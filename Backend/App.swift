import Foundation
import HTTPTypes
import Hummingbird
import Logging

struct ResponseHeaders<Context: RequestContext>: RouterMiddleware {
    func handle(
        _ request: Request, context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        var response = try await next(request, context)
        response.headers[.cacheControl] = request.uri.path.hasPrefix("/api/") ? "no-store" : "no-cache"
        response.headers[.contentSecurityPolicy] = contentSecurityPolicy
        response.headers[.xContentTypeOptions] = "nosniff"
        response.headers[referrerPolicyField] = "no-referrer"
        response.headers[permissionsPolicyField] = "camera=(), microphone=(), geolocation=()"
        return response
    }
}

struct SameOrigin<Context: RequestContext>: RouterMiddleware {

    let names: Set<String>?

    init(host: String) {
        if ["127.0.0.1", "localhost", "::1"].contains(host) {
            names = ["127.0.0.1", "localhost", "[::1]"]
        } else {
            names = nil
        }
    }

    private static func name(of authority: String) -> String {
        guard let colon = authority.lastIndex(of: ":"), !authority.hasSuffix("]") else { return authority }
        return String(authority[..<colon])
    }

    func handle(
        _ request: Request, context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let authority = (request.head.authority ?? hostField.flatMap { request.headers[$0] } ?? "").lowercased()
        if let names, !names.contains(Self.name(of: authority)) {
            throw HTTPError(.forbidden, message: "This console answers on its loopback address only.")
        }
        let reads = request.method == .get || request.method == .head
        if !reads, let origin = originField.flatMap({ request.headers[$0] }),
           origin.lowercased() != "http://\(authority)", origin.lowercased() != "https://\(authority)" {
            throw HTTPError(.forbidden, message: "Cross-origin request refused.")
        }
        return try await next(request, context)
    }
}

private let originField = HTTPField.Name("Origin")
private let hostField = HTTPField.Name("Host")
private let referrerPolicyField = HTTPField.Name("Referrer-Policy")!
private let contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].joined(separator: "; ")
private let permissionsPolicyField = HTTPField.Name("Permissions-Policy")!

struct NamedFailures<Context: RequestContext>: RouterMiddleware {
    func handle(
        _ request: Request, context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        do {
            return try await next(request, context)
        } catch let error as HTTPResponseError {
            throw error
        } catch is DecodingError {

            throw HTTPError(.badRequest, message: "The request body is not valid JSON.")
        } catch {
            let reason = failureReason(error)
            context.logger.error("\(request.method) \(request.uri.path): \(reason)")
            throw HTTPError(.internalServerError, message: reason)
        }
    }
}

func failureReason(_ error: any Error) -> String {
    switch error {
    case let error as HTTPError: return error.body ?? error.status.reasonPhrase
    case ElasticError.notFound: return "Elasticsearch has no such index"
    case ElasticError.request(let status, let message): return "Elasticsearch answered \(status): \(message)"
    default: return "\(error)"
    }
}

struct Contract: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@main
struct DashboardServer {
    static func main() async throws {
        var logger = Logger(label: "dashboard")
        logger.logLevel = .info

        let env = ProcessInfo.processInfo.environment
        let host = env["HOST"] ?? "127.0.0.1"
        let port = env["PORT"].flatMap(Int.init) ?? 8080
        let publicDir = env["PUBLIC_DIR"] ?? "Frontend"

        let challengesDir = env["CHALLENGES_DIR"] ?? "Challenges"
        let challenges = FileManager.default.fileExists(atPath: challengesDir)

        let router = Router()
        router.addMiddleware {
            LogRequestsMiddleware(.info)
            NamedFailures()
            ResponseHeaders()
            SameOrigin(host: host)
            SessionGate()
            FileMiddleware(publicDir, searchForIndexHtml: true)
        }
        if challenges {
            router.add(middleware: FileMiddleware(challengesDir, urlBasePath: "/challenges"))
        }
        router.get("api/health") { _, _ in "ok" }

        let elastic = ElasticClient()
        do {
            try await elastic.ensureIndices()
        } catch {
            logger.warning("Elasticsearch schema not ensured at \(elastic.baseURL): unreachable, or a mapping was refused: \(error)")
        }

        for query in GraphQueryCatalog.all { _ = try GraphScript.parse(query.script) }

        for escalation in ADCSEscalation.everyEscalation {
            _ = try GraphScript.clauses(escalation.template)
            _ = try GraphScript.clauses(escalation.authority)
            _ = try GraphScript.clauses(escalation.domain)
        }

        let traversable = Set(GraphTraversal.escalationEdges), named = ReachTechniques.known
        guard traversable == named else {
            throw Contract("traversable edges and the technique register disagree: "
                + "traversable only: \(traversable.subtracting(named).sorted()), "
                + "named only: \(named.subtracting(traversable).sorted())")
        }

        let analysis = AnalysisQueue(elastic: elastic, logger: logger)

        ProjectRoutes.addRoutes(to: router, elastic: elastic, logger: logger)
        IngestRoutes.addRoutes(to: router, elastic: elastic, logger: logger, analysis: analysis)
        GraphRoutes.addRoutes(to: router, elastic: elastic)
        GraphScript.addRoutes(to: router, elastic: elastic)
        AssertRoutes.addRoutes(to: router, elastic: elastic, logger: logger)
        StateRoutes.addRoutes(to: router, elastic: elastic)
        LibraryRoutes.addRoutes(to: router, elastic: elastic)
        OverviewRoutes.addRoutes(to: router, elastic: elastic, logger: logger)

        let app = Application(
            router: router,
            configuration: .init(address: .hostname(host, port: port)),
            logger: logger
        )

        Task { await analysis.recover() }

        logger.info("Listening on http://\(host):\(port)")
        try await app.runService()
    }
}

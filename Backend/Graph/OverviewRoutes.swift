import Foundation
import Hummingbird
import Logging

struct WorkspaceOverviewDTO: ResponseEncodable {
    let databases: Int
    let nodes: Int
    let edges: Int
    let tierZero: Int

    let principals: Int

    let exposed: Int
}

struct FindingCountDTO: ResponseEncodable {
    let id: String
    let count: Int
}

struct TierZeroSeedDTO: ResponseEncodable {
    let id: String
    let kind: String
    let label: String
    let reason: String
    let database: String
    let owned: Bool
}

struct NamedCountDTO: ResponseEncodable {
    let id: String
    let label: String
    let count: Int
    let script: String
}

struct DomainCardDTO: ResponseEncodable {
    let id: String
    let label: String
    let database: String
    let functionalLevel: String?
    let created: Int?
    let controllers: Int
    let ous: Int
    let gpos: Int
}

struct PopulationDTO: ResponseEncodable {
    let users: [NamedCountDTO]
    let computers: [NamedCountDTO]
    let domains: [DomainCardDTO]
}

enum Part<Value: Encodable & Sendable>: Encodable, Sendable {
    case value(Value)
    case error(String)

    init(_ read: () async throws -> Value) async {
        do { self = .value(try await read()) } catch { self = .error(failureReason(error)) }
    }

    private enum Key: String, CodingKey { case value, error }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case .value(let value): try container.encode(value, forKey: .value)
        case .error(let message): try container.encode(["message": message], forKey: .error)
        }
    }
}

struct StatisticsDTO: ResponseEncodable {
    let overview: Part<WorkspaceOverviewDTO>
    let findings: Part<[FindingCountDTO]>
    let tierZero: Part<[TierZeroSeedDTO]>
    let population: Part<PopulationDTO>
    let score: Part<[String: ScoreDTO]>
    let routes: Part<ReachPathsDTO>
    let history: Part<[AssertionRecordDTO]>
    let detail: Part<DatabaseDetailDTO>
    let owned: Part<GraphViewDTO>
}

enum OverviewRoutes {

    private struct Scope {
        let databases: [DatabaseDTO]
        let merged: Set<String>
        var inScope: [DatabaseDTO] { databases.filter { !merged.contains($0.id) } }

        var clause: JSONValue { ["terms": ["db": .strings(inScope.map(\.id))]] }
        func query(_ clauses: [JSONValue]) -> JSONValue {
            ["bool": ["must": .array(clauses + [clause])]]
        }
        static func load(_ elastic: ElasticClient, _ request: Request) async throws -> Scope {
            let databases = try await DatabaseStore.list(
                elastic, project: try await Sessions.require(request).project)
            let picked = request.uri.queryParameters["db"].map { String($0) }.flatMap { $0.isEmpty ? nil : $0 }
            guard let picked else {
                return Scope(databases: databases, merged: Set(databases.flatMap(\.sources)))
            }

            guard let one = databases.first(where: { $0.id == picked }) else {
                throw HTTPError(.notFound, message: "No such database.")
            }
            return Scope(databases: [one], merged: [])
        }
    }

    private static let people: JSONValue = ["terms": ["kind": .strings(
        [ADNodeKind.user, .computer].map(\.rawValue))]]

    private static let exposedClauses: [JSONValue] = [
        people,
        ["term": ["tierZero": .bool(true)]],
        ["term": ["tierZeroSeed": .bool(false)]],
    ]

    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient, logger: Logger
    ) {

        router.get("api/overview/statistics") { request, _ -> StatisticsDTO in
            let scope = try await Scope.load(elastic, request)
            guard let db = scope.databases.first?.id, scope.databases.count == 1,
                  request.uri.queryParameters["db"].map(String.init) == db else {
                throw HTTPError(.badRequest, message: "A database is required.")
            }
            async let counts = Self.catalogueCounts(elastic, scope)
            async let overview = Part { try await Self.overview(elastic, scope) }
            async let seeds = Part { try await Self.tierZero(elastic, scope) }
            async let population = Part { try await Self.population(elastic, scope) }
            async let routes = Part { try await ReachPaths.routes(elastic, db: db) }
            async let history = Part { try await AssertRoutes.history(elastic, db: db, logger: logger) }
            async let detail = Part { try await DatabaseStore.detail(elastic, dbId: db) }
            async let owned = Part {
                try await GraphScript.run(try GraphScript.parse("find objects where owned = true"), elastic, db: db)
            }
            let counted = await counts
            return StatisticsDTO(
                overview: await overview,
                findings: await Part { try Self.findings(counted, scope) },
                tierZero: await seeds,
                population: await population,
                score: .value(Self.score(counted, scope)),
                routes: await routes,
                history: await history,
                detail: await detail,
                owned: await owned)
        }
    }

    private static func overview(_ elastic: ElasticClient, _ scope: Scope) async throws -> WorkspaceOverviewDTO {
        WorkspaceOverviewDTO(
            databases: scope.inScope.count,
            nodes: try await elastic.distinct(index: Indices.nodes, field: "id", scope.clause),
            edges: try await elastic.count(index: Indices.edges, scope.clause),
            tierZero: try await elastic.distinct(
                index: Indices.nodes, field: "id", scope.query([["term": ["tierZero": true]]])),
            principals: try await elastic.distinct(index: Indices.nodes, field: "id", scope.query([people])),
            exposed: try await elastic.distinct(
                index: Indices.nodes, field: "id", scope.query(exposedClauses)))
    }

    struct CountFailure: Error, Sendable { let reason: String }

    typealias Counts = [String: [String: Result<Int, CountFailure>]]

    private static func catalogueCounts(_ elastic: ElasticClient, _ scope: Scope) async -> Counts {
        await withTaskGroup(of: (String, String, Result<Int, CountFailure>).self) { group in
            for db in scope.inScope {
                for row in GraphQueryCatalog.all {
                    group.addTask {
                        do { return (db.id, row.id, .success(try await GraphRoutes.answer(row, elastic, db: db.id).count)) }
                        catch { return (db.id, row.id, .failure(CountFailure(reason: failureReason(error)))) }
                    }
                }
            }
            var counts: Counts = [:]
            for await (db, row, result) in group { counts[db, default: [:]][row] = result }
            return counts
        }
    }

    private static func findings(_ counts: Counts, _ scope: Scope) throws -> [FindingCountDTO] {
        try GraphQueryCatalog.all.map { query in
            var byDatabase: [String: Int] = [:]
            for db in scope.inScope {
                switch counts[db.id]?[query.id] ?? .failure(CountFailure(reason: "not counted")) {
                case .success(let n): byDatabase[db.id] = n
                case .failure(let failure): throw HTTPError(.internalServerError, message: failure.reason)
                }
            }
            return FindingCountDTO(id: query.id, count: byDatabase.values.reduce(0, +))
        }
    }

    private static func score(_ counts: Counts, _ scope: Scope) -> [String: ScoreDTO] {
        var out: [String: ScoreDTO] = [:]
        for db in scope.inScope {
            let rows = GraphQueryCatalog.all.map { row -> (row: GraphQueryInfo, count: Int?) in
                (row, try? counts[db.id]?[row.id]?.get())
            }
            out[db.id] = Scoring.score(rows: rows)
        }
        return out
    }

    private static func tierZero(_ elastic: ElasticClient, _ scope: Scope) async throws -> [TierZeroSeedDTO] {
        let hits = try await elastic.scan(
            index: Indices.nodes,
            query: scope.query([["term": ["tierZeroSeed": .bool(true)]]]),
            source: ["id", "label", "labelAsserted", "kind", "tierZeroReason", "owned", "db"],
            sort: GraphStore.nodeOrder)
        var seen: Set<String> = []
        var seeds: [TierZeroSeedDTO] = []
        for hit in hits {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  seen.insert(id).inserted else { continue }
            seeds.append(TierZeroSeedDTO(
                id: id, kind: source["kind"]?.string ?? "",
                label: GraphStore.label(source, id: id),
                reason: source["tierZeroReason"]?.string ?? "Tier Zero",
                database: source["db"]?.string ?? "",
                owned: source["owned"]?.bool ?? false))
        }
        return seeds.sorted { ($0.kind, $0.label) < ($1.kind, $1.label) }
    }

    private static func population(_ elastic: ElasticClient, _ scope: Scope) async throws -> PopulationDTO {
        PopulationDTO(
            users: try await counted(elastic, scope, userFigures),
            computers: try await counted(elastic, scope, computerFigures),
            domains: try await domains(elastic, scope))
    }

    private static let userFigures: [(id: String, label: String, conditions: String)] = [
        ("users", "Users", "where kind = users"),
        ("users-enabled", "Enabled", "where kind = users and where enabled = true"),
        ("users-disabled", "Disabled", "where kind = users and where enabled = false"),
        ("users-dormant", "Dormant 90 days, enabled",
         "where kind = users and where enabled = true and where lastlogon older than 90d"),
        ("users-never-expires", "Password never expires", "where kind = users and where pwdneverexpires = true"),
        ("users-protected", "adminCount set", "where kind = users and where admincount = true"),
        ("users-sid-history", "SID history", "where kind = users and with sidhistory"),
    ]
    private static let computerFigures: [(id: String, label: String, conditions: String)] = [
        ("computers", "Computers", "where kind = computers"),
        ("computers-enabled", "Enabled", "where kind = computers and where enabled = true"),
        ("computers-dormant", "Dormant 90 days, enabled",
         "where kind = computers and where enabled = true and where lastlogon older than 90d"),
        ("computers-controllers", "Domain controllers", "where kind = computers and where isdc = true"),
        ("computers-laps", "LAPS, enabled", "where kind = computers and where enabled = true and where haslaps = true"),
        ("computers-unconstrained", "Unconstrained delegation",
         "where kind = computers and where unconstraineddelegation = true and where isdc != true"),
    ]

    private static func counted(
        _ elastic: ElasticClient, _ scope: Scope,
        _ figures: [(id: String, label: String, conditions: String)]
    ) async throws -> [NamedCountDTO] {
        var out: [NamedCountDTO] = []
        for figure in figures {
            let clauses = try GraphScript.clauses(figure.conditions)
            out.append(NamedCountDTO(
                id: figure.id, label: figure.label,
                count: try await elastic.distinct(index: Indices.nodes, field: "id", scope.query(clauses)),
                script: "find objects \(figure.conditions)"))
        }
        return out
    }

    private static func domains(
        _ elastic: ElasticClient, _ scope: Scope
    ) async throws -> [DomainCardDTO] {
        let hits: [JSONValue]
        do {
            hits = try await elastic.scan(
                index: Indices.nodes,
                query: scope.query([["term": ["kind": .string(ADNodeKind.domain.rawValue)]]]),
                source: ["id", "label", "labelAsserted", "db", "props.functionallevel", "props.whencreated"],
                sort: GraphStore.nodeOrder)
        } catch ElasticError.notFound { return [] }

        var seen: Set<String> = []
        var cards: [DomainCardDTO] = []
        for hit in hits {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  seen.insert(id).inserted else { continue }
            let db = source["db"]?.string
            let inDomain = { (kind: ADNodeKind, extra: [JSONValue]) -> JSONValue in
                GraphStore.scoped([
                    ["term": ["kind": .string(kind.rawValue)]],
                    ["term": ["props.domainsid": .string(id)]],
                ] + extra, db: db)
            }
            cards.append(DomainCardDTO(
                id: id,
                label: GraphStore.label(source, id: id),
                database: db ?? "",
                functionalLevel: source["props"]?["functionallevel"]?.string,
                created: source["props"]?["whencreated"]?.int,
                controllers: try await elastic.count(
                    index: Indices.nodes, inDomain(.computer, [["term": ["props.isdc": .bool(true)]]])),
                ous: try await elastic.count(index: Indices.nodes, inDomain(.ou, [])),
                gpos: try await elastic.count(index: Indices.nodes, inDomain(.gpo, []))))
        }
        return cards
    }
}

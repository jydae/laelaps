import Crypto
import Foundation
import HTTPTypes
import Hummingbird
import Logging

struct ProjectDTO: ResponseEncodable {
    let id: String
    let name: String
    let user: String
    let created: String
    let opened: String
}

struct SessionDTO: ResponseEncodable {
    let id: String
    let name: String
    let user: String
    let timer: Bool
    let challenges: Bool

    let openedAt: String
}

struct Session: Sendable {
    var project: String
    var name: String
    var user: String
    var timer: Bool
    var challenges: Bool
    let openedAt: String

    var dto: SessionDTO {
        SessionDTO(id: project, name: name, user: user, timer: timer, challenges: challenges, openedAt: openedAt)
    }
}

enum Password {
    static let rounds = 600_000
    private static let saltBytes = 32

    static func random(_ count: Int) -> [UInt8] {
        (0..<count).map { _ in UInt8.random(in: .min ... .max) }
    }

    static func derive(_ password: String, salt: [UInt8], rounds: Int = rounds) -> [UInt8] {
        let key = SymmetricKey(data: Array(password.utf8))
        var u = Array(HMAC<SHA256>.authenticationCode(for: salt + [0, 0, 0, 1], using: key))
        var t = u
        for _ in 1..<rounds {
            u = Array(HMAC<SHA256>.authenticationCode(for: u, using: key))
            for i in t.indices { t[i] ^= u[i] }
        }
        return t
    }

    static func store(_ password: String) -> (salt: String, hash: String) {
        let salt = random(saltBytes)
        return (Data(salt).base64EncodedString(), Data(derive(password, salt: salt)).base64EncodedString())
    }

    static func matches(_ password: String, salt: String, hash: String) -> Bool {
        guard let salt = Data(base64Encoded: salt), let stored = Data(base64Encoded: hash) else { return false }
        let computed = derive(password, salt: Array(salt))
        guard computed.count == stored.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(computed, stored) { diff |= a ^ b }
        return diff == 0
    }
}

actor Attempts {
    static let shared = Attempts()
    private static let free = 5
    private static let longestWait = 300.0

    private var failed: [String: (count: Int, until: Date)] = [:]

    func matches(_ password: String, project id: String, salt: String, hash: String) throws -> Bool {
        let now = Date()
        if let entry = failed[id], entry.until > now {
            let wait = Int(entry.until.timeIntervalSince(now).rounded(.up))
            throw HTTPError(.tooManyRequests, message: "Too many wrong passwords. Try again in \(wait) s.")
        }
        if Password.matches(password, salt: salt, hash: hash) {
            failed[id] = nil
            return true
        }

        if failed.count > 1_000 { failed = failed.filter { $0.value.count >= Self.free } }
        let count = (failed[id]?.count ?? 0) + 1
        let wait = count < Self.free ? 0 : min(Self.longestWait, pow(2, Double(count - Self.free)))
        failed[id] = (count: count, until: now.addingTimeInterval(wait))
        return false
    }
}

actor Sessions {
    static let shared = Sessions()
    static let cookie = "session"
    static let idleLimit: TimeInterval = 12 * 60 * 60

    private var live: [String: Session] = [:]
    private var seen: [String: Date] = [:]

    func open(_ session: Session) -> String {
        let token = Data(Password.random(32)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        live[token] = session
        seen[token] = Date()
        return token
    }

    func close(_ token: String) { live[token] = nil; seen[token] = nil }

    func closeOthers(project: String, keeping token: String?) {
        for (other, session) in live where session.project == project && other != token {
            live[other] = nil
            seen[other] = nil
        }
    }

    func update(project: String, _ change: @Sendable (inout Session) -> Void) {
        for (token, var session) in live where session.project == project {
            change(&session)
            live[token] = session
        }
    }

    func closeAll(project: String) {
        for (token, session) in live where session.project == project { close(token) }
    }

    func session(_ token: String?, now: Date = Date()) -> Session? {
        guard let token, let session = live[token] else { return nil }
        if let last = seen[token], now.timeIntervalSince(last) > Self.idleLimit {
            close(token)
            return nil
        }
        seen[token] = now
        return session
    }

    static func require(_ request: Request) async throws -> Session {
        guard let session = await shared.session(request.cookies[cookie]?.value) else {
            throw HTTPError(.unauthorized, message: "No project is open.")
        }
        return session
    }

    static func setCookie(_ token: String?) -> HTTPFields {
        let cookie = Cookie(name: cookie, value: token ?? "", maxAge: token == nil ? 0 : nil,
                            path: "/", httpOnly: true, sameSite: .strict)
        return [.setCookie: cookie.description]
    }
}

struct SessionGate<Context: RequestContext>: RouterMiddleware {
    func handle(
        _ request: Request, context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {

        guard let path = request.uri.path.removingPercentEncoding else {
            throw HTTPError(.badRequest, message: "Malformed request path.")
        }
        let gated = path.hasPrefix("/api/") || path.hasPrefix("/challenges/")
        let open = path == "/api/health" || path == "/api/project" || path == "/api/project/me"
            || (request.method == .post && path.hasPrefix("/api/project/") && path.hasSuffix("/open"))
        if gated && !open {
            let session = try await Sessions.require(request)

            if path.hasPrefix("/challenges/") && !session.challenges {
                throw HTTPError(.notFound)
            }
        }
        return try await next(request, context)
    }
}

enum ProjectRoutes {
    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient, logger: Logger
    ) {
        router.get("api/project") { _, _ -> [ProjectDTO] in
            try await list(elastic)
        }

        router.post("api/project") { request, _ -> EditedResponse<SessionDTO> in
            let body = try await json(request)
            let name = body["name"]?.string?.trimmingCharacters(in: .whitespaces) ?? ""
            let user = body["user"]?.string?.trimmingCharacters(in: .whitespaces) ?? ""
            let password = body["password"]?.string ?? ""
            guard !name.isEmpty, !user.isEmpty else {
                throw HTTPError(.badRequest, message: "A project needs a name and a user.")
            }
            try checkPassword(password)
            let id = "p-" + String(Int(Date().timeIntervalSince1970), radix: 36)
                + "-" + String(UInt32.random(in: 0..<UInt32.max), radix: 36)
            let now = ElasticClient.timestamp()
            let stored = Password.store(password)
            try await elastic.index(Indices.projects, id: id, doc: [
                "id": .string(id), "name": .string(name), "user": .string(user),
                "salt": .string(stored.salt), "hash": .string(stored.hash),
                "timer": .bool(body["timer"]?.bool ?? true),
                "challenges": .bool(body["challenges"]?.bool ?? false),
                "created": .string(now), "opened": .string(now),
            ])
            logger.info("Project: created \(id) '\(name)'")
            return try await open(elastic, id: id)
        }

        router.post("api/project/:id/open") { request, context -> EditedResponse<SessionDTO> in
            let id = try context.parameters.require("id", as: String.self)
            let body = try await json(request)
            try await verify(elastic, id: id, password: body["password"]?.string ?? "")
            try await elastic.bulkUpdate([.init(index: Indices.projects, id: id,
                                                doc: ["opened": .string(ElasticClient.timestamp())])])
            return try await open(elastic, id: id)
        }

        router.get("api/project/me") { request, context -> Response in
            guard let session = await Sessions.shared.session(request.cookies[Sessions.cookie]?.value) else {
                return Response(status: .noContent)
            }
            return try session.dto.response(from: request, context: context)
        }

        router.post("api/project/close") { request, _ -> EditedResponse<HTTPResponse.Status> in
            if let token = request.cookies[Sessions.cookie]?.value { await Sessions.shared.close(token) }
            return EditedResponse(status: .noContent, headers: Sessions.setCookie(nil), response: .noContent)
        }

        router.put("api/project/settings") { request, _ -> SessionDTO in
            let session = try await Sessions.require(request)
            let body = try await json(request)
            var fields: [String: JSONValue] = [:]
            if let name = body["name"]?.string?.trimmingCharacters(in: .whitespaces) {
                guard !name.isEmpty else { throw HTTPError(.badRequest, message: "The name cannot be empty.") }
                fields["name"] = .string(name)
            }
            if let user = body["user"]?.string?.trimmingCharacters(in: .whitespaces) {
                guard !user.isEmpty else { throw HTTPError(.badRequest, message: "The user cannot be empty.") }
                fields["user"] = .string(user)
            }
            if let timer = body["timer"]?.bool { fields["timer"] = .bool(timer) }
            if let challenges = body["challenges"]?.bool { fields["challenges"] = .bool(challenges) }
            if let new = body["newPassword"]?.string {
                try await verify(elastic, id: session.project, password: body["password"]?.string ?? "")
                try checkPassword(new)
                let stored = Password.store(new)
                fields["salt"] = .string(stored.salt)
                fields["hash"] = .string(stored.hash)
            }
            guard !fields.isEmpty else { return session.dto }
            try await elastic.bulkUpdate([.init(index: Indices.projects, id: session.project, doc: fields)])
            try await elastic.refresh(Indices.projects)
            let written = fields

            if written["hash"] != nil {
                await Sessions.shared.closeOthers(project: session.project, keeping: request.cookies[Sessions.cookie]?.value)
            }
            await Sessions.shared.update(project: session.project) { s in
                if let v = written["name"]?.string { s.name = v }
                if let v = written["user"]?.string { s.user = v }
                if let v = written["timer"]?.bool { s.timer = v }
                if let v = written["challenges"]?.bool { s.challenges = v }
            }
            return try await Sessions.require(request).dto
        }

        router.delete("api/project") { request, _ -> EditedResponse<HTTPResponse.Status> in
            let session = try await Sessions.require(request)
            let body = try await json(request)
            try await verify(elastic, id: session.project, password: body["password"]?.string ?? "")
            for db in try await DatabaseStore.list(elastic, project: session.project) {
                try await DatabaseStore.delete(elastic, dbId: db.id, logger: logger)
            }
            try await elastic.deleteByQuery(index: Indices.state, ["term": ["scope": .string(session.project)]])
            try await elastic.deleteByQuery(index: Indices.library, ["term": ["scope": .string(session.project)]])
            try await elastic.delete(index: Indices.projects, id: session.project)
            await Sessions.shared.closeAll(project: session.project)
            logger.info("Project: deleted \(session.project)")
            return EditedResponse(status: .noContent, headers: Sessions.setCookie(nil), response: .noContent)
        }
    }

    private static func json(_ request: Request) async throws -> JSONValue {
        let buffer = try await request.body.collect(upTo: 16 * 1024)
        return try JSONValue.parse(Array(buffer.readableBytesView))
    }

    private static func checkPassword(_ password: String) throws {
        guard password.count >= 8 else {
            throw HTTPError(.badRequest, message: "A password needs at least 8 characters.")
        }
    }

    static func list(_ elastic: ElasticClient) async throws -> [ProjectDTO] {
        do {
            let hits = try await elastic.scan(
                index: Indices.projects, query: ["match_all": .object([:])],
                source: ["id", "name", "user", "created", "opened"], sort: ["created", "id"])
            return hits.compactMap { hit -> ProjectDTO? in
                guard let s = hit["_source"], let id = s["id"]?.string else { return nil }
                return ProjectDTO(id: id, name: s["name"]?.string ?? id, user: s["user"]?.string ?? "",
                                  created: s["created"]?.string ?? "", opened: s["opened"]?.string ?? "")
            }.sorted { $0.opened > $1.opened }
        } catch ElasticError.notFound {
            return []
        }
    }

    private static func document(_ elastic: ElasticClient, id: String) async throws -> JSONValue {
        guard let doc = try await elastic.get(index: Indices.projects, id: id) else {
            throw HTTPError(.notFound, message: "No such project.")
        }
        return doc
    }

    private static func verify(_ elastic: ElasticClient, id: String, password: String) async throws {
        let doc = try await elastic.get(index: Indices.projects, id: id)
        let matches = try await Attempts.shared.matches(
            password, project: id, salt: doc?["salt"]?.string ?? "", hash: doc?["hash"]?.string ?? "")
        guard doc != nil, matches else { throw HTTPError(.unauthorized, message: "Wrong password.") }
    }

    private static func open(_ elastic: ElasticClient, id: String) async throws -> EditedResponse<SessionDTO> {
        let doc = try await document(elastic, id: id)
        let session = Session(
            project: id, name: doc["name"]?.string ?? id, user: doc["user"]?.string ?? "",
            timer: doc["timer"]?.bool ?? true, challenges: doc["challenges"]?.bool ?? false,
            openedAt: ElasticClient.timestamp())
        let token = await Sessions.shared.open(session)
        return EditedResponse(status: .ok, headers: Sessions.setCookie(token), response: session.dto)
    }
}

struct ViewStateDTO: ResponseEncodable {
    let tab: String
    let view: [String: JSONValue]
}

enum StateRoutes {
    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient
    ) {
        router.get("api/state/:tab") { request, context -> ViewStateDTO in
            let tab = try context.parameters.require("tab", as: String.self)
            let scope = try await Sessions.require(request).project
            let hits = try await elastic.search(index: Indices.state, [
                "size": 1,
                "query": ["term": ["_id": .string("\(scope)|\(tab)")]],
            ])
            let doc = (hits["hits"]?["hits"]?.array ?? []).first?["_source"]
            return ViewStateDTO(tab: tab, view: doc?["view"]?.object ?? [:])
        }

        router.put("api/state/:tab") { request, context -> ViewStateDTO in
            let tab = try context.parameters.require("tab", as: String.self)
            let scope = try await Sessions.require(request).project

            let buffer = try await request.body.collect(upTo: 256 * 1024)
            let view = try JSONValue.parse(Array(buffer.readableBytesView)).object ?? [:]

            try await elastic.index(Indices.state, id: "\(scope)|\(tab)", doc: [
                "scope": .string(scope),
                "tab": .string(tab),
                "view": .object(view),
                "updated": .string(ElasticClient.timestamp()),
            ])
            return ViewStateDTO(tab: tab, view: view)
        }
    }
}

struct LibraryItemDTO: ResponseEncodable {
    let id: String
    let db: String
    let kind: String
    let title: String
    let description: String
    let author: String
    let created: String
    let updated: String

    let body: [String: JSONValue]
}

enum LibraryRoutes {

    static let kinds: Set<String> = ["filter"]

    static let bodyLimit = 256 * 1024
    static let titleLimit = 120
    static let listLimit = 500

    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient
    ) {
        router.get("api/library") { request, _ -> [LibraryItemDTO] in
            let scope = try await Sessions.require(request).project
            let db = try await GraphRoutes.db(request, elastic)
            var must: [JSONValue] = [
                ["term": ["scope": .string(scope)]],
                ["term": ["db": .string(db)]],
            ]
            if let kind = request.uri.queryParameters["kind"].map({ String($0) }), !kind.isEmpty {
                must.append(["term": ["kind": .string(kind)]])
            }
            let hits: JSONValue
            do {
                hits = try await elastic.search(index: Indices.library, [
                    "size": .int(listLimit),
                    "sort": [.object(["updated": .object(["order": .string("desc")])])],
                    "query": ["bool": ["must": .array(must)]],
                ])
            } catch ElasticError.notFound {
                return []
            }
            return (hits["hits"]?["hits"]?.array ?? []).compactMap { item($0["_source"]) }
        }

        router.put("api/library/:id") { request, context -> LibraryItemDTO in
            let id = GraphRoutes.decodedPathID(try context.parameters.require("id", as: String.self))
            let session = try await Sessions.require(request)
            let buffer = try await request.body.collect(upTo: bodyLimit + 16 * 1024)
            let doc = try JSONValue.parse(Array(buffer.readableBytesView))
            let db = try await GraphRoutes.db(request, elastic, doc["db"]?.string)

            guard !id.isEmpty, id.count <= 64 else { throw HTTPError(.badRequest, message: "A saved item needs an id.") }
            guard let kind = doc["kind"]?.string, kinds.contains(kind) else {
                throw HTTPError(.badRequest, message: "Unknown kind.")
            }
            let title = (doc["title"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { throw HTTPError(.badRequest, message: "A name is required.") }
            guard title.count <= titleLimit else { throw HTTPError(.badRequest, message: "The name is too long.") }
            let description = doc["description"]?.string ?? ""
            let body = doc["body"]?.object ?? [:]
            guard try JSONValue.object(body).serializedLine().utf8.count <= bodyLimit else {
                throw HTTPError(.badRequest, message: "This is too large to save.")
            }

            let sentence = body["script"]?.string ?? ""
            if !sentence.isEmpty {
                do {
                    _ = try GraphScript.parse(sentence)
                } catch let failure as GraphScript.Failure {
                    throw HTTPError(.badRequest, message: failure.line)
                }
            }

            let existing = try await elastic.get(index: Indices.library, id: id)
            if let existing, existing["scope"]?.string != session.project {
                throw HTTPError(.notFound)
            }
            let now = ElasticClient.timestamp()
            let fields: [String: JSONValue] = [
                "id": .string(id),
                "scope": .string(session.project),
                "db": .string(db),
                "kind": .string(kind),
                "title": .string(title),
                "description": .string(description),
                "author": .string(existing?["author"]?.string ?? session.user),
                "created": .string(existing?["created"]?.string ?? now),
                "updated": .string(now),
                "body": .object(body),
            ]
            try await elastic.index(Indices.library, id: id, doc: fields)
            guard let saved = item(.object(fields)) else { throw HTTPError(.internalServerError) }
            return saved
        }

        router.delete("api/library/:id") { request, context -> HTTPResponse.Status in
            let id = GraphRoutes.decodedPathID(try context.parameters.require("id", as: String.self))
            let scope = try await Sessions.require(request).project
            do {
                try await elastic.deleteByQuery(index: Indices.library, ["bool": ["must": [
                    .object(["term": .object(["id": .string(id)])]),
                    .object(["term": .object(["scope": .string(scope)])]),
                ]]])
            } catch ElasticError.notFound {

            }

            return .noContent
        }
    }

    private static func item(_ source: JSONValue?) -> LibraryItemDTO? {
        guard let source, let id = source["id"]?.string, let kind = source["kind"]?.string else { return nil }
        return LibraryItemDTO(
            id: id, db: source["db"]?.string ?? "", kind: kind,
            title: source["title"]?.string ?? "", description: source["description"]?.string ?? "",
            author: source["author"]?.string ?? "", created: source["created"]?.string ?? "",
            updated: source["updated"]?.string ?? "", body: source["body"]?.object ?? [:])
    }
}

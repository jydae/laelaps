import AsyncHTTPClient
import Foundation
import NIOCore

struct ElasticClient: Sendable {
    let baseURL: String
    let username: String?
    let password: String?

    private static let responseLimit = 128 * 1024 * 1024

    init() {
        let env = ProcessInfo.processInfo.environment
        var url = env["ES_URL"] ?? "http://127.0.0.1:9200"
        while url.hasSuffix("/") { url.removeLast() }
        baseURL = url
        username = env["ES_USER"]
        password = env["ES_PASSWORD"]
    }

    struct BulkOp: Sendable {
        let index: String
        let id: String
        let doc: [String: JSONValue]
    }

    static func timestamp(_ instant: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: instant)
    }

    func ensureIndices() async throws {
        try await ensureIndex(Indices.nodes, properties: [
            "id": ["type": "keyword"],
            "db": ["type": "keyword"],
            "kind": ["type": "keyword"],
            "label": ["type": "text", "fields": ["keyword": ["type": "keyword"]]],
            "props": ["type": "flattened"],
            "tierZero": ["type": "boolean"],
            "tierZeroSeed": ["type": "boolean"],
            "tierZeroReason": ["type": "text"],

            "chokeValue": ["type": "integer"],

            "zoneTier": ["type": "integer"],
            "zoneTierReason": ["type": "text"],

            "zoneTierInferred": ["type": "boolean"],

            "labelAsserted": ["type": "text", "fields": ["keyword": ["type": "keyword"]]],
            "owned": ["type": "boolean"],
            "ownedReason": ["type": "text"],

            "zoneAsserted": ["type": "boolean"],
            "zoneRefuted": ["type": "boolean"],

            "tierAsserted": ["type": "integer"],
            "notes": ["type": "flattened"],
        ])
        try await ensureIndex(Indices.edges, properties: [
            "db": ["type": "keyword"],
            "source": ["type": "keyword"],
            "target": ["type": "keyword"],
            "kind": ["type": "keyword"],

            "origin": ["type": "keyword"],

            "derived": ["type": "boolean"],

            "refuted": ["type": "boolean"],

            "inherited": ["type": "boolean"],

            "unvetted": ["type": "boolean"],

            "enforced": ["type": "boolean"],
            "blocked": ["type": "boolean"],

            "peer": ["type": "keyword"],
            "peerName": ["type": "keyword"],

            "through": ["type": "keyword"],
            "passwordAgeDays": ["type": "integer"],
            "aesOnly": ["type": "boolean"],

            "targetDisabled": ["type": "boolean"],
            "needsApproval": ["type": "boolean"],
            "quotaZero": ["type": "boolean"],
            "sessionAgeDays": ["type": "integer"],

            "seenAt": ["type": "long"],

            "note": ["type": "text"],
        ])
        try await ensureIndex(Indices.databases, properties: [
            "id": ["type": "keyword"],

            "project": ["type": "keyword"],
            "name": ["type": "text", "fields": ["keyword": ["type": "keyword"]]],
            "created": ["type": "date"],
            "updated": ["type": "date"],
            "files": ["type": "keyword"],
            "fileCount": ["type": "integer"],
            "nodeCount": ["type": "integer"],
            "edgeCount": ["type": "integer"],
            "byteCount": ["type": "long"],
            "tierZeroCount": ["type": "integer"],
            "declaredCount": ["type": "integer"],
            "skippedCount": ["type": "integer"],
            "mergedCount": ["type": "integer"],
            "baseCount": ["type": "integer"],
            "derivedEdgeCount": ["type": "integer"],
            "sources": ["type": "keyword"],

            "analyzed": ["type": "boolean"],
            "analysisError": ["type": "text"],

            "ledger": ["type": "object", "enabled": false],
            "census": ["type": "object", "enabled": false],
        ])

        try await ensureIndex(Indices.assertions, properties: [
            "db": ["type": "keyword"],
            "changeset": ["type": "keyword"],
            "subject": ["type": "keyword"],
            "subjectKind": ["type": "keyword"],
            "op": ["type": "keyword"],
            "value": ["type": "flattened"],
            "author": ["type": "keyword"],

            "assertedAt": ["type": "date"],
            "effectiveAt": ["type": "date"],
            "reason": ["type": "text"],
            "supersededBy": ["type": "keyword"],
        ])
        try await ensureIndex(Indices.state, properties: [
            "scope": ["type": "keyword"],
            "tab": ["type": "keyword"],
            "view": ["type": "flattened"],
            "updated": ["type": "date"],
        ])

        try await ensureIndex(Indices.library, properties: [
            "id": ["type": "keyword"],
            "scope": ["type": "keyword"],
            "db": ["type": "keyword"],
            "kind": ["type": "keyword"],
            "title": ["type": "text", "fields": ["keyword": ["type": "keyword"]]],
            "description": ["type": "text"],
            "author": ["type": "keyword"],
            "created": ["type": "date"],
            "updated": ["type": "date"],
            "body": ["type": "object", "enabled": false],
        ])
        try await ensureIndex(Indices.projects, properties: [
            "id": ["type": "keyword"],
            "name": ["type": "text", "fields": ["keyword": ["type": "keyword"]]],
            "user": ["type": "keyword"],
            "salt": ["type": "keyword"],
            "hash": ["type": "keyword"],
            "timer": ["type": "boolean"],
            "challenges": ["type": "boolean"],
            "created": ["type": "date"],
            "opened": ["type": "date"],
        ])
    }

    private func ensureIndex(_ index: String, properties: JSONValue) async throws {
        var create = HTTPClientRequest(url: "\(baseURL)/\(index)")
        create.method = .PUT
        create.body = .bytes(ByteBuffer(string: try JSONValue.object([
            "mappings": .object(["properties": properties]),
        ]).serializedLine()))
        do {
            _ = try await send(create, contentType: "application/json")
            return
        } catch ElasticError.request(let status, let message)
            where status == 400 && message.contains("resource_already_exists_exception") {

        }

        var update = HTTPClientRequest(url: "\(baseURL)/\(index)/_mapping")
        update.method = .PUT
        update.body = .bytes(ByteBuffer(string: try JSONValue.object([
            "properties": properties,
        ]).serializedLine()))
        _ = try await send(update, contentType: "application/json")
    }

    struct BulkOutcome: Sendable {
        let created: Int
        let updated: Int

        var missing: Int = 0
    }

    @discardableResult
    func bulk(_ ops: [BulkOp], batch: Int = 1_000) async throws -> BulkOutcome {
        try await sendBatched(ops, batch: batch) { op in
            try JSONValue.object([
                "index": .object(["_index": .string(op.index), "_id": .string(op.id)]),
            ]).serializedLine() + JSONValue.object(op.doc).serializedLine()
        }
    }

    func refresh(_ indices: String...) async throws {
        var request = HTTPClientRequest(url: "\(baseURL)/\(indices.joined(separator: ","))/_refresh")
        request.method = .POST
        _ = try await send(request, contentType: "application/json")
    }

    @discardableResult
    func bulkUpdate(
        _ ops: [BulkOp], skippingMissing: Bool = false, upsert: Bool = false
    ) async throws -> BulkOutcome {
        try await sendBatched(ops, batch: 1_000, skippingMissing: skippingMissing) { op in
            var line: [String: JSONValue] = ["doc": .object(op.doc)]
            if upsert { line["doc_as_upsert"] = .bool(true) }
            return try JSONValue.object([
                "update": .object([
                    "_index": .string(op.index),
                    "_id": .string(op.id),

                    "retry_on_conflict": .int(3),
                ]),
            ]).serializedLine() + JSONValue.object(line).serializedLine()
        }
    }

    private func sendBatched(
        _ ops: [BulkOp], batch: Int, skippingMissing: Bool = false, lines: (BulkOp) throws -> String
    ) async throws -> BulkOutcome {
        var total = BulkOutcome(created: 0, updated: 0)
        for chunk in ops.chunked(batch) {
            let outcome = try await sendBulk(
                try chunk.map(lines).joined(), skippingMissing: skippingMissing)
            total = BulkOutcome(created: total.created + outcome.created,
                                updated: total.updated + outcome.updated,
                                missing: total.missing + outcome.missing)
        }
        return total
    }

    @discardableResult
    private func sendBulk(_ body: String, skippingMissing: Bool = false) async throws -> BulkOutcome {

        var request = HTTPClientRequest(url: "\(baseURL)/_bulk")
        request.method = .POST
        request.body = .bytes(ByteBuffer(string: body))
        let bytes = try await send(request, contentType: "application/x-ndjson")

        let result = try JSONValue.parse(bytes)
        var created = 0, updated = 0, missing = 0
        var failure: JSONValue?
        for item in result["items"]?.array ?? [] {
            guard let outcome = item.object?.first?.value else { continue }
            if let error = outcome["error"] {
                if skippingMissing, error["type"]?.string == "document_missing_exception" {
                    missing += 1
                } else if failure == nil {
                    failure = error
                }
                continue
            }
            switch outcome["result"]?.string {
            case "created": created += 1
            case "updated", "noop": updated += 1
            default: break
            }
        }
        if let failure {
            throw ElasticError.request(
                status: 200,
                message: "\(failure["type"]?.string ?? "error"): \(failure["reason"]?.string ?? "")")
        }
        return BulkOutcome(created: created, updated: updated, missing: missing)
    }

    func index(_ index: String, id: String, doc: [String: JSONValue]) async throws {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_doc/\(Self.escape(id))?refresh=true")
        request.method = .PUT
        request.body = .bytes(ByteBuffer(string: try JSONValue.object(doc).serializedLine()))
        _ = try await send(request, contentType: "application/json")
    }

    func delete(index: String, id: String) async throws {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_doc/\(Self.escape(id))?refresh=true")
        request.method = .DELETE
        do {
            _ = try await send(request, contentType: "application/json")
        } catch ElasticError.notFound {
            return
        }
    }

    func deleteByQuery(index: String, _ query: JSONValue) async throws {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_delete_by_query?conflicts=proceed&refresh=true")
        request.method = .POST
        request.body = .bytes(ByteBuffer(string: try JSONValue.object(["query": query]).serializedLine()))
        _ = try await send(request, contentType: "application/json")
    }

    func count(index: String, _ query: JSONValue) async throws -> Int {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_count")
        request.method = .POST
        request.body = .bytes(ByteBuffer(string: try JSONValue.object(["query": query]).serializedLine()))
        do {
            let bytes = try await send(request, contentType: "application/json")
            return try JSONValue.parse(bytes)["count"]?.int ?? 0
        } catch ElasticError.notFound {
            return 0
        }
    }

    func distinct(index: String, field: String, _ query: JSONValue) async throws -> Int {
        do {
            let response = try await search(index: index, [
                "size": 0, "query": query,
                "aggs": ["n": ["cardinality": [
                    "field": .string(field), "precision_threshold": 40_000,
                ]]],
            ])
            return response["aggregations"]?["n"]?["value"]?.int ?? 0
        } catch ElasticError.notFound {
            return 0
        }
    }

    func search(index: String, _ body: JSONValue) async throws -> JSONValue {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_search")
        request.method = .POST
        request.body = .bytes(ByteBuffer(string: try body.serializedLine()))
        let bytes = try await send(request, contentType: "application/json")
        return try JSONValue.parse(bytes)
    }

    func get(index: String, id: String) async throws -> JSONValue? {
        var request = HTTPClientRequest(url: "\(baseURL)/\(index)/_doc/\(Self.escape(id))")
        request.method = .GET
        do {
            let bytes = try await send(request, contentType: "application/json")
            return try JSONValue.parse(bytes)["_source"]
        } catch ElasticError.notFound {
            return nil
        }
    }

    func page(
        index: String, query: JSONValue, source: [String], sort: [String],
        after: JSONValue? = nil, size: Int = 2_000
    ) async throws -> (hits: [JSONValue], cursor: JSONValue?) {
        var body: [String: JSONValue] = [
            "size": .int(size),

            "track_total_hits": .bool(false),
            "_source": .array(source.map(JSONValue.string)),
            "query": query,
            "sort": .array(sort.map { .object([$0: .object(["order": .string("asc")])]) }),
        ]
        if let after { body["search_after"] = after }

        let response = try await search(index: index, .object(body))
        let hits = response["hits"]?["hits"]?.array ?? []

        return (hits, hits.count == size ? hits.last?["sort"] : nil)
    }

    func fetchByIDs(
        index: String, ids: [String], source: [String]? = nil, db: String? = nil
    ) async throws -> [JSONValue] {
        guard !ids.isEmpty else { return [] }
        var out: [JSONValue] = []
        for chunk in ids.chunked(Self.idFetchChunk) {
            var must: [JSONValue] = [["terms": ["id": .strings(chunk)]]]
            if let db { must.append(["term": ["db": .string(db)]]) }
            let query: JSONValue = ["bool": ["must": .array(must)]]
            var cursor: JSONValue?
            repeat {
                let read = try await page(index: index, query: query, source: source ?? [],
                                          sort: ["id", "db"], after: cursor)
                out += read.hits
                cursor = read.cursor
            } while cursor != nil
        }
        return out
    }

    private static let idFetchChunk = 5_000

    private static func escape(_ id: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
    }

    private func send(_ request: HTTPClientRequest, contentType: String) async throws -> [UInt8] {
        var request = request
        request.headers.add(name: "Content-Type", value: contentType)
        if let username, let password {
            let token = Data("\(username):\(password)".utf8).base64EncodedString()
            request.headers.add(name: "Authorization", value: "Basic \(token)")
        }
        let response = try await Self.http.execute(request, timeout: .seconds(60))
        let buffer = try await response.body.collect(upTo: Self.responseLimit)
        let bytes = Array(buffer.readableBytesView)

        let status = Int(response.status.code)
        if status == 404 { throw ElasticError.notFound }
        guard (200..<300).contains(status) else {
            throw ElasticError.request(status: status, message: String(decoding: bytes, as: UTF8.self))
        }
        return bytes
    }

    private static let http: HTTPClient = {
        var config = HTTPClient.Configuration()
        config.decompression = .disabled
        return HTTPClient(eventLoopGroupProvider: .singleton, configuration: config)
    }()
}

enum ElasticError: Error {
    case notFound
    case request(status: Int, message: String)
}

import Foundation
import Hummingbird
import Logging

enum DatabaseStore {

    static func owned<Context: RequestContext>(
        _ elastic: ElasticClient, _ request: Request, _ context: Context
    ) async throws -> String {
        let dbId = try context.parameters.require("dbId", as: String.self)
        try await owned(elastic, dbId: dbId, project: try await Sessions.require(request).project)
        return dbId
    }

    static func owned(_ elastic: ElasticClient, dbId: String, project: String) async throws {
        let n = try await elastic.count(index: Indices.databases, ["bool": ["must": [
            .object(["term": .object(["id": .string(dbId)])]),
            .object(["term": .object(["project": .string(project)])]),
        ]]])
        guard n > 0 else { throw HTTPError(.notFound, message: "No such database.") }
    }

    static func isWellFormed(id: String) -> Bool {
        (1...64).contains(id.utf8.count) && id.utf8.allSatisfy { byte in
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F: return true
            default: return false
            }
        }
    }

    static func claimable(_ elastic: ElasticClient, dbId: String, project: String) async throws {
        guard isWellFormed(id: dbId) else {
            throw HTTPError(.badRequest, message: "Malformed database id.")
        }
        if let owner = try await document(elastic, dbId: dbId)?["project"]?.string, owner != project {
            throw HTTPError(.notFound, message: "No such database.")
        }
    }

    static func list(_ elastic: ElasticClient, project: String) async throws -> [DatabaseDTO] {
        do {
            let hits = try await elastic.scan(
                index: Indices.databases, query: ["term": ["project": .string(project)]],
                source: DatabaseDTO.sourceFields, sort: ["created", "id"])
            return hits.compactMap { $0["_source"].flatMap(dto(from:)) }
                .sorted { $0.created > $1.created }
        } catch ElasticError.notFound {
            return []
        }
    }

    static func unsettled(_ elastic: ElasticClient) async throws -> [String] {
        do {
            let hits = try await elastic.scan(
                index: Indices.databases,
                query: ["bool": ["must_not": [
                    .object(["term": .object(["analyzed": .bool(true)])]),
                ]]],
                source: ["id"], sort: ["created", "id"])
            return hits.compactMap { $0["_source"]?["id"]?.string }
        } catch ElasticError.notFound {
            return []
        }
    }

    static func detail(_ elastic: ElasticClient, dbId: String) async throws -> DatabaseDetailDTO {
        let source = try await document(elastic, dbId: dbId)
        return DatabaseDetailDTO(
            id: dbId, files: IngestReport.files(from: source), census: IngestReport.census(from: source))
    }

    static func document(_ elastic: ElasticClient, dbId: String) async throws -> JSONValue? {
        try await elastic.search(index: Indices.databases, [
            "size": 1, "query": ["term": ["id": .string(dbId)]],
        ])["hits"]?["hits"]?.array?.first?["_source"]
    }

    static func dto(from source: JSONValue) -> DatabaseDTO? {
        guard let id = source["id"]?.string else { return nil }
        return DatabaseDTO(
            id: id,
            name: source["name"]?.string ?? id,
            created: source["created"]?.string ?? "",
            updated: source["updated"]?.string ?? source["created"]?.string ?? "",
            files: source["files"]?.array?.compactMap { $0.string } ?? [],
            fileCount: source["fileCount"]?.int ?? 0,
            nodeCount: source["nodeCount"]?.int ?? 0,
            edgeCount: source["edgeCount"]?.int ?? 0,
            byteCount: source["byteCount"]?.int ?? 0,
            tierZeroCount: source["tierZeroCount"]?.int ?? 0,
            declaredCount: source["declaredCount"]?.int ?? (source["nodeCount"]?.int ?? 0),
            skippedCount: source["skippedCount"]?.int ?? 0,
            mergedCount: source["mergedCount"]?.int ?? 0,
            baseCount: source["baseCount"]?.int ?? 0,
            derivedEdgeCount: source["derivedEdgeCount"]?.int ?? 0,

            analyzed: source["analyzed"]?.bool ?? (source["census"]?["computed"]?.string != nil),
            analysisError: source["analysisError"]?.string,
            sources: source["sources"]?.array?.compactMap { $0.string } ?? [],
            domains: (IngestReport.census(from: source)?.domains ?? []).map {
                DomainRefDTO(id: $0.id, label: $0.label)
            })
    }

    static func record(
        _ elastic: ElasticClient, dbId: String, project: String, fileName: String,
        name: String?, domain: String? = nil, indexed: Bool = true, row: IngestReport.Record
    ) async throws {
        let existing = try await document(elastic, dbId: dbId)

        if let owner = existing?["project"]?.string, owner != project {
            throw HTTPError(.notFound, message: "No such database.")
        }
        if existing == nil, !indexed { return }
        var files = existing?["files"]?.array?.compactMap { $0.string } ?? []
        if !files.contains(fileName) { files.append(fileName) }
        var ledger = (existing?["ledger"]?.array ?? []).filter { $0["name"]?.string != fileName }
        ledger.append(IngestReport.encode(row))

        func total(_ key: String) -> Int {
            ledger.reduce(0) { $0 + ($1[key]?.int ?? 0) }
        }

        let declaredTotal = ledger.reduce(0) {
            $0 + ($1["declared"]?.int ?? $1["present"]?.int ?? 0)
        }

        var doc: [String: JSONValue] = [
            "id": .string(dbId),
            "project": .string(project),
            "name": .string(existing?["name"]?.string ?? name ?? domain ?? defaultName(for: fileName)),
            "created": .string(existing?["created"]?.string ?? ElasticClient.timestamp()),

            "updated": .string(indexed ? ElasticClient.timestamp()
                : existing?["updated"]?.string ?? existing?["created"]?.string ?? ElasticClient.timestamp()),
            "files": .strings(files),
            "fileCount": .int(files.count),

            "nodeCount": .int(total("nodes")),
            "edgeCount": .int(total("edges")),
            "byteCount": .int(total("bytes")),
            "tierZeroCount": .int(existing?["tierZeroCount"]?.int ?? 0),
            "baseCount": .int(existing?["baseCount"]?.int ?? 0),
            "derivedEdgeCount": .int(existing?["derivedEdgeCount"]?.int ?? 0),
            "declaredCount": .int(declaredTotal),
            "skippedCount": .int(total("skipped")),
            "mergedCount": .int(total("merged")),
            "sources": .strings(existing?["sources"]?.array?.compactMap { $0.string } ?? []),

            "analyzed": .bool(indexed ? false : (existing?["analyzed"]?.bool ?? false)),
            "ledger": .array(ledger),
        ]
        if let census = existing?["census"] { doc["census"] = census }
        try await elastic.index(Indices.databases, id: dbId, doc: doc)
    }

    static func update(
        _ elastic: ElasticClient, dbId: String, fields: [String: JSONValue]
    ) async throws {
        try await elastic.bulkUpdate([.init(index: Indices.databases, id: dbId, doc: fields)])
        try await elastic.refresh(Indices.databases)
    }

    @discardableResult
    static func analyze(
        _ elastic: ElasticClient, dbId: String, logger: Logger,
        extra: @Sendable @escaping (_ objects: Int) -> [String: JSONValue] = { _ in [:] }
    ) async throws -> Passes.Outcome {
        do {

            return try await Passes.gate.run(dbId) {
                let outcome = try await Passes.complete(elastic, database: dbId, logger: logger)
                let census = try await IngestReport.census(elastic, database: dbId, logger: logger)

                let objects = max(0, census.nodeTotal - outcome.baseStubs)
                var fields: [String: JSONValue] = [
                    "tierZeroCount": .int(outcome.tierZero),
                    "baseCount": .int(outcome.baseStubs),
                    "derivedEdgeCount": .int(outcome.derivedEdges),
                    "nodeCount": .int(objects),
                    "edgeCount": .int(max(0, census.edgeTotal - outcome.derivedEdges)),
                    "census": IngestReport.encode(census),
                    "analyzed": .bool(true),

                    "analysisError": .null,
                ]
                fields.merge(extra(objects)) { _, new in new }
                try await update(elastic, dbId: dbId, fields: fields)
                return outcome
            }
        } catch {

            try? await update(
                elastic, dbId: dbId, fields: ["analysisError": .string(failureReason(error))])
            throw error
        }
    }

    static func delete(_ elastic: ElasticClient, dbId: String, logger: Logger) async throws {
        try await Passes.gate.run(dbId) {
            let match: JSONValue = ["term": ["db": .string(dbId)]]

            for index in Indices.databaseScoped {
                try await elastic.deleteByQuery(index: index, match)
            }
            try await elastic.delete(index: Indices.databases, id: dbId)
            logger.info("Ingest: deleted database \(dbId)")
        }
    }

    static func defaultName(for fileName: String) -> String {
        let stem = fileName.split(separator: "_").first.map(String.init) ?? fileName
        let isTimestamp = stem.count >= 8 && stem.allSatisfy(\.isNumber)
        return isTimestamp ? stem : fileName
    }
}

extension Array {

    func chunked(_ size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

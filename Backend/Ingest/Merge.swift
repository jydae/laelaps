import Foundation
import Hummingbird
import Logging

enum Merge {

    static let termsChunk = 10_000

    static func candidates(_ elastic: ElasticClient, project: String) async throws -> [MergePairDTO] {
        let databases = try await DatabaseStore.list(elastic, project: project)
        guard databases.count >= 2 else { return [] }
        let names = Dictionary(uniqueKeysWithValues: databases.map { ($0.id, $0.name) })

        func rows(_ query: JSONValue) async throws -> [(id: String, db: String)] {
            try await elastic.scan(index: Indices.nodes, query: query, source: ["id", "db"],
                                   sort: ["db", "id"]).compactMap { hit -> (id: String, db: String)? in
                guard let source = hit["_source"], let id = source["id"]?.string,
                      let db = source["db"]?.string else { return nil }
                return (id: id, db: db)
            }
        }

        let base: JSONValue = ["term": ["kind": .string(ADNodeKind.base.rawValue)]]
        var stubs: [String: Set<String>] = [:]
        for row in try await rows(base) { stubs[row.db, default: []].insert(row.id) }
        let wanted = Set(stubs.values.flatMap { $0 }).sorted()
        guard !wanted.isEmpty else { return [] }

        var described: [String: Set<String>] = [:]
        for chunk in wanted.chunked(termsChunk) {
            for row in try await rows(["bool": [
                "must": .array([["terms": ["id": .strings(chunk)]]]),
                "must_not": .array([base]),
            ]]) { described[row.id, default: []].insert(row.db) }
        }

        var domains: [String: Set<String>] = [:]
        for row in try await rows(["term": ["kind": .string(ADNodeKind.domain.rawValue)]]) {
            domains[row.db, default: []].insert(row.id)
        }

        let combined = alreadyCombined(databases)
        var out: [MergePairDTO] = []
        for (i, a) in databases.enumerated() {
            for b in databases.dropFirst(i + 1) {
                if combined.contains(pairKey(a.id, b.id)) { continue }
                let forward = (stubs[a.id] ?? []).filter { described[$0]?.contains(b.id) == true }
                let backward = (stubs[b.id] ?? []).filter { described[$0]?.contains(a.id) == true }
                let resolves = forward.count + backward.count
                guard resolves > 0 else { continue }
                out.append(MergePairDTO(
                    a: a.id, aName: names[a.id] ?? a.id,
                    b: b.id, bName: names[b.id] ?? b.id,
                    resolves: resolves,
                    overlapping: !(domains[a.id] ?? []).isDisjoint(with: domains[b.id] ?? [])))
            }
        }
        return out.sorted { $0.resolves > $1.resolves }
    }

    static func pairKey(_ a: String, _ b: String) -> String { [a, b].sorted().joined(separator: "|") }

    static func alreadyCombined(_ databases: [DatabaseDTO]) -> Set<String> {
        let sources = Dictionary(uniqueKeysWithValues: databases.map { ($0.id, $0.sources) })
        func ancestry(_ id: String, _ seen: Set<String> = []) -> Set<String> {
            guard !seen.contains(id) else { return [] }
            var out = Set(sources[id] ?? [])
            for source in sources[id] ?? [] { out.formUnion(ancestry(source, seen.union([id]))) }
            return out
        }
        var out: Set<String> = []
        for database in databases {
            let lineage = ancestry(database.id)
            for ancestor in lineage { out.insert(pairKey(database.id, ancestor)) }
            let direct = database.sources
            for (i, left) in direct.enumerated() {
                for right in direct.dropFirst(i + 1) { out.insert(pairKey(left, right)) }
            }
        }
        return out
    }

    static func create(
        _ elastic: ElasticClient, project: String, sources requested: [String], name: String?,
        logger: Logger
    ) async throws -> DatabaseDTO {
        var sources: [String] = []
        for id in requested where !sources.contains(id) { sources.append(id) }
        guard sources.count >= 2 else {
            throw HTTPError(.badRequest, message: "Merging needs at least two databases.")
        }
        let picked = try await DatabaseStore.list(elastic, project: project)
            .filter { sources.contains($0.id) }
            .sorted { $0.created < $1.created }
        guard picked.count == sources.count else {
            throw HTTPError(.badRequest, message: "One of those databases no longer exists.")
        }

        let target = "db-merge-"
            + String(Int(Date().timeIntervalSince1970), radix: 36)
            + "-" + String(UInt32.random(in: 0..<UInt32.max), radix: 36)

        _ = try await copy(elastic, sources: picked.map(\.id), into: target, logger: logger)

        try await elastic.index(Indices.databases, id: target, doc: [
            "id": .string(target),
            "project": .string(project),
            "name": .string(name ?? picked.map(\.name).joined(separator: " + ")),
            "created": .string(ElasticClient.timestamp()),
            "updated": .string(ElasticClient.timestamp()),
            "files": .strings(picked.flatMap(\.files)),
            "fileCount": .int(picked.reduce(0) { $0 + $1.fileCount }),
            "byteCount": .int(picked.reduce(0) { $0 + $1.byteCount }),
            "nodeCount": .int(0), "edgeCount": .int(0),
            "declaredCount": .int(0), "skippedCount": .int(0), "mergedCount": .int(0),
            "tierZeroCount": .int(0), "baseCount": .int(0), "derivedEdgeCount": .int(0),
            "sources": .strings(picked.map(\.id)),
            "analyzed": .bool(false),
            "ledger": .array([]),
        ])

        try await DatabaseStore.analyze(elastic, dbId: target, logger: logger) { objects in
            ["declaredCount": .int(objects)]
        }
        guard let merged = try await DatabaseStore.list(elastic, project: project)
            .first(where: { $0.id == target }) else { throw HTTPError(.internalServerError) }
        return merged
    }

    static func copy(
        _ elastic: ElasticClient, sources: [String], into target: String, logger: Logger? = nil
    ) async throws -> (nodes: Int, edges: Int) {
        var nodes = 0, edges = 0
        let stub: JSONValue = ["term": ["kind": .string(ADNodeKind.base.rawValue)]]

        for onlyStubs in [true, false] {
            for source in sources {
                var must: [JSONValue] = [["term": ["db": .string(source)]]]
                var mustNot: [JSONValue] = []
                if onlyStubs { must.append(stub) } else { mustNot.append(stub) }
                let query: JSONValue = ["bool": [
                    "must": .array(must), "must_not": .array(mustNot),
                ]]
                nodes += try await copyPages(
                    elastic, index: Indices.nodes, query: query, into: target,
                    sort: GraphStore.nodeOrder, key: { "\(target)|\($0["id"]?.string ?? "")" })
            }
        }
        for source in sources {
            edges += try await copyPages(
                elastic, index: Indices.edges,
                query: ["term": ["db": .string(source)]], into: target,
                sort: GraphStore.edgeOrder,
                key: {
                    GraphStore.edgeID(db: target, source: $0["source"]?.string ?? "",
                                      kind: $0["kind"]?.string ?? "", target: $0["target"]?.string ?? "")
                })
        }
        try await elastic.refresh(Indices.nodes, Indices.edges)
        logger?.info("Merge: merged \(sources.count) databases into \(target)")
        return (nodes, edges)
    }

    private static func copyPages(
        _ elastic: ElasticClient, index: String, query: JSONValue, into target: String,
        sort: [String], key: ([String: JSONValue]) -> String
    ) async throws -> Int {
        var written = 0
        var cursor: JSONValue?
        repeat {
            let page = try await elastic.page(
                index: index, query: query, source: ["*"], sort: sort, after: cursor)
            let ops: [ElasticClient.BulkOp] = page.hits.compactMap { hit in
                guard var doc = hit["_source"]?.object else { return nil }
                doc["db"] = .string(target)
                return .init(index: index, id: key(doc), doc: doc)
            }
            written += try await elastic.bulk(ops).created
            cursor = page.cursor
        } while cursor != nil
        return written
    }
}

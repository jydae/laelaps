import Foundation
import Hummingbird
import Logging

enum AssertionOp: String, Sendable {

    case rename

    case owned

    case link

    case refute

    case annotate

    case zone

    case tier
}

extension AssertionOp {

    var movesTheGraph: Bool {
        switch self {
        case .rename, .owned, .annotate: return false
        case .zone, .tier, .link, .refute: return true
        }
    }

    var movesTheEdges: Bool {
        switch self {
        case .link, .refute: return true
        case .rename, .owned, .annotate, .zone, .tier: return false
        }
    }
}

enum AssertionSubject: String, Sendable {
    case node
    case edge
}

struct Assertion: Sendable {
    let id: String
    let db: String
    let changeset: String

    let subject: String
    let subjectKind: AssertionSubject
    let op: AssertionOp
    let value: [String: JSONValue]
    let author: String
    let assertedAt: String
    let effectiveAt: String
    let reason: String?
    let supersededBy: String?

    static func newID(at now: Date = Date()) -> String {
        let ms = UInt64(now.timeIntervalSince1970 * 1000)
        let stamp = String(ms, radix: 36)
        let noise = String(UInt32.random(in: 0..<UInt32.max), radix: 36)
        return "\(String(repeating: "0", count: max(0, 10 - stamp.count)))\(stamp)-\(noise)"
    }

    var document: [String: JSONValue] {
        var doc: [String: JSONValue] = [
            "db": .string(db),
            "changeset": .string(changeset),
            "subject": .string(subject),
            "subjectKind": .string(subjectKind.rawValue),
            "op": .string(op.rawValue),
            "value": .object(value),
            "author": .string(author),
            "assertedAt": .string(assertedAt),
            "effectiveAt": .string(effectiveAt),
        ]
        if let reason { doc["reason"] = .string(reason) }
        if let supersededBy { doc["supersededBy"] = .string(supersededBy) }
        return doc
    }

    static func from(id: String, source: JSONValue) -> Assertion? {
        guard let db = source["db"]?.string,
              let subject = source["subject"]?.string,
              let opRaw = source["op"]?.string, let op = AssertionOp(rawValue: opRaw),
              let kindRaw = source["subjectKind"]?.string,
              let kind = AssertionSubject(rawValue: kindRaw)
        else { return nil }
        return Assertion(
            id: id, db: db,
            changeset: source["changeset"]?.string ?? "",
            subject: subject, subjectKind: kind, op: op,
            value: source["value"]?.object ?? [:],
            author: source["author"]?.string ?? "unknown",
            assertedAt: source["assertedAt"]?.string ?? "",
            effectiveAt: source["effectiveAt"]?.string ?? "",
            reason: source["reason"]?.string,
            supersededBy: source["supersededBy"]?.string
        )
    }
}

struct AssertedEdge: Sendable, Hashable {
    let source: String
    let kind: String
    let target: String

    init?(subject: String) {
        let parts = subject.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, !parts[0].isEmpty, !parts[1].isEmpty, !parts[2].isEmpty else { return nil }
        source = parts[0]; kind = parts[1]; target = parts[2]
    }

    func documentID(db: String) -> String { "\(db)|\(source)|\(kind)|\(target)" }
}

enum Assertions {

    static func notesMap(_ stored: JSONValue?) -> [String: JSONValue] {
        if let map = stored?.object { return map }
        var out: [String: JSONValue] = [:]
        for entry in stored?.array ?? [] {
            if let key = entry["key"]?.string, let text = entry["text"] { out[key] = text }
        }
        return out
    }

    static let nodeProjection = [
        "labelAsserted", "owned", "ownedReason", "zoneAsserted", "zoneRefuted", "notes",
    ]

    struct Outcome: Sendable {
        let live: Int
    }

    private struct NodeState {
        var labelAsserted: String?
        var owned: Bool = false
        var ownedReason: String?
        var zoneAsserted: Bool = false
        var zoneRefuted: Bool = false

        var tierAsserted: Int?
        var notes: [String: JSONValue] = [:]

        var isEmpty: Bool {
            labelAsserted == nil && !owned && !zoneAsserted && !zoneRefuted
                && tierAsserted == nil && notes.isEmpty
        }

        var document: [String: JSONValue] {
            [
                "labelAsserted": labelAsserted.map { JSONValue.string($0) } ?? .null,
                "owned": .bool(owned),
                "ownedReason": ownedReason.map { JSONValue.string($0) } ?? .null,
                "zoneAsserted": .bool(zoneAsserted),
                "zoneRefuted": .bool(zoneRefuted),
                "tierAsserted": tierAsserted.map { JSONValue.int($0) } ?? .null,

                "notes": notes.isEmpty ? .null : .array(notes.keys.sorted().map { key in
                    .object(["key": .string(key), "text": notes[key] ?? .null])
                }),
            ]
        }

        static var cleared: [String: JSONValue] {
            [
                "labelAsserted": .null, "owned": .bool(false), "ownedReason": .null,
                "zoneAsserted": .bool(false), "zoneRefuted": .bool(false),
                "tierAsserted": .null,
                "notes": .null,
            ]
        }
    }

    @discardableResult
    static func project(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Outcome {
        let live = try await liveAssertions(elastic, database: database, logger: logger)

        var nodes: [String: NodeState] = [:]
        var linked: Set<AssertedEdge> = []
        var refuted: Set<AssertedEdge> = []

        for assertion in live {
            switch assertion.op {
            case .rename:
                let name = assertion.value["label"]?.string
                nodes[assertion.subject, default: NodeState()].labelAsserted =
                    (name?.isEmpty ?? true) ? nil : name
            case .owned:
                let on = assertion.value["owned"]?.bool ?? true
                nodes[assertion.subject, default: NodeState()].owned = on
                nodes[assertion.subject, default: NodeState()].ownedReason =
                    on ? (assertion.reason ?? assertion.value["reason"]?.string) : nil
            case .zone:
                let member = assertion.value["member"]?.bool ?? true
                nodes[assertion.subject, default: NodeState()].zoneAsserted = member
                nodes[assertion.subject, default: NodeState()].zoneRefuted = !member
            case .annotate:
                let key = assertion.value["key"]?.string ?? "note"
                if let text = assertion.value["text"]?.string, !text.isEmpty {
                    nodes[assertion.subject, default: NodeState()].notes[key] = .string(text)
                } else {
                    nodes[assertion.subject, default: NodeState()].notes.removeValue(forKey: key)
                }
            case .tier:
                nodes[assertion.subject, default: NodeState()].tierAsserted = assertion.value["tier"]?.int
            case .link:
                if let edge = AssertedEdge(subject: assertion.subject) { linked.insert(edge) }
            case .refute:
                if let edge = AssertedEdge(subject: assertion.subject) { refuted.insert(edge) }
            }
        }

        let cleared = try await reconcileNodes(elastic, database: database, desired: nodes, logger: logger)
        let (added, marked) = try await reconcileEdges(
            elastic, database: database, linked: linked, refuted: refuted)

        logger?.info("""
            Assertions: [\(database)] \(live.count) live, \(nodes.count) nodes projected, \
            \(cleared) cleared, \(added) edges asserted, \(marked) refuted
            """)
        return Outcome(live: live.count)
    }

    static func liveAssertions(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> [Assertion] {
        let query: JSONValue = ["bool": [
            "must": [.object(["term": .object(["db": .string(database)])])],
            "must_not": [.object(["exists": .object(["field": .string("supersededBy")])])],
        ]]

        var out: [Assertion] = []
        var from = 0
        let size = 1_000
        let ceiling = 10_000
        while true {
            let hits = try await elastic.search(index: Indices.assertions, [
                "size": .int(size), "from": .int(from),
                "sort": [
                    .object(["assertedAt": .object(["order": .string("asc")])]),
                    .object(["changeset": .object(["order": .string("asc")])]),
                ],
                "query": query,
            ])
            let rows = hits["hits"]?["hits"]?.array ?? []
            for row in rows {
                guard let id = row["_id"]?.string, let source = row["_source"] else { continue }
                if let assertion = Assertion.from(id: id, source: source) { out.append(assertion) }
            }
            if rows.count < size { break }
            from += size
            if from >= ceiling {
                logger?.warning("""
                    Assertions: [\(database)] more than \(ceiling) live claims; the rest are \
                    not being projected.
                    """)
                break
            }
        }
        return out
    }

    private static func reconcileNodes(
        _ elastic: ElasticClient, database: String,
        desired: [String: NodeState], logger: Logger?
    ) async throws -> Int {

        let projected = try await projectedNodeIDs(elastic, database: database)
        let wanted = Set(desired.filter { !$0.value.isEmpty }.keys)
        let stale = projected.subtracting(wanted)

        var ops = desired.compactMap { id, state -> ElasticClient.BulkOp? in
            state.isEmpty ? nil : ElasticClient.BulkOp(
                index: Indices.nodes, id: "\(database)|\(id)", doc: state.document)
        }
        ops += stale.map { id in
            ElasticClient.BulkOp(
                index: Indices.nodes, id: "\(database)|\(id)", doc: NodeState.cleared)
        }
        guard !ops.isEmpty else { return 0 }

        let absent: Int
        do { absent = try await elastic.bulkUpdate(ops, skippingMissing: true).missing } catch {
            logger?.error("Assertions: [\(database)] node projection failed: \(error)")
            throw error
        }
        if absent > 0 {
            logger?.info(
                "Assertions: [\(database)] \(absent) projections name objects with no document and were not written")
        }
        try await elastic.refresh(Indices.nodes)
        return stale.count
    }

    private static func projectedNodeIDs(
        _ elastic: ElasticClient, database: String
    ) async throws -> Set<String> {
        let carrying: [JSONValue] = nodeProjection.map { field in
            field == "owned" || field == "zoneAsserted" || field == "zoneRefuted"
                ? ["term": [.init(stringLiteral: field): .bool(true)]]
                : ["exists": ["field": .string(field)]]
        }

        return try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["bool": ["should": .array(carrying), "minimum_should_match": 1]],
        ], db: database))
    }

    private static func reconcileEdges(
        _ elastic: ElasticClient, database: String,
        linked: Set<AssertedEdge>, refuted: Set<AssertedEdge>
    ) async throws -> (added: Int, refuted: Int) {

        let collected = try await GraphStore.collectedEdgeIDs(
            elastic, ids: linked.map { $0.documentID(db: database) }, db: database)
        let ops: [ElasticClient.BulkOp] = linked.filter {
            !collected.contains($0.documentID(db: database))
        }.map { edge in
            ElasticClient.BulkOp(index: Indices.edges, id: edge.documentID(db: database), doc: [
                "db": .string(database),
                "source": .string(edge.source),
                "kind": .string(edge.kind),
                "target": .string(edge.target),
                "origin": .string("asserted"),
            ])
        }

        try await elastic.bulkUpdate(ops, upsert: true)

        var marks: [ElasticClient.BulkOp] = refuted.map { edge in
            ElasticClient.BulkOp(index: Indices.edges, id: edge.documentID(db: database),
                                 doc: ["refuted": .bool(true)])
        }

        let (wasLinked, wasRefuted) = try await markedEdges(elastic, database: database)
        for edge in wasRefuted.subtracting(refuted) {
            marks.append(ElasticClient.BulkOp(
                index: Indices.edges, id: edge.documentID(db: database),
                doc: ["refuted": .bool(false)]))
        }

        try await elastic.bulkUpdate(marks, skippingMissing: true)
        for edge in wasLinked.subtracting(linked) {
            try await elastic.delete(index: Indices.edges, id: edge.documentID(db: database))
        }

        try await elastic.refresh(Indices.edges)
        return (linked.count, refuted.count)
    }

    private static func markedEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> (linked: Set<AssertedEdge>, refuted: Set<AssertedEdge>) {

        let query = GraphStore.scoped([["bool": [
            "should": [
                .object(["term": .object(["origin": .string("asserted")])]),
                .object(["term": .object(["refuted": .bool(true)])]),
            ],
            "minimum_should_match": 1,
        ]]], db: database)
        var linked: Set<AssertedEdge> = []
        var refuted: Set<AssertedEdge> = []
        for edge in try await GraphStore.edges(elastic, query) {
            guard let asserted = AssertedEdge(subject: "\(edge.source)|\(edge.kind)|\(edge.target)")
            else { continue }
            if edge.origin == "asserted" { linked.insert(asserted) }
            if edge.refuted { refuted.insert(asserted) }
        }
        return (linked, refuted)
    }
}

struct AssertionRecordDTO: ResponseEncodable {
    let id: String
    let changeset: String
    let subject: String
    let subjectKind: String
    let op: String
    let author: String
    let assertedAt: String
    let effectiveAt: String
    let reason: String?
    let supersededBy: String?
    let value: [String: JSONValue]
}

struct CommitOutcomeDTO: ResponseEncodable {
    let live: Int

    let rewalked: Bool
}

enum AssertRoutes {
    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient, logger: Logger
    ) {

        router.post("api/assert") { request, _ -> CommitOutcomeDTO in
            let buffer = try await request.body.collect(upTo: 512 * 1024)
            let body = try JSONValue.parse(Array(buffer.readableBytesView))
            let session = try await Sessions.require(request)
            let db = try await GraphRoutes.db(request, elastic, body["db"]?.string)

            let changes = body["changes"]?.array ?? (body["change"].map { [$0] } ?? [])
            guard !changes.isEmpty else { throw HTTPError(.badRequest) }

            let now = ElasticClient.timestamp()
            let batch = Assertion.newID()
            var ops: [ElasticClient.BulkOp] = []
            var rewalk = false
            var rederive = false

            var referenced = Set<String>()

            for change in changes {
                guard let subject = change["subject"]?.string, !subject.isEmpty,
                      let opRaw = change["op"]?.string, let op = AssertionOp(rawValue: opRaw),
                      let kindRaw = change["subjectKind"]?.string,
                      let kind = AssertionSubject(rawValue: kindRaw)
                else { throw HTTPError(.badRequest) }
                switch kind {
                case .node:
                    referenced.insert(subject)
                case .edge:
                    guard let edge = AssertedEdge(subject: subject) else {
                        throw HTTPError(.badRequest, message: "Malformed edge subject '\(subject)'.")
                    }
                    referenced.insert(edge.source)
                    referenced.insert(edge.target)
                }
                if op.movesTheGraph { rewalk = true }
                if op.movesTheEdges { rederive = true }
                let assertion = Assertion(
                    id: Assertion.newID(), db: db, changeset: batch,
                    subject: subject, subjectKind: kind, op: op,
                    value: change["value"]?.object ?? [:],
                    author: session.user,
                    assertedAt: now,
                    effectiveAt: change["effectiveAt"]?.string ?? now,
                    reason: change["reason"]?.string ?? body["reason"]?.string,
                    supersededBy: nil
                )
                ops.append(ElasticClient.BulkOp(
                    index: Indices.assertions, id: assertion.id, doc: assertion.document))
            }

            try await requireObjects(elastic, database: db, ids: referenced)
            try await elastic.bulk(ops)
            try await elastic.refresh(Indices.assertions)
            return try await settle(
                elastic, database: db, rewalk: rewalk, rederive: rederive,
                logger: logger)
        }

        router.get("api/assert") { request, _ -> [AssertionRecordDTO] in
            try await history(elastic, db: try await GraphRoutes.db(request, elastic), logger: logger)
        }
    }

    static func history(_ elastic: ElasticClient, db: String, logger: Logger) async throws -> [AssertionRecordDTO] {

        let historyLimit = 5_000
        let hits = try await elastic.search(index: Indices.assertions, [
            "size": .int(historyLimit),
            "sort": [.object(["assertedAt": .object(["order": .string("desc")])])],
            "query": ["term": ["db": .string(db)]],
        ])
        let rows = (hits["hits"]?["hits"]?.array ?? []).compactMap { row -> Assertion? in
            guard let id = row["_id"]?.string, let source = row["_source"] else { return nil }
            return Assertion.from(id: id, source: source)
        }

        if rows.count >= historyLimit {
            logger.warning(
                "Assertions: [\(db)] history capped at \(historyLimit); older entries are not shown.")
        }
        return rows.map { assertion in
            AssertionRecordDTO(
                id: assertion.id, changeset: assertion.changeset,
                subject: assertion.subject, subjectKind: assertion.subjectKind.rawValue,
                op: assertion.op.rawValue, author: assertion.author,
                assertedAt: assertion.assertedAt, effectiveAt: assertion.effectiveAt,
                reason: assertion.reason, supersededBy: assertion.supersededBy,
                value: assertion.value)
        }
    }

    private static func settle(
        _ elastic: ElasticClient, database: String,
        rewalk: Bool, rederive: Bool, logger: Logger
    ) async throws -> CommitOutcomeDTO {

        let projection: Assertions.Outcome = try await Passes.gate.run(database) {
            if rederive {
                return try await Passes.complete(elastic, database: database, logger: logger).assertions
            }
            let projected = try await Assertions.project(elastic, database: database, logger: logger)
            if rewalk {
                try await TierZero.analyze(elastic, database: database, logger: logger)
                try await Zones.analyze(elastic, database: database, logger: logger)
            }
            return projected
        }
        try await invalidateCensus(elastic, database: database)
        return CommitOutcomeDTO(live: projection.live, rewalked: rewalk)
    }

    private static func invalidateCensus(
        _ elastic: ElasticClient, database: String
    ) async throws {

        try await elastic.bulkUpdate(
            [ElasticClient.BulkOp(index: Indices.databases, id: database, doc: ["census": .null])],
            skippingMissing: true)
    }

    private static func requireObjects(
        _ elastic: ElasticClient, database: String, ids: Set<String>
    ) async throws {
        guard !ids.isEmpty else { return }
        let hits = try await elastic.fetchByIDs(
            index: Indices.nodes, ids: Array(ids), source: ["id"], db: database)
        var found = Set<String>()
        for hit in hits {
            if let id = hit["_source"]?["id"]?.string { found.insert(id) }
        }
        let unknown = ids.subtracting(found).sorted()
        guard unknown.isEmpty else {
            let named = unknown.prefix(3).joined(separator: ", ")
            let rest = unknown.count > 3 ? " (and \(unknown.count - 3) more)" : ""
            throw HTTPError(
                .badRequest,
                message: "No object in this database with id \(named)\(rest). Nothing was written.")
        }
    }
}

import Foundation
import Hummingbird
import Logging

struct IngestFileRecordDTO: ResponseEncodable {
    let name: String
    let uploaded: String
    let fileExtension: String
    let contentType: String
    let status: String

    let declared: Int?
    let present: Int
    let nodes: Int
    let edges: Int
    let skipped: Int
    let merged: Int
    let edgesFolded: Int
    let bytes: Int
    let note: String?

    let collectorVersion: Int?
    let methods: [String]
}

struct CensusDTO: ResponseEncodable {
    let computed: String
    let nodeTotal: Int
    let edgeTotal: Int

    let computersEnabled: Int
    let computersWithSessions: Int

    let domains: [CensusDomainDTO]

    let trusts: [CensusTrustDTO]
}

struct CensusDomainDTO: ResponseEncodable, Equatable {
    let id: String
    let label: String
    let objects: Int
    let tierZero: Int
}

struct CensusTrustDTO: ResponseEncodable, Equatable {
    let from: String
    let fromLabel: String
    let fromCollected: Bool
    let to: String
    let toLabel: String
    let toCollected: Bool

    let kind: String
    let bidirectional: Bool
}

struct DatabaseDetailDTO: ResponseEncodable {
    let id: String
    let files: [IngestFileRecordDTO]
    let census: CensusDTO?
}

enum IngestReport {

    enum Status: String, Sendable {
        case ok, short, ignored, rejected
    }

    struct Record: Sendable {
        let name: String
        let fileExtension: String
        let contentType: String
        let status: Status
        let declared: Int?
        let present: Int
        let nodes: Int
        let edges: Int
        let skipped: Int
        let merged: Int
        let edgesFolded: Int
        let bytes: Int
        let note: String?
        let version: Int?
        let methods: Int?

        init(
            name: String, fileExtension: String, contentType: String, status: Status,
            declared: Int? = nil, present: Int = 0, nodes: Int = 0, edges: Int = 0,
            skipped: Int = 0, merged: Int = 0, edgesFolded: Int = 0, bytes: Int = 0,
            note: String? = nil, version: Int? = nil, methods: Int? = nil
        ) {
            self.name = name; self.fileExtension = fileExtension
            self.contentType = contentType; self.status = status
            self.declared = declared; self.present = present
            self.nodes = nodes; self.edges = edges; self.skipped = skipped
            self.merged = merged; self.edgesFolded = edgesFolded
            self.bytes = bytes; self.note = note
            self.version = version; self.methods = methods
        }
    }

    static let collectionMethods: [String] = [
        "Group", "LocalAdmin", "GPOLocalGroup", "Session", "LoggedOn", "Trusts", "ACL",
        "Container", "RDP", "ObjectProps", "SessionLoop", "LoggedOnLoop", "DCOM",
        "SPNTargets", "PSRemote", "UserRights", "CARegistry", "DCRegistry", "CertServices",
    ]
    static func methodNames(_ mask: Int?) -> [String] {
        guard let mask, mask > 0 else { return [] }
        return collectionMethods.enumerated().compactMap { bit, name in
            mask & (1 << bit) != 0 ? name : nil
        }
    }

    static func reconcile(_ parsed: BloodHoundImport.Parsed) -> (Status, String?) {
        var faults: [String] = []
        var remarks: [String] = []

        if let declared = parsed.declared, declared != parsed.present {
            let text = "envelope declared \(declared), file held \(parsed.present)"

            if declared > parsed.present { faults.append(text) } else { remarks.append(text) }
        }
        if parsed.skipped > 0 {
            faults.append("\(parsed.skipped) objects had no ObjectIdentifier")
        }
        if parsed.merged > 0 {
            remarks.append("\(parsed.merged) repeated an id and were folded together")
        }
        if parsed.edgesFolded > 0 {
            remarks.append("\(parsed.edgesFolded) relationships were emitted more than once")
        }
        if parsed.unresolvedLocalGroups > 0 {
            remarks.append(
                "\(parsed.unresolvedLocalGroups) rights held by local groups that were not collected")
        }

        if parsed.rejectedRights > 0 {
            faults.append(
                "\(parsed.rejectedRights) ACEs named a composed relationship kind and were refused")
        }
        if parsed.unknownRights > 0 {
            remarks.append(
                "\(parsed.unknownRights) ACEs carry a right this build does not recognise (drawn, not traversed)")
        }

        let expected = parsed.present - parsed.skipped - parsed.merged
        if parsed.nodes.count != expected {
            faults.append("\(expected - parsed.nodes.count) objects lost after parsing")
        }

        let note = (faults + remarks).joined(separator: "; ")
        return (faults.isEmpty ? .ok : .short, note.isEmpty ? nil : note)
    }

    static func encode(_ record: Record) -> JSONValue {
        .object([
            "name": .string(record.name),
            "uploaded": .string(ElasticClient.timestamp()),
            "extension": .string(record.fileExtension),
            "contentType": .string(record.contentType),
            "status": .string(record.status.rawValue),
            "declared": record.declared.map { JSONValue.int($0) } ?? .null,
            "present": .int(record.present),
            "nodes": .int(record.nodes),
            "edges": .int(record.edges),
            "skipped": .int(record.skipped),
            "merged": .int(record.merged),
            "edgesFolded": .int(record.edgesFolded),
            "bytes": .int(record.bytes),
            "note": record.note.map { JSONValue.string($0) } ?? .null,
            "version": record.version.map { JSONValue.int($0) } ?? .null,
            "methods": record.methods.map { JSONValue.int($0) } ?? .null,
        ])
    }

    static func files(from source: JSONValue?) -> [IngestFileRecordDTO] {
        (source?["ledger"]?.array ?? []).compactMap { row in
            guard let name = row["name"]?.string else { return nil }
            return IngestFileRecordDTO(
                name: name,
                uploaded: row["uploaded"]?.string ?? "",
                fileExtension: row["extension"]?.string ?? "",
                contentType: row["contentType"]?.string ?? "",
                status: row["status"]?.string ?? Status.ok.rawValue,
                declared: row["declared"]?.int,
                present: row["present"]?.int ?? 0,
                nodes: row["nodes"]?.int ?? 0,
                edges: row["edges"]?.int ?? 0,
                skipped: row["skipped"]?.int ?? 0,
                merged: row["merged"]?.int ?? 0,
                edgesFolded: row["edgesFolded"]?.int ?? 0,
                bytes: row["bytes"]?.int ?? 0,
                note: row["note"]?.string,
                collectorVersion: row["version"]?.int,
                methods: methodNames(row["methods"]?.int))
        }
    }

    static func census(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> CensusDTO {
        let scope: JSONValue = ["term": ["db": .string(database)]]

        let nodeTotal = try await elastic.count(index: Indices.nodes, scope)
        let edgeTotal = try await elastic.count(index: Indices.edges, scope)
        let coverage = try await coverage(elastic, scope: scope)
        let domains = try await domains(elastic, database: database)
        let trusts = summarizeTrusts(try await trustEdges(elastic, database: database), domains: domains)

        logger?.info(
            "Census: [\(database)] \(nodeTotal) nodes, \(edgeTotal) edges, \(domains.count) domains, \(trusts.count) trusts")
        return CensusDTO(
            computed: ElasticClient.timestamp(), nodeTotal: nodeTotal, edgeTotal: edgeTotal,
            computersEnabled: coverage.enabled, computersWithSessions: coverage.sessions,
            domains: domains, trusts: trusts)
    }

    private static let collectedOnly: JSONValue =
        ["bool": ["must_not": ["term": ["derived": .bool(true)]]]]

    private static func coverage(
        _ elastic: ElasticClient, scope: JSONValue
    ) async throws -> (enabled: Int, sessions: Int) {
        let computer: JSONValue = ["term": ["kind": .string(ADNodeKind.computer.rawValue)]]
        let must = { (clauses: [JSONValue]) -> JSONValue in ["bool": ["must": .array([scope] + clauses)]] }
        do {
            return (
                enabled: try await elastic.count(
                    index: Indices.nodes, must([computer, ["term": ["props.enabled": .bool(true)]]])),

                sessions: try await elastic.distinct(
                    index: Indices.edges, field: "source",
                    must([["term": ["kind": .string(ADEdgeKind.hasSession.rawValue)]],
                          collectedOnly])))
        } catch ElasticError.notFound { return (0, 0) }
    }

    private static func domains(
        _ elastic: ElasticClient, database: String
    ) async throws -> [CensusDomainDTO] {
        let hits: [JSONValue]
        do {
            hits = try await elastic.scan(
                index: Indices.nodes,
                query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.domain.rawValue)]]], db: database),
                source: ["id", "label", "labelAsserted"], sort: GraphStore.nodeOrder)
        } catch ElasticError.notFound { return [] }

        var out: [CensusDomainDTO] = []
        for hit in hits {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let inDomain = { (extra: [JSONValue]) -> JSONValue in
                GraphStore.scoped([["term": ["props.domainsid": .string(id)]]] + extra, db: database)
            }
            out.append(CensusDomainDTO(
                id: id, label: GraphStore.label(source, id: id),
                objects: try await elastic.count(index: Indices.nodes, inDomain([])),
                tierZero: try await elastic.count(
                    index: Indices.nodes, inDomain([["term": ["tierZero": .bool(true)]]]))))
        }
        return out.sorted { $0.label < $1.label }
    }

    struct TrustEdge: Sendable, Equatable {
        let from: String
        let to: String
        let kind: String

        let peer: String?
        let peerName: String?
    }

    private static func trustEdges(_ elastic: ElasticClient, database: String) async throws -> [TrustEdge] {
        let kinds = [ADEdgeKind.sameForestTrust.rawValue, ADEdgeKind.crossForestTrust.rawValue]
        do {
            return try await elastic.scan(
                index: Indices.edges,
                query: GraphStore.edgeScope([["terms": ["kind": .strings(kinds)]]], db: database),
                source: ["source", "target", "kind", "peer", "peerName"], sort: GraphStore.edgeOrder
            ) { hit in
                guard let source = hit["_source"], let from = source["source"]?.string,
                      let to = source["target"]?.string, let kind = source["kind"]?.string else { return nil }
                return TrustEdge(from: from, to: to, kind: kind,
                                 peer: source["peer"]?.string, peerName: source["peerName"]?.string)
            }
        } catch ElasticError.notFound { return [] }
    }

    static func summarizeTrusts(_ edges: [TrustEdge], domains: [CensusDomainDTO]) -> [CensusTrustDTO] {
        var labels = Dictionary(domains.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        let collected = Set(domains.map(\.id))
        for edge in edges {
            if let peer = edge.peer, let name = edge.peerName, !name.isEmpty, labels[peer] == nil {
                labels[peer] = name
            }
        }

        var order: [String] = []
        var byPair: [String: (first: TrustEdge, reverse: Bool)] = [:]
        for edge in edges {
            let key = [edge.from, edge.to].sorted().joined(separator: "|")
            if let seen = byPair[key] {
                if seen.first.from == edge.to { byPair[key] = (seen.first, true) }
            } else {
                byPair[key] = (edge, false)
                order.append(key)
            }
        }

        return order.compactMap { byPair[$0] }.map { pair in

            let edge = pair.reverse && !collected.contains(pair.first.from) && collected.contains(pair.first.to)
                ? TrustEdge(from: pair.first.to, to: pair.first.from, kind: pair.first.kind,
                            peer: pair.first.peer, peerName: pair.first.peerName)
                : pair.first
            return CensusTrustDTO(
                from: edge.from, fromLabel: labels[edge.from] ?? edge.from,
                fromCollected: collected.contains(edge.from),
                to: edge.to, toLabel: labels[edge.to] ?? edge.to,
                toCollected: collected.contains(edge.to),
                kind: edge.kind, bidirectional: pair.reverse)
        }.sorted { ($0.fromLabel, $0.toLabel) < ($1.fromLabel, $1.toLabel) }
    }

    static func encode(_ census: CensusDTO) -> JSONValue {
        .object([
            "computed": .string(census.computed),
            "nodeTotal": .int(census.nodeTotal), "edgeTotal": .int(census.edgeTotal),
            "computersEnabled": .int(census.computersEnabled),
            "computersWithSessions": .int(census.computersWithSessions),
            "domains": .array(census.domains.map { domain in .object([
                "id": .string(domain.id), "label": .string(domain.label),
                "objects": .int(domain.objects), "tierZero": .int(domain.tierZero),
            ]) }),
            "trusts": .array(census.trusts.map { trust in .object([
                "from": .string(trust.from), "fromLabel": .string(trust.fromLabel),
                "fromCollected": .bool(trust.fromCollected),
                "to": .string(trust.to), "toLabel": .string(trust.toLabel),
                "toCollected": .bool(trust.toCollected),
                "kind": .string(trust.kind), "bidirectional": .bool(trust.bidirectional),
            ]) }),
        ])
    }

    static func census(from source: JSONValue?) -> CensusDTO? {
        guard let doc = source?["census"], doc != .null, doc["computed"] != nil else { return nil }
        return CensusDTO(
            computed: doc["computed"]?.string ?? "",
            nodeTotal: doc["nodeTotal"]?.int ?? 0, edgeTotal: doc["edgeTotal"]?.int ?? 0,
            computersEnabled: doc["computersEnabled"]?.int ?? 0,
            computersWithSessions: doc["computersWithSessions"]?.int ?? 0,
            domains: (doc["domains"]?.array ?? []).compactMap { row in
                guard let id = row["id"]?.string else { return nil }
                return CensusDomainDTO(
                    id: id, label: row["label"]?.string ?? id,
                    objects: row["objects"]?.int ?? 0, tierZero: row["tierZero"]?.int ?? 0)
            },
            trusts: (doc["trusts"]?.array ?? []).compactMap { row in
                guard let from = row["from"]?.string, let to = row["to"]?.string else { return nil }
                return CensusTrustDTO(
                    from: from, fromLabel: row["fromLabel"]?.string ?? from,
                    fromCollected: row["fromCollected"]?.bool ?? false,
                    to: to, toLabel: row["toLabel"]?.string ?? to,
                    toCollected: row["toCollected"]?.bool ?? false,
                    kind: row["kind"]?.string ?? "",
                    bidirectional: row["bidirectional"]?.bool ?? false)
            })
    }
}

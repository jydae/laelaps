import Foundation
import Hummingbird

struct GraphNodeDTO: ResponseEncodable {
    let id: String; let label: String; let kind: String

    let tierZero: Bool; let tierZeroSeed: Bool

    let owned: Bool
}

struct GraphLinkDTO: ResponseEncodable {
    let source: Int
    let target: Int
    let kinds: [String]
}

struct GraphViewDTO: ResponseEncodable {
    let nodes: [GraphNodeDTO]
    let links: [GraphLinkDTO]
    let total: Int
    let truncated: Bool

    let counting: String

    var flow = false

    init(
        nodes: [GraphNodeDTO], links: [GraphLinkDTO],
        total: Int? = nil, counting: String = "objects", truncated: Bool? = nil
    ) {
        self.nodes = nodes
        self.links = links
        let shown = counting == "relationships" ? links.count : nodes.count
        let matched = total ?? shown
        self.total = matched
        self.truncated = truncated ?? (matched > shown)
        self.counting = counting
    }
}

struct ReachStepDTO: ResponseEncodable {
    let fromLabel: String
    let toId: String
    let toLabel: String

    let toKind: String

    let edge: String

    let technique: String

    let effort: String

    let fix: String

    let provenance: String

    let choke: Int

    let facts: [String]

    let difficulty: String

    let assumed: Bool
}

struct ReachPathDTO: ResponseEncodable {
    let startId: String
    let startLabel: String

    let startKind: String
    let targetId: String
    let targetLabel: String

    let targetReason: String

    let reached: String

    let targetOwned: Bool

    let walked: Int

    let startChoke: Int

    let standing: Bool

    let difficulty: String

    let difficultyAssumed: Bool

    let hardestStep: String
    let hardestWhy: [String]
    let steps: [ReachStepDTO]
}

struct ReachPathsDTO: ResponseEncodable {
    let paths: [ReachPathDTO]
    let truncated: Bool

    var population: Int = 0

    var domains: Int = 0
    var domainsHeld: Int = 0
}

struct ZoneDTO: ResponseEncodable {
    let id: String
    let tier: Int
    let name: String
    let count: Int
}

struct ZoneCrossingDTO: ResponseEncodable {

    let sort: String
    let sourceId: String
    let sourceLabel: String
    let sourceKind: String
    let sourceTier: Int
    let targetId: String
    let targetLabel: String
    let targetKind: String
    let targetTier: Int
    let edge: String
    let technique: String
    let effort: String
    let fix: String

    let inferred: Bool
}

struct ZoneReportDTO: ResponseEncodable {
    let zones: [ZoneDTO]
    let crossings: [ZoneCrossingDTO]

    let truncated: Bool
    let total: Int

    var inferred: [InferredDTO] = []
}

struct InferredDTO: ResponseEncodable {
    let id: String
    let label: String
    let reason: String
}

struct AroundDTO: ResponseEncodable {
    let kind: String

    let direction: String
    let count: Int

    let technique: String

    let traversable: Bool
}

struct EdgeDetailDTO: ResponseEncodable {
    let otherId: String

    let otherLabel: String
    let otherTierZeroSeed: Bool
    let otherKind: String
    let kind: String
    let direction: String

    let derived: Bool
}
struct NodeDetailDTO: ResponseEncodable {
    let id: String
    let kind: String
    let label: String

    let properties: [String: JSONValue]
    let edges: [EdgeDetailDTO]

    let edgeTotal: Int

    let edgesTruncated: Bool
    let tierZero: Bool
    let tierZeroReason: String?

    let tierZeroSeed: Bool
    let zoneAsserted: Bool

    let zoneTier: Int?
    let zoneTierReason: String?

    let zoneTierInferred: Bool

    let labelObserved: String?
    let owned: Bool
    let ownedReason: String?

    let notes: [String: JSONValue]
}

struct SearchResultDTO: ResponseEncodable {
    let kind: String?
    let ofKind: [GraphNodeDTO]
    let byName: [GraphNodeDTO]
}

struct StandingDTO: ResponseEncodable {

    let memberOfUnrolled: Int

    let controlsTransitive: Int

    let controlledByTransitive: Int

    let reachableTierZero: Int
    let truncated: Bool
}

struct CoverageDTO: ResponseEncodable {
    let id: String
    let title: String
    let present: Bool

    let have: Int
    let of: Int

    let costs: String
}

struct QueryInfoDTO: ResponseEncodable {
    let id: String; let title: String; let description: String

    let section: String

    let script: String

    let severity: String

    let remedy: String
}

struct FindingDTO: ResponseEncodable {
    let id: String
    let count: Int

    let counting: String
}

enum GraphRoutes {

    static let detailEdgeLimit = 200

    static let searchPage = 50

    static let crossingLimit = 500

    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient
    ) {

        router.get("api/graph/node/:id/neighbors") { request, context -> GraphViewDTO in
            let id = decodedPathID(try context.parameters.require("id", as: String.self))
            let db = try await Self.db(request, elastic)

            let wanted = (request.uri.queryParameters["kind"].map { String($0) } ?? "")
                .split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            let direction = request.uri.queryParameters["direction"].map { String($0) } ?? ""

            let touching: JSONValue
            if wanted.isEmpty {

                let outbound: JSONValue = ["term": ["source": .string(id)]]
                let inboundSession: JSONValue = ["bool": ["must": [
                    .object(["term": .object(["target": .string(id)])]),
                    .object(["term": .object(["kind": .string(ADEdgeKind.hasSession.rawValue)])]),
                ]]]
                touching = ["bool": [
                    "should": [outbound, inboundSession],
                    "minimum_should_match": 1,
                ]]
            } else {
                let field = direction == "in" ? "target" : "source"
                var must: [JSONValue] = [["terms": ["kind": .strings(wanted)]]]

                if direction == "in" || direction == "out" {
                    must.append(["term": [field: .string(id)]])
                } else {
                    must.append(["bool": [
                        "should": [.object(["term": .object(["source": .string(id)])]),
                                   .object(["term": .object(["target": .string(id)])])],
                        "minimum_should_match": 1,
                    ]])
                }
                touching = ["bool": ["must": .array(must)]]
            }

            let query = GraphStore.edgeScope([touching], db: db)
            let edgeTotal = try await elastic.count(index: Indices.edges, query)
            let edges = GraphStore.edges(in: try await elastic.search(index: Indices.edges, [
                "size": 500,
                "_source": .strings(GraphStore.Edge.fields),
                "query": query,
            ]))

            var ids: Set<String> = [id]
            for edge in edges { ids.insert(edge.source); ids.insert(edge.target) }

            let nodes = GraphStore.rows(try await elastic.fetchByIDs(
                index: Indices.nodes, ids: Array(ids), db: db))

            return GraphViewDTO(
                nodes: nodes.map(\.dto), links: GraphStore.links(edges, among: nodes),
                total: edgeTotal, counting: "relationships",
                truncated: edgeTotal > edges.count)
        }

        router.get("api/graph/node/:id") { request, context -> NodeDetailDTO in
            let id = decodedPathID(try context.parameters.require("id", as: String.self))
            let db = try await Self.db(request, elastic)

            let hits = try await elastic.search(index: Indices.nodes, [
                "size": 1, "query": GraphStore.scoped([["term": ["id": .string(id)]]], db: db),
            ])
            guard let doc = (hits["hits"]?["hits"]?.array ?? []).first?["_source"] else {
                throw HTTPError(.notFound)
            }

            let outQuery = GraphStore.edgeScope([["term": ["source": .string(id)]]], db: db)
            let inQuery = GraphStore.edgeScope([["term": ["target": .string(id)]]], db: db)
            let outTotal = try await elastic.count(index: Indices.edges, outQuery)
            let inTotal = try await elastic.count(index: Indices.edges, inQuery)
            let edgeTotal = outTotal + inTotal

            let edgeFields: JSONValue = .strings(GraphStore.Edge.fields)
            let outHits = try await elastic.search(index: Indices.edges, [
                "size": .int(detailEdgeLimit), "_source": edgeFields, "query": outQuery,
            ])
            let inHits = try await elastic.search(index: Indices.edges, [
                "size": .int(detailEdgeLimit), "_source": edgeFields, "query": inQuery,
            ])

            let edges = Self.edgeDetails(outHits, direction: "out", excluding: id)
                      + Self.edgeDetails(inHits, direction: "in", excluding: id)

            let collected = doc["label"]?.string ?? id
            let asserted = doc["labelAsserted"]?.string
            return NodeDetailDTO(
                id: id,
                kind: doc["kind"]?.string ?? "",
                label: asserted ?? collected,
                properties: doc["props"]?.object ?? [:],
                edges: try await Self.named(edges, elastic, db: db),
                edgeTotal: edgeTotal,
                edgesTruncated: outTotal > detailEdgeLimit || inTotal > detailEdgeLimit,
                tierZero: doc["tierZero"]?.bool ?? false,
                tierZeroReason: doc["tierZeroReason"]?.string,
                tierZeroSeed: doc["tierZeroSeed"]?.bool ?? false,
                zoneAsserted: doc["zoneAsserted"]?.bool ?? false,
                zoneTier: doc["zoneTier"]?.int,
                zoneTierReason: doc["zoneTierReason"]?.string,
                zoneTierInferred: doc["zoneTierInferred"]?.bool ?? false,
                labelObserved: asserted == nil ? nil : collected,
                owned: doc["owned"]?.bool ?? false,
                ownedReason: doc["ownedReason"]?.string,
                notes: Assertions.notesMap(doc["notes"])
            )
        }

        router.get("api/graph/node/:id/around") { request, context -> [AroundDTO] in
            let id = decodedPathID(try context.parameters.require("id", as: String.self))
            let db = try await Self.db(request, elastic)
            let walkable = Set(GraphTraversal.escalationEdges)
            var out: [AroundDTO] = []
            for (direction, field) in [("out", "source"), ("in", "target")] {
                let response = try await elastic.search(index: Indices.edges, [
                    "size": 0,
                    "query": GraphStore.edgeScope([["term": [field: .string(id)]]], db: db),
                    "aggs": ["kinds": ["terms": ["field": "kind", "size": 100]]],
                ])
                for bucket in response["aggregations"]?["kinds"]?["buckets"]?.array ?? [] {
                    guard let kind = bucket["key"]?.string else { continue }
                    out.append(AroundDTO(
                        kind: kind, direction: direction,
                        count: bucket["doc_count"]?.int ?? 0,
                        technique: ReachTechniques.for(edge: kind),
                        traversable: walkable.contains(kind)))
                }
            }

            return out.sorted {
                ($1.count, $0.direction, $0.kind) < ($0.count, $1.direction, $1.kind)
            }
        }

        router.get("api/graph/node/:id/standing") { request, context -> StandingDTO in
            let id = decodedPathID(try context.parameters.require("id", as: String.self))
            let db = try await Self.db(request, elastic)
            let membership = try await Self.outward(
                elastic, db: db, from: id, kinds: [ADEdgeKind.memberOf.rawValue], maxHops: GraphScript.maxHops)
            let control = try await Self.outward(
                elastic, db: db, from: id, kinds: GraphTraversal.escalationEdges, maxHops: 4)
            let into = try await GraphTraversal.reachableInto(
                elastic, db: db, into: [id], kinds: GraphTraversal.escalationEdges, maxHops: 4)
            let seeds = try await GraphStore.nodeIDs(
                elastic, GraphStore.scoped([["term": ["tierZeroSeed": .bool(true)]]], db: db))
            let walk = try await GraphTraversal.reach(
                elastic, db: db, from: id, to: seeds.subtracting([id]), maxHops: 6)
            return StandingDTO(
                memberOfUnrolled: membership.count,
                controlsTransitive: control.count,
                controlledByTransitive: max(0, into.nodes.count - 1),
                reachableTierZero: walk.reached.count,
                truncated: membership.truncated || control.truncated || into.truncated)
        }

        router.get("api/graph/search") { request, _ -> SearchResultDTO in
            guard let raw = request.uri.queryParameters["q"].map({ String($0) }) else {
                return SearchResultDTO(kind: nil, ofKind: [], byName: [])
            }
            let term = raw.trimmingCharacters(in: .whitespaces)
            let db = try await Self.db(request, elastic)

            let from = max(0, min(
                request.uri.queryParameters["from"].flatMap { Int($0) } ?? 0,
                10_000 - searchPage))

            var kind: ADNodeKind?
            var rest: [String] = []
            for word in term.split(separator: " ").map(String.init) {
                if kind == nil, let match = ADNodeKind.matching(word) { kind = match; continue }
                rest.append(word)
            }
            let remainder = rest.joined(separator: " ")

            var ofKind: [GraphNodeDTO] = []
            if let kind {
                var must: [JSONValue] = [["term": ["kind": .string(kind.rawValue)]]]
                if !remainder.isEmpty { must.append(GraphStore.nameMatch(remainder)) }
                let hits = try await elastic.search(index: Indices.nodes, [
                    "size": .int(searchPage), "from": .int(from),

                    "sort": GraphStore.typeAheadSort(relevant: !remainder.isEmpty),
                    "query": GraphStore.scoped(must, db: db),
                ])
                ofKind = GraphStore.nodes(from: hits).map(\.dto)
            }

            var byName: [GraphNodeDTO] = []
            if term.count >= 2 {
                let hits = try await elastic.search(index: Indices.nodes, [
                    "size": .int(searchPage), "from": .int(from),
                    "sort": GraphStore.typeAheadSort(relevant: true),
                    "query": GraphStore.scoped([GraphStore.nameMatch(term)], db: db),
                ])
                let seen = Set(ofKind.map(\.id))
                byName = GraphStore.nodes(from: hits).map(\.dto).filter { !seen.contains($0.id) }
            }

            return SearchResultDTO(kind: kind?.rawValue, ofKind: ofKind, byName: byName)
        }

        router.get("api/graph/queries") { _, _ -> [QueryInfoDTO] in
            GraphQueryCatalog.all.map {
                QueryInfoDTO(id: $0.id, title: $0.title, description: $0.description,
                             section: $0.section, script: $0.script,
                             severity: $0.severity.rawValue, remedy: $0.remedy)
            }
        }

        router.get("api/graph/findings") { request, _ -> [FindingDTO] in
            let db = try await Self.db(request, elastic)
            return try await withThrowingTaskGroup(of: FindingDTO?.self) { group in
                for row in GraphQueryCatalog.all {
                    group.addTask {
                        guard let answer = try? await Self.answer(row, elastic, db: db) else { return nil }
                        return FindingDTO(id: row.id, count: answer.count, counting: answer.counting)
                    }
                }
                var found: [FindingDTO] = []
                for try await row in group { if let row { found.append(row) } }

                let place = Dictionary(uniqueKeysWithValues: GraphQueryCatalog.all.enumerated().map { ($1.id, $0) })
                return found.sorted { (place[$0.id] ?? 0) < (place[$1.id] ?? 0) }
            }
        }

        router.get("api/graph/routes") { request, _ -> ReachPathsDTO in
            try await ReachPaths.routes(elastic, db: try await Self.db(request, elastic))
        }

        router.get("api/graph/coverage") { request, _ -> [CoverageDTO] in
            let db = try await Self.db(request, elastic)
            let collected: JSONValue = ["bool": ["must_not": ["term": ["derived": .bool(true)]]]]
            let computers = try await elastic.count(index: Indices.nodes, GraphStore.scoped(
                [["term": ["kind": .string(ADNodeKind.computer.rawValue)]]], db: db))
            func hosts(_ kinds: [String]) async throws -> Int {
                try await elastic.distinct(index: Indices.edges, field: "source", GraphStore.edgeScope(
                    [["terms": ["kind": .strings(kinds)]], collected], db: db))
            }
            func objects(_ kinds: [ADNodeKind]) async throws -> Int {
                try await elastic.count(index: Indices.nodes, GraphStore.scoped(
                    [["terms": ["kind": .strings(kinds.map(\.rawValue))]]], db: db))
            }
            let sessions = try await hosts([ADEdgeKind.hasSession.rawValue])
            let local = try await elastic.distinct(
                index: Indices.edges, field: "target", GraphStore.edgeScope([
                    ["terms": ["kind": .strings([ADEdgeKind.adminTo, .canRDP, .canPSRemote, .executeDCOM]
                        .map(\.rawValue))]], collected,
                ], db: db))
            let pki = try await objects([.enterpriseCA, .rootCA, .certTemplate])
            let acls = try await elastic.count(index: Indices.edges, GraphStore.edgeScope(
                [["terms": ["kind": .strings(Array(BloodHoundImport.collectedRights))]], collected], db: db))
            return [
                CoverageDTO(
                    id: "sessions", title: "Logged-on sessions", present: sessions > 0,
                    have: sessions, of: computers,
                    costs: sessions > 0 ? "" : "No host reported a session, so every route that runs "
                        + "through resident credentials is invisible here."),
                CoverageDTO(
                    id: "local-groups", title: "Local group membership", present: local > 0,
                    have: local, of: computers,
                    costs: local > 0 ? "" : "No host reported its local groups, so every route through "
                        + "local administrator, Remote Desktop, remoting or DCOM rights is invisible here."),
                CoverageDTO(
                    id: "certificate-services", title: "Certificate services", present: pki > 0,
                    have: pki, of: pki,
                    costs: pki > 0 ? "" : "No certification authority or template was uploaded, so no "
                        + "certificate escalation was assessed."),
                CoverageDTO(
                    id: "permissions", title: "Object permissions", present: acls > 0,
                    have: acls, of: acls,
                    costs: acls > 0 ? "" : "No access-control entry was read, so no permission-based "
                        + "route was assessed."),
                CoverageDTO(
                    id: "policy-contents", title: "Policy contents", present: false, have: 0, of: 0,
                    costs: "Group policy files are not read by this build, so a password or a scheduled "
                        + "task inside a policy is not assessed."),
            ]
        }

        router.get("api/graph/zones") { request, _ -> ZoneReportDTO in
            let db = try await Self.db(request, elastic)
            let tiers = try await Zones.tiers(elastic, database: db)
            var counts: [Int: Int] = [:]
            for tier in tiers.values { counts[tier, default: 0] += 1 }

            let population = try await elastic.count(index: Indices.nodes, GraphStore.scoped([], db: db))
            counts[Zones.defaultTier, default: 0] += max(0, population - tiers.count)

            let crossings = try await Zones.crossings(elastic, database: db, tier: tiers)
            let shown = Array(crossings.prefix(crossingLimit))
            var ids: Set<String> = []
            for crossing in shown { ids.insert(crossing.sourceId); ids.insert(crossing.targetId) }
            var label: [String: String] = [:]
            var kind: [String: String] = [:]
            var inferred: Set<String> = []
            var inferredRows: [InferredDTO] = []
            if !ids.isEmpty {
                let hits = try await elastic.fetchByIDs(
                    index: Indices.nodes, ids: Array(ids),
                    source: ["id", "label", "labelAsserted", "kind", "zoneTierInferred", "zoneTierReason"], db: db)
                for hit in hits {
                    guard let source = hit["_source"], let id = source["id"]?.string else { continue }
                    label[id] = GraphStore.label(source, id: id)
                    kind[id] = source["kind"]?.string ?? ""
                    if source["zoneTierInferred"]?.bool == true {
                        inferred.insert(id)
                        inferredRows.append(InferredDTO(
                            id: id,
                            label: GraphStore.label(source, id: id),
                            reason: source["zoneTierReason"]?.string ?? "Classified from the name"))
                    }
                }
            }
            return ZoneReportDTO(
                zones: Zones.all.map {
                    ZoneDTO(id: $0.id, tier: $0.tier, name: $0.name, count: counts[$0.tier] ?? 0)
                },
                crossings: shown.map { crossing in
                    let remedy = ReachTechniques.remedy(edge: crossing.edge)
                    return ZoneCrossingDTO(
                        sort: crossing.sort,
                        sourceId: crossing.sourceId,
                        sourceLabel: label[crossing.sourceId] ?? crossing.sourceId,
                        sourceKind: kind[crossing.sourceId] ?? "",
                        sourceTier: crossing.sourceTier,
                        targetId: crossing.targetId,
                        targetLabel: label[crossing.targetId] ?? crossing.targetId,
                        targetKind: kind[crossing.targetId] ?? "",
                        targetTier: crossing.targetTier,
                        edge: crossing.edge,
                        technique: ReachTechniques.for(edge: crossing.edge),
                        effort: remedy.effort, fix: remedy.fix,
                        inferred: inferred.contains(crossing.sourceId)
                            || inferred.contains(crossing.targetId))
                },
                truncated: crossings.count > shown.count,
                total: crossings.count,
                inferred: inferredRows.sorted { $0.label < $1.label })
        }

        router.get("api/graph/delegations") { request, _ -> DelegationReportDTO in
            try await Delegation.report(elastic, db: try await Self.db(request, elastic))
        }

        router.get("api/graph/query/:id") { request, context -> GraphViewDTO in
            let id = try context.parameters.require("id", as: String.self)
            guard let query = GraphQueryCatalog.all.first(where: { $0.id == id }) else {
                throw HTTPError(.notFound)
            }

            return try await Self.answer(query, elastic, db: try await Self.db(request, elastic)).view
        }
    }

    static func onlyConnected(_ view: GraphViewDTO) -> GraphViewDTO {
        var touched: Set<Int> = []
        for link in view.links { touched.insert(link.source); touched.insert(link.target) }
        guard touched.count < view.nodes.count else { return view }
        let kept = view.nodes.indices.filter { touched.contains($0) }

        var moved: [Int: Int] = [:]
        for (to, from) in kept.enumerated() { moved[from] = to }
        return GraphViewDTO(
            nodes: kept.map { view.nodes[$0] },
            links: view.links.compactMap { link in
                guard let source = moved[link.source], let target = moved[link.target] else { return nil }
                return GraphLinkDTO(source: source, target: target, kinds: link.kinds)
            })
    }

    struct CatalogAnswer {
        let view: GraphViewDTO
        let count: Int
        let counting: String
    }

    static func answer(
        _ row: GraphQueryInfo, _ elastic: ElasticClient, db: String
    ) async throws -> CatalogAnswer {
        let expression = try GraphScript.parse(row.script)
        switch row.counts {
        case .objects:

            let view = try await GraphScript.run(expression, elastic, db: db)
            return CatalogAnswer(view: view, count: view.nodes.count, counting: "objects")

        case .ofKind(let kind):
            let view = try await GraphScript.run(expression, elastic, db: db)
            return CatalogAnswer(
                view: view, count: view.nodes.filter { $0.kind == kind.rawValue }.count, counting: "objects")

        case .edges(let kinds):

            let edges = try await GraphStore.edges(elastic, GraphStore.edgeScope(
                [["terms": ["kind": .strings(kinds)]]], db: db))
            var ids: [String] = []
            var seen: Set<String> = []
            for edge in edges {
                for id in [edge.source, edge.target] where seen.insert(id).inserted { ids.append(id) }
            }
            let view = try await GraphTraversal.assemble(elastic, db: db, ids: ids, edges: edges)

            return CatalogAnswer(view: view, count: edges.count, counting: "relationships")

        case .answer, .reaching:

            let view = Self.onlyConnected(try await GraphScript.run(expression, elastic, db: db))
            var selection: Set<String> = []
            if case .one(let plan) = expression, plan.verb == .reach {
                let into = try await GraphScript.evaluate(
                    .one(GraphScript.Plan(verb: .find, from: plan.from, to: [], kinds: nil,
                                          hops: plan.hops, show: .objects)), elastic, db: db)
                selection = Set(into.nodes.map(\.id))
            }
            return CatalogAnswer(
                view: view, count: view.nodes.filter { !selection.contains($0.id) }.count, counting: "objects")
        }
    }

    static func db(_ request: Request, _ elastic: ElasticClient, _ given: String? = nil) async throws -> String {
        let param = request.uri.queryParameters["db"].map { String($0) }.flatMap { $0.isEmpty ? nil : $0 }
        guard let db = given ?? param else { throw HTTPError(.badRequest, message: "A database is required.") }
        try await DatabaseStore.owned(elastic, dbId: db, project: try await Sessions.require(request).project)
        return db
    }

    static func decodedPathID(_ raw: String) -> String {
        raw.removingPercentEncoding ?? raw
    }

    private static let standingCeiling = 5_000
    private static func outward(
        _ elastic: ElasticClient, db: String?, from id: String, kinds: [String], maxHops: Int
    ) async throws -> (count: Int, truncated: Bool) {
        var seen: Set<String> = [id]
        var frontier = [id]
        for _ in 0..<maxHops {
            let hopped = try await GraphTraversal.hop(
                elastic, db: db, frontier: frontier, outbound: true, kinds: kinds)
            let arrived = hopped.map(\.target).filter { seen.insert($0).inserted }
            if arrived.isEmpty { break }
            if seen.count > standingCeiling { return (seen.count - 1, true) }
            frontier = arrived
        }
        return (seen.count - 1, false)
    }

    private static func named(
        _ edges: [EdgeDetailDTO], _ elastic: ElasticClient, db: String?
    ) async throws -> [EdgeDetailDTO] {
        let ids = Set(edges.map(\.otherId))
        guard !ids.isEmpty else { return edges }

        let hits = try await elastic.fetchByIDs(
            index: Indices.nodes, ids: Array(ids),
            source: ["id", "label", "labelAsserted", "tierZeroSeed", "kind"], db: db)
        var labels: [String: String] = [:]
        var kinds: [String: String] = [:]
        var seeds: Set<String> = []
        for hit in hits {
            guard let source = hit["_source"], let key = source["id"]?.string else { continue }
            kinds[key] = source["kind"]?.string ?? ""

            labels[key] = GraphStore.label(source, id: key)
            if source["tierZeroSeed"]?.bool == true { seeds.insert(key) }
        }
        return edges.map {
            EdgeDetailDTO(otherId: $0.otherId, otherLabel: labels[$0.otherId] ?? $0.otherId,
                          otherTierZeroSeed: seeds.contains($0.otherId),
                          otherKind: kinds[$0.otherId] ?? "",
                          kind: $0.kind, direction: $0.direction, derived: $0.derived)
        }
    }

    private static func edgeDetails(
        _ response: JSONValue, direction: String, excluding id: String
    ) -> [EdgeDetailDTO] {
        GraphStore.edges(in: response).compactMap { edge in
            let other = direction == "out" ? edge.target : edge.source
            guard other != id, !edge.kind.isEmpty else { return nil }
            return EdgeDetailDTO(otherId: other, otherLabel: other, otherTierZeroSeed: false,
                                 otherKind: "", kind: edge.kind, direction: direction,
                                 derived: edge.derived)
        }
    }
}

extension ElasticClient {

    func scan<Row>(
        index: String, query: JSONValue, source: [String], sort: [String],
        row: (JSONValue) -> Row?
    ) async throws -> [Row] {
        var out: [Row] = []
        var cursor: JSONValue?
        repeat {
            let read = try await page(index: index, query: query, source: source,
                                      sort: sort, after: cursor)
            out.append(contentsOf: read.hits.compactMap(row))
            cursor = read.cursor
        } while cursor != nil
        return out
    }

    func scan(
        index: String, query: JSONValue, source: [String], sort: [String]
    ) async throws -> [JSONValue] {
        try await scan(index: index, query: query, source: source, sort: sort, row: { $0 })
    }
}

enum GraphStore {

    static let nodeOrder = ["id"]
    static let edgeOrder = ["source", "kind", "target"]

    static func scoped(_ must: [JSONValue], db: String?) -> JSONValue {
        var clauses = must
        if let db { clauses.append(["term": ["db": .string(db)]]) }
        if clauses.isEmpty { return ["match_all": [:]] }
        return ["bool": ["must": .array(clauses)]]
    }

    static func label(_ source: JSONValue, id: String) -> String {
        source["labelAsserted"]?.string ?? source["label"]?.string ?? id
    }

    static func edgeID(db: String, source: String, kind: String, target: String) -> String {
        "\(db)|\(source)|\(kind)|\(target)"
    }

    static func edgeScope(_ must: [JSONValue], db: String?) -> JSONValue {
        var clauses = must
        if let db { clauses.append(["term": ["db": .string(db)]]) }
        return ["bool": [
            "must": clauses.isEmpty ? [.object(["match_all": .object([:])])] : .array(clauses),
            "must_not": [["term": ["refuted": .bool(true)]]],
        ]]
    }

    static func nameMatch(_ term: String) -> JSONValue {
        let prefix: JSONValue = ["query": .string(term), "max_expansions": 10_000]
        return ["bool": [
            "should": [
                .object(["match_phrase_prefix": .object(["label": prefix])]),
                .object(["match_phrase_prefix": .object(["labelAsserted": prefix])]),
            ],
            "minimum_should_match": 1,
        ]]
    }

    static func typeAheadSort(relevant: Bool) -> JSONValue {
        let primary: JSONValue = relevant
            ? ["_score": ["order": "desc"]]
            : ["label.keyword": ["order": "asc"]]
        return [primary, .object(["id": .object(["order": .string("asc")])])]
    }

    static func nodeIDs(_ elastic: ElasticClient, _ query: JSONValue) async throws -> Set<String> {
        Set(try await elastic.scan(index: Indices.nodes, query: query, source: ["id"], sort: nodeOrder,
                                   row: { $0["_source"]?["id"]?.string }))
    }

    static func edgeIDs(_ elastic: ElasticClient, _ query: JSONValue) async throws -> Set<String> {
        Set(try await elastic.scan(index: Indices.edges, query: query, source: ["kind"], sort: edgeOrder,
                                   row: { $0["_id"]?.string }))
    }

    static func edges(_ elastic: ElasticClient, _ query: JSONValue) async throws -> [Edge] {
        try await elastic.scan(index: Indices.edges, query: query, source: Edge.fields, sort: edgeOrder,
                               row: { Edge($0) })
    }

    static func collectedEdgeIDs(
        _ elastic: ElasticClient, ids: [String], db: String
    ) async throws -> Set<String> {
        var out: Set<String> = []
        for chunk in ids.chunked(1_000) {
            out.formUnion(try await edgeIDs(elastic, scoped([
                ["ids": ["values": .strings(chunk)]],
                ["bool": ["must_not": [
                    .object(["term": .object(["derived": .bool(true)])]),
                    .object(["term": .object(["origin": .string("asserted")])]),
                ]]],
            ], db: db)))
        }
        return out
    }

    static func edges(in response: JSONValue) -> [Edge] {
        (response["hits"]?["hits"]?.array ?? []).compactMap(Edge.init)
    }

    struct Edge: Sendable {
        let source: String, target: String, kind: String

        let enforced: Bool, blocked: Bool

        let through: String?
        let passwordAgeDays: Int?
        let aesOnly: Bool?

        let targetDisabled: Bool?
        let needsApproval: Bool?
        let quotaZero: Bool?
        let sessionAgeDays: Int?

        let note: String?

        let inherited: Bool?

        let derived: Bool

        let origin: String?
        let refuted: Bool

        static let fields = [
            "source", "target", "kind", "enforced", "blocked",
            "through", "passwordAgeDays", "aesOnly",
            "targetDisabled", "needsApproval", "quotaZero", "sessionAgeDays", "note",
            "inherited",
            "derived", "origin", "refuted",
        ]

        init?(_ hit: JSONValue) {
            guard let doc = hit["_source"], let from = doc["source"]?.string,
                  let to = doc["target"]?.string else { return nil }
            source = from
            target = to
            kind = doc["kind"]?.string ?? ""
            enforced = doc["enforced"]?.bool == true
            blocked = doc["blocked"]?.bool == true
            through = doc["through"]?.string
            passwordAgeDays = doc["passwordAgeDays"]?.int
            aesOnly = doc["aesOnly"]?.bool
            targetDisabled = doc["targetDisabled"]?.bool
            needsApproval = doc["needsApproval"]?.bool
            quotaZero = doc["quotaZero"]?.bool
            sessionAgeDays = doc["sessionAgeDays"]?.int
            note = doc["note"]?.string
            inherited = doc["inherited"]?.bool
            derived = doc["derived"]?.bool == true
            origin = doc["origin"]?.string
            refuted = doc["refuted"]?.bool == true
        }
    }

    struct NodeRow: Sendable {
        let id: String, label: String, kind: String
        let tierZero: Bool, tierZeroSeed: Bool
        let owned: Bool

        static let fields = ["id", "label", "labelAsserted", "kind", "tierZero", "tierZeroSeed", "owned"]

        init?(_ hit: JSONValue) {
            guard let source = hit["_source"], let id = source["id"]?.string else { return nil }
            self.id = id

            label = GraphStore.label(source, id: id)
            kind = source["kind"]?.string ?? ""
            tierZero = source["tierZero"]?.bool ?? false
            tierZeroSeed = source["tierZeroSeed"]?.bool ?? false
            owned = source["owned"]?.bool ?? false
        }

        var dto: GraphNodeDTO {
            .init(id: id, label: label, kind: kind,
                  tierZero: tierZero, tierZeroSeed: tierZeroSeed, owned: owned)
        }
    }

    static func nodes(from response: JSONValue) -> [NodeRow] {
        rows(response["hits"]?["hits"]?.array ?? [])
    }

    static func rows(_ hits: [JSONValue]) -> [NodeRow] {
        unique(hits.compactMap { NodeRow($0) })
    }

    static func unique(_ rows: [NodeRow]) -> [NodeRow] {
        var seen: Set<String> = []
        return rows.filter { seen.insert($0.id).inserted }
    }

    static func links(_ edges: [Edge], among nodes: [NodeRow]) -> [GraphLinkDTO] {
        let position = Dictionary(nodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        var order: [(Int, Int)] = []
        var kinds: [String: [String]] = [:]

        for edge in edges {
            guard let i = position[edge.source], let j = position[edge.target], i != j else { continue }
            let key = "\(i)-\(j)"
            if kinds[key] == nil {
                order.append((i, j))
                kinds[key] = []
            }
            if !edge.kind.isEmpty, !kinds[key]!.contains(edge.kind) { kinds[key]!.append(edge.kind) }
        }
        return order.map { i, j in
            GraphLinkDTO(source: i, target: j, kinds: kinds["\(i)-\(j)"] ?? [])
        }
    }
}

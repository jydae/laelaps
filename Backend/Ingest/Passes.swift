import Foundation
import Logging

actor DatabaseGate {
    private var tails: [String: Task<Void, Never>] = [:]

    func run<T: Sendable>(
        _ database: String, _ body: @Sendable @escaping () async throws -> T
    ) async throws -> T {
        let previous = tails[database]
        let task = Task<T, Error> {
            _ = await previous?.value
            return try await body()
        }
        tails[database] = Task { _ = try? await task.value }
        return try await task.value
    }
}

enum Passes {
    static let gate = DatabaseGate()

    struct Outcome: Sendable {
        let baseStubs: Int
        let derivedEdges: Int
        let tierZero: Int

        let tierZeroSettled: Bool

        let assertions: Assertions.Outcome
    }

    static func complete(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Outcome {
        let projected = try await Assertions.project(elastic, database: database, logger: logger)
        try await roastable(elastic, database: database, logger: logger)
        try await wellKnownMembership(elastic, database: database, logger: logger)
        try await certificateChain(elastic, database: database, logger: logger)
        try await issuancePolicyLinks(elastic, database: database, logger: logger)

        try await adcsEscalations(elastic, database: database, logger: logger)
        try await dcSync(elastic, database: database, logger: logger)
        try await ticketPrimitives(elastic, database: database, logger: logger)
        try await trustAbuse(elastic, database: database, logger: logger)

        try await builtinRights(elastic, database: database, logger: logger)

        try await directoryFacts(elastic, database: database, logger: logger)
        try await modernPaths(elastic, database: database, logger: logger)

        try await weighFacts(elastic, database: database, logger: logger)
        try await baseNodes(elastic, database: database, logger: logger)
        let stubs = try await elastic.count(index: Indices.nodes, GraphStore.scoped(
            [["term": ["kind": .string(ADNodeKind.base.rawValue)]]], db: database))

        let derived = try await elastic.count(index: Indices.edges, GraphStore.scoped(
            [["term": ["derived": .bool(true)]]], db: database))
        let tierZero = try await TierZero.analyze(elastic, database: database, logger: logger)

        try await Zones.analyze(elastic, database: database, logger: logger)
        return Outcome(baseStubs: stubs, derivedEdges: derived, tierZero: tierZero.tagged,
                       tierZeroSettled: tierZero.settled, assertions: projected)
    }

    @discardableResult
    static func baseNodes(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {

        let scope = GraphStore.scoped([], db: database)
        let known = try await GraphStore.nodeIDs(elastic, scope)
        var unresolved: Set<String> = []
        for edge in try await GraphStore.edges(elastic, scope) {
            for end in [edge.source, edge.target] where !end.isEmpty && !known.contains(end) {
                unresolved.insert(end)
            }
        }

        guard !unresolved.isEmpty else { return 0 }
        let ops = unresolved.map { id in
            ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: [
                "id": .string(id), "db": .string(database),
                "kind": .string(ADNodeKind.base.rawValue),
                "label": .string(id), "props": .object([:]),

                "tierZero": .bool(false), "tierZeroSeed": .bool(false),
            ])
        }
        let created = try await elastic.bulk(ops).created
        try await elastic.refresh(Indices.nodes)
        logger?.info("Passes: [\(database)] \(created) Base stubs")
        return created
    }

    @discardableResult
    static func wellKnownMembership(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.memberOf],
            ops: try await wellKnownLinks(elastic, database: database), logger: logger)
    }

    private static func wellKnownLinks(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        let domains: [(sid: String, name: String)] = try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.domain.rawValue)]]],
                                     db: database),
            source: ["id", "props.name"], sort: GraphStore.nodeOrder
        ).compactMap { hit -> (sid: String, name: String)? in
            guard let source = hit["_source"], let sid = source["id"]?.string else { return nil }
            return (sid: sid, name: source["props"]?["name"]?.string ?? "")
        }
        guard !domains.isEmpty else { return [] }

        func prefixes(_ domain: (sid: String, name: String)) -> [String] {
            domain.name.isEmpty ? [""] : ["", domain.name + "-"]
        }
        let identities = Set(domains.flatMap { domain in
            prefixes(domain).flatMap { [$0 + WellKnown.authenticatedUsers, $0 + WellKnown.everyone] }
        })

        var referenced: Set<String> = []
        for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([["bool": [
            "should": [["terms": ["source": .strings(Array(identities))]],
                       ["terms": ["target": .strings(Array(identities))]]],
            "minimum_should_match": .int(1),
        ]]], db: database)) where !(edge.kind == ADEdgeKind.memberOf.rawValue && edge.derived) {
            referenced.formUnion(identities.intersection([edge.source, edge.target]))
        }

        var ops: [ElasticClient.BulkOp] = []
        for domain in domains {
            for prefix in prefixes(domain) {
                let authenticated = prefix + WellKnown.authenticatedUsers
                let everyone = prefix + WellKnown.everyone
                guard referenced.contains(authenticated) || referenced.contains(everyone) else { continue }
                for rid in [WellKnown.domainUsers, WellKnown.domainComputers] {
                    ops += edge("\(domain.sid)-\(rid)", .memberOf, authenticated, database)
                }
                ops += edge(authenticated, .memberOf, everyone, database)
            }
        }
        return ops
    }

    private static let signerPreference: [ADNodeKind] = [.rootCA, .aiaCA, .enterpriseCA]

    @discardableResult
    static func certificateChain(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.trustedForNTAuth, .issuedSignedBy],
            ops: try await certificateLinks(elastic, database: database), logger: logger)
    }

    private static func certificateLinks(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        struct Authority { let id, kind, thumbprint: String; let chain: [String] }

        let query = GraphStore.scoped([["terms": ["kind": .strings(
            [ADNodeKind.enterpriseCA, .rootCA, .aiaCA, .ntAuthStore].map(\.rawValue))]]],
            db: database)

        var authorities: [Authority] = []
        var stores: [(id: String, thumbprints: [String])] = []
        for hit in try await elastic.scan(
            index: Indices.nodes, query: query,
            source: ["id", "kind", "props.certthumbprint", "props.certchain", "props.certthumbprints"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  let kind = source["kind"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            if kind == ADNodeKind.ntAuthStore.rawValue {
                stores.append((id, strings(props["certthumbprints"]).map(normalise)))
            } else if let thumb = props["certthumbprint"]?.string, !thumb.isEmpty {
                authorities.append(Authority(id: id, kind: kind, thumbprint: normalise(thumb),
                                             chain: strings(props["certchain"]).map(normalise)))
            }
        }
        guard !authorities.isEmpty else { return [] }

        var byThumbprint: [String: [Authority]] = [:]
        for authority in authorities { byThumbprint[authority.thumbprint, default: []].append(authority) }
        for (thumb, holders) in byThumbprint {
            byThumbprint[thumb] = holders.sorted { rank($0.kind) < rank($1.kind) }
        }

        var ops: [ElasticClient.BulkOp] = []

        for store in stores {
            for thumb in store.thumbprints {
                for holder in byThumbprint[thumb] ?? []
                where holder.kind == ADNodeKind.enterpriseCA.rawValue {
                    ops += edge(holder.id, .trustedForNTAuth, store.id, database)
                }
            }
        }

        for authority in authorities {
            guard let signerThumb = authority.chain.count > 1
                ? authority.chain[1] : authority.chain.first else { continue }
            guard let signer = (byThumbprint[signerThumb] ?? []).first,
                  signer.id != authority.id else { continue }
            ops += edge(authority.id, .issuedSignedBy, signer.id, database)
        }
        return ops
    }

    @discardableResult
    static func reconcileDerived(
        _ elastic: ElasticClient, database: String, kinds: [ADEdgeKind],
        ops: [ElasticClient.BulkOp], logger: Logger? = nil
    ) async throws -> Int {

        let previous = try await GraphStore.edgeIDs(elastic, GraphStore.scoped([
            ["terms": ["kind": .strings(kinds.map(\.rawValue))]],
            ["term": ["derived": .bool(true)]],
            ["bool": ["must_not": ["term": ["origin": .string("asserted")]]]],
        ], db: database))

        let unique = Array(
            Dictionary(ops.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values)

        let collected = try await GraphStore.collectedEdgeIDs(
            elastic, ids: unique.map(\.id), db: database)
        let writes = unique.filter { !collected.contains($0.id) }
        try await elastic.bulkUpdate(writes, upsert: true)
        let stale = previous.subtracting(writes.map(\.id))
        for batch in Array(stale).chunked(1_000) {
            try await elastic.deleteByQuery(index: Indices.edges, ["terms": ["_id": .strings(batch)]])
        }
        try await elastic.refresh(Indices.edges)

        let composed = kinds.map(\.rawValue).joined(separator: ", ")
        logger?.info(
            "Passes: [\(database)] \(writes.count) derived, \(stale.count) withdrawn (\(composed))")
        return writes.count
    }

    private static let replication = ["GetChanges", "GetChangesAll"].map { [$0, "AllExtendedRights"] }

    @discardableResult
    static func dcSync(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.dcSync],
            ops: try await replicationEdges(elastic, database: database), logger: logger)
    }

    private static func replicationEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let domains = try await nodeIDs(elastic, database: database, kind: .domain, clauses: [])
        guard !domains.isEmpty else { return [] }

        let members = try await Membership(elastic, database: database)
        var ops: [ElasticClient.BulkOp] = []
        for (domain, rights) in try await directHolders(
            elastic, database: database, of: domains, groups: replication) {
            for principal in members.joint(rights) {
                ops += edge(principal, .dcSync, domain, database)
            }
        }
        return ops
    }

    static func domainOf(
        _ elastic: ElasticClient, database: String, clauses: [JSONValue]
    ) async throws -> [String: String] {
        var out: [String: String] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes, query: GraphStore.scoped(clauses, db: database),
            source: ["id", "props.domainsid"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  let domain = source["props"]?["domainsid"]?.string, !domain.isEmpty else { continue }
            out[id] = domain
        }
        return out
    }

    static func wellKnownHubs(
        _ elastic: ElasticClient, database: String, suffix: String
    ) async throws -> [String: String] {
        var out: [String: String] = [:]
        for (id, domain) in try await domainOf(elastic, database: database, clauses: [
            ["term": ["kind": .string(ADNodeKind.group.rawValue)]],
        ]) where id.uppercased().hasSuffix(suffix) {
            out[domain] = id
        }
        return out
    }

    static func nodeIDs(
        _ elastic: ElasticClient, database: String, kind: ADNodeKind, clauses: [JSONValue]
    ) async throws -> Set<String> {
        try await GraphStore.nodeIDs(elastic, GraphStore.scoped(
            [["term": ["kind": .string(kind.rawValue)]]] + clauses, db: database))
    }

    static func directHolders(
        _ elastic: ElasticClient, database: String, of targets: Set<String>, groups: [[String]]
    ) async throws -> [String: [Set<String>]] {
        var out: [String: [Set<String>]] = [:]
        for target in targets { out[target] = [] }
        for group in groups {
            let held = try await directHolders(elastic, database: database, of: targets, kinds: group)
            for target in targets { out[target]?.append(held[target] ?? []) }
        }
        return out.filter { $0.value.allSatisfy { !$0.isEmpty } }
    }

    static func directHolders(
        _ elastic: ElasticClient, database: String, of targets: Set<String>, kinds: [String]
    ) async throws -> [String: Set<String>] {
        var out: [String: Set<String>] = [:]
        for chunk in Array(targets).chunked(1_000) {
            for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([
                ["terms": ["kind": .strings(kinds)]],
                ["terms": ["target": .strings(chunk)]],
            ], db: database)) {
                out[edge.target, default: []].insert(edge.source)
            }
        }
        return out
    }

    struct Membership {

        private var groupsOf: [String: [String]] = [:]
        private var membersOf: [String: [String]] = [:]

        init(_ elastic: ElasticClient, database: String) async throws {
            self.init(try await Passes.edgesOf(elastic, database: database, kind: .memberOf))
        }

        init(_ memberships: [(String, String)]) {
            for (member, group) in memberships {
                groupsOf[member, default: []].append(group)
                membersOf[group, default: []].append(member)
            }
        }

        private func closure(_ ids: Set<String>, along step: [String: [String]]) -> Set<String> {
            var out = ids, frontier = Array(ids)
            while let id = frontier.popLast() {
                for next in step[id] ?? [] {
                    if out.insert(next).inserted { frontier.append(next) }
                }
            }
            return out
        }

        func expanded(_ ids: Set<String>) -> Set<String> {
            closure(ids, along: membersOf)
        }

        func joint(_ sets: [Set<String>]) -> Set<String> {
            guard let smallest = sets.min(by: { $0.count < $1.count }) else { return [] }
            guard sets.count > 1 else { return smallest }
            var lineages: [String: Set<String>] = [:]
            func lineage(_ principal: String) -> Set<String> {
                if let known = lineages[principal] { return known }
                let found = closure([principal], along: groupsOf)
                lineages[principal] = found
                return found
            }
            let held = closure(smallest, along: membersOf).filter { principal in
                let above = lineage(principal)
                return sets.allSatisfy { !$0.isDisjoint(with: above) }
            }

            return held.filter { principal in
                !lineage(principal).contains { group in
                    group != principal && held.contains(group) && !lineage(group).contains(principal)
                }
            }
        }
    }

    static func edgesOf(
        _ elastic: ElasticClient, database: String, kind: ADEdgeKind
    ) async throws -> [(String, String)] {
        try await GraphStore.edges(elastic, GraphStore.edgeScope(
            [["term": ["kind": .string(kind.rawValue)]]], db: database)).map { ($0.source, $0.target) }
    }

    private static func rank(_ kind: String) -> Int {
        signerPreference.firstIndex { $0.rawValue == kind } ?? signerPreference.count
    }

    static func normalise(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespaces).uppercased()
    }

    static func strings(_ value: JSONValue?) -> [String] {
        if let array = value?.array { return array.compactMap { $0.string } }
        if let single = value?.string { return [single] }
        return []
    }

    static func edge(
        _ source: String, _ kind: ADEdgeKind, _ target: String, _ database: String,
        extra: [String: JSONValue] = [:]
    ) -> [ElasticClient.BulkOp] {
        guard source != target, !source.isEmpty, !target.isEmpty else { return [] }
        var doc: [String: JSONValue] = [
            "db": .string(database), "source": .string(source),
            "target": .string(target), "kind": .string(kind.rawValue),
            "derived": .bool(true),
        ]
        for (key, value) in extra { doc[key] = value }
        return [.init(index: Indices.edges,
                      id: "\(database)|\(source)|\(kind.rawValue)|\(target)", doc: doc)]
    }
}

extension Passes {

    static func weighFacts(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws {

        let facts = ["targetDisabled", "quotaZero", "needsApproval", "sessionAgeDays"]
        let stale = try await GraphStore.edges(elastic, GraphStore.scoped([
            ["bool": ["should": .array(facts.map { ["exists": ["field": .string($0)]] }), "minimum_should_match": 1]],
        ], db: database))
        let cleared = Dictionary(uniqueKeysWithValues: facts.map { ($0, JSONValue.null) })

        var ops: [ElasticClient.BulkOp] = stale.map { edge in
            .init(index: Indices.edges,
                  id: GraphStore.edgeID(db: database, source: edge.source, kind: edge.kind, target: edge.target),
                  doc: cleared)
        }
        ops += try await disabledTargets(elastic, database: database)
        ops += try await quotaFacts(elastic, database: database)
        ops += try await approvalFacts(elastic, database: database)
        ops += try await sessionFacts(elastic, database: database)
        guard !ops.isEmpty else { return }

        let outcome = try await elastic.bulkUpdate(ops, skippingMissing: true)
        try await elastic.refresh(Indices.edges)
        logger?.info("weighed \(outcome.updated) relationships in \(database)")
    }

    private static func disabledTargets(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let disabled = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["terms": ["kind": .strings(ADNodeKind.principals.map(\.rawValue))]],
            ["term": ["props.enabled": .string("false")]],
        ], db: database))
        guard !disabled.isEmpty else { return [] }

        var ops: [ElasticClient.BulkOp] = []
        for chunk in Array(disabled).sorted().chunked(1_000) {
            for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([
                ["terms": ["target": .strings(chunk)]],
            ], db: database)) {
                ops.append(.init(index: Indices.edges,
                                 id: GraphStore.edgeID(db: database, source: edge.source,
                                                        kind: edge.kind, target: edge.target),
                                 doc: ["targetDisabled": .bool(true)]))
            }
        }
        return ops
    }

    private static func quotaFacts(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let domains = try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["term": ["kind": .string(ADNodeKind.domain.rawValue)]],
            ], db: database),
            source: ["id", "props.machineaccountquota", "props.ms-ds-machineaccountquota"],
            sort: GraphStore.nodeOrder)

        let zeroed = domains.contains { hit in
            let props = hit["_source"]?["props"]?.object ?? [:]
            let quota = number(props["machineaccountquota"]) ?? number(props["ms-ds-machineaccountquota"])
            return quota == 0
        }
        guard zeroed, domains.count == 1 else { return [] }

        return try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["term": ["kind": .string(ADEdgeKind.allowedToAct.rawValue)]],
        ], db: database)).map { edge in
            .init(index: Indices.edges,
                  id: GraphStore.edgeID(db: database, source: edge.source,
                                         kind: edge.kind, target: edge.target),
                  doc: ["quotaZero": .bool(true)])
        }
    }

    private static func approvalFacts(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let gated = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["kind": .string(ADNodeKind.certTemplate.rawValue)]],
            ["term": ["props.requiresmanagerapproval": .string("true")]],
        ], db: database))
        guard !gated.isEmpty else { return [] }

        var ops: [ElasticClient.BulkOp] = []
        for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["terms": ["kind": .strings(ADCSEscalation.everyEdge.map(\.rawValue))]],
        ], db: database)) {
            guard let template = edge.through, gated.contains(template) else { continue }
            ops.append(.init(index: Indices.edges,
                             id: GraphStore.edgeID(db: database, source: edge.source,
                                                    kind: edge.kind, target: edge.target),
                             doc: ["needsApproval": .bool(true)]))
        }
        return ops
    }

    private static func sessionFacts(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.edges,
            query: GraphStore.edgeScope([
                ["term": ["kind": .string(ADEdgeKind.hasSession.rawValue)]],
                ["exists": ["field": "seenAt"]],
            ], db: database),
            source: ["source", "target", "kind", "seenAt"], sort: GraphStore.edgeOrder) {
            guard let doc = hit["_source"],
                  let from = doc["source"]?.string, let to = doc["target"]?.string,
                  let stamp = number(doc["seenAt"]), stamp > 0, stamp < 4_000_000_000 else { continue }
            let days = (Int(Date().timeIntervalSince1970) - stamp) / 86_400
            guard days > 0 else { continue }
            ops.append(.init(index: Indices.edges,
                             id: GraphStore.edgeID(db: database, source: from,
                                                    kind: ADEdgeKind.hasSession.rawValue, target: to),
                             doc: ["sessionAgeDays": .int(days)]))
        }
        return ops
    }
}

extension Passes {

    static func directoryFacts(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws {
        try await reconcileDerived(
            elastic, database: database,
            kinds: [.hasTrustKeys, .protectAdminGroups, .claimSpecialIdentity, .syncLAPSPassword],
            ops: try await trustKeyEdges(elastic, database: database)
                + adminSDHolderEdges(elastic, database: database)
                + specialIdentityEdges(elastic, database: database)
                + filteredSetEdges(elastic, database: database),
            logger: logger)

        try await reconcileDerived(
            elastic, database: database, kinds: [.propagatesACEsTo],
            ops: try await inheritanceEdges(elastic, database: database), logger: logger)
        try await reconcileDerived(
            elastic, database: database, kinds: [.gpoAppliesTo],
            ops: try await effectivePolicyEdges(elastic, database: database), logger: logger)
    }

    private static func trustKeyEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let trusts = try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["terms": ["kind": .strings([ADEdgeKind.sameForestTrust.rawValue,
                                         ADEdgeKind.crossForestTrust.rawValue])]],
        ], db: database))
        guard !trusts.isEmpty else { return [] }

        var byName: [String: String] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["terms": ["kind": .strings([ADNodeKind.user.rawValue, ADNodeKind.computer.rawValue])]],
            ], db: database),
            source: ["id", "label"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  let label = source["label"]?.string else { continue }
            let name = label.split(separator: "@").first.map(String.init) ?? label
            guard name.hasSuffix("$") else { continue }
            byName[name.uppercased()] = id
        }
        guard !byName.isEmpty else { return [] }

        var labels: [String: String] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.domain.rawValue)]]], db: database),
            source: ["id", "label"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            labels[id] = source["label"]?.string ?? id
        }

        var ops: [ElasticClient.BulkOp] = []
        for trust in trusts {

            guard let far = labels[trust.target] else { continue }
            let netbios = (far.split(separator: ".").first.map(String.init) ?? far).uppercased()
            guard let account = byName[netbios + "$"] else { continue }
            ops += edge(account, .hasTrustKeys, trust.target, database,
                        extra: ["through": .string(trust.source)])
        }
        return ops
    }

    private static func adminSDHolderEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        let holders = try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["match_phrase": ["props.distinguishedname": .string("CN=AdminSDHolder")]],
            ], db: database),
            source: ["id"], sort: GraphStore.nodeOrder)
        guard let holder = holders.first?["_source"]?["id"]?.string else { return [] }

        let protectedObjects = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["props.admincount": .string("true")]],
        ], db: database))
        return protectedObjects.sorted().flatMap { object in
            edge(holder, .protectAdminGroups, object, database)
        }
    }

    private static func inheritanceEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        let protectedChildren = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["props.isaclprotected": .string("true")]],
        ], db: database))

        var ops: [ElasticClient.BulkOp] = []
        for (parent, child) in try await edgesOf(elastic, database: database, kind: .contains) {
            guard !protectedChildren.contains(child) else { continue }
            ops += edge(parent, .propagatesACEsTo, child, database)
        }
        return ops
    }

    private static func effectivePolicyEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let links = try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["term": ["kind": .string(ADEdgeKind.gpLink.rawValue)]],
        ], db: database))
        guard !links.isEmpty else { return [] }

        var children: [String: [String]] = [:]
        var blocks = Set<String>()
        for containment in try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["term": ["kind": .string(ADEdgeKind.contains.rawValue)]],
        ], db: database)) {
            children[containment.source, default: []].append(containment.target)
            if containment.blocked { blocks.insert(containment.target) }
        }

        let appliesTo = Set(ADNodeKind.having(.principal).map(\.rawValue))
        var kinds: [String: String] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes, query: GraphStore.scoped([], db: database),
            source: ["id", "kind"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            kinds[id] = source["kind"]?.string ?? ""
        }

        var ops: [ElasticClient.BulkOp] = []
        for link in links {
            var reached: [String] = []
            var frontier = [link.target]
            var seen = Set(frontier)

            while let at = frontier.popLast() {
                for child in children[at] ?? [] {
                    guard seen.insert(child).inserted else { continue }
                    if blocks.contains(child), !link.enforced { continue }
                    if appliesTo.contains(kinds[child] ?? "") { reached.append(child) }
                    frontier.append(child)
                }
            }
            for object in reached {
                ops += edge(link.source, .gpoAppliesTo, object, database,
                            extra: ["enforced": .bool(link.enforced)])
            }
        }
        return ops
    }

    private static let specialIdentities: [(suffix: String, from: String, how: String)] = [
        ("S-1-64-10", WellKnown.authenticatedUsers, "by authenticating with NTLM"),
        ("S-1-64-14", WellKnown.authenticatedUsers, "by authenticating with a certificate over Schannel"),
        ("S-1-18-1", WellKnown.authenticatedUsers, "by authenticating with a password"),
        ("S-1-18-4", WellKnown.authenticatedUsers, "by authenticating with a key credential"),
    ]

    private static func specialIdentityEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        var ops: [ElasticClient.BulkOp] = []

        let hubs = try await wellKnownHubs(
            elastic, database: database, suffix: WellKnown.authenticatedUsers)
        guard !hubs.isEmpty else { return [] }
        let byDomain = try await domainOf(elastic, database: database, clauses: [])
        for identity in specialIdentities {
            for (id, domain) in byDomain.sorted(by: { $0.key < $1.key })
            where id.uppercased().hasSuffix(identity.suffix) {
                guard let hub = hubs[domain] else { continue }
                ops += edge(hub, .claimSpecialIdentity, id, database,
                            extra: ["note": .string(identity.how)])
            }
        }
        return ops
    }

    private static func filteredSetEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let domains = try await nodeIDs(elastic, database: database, kind: .domain, clauses: [])
        guard !domains.isEmpty else { return [] }
        let held = try await directHolders(
            elastic, database: database, of: domains,
            groups: [["GetChangesInFilteredSet"], ["GetChanges", "GenericAll", "AllExtendedRights"]])

        let managed = try await domainOf(elastic, database: database, clauses: [
            ["term": ["kind": .string(ADNodeKind.computer.rawValue)]],
            ["term": ["props.haslaps": .string("true")]],
        ])
        guard !managed.isEmpty else { return [] }

        let members = try await Membership(elastic, database: database)
        var ops: [ElasticClient.BulkOp] = []
        for (domain, groups) in held {
            let hosts = managed.filter { $0.value == domain }.keys.sorted()
            guard !hosts.isEmpty else { continue }
            for holder in members.joint(groups).sorted() {
                for host in hosts {
                    ops += edge(holder, .syncLAPSPassword, host, database,
                                extra: ["through": .string(domain)])
                }
            }
        }
        return ops
    }
}

import Foundation

enum GraphTraversal {

    private static let hopChunk = 1_000

    struct Matched: Sendable {
        let rows: [GraphStore.NodeRow]
        let total: Int
    }

    static func objects(
        _ client: ElasticClient, db: String?, clauses: [JSONValue]
    ) async throws -> Matched {
        let query = GraphStore.scoped(clauses, db: db)

        let total = try await client.count(index: Indices.nodes, query)
        let rows: [GraphStore.NodeRow] = try await client.scan(
            index: Indices.nodes, query: query, source: GraphStore.NodeRow.fields,
            sort: GraphStore.nodeOrder, row: { GraphStore.NodeRow($0) })
        return Matched(rows: GraphStore.unique(rows), total: total)
    }

    static func listing(_ matched: Matched) -> GraphViewDTO {
        GraphViewDTO(nodes: matched.rows.map(\.dto), links: [], total: matched.total)
    }

    typealias Edge = GraphStore.Edge

    enum Carried: Int, Comparable, CaseIterable, Hashable, Sendable {
        case control = 0, enforcedPolicy = 1, policy = 2, bare = 3
        static func < (a: Carried, b: Carried) -> Bool { a.rawValue < b.rawValue }
    }

    static let inheriting = Set(Rights.control)

    private static func carry(_ edge: Edge, from state: Carried) -> Carried? {
        switch edge.kind {
        case ADEdgeKind.contains.rawValue:
            switch state {
            case .bare: return nil
            case .policy: return edge.blocked ? nil : .policy
            case .control, .enforcedPolicy: return state
            }
        case ADEdgeKind.gpLink.rawValue:

            guard state == .control else { return nil }
            return edge.enforced ? .enforcedPolicy : .policy
        case "WriteGPLink":

            return .enforcedPolicy
        default:
            return inheriting.contains(edge.kind) ? .control : .bare
        }
    }

    private static func demanded(_ edge: Edge, into required: Carried) -> Carried? {
        Carried.allCases.last { carry(edge, from: $0).map { $0 <= required } ?? false }
    }

    static func hop(
        _ client: ElasticClient, db: String?, frontier: [String], outbound: Bool,
        kinds: [String] = [], walking: Bool = true
    ) async throws -> [Edge] {
        guard !frontier.isEmpty else { return [] }
        let field = outbound ? "source" : "target"
        var edges: [Edge] = []
        for chunk in frontier.chunked(hopChunk) {
            var must: [JSONValue] = [["terms": [field: .strings(chunk)]]]
            if !kinds.isEmpty { must.append(["terms": ["kind": .strings(kinds)]]) }
            if walking { must.append(["bool": ["must_not": ["term": ["unvetted": .bool(true)]]]]) }
            edges += try await GraphStore.edges(client, GraphStore.edgeScope(must, db: db))
        }
        return edges
    }

    static func reachableInto(
        _ client: ElasticClient, db: String?, into ids: [String], kinds: [String],
        maxHops: Int = 4
    ) async throws -> GraphViewDTO {
        var required: [String: Carried] = Dictionary(uniqueKeysWithValues: ids.map { ($0, .bare) })
        var frontier = ids
        var found: [Edge] = []

        for _ in 0..<maxHops {
            var arrived: [String] = []

            for edge in try await hop(client, db: db, frontier: frontier, outbound: false,
                                      kinds: kinds) {
                guard let into = required[edge.target], let need = demanded(edge, into: into) else { continue }
                found.append(edge)
                if required[edge.source] == nil {
                    required[edge.source] = need
                    arrived.append(edge.source)
                }
            }

            frontier = arrived.filter { !WellKnown.isHub($0) }
            guard !frontier.isEmpty else { break }
        }

        var grounded = Set(required.filter { $0.value == .bare }.keys)
        var grew = true
        while grew {
            grew = false
            for edge in found where grounded.contains(edge.source) {
                if grounded.insert(edge.target).inserted { grew = true }
            }
        }
        return try await assemble(client, db: db, ids: Array(grounded), edges: found)
    }

    static let escalationEdges: [String] =
        TierZero.controlEdgeKinds + [
            "MemberOf", "AddSelf",
            "WriteSPN", "ReadGMSAPassword",
            "ReadLAPSPassword", "DumpSMSAPassword",
            "AllowedToDelegate", "AllowedToAct",

            "AddAllowedToAct", "WriteAccountRestrictions",
            "ManageCertificates",
            "HasSIDHistory",

            ADEdgeKind.kerberoastable.rawValue, ADEdgeKind.asrepRoastable.rawValue,

            ADEdgeKind.seBackupPrivilege.rawValue, ADEdgeKind.seLoadDriverPrivilege.rawValue,
            ADEdgeKind.serviceControl.rawValue, ADEdgeKind.dnsServerControl.rawValue,

            ADEdgeKind.coerceToTGT.rawValue, ADEdgeKind.goldenCert.rawValue,

            ADEdgeKind.spoofSIDHistory.rawValue, ADEdgeKind.abuseTGTDelegation.rawValue,

            ADEdgeKind.adminTo.rawValue, ADEdgeKind.canRDP.rawValue,
            ADEdgeKind.canPSRemote.rawValue, ADEdgeKind.executeDCOM.rawValue,
            ADEdgeKind.hasSession.rawValue,

            ADEdgeKind.dcFor.rawValue,

            ADEdgeKind.contains.rawValue, ADEdgeKind.gpLink.rawValue, "WriteGPLink",

            ADEdgeKind.propagatesACEsTo.rawValue, ADEdgeKind.gpoAppliesTo.rawValue,

            ADEdgeKind.hasTrustKeys.rawValue, ADEdgeKind.protectAdminGroups.rawValue,
            ADEdgeKind.claimSpecialIdentity.rawValue, ADEdgeKind.syncLAPSPassword.rawValue,
            ADEdgeKind.badSuccessor.rawValue, ADEdgeKind.rodcKeyRecovery.rawValue,

            ADEdgeKind.coerceAndRelayToADCS.rawValue, ADEdgeKind.coerceAndRelayToLDAP.rawValue,
            ADEdgeKind.coerceAndRelayToSMB.rawValue,

            ADEdgeKind.sccmSiteTakeover.rawValue, ADEdgeKind.sccmClientPush.rawValue,
            ADEdgeKind.sqlAdmin.rawValue,

            ADEdgeKind.syncedToEntraUser.rawValue, ADEdgeKind.syncedToADUser.rawValue,

            ADEdgeKind.gppPassword.rawValue,

            ADEdgeKind.adcsESC5.rawValue, ADEdgeKind.adcsESC11.rawValue, ADEdgeKind.adcsESC16.rawValue,
        ]

    fileprivate struct Visit: Hashable, Sendable {
        let node: String
        let carried: Carried
    }

    fileprivate struct Step: Sendable {
        let edge: Edge
        let from: Visit
    }

    struct Walk: Sendable {

        let reached: [String]

        fileprivate let arrival: [String: Visit]

        fileprivate let via: [Visit: Step]

        fileprivate let alternates: [Visit: [Step]]

        func chain(to target: String, every: Bool = false) -> [Edge] {
            guard let destination = arrival[target] else { return [] }
            var chain: [Edge] = []
            var seen: Set<Visit> = [destination]
            var pending = [destination]

            while let visit = pending.popLast() {
                let incoming = every ? (alternates[visit] ?? []) : (via[visit].map { [$0] } ?? [])
                for step in incoming {
                    chain.append(step.edge)
                    if seen.insert(step.from).inserted { pending.append(step.from) }
                }
            }
            return chain.reversed()
        }
    }

    static func reach(
        _ client: ElasticClient, db: String?, from source: String,
        to targets: Set<String>, kinds: [String] = escalationEdges,
        maxHops: Int
    ) async throws -> Walk {
        let start = Visit(node: source, carried: .bare)
        var depth: [Visit: Int] = [start: 0]
        var via: [Visit: Step] = [:]
        var alternates: [Visit: [Step]] = [:]
        var arrivalOf: [String: Visit] = [:]
        var reached: [String] = []
        var frontier: [Visit] = [start]

        for level in 0..<maxHops {

            var standings: [String: [Carried]] = [:]
            for visit in frontier { standings[visit.node, default: []].append(visit.carried) }
            var arrived: [Visit] = []

            for edge in try await hop(
                client, db: db, frontier: Array(standings.keys), outbound: true,
                kinds: kinds) {
                for held in standings[edge.source] ?? [] {
                    guard let next = carry(edge, from: held) else { continue }
                    let from = Visit(node: edge.source, carried: held)
                    let to = Visit(node: edge.target, carried: next)
                    let step = Step(edge: edge, from: from)
                    if let already = depth[to] {

                        if already == level + 1 { alternates[to, default: []].append(step) }
                        continue
                    }
                    depth[to] = level + 1
                    via[to] = step
                    alternates[to] = [step]
                    arrived.append(to)
                    if targets.contains(edge.target), arrivalOf[edge.target] == nil {
                        arrivalOf[edge.target] = to
                        reached.append(edge.target)
                    }
                }
            }

            frontier = arrived.filter { !targets.contains($0.node) }
            guard !frontier.isEmpty else { break }
        }
        return Walk(reached: reached, arrival: arrivalOf, via: via, alternates: alternates)
    }

    static func assemble(
        _ client: ElasticClient, db: String?, ids: [String], edges: [Edge],
        total: Int? = nil, truncated: Bool? = nil
    ) async throws -> GraphViewDTO {
        guard !ids.isEmpty else {
            return GraphViewDTO(nodes: [], links: [], total: total, truncated: truncated)
        }

        let nodes = GraphStore.rows(try await client.fetchByIDs(
            index: Indices.nodes, ids: ids, source: GraphStore.NodeRow.fields, db: db))
        return GraphViewDTO(
            nodes: nodes.map(\.dto), links: GraphStore.links(edges, among: nodes),
            total: total, truncated: truncated)
    }
}

enum ReachPaths {

    private struct Candidate {
        let source: String
        let target: String
        let chain: [GraphTraversal.Edge]

        let standing: Bool

        let category: String

        let domain: String

        var interior: [String] { chain.dropLast().map(\.target) }
    }

    static func routes(
        _ client: ElasticClient, db: String?, maxHops: Int = GraphScript.maxHops, maxRoutes: Int = 40
    ) async throws -> ReachPathsDTO {
        let owned = try await GraphStore.nodeIDs(
            client, GraphStore.scoped([["term": ["owned": .bool(true)]]], db: db)).sorted()
        guard !owned.isEmpty else { return ReachPathsDTO(paths: [], truncated: false) }

        let seedHits = try await client.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["tierZeroSeed": .bool(true)]]], db: db),
            source: ["id", "labelAsserted", "label", "kind", "tierZeroReason", "owned",
                     "props.domainsid"],
            sort: GraphStore.nodeOrder)
        let seedRows = GraphStore.rows(seedHits)
        let seeds = Set(seedRows.map(\.id))
        guard !seeds.isEmpty else { return ReachPathsDTO(paths: [], truncated: false) }
        var seedReason: [String: String] = [:]
        var seedCategory: [String: String] = [:]
        var seedDomain: [String: String] = [:]

        var controlled: Set<String> = []
        for hit in seedHits {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let reason = source["tierZeroReason"]?.string ?? "Tier Zero"
            let kind = source["kind"]?.string ?? ""
            seedReason[id] = reason
            seedCategory[id] = category(reason: reason, kind: kind)

            let domain = source["props"]?.object?["domainsid"]?.string ?? ""
            seedDomain[id] = domain.isEmpty ? id : domain
            if source["owned"]?.bool == true, takesTheDomain(id: id, kind: kind) {
                controlled.insert(seedDomain[id] ?? id)
            }
        }

        let held = Set(seedRows.filter(\.owned).map(\.id))

        let taken = Set(seeds.filter { controlled.contains(seedDomain[$0] ?? "") })

        let domains = Set(seeds.compactMap { seedDomain[$0] })
        let counts = (domains: domains.count, held: domains.intersection(controlled).count)

        let footholdHits = try await client.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["owned": .bool(true)]]], db: db),
            source: ["id", "chokeValue"], sort: GraphStore.nodeOrder)
        let footholds = footholdHits.compactMap { hit -> (id: String, choke: Int)? in
            guard let source = hit["_source"], let id = source["id"]?.string else { return nil }
            return (id, source["chokeValue"]?.int ?? 0)
        }.sorted { ($1.choke, $0.id) < ($0.choke, $1.id) }.map { $0.id }
        guard !footholds.isEmpty else {
            return ReachPathsDTO(paths: [], truncated: false,
                                 domains: counts.domains, domainsHeld: counts.held)
        }

        var candidates: [Candidate] = []
        var truncated = footholds.count > sourceLimit
        for source in footholds.prefix(sourceLimit) {

            let reachable = seeds.subtracting([source]).subtracting(taken)
            guard !reachable.isEmpty else { continue }
            let found = try await walk(client, db: db, from: source, to: reachable,
                                       maxHops: maxHops, category: seedCategory, domain: seedDomain)
            candidates += found

            let blocking = Set(found.filter(\.standing).map(\.target))
            guard !blocking.isEmpty, found.allSatisfy(\.standing) else { continue }
            candidates += try await walk(
                client, db: db, from: source, to: reachable.subtracting(blocking),
                maxHops: maxHops, category: seedCategory, domain: seedDomain)
        }

        let kept = select(candidates)
        truncated = truncated || kept.count > maxRoutes
        let chosen = Array(kept.prefix(maxRoutes))
        guard !chosen.isEmpty else {
            return ReachPathsDTO(paths: [], truncated: truncated,
                                 domains: counts.domains, domainsHeld: counts.held)
        }

        var needed: Set<String> = []
        for route in chosen {
            needed.insert(route.source); needed.insert(route.target)
            for edge in route.chain { needed.insert(edge.source); needed.insert(edge.target) }
        }
        let hits = try await client.fetchByIDs(index: Indices.nodes, ids: Array(needed), db: db)
        let rows = GraphStore.rows(hits)
        var label: [String: String] = [:]
        var kind: [String: String] = [:]
        for row in rows { label[row.id] = row.label; kind[row.id] = row.kind }

        var choke: [String: Int] = [:]
        for hit in hits {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            choke[id] = source["chokeValue"]?.int ?? 0
        }
        let name = { (id: String) in label[id] ?? id }
        let kindOf = { (id: String) in kind[id] ?? "" }
        let chokeOf = { (id: String) in choke[id] ?? 0 }

        let population = try await client.count(index: Indices.nodes, GraphStore.scoped(
            [["terms": ["kind": .strings([ADNodeKind.user.rawValue, ADNodeKind.computer.rawValue])]]], db: db))

        let ownedSet = Set(owned)
        let paths = chosen.map { route in

            let walked = route.chain
                .lastIndex { ownedSet.contains($0.target) }
                .map { $0 + 1 } ?? 0

            let hardest = Weights.hardest(route.chain)
            return ReachPathDTO(
                startId: route.source, startLabel: name(route.source),
                startKind: kindOf(route.source),
                targetId: route.target, targetLabel: name(route.target),
                targetReason: seedReason[route.target] ?? "Tier Zero",
                reached: route.category,
                targetOwned: held.contains(route.target),
                walked: walked,
                startChoke: chokeOf(route.source),
                standing: route.standing,
                difficulty: hardest.weight.difficulty.rawValue,
                difficultyAssumed: hardest.weight.assumed,
                hardestStep: hardest.step.map { ReachTechniques.for(edge: $0.kind) } ?? "",
                hardestWhy: hardest.weight.because,
                steps: route.chain.map { edge in
                    let remedy = ReachTechniques.remedy(edge: edge.kind)
                    let weight = Weights.of(edge)
                    return ReachStepDTO(
                        fromLabel: name(edge.source),
                        toId: edge.target, toLabel: name(edge.target),
                        toKind: kindOf(edge.target),
                        edge: edge.kind, technique: ReachTechniques.for(edge: edge.kind),
                        effort: remedy.effort, fix: remedy.fix,
                        provenance: edge.origin == "asserted" ? "asserted" : edge.derived ? "derived" : "collected",
                        choke: chokeOf(edge.target),
                        facts: ReachTechniques.facts(edge: edge, name: name),
                        difficulty: weight.difficulty.rawValue, assumed: weight.assumed)
                })
        }
        return ReachPathsDTO(paths: paths, truncated: truncated, population: population,
                             domains: counts.domains, domainsHeld: counts.held)
    }

    private static func walk(
        _ client: ElasticClient, db: String?, from source: String, to targets: Set<String>,
        maxHops: Int, category: [String: String], domain: [String: String]
    ) async throws -> [Candidate] {
        guard !targets.isEmpty else { return [] }
        let found = try await GraphTraversal.reach(
            client, db: db, from: source, to: targets, maxHops: maxHops)
        return found.reached.compactMap { target in
            let chain = found.chain(to: target)
            guard !chain.isEmpty else { return nil }
            return Candidate(
                source: source, target: target, chain: chain,
                standing: !chain.contains { $0.kind != ADEdgeKind.memberOf.rawValue },
                category: category[target] ?? "tier-zero", domain: domain[target] ?? "")
        }
    }

    private static func select(_ candidates: [Candidate]) -> [Candidate] {
        var kept = best(of: candidates.filter { !$0.standing })
        let answered = Set(kept.map(\.source))
        kept += best(of: candidates.filter { $0.standing && !answered.contains($0.source) })

        return kept.sorted {
            ($0.standing ? 1 : 0, $0.chain.count, $0.source, $0.target)
                < ($1.standing ? 1 : 0, $1.chain.count, $1.source, $1.target)
        }
    }

    private static func best(of candidates: [Candidate]) -> [Candidate] {

        var survivors: [Candidate] = []
        var covered: [String: Set<String>] = [:]
        for candidate in candidates.sorted(by: {
            ($1.chain.count, $0.source, $0.target) < ($0.chain.count, $1.source, $1.target)
        }) {
            if covered[candidate.target]?.contains(candidate.source) == true { continue }
            survivors.append(candidate)
            covered[candidate.target, default: []].formUnion(candidate.interior)
        }

        var shortest: [String: Candidate] = [:]
        for candidate in survivors {
            let key = "\(candidate.source)|\(candidate.domain)|\(candidate.category)"
            guard let standing = shortest[key] else { shortest[key] = candidate; continue }
            if (candidate.chain.count, candidate.target) < (standing.chain.count, standing.target) {
                shortest[key] = candidate
            }
        }
        return Array(shortest.values)
    }

    static let sourceLimit = 40

    private static let fullControl = [
        "S-1-5-32-544",
        "-512",
        "-519",
        "-516",
        "-500",
        "-502",
    ]

    static func takesTheDomain(id: String, kind: String) -> Bool {
        if kind == ADNodeKind.domain.rawValue { return true }
        let upper = id.uppercased()
        return fullControl.contains { upper.hasSuffix($0) }
    }

    private static func category(reason: String, kind: String) -> String {
        let lowered = reason.lowercased()
        if lowered.contains("domain admins") || lowered.contains("enterprise admins")
            || lowered.contains("administrators") { return "domain-admins" }
        if kind.contains("CA") || kind == "NTAuthStore" || lowered.contains("certificate") {
            return "ca"
        }
        return "tier-zero"
    }
}

enum ReachTechniques {

    private static let table: [String: String] = primitives.merging(
        ADCSEscalation.everyEscalation.reduce(into: [String: String]()) { composed, escalation in
            composed[escalation.edge.rawValue] = escalation.technique
        }, uniquingKeysWith: { primitive, _ in primitive })

    private static let primitives: [String: String] = [

        "GenericAll": "Full control (GenericAll)",
        "GenericWrite": "Write access (GenericWrite)",
        "WriteDacl": "Write DACL",
        "WriteOwner": "Write owner",
        "Owns": "Ownership",

        "OwnsLimitedRights": "Ownership, limited rights",
        "WriteOwnerLimitedRights": "Write owner, limited rights",

        "ForceChangePassword": "Force password reset",
        "AddKeyCredentialLink": "Shadow credentials",
        "WriteAltSecurityIdentities": "Explicit certificate mapping",
        "WritePublicInformation": "Write public information",
        "WriteSPN": "Targeted Kerberoasting",
        "ReadGMSAPassword": "Read gMSA password",
        "ReadLAPSPassword": "Read LAPS password",
        "DumpSMSAPassword": "Dump sMSA password",

        "Kerberoastable": "Kerberoasting",
        "ASREPRoastable": "AS-REP roasting",

        "AddMember": "Add group member",
        "AddSelf": "Add self to group",
        "MemberOf": "Group membership",

        "DCSync": "Directory replication (DCSync)",
        "AllExtendedRights": "All extended rights",

        "AllowedToDelegate": "Constrained delegation",
        "AllowedToAct": "Resource-based delegation",
        "AddAllowedToAct": "Grant resource-based delegation",
        "WriteAccountRestrictions": "Write account restrictions (RBCD)",
        "CoerceToTGT": "Unconstrained delegation (CoerceToTGT)",

        "HostsCAService": "Hosts the certification authority",
        "ManageCA": "CA administrator",
        "ManageCertificates": "CA officer",
        "GoldenCert": "Golden Certificate",

        "SeBackupPrivilege": "SeBackupPrivilege",
        "SeLoadDriverPrivilege": "SeLoadDriverPrivilege",
        "ServiceControl": "Service control",
        "DNSServerControl": "DnsAdmins DLL load",

        "HasSIDHistory": "SID history",

        "SpoofSIDHistory": "SpoofSIDHistory",
        "AbuseTGTDelegation": "AbuseTGTDelegation",

        "AdminTo": "Local administrator",
        "CanRDP": "Remote Desktop",
        "CanPSRemote": "PowerShell remoting",
        "ExecuteDCOM": "DCOM execution",
        "HasSession": "HasSession",
        "DCFor": "DCFor",

        "Contains": "Contains",
        "GPLink": "Group policy applies",
        "WriteGPLink": "Link a controlled policy",

        "PropagatesACEsTo": "PropagatesACEsTo",
        "GPOAppliesTo": "GPOAppliesTo",
        "HasTrustKeys": "Trust account keys",
        "ProtectAdminGroups": "AdminSDHolder descriptor stamping",
        "ClaimSpecialIdentity": "ClaimSpecialIdentity",
        "SyncLAPSPassword": "SyncLAPSPassword",
        "BadSuccessor": "BadSuccessor",
        "RODCKeyRecovery": "RODC password replication",
        "CoerceAndRelayNTLMToADCS": "CoerceAndRelayNTLMToADCS",
        "CoerceAndRelayNTLMToLDAP": "CoerceAndRelayNTLMToLDAP",
        "CoerceAndRelayNTLMToSMB": "CoerceAndRelayNTLMToSMB",

        "SCCMSiteTakeover": "Configuration Manager site control",
        "SCCMClientPush": "Configuration Manager client push account",
        "SyncedToEntraUser": "Directory synchronisation to the cloud account",
        "SyncedToADUser": "Cloud synchronisation to the directory account",
        "SQLAdmin": "Database instance administrator",
        "GPPPassword": "GPP password",
    ]

    struct Remedy: Sendable {
        let effort: String
        let fix: String
    }

    private static let remedies: [String: Remedy] = [
        "GenericAll": .init(effort: "easy", fix: "Remove the full-control permission from the ACL"),
        "GenericWrite": .init(effort: "easy", fix: "Remove the write permission from the ACL"),
        "WriteDacl": .init(effort: "easy", fix: "Remove the right to change the ACL"),
        "WriteOwner": .init(effort: "easy", fix: "Remove the right to change the owner"),
        "Owns": .init(effort: "easy", fix: "Make a Tier Zero group the owner"),
        "OwnsLimitedRights": .init(effort: "easy", fix: "Make a Tier Zero group the owner"),
        "WriteOwnerLimitedRights": .init(effort: "easy", fix: "Remove the right to change the owner"),
        "AllExtendedRights": .init(effort: "easy", fix: "Remove the all-extended-rights permission"),
        "ForceChangePassword": .init(effort: "easy", fix: "Remove the reset-password right"),
        "AddKeyCredentialLink": .init(effort: "easy", fix: "Remove write access to the key credential attribute"),
        "WriteAltSecurityIdentities": .init(effort: "easy", fix: "Remove write access to the certificate mapping attribute"),
        "WritePublicInformation": .init(effort: "easy", fix: "Remove the public-information write from the ACL"),
        "WriteSPN": .init(effort: "easy", fix: "Remove write access to the service principal names"),
        "ReadGMSAPassword": .init(effort: "easy", fix: "Limit who may retrieve the managed password to the hosts that need it"),
        "ReadLAPSPassword": .init(effort: "easy", fix: "Limit who may read the local administrator password"),
        "DumpSMSAPassword": .init(effort: "moderate", fix: "Limit local administrators on the host that holds the managed account"),
        "Kerberoastable": .init(effort: "moderate", fix: "Rotate the password to a long random one, or move the service to a managed account"),
        "ASREPRoastable": .init(effort: "easy", fix: "Require Kerberos pre-authentication on the account"),
        "AddMember": .init(effort: "easy", fix: "Remove the right to change the group's members"),
        "AddSelf": .init(effort: "easy", fix: "Remove the right to add oneself to the group"),
        "MemberOf": .init(effort: "easy", fix: "Remove the membership"),
        "DCSync": .init(effort: "easy", fix: "Remove directory replication rights from everything but domain controllers"),
        "AllowedToDelegate": .init(effort: "moderate", fix: "Remove or narrow the constrained delegation"),
        "AllowedToAct": .init(effort: "moderate", fix: "Clear the resource-based delegation list"),
        "AddAllowedToAct": .init(effort: "easy", fix: "Remove write access to the resource-based delegation list"),
        "WriteAccountRestrictions": .init(effort: "easy", fix: "Remove write access to the account restrictions"),
        "CoerceToTGT": .init(effort: "moderate", fix: "Clear unconstrained delegation on the account, or mark privileged accounts sensitive"),
        "HostsCAService": .init(effort: "inherent", fix: "Protect the CA host as Tier Zero"),
        "ManageCA": .init(effort: "moderate", fix: "Remove the CA administrator role"),
        "ManageCertificates": .init(effort: "moderate", fix: "Remove the certificate manager role"),
        "GoldenCert": .init(effort: "hard", fix: "Hold the authority's key in a hardware module and treat the host as Tier Zero"),
        "SeBackupPrivilege": .init(effort: "easy", fix: "Empty the Backup Operators group and grant the backup right to a managed account instead"),
        "SeLoadDriverPrivilege": .init(effort: "easy", fix: "Empty the Print Operators group"),
        "ServiceControl": .init(effort: "easy", fix: "Empty the Server Operators group"),
        "DNSServerControl": .init(effort: "easy", fix: "Empty the DNSAdmins group, or run the name service off the controllers"),
        "HasSIDHistory": .init(effort: "easy", fix: "Clear the SID history"),
        "SpoofSIDHistory": .init(effort: "moderate", fix: "Enable SID filtering (quarantine) on the trust"),
        "AbuseTGTDelegation": .init(effort: "moderate", fix: "Disable ticket-granting-ticket delegation across the trust"),
        "AdminTo": .init(effort: "moderate", fix: "Remove the local administrator right"),
        "CanRDP": .init(effort: "moderate", fix: "Remove the Remote Desktop right"),
        "CanPSRemote": .init(effort: "moderate", fix: "Remove the remote management right"),
        "ExecuteDCOM": .init(effort: "moderate", fix: "Remove the DCOM access right"),
        "HasSession": .init(effort: "hard", fix: "Keep privileged accounts from logging on to this host"),
        "DCFor": .init(effort: "inherent", fix: "Protect the domain controller as Tier Zero"),
        "Contains": .init(effort: "hard", fix: "Move the object, or block inheritance from its container"),
        "GPLink": .init(effort: "moderate", fix: "Unlink the policy, or restrict who may edit it"),
        "WriteGPLink": .init(effort: "easy", fix: "Remove the right to link policies"),

        "PropagatesACEsTo": .init(effort: "inherent",
            fix: "Block inheritance on the child, or remove the inheritable permission at the parent"),
        "GPOAppliesTo": .init(effort: "moderate",
            fix: "Narrow the policy's security filtering, or unlink it from this part of the tree"),
        "HasTrustKeys": .init(effort: "hard",
            fix: "Rotate the trust password; recreate the trust if it has never been rotated"),
        "ProtectAdminGroups": .init(effort: "moderate",
            fix: "Remove the permission from AdminSDHolder, and clear adminCount on objects no longer protected"),
        "ClaimSpecialIdentity": .init(effort: "inherent",
            fix: "Remove whatever the special identity is granted, rather than the claim itself"),
        "SyncLAPSPassword": .init(effort: "easy",
            fix: "Remove the filtered-attribute-set replication right"),
        "BadSuccessor": .init(effort: "easy",
            fix: "Remove the right to create delegated managed service accounts in this container"),
        "RODCKeyRecovery": .init(effort: "moderate",
            fix: "Take the principals out of the reveal group, and add the ones that matter to the never-reveal group"),
        "CoerceAndRelayNTLMToADCS": .init(effort: "moderate",
            fix: "Turn on Extended Protection for Authentication on the enrolment endpoint, and require HTTPS"),
        "CoerceAndRelayNTLMToLDAP": .init(effort: "moderate",
            fix: "Require LDAP signing and channel binding on the controllers"),
        "CoerceAndRelayNTLMToSMB": .init(effort: "moderate",
            fix: "Require SMB signing on the host"),
        "SCCMSiteTakeover": .init(effort: "moderate",
            fix: "Restrict who administers the site server; it is Tier Zero for every client it manages"),
        "SCCMClientPush": .init(effort: "moderate",
            fix: "Turn off automatic client push installation, or give the push account no rights anywhere"),
        "SyncedToEntraUser": .init(effort: "inherent",
            fix: "Treat the on-premises account as Tier Zero for the cloud role it holds"),
        "SyncedToADUser": .init(effort: "inherent",
            fix: "Treat the cloud account as Tier Zero for the directory account it writes"),
        "SQLAdmin": .init(effort: "moderate",
            fix: "Remove the sysadmin role from the principal on that instance"),
        "GPPPassword": .init(effort: "easy",
            fix: "Delete the preference holding the credential, and rotate the password it held"),
    ]

    private static let certificateRemedies: [ADEdgeKind: Remedy] = [
        .adcsESC1: .init(effort: "moderate", fix: "Stop the template accepting a requested subject, or require manager approval"),
        .adcsESC3: .init(effort: "moderate", fix: "Restrict who may hold an enrollment agent certificate"),
        .adcsESC4: .init(effort: "easy", fix: "Remove write access to the certificate template"),
        .adcsESC6: .init(effort: "moderate", fix: "Clear EDITF_ATTRIBUTESUBJECTALTNAME2 on the authority"),
        .adcsESC7: .init(effort: "moderate", fix: "Remove the authority's administrator and officer roles from this principal"),
        .adcsESC9: .init(effort: "moderate", fix: "Put the SID security extension back on the template"),
        .adcsESC10: .init(effort: "moderate", fix: "Require strong certificate binding on the domain controllers"),
        .adcsESC13: .init(effort: "moderate", fix: "Remove the OID group link from the issuance policy"),
        .adcsESC5: .init(effort: "easy", fix: "Remove control of the PKI object from this principal"),
        .adcsESC11: .init(effort: "moderate", fix: "Turn on IF_ENFORCEENCRYPTICERTREQUEST on the authority"),
        .adcsESC16: .init(effort: "moderate", fix: "Take the SID security extension off the authority's disabled-extension list"),
    ]

    static func remedy(edge: String) -> Remedy {
        if let known = remedies[edge] { return known }
        if let kind = ADEdgeKind(rawValue: edge), let certificate = certificateRemedies[kind] {
            return certificate
        }
        return .init(effort: "moderate", fix: "Review this relationship")
    }

    static func facts(
        edge: GraphStore.Edge, name: (String) -> String
    ) -> [String] {
        var out: [String] = []
        switch edge.kind {
        case ADEdgeKind.kerberoastable.rawValue, ADEdgeKind.asrepRoastable.rawValue:
            if let days = edge.passwordAgeDays { out.append("Password set \(age(days)) ago") }
            if edge.aesOnly == false { out.append("Accepts RC4") }
        case ADEdgeKind.adcsESC9.rawValue, ADEdgeKind.adcsESC10.rawValue:
            if let through = edge.through { out.append("By rewriting the identity of \(name(through))") }
        case ADEdgeKind.gpLink.rawValue:
            if edge.enforced { out.append("Enforced, so it applies through a blocking container") }
        case ADEdgeKind.contains.rawValue:
            if edge.blocked { out.append("This container blocks policy inheritance") }
        case ADEdgeKind.spoofSIDHistory.rawValue:
            out.append("SID filtering is off on the trust")
        case ADEdgeKind.abuseTGTDelegation.rawValue:
            out.append("Ticket-granting-ticket delegation is allowed across the trust")
        case ADEdgeKind.hasTrustKeys.rawValue:
            if let through = edge.through { out.append("The trust from \(name(through)) is keyed by this account") }
        case ADEdgeKind.syncLAPSPassword.rawValue:
            out.append("The local administrator password is in the directory for this host")
        case ADEdgeKind.gpoAppliesTo.rawValue:
            out.append(edge.enforced
                ? "Enforced, so it applies through a blocking container"
                : "Reaches this object unless the policy's security filtering excludes it")
        default: break
        }

        if let note = edge.note, !note.isEmpty { out.append(note) }
        return out
    }

    private static func age(_ days: Int) -> String {
        if days >= 730 { return "\(days / 365) years" }
        if days >= 60 { return "\(days / 30) months" }
        return days == 1 ? "a day" : "\(days) days"
    }

    static var known: Set<String> { Set(table.keys) }

    static func `for`(edge: String) -> String { table[edge] ?? edge }
}

enum Difficulty: String, Sendable, CaseIterable, Comparable {

    case trivial

    case easy

    case moderate

    case hard

    case blocked

    private var order: Int { Difficulty.allCases.firstIndex(of: self) ?? 0 }
    static func < (a: Difficulty, b: Difficulty) -> Bool { a.order < b.order }
}

struct Weight: Sendable, Equatable {
    let difficulty: Difficulty

    let assumed: Bool

    let because: [String]

    static let unknown = Weight(difficulty: .moderate, assumed: true, because: [])
}

struct Ramp: Sendable {

    let read: @Sendable (GraphStore.Edge) -> (to: Difficulty, said: String)?

    let source: String
}

enum Weights {

    private static let ageRamp = Ramp(
        read: { edge in
            guard let days = edge.passwordAgeDays, days >= 0 else { return nil }
            let years = days / 365
            let said = years >= 1
                ? "the password is \(years) year\(years >= 2 ? "s" : "") old"
                : "the password was set \(days) days ago"

            if days >= 365 * 3 { return (.easy, said + ", which predates any rotation policy") }
            if days >= 365 { return (.moderate, said) }
            return (.hard, said + ", so it is probably policy-generated")
        },
        source: "Adalanche's password-age curve, read as work rather than as probability")

    private static let aesRamp = Ramp(
        read: { edge in
            guard edge.aesOnly == true else { return nil }
            return (.hard, "the account accepts AES only, so the ticket is orders of magnitude slower to crack")
        },
        source: "RC4 tickets are the cheap case; AES-only is not impossible, it is expensive")

    private static let disabledRamp = Ramp(
        read: { edge in
            guard edge.targetDisabled == true else { return nil }
            return (.blocked, "the account at the far end is disabled")
        },
        source: "Adalanche's OnlyIfTargetAccountEnabled: the relationship is real and unusable")

    private static let approvalRamp = Ramp(
        read: { edge in
            guard edge.needsApproval == true else { return nil }
            return (.hard, "the template needs manager approval, so a person sees the request")
        },
        source: "Approval does not prevent the request; it puts a human in front of it")

    private static let quotaRamp = Ramp(
        read: { edge in
            guard edge.quotaZero == true else { return nil }
            return (.hard, "MachineAccountQuota is 0, so this needs a machine account that already exists")
        },
        source: "The quota gates the usual way this right is taken, not the right itself")

    private static let staleSessionRamp = Ramp(
        read: { edge in
            guard let days = edge.sessionAgeDays, days > 7 else { return nil }
            return (.hard, "the session was last seen \(days) days ago and may be long gone")
        },
        source: "A session is an observation with a timestamp, not a standing fact")

    struct Technique: Sendable {
        let base: Difficulty
        let ramps: [Ramp]

        let subsumes: [String]

        init(_ base: Difficulty, ramps: [Ramp] = [], subsumes: [String] = []) {
            self.base = base
            self.ramps = ramps
            self.subsumes = subsumes
        }
    }

    static let table: [String: Technique] = [

        ADEdgeKind.memberOf.rawValue: Technique(.trivial),
        ADEdgeKind.hasSIDHistory.rawValue: Technique(.trivial),
        ADEdgeKind.dcFor.rawValue: Technique(.trivial),

        "GenericAll": Technique(.easy,
                                subsumes: ["GenericWrite", "WriteDacl", "WriteOwner", "AllExtendedRights",
                                           "ForceChangePassword", "AddKeyCredentialLink",
                                           "WritePublicInformation", "WriteAltSecurityIdentities"]),
        "GenericWrite": Technique(.easy,
                                  subsumes: ["WritePublicInformation", "WriteAltSecurityIdentities",
                                             "AddKeyCredentialLink"]),
        "WriteDacl": Technique(.easy, subsumes: ["WriteOwner"]),
        "WriteOwner": Technique(.easy),
        "Owns": Technique(.easy, subsumes: ["WriteOwner"]),
        "AllExtendedRights": Technique(.easy,
                                       subsumes: ["ForceChangePassword", "GetChanges", "GetChangesAll"]),
        "ForceChangePassword": Technique(.easy, ramps: [disabledRamp]),
        "AddKeyCredentialLink": Technique(.easy, ramps: [disabledRamp]),
        "WriteAltSecurityIdentities": Technique(.easy, ramps: [disabledRamp]),
        "WritePublicInformation": Technique(.easy, ramps: [disabledRamp]),
        "AddMember": Technique(.easy),
        "AddSelf": Technique(.easy),
        "WriteSPN": Technique(.easy, ramps: [disabledRamp]),
        ADEdgeKind.dcSync.rawValue: Technique(.easy),
        ADEdgeKind.syncLAPSPassword.rawValue: Technique(.easy),
        "ReadLAPSPassword": Technique(.easy),
        "ReadGMSAPassword": Technique(.easy),
        ADEdgeKind.badSuccessor.rawValue: Technique(.easy),

        ADEdgeKind.adminTo.rawValue: Technique(
            .easy, ramps: [disabledRamp],
            subsumes: [ADEdgeKind.canRDP.rawValue, ADEdgeKind.canPSRemote.rawValue,
                       ADEdgeKind.executeDCOM.rawValue]),
        ADEdgeKind.canRDP.rawValue: Technique(.easy),
        ADEdgeKind.canPSRemote.rawValue: Technique(.easy),
        ADEdgeKind.executeDCOM.rawValue: Technique(.easy),

        ADEdgeKind.hasSession.rawValue: Technique(.moderate, ramps: [staleSessionRamp]),
        ADEdgeKind.dumpSMSAPassword.rawValue: Technique(.moderate),
        ADEdgeKind.seBackupPrivilege.rawValue: Technique(.moderate),
        ADEdgeKind.seLoadDriverPrivilege.rawValue: Technique(.moderate),
        ADEdgeKind.serviceControl.rawValue: Technique(.moderate),
        ADEdgeKind.dnsServerControl.rawValue: Technique(.moderate),
        ADEdgeKind.coerceToTGT.rawValue: Technique(.moderate, ramps: [disabledRamp]),
        ADEdgeKind.goldenCert.rawValue: Technique(.moderate),
        ADEdgeKind.allowedToAct.rawValue: Technique(.moderate, ramps: [quotaRamp, disabledRamp]),
        ADEdgeKind.allowedToDelegate.rawValue: Technique(.moderate, ramps: [disabledRamp]),
        ADEdgeKind.rodcKeyRecovery.rawValue: Technique(.moderate),
        ADEdgeKind.hasTrustKeys.rawValue: Technique(.moderate),
        ADEdgeKind.coerceAndRelayToADCS.rawValue: Technique(.moderate),
        ADEdgeKind.coerceAndRelayToLDAP.rawValue: Technique(.moderate),
        ADEdgeKind.coerceAndRelayToSMB.rawValue: Technique(.moderate),
        ADEdgeKind.sccmSiteTakeover.rawValue: Technique(.moderate),
        ADEdgeKind.sqlAdmin.rawValue: Technique(.moderate),

        ADEdgeKind.adcsESC1.rawValue: Technique(.easy, ramps: [approvalRamp]),
        ADEdgeKind.adcsESC3.rawValue: Technique(.moderate, ramps: [approvalRamp]),
        ADEdgeKind.adcsESC4.rawValue: Technique(.easy, ramps: [approvalRamp]),
        ADEdgeKind.adcsESC6.rawValue: Technique(.easy, ramps: [approvalRamp]),
        ADEdgeKind.adcsESC7.rawValue: Technique(.moderate),
        ADEdgeKind.adcsESC9.rawValue: Technique(.moderate, ramps: [approvalRamp, disabledRamp]),
        ADEdgeKind.adcsESC10.rawValue: Technique(.moderate, ramps: [approvalRamp, disabledRamp]),
        ADEdgeKind.adcsESC13.rawValue: Technique(.easy, ramps: [approvalRamp]),
        ADEdgeKind.adcsESC5.rawValue: Technique(.moderate),
        ADEdgeKind.adcsESC11.rawValue: Technique(.moderate),
        ADEdgeKind.adcsESC16.rawValue: Technique(.easy),

        ADEdgeKind.kerberoastable.rawValue: Technique(.hard, ramps: [ageRamp, aesRamp, disabledRamp]),
        ADEdgeKind.asrepRoastable.rawValue: Technique(.hard, ramps: [ageRamp, aesRamp, disabledRamp]),

        ADEdgeKind.spoofSIDHistory.rawValue: Technique(.moderate),
        ADEdgeKind.abuseTGTDelegation.rawValue: Technique(.moderate),
    ]

    static func of(_ edge: GraphStore.Edge) -> Weight {
        guard let technique = table[edge.kind] else { return .unknown }
        var because: [String] = []

        var harder: Difficulty?
        var easier: Difficulty?
        for ramp in technique.ramps {
            guard let (to, said) = ramp.read(edge) else { continue }
            because.append(said)
            if to >= technique.base { harder = max(harder ?? to, to) } else { easier = min(easier ?? to, to) }
        }
        let difficulty = harder ?? easier ?? technique.base
        return Weight(difficulty: difficulty, assumed: because.isEmpty, because: because)
    }

    static func subsumed(by kind: String) -> [String] { table[kind]?.subsumes ?? [] }

    static func hardest(_ edges: [GraphStore.Edge]) -> (weight: Weight, step: GraphStore.Edge?) {
        var worst = Weight(difficulty: .trivial, assumed: true, because: [])
        var at: GraphStore.Edge?

        var covered = Set<String>()
        let pair = { (edge: GraphStore.Edge, kind: String) in "\(edge.source)|\(edge.target)|\(kind)" }
        for edge in edges {
            if covered.contains(pair(edge, edge.kind)) { continue }
            for kind in subsumed(by: edge.kind) { covered.insert(pair(edge, kind)) }
            let weight = of(edge)
            guard weight.difficulty > worst.difficulty
                || (weight.difficulty == worst.difficulty && at == nil) else { continue }
            worst = weight
            at = edge
        }
        return (worst, at)
    }
}

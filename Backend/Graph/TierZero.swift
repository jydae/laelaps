import Foundation
import Hummingbird
import Logging

enum TierZero {

    private static let wellKnownRIDs: [(suffix: String, name: String)] = [
        ("-512", "Domain Admins"),
        ("-519", "Enterprise Admins"),
        ("-518", "Schema Admins"),
        ("-516", "Domain Controllers"),
        ("-521", "Read-only Domain Controllers"),
        ("-498", "Enterprise Read-only Domain Controllers"),
        ("-502", "krbtgt"),
        ("-500", "Built-in Administrator"),
        ("-526", "Key Admins"),
        ("-527", "Enterprise Key Admins"),
    ]

    private static let wellKnownSIDs: [(sid: String, name: String)] = [
        ("S-1-5-32-544", "Administrators"),
        ("S-1-5-32-548", "Account Operators"),
        ("S-1-5-32-549", "Server Operators"),
        ("S-1-5-32-550", "Print Operators"),
        ("S-1-5-32-551", "Backup Operators"),
    ]

    private static let controlEdges = controlEdgeKinds

    private static let containment = [ADEdgeKind.contains.rawValue]
    private static let policy = [ADEdgeKind.gpLink.rawValue]

    static let controlEdgeKinds: [String] = Rights.control + Rights.limitedOwnership
        + Rights.identityWrites + [
        "AllExtendedRights", "AddMember",

        ADEdgeKind.dcSync.rawValue,

        ADEdgeKind.hostsCAService.rawValue, "ManageCA",

        ADEdgeKind.goldenCert.rawValue, ADEdgeKind.coerceToTGT.rawValue,

    ] + ADCSEscalation.everyEdge.map(\.rawValue)

    private static let maxRounds = 8

    private static let seedProperties = ["highvalue", "admincount", "unconstraineddelegation"]

    private static let pkiSeedReasons: [String: String] = [
        ADNodeKind.rootCA.rawValue:
            "Root certification authority: its signature is trusted domain-wide",
        ADNodeKind.enterpriseCA.rawValue:
            "Enterprise certification authority: issues certificates the domain accepts",
        ADNodeKind.aiaCA.rawValue:
            "Intermediate certification authority: trusted in the issuing chain",
        ADNodeKind.ntAuthStore.rawValue:
            "NTAuth store: names the authorities allowed to issue logon certificates",
    ]

    private static let wellKnownNames = [
        "DOMAIN ADMINS", "ENTERPRISE ADMINS", "SCHEMA ADMINS", "ADMINISTRATORS",
        "DOMAIN CONTROLLERS", "ACCOUNT OPERATORS", "BACKUP OPERATORS",
        "SERVER OPERATORS", "PRINT OPERATORS", "KEY ADMINS", "ENTERPRISE KEY ADMINS",
        "READ-ONLY DOMAIN CONTROLLERS", "KRBTGT",
    ]

    static func seedReason(id: String, kind: String, label: String, props: [String: JSONValue]) -> String? {

        let normalizedId = id.trimmingCharacters(in: .whitespaces).uppercased()

        for entry in wellKnownRIDs where normalizedId.hasSuffix(entry.suffix) {
            return "Well-known principal: \(entry.name)"
        }
        let name = label.split(separator: "@").first.map(String.init)?
            .trimmingCharacters(in: .whitespaces).uppercased() ?? ""
        for known in wellKnownNames where name == known {
            return "Built-in privileged principal: \(known)"
        }
        for entry in wellKnownSIDs where normalizedId.hasSuffix(entry.sid) {
            return "Built-in principal: \(entry.name)"
        }
        if kind == ADNodeKind.domain.rawValue { return "Domain object" }
        if let pki = pkiSeedReasons[kind] { return pki }
        if JSONValue.isTrue(props["highvalue"]) { return "Flagged high value by the collector" }
        if JSONValue.isTrue(props["admincount"]) { return "Protected by AdminSDHolder (adminCount)" }
        if kind == ADNodeKind.computer.rawValue, JSONValue.isTrue(props["unconstraineddelegation"]) {
            return "Unconstrained delegation: can harvest any TGT presented to it"
        }
        return nil
    }

    struct Walk: Sendable {
        let tagged: Int
        let settled: Bool
    }

    @discardableResult
    static func analyze(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Walk {
        let scope = GraphStore.scoped([], db: database)
        let fields = ["id", "kind", "label", "tierZero", "zoneAsserted", "zoneRefuted"]
            + seedProperties.map { "props.\($0)" }

        var reasons: [String: String] = [:]
        var labels: [String: String] = [:]

        var alreadyTagged: Set<String> = []

        var refused: Set<String> = []
        var scanned = 0

        for hit in try await elastic.scan(
            index: Indices.nodes, query: scope, source: fields, sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            scanned += 1
            let label = source["label"]?.string ?? id
            labels[id] = label
            if source["tierZero"]?.bool == true { alreadyTagged.insert(id) }

            if source["zoneRefuted"]?.bool == true {
                refused.insert(id); continue
            }

            if let reason = seedReason(
                id: id,
                kind: source["kind"]?.string ?? "",
                label: label,
                props: source["props"]?.object ?? [:]
            ) {
                reasons[id] = reason
            } else if source["zoneAsserted"]?.bool == true {
                reasons[id] = "Added to Tier Zero by an operator"
            }
        }

        logger?.info("TierZero: [\(database)] \(scanned) nodes scanned, \(reasons.count) seeded directly")
        guard !reasons.isEmpty else {

            try await write(elastic, database: database, tag: [:], clear: alreadyTagged,
                            seeded: [], choke: [:], logger: logger)
            logger?.info(
                "TierZero: [\(database)] no seed matched, 0 tagged, \(alreadyTagged.count) cleared")
            return Walk(tagged: 0, settled: true)
        }

        let seeded = Set(reasons.keys)

        var parent: [String: String] = [:]
        var order: [String] = []

        var climbed: Set<String> = []
        var policyOK: Set<String> = []

        var structural: Set<String> = []

        var frontier = seeded
        var settled = true
        for round in 0..<maxRounds {
            let before = reasons.count
            var discovered = Set<String>()

            let passes: [(kinds: [String], reason: @Sendable (String, String) -> String)] = [
                ([ADEdgeKind.memberOf.rawValue], { _, target in "Member of \(target)" }),
                (controlEdges, { kind, target in "Holds \(kind) over \(target)" }),
                (containment, { _, target in "Contains \(target)" }),
                (policy, { _, target in "Policy applied to \(target)" }),
            ]
            for pass in passes {
                let isPolicy = pass.kinds == policy

                let climbedNow = climbed, policyNow = policyOK, structuralNow = structural

                let found = try await expand(
                    elastic, database: database, kinds: pass.kinds, reason: pass.reason,
                    into: frontier.union(discovered),
                    skipping: Set(reasons.keys).union(refused), labels: labels,
                    admit: { to, kind, enforced in
                        if isPolicy {
                            return enforced || !climbedNow.contains(to) || policyNow.contains(to)
                        }
                        return !structuralNow.contains(to) || GraphTraversal.inheriting.contains(kind)
                    })
                for (id, step) in found {
                    reasons[id] = step.reason

                    parent[id] = step.via
                    order.append(id)
                    discovered.insert(id)
                    if pass.kinds == containment || isPolicy { structural.insert(id) }
                    if pass.kinds == containment {
                        climbed.insert(id)
                        let below = step.via
                        if !step.blocked, !climbed.contains(below) || policyOK.contains(below) {
                            policyOK.insert(id)
                        }
                    }
                }
            }

            logger?.info("TierZero: [\(database)] round \(round): \(reasons.count) total (was \(before))")
            frontier = discovered
            if discovered.isEmpty { break }

            if round == maxRounds - 1 {
                settled = false
                logger?.warning("""
                    TierZero: [\(database)] closure did not settle within \(maxRounds) rounds, \
                    \(discovered.count) objects were still being discovered. The tagged set is \
                    incomplete; treat it as a lower bound.
                    """)
            }
        }

        let taggable = reasons.filter { labels[$0.key] != nil }
        let phantom = reasons.count - taggable.count
        if phantom > 0 {
            logger?.info(
                "TierZero: [\(database)] \(phantom) referenced principals have no node document and were not tagged"
            )
        }

        let live = seeded.subtracting(refused)
        let stale = alreadyTagged.subtracting(taggable.keys)
        let choke = chokeValues(order: order, parent: parent, seeded: live)
        try await write(elastic, database: database, tag: taggable, clear: stale,
                        seeded: live, choke: choke, logger: logger)
        logger?.info("TierZero: [\(database)] tagged \(taggable.count), cleared \(stale.count)")
        return Walk(tagged: taggable.count, settled: settled)
    }

    static func chokeValues(
        order: [String], parent: [String: String], seeded: Set<String>
    ) -> [String: Int] {
        var size: [String: Int] = [:]
        for id in order.reversed() {
            let through = (size[id] ?? 0) + 1
            if let up = parent[id], up != id { size[up, default: 0] += through }
        }

        return size.filter { !seeded.contains($0.key) }
    }

    private static func write(
        _ elastic: ElasticClient, database: String,
        tag: [String: String], clear: Set<String>, seeded: Set<String>,
        choke: [String: Int], logger: Logger?
    ) async throws {
        var ops = tag.map { id, reason in
            ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: [
                "tierZero": .bool(true),
                "tierZeroSeed": .bool(seeded.contains(id)),
                "tierZeroReason": .string(reason),

                "chokeValue": .int(choke[id] ?? 0),
            ])
        }
        ops += clear.map { id in
            ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: [
                "tierZero": .bool(false),
                "tierZeroSeed": .bool(false),
                "tierZeroReason": .null,
                "chokeValue": .int(0),
            ])
        }
        do {
            try await elastic.bulkUpdate(ops)
        } catch {
            logger?.error("TierZero: [\(database)] tagging write failed: \(type(of: error)): \(error)")
            throw error
        }

        try await elastic.refresh(Indices.nodes)
    }

    struct Step: Sendable { let reason: String; let via: String; let blocked: Bool }

    private static func expand(
        _ elastic: ElasticClient, database: String, kinds: [String],
        reason: @Sendable (String, String) -> String,
        into targets: Set<String>, skipping tagged: Set<String>, labels: [String: String],
        admit: @Sendable (String, String, Bool) -> Bool = { _, _, _ in true }
    ) async throws -> [String: Step] {
        var found: [String: Step] = [:]

        for chunk in Array(targets).chunked(1_000) {

            let query = GraphStore.edgeScope([
                ["terms": ["target": .strings(chunk)]],
                ["terms": ["kind": .strings(kinds)]],
                ["bool": ["must_not": ["term": ["unvetted": .bool(true)]]]],
            ], db: database)

            for edge in try await GraphStore.edges(elastic, query) {
                guard !tagged.contains(edge.source), found[edge.source] == nil,
                      admit(edge.target, edge.kind, edge.enforced) else { continue }
                found[edge.source] = Step(
                    reason: reason(edge.kind, labels[edge.target] ?? edge.target),
                    via: edge.target, blocked: edge.blocked)
            }
        }
        return found
    }
}

struct TierRule: Sendable {
    enum Verdict: String, Sendable {

        case yes

        case no

        case depends
    }

    let id: String

    let title: String

    let nameFragment: String?
    let sidSuffix: String?

    let kinds: [ADNodeKind]
    let verdict: Verdict

    let tier: Int

    let because: String

    let source: String
}

enum RulePack {

    static let all: [TierRule] = [

        .init(id: "entra-connect", title: "Entra Connect synchronisation account",
              nameFragment: "MSOL_", sidSuffix: nil, kinds: [.user], verdict: .yes, tier: 0,
              because: "It replicates the directory, so holding it is holding the directory",
              source: "Microsoft: Entra Connect installs this account with replication rights"),
        .init(id: "entra-sync", title: "Directory synchronisation account",
              nameFragment: "AAD_", sidSuffix: nil, kinds: [.user], verdict: .yes, tier: 0,
              because: "The cloud synchronisation account, with the same rights as MSOL_",
              source: "Microsoft: the Entra Connect service account naming convention"),
        .init(id: "azuread-connect-host", title: "Entra Connect server",
              nameFragment: "AZUREADCONNECT", sidSuffix: nil, kinds: [.computer], verdict: .depends,
              tier: 0,
              because: "The host holds the synchronisation account's credentials in its own store",
              source: "Microsoft: the connector database is decryptable on the host"),
        .init(id: "rodc-krbtgt", title: "Read-only controller ticket account",
              nameFragment: "KRBTGT_", sidSuffix: nil, kinds: [.user], verdict: .yes, tier: 0,

              because: "It signs tickets for whatever the controller's reveal set allows",
              source: "Microsoft: each RODC has its own krbtgt account"),
        .init(id: "exchange-windows-permissions", title: "Exchange Windows Permissions",
              nameFragment: "EXCHANGE WINDOWS PERMISSIONS", sidSuffix: nil, kinds: [.group],
              verdict: .yes, tier: 0,
              because: "It holds WriteDacl on the domain in most installations",
              source: "Microsoft: the Exchange installation grants this at the domain root"),
        .init(id: "exchange-trusted-subsystem", title: "Exchange Trusted Subsystem",
              nameFragment: "EXCHANGE TRUSTED SUBSYSTEM", sidSuffix: nil, kinds: [.group],
              verdict: .depends, tier: 0,
              because: "Reaches the domain through Exchange Windows Permissions where that is granted",
              source: "Microsoft: nested into Exchange Windows Permissions by the installer"),
        .init(id: "organization-management", title: "Organization Management",
              nameFragment: "ORGANIZATION MANAGEMENT", sidSuffix: nil, kinds: [.group],
              verdict: .depends, tier: 0,
              because: "Can grant itself the Exchange rights that reach the domain",
              source: "Microsoft: the Exchange role group with delegation rights"),

        .init(id: "domain-admins", title: "Domain Admins", nameFragment: nil, sidSuffix: "-512",
              kinds: [.group], verdict: .yes, tier: 0,
              because: "Administers the domain", source: "Well-known relative identifier"),
        .init(id: "enterprise-admins", title: "Enterprise Admins", nameFragment: nil, sidSuffix: "-519",
              kinds: [.group], verdict: .yes, tier: 0,
              because: "Administers every domain in the forest", source: "Well-known relative identifier"),
        .init(id: "schema-admins", title: "Schema Admins", nameFragment: nil, sidSuffix: "-518",
              kinds: [.group], verdict: .yes, tier: 0,
              because: "Can change the schema, which applies forest-wide",
              source: "Well-known relative identifier"),
        .init(id: "administrators", title: "Administrators", nameFragment: nil, sidSuffix: "S-1-5-32-544",
              kinds: [.group], verdict: .yes, tier: 0,
              because: "Local administrator on every controller",
              source: "Well-known built-in identifier"),
        .init(id: "backup-operators", title: "Backup Operators", nameFragment: nil,
              sidSuffix: "S-1-5-32-551", kinds: [.group], verdict: .yes, tier: 0,
              because: "May read the directory database off a controller",
              source: "Well-known built-in identifier; the right comes from the controllers policy"),
        .init(id: "account-operators", title: "Account Operators", nameFragment: nil,
              sidSuffix: "S-1-5-32-548", kinds: [.group], verdict: .depends, tier: 0,
              because: "Controls every account the AdminSDHolder sweep does not protect",
              source: "SpecterOps: it depends on what is protected in this directory"),
        .init(id: "dnsadmins", title: "DNS Admins", nameFragment: "DNSADMINS", sidSuffix: nil,
              kinds: [.group], verdict: .depends, tier: 0,
              because: "Can load a library into the name service, which runs on a controller",
              source: "SpecterOps: only where the service runs on a controller, which is usual"),
        .init(id: "cert-publishers", title: "Cert Publishers", nameFragment: nil, sidSuffix: "-517",
              kinds: [.group], verdict: .no, tier: 1,
              because: "Publishes certificates; it does not by itself reach the domain",
              source: "SpecterOps: commonly misread as Tier Zero"),
        .init(id: "protected-users", title: "Protected Users", nameFragment: nil, sidSuffix: "-525",
              kinds: [.group], verdict: .no, tier: 2,
              because: "Membership is a hardening measure, not a privilege",
              source: "Microsoft: a protective group, frequently mistaken for a privileged one"),
    ]

    static func verdict(id: String, kind: String, label: String) -> TierRule? {
        let name = (label.split(separator: "@").first.map(String.init) ?? label)
            .trimmingCharacters(in: .whitespaces).uppercased()
        let objectKind = ADNodeKind(rawValue: kind)
        var best: TierRule?
        for rule in all {
            if !rule.kinds.isEmpty, let objectKind, !rule.kinds.contains(objectKind) { continue }
            let matched = (rule.sidSuffix.map { id.uppercased().hasSuffix($0) } ?? false)
                || (rule.nameFragment.map { name.contains($0) } ?? false)
            guard matched else { continue }

            let better = best.map { held in
                (rule.tier, rule.verdict == .yes ? 0 : 1) < (held.tier, held.verdict == .yes ? 0 : 1)
            } ?? true
            if better { best = rule }
        }
        return best
    }
}

enum Zones {

    struct Zone: Sendable {
        let id: String
        let tier: Int
        let name: String
    }

    static let all: [Zone] = [

        .init(id: "control", tier: 0, name: "Control plane"),

        .init(id: "management", tier: 1, name: "Management plane"),

        .init(id: "data", tier: 2, name: "Data plane"),
    ]

    static let defaultTier = 2

    private static let serverOperatingSystems = ["server", "hyper-v", "esxi", "vmware"]

    private static let managementSignatures: [(fragment: String, role: String)] = [
        ("BACKUP", "backup"), ("VEEAM", "backup"), ("COMMVAULT", "backup"), ("NETBACKUP", "backup"),
        ("RUBRIK", "backup"), ("BAREOS", "backup"), ("BACULA", "backup"), ("ARCSERVE", "backup"),
        ("VCENTER", "virtualisation"), ("VSPHERE", "virtualisation"), ("VMWARE", "virtualisation"),
        ("ESXI", "virtualisation"), ("XENSERVER", "virtualisation"), ("NUTANIX", "virtualisation"),
        ("PROXMOX", "virtualisation"),
        ("SCCM", "endpoint management"), ("MECM", "endpoint management"), ("INTUNE", "endpoint management"),
        ("WSUS", "endpoint management"), ("TANIUM", "endpoint management"), ("BIGFIX", "endpoint management"),
        ("LANDESK", "endpoint management"), ("IVANTI", "endpoint management"), ("JAMF", "endpoint management"),
        ("CROWDSTRIKE", "endpoint protection"), ("SENTINELONE", "endpoint protection"),
        ("CARBONBLACK", "endpoint protection"), ("CYLANCE", "endpoint protection"),
        ("SCOM", "monitoring"), ("NAGIOS", "monitoring"), ("ZABBIX", "monitoring"),
        ("SPLUNK", "monitoring"), ("SOLARWINDS", "monitoring"), ("DATADOG", "monitoring"),
        ("JENKINS", "build"), ("TEAMCITY", "build"), ("BAMBOO", "build"), ("GITLAB-RUNNER", "build"),
        ("ANSIBLE", "configuration management"), ("PUPPET", "configuration management"),
        ("CHEF", "configuration management"), ("SALTSTACK", "configuration management"),
        ("EXCHANGE", "messaging"), ("SHAREPOINT", "collaboration"),
        ("VAULT", "secrets"), ("CYBERARK", "secrets"), ("THYCOTIC", "secrets"),
        ("DELINEA", "secrets"), ("BEYONDTRUST", "secrets"), ("KEEPER", "secrets"),
    ]

    private static let properties = [
        "operatingsystem", "isdc", "admincount", "highvalue", "unconstraineddelegation",
        "trustedtoauth", "serviceprincipalnames", "hasspn",
    ]

    static func classify(
        id: String, kind: String, label: String, props: [String: JSONValue],
        seeded: Bool, asserted: Bool, setByHand: Int? = nil
    ) -> (tier: Int, reason: String, inferred: Bool)? {

        if let setByHand, all.contains(where: { $0.tier == setByHand }) {
            return (setByHand, "Set by an operator", false)
        }
        if seeded { return (0, "Control plane by rule", false) }
        if asserted { return (0, "Placed in the control plane by an operator", false) }

        if let rule = RulePack.verdict(id: id, kind: kind, label: label), rule.verdict != .no {
            return (rule.tier, rule.because, rule.verdict == .depends)
        }

        guard kind == ADNodeKind.computer.rawValue else { return nil }

        let os = props["operatingsystem"]?.string?.lowercased() ?? ""
        if serverOperatingSystems.contains(where: { os.contains($0) }) {
            return (1, "Management plane: runs a server operating system", false)
        }

        if JSONValue.isTrue(props["trustedtoauth"]) {
            return (1, "Management plane: trusted to authenticate for other principals", false)
        }

        let name = label.split(separator: "@").first.map(String.init)?
            .trimmingCharacters(in: .whitespaces).uppercased() ?? ""
        for signature in managementSignatures where name.contains(signature.fragment) {
            return (1, "Management plane: the name matches \(signature.role)", true)
        }
        return nil
    }

    static func analyze(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws {
        let scope = GraphStore.scoped([], db: database)
        let fields = ["id", "kind", "label", "labelAsserted", "tierZeroSeed", "zoneAsserted",
                      "zoneRefuted", "tierAsserted"]
            + properties.map { "props.\($0)" }

        var tier: [String: Int] = [:]
        var reason: [String: String] = [:]
        var inferred: Set<String> = []
        var structure: [(id: String, kind: String)] = []

        for hit in try await elastic.scan(
            index: Indices.nodes, query: scope, source: fields, sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let kind = source["kind"]?.string ?? ""

            if [ADNodeKind.ou.rawValue, ADNodeKind.container.rawValue, ADNodeKind.gpo.rawValue]
                .contains(kind) {
                structure.append((id, kind))
            }
            let refuted = source["zoneRefuted"]?.bool == true
            let verdict = classify(
                id: id, kind: kind,
                label: GraphStore.label(source, id: id),
                props: source["props"]?.object ?? [:],
                seeded: !refuted && source["tierZeroSeed"]?.bool == true,
                asserted: !refuted && source["zoneAsserted"]?.bool == true,
                setByHand: source["tierAsserted"]?.int)
            guard let verdict else { continue }
            tier[id] = verdict.tier
            reason[id] = verdict.reason
            if verdict.inferred { inferred.insert(id) }
        }

        for (id, verdict) in try await tierStructure(
            elastic, database: database, structure: structure, tier: tier) {
            tier[id] = verdict.tier
            reason[id] = verdict.reason
        }

        let counts = Dictionary(grouping: tier.values, by: { $0 }).mapValues(\.count)
        let found = try await crossings(elastic, database: database, tier: tier)
        try await write(elastic, database: database, tier: tier, reason: reason,
                        inferred: inferred, logger: logger)
        logger?.info("""
            Zones: [\(database)] \(counts[0] ?? 0) control plane, \(counts[1] ?? 0) management plane, \
            rest data plane, \(found.count) boundary crossing(s)
            """)
    }

    private static func tierStructure(
        _ elastic: ElasticClient, database: String, structure: [(id: String, kind: String)],
        tier: [String: Int]
    ) async throws -> [String: (tier: Int, reason: String)] {
        guard !structure.isEmpty else { return [:] }
        let governs = [ADEdgeKind.contains.rawValue, ADEdgeKind.gpLink.rawValue]
        var below: [String: [String]] = [:]

        for chunk in structure.map({ $0.id }).chunked(1_000) {
            for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([
                ["terms": ["source": .strings(chunk)]],
                ["terms": ["kind": .strings(governs)]],
            ], db: database)) {
                below[edge.source, default: []].append(edge.target)
            }
        }

        var settled = tier
        var decided: [String: (tier: Int, reason: String)] = [:]
        var changed = true
        var rounds = 0
        while changed, rounds < 16 {
            changed = false
            rounds += 1
            for entry in structure {
                let lowest = (below[entry.id] ?? []).compactMap { settled[$0] }.min()
                guard let lowest, lowest < settled[entry.id] ?? defaultTier else { continue }
                settled[entry.id] = lowest
                decided[entry.id] = (lowest, entry.kind == ADNodeKind.gpo.rawValue
                    ? "Applies to a tier \(lowest) object"
                    : "Holds a tier \(lowest) object")
                changed = true
            }
        }
        return decided
    }

    struct Crossing: Sendable {

        let sort: String
        let sourceId: String
        let targetId: String
        let edge: String
        let sourceTier: Int
        let targetTier: Int
    }

    private static let residency = [ADEdgeKind.hasSession.rawValue, ADEdgeKind.dumpSMSAPassword.rawValue]

    private static let openToEveryone = [
        ADEdgeKind.kerberoastable.rawValue, ADEdgeKind.asrepRoastable.rawValue,
    ]

    static func crossings(
        _ elastic: ElasticClient, database: String, tier: [String: Int]
    ) async throws -> [Crossing] {
        let at = { (id: String) in tier[id] ?? defaultTier }

        let privileged = Array(tier.filter { $0.value < defaultTier }.keys)
        guard !privileged.isEmpty else { return [] }
        var found: [Crossing] = []

        func into(_ kinds: [String]) async throws -> [GraphStore.Edge] {
            var edges: [GraphStore.Edge] = []
            for chunk in privileged.chunked(1_000) {
                edges += try await GraphStore.edges(elastic, GraphStore.edgeScope([
                    ["terms": ["kind": .strings(kinds)]],
                    ["terms": ["target": .strings(chunk)]],

                    ["bool": ["must_not": ["term": ["unvetted": .bool(true)]]]],
                ], db: database))
            }
            return edges
        }

        for edge in try await into(TierZero.controlEdgeKinds) {
            guard at(edge.source) > at(edge.target) else { continue }
            found.append(Crossing(
                sort: "control", sourceId: edge.source, targetId: edge.target, edge: edge.kind,
                sourceTier: at(edge.source), targetTier: at(edge.target)))
        }

        for edge in try await into(residency) {
            guard at(edge.target) < at(edge.source) else { continue }
            found.append(Crossing(
                sort: "credential", sourceId: edge.source, targetId: edge.target, edge: edge.kind,
                sourceTier: at(edge.source), targetTier: at(edge.target)))
        }

        for edge in try await into(openToEveryone) {
            found.append(Crossing(
                sort: "authentication", sourceId: edge.source, targetId: edge.target, edge: edge.kind,
                sourceTier: defaultTier, targetTier: at(edge.target)))
        }

        return found.sorted {
            ($0.targetTier, -($0.sourceTier - $0.targetTier), $0.sort, $0.sourceId, $0.targetId)
                < ($1.targetTier, -($1.sourceTier - $1.targetTier), $1.sort, $1.sourceId, $1.targetId)
        }
    }

    static func tiers(_ elastic: ElasticClient, database: String) async throws -> [String: Int] {
        var tier: [String: Int] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["exists": ["field": "zoneTier"]]], db: database),
            source: ["id", "zoneTier"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  let value = source["zoneTier"]?.int else { continue }
            tier[id] = value
        }
        return tier
    }

    private static func write(
        _ elastic: ElasticClient, database: String, tier: [String: Int],
        reason: [String: String], inferred: Set<String>, logger: Logger?
    ) async throws {
        let previous = try await GraphStore.nodeIDs(elastic, GraphStore.scoped(
            [["exists": ["field": "zoneTier"]]], db: database))
        var ops = tier.map { id, value in
            ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: [
                "zoneTier": .int(value),
                "zoneTierReason": .string(reason[id] ?? ""),
                "zoneTierInferred": .bool(inferred.contains(id)),
            ])
        }
        ops += previous.subtracting(tier.keys).map { id in
            ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: [
                "zoneTier": .null, "zoneTierReason": .null, "zoneTierInferred": .bool(false),
            ])
        }
        do {
            try await elastic.bulkUpdate(ops)
        } catch {
            logger?.error("Zones: [\(database)] tier write failed: \(type(of: error)): \(error)")
            throw error
        }
        try await elastic.refresh(Indices.nodes)
    }
}

struct DelegationDTO: ResponseEncodable {
    let principal: String
    let principalLabel: String
    let principalKind: String
    let target: String
    let targetLabel: String
    let targetKind: String

    let rights: [String]

    let principalTier: Int
    let targetTier: Int

    let reaches: Int

    let crosses: Bool
}

struct DelegationReportDTO: ResponseEncodable {
    let rows: [DelegationDTO]

    let permissions: Int
    let afterBaseline: Int

    let crossing: Int
}

enum Delegation {

    static let baselinePrincipals = [
        "S-1-5-32-544",
        "-512", "-519", "-518",
        "S-1-5-18",
        "S-1-5-10",
        "S-1-3-0",
        "S-1-5-9",
        "-516",
    ]

    static func isBaseline(_ principal: String) -> Bool {
        let id = principal.uppercased()
        return baselinePrincipals.contains { id.hasSuffix($0) }
    }

    static func report(_ elastic: ElasticClient, db: String) async throws -> DelegationReportDTO {
        let controlRights = Set(Rights.control + Rights.limitedOwnership + Rights.identityWrites
            + ["AllExtendedRights", "AddMember", "WriteGPLink", "CreateChild"])

        let stamped = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["props.admincount": .string("true")]],
        ], db: db))

        var permissions = 0
        var held: [String: (rights: Set<String>, principal: String, target: String)] = [:]
        for edge in try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["terms": ["kind": .strings(Array(controlRights))]],
        ], db: db)) {
            permissions += 1
            if edge.inherited == true { continue }
            if isBaseline(edge.source) { continue }
            if stamped.contains(edge.target) { continue }

            if edge.derived { continue }
            let key = "\(edge.source)|\(edge.target)"
            held[key, default: ([], edge.source, edge.target)].rights.insert(edge.kind)
        }
        guard !held.isEmpty else {
            return DelegationReportDTO(rows: [], permissions: permissions, afterBaseline: 0,
                                       crossing: 0)
        }

        let tiers = try await Zones.tiers(elastic, database: db)
        let ends = Set(held.values.flatMap { [$0.principal, $0.target] })
        var label: [String: String] = [:]
        var kind: [String: String] = [:]
        for hit in try await elastic.fetchByIDs(
            index: Indices.nodes, ids: Array(ends),
            source: ["id", "label", "labelAsserted", "kind"], db: db) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            label[id] = GraphStore.label(source, id: id)
            kind[id] = source["kind"]?.string ?? ""
        }

        var below: [String: Int] = [:]
        for containment in try await GraphStore.edges(elastic, GraphStore.edgeScope([
            ["term": ["kind": .string(ADEdgeKind.contains.rawValue)]],
        ], db: db)) {
            below[containment.source, default: 0] += 1
        }

        var rows: [DelegationDTO] = []
        for (_, entry) in held {
            let principalTier = tiers[entry.principal] ?? Zones.defaultTier
            let targetTier = tiers[entry.target] ?? Zones.defaultTier
            rows.append(DelegationDTO(
                principal: entry.principal,
                principalLabel: label[entry.principal] ?? entry.principal,
                principalKind: kind[entry.principal] ?? "",
                target: entry.target,
                targetLabel: label[entry.target] ?? entry.target,
                targetKind: kind[entry.target] ?? "",
                rights: entry.rights.sorted(),
                principalTier: principalTier, targetTier: targetTier,
                reaches: below[entry.target] ?? 0,
                crosses: principalTier > targetTier))
        }

        rows.sort { first, second in
            if first.crosses != second.crosses { return first.crosses }
            if first.reaches != second.reaches { return first.reaches > second.reaches }
            return first.principalLabel < second.principalLabel
        }

        return DelegationReportDTO(
            rows: rows, permissions: permissions,
            afterBaseline: rows.count, crossing: rows.filter(\.crosses).count)
    }
}

import Foundation
import Logging

extension Passes {

    @discardableResult
    static func adcsEscalations(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: ADCSEscalation.everyEdge,
            ops: try await escalationEdges(elastic, database: database), logger: logger)
    }

    private static func escalationEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        let caToDomain = try await chainValidCAs(elastic, database: database)
        guard !caToDomain.isEmpty else { return [] }

        let published = try await edgesOf(elastic, database: database, kind: .publishedTo)
        let onAuthority = try await directHolders(
            elastic, database: database, of: Set(caToDomain.keys),
            kinds: ADCSEscalation.enrolment)
        let members = try await Membership(elastic, database: database)

        var ops: [ElasticClient.BulkOp] = []

        ops += try await pkiObjectEdges(
            elastic, database: database, caToDomain: caToDomain, members: members)
        for escalation in ADCSEscalation.all {
            if escalation.onAuthority {
                ops += try await authorityEdges(
                    elastic, database: database, escalation: escalation,
                    caToDomain: caToDomain, members: members)
                continue
            }

            var authorities = Set(caToDomain.keys)
            if !escalation.authority.isEmpty {
                authorities.formIntersection(try await nodeIDs(
                    elastic, database: database, kind: .enterpriseCA,
                    clauses: try GraphScript.clauses(escalation.authority)))
            }
            let templates = try await nodeIDs(
                elastic, database: database, kind: .certTemplate,
                clauses: try GraphScript.clauses(escalation.template))
            guard !authorities.isEmpty, !templates.isEmpty else { continue }

            var publishers: [String: Set<String>] = [:]
            for (template, ca) in published
            where templates.contains(template) && authorities.contains(ca) {
                publishers[template, default: []].insert(ca)
            }
            guard !publishers.isEmpty else { continue }

            let onTemplate = try await directHolders(
                elastic, database: database, of: Set(publishers.keys), groups: escalation.rights)

            var eligibleDomains: Set<String>?
            if !escalation.domain.isEmpty {
                let controllers = try await nodeIDs(
                    elastic, database: database, kind: .computer,
                    clauses: try GraphScript.clauses(escalation.domain))
                guard !controllers.isEmpty else { continue }
                let served = try await edgesOf(elastic, database: database, kind: .dcFor)
                eligibleDomains = Set(served.filter { controllers.contains($0.0) }.map { $0.1 })
                if eligibleDomains?.isEmpty ?? true { continue }
            }

            var writersOver: [String: Set<String>] = [:]
            if escalation.throughVictim {
                var enrollers: Set<String> = []
                for (_, rights) in onTemplate { for set in rights { enrollers.formUnion(set) } }

                enrollers = members.expanded(enrollers)
                if enrollers.isEmpty { continue }
                writersOver = try await directHolders(
                    elastic, database: database, of: enrollers,
                    kinds: Rights.identityAttributeWrites)
            }

            for (template, viaAuthorities) in publishers {
                guard let rights = onTemplate[template] else { continue }
                for authority in viaAuthorities {
                    let holders = members.joint(rights + [onAuthority[authority] ?? []])
                    var domains = caToDomain[authority] ?? []
                    if let eligibleDomains { domains.formIntersection(eligibleDomains) }
                    guard !domains.isEmpty else { continue }

                    if escalation.throughVictim {

                        for victim in members.expanded(holders) {
                            for writer in writersOver[victim] ?? [] where writer != victim {
                                for domain in domains {
                                    ops += edge(writer, escalation.edge, domain, database,
                                                extra: ["through": .string(victim)])
                                }
                            }
                        }
                    } else {
                        for principal in holders {
                            for domain in domains {
                                ops += edge(principal, escalation.edge, domain, database)
                            }
                        }
                    }
                }
            }
        }
        ops += try await issuancePolicyEdges(
            elastic, database: database, caToDomain: caToDomain,
            published: published, onAuthority: onAuthority, members: members)
        return ops
    }

    private static func authorityEdges(
        _ elastic: ElasticClient, database: String, escalation: ADCSEscalation,
        caToDomain: [String: Set<String>], members: Membership
    ) async throws -> [ElasticClient.BulkOp] {
        var authorities = Set(caToDomain.keys)
        if !escalation.authority.isEmpty {
            authorities.formIntersection(try await nodeIDs(
                elastic, database: database, kind: .enterpriseCA,
                clauses: try GraphScript.clauses(escalation.authority)))
        }
        guard !authorities.isEmpty else { return [] }
        let held = try await directHolders(
            elastic, database: database, of: authorities, groups: escalation.rights)
        var ops: [ElasticClient.BulkOp] = []
        for (authority, rights) in held {
            for principal in members.joint(rights) {
                for domain in caToDomain[authority] ?? [] {
                    ops += edge(principal, escalation.edge, domain, database)
                }
            }
        }
        return ops
    }

    private static func pkiObjectEdges(
        _ elastic: ElasticClient, database: String, caToDomain: [String: Set<String>],
        members: Membership
    ) async throws -> [ElasticClient.BulkOp] {
        let escalation = ADCSEscalation.esc5
        var ops: [ElasticClient.BulkOp] = []

        for (machine, authority) in try await edgesOf(elastic, database: database, kind: .hostsCAService) {
            guard let domains = caToDomain[authority] else { continue }
            for holder in try await directHolders(
                elastic, database: database, of: [machine], kinds: Rights.control)[machine] ?? [] {
                for domain in domains {
                    ops += edge(holder, escalation.edge, domain, database, extra: [
                        "through": .string(machine),
                        "note": .string("Controls the machine hosting the authority, which holds its private key"),
                    ])
                }
            }
        }

        let everyDomain = Set(caToDomain.values.flatMap { $0 })
        guard !everyDomain.isEmpty else { return ops }
        let supporting = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["terms": ["kind": .strings(ADCSEscalation.pkiSupport.map(\.rawValue))]],
        ], db: database))
        guard !supporting.isEmpty else { return ops }

        let held = try await directHolders(
            elastic, database: database, of: supporting, groups: escalation.rights)
        for (object, rights) in held {
            for principal in members.joint(rights) {
                for domain in everyDomain {
                    ops += edge(principal, escalation.edge, domain, database, extra: [
                        "through": .string(object),
                        "note": .string("Controls a certificate object the whole chain depends on"),
                    ])
                }
            }
        }
        return ops
    }

    private static func issuancePolicyEdges(
        _ elastic: ElasticClient, database: String, caToDomain: [String: Set<String>],
        published: [(String, String)], onAuthority: [String: Set<String>], members: Membership
    ) async throws -> [ElasticClient.BulkOp] {
        let escalation = ADCSEscalation.esc13

        var conferred: [String: Set<String>] = [:]
        for (policy, group) in try await edgesOf(elastic, database: database, kind: .oidGroupLink) {
            conferred[policy, default: []].insert(group)
        }
        guard !conferred.isEmpty else { return [] }
        var embeds: [String: Set<String>] = [:]
        for (template, policy) in try await edgesOf(elastic, database: database, kind: .extendedByPolicy)
        where conferred[policy] != nil {
            embeds[template, default: []].insert(policy)
        }
        guard !embeds.isEmpty else { return [] }

        let templates = try await nodeIDs(
            elastic, database: database, kind: .certTemplate,
            clauses: try GraphScript.clauses(escalation.template))
        let authorities = Set(caToDomain.keys)
        var publishers: [String: Set<String>] = [:]
        for (template, ca) in published
        where templates.contains(template) && authorities.contains(ca) && embeds[template] != nil {
            publishers[template, default: []].insert(ca)
        }
        guard !publishers.isEmpty else { return [] }
        let onTemplate = try await directHolders(
            elastic, database: database, of: Set(publishers.keys), groups: escalation.rights)

        var ops: [ElasticClient.BulkOp] = []
        for (template, viaAuthorities) in publishers {
            guard let rights = onTemplate[template] else { continue }
            let groups = (embeds[template] ?? []).flatMap { conferred[$0] ?? [] }
            for authority in viaAuthorities {
                for principal in members.joint(rights + [onAuthority[authority] ?? []]) {
                    for group in groups {
                        ops += edge(principal, escalation.edge, group, database)
                    }
                }
            }
        }
        return ops
    }

    @discardableResult
    static func issuancePolicyLinks(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.extendedByPolicy],
            ops: try await policyLinks(elastic, database: database), logger: logger)
    }

    private static func policyLinks(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        var policyByOID: [String: [String]] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped(
                [["term": ["kind": .string(ADNodeKind.issuancePolicy.rawValue)]]], db: database),
            source: ["id", "props.certtemplateoid", "props.oid", "props.msds-oidtogrouplink"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            for oid in (strings(props["certtemplateoid"]) + strings(props["oid"])).map(normalise)
            where !oid.isEmpty {
                policyByOID[oid, default: []].append(id)
            }
        }
        guard !policyByOID.isEmpty else { return [] }

        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped(
                [["term": ["kind": .string(ADNodeKind.certTemplate.rawValue)]]], db: database),
            source: ["id", "props.certificatepolicy", "props.certificatepolicyoid"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            let oids = (strings(props["certificatepolicy"]) + strings(props["certificatepolicyoid"]))
                .map(normalise)
            for oid in oids {
                for policy in policyByOID[oid] ?? [] {
                    ops += edge(id, .extendedByPolicy, policy, database)
                }
            }
        }
        return ops
    }

    @discardableResult
    static func builtinRights(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {

        let every = WellKnown.controllerRights.map { $0.edge }
            + WellKnown.controllerRightsByName.map { $0.edge }
        var kinds: [ADEdgeKind] = []
        for kind in every.sorted(by: { $0.rawValue < $1.rawValue }) where !kinds.contains(kind) {
            kinds.append(kind)
        }
        return try await reconcileDerived(
            elastic, database: database, kinds: kinds,
            ops: try await controllerRightEdges(elastic, database: database), logger: logger)
    }

    private static func controllerRightEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        var controllers: [String: Set<String>] = [:]
        for (computer, domain) in try await edgesOf(elastic, database: database, kind: .dcFor) {
            controllers[domain, default: []].insert(computer)
        }
        guard !controllers.isEmpty else { return [] }

        let readOnly = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["kind": .string(ADNodeKind.computer.rawValue)]],
            ["term": ["props.isreadonlydc": .string("true")]],
        ], db: database))

        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.group.rawValue)]]],
                                     db: database),
            source: ["id", "label", "props.name", "props.domainsid"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            let normalizedId = id.trimmingCharacters(in: .whitespaces).uppercased()
            let label = props["name"]?.string ?? source["label"]?.string ?? ""
            let name = label.split(separator: "@").first.map(String.init)?
                .trimmingCharacters(in: .whitespaces).uppercased() ?? ""

            var confers: [ADEdgeKind] = WellKnown.controllerRights
                .filter { normalizedId.hasSuffix($0.suffix) }.map { $0.edge }
            confers += WellKnown.controllerRightsByName.filter { $0.name == name }.map { $0.edge }
            guard !confers.isEmpty else { continue }

            let owning = props["domainsid"]?.string.flatMap { $0.isEmpty ? nil : $0 }
            let targets = owning.flatMap { controllers[$0] }
                ?? (controllers.count == 1 ? Set(controllers.values.joined()) : [])
            for edgeKind in confers {
                for controller in targets {
                    if edgeKind == .seBackupPrivilege, readOnly.contains(controller) { continue }
                    ops += edge(id, edgeKind, controller, database)
                }
            }
        }
        return ops
    }

    @discardableResult
    static func roastable(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.kerberoastable, .asrepRoastable],
            ops: try await roastableEdges(elastic, database: database), logger: logger)
    }

    private static let managedFlags = ["gmsa", "isgmsa", "msa", "ismsa", "dmsa", "isdmsa"]

    private static func roastableEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        let authenticated = try await wellKnownHubs(
            elastic, database: database, suffix: WellKnown.authenticatedUsers)
        let everyone = try await wellKnownHubs(
            elastic, database: database, suffix: WellKnown.everyone)

        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["term": ["kind": .string(ADNodeKind.user.rawValue)]],
            ], db: database),
            source: ["id", "label", "props.enabled", "props.hasspn", "props.serviceprincipalnames",
                     "props.dontreqpreauth", "props.pwdlastset", "props.whencreated",
                     "props.domainsid",
                     "props.supportedencryptiontypes"] + managedFlags.map { "props.\($0)" },
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]

            if let enabled = props["enabled"], !JSONValue.isTrue(enabled) { continue }

            guard !id.trimmingCharacters(in: .whitespaces).uppercased().hasSuffix("-502") else { continue }
            if managedFlags.contains(where: { JSONValue.isTrue(props[$0]) }) { continue }

            var extra: [String: JSONValue] = [:]
            if let age = passwordAge(props) { extra["passwordAgeDays"] = .int(age) }

            if let types = number(props["supportedencryptiontypes"]) {
                extra["aesOnly"] = .bool(types & 0x18 != 0 && types & 0x7 == 0)
            }

            let domain = props["domainsid"]?.string ?? ""
            let hasSPN = JSONValue.isTrue(props["hasspn"])
                || !strings(props["serviceprincipalnames"]).isEmpty
            if hasSPN, let hub = authenticated[domain] {
                ops += edge(hub, .kerberoastable, id, database, extra: extra)
            }
            if JSONValue.isTrue(props["dontreqpreauth"]), let hub = everyone[domain] {
                ops += edge(hub, .asrepRoastable, id, database, extra: extra)
            }
        }
        return ops
    }

    private static func passwordAge(_ props: [String: JSONValue]) -> Int? {
        let stamp = number(props["pwdlastset"]) ?? number(props["whencreated"])

        guard let stamp, stamp > 0, stamp < 4_000_000_000 else { return nil }
        let days = (Int(Date().timeIntervalSince1970) - stamp) / 86_400
        return days >= 0 ? days : nil
    }

    @discardableResult
    static func ticketPrimitives(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {
        try await reconcileDerived(
            elastic, database: database, kinds: [.coerceToTGT, .goldenCert],

            ops: try await coercionEdges(elastic, database: database)
                + goldenCertEdges(elastic, database: database),
            logger: logger)
    }

    private static func coercionEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["terms": ["kind": .strings([ADNodeKind.computer.rawValue, ADNodeKind.user.rawValue])]],
                ["term": ["props.unconstraineddelegation": .string("true")]],
            ], db: database),
            source: ["id", "kind", "props.isdc", "props.domainsid", "props.enabled"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]

            guard !JSONValue.isTrue(props["isdc"]) else { continue }
            if let enabled = props["enabled"], !JSONValue.isTrue(enabled) { continue }
            guard let domain = props["domainsid"]?.string, !domain.isEmpty else { continue }
            ops += edge(id, .coerceToTGT, domain, database)
        }
        return ops
    }

    private static func goldenCertEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let caToDomain = try await chainValidCAs(elastic, database: database)
        guard !caToDomain.isEmpty else { return [] }
        var ops: [ElasticClient.BulkOp] = []
        for (host, authority) in try await edgesOf(elastic, database: database, kind: .hostsCAService) {
            for domain in caToDomain[authority] ?? [] {
                ops += edge(host, .goldenCert, domain, database)
            }
        }
        return ops
    }

    @discardableResult
    static func trustAbuse(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws -> Int {

        var unfiltered: [String: Set<String>] = [:]
        var delegable: [String: Set<String>] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.domain.rawValue)]]],
                                     db: database),
            source: ["id", "props.sidfilteringofffor", "props.tgtdelegationfor"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            unfiltered[id] = Set(strings(props["sidfilteringofffor"]))
            delegable[id] = Set(strings(props["tgtdelegationfor"]))
        }

        var ops: [ElasticClient.BulkOp] = []
        for trust in try await GraphStore.edges(elastic, GraphStore.edgeScope(
            [["term": ["kind": .string(ADEdgeKind.crossForestTrust.rawValue)]]], db: database)) {

            if unfiltered[trust.target]?.contains(trust.source) == true {
                ops += edge(trust.source, .spoofSIDHistory, trust.target, database)
            }
            if delegable[trust.target]?.contains(trust.source) == true {
                ops += edge(trust.source, .abuseTGTDelegation, trust.target, database)
            }
        }
        return try await reconcileDerived(
            elastic, database: database, kinds: [.spoofSIDHistory, .abuseTGTDelegation],
            ops: ops, logger: logger)
    }

    static func chainValidCAs(
        _ elastic: ElasticClient, database: String
    ) async throws -> [String: Set<String>] {

        let trusts = try await edgesOf(elastic, database: database,
                                       kind: .trustedForNTAuth)
        let storeFor = try await edgesOf(elastic, database: database,
                                         kind: .ntAuthStoreFor)
        let signedBy = try await edgesOf(elastic, database: database,
                                         kind: .issuedSignedBy)
        let rootFor = try await edgesOf(elastic, database: database,
                                        kind: .rootCAFor)

        var storeDomains: [String: Set<String>] = [:]
        for (store, domain) in storeFor { storeDomains[store, default: []].insert(domain) }

        var rootDomains: [String: Set<String>] = [:]
        for (root, domain) in rootFor { rootDomains[root, default: []].insert(domain) }

        var signer: [String: String] = [:]
        for (ca, up) in signedBy { signer[ca] = up }
        func chainDomains(_ ca: String) -> Set<String> {
            var out: Set<String> = [], seen: Set<String> = [], node = ca
            while true {
                out.formUnion(rootDomains[node] ?? [])
                guard let up = signer[node], !seen.contains(node) else { break }
                seen.insert(node); node = up
            }
            return out
        }

        var valid: [String: Set<String>] = [:]
        for (ca, store) in trusts {
            let ntAuthDomains = storeDomains[store] ?? []
            let reachable = ntAuthDomains.intersection(chainDomains(ca))
            if !reachable.isEmpty { valid[ca, default: []].formUnion(reachable) }
        }
        return valid
    }

    static func number(_ value: JSONValue?) -> Int? {
        if let int = value?.int { return int }
        if let text = value?.string {
            if let exact = Int(text) { return exact }

            if let approximate = Double(text) { return Int(exactly: approximate.rounded()) }
        }
        return nil
    }
}

extension Passes {
    static func modernPaths(
        _ elastic: ElasticClient, database: String, logger: Logger? = nil
    ) async throws {
        try await reconcileDerived(
            elastic, database: database,
            kinds: [.badSuccessor, .rodcKeyRecovery, .coerceAndRelayToADCS, .coerceAndRelayToLDAP,
                    .coerceAndRelayToSMB, .sccmManages, .sccmSiteTakeover,
                    .syncedToEntraUser, .syncedToADUser],
            ops: try await badSuccessorEdges(elastic, database: database)
                + rodcEdges(elastic, database: database)
                + relayEdges(elastic, database: database)
                + sccmEdges(elastic, database: database)
                + hybridEdges(elastic, database: database),
            logger: logger)
    }

    private static func badSuccessorEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {

        var supported = try await nodeIDs(
            elastic, database: database, kind: .domain,

            clauses: [["terms": ["props.functionallevel": .strings(
                ["2025", "10", "Windows Server 2025"])]]])
        for (_, domain) in try await domainOf(elastic, database: database, clauses: [
            ["bool": ["should": [
                .object(["term": .object(["kind": .string(ADNodeKind.dmsa.rawValue)])]),
                .object(["exists": .object(["field": .string("props.msds-delegatedmsastate")])]),
            ], "minimum_should_match": 1]],
        ]) {
            supported.insert(domain)
        }
        guard !supported.isEmpty else { return [] }

        let containerDomain = try await domainOf(elastic, database: database, clauses: [
            ["terms": ["kind": .strings(ADNodeKind.having(.container).map(\.rawValue))]],
        ]).filter { supported.contains($0.value) }
        guard !containerDomain.isEmpty else { return [] }
        let holders = try await directHolders(
            elastic, database: database, of: Set(containerDomain.keys),
            kinds: ["CreateChild", "AddAllowedToAct", "GenericAll", "GenericWrite"])

        var ops: [ElasticClient.BulkOp] = []
        for (container, principals) in holders {

            guard let domain = containerDomain[container] else { continue }
            for principal in principals.sorted() {
                ops += edge(principal, .badSuccessor, domain, database, extra: [
                    "through": .string(container),
                    "note": .string("Can create a delegated managed service account in this container"),
                ])
            }
        }
        return ops
    }

    private static func rodcEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        var ops: [ElasticClient.BulkOp] = []
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["bool": ["should": [
                    .object(["term": .object(["kind": .string(ADNodeKind.rodc.rawValue)])]),
                    .object(["exists": .object(["field": .string("props.msds-revealondemandgroup")])]),
                ], "minimum_should_match": 1]],
            ], db: database),
            source: ["id", "props.msds-revealondemandgroup", "props.msds-neverrevealgroup"],
            sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            let props = source["props"]?.object ?? [:]
            let reveal = strings(props["msds-revealondemandgroup"]).map(normalise)
            let never = Set(strings(props["msds-neverrevealgroup"]).map(normalise))
            for group in reveal where !never.contains(group) {
                ops += edge(id, .rodcKeyRecovery, group, database, extra: [
                    "note": .string("This controller may cache the secrets of everything in the reveal set"),
                ])
            }
        }
        return ops
    }

    private static func relayEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        var ops: [ElasticClient.BulkOp] = []

        let hubs = try await wellKnownHubs(
            elastic, database: database, suffix: WellKnown.authenticatedUsers)
        guard !hubs.isEmpty else { return [] }

        let caToDomain = try await chainValidCAs(elastic, database: database)
        let webEnrolment = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["kind": .string(ADNodeKind.enterpriseCA.rawValue)]],
            ["term": ["props.hasvulnerableendpoint": .string("true")]],
        ], db: database))
        var adcsDomains: Set<String> = []
        for authority in webEnrolment { adcsDomains.formUnion(caToDomain[authority] ?? []) }
        for domain in adcsDomains.sorted() {
            guard let hub = hubs[domain] else { continue }
            ops += edge(hub, .coerceAndRelayToADCS, domain, database, extra: [
                "note": .string("An enrolment endpoint accepts relayed authentication (ESC8)"),
            ])
        }

        var controllerDomain: [String: String] = [:]
        for (computer, domain) in try await edgesOf(elastic, database: database, kind: .dcFor) {
            controllerDomain[computer] = domain
        }
        let unsignedLDAP = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["term": ["kind": .string(ADNodeKind.computer.rawValue)]],
            ["term": ["props.isdc": .string("true")]],
            ["term": ["props.ldapsigning": .string("false")]],
        ], db: database))
        var ldapDomains: Set<String> = []
        for controller in unsignedLDAP { ldapDomains.formUnion(controllerDomain[controller].map { [$0] } ?? []) }
        for domain in ldapDomains.sorted() {
            guard let hub = hubs[domain] else { continue }
            ops += edge(hub, .coerceAndRelayToLDAP, domain, database, extra: [
                "note": .string("A controller accepts unsigned directory binds"),
            ])
        }

        for (host, domain) in (try await domainOf(elastic, database: database, clauses: [
            ["term": ["kind": .string(ADNodeKind.computer.rawValue)]],
            ["term": ["props.smbsigning": .string("false")]],
        ])).sorted(by: { $0.key < $1.key }) {
            guard let hub = hubs[domain] else { continue }
            ops += edge(hub, .coerceAndRelayToSMB, host, database, extra: [
                "note": .string("This host does not require message signing"),
            ])
        }
        return ops
    }

    private static func sccmEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let points = try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["terms": ["kind": .strings([ADNodeKind.sccmManagementPoint.rawValue,
                                             ADNodeKind.sccmSite.rawValue])]],
            ], db: database),
            source: ["id", "kind", "props.dnshostname", "props.mssmssitecode"],
            sort: GraphStore.nodeOrder)
        guard !points.isEmpty else { return [] }

        var byHost: [String: String] = [:]
        for hit in try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([["term": ["kind": .string(ADNodeKind.computer.rawValue)]]], db: database),
            source: ["id", "label", "props.dnshostname"], sort: GraphStore.nodeOrder) {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            if let host = source["props"]?["dnshostname"]?.string { byHost[normalise(host)] = id }
            if let label = source["label"]?.string { byHost[normalise(label)] = id }
        }

        var ops: [ElasticClient.BulkOp] = []
        for hit in points {
            guard let source = hit["_source"], let id = source["id"]?.string else { continue }
            guard let host = source["props"]?["dnshostname"]?.string,
                  let machine = byHost[normalise(host)] else { continue }

            ops += edge(id, .sccmManages, machine, database)

            for holder in try await directHolders(
                elastic, database: database, of: [id], kinds: Rights.control)[id] ?? [] {
                ops += edge(holder, .sccmSiteTakeover, machine, database, extra: [
                    "note": .string("Controls the published management point, which is where clients are told to go"),
                ])
            }
        }
        return ops
    }

    private static func hybridEdges(
        _ elastic: ElasticClient, database: String
    ) async throws -> [ElasticClient.BulkOp] {
        let cloud = try await elastic.scan(
            index: Indices.nodes,
            query: GraphStore.scoped([
                ["term": ["kind": .string(ADNodeKind.entraUser.rawValue)]],
            ], db: database),
            source: ["id", "props.onpremisesecurityidentifier"], sort: GraphStore.nodeOrder)
        guard !cloud.isEmpty else { return [] }

        let onPrem = try await GraphStore.nodeIDs(elastic, GraphStore.scoped([
            ["terms": ["kind": .strings([ADNodeKind.user.rawValue, ADNodeKind.computer.rawValue])]],
        ], db: database))

        var ops: [ElasticClient.BulkOp] = []
        for hit in cloud {
            guard let source = hit["_source"], let id = source["id"]?.string,
                  let sid = source["props"]?["onpremisesecurityidentifier"]?.string,
                  !sid.isEmpty else { continue }
            let wanted = normalise(sid)
            guard let local = onPrem.first(where: { normalise($0) == wanted }) else { continue }

            ops += edge(local, .syncedToEntraUser, id, database)
            ops += edge(id, .syncedToADUser, local, database)
        }
        return ops
    }
}

enum BloodHoundImport {

    struct Envelope: Sendable {
        let type: String
        let declared: Int?

        let version: Int?
        let methods: Int?
    }

    static func envelope(of json: JSONValue) -> Envelope? {
        guard let meta = json["meta"], let type = meta["type"]?.string else { return nil }

        return Envelope(type: type, declared: meta["count"]?.int.map { min(max($0, 0), Int(Int32.max)) },
                        version: meta["version"]?.int, methods: meta["methods"]?.int)
    }

    static func recognize(json: JSONValue) -> String? { envelope(of: json)?.type }

    struct Parsed: Sendable {
        let nodes: [ElasticClient.BulkOp]
        let edges: [ElasticClient.BulkOp]
        let declared: Int?
        let present: Int

        let skipped: Int

        let merged: Int

        let edgesFolded: Int

        let unresolvedLocalGroups: Int

        let rejectedRights: Int

        let unknownRights: Int

        let domain: String?
    }

    static func parse(
        kind: ADNodeKind, json: JSONValue, database: String, declared: Int?
    ) -> Parsed {
        guard let data = json["data"]?.array else {
            return Parsed(nodes: [], edges: [], declared: declared,
                          present: 0, skipped: 0, merged: 0, edgesFolded: 0,
                          unresolvedLocalGroups: 0, rejectedRights: 0, unknownRights: 0,
                          domain: nil)
        }

        var order: [String] = []
        var docs: [String: [String: JSONValue]] = [:]

        var edgeOrder: [String] = []
        var edgeDocs: [String: [String: JSONValue]] = [:]
        var edgesFolded = 0
        var skipped = 0
        var merged = 0
        var unresolved = 0
        var rights = RightsTally()

        for object in data {

            guard let id = object["ObjectIdentifier"]?.string, !id.isEmpty else {
                skipped += 1
                continue
            }
            let props = Self.enrich(object["Properties"]?.object ?? [:], kind: kind, object: object)
            let doc: [String: JSONValue] = [
                "id": .string(id),
                "db": .string(database),
                "kind": .string(kind.rawValue),
                "label": .string(props["name"]?.string ?? id),
                "props": .object(props),
            ]
            if let existing = docs[id] {
                docs[id] = Self.fold(existing, doc)
                merged += 1
            } else {
                order.append(id)
                docs[id] = doc
            }

            for op in Self.edges(kind: kind, id: id, object: object,
                                 database: database, unresolved: &unresolved, rights: &rights) {
                if edgeDocs[op.id] == nil {
                    edgeOrder.append(op.id)
                    edgeDocs[op.id] = op.doc
                } else {
                    edgesFolded += 1
                }
            }
        }

        let nodes = order.compactMap { id in
            docs[id].map { ElasticClient.BulkOp(index: Indices.nodes, id: "\(database)|\(id)", doc: $0) }
        }
        let edges = edgeOrder.compactMap { id in
            edgeDocs[id].map { ElasticClient.BulkOp(index: Indices.edges, id: id, doc: $0) }
        }
        return Parsed(nodes: nodes, edges: edges, declared: declared,
                      present: data.count, skipped: skipped, merged: merged,
                      edgesFolded: edgesFolded, unresolvedLocalGroups: unresolved,
                      rejectedRights: rights.rejected, unknownRights: rights.unknown,
                      domain: order.lazy.compactMap { docs[$0]?["props"]?["domain"]?.string }
                          .first { !$0.isEmpty })
    }

    struct RightsTally { var rejected = 0; var unknown = 0 }

    static let collectedRights: Set<String> = [
        "GenericAll", "GenericWrite", "WriteDacl", "WriteOwner", "Owns",

        "OwnsLimitedRights", "WriteOwnerLimitedRights",
        "AllExtendedRights", "ForceChangePassword", "AddMember", "AddSelf",
        "AddKeyCredentialLink", "WriteSPN", "AddAllowedToAct", "WriteAccountRestrictions",

        "WriteAltSecurityIdentities", "WritePublicInformation",
        "ReadLAPSPassword", "ReadGMSAPassword",
        "GetChanges", "GetChangesAll", "GetChangesInFilteredSet",
        "WriteGPLink", "Enroll", "AutoEnroll", "ManageCA", "ManageCertificates",
        "WritePKIEnrollmentFlag", "WritePKINameFlag",
    ]

    static let rawRightAliases: [String: String] = [
        "OwnsRaw": "Owns", "WriteOwnerRaw": "WriteOwner",
    ]

    static let composedKinds: Set<String> = Set(
        ([ADEdgeKind.dcSync, .trustedForNTAuth, .issuedSignedBy, .extendedByPolicy,
          .kerberoastable, .asrepRoastable, .coerceToTGT, .goldenCert,
          .spoofSIDHistory, .abuseTGTDelegation,
          .seBackupPrivilege, .seLoadDriverPrivilege, .serviceControl, .dnsServerControl,

          .hasTrustKeys, .protectAdminGroups, .propagatesACEsTo, .gpoAppliesTo,
          .claimSpecialIdentity, .syncLAPSPassword, .badSuccessor, .rodcKeyRecovery,
          .coerceAndRelayToADCS, .coerceAndRelayToLDAP, .coerceAndRelayToSMB,
          .sccmSiteTakeover, .sccmManages, .syncedToEntraUser, .syncedToADUser]
         + ADCSEscalation.everyEdge).map(\.rawValue))

    private static func fold(
        _ a: [String: JSONValue], _ b: [String: JSONValue]
    ) -> [String: JSONValue] {
        let aProps = a["props"]?.object ?? [:]
        let bProps = b["props"]?.object ?? [:]
        let aIsRicher = aProps.count >= bProps.count
        var out = aIsRicher ? a : b
        var props = aIsRicher ? aProps : bProps
        for (key, value) in (aIsRicher ? bProps : aProps) where props[key] == nil {
            props[key] = value
        }
        out["props"] = .object(props)

        if let name = props["name"]?.string, !name.isEmpty { out["label"] = .string(name) }
        return out
    }

    private static func enrich(
        _ props: [String: JSONValue], kind: ADNodeKind, object: JSONValue
    ) -> [String: JSONValue] {
        var merged = props
        if kind == .enterpriseCA,
           let flag = object["CARegistryData"]?["IsUserSpecifiesSanEnabled"],
           flag["Collected"]?.bool == true {
            merged["isuserspecifiessanenabled"] = .bool(flag["Value"]?.bool ?? false)
        }

        if kind == .domain {
            var unfiltered: [String] = []
            var delegable: [String] = []
            for trust in object["Trusts"]?.array ?? [] {
                guard let peer = trust["TargetDomainSid"]?.string, !peer.isEmpty else { continue }
                let direction = trustDirection(trust["TrustDirection"])
                guard direction == "Outbound" || direction == "Bidirectional" else { continue }
                if let filtering = trust["SidFilteringEnabled"], filtering != .null,
                   !JSONValue.isTrue(filtering) {
                    unfiltered.append(peer)
                }
                if JSONValue.isTrue(trust["TGTDelegationEnabled"]) { delegable.append(peer) }
            }
            if !unfiltered.isEmpty { merged["sidfilteringofffor"] = .strings(unfiltered) }
            if !delegable.isEmpty { merged["tgtdelegationfor"] = .strings(delegable) }
        }

        if kind == .computer, let registry = object["DCRegistryData"] {
            for (key, name) in [("StrongCertificateBindingEnforcement", "strongcertificatebindingenforcement"),
                                ("CertificateMappingMethods", "certificatemappingmethods")] {
                guard let value = registry[key], value["Collected"]?.bool == true,
                      let number = value["Value"]?.int else { continue }
                merged[name] = .int(number)
            }
        }
        return merged
    }

    private static func edges(
        kind: ADNodeKind, id: String, object: JSONValue, database: String,
        unresolved: inout Int, rights: inout RightsTally
    ) -> [ElasticClient.BulkOp] {
        var out = aceEdges(targetId: id, object: object, database: database, rights: &rights)
        out += containmentEdge(objectId: id, object: object, database: database)

        switch kind {
        case .group:
            out += inboundListEdges(targetId: id, object: object, key: "Members",
                                    edgeKind: .memberOf, database: database)
            out += sidHistoryEdges(sourceId: id, object: object, database: database)

        case .computer, .rodc:
            out += primaryGroupEdge(sourceId: id, object: object, database: database)
            let groups = localGroupIndex(object)
            out += localGroupEdges(computerId: id, object: object, groups: groups,
                                   database: database, unresolved: &unresolved)
            out += sessionEdges(computerId: id, object: object, database: database)
            out += userRightEdges(computerId: id, object: object, groups: groups,
                                  database: database, unresolved: &unresolved)
            out += domainRoleEdge(sourceId: id, object: object, kind: .dcFor,
                                  when: JSONValue.isTrue(object["Properties"]?["isdc"]), database: database)
            out += sidHistoryEdges(sourceId: id, object: object, database: database)

            out += inboundListEdges(targetId: id, object: object, key: "AllowedToAct",
                                    edgeKind: .allowedToAct, database: database)
            out += outboundListEdges(sourceId: id, object: object, key: "AllowedToDelegate",
                                     edgeKind: .allowedToDelegate, database: database)
            out += outboundListEdges(sourceId: id, object: object, key: "DumpSMSAPassword",
                                     edgeKind: .dumpSMSAPassword, database: database)

        case .user, .dmsa:
            out += primaryGroupEdge(sourceId: id, object: object, database: database)
            out += sidHistoryEdges(sourceId: id, object: object, database: database)
            out += outboundListEdges(sourceId: id, object: object, key: "AllowedToDelegate",
                                     edgeKind: .allowedToDelegate, database: database)
        case .ntAuthStore:
            out += domainRoleEdge(sourceId: id, object: object, kind: .ntAuthStoreFor,
                                  when: true, database: database)
        case .rootCA:
            out += domainRoleEdge(sourceId: id, object: object, kind: .rootCAFor,
                                  when: true, database: database)
        case .domain:
            out += trustEdges(domainId: id, object: object, database: database)
            out += gpLinkEdges(targetId: id, object: object, database: database)
            out += policyEffectEdges(object: object, database: database)
        case .ou:
            out += gpLinkEdges(targetId: id, object: object, database: database)
            out += policyEffectEdges(object: object, database: database)
        case .enterpriseCA:

            out += inboundListEdges(targetId: id, object: object,
                                    key: "EnabledCertTemplates", edgeKind: .publishedTo,
                                    database: database)
            if let host = object["HostingComputer"]?.string, !host.isEmpty,
               let hosts = edgeOp(source: host, target: id,
                                  kind: ADEdgeKind.hostsCAService.rawValue, database: database) {
                out += [hosts]
            }
            out += domainRoleEdge(sourceId: id, object: object, kind: .enterpriseCAFor,
                                  when: true, database: database)
            out += enrollmentAgentEdges(object: object, database: database)
        case .issuancePolicy:

            out += groupLinkEdge(policyId: id, object: object, database: database)
        case .gpo, .container, .certTemplate, .aiaCA, .base:
            break
        case .sccmSite, .sccmManagementPoint:

            break
        case .entraUser, .entraGroup, .entraRole, .entraTenant:

            break
        }
        return out
    }

    private static func containmentEdge(
        objectId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        guard let parent = object["ContainedBy"]?["ObjectIdentifier"]?.string,
              !parent.isEmpty else { return [] }
        var extra: [String: JSONValue] = [:]
        if JSONValue.isTrue(object["Properties"]?["blocksinheritance"]) { extra["blocked"] = .bool(true) }
        return [edgeOp(source: parent, target: objectId,
                       kind: ADEdgeKind.contains.rawValue, database: database,
                       extra: extra)].compactMap { $0 }
    }

    private static func gpLinkEdges(
        targetId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        (object["Links"]?.array ?? []).compactMap { link in
            guard let gpo = link["GUID"]?.string, !gpo.isEmpty else { return nil }

            let enforced = JSONValue.isTrue(link["IsEnforced"])
            return edgeOp(source: gpo, target: targetId,
                          kind: ADEdgeKind.gpLink.rawValue, database: database,
                          extra: enforced ? ["enforced": .bool(true)] : [:])
        }
    }

    private static let sameForestTrustTypes: Set<String> = ["ParentChild", "CrossLink", "TreeRoot"]

    private static func trustDirection(_ value: JSONValue?) -> String? {
        let known = ["Disabled", "Inbound", "Outbound", "Bidirectional"]
        if let name = value?.string {
            if known.contains(name) { return name }
            if let code = Int(name) { return namedDirection(code: code) }
            return nil
        }
        if let code = value?.int { return namedDirection(code: code) }
        return nil
    }

    private static func namedDirection(code: Int) -> String? {
        switch code {
        case 0: return "Disabled"
        case 1: return "Inbound"
        case 2: return "Outbound"
        case 3: return "Bidirectional"
        default: return nil
        }
    }

    private static func trustEdges(
        domainId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        (object["Trusts"]?.array ?? []).flatMap { trust -> [ElasticClient.BulkOp] in
            guard let target = trust["TargetDomainSid"]?.string, !target.isEmpty else { return [] }
            let kind = sameForestTrustTypes.contains(trust["TrustType"]?.string ?? "")
                ? ADEdgeKind.sameForestTrust : ADEdgeKind.crossForestTrust
            let direction = trustDirection(trust["TrustDirection"])

            var settings: [String: JSONValue] = [:]

            settings["peer"] = .string(target)
            if let name = trust["TargetDomainName"]?.string, !name.isEmpty {
                settings["peerName"] = .string(name)
            }

            var out: [ElasticClient.BulkOp] = []
            if direction == "Bidirectional" || direction == "Inbound",
               let edge = edgeOp(source: domainId, target: target,
                                 kind: kind.rawValue, database: database, extra: settings) {
                out.append(edge)
            }
            if direction == "Bidirectional" || direction == "Outbound",
               let edge = edgeOp(source: target, target: domainId,
                                 kind: kind.rawValue, database: database, extra: settings) {
                out.append(edge)
            }
            return out
        }
    }

    private static let localGroupRights: [(suffix: String, kind: ADEdgeKind)] = [
        ("-544", .adminTo),
        ("-555", .canRDP),
        ("-562", .executeDCOM),
        ("-580", .canPSRemote),
    ]

    private static func localGroupEdges(
        computerId: String, object: JSONValue, groups: [String: [JSONValue]],
        database: String, unresolved: inout Int
    ) -> [ElasticClient.BulkOp] {
        var out: [ElasticClient.BulkOp] = []

        var walks: [String: Flattening] = [:]
        for group in object["LocalGroups"]?.array ?? [] {
            let groupId = group["ObjectIdentifier"]?.string ?? ""
            guard let right = localGroupRights.first(where: { groupId.hasSuffix($0.suffix) })
            else { continue }
            var walk = walks[right.kind.rawValue] ?? Flattening()
            if walk.visited.insert(groupId).inserted {
                let members = flatten(group["Results"]?.array ?? [], through: groups,
                                      walk: &walk, unresolved: &unresolved)
                out += members.compactMap {
                    edgeOp(source: $0, target: computerId, kind: right.kind.rawValue, database: database)
                }
            }
            walks[right.kind.rawValue] = walk
        }
        return out
    }

    private static func localGroupIndex(_ object: JSONValue) -> [String: [JSONValue]] {
        var index: [String: [JSONValue]] = [:]
        for group in object["LocalGroups"]?.array ?? [] {
            guard let id = group["ObjectIdentifier"]?.string, !id.isEmpty else { continue }
            index[id] = group["Results"]?.array ?? []
        }
        return index
    }

    private static func flatten(
        _ members: [JSONValue], through index: [String: [JSONValue]],
        walk: inout Flattening, unresolved: inout Int
    ) -> [String] {
        var out: [String] = []
        var pending = Array(members.reversed())
        while let member = pending.popLast() {
            guard let sid = identifier(of: member), !sid.isEmpty else { continue }
            let named = member["ObjectType"]?.string == "LocalGroup"
            guard named || index[sid] != nil else {
                if walk.emitted.insert(sid).inserted { out.append(sid) }
                continue
            }
            guard let nested = index[sid] else {

                unresolved += 1
                continue
            }

            guard walk.visited.insert(sid).inserted else { continue }
            pending.append(contentsOf: nested.reversed())
        }
        return out
    }

    private struct Flattening {
        var visited: Set<String> = []
        var emitted: Set<String> = []
    }

    private static func sessionEdges(
        computerId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        ["Sessions", "PrivilegedSessions", "RegistrySessions"].flatMap { key in
            (object[key]?["Results"]?.array ?? []).compactMap { entry in
                guard let userId = entry["UserSID"]?.string, !userId.isEmpty else { return nil }
                return edgeOp(source: computerId, target: userId,
                              kind: ADEdgeKind.hasSession.rawValue, database: database)
            }
        }
    }

    private static func policyEffectEdges(
        object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        guard let changes = object["GPOChanges"] else { return [] }
        let computers = entries(changes, "AffectedComputers").compactMap(identifier(of:))
        guard !computers.isEmpty else { return [] }

        let delivered: [(key: String, kind: ADEdgeKind)] = [
            ("LocalAdmins", .adminTo),
            ("RemoteDesktopUsers", .canRDP),
            ("DcomUsers", .executeDCOM),
            ("PSRemoteUsers", .canPSRemote),
        ]
        var out: [ElasticClient.BulkOp] = []
        for (key, kind) in delivered {
            for principal in entries(changes, key).compactMap(identifier(of:)) {
                for computer in computers {
                    if let op = edgeOp(source: principal, target: computer,
                                       kind: kind.rawValue, database: database) {
                        out.append(op)
                    }
                }
            }
        }
        return out
    }

    private static func userRightEdges(
        computerId: String, object: JSONValue, groups: [String: [JSONValue]],
        database: String, unresolved: inout Int
    ) -> [ElasticClient.BulkOp] {
        var out: [ElasticClient.BulkOp] = []
        var walk = Flattening()
        for right in object["UserRights"]?.array ?? []
        where right["Privilege"]?.string == "SeRemoteInteractiveLogonRight" {
            let holders = flatten(right["Results"]?.array ?? [], through: groups,
                                  walk: &walk, unresolved: &unresolved)
            out += holders.compactMap {
                edgeOp(source: $0, target: computerId,
                       kind: ADEdgeKind.remoteInteractiveLogonRight.rawValue, database: database)
            }
        }
        return out
    }

    private static func domainRoleEdge(
        sourceId: String, object: JSONValue, kind: ADEdgeKind, when condition: Bool,
        database: String
    ) -> [ElasticClient.BulkOp] {
        guard condition else { return [] }
        let domain = object["DomainSID"]?.string ?? object["Properties"]?["domainsid"]?.string
        guard let domain, !domain.isEmpty else { return [] }
        return [edgeOp(source: sourceId, target: domain,
                       kind: kind.rawValue, database: database)].compactMap { $0 }
    }

    private static func enrollmentAgentEdges(
        object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        let restrictions = object["CARegistryData"]?["EnrollmentAgentRestrictions"]
        guard restrictions?["Collected"]?.bool != false else { return [] }
        return (restrictions?["Restrictions"]?.array ?? []).flatMap { entry -> [ElasticClient.BulkOp] in
            guard entry["AccessType"]?.string == "AccessAllowedCallback",
                  let agent = entry["Agent"]?["ObjectIdentifier"]?.string, !agent.isEmpty
            else { return [] }

            guard let template = entry["Template"]?["ObjectIdentifier"]?.string, !template.isEmpty
            else { return [] }
            return [edgeOp(source: agent, target: template,
                           kind: ADEdgeKind.delegatedEnrollmentAgent.rawValue,
                           database: database)].compactMap { $0 }
        }
    }

    private static func groupLinkEdge(
        policyId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        let link = object["GroupLink"] ?? object["Properties"]?["msds-oidtogrouplink"]
        guard let group = identifier(of: link ?? .null), !group.isEmpty else { return [] }
        return [edgeOp(source: policyId, target: group,
                       kind: ADEdgeKind.oidGroupLink.rawValue, database: database)].compactMap { $0 }
    }

    private static func sidHistoryEdges(
        sourceId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        outboundListEdges(sourceId: sourceId, object: object, key: "HasSIDHistory",
                          edgeKind: .hasSIDHistory, database: database)
    }

    private static func primaryGroupEdge(
        sourceId: String, object: JSONValue, database: String
    ) -> [ElasticClient.BulkOp] {
        let groupId = object["PrimaryGroupSID"]?.string ?? object["PrimaryGroupSid"]?.string
        guard let groupId, !groupId.isEmpty else { return [] }
        return [edgeOp(source: sourceId, target: groupId,
                       kind: ADEdgeKind.memberOf.rawValue, database: database)].compactMap { $0 }
    }

    private static func aceEdges(
        targetId: String, object: JSONValue, database: String, rights: inout RightsTally
    ) -> [ElasticClient.BulkOp] {
        guard let aces = object["Aces"]?.array else { return [] }
        var out: [ElasticClient.BulkOp] = []
        for ace in aces {
            guard let principal = ace["PrincipalSID"]?.string, !principal.isEmpty,
                  let reported = ace["RightName"]?.string, !reported.isEmpty else { continue }

            let right = rawRightAliases[reported] ?? reported
            if composedKinds.contains(right) { rights.rejected += 1; continue }
            let known = collectedRights.contains(right)
            if !known { rights.unknown += 1 }

            var extra: [String: JSONValue] = known ? [:] : ["unvetted": .bool(true)]
            if JSONValue.isTrue(ace["IsInherited"]) { extra["inherited"] = .bool(true) }
            if let op = edgeOp(source: principal, target: targetId, kind: right, database: database,
                               extra: extra) {
                out.append(op)
            }
        }
        return out
    }

    private static func inboundListEdges(
        targetId: String, object: JSONValue, key: String, edgeKind: ADEdgeKind, database: String
    ) -> [ElasticClient.BulkOp] {
        entries(object, key).compactMap { entry in
            guard let sid = identifier(of: entry), !sid.isEmpty else { return nil }
            return edgeOp(source: sid, target: targetId, kind: edgeKind.rawValue, database: database)
        }
    }

    private static func outboundListEdges(
        sourceId: String, object: JSONValue, key: String, edgeKind: ADEdgeKind, database: String
    ) -> [ElasticClient.BulkOp] {
        entries(object, key).compactMap { entry in
            guard let sid = identifier(of: entry), !sid.isEmpty else { return nil }
            return edgeOp(source: sourceId, target: sid, kind: edgeKind.rawValue, database: database)
        }
    }

    private static func entries(_ object: JSONValue, _ key: String) -> [JSONValue] {
        let field = object[key]
        return field?["Results"]?.array ?? field?.array ?? []
    }

    private static func identifier(of entry: JSONValue) -> String? {
        entry["ObjectIdentifier"]?.string ?? entry.string
    }

    private static func edgeOp(
        source: String, target: String, kind: String, database: String,
        extra: [String: JSONValue] = [:]
    ) -> ElasticClient.BulkOp? {
        guard source != target else { return nil }
        var doc: [String: JSONValue] = [
            "db": .string(database),
            "source": .string(source), "target": .string(target), "kind": .string(kind),
        ]
        for (key, value) in extra { doc[key] = value }
        return .init(index: Indices.edges, id: "\(database)|\(source)|\(kind)|\(target)", doc: doc)
    }
}

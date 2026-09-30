extension ADNodeKind {
    static func matching(_ word: String) -> ADNodeKind? {
        let needle = word.lowercased()
        guard needle.count >= 2 else { return nil }
        return allCases.first { kind in
            let name = kind.rawValue.lowercased()
            return needle == name || needle == name + "s"
        }
    }
}

enum ADNodeKind: String, Sendable, CaseIterable {
    case user = "User"
    case group = "Group"
    case computer = "Computer"
    case domain = "Domain"
    case gpo = "GPO"
    case ou = "OU"
    case container = "Container"

    case certTemplate = "CertTemplate"
    case enterpriseCA = "EnterpriseCA"
    case rootCA = "RootCA"
    case aiaCA = "AIACA"
    case ntAuthStore = "NTAuthStore"

    case issuancePolicy = "IssuancePolicy"

    case dmsa = "DMSA"

    case rodc = "RODC"

    case sccmSite = "SCCMSite"
    case sccmManagementPoint = "SCCMManagementPoint"

    case entraUser = "AZUser"
    case entraGroup = "AZGroup"
    case entraRole = "AZRole"
    case entraTenant = "AZTenant"

    case base = "Base"

    init?(bloodHoundType: String) {
        switch bloodHoundType {
        case "users": self = .user
        case "groups": self = .group
        case "computers": self = .computer
        case "domains": self = .domain
        case "gpos": self = .gpo
        case "ous": self = .ou
        case "containers": self = .container
        case "certtemplates": self = .certTemplate
        case "enterprisecas": self = .enterpriseCA
        case "rootcas": self = .rootCA
        case "aiacas": self = .aiaCA
        case "ntauthstores": self = .ntAuthStore

        case "issuancepolicies", "inssuancepolicie", "issuancepolicys": self = .issuancePolicy

        case "dmsas", "dmsa": self = .dmsa
        case "rodcs", "rodc": self = .rodc
        case "sccmsites", "sccmsite": self = .sccmSite
        case "sccmmanagementpoints", "sccmmanagementpoint": self = .sccmManagementPoint
        case "azusers", "azuser": self = .entraUser
        case "azgroups", "azgroup": self = .entraGroup
        case "azroles", "azrole": self = .entraRole
        case "aztenants", "aztenant": self = .entraTenant
        default: return nil
        }
    }

    static let principals: [ADNodeKind] = [.user, .computer, .group, .dmsa, .rodc,
                                           .entraUser, .entraGroup]

    var interfaces: Set<ADInterface> {
        switch self {
        case .user: return [.principal, .securable, .roastable]
        case .dmsa: return [.principal, .securable]
        case .group: return [.principal, .securable]
        case .computer: return [.principal, .securable, .roastable, .credentialStore]
        case .rodc: return [.principal, .securable, .credentialStore, .authority]
        case .domain: return [.securable, .container, .policyTarget]
        case .ou, .container: return [.securable, .container, .policyTarget]
        case .gpo: return [.securable, .policySource, .credentialStore]
        case .certTemplate: return [.securable, .policySource]
        case .enterpriseCA, .rootCA, .aiaCA: return [.securable, .authority, .credentialStore]
        case .ntAuthStore: return [.securable, .authority]
        case .issuancePolicy: return [.securable, .policySource]
        case .sccmSite: return [.securable, .policySource, .credentialStore]
        case .sccmManagementPoint: return [.securable, .policySource, .credentialStore]
        case .entraUser: return [.principal, .securable]
        case .entraGroup: return [.principal, .securable]
        case .entraRole: return [.securable]
        case .entraTenant: return [.securable, .container]
        case .base: return []
        }
    }

    static func having(_ interface: ADInterface) -> [ADNodeKind] {
        allCases.filter { $0.interfaces.contains(interface) }
    }
}

enum ADInterface: String, Sendable, CaseIterable {

    case principal

    case securable

    case roastable

    case credentialStore

    case policySource

    case policyTarget

    case container

    case authority
}

enum ADEdgeKind: String, Sendable, CaseIterable {
    case memberOf = "MemberOf"
    case adminTo = "AdminTo"
    case canRDP = "CanRDP"
    case executeDCOM = "ExecuteDCOM"
    case canPSRemote = "CanPSRemote"
    case hasSession = "HasSession"

    case publishedTo = "PublishedTo"
    case hostsCAService = "HostsCAService"

    case extendedByPolicy = "ExtendedByPolicy"
    case oidGroupLink = "OIDGroupLink"

    case contains = "Contains"
    case gpLink = "GPLink"

    case sameForestTrust = "SameForestTrust"
    case crossForestTrust = "CrossForestTrust"

    case spoofSIDHistory = "SpoofSIDHistory"
    case abuseTGTDelegation = "AbuseTGTDelegation"
    case allowedToAct = "AllowedToAct"
    case allowedToDelegate = "AllowedToDelegate"
    case hasSIDHistory = "HasSIDHistory"
    case dumpSMSAPassword = "DumpSMSAPassword"
    case remoteInteractiveLogonRight = "RemoteInteractiveLogonRight"

    case dcFor = "DCFor"
    case enterpriseCAFor = "EnterpriseCAFor"
    case ntAuthStoreFor = "NTAuthStoreFor"
    case rootCAFor = "RootCAFor"
    case delegatedEnrollmentAgent = "DelegatedEnrollmentAgent"

    case trustedForNTAuth = "TrustedForNTAuth"
    case issuedSignedBy = "IssuedSignedBy"

    case dcSync = "DCSync"

    case coerceToTGT = "CoerceToTGT"

    case goldenCert = "GoldenCert"

    case seBackupPrivilege = "SeBackupPrivilege"
    case seLoadDriverPrivilege = "SeLoadDriverPrivilege"
    case serviceControl = "ServiceControl"
    case dnsServerControl = "DNSServerControl"

    case kerberoastable = "Kerberoastable"

    case asrepRoastable = "ASREPRoastable"

    case adcsESC1 = "ADCSESC1"
    case adcsESC3 = "ADCSESC3"
    case adcsESC4 = "ADCSESC4"
    case adcsESC6 = "ADCSESC6"

    case adcsESC7 = "ADCSESC7"

    case adcsESC9 = "ADCSESC9"
    case adcsESC10 = "ADCSESC10"

    case adcsESC13 = "ADCSESC13"

    case adcsESC5 = "ADCSESC5"

    case adcsESC11 = "ADCSESC11"

    case adcsESC16 = "ADCSESC16"

    case hasTrustKeys = "HasTrustKeys"

    case protectAdminGroups = "ProtectAdminGroups"

    case propagatesACEsTo = "PropagatesACEsTo"

    case gpoAppliesTo = "GPOAppliesTo"

    case claimSpecialIdentity = "ClaimSpecialIdentity"

    case syncLAPSPassword = "SyncLAPSPassword"

    case badSuccessor = "BadSuccessor"

    case rodcKeyRecovery = "RODCKeyRecovery"

    case coerceAndRelayToADCS = "CoerceAndRelayNTLMToADCS"
    case coerceAndRelayToLDAP = "CoerceAndRelayNTLMToLDAP"
    case coerceAndRelayToSMB = "CoerceAndRelayNTLMToSMB"

    case sccmSiteTakeover = "SCCMSiteTakeover"
    case sccmClientPush = "SCCMClientPush"
    case sccmManages = "SCCMManages"

    case syncedToEntraUser = "SyncedToEntraUser"
    case syncedToADUser = "SyncedToADUser"

    case sqlAdmin = "SQLAdmin"

    case gppPassword = "GPPPassword"
}

enum Rights {
    static let control = ["GenericAll", "GenericWrite", "WriteDacl", "WriteOwner", "Owns"]

    static let limitedOwnership = ["OwnsLimitedRights", "WriteOwnerLimitedRights"]

    static let identityWrites = [
        "AddKeyCredentialLink",
        "WriteAltSecurityIdentities",
        "WritePublicInformation",
        "ForceChangePassword",
    ]

    static let identityAttributeWrites = control + ["WritePublicInformation"]
}

enum WellKnown {

    static let everyone = "S-1-1-0"
    static let authenticatedUsers = "S-1-5-11"
    static let builtinUsers = "S-1-5-32-545"

    static let domainUsers = "513", domainComputers = "515"

    static let hubs = [everyone, authenticatedUsers, "-" + domainUsers, "-" + domainComputers, builtinUsers]

    static func isHub(_ id: String) -> Bool { hubs.contains { id.hasSuffix($0) } }

    static let controllerRights: [(suffix: String, edge: ADEdgeKind)] = [
        ("S-1-5-32-544", .adminTo),
        ("S-1-5-32-551", .seBackupPrivilege),
        ("S-1-5-32-549", .serviceControl),
        ("S-1-5-32-550", .seLoadDriverPrivilege),
    ]

    static let controllerRightsByName: [(name: String, edge: ADEdgeKind)] = [
        ("DNSADMINS", .dnsServerControl),
    ]
}

struct ADCSEscalation: Sendable {

    let edge: ADEdgeKind

    let rights: [[String]]

    let template: String

    let authority: String

    let technique: String

    var throughVictim: Bool = false

    var domain: String = ""

    var onAuthority: Bool = false

    static let enrolment = ["Enroll", "AutoEnroll", "AllExtendedRights", "GenericAll"]

    static let templateControl = Rights.control + Rights.limitedOwnership
        + ["WritePKINameFlag", "WritePKIEnrollmentFlag"]

    static let esc1 = ADCSEscalation(
        edge: .adcsESC1, rights: [enrolment],

        template: "where authenticationenabled = true and where enrolleesuppliessubject = true"
            + " and where requiresmanagerapproval != true"
            + " and (where authorizedsignatures = 0 or not authorizedsignatures)",
        authority: "",
        technique: "Enrollee supplies subject (ESC1)")

    static let esc3 = ADCSEscalation(
        edge: .adcsESC3, rights: [[ADEdgeKind.delegatedEnrollmentAgent.rawValue], enrolment],
        template: "where authenticationenabled = true and where requiresmanagerapproval != true",
        authority: "",
        technique: "Enrollment agent (ESC3)")

    static let esc6 = ADCSEscalation(
        edge: .adcsESC6, rights: [enrolment],
        template: "where authenticationenabled = true and where requiresmanagerapproval != true"
            + " and (where authorizedsignatures = 0 or not authorizedsignatures)",
        authority: "where isuserspecifiessanenabled = true",
        technique: "SAN attribute flag on CA (ESC6)")

    static let esc4 = ADCSEscalation(
        edge: .adcsESC4, rights: [templateControl],
        template: "where authenticationenabled = true",
        authority: "",
        technique: "Template control (ESC4)")

    static let esc7 = ADCSEscalation(
        edge: .adcsESC7, rights: [["ManageCA"]],
        template: "", authority: "",
        technique: "ManageCA (ESC7)",
        onAuthority: true)

    static let esc9 = ADCSEscalation(
        edge: .adcsESC9, rights: [enrolment],
        template: "where authenticationenabled = true and where nosecurityextension = true"
            + " and where requiresmanagerapproval != true"
            + " and (where subjectaltrequireupn = true or where subjectaltrequiredns = true"
            + " or where subjectaltrequiredomaindns = true or where subjectaltrequirespn = true)",
        authority: "",
        technique: "No security extension (ESC9)",
        throughVictim: true)

    static let esc10 = ADCSEscalation(
        edge: .adcsESC10, rights: [enrolment],
        template: "where authenticationenabled = true and where requiresmanagerapproval != true"
            + " and (where subjectaltrequireupn = true or where subjectaltrequiredns = true"
            + " or where subjectaltrequiredomaindns = true or where subjectaltrequirespn = true)",
        authority: "",
        technique: "Weak certificate mapping (ESC10)",
        throughVictim: true,

        domain: "where strongcertificatebindingenforcement in (0, 1)"
            + " or where certificatemappingmethods in (4, 5, 6, 7, 12, 13, 14, 15, 20, 21, 22, 23, 28, 29, 30, 31)")

    static let esc13 = ADCSEscalation(
        edge: .adcsESC13, rights: [enrolment],
        template: "where authenticationenabled = true and where requiresmanagerapproval != true",
        authority: "",
        technique: "Issuance policy group (ESC13)")

    static let esc11 = ADCSEscalation(
        edge: .adcsESC11, rights: [enrolment],
        template: "", authority: "where enforceencryptedicertrequest = false",
        technique: "Unencrypted ICPR requests (ESC11)",
        onAuthority: true)

    static let esc16 = ADCSEscalation(
        edge: .adcsESC16, rights: [enrolment],

        template: "", authority: "where disableextensionlist = \"1.3.6.1.4.1.311.25.2\"",
        technique: "Security extension disabled on CA (ESC16)",
        onAuthority: true)

    static let esc5 = ADCSEscalation(
        edge: .adcsESC5, rights: [templateControl],
        template: "", authority: "",
        technique: "PKI object control (ESC5)")

    static let pkiSupport: [ADNodeKind] = [.rootCA, .aiaCA, .ntAuthStore]

    static let all = [esc1, esc3, esc4, esc6, esc7, esc9, esc10, esc11, esc16]

    static let everyEscalation = all + [esc13, esc5]

    static let everyEdge: [ADEdgeKind] = everyEscalation.map(\.edge)
}

enum Indices {
    static let nodes = "ad-nodes"
    static let edges = "ad-edges"

    static let databases = "ad-databases"

    static let state = "app-state"

    static let projects = "app-projects"

    static let assertions = "ad-assertions"

    static let library = "app-library"

    static let databaseScoped = [nodes, edges, assertions, library]
}

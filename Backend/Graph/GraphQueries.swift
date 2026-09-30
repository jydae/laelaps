import Foundation
import Hummingbird

enum Severity: String, Sendable, CaseIterable, Comparable {

    case critical

    case high

    case medium

    case low

    case none

    private var order: Int { Severity.allCases.firstIndex(of: self) ?? 0 }
    static func < (a: Severity, b: Severity) -> Bool { a.order < b.order }
}

enum Counting: Sendable {
    case objects

    case ofKind(ADNodeKind)
    case edges([String])
    case answer
    case reaching
}

struct GraphQueryInfo: Sendable {
    let id: String
    let title: String
    let description: String

    let section: String

    let script: String

    var severity: Severity = .none

    var remedy: String = ""

    var counts: Counting = .objects
}

enum GraphQueryCatalog {

    static let all: [GraphQueryInfo] = [

        .init(
            id: "trust-carries-an-attack", title: "Trusts without SID filtering or with TGT delegation",
            description: "A cross-forest trust with SID filtering off, or ticket delegation allowed.",
            section: "Forest boundary",
            script: "reach domains via SpoofSIDHistory, AbuseTGTDelegation within 1",
            severity: .critical,
            remedy: "Enable SID filtering, and disable ticket-granting-ticket delegation across the trust",
            counts: .edges([ADEdgeKind.spoofSIDHistory.rawValue, ADEdgeKind.abuseTGTDelegation.rawValue])),
        .init(
            id: "trusts", title: "Every trust",
            description: "Each trust, in the direction authentication flows.",
            section: "Forest boundary",
            script: "find domains via SameForestTrust, CrossForestTrust within 1"),
        .init(
            id: "password-not-required", title: "Password not required",
            description: "PASSWD_NOTREQD set. The password may be empty.",
            section: "Credential exposure",
            script: "find objects where passwordnotreqd = true",
            severity: .critical,
            remedy: "Clear PASSWD_NOTREQD and set a password policy that applies to the account"),
        .init(
            id: "spn-user-accounts", title: "SPN set on a user account",
            description: "servicePrincipalName on a user. Ticket encrypted under its password hash.",
            section: "Credential exposure",
            script: "find objects where hasspn = true",

            remedy: "Move the service to a group managed service account, or rotate to a long random password"),
        .init(
            id: "no-password-protected", title: "No password on a protected account",
            description: "PASSWD_NOTREQD on an account the AdminSDHolder sweep protects.",
            section: "Credential exposure",

            script: "find users where passwordnotreqd = true and where admincount = true",
            severity: .critical,
            remedy: "Set a password on the account now, then clear PASSWD_NOTREQD"),
        .init(
            id: "spn-protected-account", title: "SPN on a protected account",
            description: "servicePrincipalName where adminCount is set.",
            section: "Credential exposure",
            script: "find objects where hasspn = true and where admincount = true",
            severity: .critical,
            remedy: "Never run a service as a protected account: move the service to its own managed account"),
        .init(
            id: "ticket-recoverable", title: "Kerberoastable users",
            description: "Any authenticated principal can request a ticket encrypted under this password.",
            section: "Credential exposure",

            script: "find users where hasspn = true and where enabled = true",
            severity: .high,
            remedy: "Rotate the password to a long random one, or move the service to a managed account",
            counts: .edges(["Kerberoastable"])),
        .init(
            id: "preauth-recoverable", title: "AS-REP roastable users",
            description: "Pre-authentication is off, so the reply is obtainable with no account at all.",
            section: "Credential exposure",
            script: "find users where dontreqpreauth = true and where enabled = true",
            severity: .high,
            remedy: "Require Kerberos pre-authentication on the account",
            counts: .edges(["ASREPRoastable"])),
        .init(
            id: "ticket-recoverable-stale", title: "Kerberoastable, password older than 5 years",
            description: "A ticket is obtainable and the password has stood for over five years.",
            section: "Credential exposure",
            script: "find users where hasspn = true and where enabled = true"
                + " and where samaccountname != \"krbtgt\" and where pwdlastset older than 5y",
            severity: .critical,
            remedy: "Rotate the password now; at this age it is within reach of an offline attack"),
        .init(
            id: "preauth-disabled", title: "Pre-authentication disabled",
            description: "DONT_REQ_PREAUTH set. AS-REP hash obtainable unauthenticated.",
            section: "Credential exposure",
            script: "find objects where dontreqpreauth = true",
            severity: .high,
            remedy: "Require Kerberos pre-authentication on the account"),
        .init(
            id: "legacy-password-attributes", title: "Legacy password attributes",
            description: "userPassword or equivalent populated. Stored recoverably, not hashed.",
            section: "Credential exposure",
            script: "find objects with userpassword or with unixpassword or with unicodepassword or with sfupassword",
            severity: .critical,
            remedy: "Clear the attribute; it stores the password recoverably and is world-readable"),
        .init(
            id: "accounts-with-description", title: "Accounts with description",
            description: "Enabled accounts carrying description text. Readable domain-wide.",
            section: "Credential exposure",
            script: "find users where enabled = true and with description",

            remedy: "Review the text: descriptions are readable by every authenticated principal"),
        .init(
            id: "disabled-with-description", title: "Disabled with description",
            description: "ACCOUNTDISABLE set with description text. Scrutinised less.",
            section: "Credential exposure",
            script: "find users where enabled = false and with description",

            remedy: "Review the text, then remove the account if it is no longer needed"),
        .init(
            id: "tier-zero", title: "Tier Zero principals",
            description: "Qualifies on its own merits, not by transitive control.",
            section: "Privileged access",
            script: "find objects tier zero"),
        .init(
            id: "domain-admins-transitive", title: "Domain Admins, transitive",
            description: "Reaches Domain Admins through nested membership.",
            section: "Privileged access",
            script: "reach groups named \"DOMAIN ADMINS\" via MemberOf within 4",
            severity: .high,
            remedy: "Unroll the nesting: membership of Domain Admins should be direct and few",
            counts: .answer),
        .init(
            id: "replication-rights", title: "Directory replication rights",
            description: "DS-Replication-Get-Changes(-All), or All Extended Rights.",
            section: "Privileged access",
            script: "reach domains via DCSync within 1",
            severity: .critical,
            remedy: "Remove directory replication rights from everything but the domain controllers",
            counts: .edges([ADEdgeKind.dcSync.rawValue])),
        .init(
            id: "builtin-right-on-controller", title: "Built-in right on a controller",
            description: "A group whose membership confers a local right on a domain controller.",
            section: "Privileged access",
            script: "reach computers where isdc = true via SeBackupPrivilege, ServiceControl,"
                + " SeLoadDriverPrivilege, DNSServerControl within 1",
            severity: .critical,
            remedy: "Empty the group; grant the right to a dedicated managed account instead",
            counts: .edges([ADEdgeKind.seBackupPrivilege.rawValue, ADEdgeKind.serviceControl.rawValue,
                ADEdgeKind.seLoadDriverPrivilege.rawValue, ADEdgeKind.dnsServerControl.rawValue])),
        .init(
            id: "control-right-on-controller", title: "Control right on a controller",
            description: "A principal holds a takeover right over the controller's own object.",
            section: "Privileged access",

            script: "reach computers where isdc = true via escalation within 1",
            severity: .critical,
            remedy: "Remove the permission: a controller object is administered by Tier 0 groups only",
            counts: .reaching),
        .init(
            id: "control-plane", title: "Control plane",
            description: "Tier 0: the identity system itself and the principals that administer it.",
            section: "Privileged access",
            script: "find objects where zonetier = 0"),
        .init(
            id: "management-plane", title: "Management plane",
            description: "Tier 1: the infrastructure that operates the control plane.",
            section: "Privileged access",
            script: "find objects where zonetier = 1"),
        .init(
            id: "tier-inferred", title: "Tier inferred from a name",
            description: "Classified by a name signature, not a collected fact. Confirm or correct.",
            section: "Privileged access",
            script: "find objects where zonetierinferred = true"),
        .init(
            id: "protected-delegatable", title: "Protected and delegatable",
            description: "adminCount set, NOT_DELEGATED absent.",
            section: "Privileged access",
            script: "find users where admincount = true and where sensitive != true",
            severity: .high,
            remedy: "Set NOT_DELEGATED on the account, or add it to Protected Users"),
        .init(
            id: "protected-dormant", title: "Protected and dormant",
            description: "adminCount set, lastLogon over 180 days old or never recorded.",
            section: "Privileged access",
            script: "find users where admincount = true and where lastlogon older than 180d",
            severity: .medium,
            remedy: "Disable the account, then remove it once the owner is confirmed gone"),
        .init(
            id: "protected-disabled", title: "Disabled, still protected",
            description: "ACCOUNTDISABLE set, adminCount still present.",
            section: "Privileged access",
            script: "find objects where admincount = true and where enabled = false",
            severity: .medium,
            remedy: "Clear adminCount and restore inheritance on the object, or delete it"),
        .init(
            id: "unconstrained-delegation", title: "Unconstrained delegation",
            description: "Caches any ticket presented to it. Controllers are excluded: they hold it by design.",
            section: "Kerberos delegation",
            script: "find computers where unconstraineddelegation = true and where isdc != true",
            severity: .critical,
            remedy: "Clear unconstrained delegation; use constrained or resource-based delegation instead"),
        .init(
            id: "delegation-ticket-capture", title: "Unconstrained delegation to a domain",
            description: "Holding this account yields a forwarded ticket for whoever authenticates to it.",
            section: "Kerberos delegation",
            script: "reach domains via CoerceToTGT within 1",
            severity: .critical,
            remedy: "Clear unconstrained delegation on the account, or mark privileged accounts sensitive",
            counts: .edges([ADEdgeKind.coerceToTGT.rawValue])),
        .init(
            id: "protocol-transition", title: "Protocol transition",
            description: "TRUSTED_TO_AUTH_FOR_DELEGATION set. S4U2Self to any principal.",
            section: "Kerberos delegation",
            script: "find objects where trustedtoauth = true",
            severity: .high,
            remedy: "Remove TRUSTED_TO_AUTH_FOR_DELEGATION, or narrow what the account may delegate to"),
        .init(
            id: "template-requester-subject", title: "Enrollee supplies subject (ESC1)",
            description: "The requester names the subject and gets a logon certificate. No approval needed.",
            section: "Certificate services",

            script: "find certtemplates \(ADCSEscalation.esc1.template) via PublishedTo within 1",
            severity: .critical,
            remedy: "Stop the template accepting a requested subject, or require manager approval",
            counts: .ofKind(.certTemplate)),
        .init(
            id: "template-unrestricted-eku", title: "Unrestricted key usage",
            description: "Any Purpose EKU (2.5.29.37.0) or no EKU declared.",
            section: "Certificate services",
            script: "find certtemplates where effectiveekus = \"2.5.29.37.0\" or not effectiveekus via PublishedTo within 1",
            severity: .high,
            remedy: "Restrict the template's extended key usage to what the service needs",
            counts: .ofKind(.certTemplate)),
        .init(
            id: "template-request-agent", title: "Enrollment agent templates (ESC3)",
            description: "Certificate Request Agent EKU (1.3.6.1.4.1.311.20.2.1).",
            section: "Certificate services",
            script: "find certtemplates where effectiveekus = \"1.3.6.1.4.1.311.20.2.1\" via PublishedTo within 1",
            severity: .high,
            remedy: "Restrict who may enrol for an enrollment agent certificate",
            counts: .ofKind(.certTemplate)),
        .init(
            id: "template-no-sid-binding", title: "No security extension (ESC9)",
            description: "Enrollment flags omit the SID security extension.",
            section: "Certificate services",
            script: "find certtemplates where nosecurityextension = true via PublishedTo within 1",
            severity: .high,
            remedy: "Put the SID security extension back on the template",
            counts: .ofKind(.certTemplate)),
        .init(
            id: "template-writable", title: "Certificate template writable",
            description: "A principal can rewrite the template, including into an escalation.",
            section: "Certificate services",

            script: "reach certtemplates via escalation within 1",
            severity: .critical,
            remedy: "Restrict the template's permissions to the authorities and Tier 0 administrators",
            counts: .reaching),
        .init(
            id: "ca-requester-san", title: "CA accepts a requested SAN",
            description: "EDITF_ATTRIBUTESUBJECTALTNAME2 enabled on the authority.",
            section: "Certificate services",
            script: "find enterprisecas where isuserspecifiessanenabled = true",
            severity: .critical,
            remedy: "Clear EDITF_ATTRIBUTESUBJECTALTNAME2 on the authority"),
        .init(
            id: "certificate-escalation", title: "ADCS escalation to a domain",
            description: "Enrolment rights that together issue a logon certificate for anyone.",
            section: "Certificate services",

            script: "reach domains via "
                + ADCSEscalation.all.map(\.edge.rawValue).joined(separator: ", ") + " within 1",
            severity: .critical,
            remedy: "Close the template or authority condition each route names",
            counts: .edges(ADCSEscalation.all.map(\.edge.rawValue))),
        .init(
            id: "authority-key-holder", title: "CA host (Golden Certificate)",
            description: "The machine hosting the authority can forge a certificate for anyone.",
            section: "Certificate services",
            script: "reach domains via GoldenCert within 1",
            severity: .high,
            remedy: "Hold the authority's key in a hardware module and treat the host as Tier Zero",
            counts: .edges([ADEdgeKind.goldenCert.rawValue])),
        .init(
            id: "issuance-policy-group", title: "Issuance policy confers a group",
            description: "A template whose policy is linked to a group: the certificate is the membership.",
            section: "Certificate services",
            script: "find certtemplates via ExtendedByPolicy, OIDGroupLink within 2",
            severity: .high,
            remedy: "Remove the OID group link, or restrict who may enrol for the template",
            counts: .edges([ADEdgeKind.oidGroupLink.rawValue])),
        .init(
            id: "gpo-writable", title: "Group policy writable",
            description: "A principal can rewrite a policy, and so run code wherever it is linked.",
            section: "Group policy",

            script: "reach gpos via escalation within 1",
            severity: .critical,
            remedy: "Restrict the policy's permissions; delegate at the link, not on the object",
            counts: .reaching),
        .init(
            id: "laps-absent", title: "Computers without LAPS",
            description: "No LAPS. One recovered local hash opens every machine that shares it.",
            section: "Unmanaged assets",
            script: "find computers where haslaps != true",

            remedy: "Deploy LAPS so each machine's local administrator password is unique"),
        .init(
            id: "no-recorded-logon", title: "Enabled, never logged on",
            description: "Enabled with no lastLogon value.",
            section: "Unmanaged assets",
            script: "find objects where enabled = true and not lastlogon",

            remedy: "Disable the account, then remove it once the owner is confirmed gone"),

        .init(
            id: "control-plane-not-tier-zero", title: "Control plane, outside Tier Zero",
            description: "Classified as control plane by what it is, but the closure does not hold it.",
            section: "Tiering gaps",
            script: "find objects where zonetier = 0"
                + " minus find objects where tierzero = true",
            severity: .high,
            remedy: "Seed it, or say why an object on the control plane is outside the zone the tool defends"),
        .init(
            id: "tier-zero-below-control-plane", title: "Tier Zero, below the control plane",
            description: "Absorbed into Tier Zero by a route, while what it is puts it lower.",
            section: "Tiering gaps",
            script: "find objects where tierzero = true"
                + " minus find objects where zonetier = 0",
            severity: .medium,
            remedy: "This is the crossing to fix: break the route, rather than accepting the object into Tier Zero"),
        .init(
            id: "protected-below-control-plane", title: "Protected, below the control plane",
            description: "adminCount is set, but the object is not classified on the control plane.",
            section: "Tiering gaps",
            script: "find objects where admincount = true"
                + " minus find objects where zonetier = 0",
            severity: .medium,
            remedy: "Clear a stale adminCount, or move the account onto the plane its rights belong to"),
        .init(
            id: "roastable-not-tier-zero", title: "Roastable, not already Tier Zero",
            description: "A ticket worth cracking: the account is recoverable and is not yet in the zone.",
            section: "Tiering gaps",

            script: "find objects where id = \"\(WellKnown.authenticatedUsers)\" via Kerberoastable within 1"
                + " minus find objects where tierzero = true"
                + " minus find objects where id = \"\(WellKnown.authenticatedUsers)\"",
            severity: .high,
            remedy: "Rotate the password to a long random one, or move the service to a managed account"),

        .init(
            id: "all-users", title: "All users",
            description: "Every user object in the database.",
            section: "Objects",
            script: "find users"),
        .init(
            id: "all-groups", title: "All groups",
            description: "Every group, with the memberships between them.",
            section: "Objects",
            script: "find groups show paths"),
        .init(
            id: "all-computers", title: "All computers",
            description: "Every computer object in the database.",
            section: "Objects",
            script: "find computers"),
        .init(
            id: "all-ous", title: "All OUs",
            description: "Every organizational unit, with what contains what.",
            section: "Objects",
            script: "find ous show paths"),
        .init(
            id: "all-gpos", title: "All GPOs",
            description: "Every group policy object in the database.",
            section: "Objects",
            script: "find gpos"),
        .init(
            id: "all-domains", title: "All domains",
            description: "Every domain, with the trusts between them.",
            section: "Objects",
            script: "find domains show paths"),
        .init(
            id: "all-containers", title: "All containers",
            description: "Every container, with what contains what.",
            section: "Objects",
            script: "find containers show paths"),
        .init(
            id: "all-issuance-policies", title: "All issuance policies",
            description: "Every certificate issuance policy, with the group each one is linked to.",
            section: "Objects",
            script: "find issuancepolicy via OIDGroupLink within 1"),
        .init(
            id: "all-certificate-templates", title: "All certificate templates",
            description: "Every template, attached to the authorities that publish it.",
            section: "Objects",
            script: "find certtemplates via PublishedTo within 1"),
    ]
}

struct ScoreDTO: ResponseEncodable {

    let points: Int

    let maturity: Int
    let maturityTitle: String

    let counted: Int
    let uncounted: Int
}

enum Scoring {

    static func points(_ severity: Severity, count: Int) -> Int {
        guard count > 0 else { return 0 }
        let base: Int
        switch severity {
        case .critical: base = 50
        case .high: base = 30
        case .medium: base = 15
        case .low: base = 5
        case .none: return 0
        }

        let volume = 1.0 + 0.25 * min(3.0, log10(Double(count)))
        return min(100, Int((Double(base) * volume).rounded()))
    }

    static func band(_ severity: Severity) -> Int {
        switch severity {
        case .critical: return 1
        case .high: return 2
        case .medium: return 3
        case .low: return 4
        case .none: return 5
        }
    }

    static let bandTitles = [
        1: "The domain can be taken over by an unprivileged account",
        2: "A privileged position is one abusable step away",
        3: "The tiering model is broken in places",
        4: "Hygiene findings only",
        5: "Nothing the catalogue can fault",
    ]

    static func category(_ scored: [(severity: Severity, count: Int, title: String)]) -> Int {
        let ranked = scored
            .filter { $0.count > 0 && $0.severity != .none }
            .sorted { ($0.severity, $0.title) < ($1.severity, $1.title) }
        guard let worst = ranked.first else { return 0 }
        let lead = points(worst.severity, count: worst.count)
        let rest = ranked.dropFirst().reduce(0) { $0 + points($1.severity, count: $1.count) / 4 }
        return min(100, lead + rest)
    }

    static func score(rows: [(row: GraphQueryInfo, count: Int?)]) -> ScoreDTO {
        var byCategory: [String: [(severity: Severity, count: Int, title: String)]] = [:]
        var order: [String] = []
        var counted = 0, uncounted = 0
        var worstBand = 5

        for (row, count) in rows {
            guard row.severity != .none else { continue }
            guard let count else { uncounted += 1; continue }
            counted += 1
            if byCategory[row.section] == nil { order.append(row.section) }
            byCategory[row.section, default: []].append((row.severity, count, row.title))
            if count > 0, band(row.severity) < worstBand { worstBand = band(row.severity) }
        }

        return ScoreDTO(
            points: order.map { category(byCategory[$0] ?? []) }.max() ?? 0,
            maturity: worstBand,
            maturityTitle: bandTitles[worstBand] ?? "",
            counted: counted, uncounted: uncounted)
    }
}

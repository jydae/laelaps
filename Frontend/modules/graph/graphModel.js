import { utcMinute, NA } from "../../core/index.js";

export const table = (rows) => Object.assign(Object.create(null), rows);

const AD_ATTRIBUTES = table({

  admincount: "adminCount",
  displayname: "displayName",
  distinguishedname: "distinguishedName",
  homedirectory: "homeDirectory",
  lastlogon: "lastLogon",
  lastlogontimestamp: "lastLogonTimestamp",
  logonscript: "scriptPath",
  objectid: "objectSid",
  objectsid: "objectSid",
  operatingsystem: "operatingSystem",
  primarygroupsid: "primaryGroupSID",
  pwdlastset: "pwdLastSet",
  samaccountname: "sAMAccountName",
  serviceprincipalnames: "servicePrincipalName",
  sidhistory: "sIDHistory",
  userpassword: "userPassword",
  unixpassword: "unixUserPassword",
  whenchanged: "whenChanged",
  whencreated: "whenCreated",
  gpcpath: "gPCFileSysPath",
  allowedtodelegate: "msDS-AllowedToDelegateTo",

  authenticationenabled: "authenticationEnabled",
  authorizedsignatures: "authorizedSignatures",
  domainsid: "domainSID",
  dontreqpreauth: "dontReqPreAuth",
  effectiveekus: "effectiveEKUs",
  enrolleesuppliessubject: "enrolleeSuppliesSubject",
  haslaps: "hasLAPS",
  hasspn: "hasSPN",
  highvalue: "highValue",
  isaclprotected: "isACLProtected",
  isdc: "isDC",
  isuserspecifiessanenabled: "isUserSpecifiesSanEnabled",
  nosecurityextension: "noSecurityExtension",
  passwordnotreqd: "passwordNotReqd",
  pwdneverexpires: "pwdNeverExpires",
  requiresmanagerapproval: "requiresManagerApproval",
  trustedtoauth: "trustedToAuth",
  unconstraineddelegation: "unconstrainedDelegation",
  isreadonlydc: "isReadOnlyDC",
  strongcertificatebindingenforcement: "strongCertificateBindingEnforcement",
  certificatemappingmethods: "certificateMappingMethods",
  supportedencryptiontypes: "msDS-SupportedEncryptionTypes",
  subjectaltrequireupn: "subjectAltRequireUPN",
  subjectaltrequiredns: "subjectAltRequireDNS",
  subjectaltrequiredomaindns: "subjectAltRequireDomainDNS",
  subjectaltrequirespn: "subjectAltRequireSPN",
  certtemplateoid: "msPKI-Cert-Template-OID",
  certificatepolicy: "msPKI-Certificate-Policy",
});

export const propLabel = (key) => AD_ATTRIBUTES[key] ?? key;

export const KIND_LABELS = table({
  User: "Users",
  Group: "Groups",
  Computer: "Computers",
  Domain: "Domains",
  OU: "Organizational Units",
  Container: "Containers",
  GPO: "Group Policy Objects",
  CertTemplate: "Certificate Templates",
  EnterpriseCA: "Enterprise CAs",
  RootCA: "Root CAs",
  AIACA: "AIA CAs",
  NTAuthStore: "NTAuth Stores",
  IssuancePolicy: "Issuance Policies",
});

const TIER_LABELS = table({ 0: "Control plane", 1: "Management plane", 2: "Data plane" });

export const tierLabel = (tier) => TIER_LABELS[tier] ?? (tier === undefined || tier === null ? NA : `Tier ${tier}`);

export const CROSSING_LABELS = table({
  control: "A less privileged principal can take a more privileged object",
  credential: "A privileged account's credentials are resident on a less privileged host",
  authentication: "Authentication material for a privileged account is obtainable by anyone",
});

const CONTAINS = table({
  GenericAll: [
    "GenericWrite", "WriteDacl", "WriteOwner", "AllExtendedRights",
    "ForceChangePassword", "AddMember", "AddSelf", "AddKeyCredentialLink",
    "WriteSPN", "AddAllowedToAct", "ReadLAPSPassword", "ReadGMSAPassword",
    "GetChanges", "GetChangesAll",

    "Enroll", "AutoEnroll", "WritePKINameFlag", "WritePKIEnrollmentFlag",

    "WriteAltSecurityIdentities", "WritePublicInformation",
  ],
  GenericWrite: [
    "AddMember", "AddSelf", "AddKeyCredentialLink", "WriteSPN", "AddAllowedToAct",
    "WritePKINameFlag", "WritePKIEnrollmentFlag",
    "WriteAltSecurityIdentities", "WritePublicInformation",
  ],
  AllExtendedRights: [
    "ForceChangePassword", "AddSelf", "GetChanges", "GetChangesAll",
    "ReadLAPSPassword", "ReadGMSAPassword", "Enroll", "AutoEnroll",
  ],

  WritePublicInformation: ["WriteAltSecurityIdentities", "WriteSPN"],

  WriteOwner: ["WriteOwnerLimitedRights"],
  Owns: ["OwnsLimitedRights"],
});

export function summariseKinds(kinds = []) {
  const covered = new Set();
  for (const kind of kinds) for (const inner of CONTAINS[kind] ?? []) covered.add(inner);
  const kept = kinds.filter((kind) => !covered.has(kind));
  return kept.join(", ");
}

const TIMESTAMPS = new Set(["whencreated", "whenchanged", "lastlogon", "lastlogontimestamp", "pwdlastset"]);

export function formatProp(value, key) {
  if (value === null || value === undefined) return NA;
  if (TIMESTAMPS.has(key) && typeof value === "number") {
    if (value <= 0) return "Never";
    const at = new Date(value * 1000);
    if (Number.isFinite(at.getTime())) return utcMinute(at);
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : NA;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function zoneOrigin(detail) {
  if (detail.tierZeroSeed) return detail.tierZeroReason || "matched a rule";
  if (detail.zoneAsserted) return "added by an operator";
  return "reached from a Tier Zero object";
}

export const routeMeta = (path) => {
  if (path.targetOwned) return null;
  const n = path.steps.length;
  return path.walked > 0 ? `${path.walked} of ${n}` : String(n);
};

export const isStanding = (path) => path.standing === true;

export const routeKey = (path) => `${path.startId}|${path.targetId}`;

export const DOMAIN_VIEW = "domain";

export const sameRoute = (a, b) => Boolean(a && b) && routeKey(a) === routeKey(b);

export const edgesByDirection = (edges) => {
  const order = (a, b) => a.kind.localeCompare(b.kind)
    || (a.otherLabel ?? a.otherId).localeCompare(b.otherLabel ?? b.otherId);
  return {
    out: edges.filter((e) => e.direction === "out").sort(order),
    in: edges.filter((e) => e.direction === "in").sort(order),
  };
};

export const rowNode = (edge) => ({
  id: edge.otherId, label: edge.otherLabel, kind: edge.otherKind,
  tierZeroSeed: edge.otherTierZeroSeed,
});

export function merge(nodes, links, incoming, from) {
  const merged = nodes.slice();
  const indexOf = new Map(merged.map((n, i) => [n.id, i]));
  for (const node of incoming.nodes) {
    if (indexOf.has(node.id)) continue;
    indexOf.set(node.id, merged.length);
    merged.push({ ...node, from });
  }
  const mergedLinks = links.slice();
  const at = new Map(links.map((l, i) => [`${l.source}-${l.target}`, i]));
  for (const link of incoming.links) {
    const a = indexOf.get(incoming.nodes[link.source]?.id);
    const b = indexOf.get(incoming.nodes[link.target]?.id);
    if (a === undefined || b === undefined) continue;
    const key = `${a}-${b}`;
    const i = at.get(key);
    if (i !== undefined) {

      const have = mergedLinks[i].kinds ?? [];
      const extra = (link.kinds ?? []).filter((kind) => !have.includes(kind));
      if (extra.length > 0) mergedLinks[i] = { ...mergedLinks[i], kinds: [...have, ...extra] };
      continue;
    }
    at.set(key, mergedLinks.length);
    mergedLinks.push({ source: a, target: b, kinds: link.kinds, from });
  }
  return { nodes: merged, links: mergedLinks };
}

export function without(nodes, links, gone) {
  const kept = nodes.filter((n) => !gone.has(n.id));
  const index = new Map(kept.map((n, i) => [n.id, i]));
  const remapped = [];
  for (const link of links) {
    const i = index.get(nodes[link.source]?.id);
    const j = index.get(nodes[link.target]?.id);
    if (i !== undefined && j !== undefined) {
      remapped.push({ source: i, target: j, kinds: link.kinds, from: link.from });
    }
  }
  return { nodes: kept, links: remapped };
}

export function withoutKinds(links, hidden) {
  if (hidden.length === 0) return links;
  const off = new Set(hidden);
  const out = [];
  for (const link of links) {
    const kinds = link.kinds ?? [];
    if (kinds.length === 0) { out.push(link); continue; }
    const kept = kinds.filter((kind) => !off.has(kind));
    if (kept.length === 0) continue;
    out.push(kept.length === kinds.length ? link : { ...link, kinds: kept });
  }
  return out;
}

export function kindCensus(items, kindsOf) {
  const tally = new Map();
  for (const item of items) {
    for (const kind of kindsOf(item)) tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({ kind, count }));
}

export const ALL_KINDS = "__all__";

export const nextHidden = (hidden, kind, census) => {
  if (kind === ALL_KINDS) {
    const here = new Set(census.map((c) => c.kind));
    return hidden.some((k) => here.has(k))
      ? hidden.filter((k) => !here.has(k))
      : [...hidden, ...here];
  }
  return hidden.includes(kind) ? hidden.filter((k) => k !== kind) : [...hidden, kind];
};

export const SEVERITIES = ["critical", "high", "medium", "low"];

const isFinding = (query) => SEVERITIES.includes(query.severity);

export const withCounts = (queries, counts) => {
  const by = new Map((counts ?? []).map((c) => [c.id, c]));
  return queries.map((q) => {
    const found = by.get(q.id);
    return { ...q, count: found?.count, counting: found?.counting ?? "objects" };
  });
};

export const severityTally = (queries) => {
  const tally = Object.create(null);
  for (const s of SEVERITIES) tally[s] = 0;
  for (const q of queries) if (isFinding(q) && q.count > 0) tally[q.severity] += 1;
  return tally;
};

const isReported = (query) => isFinding(query) && query.count > 0;

export const byGravity = (queries) => queries
  .filter(isReported)
  .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || b.count - a.count || a.title.localeCompare(b.title));

export function sections(queries) {
  const out = [];
  for (const query of queries) {
    const last = out[out.length - 1];
    if (last && last[0] === query.section) last[1].push(query);
    else out.push([query.section, [query]]);
  }
  return out;
}

export function atTermStart(before) {
  const head = String(before ?? "").replace(/\s+$/, "");
  return head === "" || head.endsWith("(") || /(^|[\s(])(shared\s+with|plus|minus)$/i.test(head);
}

export function splitTerms(script) {
  const source = String(script ?? "");
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  let op = null;
  const push = (end, nextOp, nextStart) => {

    const raw = source.slice(start, end);
    out.push({ op, text: raw.trim(), from: start + (raw.length - raw.trimStart().length) });
    op = nextOp;
    start = nextStart;
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") { depth += 1; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || !/\s/.test(c)) continue;

    const rest = source.slice(i + 1);
    const word = /^(shared\s+with|plus|minus)(?=\s|$)/i.exec(rest);
    if (!word) continue;
    push(i, word[1].toLowerCase().replace(/\s+/g, " "), i + 1 + word[0].length);
    i += word[0].length;
  }
  push(source.length, null, source.length);
  return out.filter((term, i) => term.text.length > 0 || i === 0);
}

const joinTerms = (terms) => terms
  .filter((term) => term.text.trim().length > 0)
  .map((term, i) => (i === 0 ? term.text.trim() : `${term.op ?? "plus"} ${term.text.trim()}`))
  .join("\n");

export const bracketed = (script) => {
  const text = String(script ?? "").trim();
  return splitTerms(text).length > 1 ? `(${text})` : text;
};

export function dropTerm(script, index) {
  const terms = splitTerms(script).filter((_, i) => i !== index);
  if (terms.length > 0) terms[0] = { op: null, text: terms[0].text };
  return joinTerms(terms);
}

const WEIGHTS = Object.freeze({
  impact: { "domain-admins": 1, ca: 0.9, "tier-zero": 0.8 },
  effort: { easy: 1, moderate: 0.6, hard: 0.3, inherent: 0 },
  provenance: { collected: 1, derived: 0.95, asserted: 0.8 },

  nearnessSlope: 0.35,
  mix: { reach: 0.4, nearness: 0.35, quickFix: 0.25 },
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));

const remaining = (path) => (path.steps ?? []).slice(Math.max(0, path.walked ?? 0));

function breakPoint(path) {
  let best = null;
  remaining(path).forEach((step, k) => {
    const ease = WEIGHTS.effort[step.effort] ?? WEIGHTS.effort.moderate;
    if (ease <= 0) return;
    const i = k + Math.max(0, path.walked ?? 0);
    const choke = step.choke ?? 0;
    if (!best || ease > best.ease || (ease === best.ease && choke > best.choke)) best = { index: i, step, ease, choke };
  });
  return best;
}

export function priority(path, population = 0) {
  const left = remaining(path);
  if (path.targetOwned || left.length === 0) {
    return { score: 0, impact: 0, reach: 0, nearness: 0, quickFix: 0, confidence: 1, at: null, done: true, standing: false };
  }

  if (path.standing) {
    return { score: 0, impact: 0, reach: 0, nearness: 0, quickFix: 0, confidence: 1, at: null, done: false, standing: true };
  }
  const impact = WEIGHTS.impact[path.reached] ?? WEIGHTS.impact["tier-zero"];

  const most = Math.max(path.startChoke ?? 0, ...left.map((s) => s.choke ?? 0));
  const reach = population > 0 ? clamp01(Math.log1p(most) / Math.log1p(population)) : 0;
  const nearness = 1 / (1 + WEIGHTS.nearnessSlope * (left.length - 1));
  const at = breakPoint(path);
  const quickFix = at ? at.ease : 0;
  const confidence = left.reduce((c, s) => c * (WEIGHTS.provenance[s.provenance] ?? 1), 1);
  const { mix } = WEIGHTS;
  const score = Math.round(100 * impact * confidence * (mix.reach * reach + mix.nearness * nearness + mix.quickFix * quickFix));
  return { score, impact, reach, nearness, quickFix, confidence, at, done: false, standing: false };
}

export function byPriority(paths, population = 0) {
  return paths
    .map((path) => ({ path, rank: priority(path, population) }))

    .sort((a, b) => Number(a.rank.standing) - Number(b.rank.standing)
      || b.rank.score - a.rank.score
      || (a.path.steps.length - a.path.walked) - (b.path.steps.length - b.path.walked)
      || `${a.path.startId}|${a.path.targetId}`.localeCompare(`${b.path.startId}|${b.path.targetId}`));
}

export const TERMS = [
  ["impact", "Impact", "What is lost if this route is used"],
  ["reach", "Spread", "How many others route through the same objects"],
  ["nearness", "Steps remaining", "How little of the route is left"],
  ["quickFix", "Ease of fix", "How easily one change breaks it"],
  ["confidence", "Confidence", "Observed, rather than drawn by a person"],
];

export const ROUTE_TEXT = {

  list: "Routes from owned",

  difficulty: "Difficulty",
  progress: "Progress",

  done: "Completed",

  unknown: "Unknown",
};

export const DIFFICULTY_RANK = { trivial: 1, easy: 1, moderate: 2, hard: 3 };

export function routeFacts(path) {
  const steps = path?.steps ?? [];
  const last = steps[steps.length - 1];
  const walked = Math.min(Math.max(path?.walked ?? 0, 0), steps.length);
  const done = Boolean(path?.targetOwned);
  return {
    key: `${path?.startId}-${path?.targetId}`,
    startKind: path?.startKind,
    startLabel: path?.startLabel,
    targetKind: last?.toKind ?? path?.targetKind ?? "Base",
    targetLabel: last?.toLabel ?? path?.targetLabel,

    reason: path?.targetReason ?? "Target",
    count: steps.length,
    walked,

    left: done ? 0 : Math.max(0, steps.length - walked),
    done,
    difficulty: path?.difficulty ?? null,

    difficultyWord: path?.difficulty ?? ROUTE_TEXT.unknown,
    difficultyRank: done ? 0 : (DIFFICULTY_RANK[path?.difficulty] ?? 2),

    hardestStep: path?.hardestStep ?? null,
    hardestWhy: path?.hardestWhy ?? [],
    difficultyAssumed: Boolean(path?.difficultyAssumed),
  };
}

export function difficultyTitle(facts) {
  const said = facts.hardestWhy.length
    ? `${facts.hardestStep}: ${facts.hardestWhy.join("; ")}`
    : facts.hardestStep
      ? `The hardest step is ${facts.hardestStep}`
      : "Nothing on this route needs doing";
  return facts.difficultyAssumed
    ? `${said} (nothing narrowed it; this is the technique's usual cost)`
    : said;
}

export const progressText = (facts) =>
  (facts.done ? ROUTE_TEXT.done : `${facts.left} of ${facts.count} left`);

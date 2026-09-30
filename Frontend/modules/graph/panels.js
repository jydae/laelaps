import { html, useRef, useState, useDismiss, useEscape, Button, Popover, dropdown, Menu, MenuItem, MenuDivider, ContextMenuPopover, zoomOf, mark, useEffect, useMemo, Fragment, ButtonGroup, Tabs, Tab, Tag, EditableText, Section, SectionCard, Table, TextArea, Dialog, DialogBody, DialogFooter, NonIdealState, Figure, Dismiss, Card, Icon, beginSidePanelResize, resetSidePanelWidth, Mark } from "../../ui/index.js";
import * as api from "../../core/index.js";
import { count, NA } from "../../core/index.js";
import { POINT_STEPS, PAINTS, slug, OwnedFlag, glyphClass } from "./graphView.js";
import { LAYOUTS, shortName } from "./graphLayout.js";
import { ALL_KINDS, KIND_LABELS, priority, byPriority, TERMS, ROUTE_TEXT, routeFacts, difficultyTitle, formatProp, propLabel, edgesByDirection, sections, routeMeta, routeKey, sameRoute, zoneOrigin, DOMAIN_VIEW, isStanding, tierLabel, CROSSING_LABELS, SEVERITIES, severityTally, byGravity, withCounts, table } from "./graphModel.js";

export const viewRows = ({ full, labels, tinted, kinds, pointScale, edgeCensus, hiddenEdgeKinds, census, hiddenKinds, layoutMode, fixedLayout = null }) => {
  const groups = [];

  groups.push([{ id: "full", label: "Fullscreen", selected: full, act: { kind: "full", value: !full } }]);

  const current = LAYOUTS.find((l) => l.id === (fixedLayout ?? layoutMode)) ?? LAYOUTS[0];
  groups.push([
    {
      id: "layout", label: `Layout: ${current.label}`, disabled: Boolean(fixedLayout),
      items: LAYOUTS.flatMap((l, i) => [
        ...(i > 0 && l.group !== LAYOUTS[i - 1].group ? [{ divider: true }] : []),
        { id: l.id, label: l.label, selected: l.id === current.id, act: { kind: "layout", value: l.id } },
      ]),
    },
    { id: "rearrange", label: "Rearrange", act: { kind: "rearrange" }, disabled: Boolean(fixedLayout) },
  ]);

  groups.push([
    { id: "labels", label: "Names", selected: labels !== "none", sticky: true, act: { kind: "labels", value: labels === "none" ? "auto" : "none" } },
    { id: "tint", label: "Colour by kind", selected: tinted, sticky: true, act: { kind: "tint", value: !tinted } },
    { id: "kinds", label: "Kind under name", selected: kinds, sticky: true, act: { kind: "kinds", value: !kinds } },
  ]);

  const step = POINT_STEPS.indexOf(pointScale);
  groups.push([
    ...(step < POINT_STEPS.length - 1 ? [{ id: "bigger", label: "Increase node size", sticky: true, act: { kind: "pointScale", value: POINT_STEPS[step + 1] } }] : []),
    ...(step > 0 ? [{ id: "smaller", label: "Decrease node size", sticky: true, act: { kind: "pointScale", value: POINT_STEPS[step - 1] } }] : []),
  ]);

  const censusRows = (id, noun, all, hidden, kind, coloured = false) => {
    const off = all.filter((c) => hidden.includes(c.kind)).length;
    return {
      id,
      label: off === 0 ? noun : `${all.length - off} of ${all.length} ${noun.toLowerCase()}`,
      items: [
        { id: ALL_KINDS, label: off === 0 ? "Hide all" : "Show all", sticky: true, act: { kind, value: ALL_KINDS } },
        ...all.map((c) => ({
          id: c.kind, label: KIND_LABELS[c.kind] ?? c.kind, note: count(c.count),
          ...(coloured ? { swatch: c.kind } : {}),
          selected: !hidden.includes(c.kind), sticky: true, act: { kind, value: c.kind },
        })),
      ],
    };
  };
  const drawn = [];
  if (edgeCensus.length > 0) drawn.push(censusRows("edge-kinds", "Relationships", edgeCensus, hiddenEdgeKinds, "edgeKind"));
  if (census.length > 0) drawn.push(censusRows("object-kinds", "Objects", census, hiddenKinds, "kind", tinted));
  if (drawn.length > 0) groups.push(drawn);

  return groups.flatMap((rows, i) => (i === 0 ? rows : [{ divider: true }, ...rows]));
};

const menuItems = (rows, onAct, dismiss) => rows.map((row, i) => {
  if (row.divider) return html`<${MenuDivider} key=${`d${i}`} title=${row.title} />`;

  if (row.dabs) {
    return html`<li key=${row.id ?? i} className="paint-strip" role="group" aria-label=${row.label}>
      ${row.dabs.map((dab) => html`<button key=${dab.id} type="button"
        className=${`paint-dab${dab.paint ? "" : " paint-dab--clear"}${dab.selected ? " is-on" : ""}`}
        ${ ""}
        style=${dab.paint ? { background: dab.paint === "white" ? "var(--fg)" : `var(--paint-${dab.paint})` } : null}
        title=${dab.label} aria-label=${dab.label} aria-pressed=${Boolean(dab.selected)}
        onClick=${() => { onAct(dab.act); dismiss?.(); }} />`)}
    </li>`;
  }
  if (row.items) {
    return html`<${MenuItem} key=${row.id} text=${row.label} label=${row.note} disabled=${row.disabled}
      popoverProps=${{ hoverCloseDelay: 120 }}>
      ${menuItems(row.items, onAct, dismiss)}
    <//>`;
  }

  const text = row.swatch
    ? html`<span className="kind-row"><span className="kind-swatch"
        style=${{ background: `var(--k-${slug(row.swatch)}, var(--line-strong))` }} />${row.label}</span>`
    : row.label;
  return html`<${MenuItem} key=${row.id ?? i} text=${text} label=${row.note}
    roleStructure=${row.selected === undefined ? "menuitem" : "listoption"}
    selected=${row.selected}
    disabled=${row.disabled}
    shouldDismissPopover=${!row.sticky}
    onClick=${() => onAct(row.act)} />`;
});

export function ViewMenu({ rows, onAct }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, open, () => setOpen(false), { portal: ".bp5-popover" });
  return html`<span ref=${ref}><${Popover} ...${dropdown} isOpen=${open}
    onInteraction=${(next) => setOpen(next)}
    content=${html`<${Menu}>${menuItems(rows, onAct, () => setOpen(false))}<//>`}>
    <${Button} text="View" rightIcon=${mark(open ? "chevron-up" : "chevron-down")} active=${open} />
  <//></span>`;
}

const aroundRows = (around) => {
  if (around === null) return [{ id: "around-wait", label: "Expand by…", disabled: true, note: "counting" }];
  if (around.length === 0) return [];

  const item = (row) => ({
    id: `${row.kind}-${row.direction}`,
    label: `${row.direction === "out" ? "\u2192" : "\u2190"} ${row.technique}`,
    note: count(row.count),
    act: { kind: "expandKind", value: { kind: row.kind, direction: row.direction } },
  });

  const walkable = around.filter((r) => r.traversable);
  const structural = around.filter((r) => !r.traversable);
  return [{
    id: "around",
    label: "Expand by…",
    note: count(around.reduce((n, r) => n + r.count, 0)),
    items: [
      ...walkable.map(item),
      ...(walkable.length > 0 && structural.length > 0 ? [{ divider: true }] : []),
      ...structural.map(item),
    ],
  }];
};

const PAINT_LABELS = { camo: "Camo green" };
const paintLabel = (paint) => PAINT_LABELS[paint] ?? paint[0].toUpperCase() + paint.slice(1);

const paintStrip = (link) => ({
  id: "paints", label: "Paint the line",
  dabs: [
    ...PAINTS.map((paint) => ({
      id: paint, paint, label: paintLabel(paint),
      selected: link.paint === paint, act: { kind: "paint", link: link.index, value: paint },
    })),
    ...(link.paint ? [{ id: "clear", label: "Clear", act: { kind: "paint", link: link.index, value: null } }] : []),
  ],
});

export function CanvasMenu({ at, node, pinned, settings, around, link, onClose, onAct }) {
  const rows = [];
  if (!node && link) {
    rows.push(paintStrip(link));
    rows.push({ divider: true });
  }

  if (node) {
    rows.push(...aroundRows(around));
    rows.push({ id: "hide", label: "Hide", act: { kind: "hide" } });
    rows.push({
      id: "owned", label: node.owned ? "Unmark as owned" : "Mark as owned",
      act: { kind: "assert", change: api.change.owned(node.id, !node.owned) },
    });
    rows.push({
      id: "zone", label: node.tierZero ? "Remove from Tier Zero" : "Add to Tier Zero",
      act: { kind: "assert", change: api.change.zone(node.id, !node.tierZero) },
    });
    if (pinned?.id && pinned.id !== node.id) {
      rows.push({
        id: "link", label: "Add GenericAll edge from path start",
        act: { kind: "assert", change: api.change.link(pinned.id, "GenericAll", node.id) },
      });
    }
    rows.push({ divider: true });
  }
  rows.push(...viewRows(settings));
  useEscape(Boolean(at), onClose);
  const zoom = zoomOf();
  return html`<${ContextMenuPopover} isOpen=${Boolean(at)} isDarkTheme
    targetOffset=${at ? { left: at.x / zoom ** 2, top: at.y / zoom ** 2 } : { left: 0, top: 0 }}
    onClose=${onClose}
    content=${html`<${Menu}>${menuItems(rows, onAct, onClose)}<//>`} />`;
}

const twoLines = (name, note, upper = false) => html`
  <span className=${"lae-item-name" + (upper ? " graph-upper" : "")}>${name}</span>
  ${note && html`<span className="lae-item-note">${note}</span>`}`;

function RoutePath({ path, population = 0 }) {
  const last = path.steps.length - 1;
  const state = (i) => (i < path.walked ? "walked" : i === path.walked ? "current" : "ahead");
  const rank = priority(path, population);
  return html`<div className="route-path">
    <${RoutePriority} rank=${rank} />
    <div className="route-step route-step--from">
      <span className="route-n"></span>
      <span className=${`route-face ${glyphClass(path.startKind)}`}></span>
      <span className="route-body"><span className="route-name mono">${path.startLabel}</span></span>
    </div>
    ${path.steps.map((step, i) => html`
      <div className=${`route-step route-step--${state(i)}`} key=${`${step.toId}-${i}`}>
        <span className="route-n mono">${i + 1}</span>
        <span className=${`route-face ${glyphClass(step.toKind)}` + (i === last ? " route-face--alarm" : "")}></span>
        <span className="route-body">
          <span className="route-name mono">${step.toLabel}</span>
          <span className="label route-edge">${step.edge}</span>
          <span className="route-tech">${step.technique}</span>
          ${ ""}
          ${(step.facts ?? []).map((fact) => html`<span className="route-fact" key=${fact}>${fact}</span>`)}
          ${rank.at?.index === i && html`<span className="route-fix">
            <span className="label">Recommended fix</span>${step.fix}
          </span>`}
        </span>
      </div>`)}
  </div>`;
}

function RoutePriority({ rank }) {
  if (rank.done) return html`<div className="route-priority route-priority--done"><span className="label">Priority</span><span className="mono">Completed</span></div>`;

  if (rank.standing) {
    return html`<div className="route-priority route-priority--standing">
      <span className="label">Via membership</span>
      <span className="route-standing-note">Already effective through group membership, so there is no
        step to take: remove the membership itself.</span>
    </div>`;
  }
  return html`<div className="route-priority">
    <div className="route-priority-head"><span className="label">Priority</span><span className="route-priority-score mono">${rank.score}</span></div>
    ${TERMS.map(([key, name, why]) => html`<div className="route-term" key=${key} title=${why}>
      <span className="route-term-name">${name}</span>
      <span className="route-term-bar"><span style=${{ width: `${Math.round(rank[key] * 100)}%` }} /></span>
      <span className="route-term-value mono">${Math.round(rank[key] * 100)}</span>
    </div>`)}
  </div>`;
}

const StepMeter = ({ path }) => html`<span className="route-meter" aria-label=${`${path.walked} of ${path.steps.length} steps completed`}>
  ${path.steps.map((_, i) => html`<span key=${i} className=${"route-meter-step"
    + (path.targetOwned || i < path.walked ? " is-walked" : i === path.walked ? " is-next" : "")} />`)}
</span>`;

const Hardness = ({ path }) => {
  const facts = routeFacts(path);
  return html`<span className=${`hardness hardness--${facts.difficulty}`}
    title=${difficultyTitle(facts)}>
    ${facts.difficultyWord}
  </span>`;
};

function Routes({ routes, population = 0, openRoute, onOpenRoute, onDismissRoute }) {

  const ranked = byPriority(routes, population);
  const tail = (path) => {
    if (path.targetOwned) {
      return html`<${Tag} onRemove=${(e) => { e.stopPropagation(); onDismissRoute(path); }}>Completed<//>`;
    }

    if (isStanding(path)) return html`<${Tag} minimal>Membership<//>`;
    return html`<span className="route-steps mono">${routeMeta(path)} ${path.walked > 0 ? "" : path.steps.length === 1 ? "step" : "steps"}</span>`;
  };
  return html`<section className="routes">
    <header className="routes-head">
      <span className="routes-title"><${Icon} icon="route" size=${14} />${ROUTE_TEXT.list}</span>
      <span className="routes-count mono">${routes.length}</span>
    </header>

    ${ranked.map(({ path, rank }) => html`<${Card} key=${routeKey(path)} interactive
      className=${"route-card" + (sameRoute(openRoute, path) ? " is-on" : "") + (path.targetOwned ? " is-done" : "")
        + (isStanding(path) ? " is-standing" : "")}
      onClick=${() => onOpenRoute(path)}>
      <span className="route-card-ends">
        <span className=${`route-card-face ${glyphClass(routeFacts(path).startKind)}`} />
        <span className="route-card-name">${routeFacts(path).startLabel}</span>
        ${mark("arrow-right")}
        <span className=${`route-card-face ${glyphClass(routeFacts(path).targetKind)}`} />
        <span className="route-card-name">${routeFacts(path).targetLabel}</span>
      </span>
      <span className="route-card-foot"><${StepMeter} path=${path} />
        ${!isStanding(path) && html`<${Hardness} path=${path} />`}
        ${!rank.done && html`<span className="route-card-priority mono" title="Priority: which route to break first">P${rank.score}</span>`}
        ${tail(path)}</span>
    <//>`)}
  </section>`;
}

const Sev = ({ severity }) => html`<span className=${`sev sev--${severity}`}>${severity}</span>`;

const Found = ({ query }) => {
  if (query.count === undefined) return null;
  return html`<span className=${"found mono" + (query.count === 0 ? " found--clear" : "")}
    title=${`${query.count} ${query.counting}`}>${count(query.count)}</span>`;
};

const isEmpty = (query) => query.count === 0;

const One = ({ kind, label, tier, guessed = false }) => html`<span className="pair pair--one">
  <span className=${`pair-face ${glyphClass(kind)}`} /><span className="pair-name" title=${label}>${label}</span>
  ${Number.isFinite(tier) && html`<${Tag} intent=${tier === 0 ? "danger" : "none"}>Tier ${tier}${guessed ? "?" : ""}<//>`}
</span>`;

const PanelNote = ({ icon = "info-sign", children }) => html`<div className="panel-note">
  <${Icon} icon=${icon} size=${13} /><span>${children}</span>
</div>`;

const WayIn = ({ title, n, onOpen }) => html`<${Card} interactive className="way-in" onClick=${onOpen}>
  <span className="way-in-title">${title}</span>
  ${n !== undefined && html`<span className="way-in-count mono">${count(n)}</span>`}
  ${mark("chevron-right")}
<//>`;

const Ways = ({ children }) => html`<div className="ways">${children}</div>`;

const Fold = ({ id, icon, title, right, open, onToggle, still = false, children }) => html`<${Section}
  className=${`lae-fold fold--${id}` + (still ? " lae-fold--still" : "")} compact
  icon=${html`<${Icon} icon=${icon} size=${14} />`} title=${title} rightElement=${right}
  collapsible=${!still} collapseProps=${still ? undefined : { isOpen: open, onToggle }}>
  <${SectionCard} padded=${false}>${children}<//>
<//>`;

const InnerTabs = ({ id, tabs, at, onChange }) => html`<${Tabs} id=${id} className="lae-tabs" animate=${false}
  selectedTabId=${at} onChange=${onChange}>
  ${tabs.map(([key, name, n]) => html`<${Tab} key=${key} id=${key}
    title=${html`<${Fragment}><span>${name}</span>${n !== undefined && html`<span className="mono">${count(n)}</span>`}<//>`} />`)}
<//>`;

function GapStrip({ coverage, open, onToggle }) {
  const gaps = (coverage ?? []).filter((c) => !c.present);
  if (gaps.length === 0) return null;
  return html`<${Fragment}>
    <div className="panel-strip" role="button" tabIndex="0" aria-expanded=${open}
      onClick=${onToggle} onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
      <${Icon} icon="eye-off" size=${13} />
      <span className="label">Not collected</span>
      <span className="panel-strip-what">${gaps.map((g) => g.title).join(", ")}</span>
      <span className="mono">${gaps.length}</span>
      <${Mark} name=${open ? "chevron-down" : "chevron-right"} />
    </div>
    ${open && html`<${Menu} className="lae-list">
      ${gaps.map((g) => html`<${MenuItem} key=${g.id} multiline
        text=${twoLines(g.title, g.costs, true)} />`)}
    <//>`}
  <//>`;
}

function ZonesBody({ report, at, onTab, onOpenCrossing, onOpenNode }) {
  const { crossings = [], total = 0, truncated = false, inferred = [] } = report ?? {};
  const tabs = [["crossings", "Tier violations", total], ["names", "Tier inferred from name", inferred.length]];
  return html`<${Fragment}>
    <${InnerTabs} id="zones" tabs=${tabs} at=${at} onChange=${onTab} />
    ${at === "crossings" && html`<${Menu} className="lae-list">
      ${crossings.map((crossing, i) => html`<${MenuItem} key=${`${crossing.sourceId}|${crossing.edge}|${crossing.targetId}|${i}`}
        multiline className=${"cross" + (crossing.inferred ? " is-inferred" : "")}
        title=${(CROSSING_LABELS[crossing.sort] ?? "")
          + (crossing.inferred ? ". One end's tier was read from its name; confirm it." : "")}
        onClick=${() => onOpenCrossing(crossing)}
        text=${html`<${Fragment}>
          ${ ""}
          <span className="cross-ends">
            <${One} kind=${crossing.sourceKind} label=${crossing.sourceLabel} tier=${crossing.sourceTier} guessed=${crossing.inferred} />
            <span className="cross-to">${mark("arrow-right")}<${One} kind=${crossing.targetKind} label=${crossing.targetLabel} tier=${crossing.targetTier} guessed=${crossing.inferred} /></span>
          </span>
          <span className="lae-item-note">${crossing.technique}</span>
        <//>`} />`)}
      ${truncated && html`<${PanelNote}>Showing the worst ${crossings.length} of ${count(total)}.<//>`}
    <//>`}
    ${at === "names" && html`<${Menu} className="lae-list">
      ${inferred.map((i) => html`<${MenuItem} key=${i.id} multiline label="Unconfirmed"
        onClick=${() => onOpenNode?.(i.id)} text=${twoLines(i.label, i.reason, true)} />`)}
    <//>`}
  <//>`;
}

const ZonesWays = ({ report, onOpenAt }) => html`<${Ways}>
  <${WayIn} title="Tier violations" n=${report?.total ?? 0} onOpen=${() => onOpenAt("crossings")} />
  <${WayIn} title="Tier inferred from name" n=${report?.inferred?.length ?? 0} onOpen=${() => onOpenAt("names")} />
<//>`;

const KIND_ONE = table({
  User: "User", Group: "Group", Computer: "Computer", Domain: "Domain",
  OU: "Organizational unit", GPO: "Group policy object", Container: "Container",
  CertTemplate: "Certificate template", EnterpriseCA: "Enterprise CA", RootCA: "Root CA",
  AIACA: "AIA CA", NTAuthStore: "NTAuth store", IssuancePolicy: "Issuance policy", Base: "Object",
});

const RIGHT_SAYS = table({
  GenericAll: "take the object outright",
  GenericWrite: "write its attributes",
  WriteDacl: "rewrite its permissions",
  WriteOwner: "take ownership",
  Owns: "owns it",
  OwnsLimitedRights: "owns it, limited to what the DACL names",
  WriteOwnerLimitedRights: "take ownership, limited to what the DACL names",
  ForceChangePassword: "reset its password",
  AddMember: "add members to it",
  AddKeyCredentialLink: "give it a key of its own",
  WriteAltSecurityIdentities: "map a certificate to it",
  WritePublicInformation: "write the attributes that decide how it authenticates",
  AllExtendedRights: "every extended right on it",
  WriteGPLink: "link a policy to it",
  CreateChild: "create objects under it",
});

const DELEGATIONS_PAGE = 25;

function indexDelegations(rows, by) {
  const groups = [];
  const at = new Map();
  for (const row of rows) {
    const key = by === "trustee" ? row.principal : row.target;
    if (!at.has(key)) {
      at.set(key, groups.length);
      groups.push({
        key,
        label: by === "trustee" ? row.principalLabel : row.targetLabel,
        kind: by === "trustee" ? row.principalKind : row.targetKind,
        tier: by === "trustee" ? row.principalTier : row.targetTier,
        crossing: 0, objects: 0, rights: [], rightAt: new Map(),
      });
    }
    const group = groups[at.get(key)];
    if (row.crosses) group.crossing += 1;
    group.objects += 1;
    for (const right of row.rights) {
      if (!group.rightAt.has(right)) {
        group.rightAt.set(right, group.rights.length);
        group.rights.push({ right, rows: [] });
      }
      group.rights[group.rightAt.get(right)].rows.push(row);
    }
  }
  groups.sort((a, b) => b.crossing - a.crossing || b.objects - a.objects);
  return groups;
}

function DelegationsWays({ report, onOpenAt }) {
  const rows = report?.rows ?? null;
  const trustees = rows ? new Set(rows.map((row) => row.principal)).size : 0;
  const objects = rows ? new Set(rows.map((row) => row.target)).size : 0;
  return html`<${Fragment}>
    <${Ways}>
      <${WayIn} title="By trustee" n=${trustees} onOpen=${rows && (() => onOpenAt("trustee"))} />
      <${WayIn} title="By resource" n=${objects} onOpen=${rows && (() => onOpenAt("resource"))} />
    <//>
  <//>`;
}

const DelegEntity = ({ id, label, kind, tier, note, large, onOpen, tally }) => html`<${Fragment}>
  <span className=${`deleg-face ${glyphClass(kind)}` + (large ? " deleg-face--lg" : "")} />
  <span className="deleg-entity">
    <span className="deleg-entity-line">
      ${onOpen
        ? html`<button type="button" className="deleg-name graph-upper" title=${`Open ${label}`}
            onClick=${() => onOpen(id)}>${label}</button>`
        : html`<span className="deleg-name deleg-name--plain graph-upper">${label}</span>`}
      ${Number.isFinite(tier) && html`<${Tag} className="deleg-tier"
        intent=${tier === 0 ? "danger" : "none"}>Tier ${tier}<//>`}
      ${tally}
    </span>
    <span className="deleg-entity-sub">${note ?? KIND_ONE[kind] ?? kind}</span>
  </span>
<//>`;

function DelegationsBody({ report, at, onTab, onOpenNode }) {
  const [shown, setShown] = useState(null);
  const [page, setPage] = useState(0);
  const rows = report?.rows ?? [];
  const groups = useMemo(() => indexDelegations(rows, at), [rows, at]);
  const trustees = useMemo(() => new Set(rows.map((row) => row.principal)).size, [rows]);
  const objects = useMemo(() => new Set(rows.map((row) => row.target)).size, [rows]);
  const tabs = [["trustee", "Trustees", trustees], ["resource", "Resources", objects]];
  const pivot = (next) => { onTab(next); setShown(null); setPage(0); };
  const pages = Math.max(1, Math.ceil(groups.length / DELEGATIONS_PAGE));
  const here = Math.min(page, pages - 1);
  const shownGroups = groups.slice(here * DELEGATIONS_PAGE, (here + 1) * DELEGATIONS_PAGE);

  return html`<div className="deleg-level">
    <${InnerTabs} id="delegations" tabs=${tabs} at=${at} onChange=${pivot} />
    ${groups.length === 0 && html`<${PanelNote}>Nothing set by hand. Every permission in this database is the directory's own.<//>`}
    ${shownGroups.map((group) => {
      const isOpen = shown === group.key;
      return html`<${Fragment} key=${group.key}>
        <div className=${"deleg-row deleg-row--head" + (isOpen ? " is-open" : "")}
          role="button" tabIndex=${0}
          onClick=${() => setShown(isOpen ? null : group.key)}
          onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShown(isOpen ? null : group.key); } }}>
          <${Mark} name=${isOpen ? "chevron-down" : "chevron-right"} className="deleg-chevron" />
          <${DelegEntity} label=${group.label} kind=${group.kind} tier=${group.tier} large
            tally=${html`<span className="deleg-tally mono">
              ${group.crossing > 0 && html`<em>${count(group.crossing)} into Tier 0</em>`}
              <span>${count(group.objects)} object${group.objects === 1 ? "" : "s"}</span>
            </span>`} />
        </div>
        ${isOpen && group.rights.map(({ right, rows: held }) => html`<${Fragment} key=${right}>
          <div className="deleg-row deleg-row--right">
            <span className="deleg-right">
              <span className="deleg-right-name mono">${right}</span>
              <span className="deleg-right-says">${RIGHT_SAYS[right] ?? ""}</span>
              <span className="deleg-right-count mono">${count(held.length)}</span>
            </span>
          </div>
          ${held.map((row) => {
            const far = at === "trustee"
              ? { id: row.target, label: row.targetLabel, kind: row.targetKind, tier: row.targetTier }
              : { id: row.principal, label: row.principalLabel, kind: row.principalKind, tier: row.principalTier };

            const note = row.reaches > 0 ? `${count(row.reaches)} objects under it` : (KIND_ONE[far.kind] ?? far.kind);
            return html`<div key=${`${row.principal}|${row.target}`}
              className="deleg-row deleg-row--object">
              <${DelegEntity} ...${far} note=${note} onOpen=${onOpenNode} />
            </div>`;
          })}
        <//>`)}
      <//>`;
    })}

    ${ ""}
    ${pages > 1 && html`<div className="deleg-pages">
      ${here > 0
        ? html`<${Button} minimal small icon=${mark("chevron-left")} text="Back"
            onClick=${() => { setPage(here - 1); setShown(null); }} />`
        : html`<span />`}
      <span className="deleg-pages-at mono">${`${here + 1} of ${pages}`}</span>
      ${here < pages - 1
        ? html`<${Button} minimal small rightIcon=${mark("chevron-right")} text="Next"
            onClick=${() => { setPage(here + 1); setShown(null); }} />`
        : html`<span />`}
    </div>`}
  </div>`;
}

const Tally = ({ queries }) => {
  const tally = severityTally(queries);
  return html`<span className="sev-tally">
    ${SEVERITIES.filter((s) => tally[s] > 0).map((s) => html`<span key=${s} className=${`tally tally--${s}`} title=${`${tally[s]} ${s}`}>
      <span className="tally-bar" /><span className="mono">${tally[s]}</span>
    </span>`)}
  </span>`;
};

const FindingsList = ({ queries, activeQuery, onRunQuery }) => html`<${Menu} className="lae-list">
  ${byGravity(queries).map((q) => {
    const on = activeQuery === q.id;
    return html`<${MenuItem} key=${q.id} multiline=${on} className="finding-row"
      active=${on} onClick=${() => onRunQuery(q)}
      text=${html`<${Fragment}>
        <span className="finding-head">
          <${Sev} severity=${q.severity} />
          <span className="lae-item-name graph-upper">${q.title}</span>
          <${Found} query=${q} />
        </span>
        ${on && html`<${Fragment}>
          <span className="lae-item-note">${q.description}</span>
          ${q.remedy && html`<span className="lae-item-note finding-remedy"><span className="label">Fix</span>${q.remedy}</span>`}
        <//>`}
      <//>`} />`;
  })}
<//>`;

const FOLDS = [
  ["zones", "layers", "Privilege zones"],
  ["delegations", "key", "ACL delegations"],
];

function FoldBody({ id, all, props, tabs, onTab }) {
  const onOpenAt = (tab) => { onTab(id, tab); props.onOpenLevel(id); };

  if (props[id]?.failed) return html`<${PanelNote} icon="warning-sign">This report could not be loaded.<//>`;
  if (id === "zones") {
    return all
      ? html`<${ZonesBody} report=${props.zones} at=${tabs.zones} onTab=${(t) => onTab("zones", t)}
          onOpenCrossing=${props.onOpenCrossing} onOpenNode=${props.onOpenNode} />`
      : html`<${ZonesWays} report=${props.zones} onOpenAt=${onOpenAt} />`;
  }
  if (id === "delegations") {
    return all
      ? html`<${DelegationsBody} report=${props.delegations} at=${tabs.delegations} onTab=${(t) => onTab("delegations", t)}
          onOpenNode=${props.onOpenNode} />`
      : html`<${DelegationsWays} report=${props.delegations} onOpenAt=${onOpenAt} />`;
  }
  return null;
}

function SavedMenu({ filter, open, onOpen, onClose, onRun, onEdit, onRename, onCopy, onDelete }) {
  const anchor = useRef(null);

  useDismiss(anchor, open, onClose, { portal: ".bp5-popover" });
  const act = (fn) => () => { onClose(); fn(filter); };

  return html`<span ref=${anchor} className="saved-row-end" onClick=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => e.stopPropagation()}>
    <${Popover} isOpen=${open} placement="bottom-end" minimal
      modifiers=${{ offset: { enabled: true, options: { offset: [0, 2] } } }}
      onInteraction=${(next) => (next ? onOpen() : onClose())}
      content=${html`<${Menu}>
        <${MenuItem} icon="play" text="Run" onClick=${act(onRun)} />
        <${MenuItem} icon="code" text="Edit script" onClick=${act(onEdit)} />
        <${MenuItem} icon="edit" text="Rename" onClick=${act(onRename)} />
        <${MenuItem} icon="duplicate" text="Copy script" onClick=${act(onCopy)} />
        <${MenuDivider} />
        <${MenuItem} icon="trash" text="Delete" intent="danger" onClick=${act(onDelete)} />
      <//>`}>
      <${Button} small className="saved-row-more" icon=${mark("chevron-down")}
        aria-label=${`Actions for ${filter.title}`} title="Actions" />
    <//>
  </span>`;
}

function FilterBody(props) {
  const { level, databases } = props;

  const queries = useMemo(() => withCounts(props.queries ?? [], props.findings),
    [props.queries, props.findings]);

  const [menuFor, setMenuFor] = useState(null);
  const [doomed, setDoomed] = useState(null);

  const asked = useRef(null);
  if (doomed) asked.current = doomed;

  if (level === "databases") {
    if (databases.length === 0) {
      return html`<${NonIdealState} title="No databases"
        description=${props.listFault ?? "Upload a collector's JSON files in the Ingestor tab."} />`;
    }
    return html`<${Menu} className="lae-list">
      ${databases.map((db) => html`<${MenuItem} key=${db.id} multiline
        text=${twoLines(db.name, `${db.fileCount} files, ${count(db.nodeCount)} nodes`)}
        onClick=${() => props.onPickDatabase(db)} />`)}
    <//>`;
  }

  if (level === "zones" || level === "delegations") {
    return html`<div className="fold-level">
      <${FoldBody} id=${level} all props=${{ ...props, queries }} tabs=${props.tabs} onTab=${props.onTab} />
    </div>`;
  }

  if (level === "route") {
    return html`<${RoutePath} path=${props.openRoute} population=${props.population} />`;
  }

  const foldCount = (id) => (props[id]?.failed ? html`<span className="mono">${NA}</span>`
    : id === "zones" ? html`<span className="mono">${count(props.zones?.total ?? 0)}</span>`
    : html`<span className="mono">${props.delegations ? count(props.delegations.afterBaseline) : ""}</span>`);

  const listed = queries;

  return html`<${Fragment}>
    ${ ""}
    <${GapStrip} coverage=${props.coverage} open=${props.gapsOpen} onToggle=${props.onToggleGaps} />
    ${ ""}
    ${props.routes.length > 0 && html`<${Routes} routes=${props.routes} population=${props.population} openRoute=${props.openRoute}
      onOpenRoute=${props.onOpenRoute} onDismissRoute=${props.onDismissRoute} />`}
    ${ ""}
    ${FOLDS.map(([id, icon, title]) => html`<${Fold} key=${id} id=${id} icon=${icon} title=${title}
      right=${foldCount(id)} open=${props.folds.has(id)} onToggle=${() => props.onToggleFold(id)}>
      <${FoldBody} id=${id} all=${false} props=${{ ...props, queries }} tabs=${props.tabs} onTab=${props.onTab} />
    <//>`)}
    ${ ""}
    <${Fold} id="findings" icon="warning-sign" title="Findings" right=${html`<${Tally} queries=${queries} />`}
      open=${props.folds.has("findings")} onToggle=${() => props.onToggleFold("findings")}>
      <${FindingsList} queries=${queries} activeQuery=${props.activeQuery} onRunQuery=${props.onRunQuery} />
    <//>
    ${ ""}
    <${Fold} id="filters" icon="filter" title="Filters" still
      right=${html`<span className="mono">${count(listed.length + 1 + (props.savedFilters?.length ?? 0))}</span>`}>
    <${Menu} className="lae-list filters">
    ${ ""}
    ${props.savedFilters?.length > 0 && html`<${Fragment}>
      <${MenuDivider} title=${html`<span className="saved-head">Almanac<span className="saved-head-count mono">${props.savedFilters.length}</span></span>`} />
      ${props.savedFilters.map((f) => {
        const on = props.activeQuery === `saved:${f.id}`;

        const text = html`<span className="lae-item-name graph-upper">${f.title}</span>
          ${f.description
            ? html`<span className="lae-item-note">${f.description}</span>`
            : html`<span className="lae-item-note saved-row-sentence mono">${f.body?.source ?? f.body?.script}</span>`}`;
        return html`<${MenuItem} key=${f.id} multiline text=${text}
          className=${"saved-row" + (on ? " is-on" : "") + (menuFor === f.id ? " is-menu" : "")}
          title=${f.body?.script} active=${on} onClick=${() => props.onRunSaved(f)}
          onContextMenu=${(e) => { e.preventDefault(); setMenuFor(f.id); }}
          labelElement=${html`<${SavedMenu} filter=${f} open=${menuFor === f.id}
            onOpen=${() => setMenuFor(f.id)} onClose=${() => setMenuFor((id) => (id === f.id ? null : id))}
            onRun=${props.onRunSaved} onEdit=${props.onEditSaved} onRename=${props.onRenameSaved}
            onCopy=${props.onCopySaved} onDelete=${setDoomed} />`} />`;
      })}
    <//>`}
    <${MenuItem} multiline text=${twoLines("Full domain", "Every relationship in this database", true)}
      active=${props.activeQuery === DOMAIN_VIEW && !props.openRoute} onClick=${() => props.onFullDomain()} />
    ${ ""}
    ${ ""}
    ${sections(listed).map(([name, group]) => html`<${Fragment} key=${name}>
      <${MenuDivider} title=${name} />
      ${group.map((q) => html`<${MenuItem} key=${q.id} multiline
        className=${"filter-row" + (isEmpty(q) ? " is-clear" : "")}
        text=${html`<span className="lae-item-name graph-upper">${q.title}</span>
          <span className="lae-item-note">${q.description}</span>`}
        labelElement=${html`<${Found} query=${q} />`}
        active=${props.activeQuery === q.id} onClick=${() => props.onRunQuery(q)} />`)}
    <//>`)}
  <//>
  <//>
  ${ ""}
  <${Dialog} isOpen=${Boolean(doomed)} onClose=${() => setDoomed(null)}
    className="lae-dialog lae-dialog--danger almanac-dialog" title="Delete from Almanac" icon="trash">
    <${DialogBody}>
      <div className="almanac-doomed">
        <span className="label">Entry</span>
        <div className="almanac-doomed-entry">
          <div className="almanac-doomed-name graph-upper">${asked.current?.title}</div>
          <div className="almanac-doomed-script mono">${asked.current?.body?.source ?? asked.current?.body?.script}</div>
        </div>
      </div>
      <p className="almanac-doomed-note">This permanently deletes the entry and its kept view.</p>
    <//>
    <${DialogFooter} actions=${html`<${Button} text="Cancel" autoFocus onClick=${() => setDoomed(null)} />
      <${Button} intent="danger" text="Delete" onClick=${() => { props.onDeleteSaved(doomed); setDoomed(null); }} />`} />
  <//>
  <//>`;
}

const ResizeHandle = ({ right = false }) => html`<div className=${"side-resize" + (right ? " side-resize--right" : "")}
  onMouseDown=${(e) => (right ? beginSidePanelResize(e, -1, "--panel-w-right") : beginSidePanelResize(e))}
  onDblClick=${(e) => (right ? resetSidePanelWidth(e, "--panel-w-right") : resetSidePanelWidth(e))}
  title="Drag to resize, double-click to reset"></div>`;

export function FilterPanel({ open, level, heading, onBack, ...body }) {

  const [folds, setFolds] = useState(() => new Set(["findings"]));
  const [tabs, setTabs] = useState({ zones: "crossings", delegations: "trustee" });
  const [gapsOpen, setGapsOpen] = useState(false);
  const onToggleFold = (id) => setFolds((was) => { const next = new Set(was); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const onTab = (id, tab) => setTabs((was) => ({ ...was, [id]: tab }));
  const state = { folds, onToggleFold, tabs, onTab, gapsOpen, onToggleGaps: () => setGapsOpen((v) => !v) };
  return html`<div className=${"side-panel" + (open ? " side-panel--open" : "")}>
    <div className="side-panel-head">
      ${level === "databases"
        ? html`<span className="label">Databases</span>`
        : html`<${Button} icon=${mark("chevron-left")} text="Back" onClick=${onBack} />`}
      <span className="side-panel-title label mono">${heading}</span>
    </div>
    <div className="side-panel-body">
      <${FilterBody} key=${level + (body.databaseId ?? "")} level=${level} ...${body} ...${state} />
    </div>
    <${ResizeHandle} />
  </div>`;
}

function ObjectHead({ detail, history, busy, onApply }) {
  const [namesOpen, setNamesOpen] = useState(false);

  const older = (history ?? [])
    .filter((h) => h.op === "rename" && h.subject === detail.id && !h.supersededBy && h.value.label !== detail.label)
    .map((h) => h.value.label);
  const collected = detail.labelObserved && detail.labelObserved !== detail.label ? detail.labelObserved : null;
  const hasNames = older.length > 0 || collected !== null;

  const [name, setName] = useState(detail.label);
  useEffect(() => setName(detail.label), [detail.id, detail.label]);

  return html`<${Fragment}>
    <div className="panel-title">
      ${ ""}
      <span aria-hidden="true"
        className=${`panel-title-glyph ${glyphClass(detail.kind)}` + (detail.tierZero ? " panel-title-glyph--alarm" : "")}>
        ${detail.owned && html`<${OwnedFlag} />`}
      </span>
      <div className="panel-title-text">
        <div className="panel-title-row">
          <span className="panel-title-name" title=${detail.label}>
            <${EditableText} value=${name} disabled=${busy} selectAllOnFocus placeholder="Name"
              onChange=${setName}
              onCancel=${() => setName(detail.label)}
              onConfirm=${(value) => {
                const next = value.trim();
                if (!next || next === detail.label) { setName(detail.label); return; }
                onApply(api.change.rename(detail.id, next)).then((ok) => { if (!ok) setName(detail.label); });
              }} />
          </span>
          <span className="panel-title-tags">
            ${detail.tierZero && html`<${Tag} intent="danger"
              title=${zoneOrigin(detail) + (detail.zoneTier === 0 ? `: ${detail.zoneTierReason || tierLabel(0)}` : "")}>Tier Zero<//>`}
            ${ ""}
            ${Number.isFinite(detail.zoneTier) && !(detail.tierZero && detail.zoneTier === 0) && html`<${Tag}
              intent=${detail.zoneTier === 0 ? "danger" : "none"}
              title=${(detail.zoneTierReason || tierLabel(detail.zoneTier))
                + (detail.zoneTierInferred ? " (read from the name, not a collected fact)" : "")}>
              Tier ${detail.zoneTier}${detail.zoneTierInferred ? "?" : ""}<//>`}
            ${detail.owned && html`<${Tag} title=${detail.ownedReason || null}>Owned<//>`}
            ${hasNames && html`<${Tag} interactive className="panel-names-toggle" aria-expanded=${namesOpen}
              rightIcon=${mark(namesOpen ? "chevron-down" : "chevron-right")}
              onClick=${() => setNamesOpen(!namesOpen)}>Names<//>`}
          </span>
        </div>
        <div className="label panel-title-kind">${detail.kind}</div>
      </div>
    </div>
    ${hasNames && namesOpen && html`<ul className="name-list mono">
      ${older.map((label) => html`<li key=${label}>${label}</li>`)}
      ${collected && html`<li>${collected}<span className="label">collected</span></li>`}
    </ul>`}
  <//>`;
}

const DIRECTIONS = [["out", "Outbound", "arrow-right"], ["in", "Inbound", "arrow-left"]];

const RelKind = ({ edge }) => html`<span className=${"rel-kind mono" + (edge.derived ? " graph-derived" : "")}
  title=${edge.derived ? "Concluded by analysis, not collected" : null}>${edge.kind}</span>`;

const RelOther = ({ edge }) => html`<span className="rel-other">
  <span className=${`rel-face ${glyphClass(edge.otherKind)}`} aria-hidden="true"></span>
  <span className="rel-name mono">${edge.otherLabel ?? edge.otherId}</span>
</span>`;

const ObjectTable = ({ id, head, interactive = false, keyed = false, children }) => html`<${Table} id=${id}
  interactive=${interactive} keyed=${keyed} columns=${[{ label: head[0], width: 38 }, { label: head[1], width: 62 }]}>
  ${children}
<//>`;

const sentence = (name) => name.charAt(0).toUpperCase() + name.slice(1);

const Properties = ({ properties }) => html`<${ObjectTable} id="object-properties" keyed head=${["Property", "Value"]}>
  <tbody>
    ${properties.map(([key, value]) => html`<tr key=${key}>
      <td>${sentence(propLabel(key))}</td><td className="lae-wrap mono">${formatProp(value, key)}</td>
    </tr>`)}
  </tbody>
<//>`;

const Relationships = ({ edges, onFollow }) => html`<${ObjectTable} id="object-relationships" interactive head=${["Relationship", "Object"]}>
  ${DIRECTIONS.map(([d, title, arrow]) => edges[d].length > 0 && html`<tbody key=${d}>
    <tr className="lae-table-group"><th colSpan="2"><div>
      <span>${mark(arrow)}${title}</span><span className="mono">${edges[d].length}</span>
    </div></th></tr>
    ${edges[d].map((edge, i) => html`<tr key=${i} onClick=${() => onFollow(edge.otherId)}
      title=${`${edge.otherKind}: ${edge.otherLabel ?? edge.otherId}`}>
      <td><${RelKind} edge=${edge} /></td>
      <td><${RelOther} edge=${edge} /></td>
    </tr>`)}
  </tbody>`)}
<//>`;

function ObjectBody({ detail, standing, folds, onFold, onFollow, onApply, busy }) {
  const properties = Object.entries(detail.properties || {}).sort(([a], [b]) => a.localeCompare(b));
  const edges = edgesByDirection(detail.edges);
  const truncated = detail.edgesTruncated ? `${detail.edges.length} of ${count(detail.edgeTotal)} shown` : undefined;

  const note = html`<${TextArea} key=${detail.id} fill rows="3" className="graph-note"
    placeholder="Notes" defaultValue=${detail.notes?.note ?? ""} disabled=${busy}
    onBlur=${(e) => {
      const text = e.target.value.trim();
      if (text !== (detail.notes?.note ?? "")) onApply(api.change.annotate(detail.id, text));
    }} />`;
  const fold = (name, title, props, children) => html`<${Section} className="lae-sheet" title=${title}
    collapsible collapseProps=${{ isOpen: folds[name], onToggle: () => onFold(name) }} ...${props}>
    <${SectionCard} padded=${false}>${children}<//>
  <//>`;

  return html`<div className="side-detail">
    ${ ""}
    <div className="figures standing">
      ${[["Member of", standing?.memberOfUnrolled, standing?.truncated],
         ["Controls", standing?.controlsTransitive, standing?.truncated],
         ["Controlled by", standing?.controlledByTransitive, standing?.truncated],
         ["Reaches Tier Zero", standing?.reachableTierZero, false]]
        .map(([label, n, atLeast]) => html`<${Figure} key=${label} label=${label}
          value=${standing ? (atLeast ? "≥ " : "") + count(n) : NA} />`)}
    </div>

    ${fold("properties", "Properties", { rightElement: count(properties.length) },
      html`<${Properties} properties=${properties} />`)}

    ${fold("relationships", "Relationships", { rightElement: count(detail.edges.length), subtitle: truncated },
      html`<${Relationships} edges=${edges} onFollow=${onFollow} />`)}

    ${fold("notes", "Notes", {}, note)}
  </div>`;
}

const TAB_MIN = 120;
const TAB_MORE = 64;

export function NodePanel({ open, bench, activeNode, details, standings, nodes, onActivate, onDrop,
                            onIsolate, onFollow, history, busy, onApply }) {
  const held = activeNode ? details.get(activeNode) ?? null : null;
  const detail = held?.error ? null : held;
  const drawn = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  const [folds, setFolds] = useState({ properties: true, relationships: true, notes: false });
  const onFold = (name) => setFolds((f) => ({ ...f, [name]: !f[name] }));

  const panelRef = useRef(null);
  const [stripWidth, setStripWidth] = useState(0);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;
    const measure = () => setStripWidth(el.clientWidth);
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    measure();
    return () => watch.disconnect();
  }, []);
  let shownTabs = bench;
  if (stripWidth > 0 && bench.length * TAB_MIN > stripWidth) {
    const room = Math.max(1, Math.floor((stripWidth - TAB_MORE) / TAB_MIN));
    shownTabs = bench.slice(0, room);
    if (activeNode && bench.includes(activeNode) && !shownTabs.includes(activeNode)) {
      shownTabs = [...shownTabs.slice(0, room - 1), activeNode];
    }
  }
  const hiddenTabs = bench.filter((id) => !shownTabs.includes(id));
  const about = (id) => {
    const point = nodes.find((n) => n.id === id);
    return {
      label: details.get(id)?.label ?? point?.label ?? id,
      kind: details.get(id)?.kind ?? point?.kind ?? "Base",
      alarm: details.get(id)?.tierZero ?? point?.tierZero ?? false,
    };
  };

  return html`<div ref=${panelRef} className=${"side-panel side-panel--right" + (open ? " side-panel--open" : "")}>
    <${Tabs} id="bench" className="lae-cells node-tabs" animate=${false} selectedTabId=${activeNode} onChange=${onActivate}>
      ${shownTabs.map((id) => {
        const { label, kind, alarm } = about(id);
        return html`<${Tab} key=${id} id=${id} className=${alarm ? "lae-alarm" : ""}
          title=${html`<span className=${`node-tab-face ${glyphClass(kind)}`} aria-hidden="true"></span>
            <span className="node-tab-name" title=${drawn.has(id) ? label : `${label} (not in the current view)`}>${shortName(label, kind)}</span>
            <${Dismiss} label="Close" onClick=${(e) => { e.stopPropagation(); onDrop(id); }} />`} />`;
      })}
      ${hiddenTabs.length > 0 && html`<span className="node-tabs-more">
        <${Popover} minimal placement="bottom-end" modifiers=${{ offset: { enabled: true, options: { offset: [0, 2] } } }}
          content=${html`<${Menu}>
            ${hiddenTabs.map((id) => {
              const { label, kind } = about(id);
              return html`<${MenuItem} key=${id} className="lae-data" text=${label} label=${kind}
                icon=${html`<span className=${`node-tab-face ${glyphClass(kind)}`} aria-hidden="true"></span>`}
                onClick=${() => onActivate(id)} />`;
            })}
          <//>`}>
          <${Button} minimal className="node-tabs-more-button" text=${`+${hiddenTabs.length}`}
            rightIcon=${mark("chevron-down")} title="More open objects" />
        <//>
      </span>`}
    <//>

    ${detail
      ? html`<${Fragment}>
          <div className="side-panel-head side-panel-head--object">
            <${ObjectHead} detail=${detail} history=${history} busy=${busy} onApply=${onApply} />
          </div>
          <${ButtonGroup} fill className="side-actions">
            <${Button} text="Outbound" title="Show this object and what it controls" onClick=${() => onIsolate("out")} />
            <${Button} text="Inbound" title="Show this object and what controls it" onClick=${() => onIsolate("in")} />
          <//>
          <div className="side-panel-body">
            <${ObjectBody} key=${activeNode} detail=${detail} standing=${standings.get(activeNode)}
              folds=${folds} onFold=${onFold} onFollow=${onFollow} onApply=${onApply} busy=${busy} />
          </div>
        <//>`
      : html`<div className="side-panel-body">
          <${NonIdealState} title=${held?.error ? "Could not load" : "Loading…"}
            description=${held?.error ?? null} />
        </div>`}

    <${ResizeHandle} right />
  </div>`;
}

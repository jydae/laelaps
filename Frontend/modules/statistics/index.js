import { html, useEffect, useRef, useState, useTick, useDismiss, animate, Ornament, Button, Popover, dropdown, Menu, MenuItem, mark, PageSection, KeyValue } from "../../ui/index.js";
import { count, NA, json, listDatabases, useDatabasesChanged, useViewState, defineModule } from "../../core/index.js";
import * as graph from "../graph/index.js";

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : NA);
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "none"];
const bySeverity = (severity) => {
  const rank = SEVERITY_ORDER.indexOf(severity ?? "none");
  return rank < 0 ? SEVERITY_ORDER.length : rank;
};

const Pips = ({ effort }) => {
  const on = graph.DIFFICULTY_RANK[effort] ?? 2;
  return html`<span className="pips" aria-hidden="true">
    ${[0, 1, 2, 3].map((i) => html`<i key=${i} className=${i < on ? "is-on" : ""}></i>`)}
  </span>`;
};

const shorten = (domains) => {
  if (domains.length !== 1) return (label) => label;
  const suffix = domains[0].toUpperCase();
  return (label) => {
    const name = String(label ?? "");
    for (const join of ["@", "."]) {
      const tail = `${join}${suffix}`;
      if (name.toUpperCase().endsWith(tail) && name.length > tail.length) {
        return name.slice(0, -tail.length);
      }
    }
    return name;
  };
};

const Face = ({ kind }) => html`
  <i className=${`face ${graph.glyphClass(kind ?? "Base")}`} aria-hidden="true"></i>`;

const Named = ({ kind, label, className = "" }) => html`
  <span className=${`named ${className}`.trim()}>
    <${Face} kind=${kind} />
    <span>${label}</span>
  </span>`;

const Ends = ({ from, to, done }) => html`
  <span className=${"ends" + (done ? " ends--done" : "")}>
    <${Face} kind=${from.kind} /><span className="ends-name">${from.label}</span>
    ${mark("arrow-right")}
    <${Face} kind=${to.kind} /><span className="ends-name">${to.label}</span>
  </span>`;

const Section = PageSection;

const Row = ({ kind, label, ...rest }) => html`<${KeyValue} ...${rest}
  label=${kind ? html`<${Named} kind=${kind} label=${label} />` : label} />`;

const Meter = ({ steps, walked, done }) => html`
  <span className="route-meter" aria-hidden="true">
    ${Array.from({ length: Math.max(steps, 1) }, (_, i) => html`<span key=${i}
      className=${"route-meter-step" + (done || i < walked ? " is-walked" : i === walked ? " is-next" : "")}></span>`)}
  </span>`;

function Reach({ exposed, principals }) {
  const ref = useRef(null);
  const share = principals > 0 ? (exposed / principals) * 100 : 0;
  const shown = useRef(0);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const watch = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting));
    watch.observe(ref.current);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || shown.current === share) return;
    const el = ref.current;
    const controls = animate(shown.current, share, {
      duration: 1.2,
      ease: "easeOut",
      onUpdate: (v) => { shown.current = v; el.textContent = v.toFixed(share > 0 && share < 1 ? 1 : 0); },
    });
    return () => controls.stop();
  }, [share, seen]);
  return html`<span ref=${ref}>0</span>`;
}

function Chain({ route, short }) {
  const steps = route.steps ?? [];
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const nodes = [{ kind: route.startKind, label: short(route.startLabel) }];
  if (steps.length === 2) nodes.push({ kind: steps[0].toKind, label: short(steps[0].toLabel) });
  else if (steps.length > 2) nodes.push({ kind: steps[steps.length - 2].toKind, label: short(last.fromLabel) });
  nodes.push({ kind: last.toKind ?? route.targetKind, label: short(last.toLabel ?? route.targetLabel) });

  return html`<div className="chain">
    ${nodes.map((node, i) => html`
      <${Named} key=${`n${i}`} kind=${node.kind} label=${node.label} className="chain-node" />
      ${i < nodes.length - 1 && html`<span key=${`h${i}`} className="hop" aria-hidden="true">
        <svg className="hop-rule" viewBox="0 0 100 8" preserveAspectRatio="none">
          <line x1="0" y1="4" x2="94" y2="4" vector-effect="non-scaling-stroke" />
        </svg>
        <svg className="hop-head" viewBox="0 0 8 8"><path d="M0 0L8 4L0 8Z" /></svg>
      </span>`}`)}
  </div>`;
}

function DatabaseMenu({ databases, value, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, open, () => setOpen(false), { portal: ".bp5-popover" });
  const current = databases.find((db) => db.id === value) ?? null;
  return html`<span ref=${ref} className="database-menu"><${Popover} ...${dropdown} isOpen=${open}
    onInteraction=${(next) => setOpen(next)}
    content=${html`<${Menu}>
      ${databases.map((db) => html`<${MenuItem} key=${db.id} text=${db.name}
        label=${`${plural(db.fileCount ?? 0, "file")}, ${count(db.nodeCount)} objects`}
        roleStructure="listoption" selected=${current?.id === db.id}
        onClick=${() => { onPick(db.id); setOpen(false); }} />`)}
    <//>`}>
    <${Button} fill ellipsizeText alignText="left" text=${current ? current.name : "No database"}
      disabled=${databases.length === 0}
      rightIcon=${mark(open ? "chevron-up" : "chevron-down")} active=${open} />
  <//></span>`;
}

const ListHead = ({ columns, sort, onSort }) => html`
  <div className="way way--head" aria-hidden="true">
    ${columns.map((c) => c.sort
      ? html`<button key=${c.label} type="button"
          className=${"col col--sort" + (sort?.[0] === c.sort ? " is-on" : "") + (sort?.[0] === c.sort && sort[1] === "desc" ? " is-desc" : "")}
          title=${`Order by ${c.label.toLowerCase()}`} onClick=${() => onSort(c.sort)}>
          <span className="label">${c.label}</span>${mark("arrow-down")}
        </button>`
      : html`<span key=${c.label} className="col label">${c.label}</span>`)}
  </div>`;

const Chips = ({ tally, on, onToggle }) => html`
  <span className="tally">
    ${tally.map(([severity, n]) => html`<button key=${severity} type="button"
        className=${`tally-chip tally-chip--${severity}` + (on.includes(severity) ? " is-on" : "")}
        title=${on.includes(severity) ? "Show every severity" : `Only ${severity}`}
        onClick=${() => onToggle(severity)}>
      <i></i>${count(n)} ${severity}
    </button>`)}
  </span>`;

const LISTING = { User: "all-users", Group: "all-groups", Computer: "all-computers", OU: "all-ous",
  GPO: "all-gpos", Domain: "all-domains", Container: "all-containers", CertTemplate: "all-certificate-templates" };

const MATURITY = {
  1: "Domain takeover by any user",
  2: "One step from a privileged position",
  3: "Tiering broken in places",
  4: "Hygiene findings only",
  5: "Nothing the catalogue faults",
};

const NO_CAMPAIGN = {
  paths: [], truncated: false, log: [], held: [], census: null, latest: null,
  domains: 0, domainsHeld: 0,
};

const VIEW = { databaseId: null, sort: { routes: null, findings: null }, filter: { severity: [] } };

function StatisticsPanel({ onOpen }) {
  graph.useKindGlyphs();
  const [view, patch, ready] = useViewState("statistics", VIEW);
  const [overview, setOverview] = useState(null);
  const [findings, setFindings] = useState([]);
  const [seeds, setSeeds] = useState([]);
  const [population, setPopulation] = useState(null);

  const [scores, setScores] = useState({});
  const [queries, setQueries] = useState([]);

  const [databases, setDatabases] = useState(null);
  const [campaign, setCampaign] = useState(NO_CAMPAIGN);
  const [error, setError] = useState(null);
  const [fault, setFault] = useState(null);
  const [edition, setEdition] = useState(0);
  useDatabasesChanged(() => setEdition((n) => n + 1));

  const [, setNow] = useState(0);
  useTick(() => setNow(Date.now()), 30000);

  useEffect(() => {
    let live = true;
    listDatabases()
      .then((all) => { if (live) setDatabases(all); })
      .catch((cause) => { if (live) setError(`The databases could not be read: ${cause.message}`); });
    return () => { live = false; };
  }, [edition]);

  const database = databases?.find((db) => db.id === view.databaseId) ?? databases?.[0] ?? null;
  const chosen = database?.id ?? null;

  const showing = useRef(null);
  useEffect(() => {
    if (!ready || !databases) return;

    if (showing.current !== chosen) {
      showing.current = chosen;
      setOverview(null); setFindings([]); setSeeds([]); setPopulation(null); setScores({});
      setCampaign(NO_CAMPAIGN);
    }
    setFault(null); setError(null);
    if (!chosen) return;
    let live = true;
    graph.listQueries().then((v) => { if (live) setQueries(v); }).catch(() => {});

    json(`/api/overview/statistics?db=${encodeURIComponent(chosen)}`)
      .then((parts) => {
        if (!live) return;

        const failed = [];
        const value = (name, part, fallback) => {
          if (part?.error) { failed.push(`${name}: ${part.error.message}`); return fallback; }
          return part?.value ?? fallback;
        };
        const overviewPart = value("overview", parts.overview, null);
        setFindings(value("findings", parts.findings, []));
        setSeeds(value("tier zero", parts.tierZero, []));
        setPopulation(value("population", parts.population, null));
        setScores(value("grade", parts.score, {}));
        const routes = value("routes from owned", parts.routes, null);
        const log = value("history", parts.history, []);
        const detail = value("collection coverage", parts.detail, null);
        const owned = value("owned", parts.owned, null);
        setCampaign({

          held: owned?.nodes ?? [],
          paths: routes?.paths ?? [],
          truncated: Boolean(routes?.truncated),

          domains: routes?.domains ?? 0,
          domainsHeld: routes?.domainsHeld ?? 0,
          log,

          latest: log.filter((r) => r.op === "owned").map((r) => r.assertedAt).sort().at(-1) ?? null,
          census: detail?.census ?? null,
        });
        setOverview(overviewPart);
        if (failed.length > 0) setFault(`Not shown: ${failed.join("; ")}.`);
      })
      .catch((cause) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [ready, databases, chosen]);

  const open = (changes) => graph.aimGraph({ databaseId: chosen, ...changes })
    .catch(() => {}).then(() => onOpen("graph"));
  const openFinding = (finding) => open({ queryId: finding.id, script: null });
  const openListing = (kind) => open({ queryId: LISTING[kind], script: null });
  const openScript = (script) => open({ queryId: null, script });

  const openOwned = () => openScript("find objects where owned = true");

  const addOwned = () => graph.findOnGraph(chosen).catch(() => {}).then(() => onOpen("graph"));

  const sortOf = (list) => view.sort?.[list] ?? null;
  const toggleSort = (list, key) => {
    const [k, dir] = sortOf(list) ?? [];
    patch({ sort: { ...view.sort, [list]: k === key && dir === "asc" ? [key, "desc"] : [key, "asc"] } });
  };
  const severityOn = view.filter?.severity ?? [];
  const toggleSeverity = (severity) => patch({ filter: { ...view.filter,
    severity: severityOn.includes(severity) ? severityOn.filter((s) => s !== severity) : [...severityOn, severity] } });
  const ordered = (rows, sort, keys) => {
    if (!sort) return rows;
    const [key, dir] = sort;
    const by = keys[key];
    return by ? [...rows].sort((a, b) => (dir === "asc" ? 1 : -1) * (by(a) - by(b))) : rows;
  };

  const { paths, latest } = campaign;

  const allDomainsHeld = campaign.domains > 0 && campaign.domainsHeld >= campaign.domains;

  const markedAt = new Map(campaign.log.filter((r) => r.op === "owned").map((r) => [r.subject, r.assertedAt]));
  const held = [...campaign.held].sort((a, b) => (markedAt.get(b.id) ?? "").localeCompare(markedAt.get(a.id) ?? ""));
  const left = (p) => Math.max(0, (p.steps?.length ?? 0) - (p.walked ?? 0));

  const nearest = [...paths].sort((a, b) => Number(b.targetOwned) - Number(a.targetOwned) || left(a) - left(b));
  const routes = ordered(nearest, sortOf("routes"), {
    effort: (p) => graph.routeFacts(p).difficultyRank,
    progress: (p) => (p.targetOwned ? -1 : left(p)),
  });
  const openRoutes = nearest.filter((p) => !p.targetOwned);
  const walked = nearest.length - openRoutes.length;
  const next = openRoutes[0] ?? null;
  const reachOf = (node) => {
    const mine = paths.filter((p) => p.startId === node.id);
    if (mine.some((p) => p.targetOwned)) return ["Route completed", true];
    if (mine.length === 0) return [node.tierZero ? "In the zone" : "No route found", false];
    const fewest = Math.min(...mine.map(left));
    return [`${plural(mine.length, "route")}, ${plural(fewest, "step")} left`, false];
  };

  const catalogue = new Map(queries.map((q) => [q.id, q]));
  const severityOf = (id) => catalogue.get(id)?.severity ?? "none";
  const matched = findings.filter((f) => f.count > 0);

  const scored = matched
    .filter((f) => severityOf(f.id) !== "none")
    .sort((a, b) => bySeverity(severityOf(a.id)) - bySeverity(severityOf(b.id)) || b.count - a.count);
  const tally = SEVERITY_ORDER.slice(0, 4)
    .map((severity) => [severity, scored.filter((f) => severityOf(f.id) === severity).length])
    .filter(([, n]) => n > 0);
  const shownFindings = ordered(
    severityOn.length > 0 ? scored.filter((f) => severityOn.includes(severityOf(f.id))) : scored,
    sortOf("findings"),
    { severity: (f) => bySeverity(severityOf(f.id)), objects: (f) => f.count });

  const fig = (rows, id) => (rows ?? []).find((r) => r.id === id);
  const userFigureIds = ["users", "users-enabled"];
  const computerFigureIds = ["computers", "computers-enabled", "computers-controllers", "computers-laps"];
  const missing = population
    ? [...userFigureIds.map((id) => [population.users, id]),
       ...computerFigureIds.map((id) => [population.computers, id])]
      .filter(([rows, id]) => !fig(rows, id)).map(([, id]) => id)
    : [];
  const shortfall = missing.length > 0
    ? `population: the server sent no figure named ${missing.join(", ")}`
    : null;
  const figure = (rows, id) => fig(rows, id)?.count ?? 0;
  const domains = [...(population?.domains ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  const sumOf = (key) => domains.reduce((t, d) => t + (d[key] ?? 0), 0);
  const users = figure(population?.users, "users");
  const usersEnabled = figure(population?.users, "users-enabled");
  const computers = figure(population?.computers, "computers");
  const computersEnabled = figure(population?.computers, "computers-enabled");
  const controllers = figure(population?.computers, "computers-controllers");
  const laps = figure(population?.computers, "computers-laps");
  const findingRow = (id) => matched.find((f) => f.id === id) ?? null;
  const findingCount = (id) => findingRow(id)?.count ?? 0;
  const seedsOwned = seeds.filter((s) => s.owned).length;

  const census = campaign.census;
  const censusEnabled = census?.computersEnabled ?? 0;
  const sessions = census?.computersWithSessions ?? 0;
  const derived = database?.derivedEdgeCount ?? 0;

  const grade = scores?.[chosen] ?? null;
  const uncounted = Object.values(scores ?? {}).reduce((t, s) => t + (s.uncounted ?? 0), 0);
  const counted = Object.values(scores ?? {}).reduce((t, s) => t + (s.counted ?? 0), 0);
  const assumed = paths.filter((p) => p.difficultyAssumed).length;

  const censusKnown = censusEnabled > 0;
  const blind = censusKnown && sessions === 0;

  const short = shorten(domains.map((d) => d.label));

  const unfinished = database?.analysisError
    ? `${database.name} could not be analysed, so Tier Zero, the routes and the findings below are `
      + `not what this data holds: ${database.analysisError}`
    : database?.analyzed === false
      ? `${database.name} is being analysed. Tier Zero, the routes and the findings below are not `
        + "what this data holds yet; they are filled in as it finishes."
      : null;
  const notice = [unfinished, error, fault, shortfall].filter(Boolean).join(" ") || null;
  const routeColumns = [{ label: "Route" }, { label: "Reaches" },
    { label: graph.ROUTE_TEXT.difficulty, sort: "effort" },
    { label: graph.ROUTE_TEXT.progress, sort: "progress" }];
  const findingColumns = [{ label: "Finding" }, { label: "Section" },
    { label: "Severity", sort: "severity" }, { label: "Objects", sort: "objects" }];

  return html`<div className="panel lae-page">
    ${notice && html`<div className="notice-line label">${notice}</div>`}
    ${databases && databases.length === 0 && html`<div className="empty-stage label">No database yet. Upload one in the Ingestor.</div>`}
    ${!overview && !error && chosen && html`<div className="empty-stage label">Loading…</div>`}
    ${overview && html`<div className="board">

      <${Ornament} className="ornament--band">
        <div className="band">
          <div className="hero">
            ${held.length > 0
              ? html`<div className="hero-v mono">${count(held.length)}</div>
                  <div className="label hero-k">Owned principals</div>
                  <div className="label hero-s">
                    ${plural(walked, "route")} completed, ${count(openRoutes.length)} remaining
                  </div>`
              : html`<div className="hero-v">
                    <${Reach} exposed=${overview.exposed} principals=${overview.principals} /><em>%</em>
                  </div>
                  <div className="label hero-k">Already reach Tier Zero</div>
                  <div className="label hero-s">
                    ${ ""}
                    ${overview.exposed > 0
                      ? `${count(overview.exposed)} accounts can reach Tier Zero unaided`
                      : "Nothing reaches Tier Zero yet"}
                  </div>`}
          </div>

          <div className="onward">
            ${next
              ? html`<${Section} icon="path-search" title="Shortest remaining route" className="sec--bare"
                    note=${`${plural(left(next), "step")} left`}>
                  ${ ""}
                  <button type="button" className="band-fill band-fill--pick"
                    aria-label="Open the routes from owned on the graph" onClick=${openOwned}>
                    <div className="onward-t">${next.hardestStep ? `Gated on: ${next.hardestStep}` : `To ${short(next.targetLabel)}`}</div>
                    <${Chain} route=${next} short=${short} />
                  </button>
                <//>`
              : held.length > 0
                ? html`<${Section} icon="path-search" title="Routes" className="sec--bare"
                      note=${allDomainsHeld ? "Domains held" : "All completed"}>
                    <div className="band-fill">
                      <p className="note onward-empty">
                        ${allDomainsHeld
                          ? `Nothing is left to reach: ${plural(campaign.domains, "domain")} in this
                             database, and an owned object holds full control of every one.`
                          : `Every route from owned is completed. Mark another principal as owned to
                             see its routes.`}
                      </p>
                    </div>
                  <//>`

                : html`<${Section} icon="path-search" title="Routes" className="sec--bare" note="None yet">
                      <div className="band-fill">
                        <p className="note onward-empty">
                          Mark a principal as owned to see the routes from owned and the shortest one here.
                        </p>
                      </div>
                    <//>`}
          </div>

          <div className="held">
            <${Section} icon="flag" title="Owned" className="sec--bare"
              note=${held.length > 0 ? "Newest first" : null}>
              <div className="band-fill">
                ${held.length === 0
                  ? html`<p className="note held-empty">
                      Nothing is marked as owned, so the findings below are ranked without a starting point.
                    </p>`
                  : html`<div className="held-list">
                      ${held.map((node) => {
                        const [reach, done] = reachOf(node);
                        return html`<button className="row row--pick row--bare" key=${node.id} onClick=${openOwned}>
                          <${Named} kind=${node.kind} label=${short(node.label)} />
                          <span className=${"label row-g" + (done ? " row-g--done" : "")}>${reach}</span>
                        </button>`;
                      })}
                    </div>`}
              </div>
              ${ ""}
              <div className="band-go">
                <${Button} onClick=${addOwned} text="Add owned" />
              </div>
            <//>
          </div>
        </div>
      <//>

      <div className="cols">
        <div className="col-main">
          ${ ""}
          <${Section} icon="route" title=${graph.ROUTE_TEXT.list}
            count=${held.length > 0 ? count(routes.length) : null}
            note=${held.length > 0 && campaign.truncated ? "Capped" : null} className="sec--list sec--routes"
            sub=${routes.length > 0 && html`<${ListHead} columns=${routeColumns} sort=${sortOf("routes")}
              onSort=${(key) => toggleSort("routes", key)} />`}>
            ${routes.length === 0
              ? html`<p className="note list-empty">
                  ${held.length === 0
                    ? "No principal is marked as owned yet."
                    : allDomainsHeld
                      ? `Every domain in this database is already held, so nothing is left to route to.`
                      : "No route from owned reaches a tracked target."}
                </p>`
              : routes.map((route) => {

                  const r = graph.routeFacts(route);
                  return html`<button className=${"way" + (r.done ? " way--done" : "")}
                    key=${r.key} onClick=${openOwned}>
                    <span className="way-t">
                      <${Ends} done=${r.done}
                        from=${{ kind: r.startKind, label: short(r.startLabel) }}
                        to=${{ kind: r.targetKind, label: short(r.targetLabel) }} />
                      <span className="label">${r.hardestStep ?? r.reason}</span>
                    </span>
                    ${ ""}
                    <${Named} kind=${r.targetKind} className="way-gets" label=${r.reason} />
                    <span className="effort" title=${graph.difficultyTitle(r)}>
                      <${Pips} effort=${r.difficulty} />
                      <em className="label">${r.difficultyWord}</em>
                    </span>
                    <span className="prog">
                      <${Meter} steps=${r.count} walked=${r.walked} done=${r.done} />
                      <span className="label route-steps">${graph.progressText(r)}</span>
                    </span>
                  </button>`;
                })}
          <//>

          <${Section} icon="warning-sign" title="Findings" className="sec--list"
            ${ ""}
            count=${severityOn.length > 0
              ? `${count(shownFindings.length)} shown of ${count(scored.length)} matched`
              : `${count(scored.length)} matched of ${count(queries.filter((q) => (q.severity ?? "none") !== "none").length)} rules`}
            tools=${tally.length > 0 && html`<${Chips} tally=${tally} on=${severityOn} onToggle=${toggleSeverity} />`}
            sub=${shownFindings.length > 0 && html`<${ListHead} columns=${findingColumns} sort=${sortOf("findings")}
              onSort=${(key) => toggleSort("findings", key)} />`}>
            ${scored.length === 0
              ? html`<p className="note list-empty">No scored rule matched this database.</p>`
              : shownFindings.length === 0
                ? html`<p className="note list-empty">Nothing at that severity. Press the chip again to show every finding.</p>`
                : shownFindings.map((finding) => {
                    const row = catalogue.get(finding.id);
                    const severity = severityOf(finding.id);
                    return html`<button className="way" key=${finding.id} onClick=${() => openFinding(finding)}>
                      <span className="way-t">
                        <b>${row?.title ?? finding.id}</b>
                        <span className="label">${row?.description ?? ""}</span>
                      </span>
                      <span className="way-gets">${row?.section ?? ""}</span>
                      <span className=${`sev sev--${severity}`}>${severity}</span>
                      <span className="mono way-n">${count(finding.count)}
                        <small className="label">objects</small></span>
                    </button>`;
                  })}
          <//>

          <div className="foot">
            <div className="fig fig--db">
              <span className="label">Database</span>
              <${DatabaseMenu} databases=${databases ?? []} value=${chosen}
                onPick=${(id) => patch({ databaseId: id })} />
            </div>
            ${ ""}
            <div className="fig">
              <span className="label">Owned</span>
              <span className="mono">${count(held.length)}
                <small>${latest ? `last ${ago(latest)}` : "none marked"}</small></span>
            </div>
            <div className=${"fig" + (grade && grade.maturity <= 2 ? " fig--flag" : "")}
              title=${grade?.maturityTitle ?? undefined}>
              <span className="label">Maturity</span>
              <span className="mono">${grade ? `Level ${grade.maturity} of 5` : NA}</span>
              ${ ""}
              ${grade && html`<span className="fig-note">${MATURITY[grade.maturity] ?? ""}</span>`}
            </div>
            <div className="fig">
              <span className="label">Tier Zero</span>
              <span className="mono">${count(overview.tierZero)}<small>/ ${count(seeds.length)} by rule${
                seedsOwned > 0 ? `, ${count(seedsOwned)} owned` : ""}</small></span>
            </div>
            <div className="fig">
              <span className="label">Last ingest</span>
              <span className="mono">${database?.updated || database?.created ? ago(database.updated || database.created) : NA}
                <small>${plural(database?.fileCount ?? 0, "file")}</small></span>
            </div>
          </div>
        </div>

        <div className="col-side">
          <${Section} icon="globe-network" title="Directory" className="sec--directory"
            note=${`${count(overview.nodes)} objects, ${count(overview.edges)} relationships`}>
            ${domains.map((d) => html`<${Row} key=${d.id} kind="Domain" label=${d.label}
              value=${plural(d.controllers ?? 0, "DC")}
              sub=${d.functionalLevel ? `level ${d.functionalLevel}` : null}
              onPick=${() => openScript(`find domains where id = "${d.id}" show paths`)} />`)}
            ${domains.length === 0 && html`<${Row} kind="Domain" label="Domains" value="0" />`}
            <${Row} kind="User" label="Users" value=${count(users)}
              sub=${`${count(usersEnabled)} enabled`} onPick=${() => openListing("User")} />
            <${Row} kind="Computer" label="Computers" value=${count(computers)}
              sub=${`${count(computersEnabled)} enabled`} onPick=${() => openListing("Computer")} />
            <${Row} kind="Computer" label="Domain controllers" value=${count(controllers)}
              onPick=${() => openScript("find computers where isdc = true")} />
            <${Row} kind="OU" label="Organisational units" value=${count(sumOf("ous"))}
              onPick=${() => openListing("OU")} />
            <${Row} kind="GPO" label="Group policies" value=${count(sumOf("gpos"))}
              onPick=${() => openListing("GPO")} />
          <//>

          <${Section} icon="key" title="Credential exposure" className="sec--creds">
            <${Row} label="Computers with sessions collected"
              value=${censusKnown ? `${count(sessions)} of ${count(censusEnabled)}` : NA}
              flag=${blind} />
            <${Row} label="Computers without LAPS"
              value=${`${count(Math.max(0, computersEnabled - laps))} of ${count(computersEnabled)}`}
              flag=${computersEnabled > 0 && laps < computersEnabled / 2}
              onPick=${findingRow("laps-absent") ? () => openFinding(findingRow("laps-absent")) : null} />
            <${Row} label="Accounts with an SPN" value=${count(findingCount("spn-user-accounts"))}
              flag=${findingCount("spn-protected-account") > 0}
              onPick=${findingRow("spn-user-accounts") ? () => openFinding(findingRow("spn-user-accounts")) : null} />
            <${Row} label="Enabled, never logged on" value=${count(findingCount("no-recorded-logon"))}
              onPick=${findingRow("no-recorded-logon") ? () => openFinding(findingRow("no-recorded-logon")) : null} />
          <//>

          <${Section} icon="eye-off" title="Blind spots" note="Re-collect" className="sec--blind">
            ${!censusKnown
              ? html`<p className="note blind">
                  <b>Collection coverage was not recorded.</b> Whether sessions and local groups
                  were collected is unknown, so routes may be missing.
                </p>`
              : blind
                ? html`<p className="note blind">
                    <b>No sessions and no local groups were collected.</b> Every route that starts
                    from a logged-on user is invisible, so ${pct(overview.exposed, overview.principals)}
                    is a floor. Run collection again with session gathering on.
                  </p>`
                : html`<p className="note blind">
                    Sessions were collected on ${pct(sessions, censusEnabled)} of enabled computers.
                    Routes through the rest are not shown.
                  </p>`}
            <${Row} label="Derived edges"
              value=${`${count(derived)} of ${count(overview.edges)}`} />
            <${Row} label="Queries that failed"
              value=${`${count(uncounted)} of ${count(counted + uncounted)}`} flag=${uncounted > 0} />
            <${Row} label="Routes with default difficulty"
              value=${`${count(assumed)} of ${count(nearest.length)}`} />
          <//>
        </div>
      </div>
    </div>`}
  </div>`;
}

const MOTIF = html`
    ${[10, 24, 38, 52].map(y => html`<path key=${y} d="M-10 ${y}H190" stroke="currentColor" stroke-width="0.6" stroke-dasharray="2 4"></path>`)}
    <path d="M-10 44L22 36L48 40L76 24L104 30L132 12L160 20L192 2" stroke="currentColor" stroke-width="1.6" fill="none"></path>
    <path d="M-10 44L22 36L48 40L76 24L104 30L132 12L160 20L192 2V80H-10Z" fill="currentColor" fill-opacity="0.22"></path>
    <path d="M-10 50L22 46L48 48L76 40L104 42L132 34L160 36L192 28" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" fill="none"></path>
    ${[[22, 36], [76, 24], [132, 12], [160, 20]].map(([x, y]) => html`<circle key=${x} cx=${x} cy=${y} r="2.4" fill="currentColor"></circle>`)}`;

export default defineModule({
  id: "statistics",
  title: "Statistics",
  motif: MOTIF,
  Panel: StatisticsPanel,
  styles: [new URL("./statistics.css", import.meta.url)],
});

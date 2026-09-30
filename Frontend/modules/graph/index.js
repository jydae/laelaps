import { html, useCallback, useEffect, useMemo, useRef, useState, Button, Keys } from "../../ui/index.js";
import * as api from "../../core/index.js";
import { count, listDatabases, useDatabasesChanged, useViewState, CAPS, defineModule, aim } from "../../core/index.js";
import { GraphView, POINT_STEPS, LINK_LABEL_MAX, OwnedFlag, glyphClass, useKindGlyphs } from "./graphView.js";
import { LAYOUTS, DEFAULT_LAYOUT, shortName } from "./graphLayout.js";
import { summariseKinds, merge, without, kindCensus, withoutKinds, nextHidden, KIND_LABELS, routeKey, sameRoute, rowNode, DOMAIN_VIEW } from "./graphModel.js";
import { PathBar, ScriptEditor, SaveDialog, Loading } from "./graphToolbar.js";
import { FilterPanel, NodePanel, ViewMenu, CanvasMenu, viewRows } from "./panels.js";
export { listQueries } from "../../core/index.js";
export { slug as kindSlug, glyphClass, useKindGlyphs } from "./graphView.js";
export { ROUTE_TEXT, DIFFICULTY_RANK, routeFacts, difficultyTitle, progressText } from "./graphModel.js";

function useReadiness(parts) {

  const key = parts.join("|");
  const names = useMemo(() => [...parts], [key]);
  const [arrived, setArrived] = useState(() => new Set());

  useEffect(() => { setArrived(new Set()); }, [key]);

  const settle = useCallback((name) => {
    setArrived((was) => (was.has(name) ? was : new Set(was).add(name)));
  }, []);

  return [names.every((name) => arrived.has(name)), settle];
}

const queued = new Map();

const readers = new Map();

function sendCommand(tab, name, detail = null) {
  queued.set(tab, { name, detail });
  for (const wake of readers.get(tab) ?? []) wake();
}

function take(tab, name) {
  const held = queued.get(tab);
  if (!held || held.name !== name) return null;
  queued.delete(tab);
  return held;
}

function useCommand(tab, name, act) {

  const [seen, setSeen] = useState(0);
  useEffect(() => {
    const wake = () => setSeen((n) => n + 1);
    const here = readers.get(tab) ?? new Set();
    here.add(wake);
    readers.set(tab, here);
    return () => {
      here.delete(wake);
      if (here.size === 0) readers.delete(tab);
    };
  }, [tab]);

  useEffect(() => {
    const held = take(tab, name);
    if (held) act(held.detail);
  }, [tab, name, seen]);
}

const BENCH_SLOTS = 5;

const PANEL_FRAME = ["view", "catalogue"];

const perDatabase = () => ({

  pinned: null, layout: null, camera: null,

  pathTarget: null,

  expanded: [], hidden: [],

  routesDismissed: [],

  lit: {},

  bench: [], reading: null,

  hiddenKinds: ["Container"],

  hiddenEdgeKinds: [],
});

const PREFERENCES = {
  labels: "auto",

  tinted: true,

  kinds: false,

  layoutMode: DEFAULT_LAYOUT,
};

const SAVED = {

  databaseId: null, queryId: null, script: null, panelOpen: true,

  scriptOpen: false, scriptFrame: null, scriptSource: null, scriptDraft: null,

  nodesOpen: false,
  ...PREFERENCES,
  ...perDatabase(),
};

const SCRIPT_DRAFT_MAX = 8000;

const NONE = [];

const ROUTES_SEEN = new Map();

function GraphPanel() {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const viewRef = useRef(null);
  const labelRefs = useRef([]);
  const linkLabelRefs = useRef([]);

  const routesRef = useRef(null);
  const ringRefs = useRef([]);
  const ownedRefs = useRef([]);

  const reticleRefs = useRef({ hover: null, select: null, group: null });

  const marqueeRef = useRef({ box: null, count: null });
  const iconRefs = useRef([]);
  const clusterRefs = useRef([]);

  const [databases, setDatabases] = useState([]);

  const [listFault, setListFault] = useState(null);
  const [queries, setQueries] = useState([]);

  const [savedFilters, setSavedFilters] = useState([]);

  const [editingFilter, setEditingFilter] = useState(null);
  const [database, setDatabase] = useState(null);

  const databaseRef = useRef(null);
  databaseRef.current = database?.id ?? null;

  const [allNodes, setNodes] = useState([]);
  const [allLinks, setLinks] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(null);

  const [glyphsLegible, setGlyphsLegible] = useState(true);

  const [clusters, setClusters] = useState([]);

  const [bench, setBench] = useState([]);
  const [activeNode, setActiveNode] = useState(null);

  const [details, setDetails] = useState(() => new Map());

  const [standings, setStandings] = useState(() => new Map());

  const inspecting = activeNode;

  const held = activeNode ? details.get(activeNode) ?? null : null;
  const detail = held?.error ? null : held;
  const setDetail = (value) => setDetails((all) => (activeNode
    ? new Map(all).set(activeNode, typeof value === "function" ? value(all.get(activeNode)) : value)
    : all));
  const [loading, setLoading] = useState(false);
  const [activeQuery, setActiveQuery] = useState(null);

  const [scriptText, setScriptText] = useState("");
  const [scriptError, setScriptError] = useState(null);

  const ask = (sentence) => { setScriptText(sentence ?? ""); setScriptError(null); save({ scriptDraft: null }); };

  const [saved, save, savedReady, aimed] = useViewState("graph", SAVED);
  const scriptOpen = saved.scriptOpen === true;
  const setScriptOpen = (open) => save({ scriptOpen: open === true });

  const scriptFrame = ["x", "y", "w", "h"].every((k) => Number.isFinite(saved.scriptFrame?.[k]))
    ? saved.scriptFrame : null;

  const typeScript = (text) => {
    setScriptText(text);
    if (text.length <= SCRIPT_DRAFT_MAX) save({ scriptDraft: text });
  };
  const { panelOpen, nodesOpen } = saved;
  const tinted = saved.tinted !== false;
  const layoutMode = LAYOUTS.some((l) => l.id === saved.layoutMode) ? saved.layoutMode : DEFAULT_LAYOUT;
  const kinds = saved.kinds === true;

  const pointScale = POINT_STEPS.includes(saved.pointScale) ? saved.pointScale : 1;
  const hiddenKinds = Array.isArray(saved.hiddenKinds) ? saved.hiddenKinds : NONE;
  const hiddenEdgeKinds = Array.isArray(saved.hiddenEdgeKinds) ? saved.hiddenEdgeKinds : NONE;

  const drawnOf = (nodesAll, linksAll) => {
    if (hiddenKinds.length === 0) return { nodes: nodesAll, links: linksAll };
    const off = new Set(hiddenKinds);
    const gone = new Set(nodesAll.filter((n) => off.has(n.kind)).map((n) => n.id));
    if (gone.size === 0) return { nodes: nodesAll, links: linksAll };
    return without(nodesAll, linksAll.filter((l) => !gone.has(l.from)), gone);
  };
  const { nodes, links: shownLinks } = useMemo(
    () => drawnOf(allNodes, allLinks), [allNodes, allLinks, hiddenKinds]);

  const links = useMemo(
    () => withoutKinds(shownLinks, hiddenEdgeKinds), [shownLinks, hiddenEdgeKinds]);

  const census = useMemo(() => kindCensus(allNodes, (node) => [node.kind]), [allNodes]);

  const edgeCensus = useMemo(
    () => kindCensus(shownLinks, (link) => link.kinds ?? []), [shownLinks]);

  useEffect(() => {
    setSelectedIndex(null);
  }, [hiddenKinds]);

  const restoring = useRef(false);
  const applyFilter = (was, patch, present) => {

    const next = Object.values(patch)[0];
    const here = new Set(present.map((c) => c.kind));
    if (!was.some((kind) => here.has(kind) && !next.includes(kind))) { save(patch); return; }
    restoring.current = true;
    setLoading(true);
    requestAnimationFrame(() => requestAnimationFrame(() => save(patch)));
  };

  const toggleKind = (kind) =>
    applyFilter(hiddenKinds, { hiddenKinds: nextHidden(hiddenKinds, kind, census) }, census);

  const toggleEdgeKind = (kind) => {
    changeRef.current = { keep: true };
    applyFilter(hiddenEdgeKinds,
      { hiddenEdgeKinds: nextHidden(hiddenEdgeKinds, kind, edgeCensus) }, edgeCensus);
  };
  const setPanelOpen = (open) => save({ panelOpen: open });
  const setNodesOpen = (open) => save({ nodesOpen: open });

  const [routes, setRoutes] = useState([]);

  const [routePopulation, setRoutePopulation] = useState(0);

  const [zones, setZones] = useState(null);

  const [findings, setFindings] = useState(null);

  const [notCollected, setNotCollected] = useState(null);
  const [delegations, setDelegations] = useState(null);
  const [reachPath, setReachPath] = useState(null);

  const [readingRoute, setReadingRoute] = useState(false);

  const [readingFold, setReadingFold] = useState(null);

  const [writing, setWriting] = useState(false);
  const [history, setHistory] = useState([]);
  const [labels, setLabels] = useState(saved.labels ?? "auto");
  const expanded = Array.isArray(saved.expanded) ? saved.expanded : [];
  const hidden = Array.isArray(saved.hidden) ? saved.hidden : [];
  const routesDismissed = Array.isArray(saved.routesDismissed) ? saved.routesDismissed : [];

  const dismissRoute = (path) =>
    save({ routesDismissed: [...routesDismissed, routeKey(path)].slice(-CAPS.dismissed) });

  const [menu, setMenu] = useState(null);
  const closeMenu = () => setMenu(null);

  const [around, setAround] = useState(null);

  const [full, setFullState] = useState(false);
  const setFull = (on) => {
    setFullState(on);
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    if (!full) return undefined;
    const left = () => { if (!document.fullscreenElement) setFullState(false); };
    const key = (e) => { if (e.key === "Escape") setFull(false); };
    document.addEventListener("fullscreenchange", left);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("fullscreenchange", left);
      window.removeEventListener("keydown", key);
    };
  }, [full]);

  const runAction = (action) => {
    if (!action) return;

    if (action.kind === "hide") { hideNode(); return; }
    if (action.kind === "paint") { viewRef.current?.paintLink(action.link, action.value); return; }
    if (action.kind === "assert") { apply(action.change); return; }
    if (action.kind === "labels") { setLabels(action.value); save({ labels: action.value }); }
    if (action.kind === "tint") { save({ tinted: action.value }); }
    if (action.kind === "kinds") { save({ kinds: action.value }); }
    if (action.kind === "pointScale") { save({ pointScale: action.value }); }
    if (action.kind === "full") { setFull(action.value); }
    if (action.kind === "rearrange") { rearrange(); }
    if (action.kind === "layout") { save({ layoutMode: action.value }); }
    if (action.kind === "expandKind" && menu?.index != null) { expandKind(menu.index, action.value); }
    if (action.kind === "edgeKind") { toggleEdgeKind(action.value); }
    if (action.kind === "kind") { toggleKind(action.value); }
  };

  const loadHistory = (db = database) => {
    if (!db) { setHistory([]); return; }
    api.history(db.id).then(forDb(db, setHistory)).catch(() => forDb(db, setHistory)([]));
  };

  const apply = (change) => {
    if (!database || !change) return Promise.resolve(false);
    setWriting(true);

    patchNode(change);
    patchDetail(change);
    return api.apply(database.id, change)
      .then((outcome) => {

        if (change.op === "rename") loadHistory();
        if (inspecting) {
          api.fetchNode(inspecting, database.id).then(setDetail).catch(() => {});
        }
        if (outcome?.rewalked) reloadInPlace();

        if (change.op === "owned" || outcome?.rewalked) loadRoutes();
        if (outcome?.rewalked) { loadZones(); loadFindings(); }
        return true;
      })
      .catch(() => {
        flashRef.current?.("WRITE FAILED");

        reloadInPlace();
        if (inspecting) api.fetchNode(inspecting, database.id).then(setDetail).catch(() => {});
        return false;
      })
      .finally(() => setWriting(false));
  };

  const patchDetail = (change) => {
    if (change.subjectKind !== "node") return;
    setDetails((all) => {
      const held = all.get(change.subject);
      if (!held || held.error) return all;
      const next = { ...held };
      if (change.op === "rename") next.label = change.value.label;
      else if (change.op === "owned") next.owned = change.value.owned;
      else if (change.op === "zone") { next.tierZero = change.value.member; next.tierZeroSeed = change.value.member; }
      else return all;
      return new Map(all).set(change.subject, next);
    });
  };

  const loadRoutes = (db = database) => {
    if (!db) { setRoutes([]); return; }

    setRoutes(ROUTES_SEEN.get(db.id)?.paths ?? []);
    setRoutePopulation(ROUTES_SEEN.get(db.id)?.population ?? 0);
    api.fetchRoutes(db.id)
      .then((result) => {
        ROUTES_SEEN.set(db.id, { paths: result.paths ?? [], population: result.population ?? 0 });
        forDb(db, setRoutes)(result.paths ?? []);
        forDb(db, setRoutePopulation)(result.population ?? 0);
      })
      .catch(() => {
        if (databaseRef.current !== db.id) return;
        setRoutes([]);
        flashRef.current?.("ROUTES FROM OWNED COULD NOT BE READ");
      });
  };

  const loadStanding = (db = database) => {
    if (!db) { setDelegations(null); return; }
    api.fetchDelegations(db.id).then(forDb(db, setDelegations)).catch(() => forDb(db, setDelegations)({ failed: true }));
  };

  const loadZones = (db = database) => {
    if (!db) { setZones(null); return; }
    api.fetchZones(db.id).then(forDb(db, setZones)).catch(() => forDb(db, setZones)({ failed: true }));
  };

  const loadFindings = (db = database) => {
    if (!db) { setFindings(null); return; }
    api.fetchFindings(db.id).then(forDb(db, setFindings)).catch(() => forDb(db, setFindings)(null));
    api.fetchCoverage(db.id).then(forDb(db, setNotCollected)).catch(() => forDb(db, setNotCollected)(null));
    loadStanding(db);
  };

  const openCrossing = (crossing) => {
    setPinned({ id: crossing.sourceId, label: crossing.sourceLabel });
    runScript(`path objects where id = "${crossing.sourceId}" to objects where id = "${crossing.targetId}" within 1`);
  };

  const openReachPath = (path) => {

    if (sameRoute(reachPath, path)) { setReadingRoute(true); return; }
    setPinned({ id: path.startId, label: path.startLabel });

    runScript(`path objects where id = "${path.startId}" to objects where id = "${path.targetId}" within ${path.steps.length}`)
      .then((drawn) => { if (drawn) { setReachPath(path); setReadingRoute(true); } });
  };

  const patchNode = (change) => {
    if (change.subjectKind !== "node" || !["rename", "owned", "zone"].includes(change.op)) return;
    changeRef.current = { keep: true };
    setNodes((current) => current.map((node) => {
      if (node.id !== change.subject) return node;
      if (change.op === "rename") return { ...node, label: change.value.label };
      if (change.op === "owned") return { ...node, owned: change.value.owned };
      if (change.op === "zone") return { ...node, tierZero: change.value.member, tierZeroSeed: change.value.member };
      return node;
    }));
  };

  const reloadInPlace = () => {
    if (!database) return;

    const view = lastView.current;
    if (!view) return;
    const id = begin("topology");
    view.request()
      .then(async (data) => {
        if (!current("topology", id)) return;

        const whole = await replayGestures(data, database);

        if (!current("topology", id)) return;
        changeRef.current = { keep: true };
        setNodes(whole.nodes);
        setLinks(whole.links);
        setEmpty(whole.nodes.length === 0);
        setCoverage({
          total: whole.total ?? whole.nodes.length,
          truncated: whole.truncated === true,
          counting: whole.counting ?? "objects",
        });
      })
      .catch(() => {});
  };

  const [searchOpen, setSearchOpen] = useState(false);
  useCommand("graph", "find", () => setSearchOpen(true));

  const pinned = saved.pinned;
  const pathTarget = saved.pathTarget;
  const setPinned = (next) => save({ pinned: next, pathTarget: null });
  const setPathTarget = (next) => save({ pathTarget: next });

  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(0);
  const [empty, setEmpty] = useState(false);

  const level = !database ? "databases"
    : readingRoute && reachPath ? "route"
    : readingFold ?? "queries";

  const openRoute = reachPath
    ? routes.find((path) => sameRoute(path, reachPath)) ?? reachPath
    : null;

  const requests = useRef({ topology: 0 });
  const begin = (kind) => {
    if (kind === "topology") setLoading(false);
    return (requests.current[kind] += 1);
  };
  const current = (kind, id) => requests.current[kind] === id;

  const changeRef = useRef(null);

  const clearSelection = () => setSelectedIndex(null);

  const openNode = (id) => {
    if (!id) return;
    setNodesOpen(true);
    setActiveNode(id);
    setBench((held) => {
      if (held.includes(id)) return held;
      if (held.length < BENCH_SLOTS) return [...held, id];
      const evict = held.find((x) => x !== activeNode) ?? held[0];
      return [...held.filter((x) => x !== evict), id];
    });
    const had = details.get(id);
    if (!database || (had && !had.error)) return;
    readHeld(id, database.id);
  };

  const readHeld = (id, db) => {
    const live = () => databaseRef.current === db;
    api.fetchNode(id, db)
      .then((data) => { if (live()) setDetails((all) => new Map(all).set(id, data)); })
      .catch((error) => { if (live()) setDetails((all) => new Map(all).set(id, { error: error.message })); });
    api.fetchStanding(id, db)
      .then((data) => { if (live()) setStandings((all) => new Map(all).set(id, data)); })
      .catch(() => {});
  };

  const dropNode = (id) => {
    setBench((held) => {
      const next = held.filter((x) => x !== id);
      if (activeNode === id) {
        const at = held.indexOf(id);
        setActiveNode(next[Math.max(0, at - 1)] ?? null);
      }
      return next;
    });
    const drop = (all) => { const rest = new Map(all); rest.delete(id); return rest; };
    setDetails(drop);
    setStandings(drop);
  };

  const clearBench = () => { setBench([]); setActiveNode(null); setDetails(new Map()); setStandings(new Map()); };

  const benchKept = useRef(false);
  const restoreBench = (db) => {
    const held = (Array.isArray(saved.bench) ? saved.bench : [])
      .filter((id) => typeof id === "string" && id).slice(0, BENCH_SLOTS);
    if (held.length > 0) {
      setBench(held);
      setActiveNode(held.includes(saved.reading) ? saved.reading : held[held.length - 1]);
      for (const id of held) readHeld(id, db.id);
    }
    benchKept.current = true;
  };

  useEffect(() => {
    if (benchKept.current) save({ bench, reading: activeNode });
  }, [bench, activeNode]);

  const [coverage, setCoverage] = useState(null);

  const replace = (data) => {
    changeRef.current = null;
    setNodes(data.nodes);
    setLinks(data.links);

    setEmpty(data.nodes.length === 0 && (data.total ?? 0) === 0);
    setCoverage({
      total: data.total ?? data.nodes.length,
      truncated: data.truncated === true,
      counting: data.counting ?? "objects",
    });
  };

  const lastView = useRef(null);

  const loadTopology = (request, replayFor = null, change = null) => {
    lastView.current = { request };

    setReachPath(null);
    const id = begin("topology");
    if (!replayFor && (expanded.length > 0 || hidden.length > 0)) {
      save({ expanded: [], hidden: [] });
    }
    setLoading(true);
    clearSelection();
    request()
      .then(async (data) => {
        if (!current("topology", id)) return;
        replace(replayFor ? await replayGestures(data, replayFor) : data);
        if (change) changeRef.current = change;
      })
      .catch(() => { if (current("topology", id)) replace({ nodes: [], links: [] }); })
      .finally(() => { if (current("topology", id)) setLoading(false); });
  };

  const replayGestures = async (data, db, gestures = { expanded, hidden }) => {
    const expanded_ = gestures.expanded ?? [];
    const hidden_ = gestures.hidden ?? [];
    if (!db || (expanded_.length === 0 && hidden_.length === 0)) return data;
    let nodes = data.nodes;
    let links = data.links;
    const results = await Promise.all(expanded_.map((id) => (
      api.fetchNeighbors(id, db.id).then((r) => [id, r]).catch(() => null)
    )));
    let truncated = data.truncated === true;
    for (const result of results) {
      if (!result) continue;
      const [id, incoming] = result;
      const merged = merge(nodes, links, incoming, id);
      nodes = merged.nodes;
      links = merged.links;
      if (incoming.truncated) truncated = true;
    }
    if (hidden_.length > 0) {

      const gone = new Set(hidden_);
      const left = without(nodes, links.filter((link) => !gone.has(link.from)), gone);
      nodes = left.nodes;
      links = left.links;
    }
    return { ...data, nodes, links, truncated };
  };

  const switchDatabase = (db) => {
    if ((db?.id ?? null) !== databaseRef.current) {
      clearBench(); setReadingFold(null);

      setRoutes([]); setZones(null); setFindings(null); setNotCollected(null); setDelegations(null); setHistory([]);
    }

    databaseRef.current = db?.id ?? null;
    setDatabase(db);
  };

  const forDb = (db, set) => (value) => { if (databaseRef.current === db.id) set(value); };

  const enterDatabase = (db) => {
    switchDatabase(db);
    save({ databaseId: db?.id ?? null, ...perDatabase() });
  };

  const openDatabase = (db, replaying = false) => {
    const query = queries.find((q) => q.id === saved.queryId);

    const draft = typeof saved.scriptDraft === "string" ? saved.scriptDraft : null;
    const typed = () => { if (draft !== null) { setScriptText(draft); save({ scriptDraft: draft }); } };
    const asTyped = typeof saved.scriptSource === "string"
      && saved.scriptSource.replace(/\s+/g, " ").trim() === saved.script ? saved.scriptSource : saved.script;
    if (query) { runQuery(query, db, replaying); typed(); }
    else if (saved.script) { setScriptText(asTyped); runScript(asTyped, db, replaying).then(typed); }
    else { clearCanvas(); typed(); }
  };

  const pickDatabase = (db) => {
    enterDatabase(db);
    openDatabase(db);
    loadHistory(db);
    loadRoutes(db);
    loadZones(db);
    loadFindings(db);
  };

  const clearCanvas = () => {
    begin("topology");
    lastView.current = null;
    clearSelection();
    changeRef.current = null;
    setNodes([]);
    setLinks([]);
    setEmpty(false);
    setCoverage(null);

    setRoutes([]);
    setReachPath(null);
  };

  const showFullDomain = (db = database) => {
    if (!db) return;
    setActiveQuery(DOMAIN_VIEW);

    save({ queryId: null, script: null });
    const sentence = "find objects show paths";
    ask(sentence);
    loadTopology(() => api.runScript(sentence, db.id), null, { fixedLayout: DEFAULT_LAYOUT });
  };

  const runQuery = (query, db = database, replaying = false) => {
    if (!db) return;
    setActiveQuery(query.id);

    ask(query.script ?? null);
    save({ queryId: query.id, script: null });
    loadTopology(() => api.fetchQuery(query.id, db.id), replaying ? db : null);
  };

  const runScript = (source, db = database, replaying = false) => {
    const kept = replaying && typeof replaying === "object" ? replaying : null;

    const sentence = (source ?? "").replace(/\s+/g, " ").trim();
    if (!db || !sentence) return Promise.resolve(false);
    const id = begin("topology");
    setScriptError(null);
    setLoading(true);
    return api.runScript(sentence, db.id)
      .then(async (data) => {
        if (!current("topology", id)) return false;

        if (data.flow && data.nodes.length === 0) { flash("NO ROUTE"); return false; }
        setActiveQuery(null);
        setReachPath(null);

        save({
          queryId: null, script: sentence,

          scriptSource: /\n/.test(source ?? "") ? source : null, scriptDraft: null,
          ...(kept ? { expanded: kept.expanded ?? [], hidden: kept.hidden ?? [] }
            : replaying ? {} : { expanded: [], hidden: [] }),
        });

        setScriptText((typed) => ((typed ?? "").replace(/\s+/g, " ").trim() === sentence ? typed : sentence));
        setScriptError(null);
        lastView.current = { request: () => api.runScript(sentence, db.id), flow: data.flow };
        clearSelection();
        replace(replaying ? await replayGestures(data, db, kept ?? undefined) : data);
        if (data.flow) changeRef.current = { flow: true };
        return true;
      })

      .catch((error) => {
        if (current("topology", id)) setScriptError({ line: error.message, source: sentence });
        return false;
      })
      .finally(() => { if (current("topology", id)) setLoading(false); });
  };

  const selectNode = (index, id = nodes[index]?.id) => {
    setSelectedIndex(index);
    openNode(id);
  };

  const showOnly = (hit) => {
    if (!database) return;
    setActiveQuery(null);
    save({ queryId: null, script: null });
    ask(null);

    begin("topology");
    lastView.current = {
      request: () => api.fetchNode(hit.id, database.id)
        .then((d) => ({ nodes: [nodeOf(d)], links: [] })),
    };
    replace({ nodes: [hit], links: [] });
    selectNode(0, hit.id);
  };

  const nodeOf = (d) => ({
    id: d.id, label: d.label, kind: d.kind,
    tierZero: d.tierZero, tierZeroSeed: d.tierZeroSeed, owned: d.owned,
  });

  const openAround = (index, filter, then) => {
    const id = nodes[index]?.id;
    if (!id || !database) return;
    const reqId = begin("topology");
    api.fetchNeighbors(id, database.id, filter)
      .then((incoming) => {
        if (!current("topology", reqId)) return;

        const merged = merge(allNodes, allLinks, incoming, id);
        if (!expanded.includes(id)) save({ expanded: [...expanded, id].slice(-CAPS.opened) });
        changeRef.current = { open: index };
        setNodes(merged.nodes);
        setLinks(merged.links);
        then?.(incoming, merged);
      })
      .catch(() => {});
  };
  const expandNode = (index, thenSelect) => openAround(index, undefined, (incoming, merged) => {

    if (incoming.truncated) {
      setCoverage((c) => ({ ...(c ?? { total: 0, counting: "objects" }), truncated: true }));
    }
    const drawn = drawnOf(merged.nodes, merged.links).nodes;
    const target = thenSelect ? drawn.findIndex((n) => n.id === thenSelect) : -1;
    if (target >= 0) selectNode(target, thenSelect);
  });

  const expandKind = (index, { kind, direction }) => openAround(index, { kind, direction });

  const collapseNode = (id) => {
    const at = new Map(allNodes.map((node, i) => [node.id, i]));
    const hub = at.get(id);
    if (hub === undefined) return;

    const kept = allLinks.filter((link) => link.source !== hub && link.from !== id);
    const anchored = new Set([id]);
    for (const link of kept) {
      anchored.add(allNodes[link.source]?.id);
      anchored.add(allNodes[link.target]?.id);
    }

    const gone = new Set();
    for (const link of allLinks) {
      if (link.source !== hub) continue;
      const other = allNodes[link.target]?.id;

      if (other && !anchored.has(other)) gone.add(other);
    }

    let grew = true;
    while (grew) {
      grew = false;
      for (const node of allNodes) {
        if (gone.has(node.id) || node.id === id) continue;
        if (node.from === id || (node.from && gone.has(node.from))) { gone.add(node.id); grew = true; }
      }
    }

    const opened = new Set([id, ...gone]);
    const left_ = allLinks.filter((link) => link.source !== hub && !opened.has(link.from));
    if (gone.size === 0 && left_.length === allLinks.length) return;

    save({ expanded: expanded.filter((open) => !opened.has(open)) });
    const left = without(allNodes, left_, gone);
    changeRef.current = { keep: true };
    setNodes(left.nodes);
    setLinks(left.links);

    const selectedId = selectedIndex !== null ? nodes[selectedIndex]?.id : null;
    const drawn = drawnOf(left.nodes, left.links).nodes;
    const next = selectedId ? drawn.findIndex((n) => n.id === selectedId) : -1;
    setSelectedIndex(next >= 0 ? next : null);
    if (next < 0) setDetail(null);
  };

  const toggleNode = (index) => {
    const id = nodes[index]?.id;
    if (!id) return;
    const hub = allNodes.findIndex((node) => node.id === id);
    const opened = allLinks.some((link) => link.source === hub || link.from === id)
      || allNodes.some((node) => node.from === id);
    if (opened) collapseNode(id);
    else expandNode(index);
  };

  const flashRef = useRef(null);
  const flash = (text) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  };
  flashRef.current = flash;
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const pinNode = () => {
    const node = nodes[selectedIndex];
    if (!node) return;
    setPinned(pinned?.id === node.id ? null : { id: node.id, label: node.label });
  };

  const runPath = (id, label, from = pinned) => {
    if (!database || !from) return;
    runScript(`path objects where id = "${from.id}" to objects where id = "${id}" via any`)
      .then((drawn) => { if (drawn) setPathTarget({ id, label }); });
  };

  const followEdge = (otherId) => {
    const at = nodes.findIndex((n) => n.id === otherId);
    if (at >= 0) { selectNode(at); return; }

    const edge = detail?.edges.find((e) => e.otherId === otherId);
    const hub = nodes.findIndex((n) => n.id === detail?.id);
    if (!edge || hub < 0) return;
    if (edge.direction === "out") { expandNode(hub, otherId); return; }

    const anchor = allNodes.findIndex((n) => n.id === detail.id);
    if (anchor < 0) return;
    const nodesAll = allNodes.concat({ ...rowNode(edge), from: detail.id });

    const linksAll = allLinks.concat([{
      source: nodesAll.length - 1, target: anchor, kinds: [edge.kind], from: detail.id,
    }]);
    changeRef.current = { open: hub };
    setNodes(nodesAll);
    setLinks(linksAll);
    const index = drawnOf(nodesAll, linksAll).nodes.findIndex((n) => n.id === otherId);
    if (index >= 0) selectNode(index, otherId);
  };

  const hideNode = () => {
    if (selectedIndex === null) return;
    const gone = new Set([nodes[selectedIndex].id]);
    for (const node of allNodes) if (node.from && gone.has(node.from)) gone.add(node.id);

    clearSelection();

    save({ hidden: [...new Set([...hidden, ...gone])].slice(-CAPS.hidden) });
    changeRef.current = { keep: true };
    const left = without(allNodes, allLinks.filter((link) => !gone.has(link.from)), gone);
    setNodes(left.nodes);
    setLinks(left.links);
    setEmpty(left.nodes.length === 0);
  };

  const isolate = (direction) => {
    if (!detail || !database) return;
    const node = nodes.find((n) => n.id === detail.id) ?? nodeOf(detail);
    begin("topology");
    lastView.current = {
      request: () => api.fetchNode(node.id, database.id)
        .then((d) => isolateView(nodeOf(d), d, direction)),
    };
    replace(isolateView(node, detail, direction));
    setSelectedIndex(0);
  };

  const isolateView = (node, detailData, direction) => {
    const view = [node];
    const viewLinks = [];
    const seen = new Map([[node.id, 0]]);
    for (const edge of detailData.edges) {
      if (edge.direction !== direction) continue;
      let other = seen.get(edge.otherId);
      if (other === undefined) {
        other = view.length;
        seen.set(edge.otherId, other);
        view.push({ ...rowNode(edge), from: node.id });
      }

      const [source, target] = direction === "out" ? [0, other] : [other, 0];
      const existing = viewLinks.find((l) => l.source === source && l.target === target);
      if (existing) existing.kinds.push(edge.kind);
      else viewLinks.push({ source, target, kinds: [edge.kind], from: node.id });
    }
    return { nodes: view, links: viewLinks };
  };

  const back = () => {

    if (readingRoute) { setReadingRoute(false); return; }
    if (readingFold) { setReadingFold(null); return; }
    enterDatabase(null);

    clearCanvas();
  };

  const loadLibrary = (db = database) => {
    if (!db) { setSavedFilters([]); return; }
    api.listLibrary(db.id, "filter").then(setSavedFilters).catch(() => setSavedFilters([]));
  };
  useEffect(() => { loadLibrary(database); setEditingFilter(null); }, [database?.id]);

  const oneLine = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const viewOf = (text) => (saved.script && !saved.queryId && oneLine(text) === saved.script
    ? { expanded, hidden, layoutMode, placed: placedOnCanvas(), lit: viewRef.current?.lit() ?? {} } : null);

  const placedOnCanvas = () => {
    const all = viewRef.current?.layout() ?? {};
    const drawn = new Set(nodes.map((n) => n.id));
    return Object.fromEntries(Object.entries(all).filter(([id]) => drawn.has(id)));
  };

  const keptView = (text, id) => {
    const sentence = oneLine(text);
    const was = id ? savedFilters.find((f) => f.id === id) : null;
    return viewOf(sentence) ?? (was?.body?.script === sentence ? was.body.view ?? null : null);
  };

  const nameTaken = (name, except) => {
    const key = oneLine(name).toLowerCase();
    return savedFilters.some((f) => f.id !== except && oneLine(f.title).toLowerCase() === key);
  };

  const saveFilter = ({ id, title, description, script, body: kept = null }) => {
    if (!database) return Promise.reject(new Error("No database is open."));
    const typed = (script ?? "").trim();
    const body = kept ?? (() => {
      const view = keptView(typed, id);
      return { script: oneLine(typed), ...(typed.includes("\n") ? { source: typed } : {}), ...(view ? { view } : {}) };
    })();
    const renaming = Boolean(kept) && Boolean(id);
    return api.saveLibrary(database.id, { id: id ?? api.libraryId(), kind: "filter", title, description, body })
      .then((item) => {
        setSavedFilters((list) => [item, ...list.filter((f) => f.id !== item.id)]);
        flash(renaming ? "ENTRY RENAMED" : id ? "ALMANAC UPDATED" : "SAVED TO ALMANAC");
        return item;
      });
  };

  const runSaved = (filter) => {
    const view = filter.body?.view;
    if (view?.layoutMode && LAYOUTS.some((l) => l.id === view.layoutMode)) save({ layoutMode: view.layoutMode });

    viewRef.current?.replacePlaced(view?.placed ?? {});
    viewRef.current?.setLit(view?.lit ?? {});
    save({ layout: view?.placed ?? {}, lit: view?.lit ?? {} });
    setScriptText(filter.body?.source ?? filter.body?.script ?? "");

    return runScript(filter.body?.source ?? filter.body?.script ?? "", database, view ? { expanded: view.expanded, hidden: view.hidden } : false)
      .then((drawn) => { if (drawn) setActiveQuery(`saved:${filter.id}`); });
  };

  const editSaved = (filter) => {
    typeScript(filter.body?.source ?? filter.body?.script ?? "");
    setScriptError(null);
    setScriptOpen(true);
    setEditingFilter(filter);
  };
  const deleteSaved = (filter) => {
    const removed = () => {
      setSavedFilters((list) => list.filter((f) => f.id !== filter.id));
      if (editingFilter?.id === filter.id) setEditingFilter(null);
      flash("REMOVED FROM ALMANAC");
    };
    return api.deleteLibrary(filter.id)
      .then(removed)
      .catch(() => api.listLibrary(database.id, "filter")
        .then((items) => {
          if (items.some((f) => f.id === filter.id)) { setSavedFilters(items); flash("DELETE FAILED"); }
          else removed();
        })
        .catch(() => flash("DELETE FAILED")));
  };

  const [renamingFilter, setRenamingFilter] = useState(null);
  const copySaved = (filter) => {
    const text = filter.body?.source ?? filter.body?.script ?? "";

    if (!navigator.clipboard?.writeText) { flash("COPY NOT AVAILABLE HERE"); return; }
    navigator.clipboard.writeText(text)
      .then(() => flash("SCRIPT COPIED"))
      .catch(() => flash("COPY FAILED"));
  };

  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    setDatabase(null);
    setDatabases([]);
    setNodes([]);
    setLinks([]);
    setSelectedIndex(null);
    clearBench();
    setEmpty(false);
    setCatalogReady(false);
    listDatabases()
      .then((all) => { setDatabases(all); setListFault(null); })
      .catch((error) => { setDatabases([]); setListFault(error.message); });

    api.listQueries()
      .then(setQueries)
      .catch(() => setQueries([]))
      .finally(() => setCatalogReady(true));
  }, []);

  useDatabasesChanged(() => listDatabases()
    .then((all) => { setDatabases(all); setListFault(null); }).catch(() => {}));

  const replayedFor = useRef(-1);
  useEffect(() => {
    if (replayedFor.current === aimed || !savedReady || !catalogReady || databases.length === 0) return;
    replayedFor.current = aimed;

    const db = databases.find((d) => d.id === saved.databaseId);
    if (!db) {

      benchKept.current = true;
      save({ databaseId: null, ...perDatabase() });
      return;
    }

    viewRef.current?.restore(saved.layout, saved.camera);
    viewRef.current?.setLit(saved.lit ?? {});
    switchDatabase(db);
    restoreBench(db);
    openDatabase(db, true);
    loadHistory(db);
    loadRoutes(db);
    loadZones(db);
    loadFindings(db);
  }, [savedReady, catalogReady, databases, queries, aimed]);

  const theme = useKindGlyphs();
  useEffect(() => { viewRef.current?.retheme(); }, [theme]);

  const handlersRef = useRef({});
  handlersRef.current = {
    onSelect: selectNode,
    onExpand: toggleNode,
    onClearSelection: clearSelection,
    onContextMenu: (index, x, y, link = null) => {

      if (index !== null && index !== undefined) selectNode(index);

      setMenu({ index: index ?? null, link: link !== null ? viewRef.current?.linkInfo(link) ?? null : null, x, y });

      setAround(null);
      const id = index != null ? nodes[index]?.id : null;
      if (!id || !database) return;
      api.fetchAround(id, database.id)
        .then((rows) => setAround(rows ?? []))
        .catch(() => setAround([]));
    },

    onLayoutChange: (layout) => save({ layout }),
    onLitChange: (lit) => save({ lit: Object.fromEntries(Object.entries(lit).slice(-CAPS.lit)) }),
    onCameraChange: (camera) => save({ camera }),

    onIconsLegible: (on) => setGlyphsLegible(on),

    onContextLost: () => flashRef.current?.("GRAPHICS CONTEXT LOST, RESTORING"),
    covered: () => coveredShare(sceneRef.current?.parentElement),
  };

  const rearrange = () => viewRef.current?.rearrange();

  useEffect(() => { viewRef.current?.setLit(saved.lit ?? {}); }, [saved.lit]);

  useEffect(() => {
    viewRef.current = new GraphView(hostRef.current, sceneRef.current, {
      onSelect: (i) => handlersRef.current.onSelect(i),
      onExpand: (i) => handlersRef.current.onExpand(i),
      onClearSelection: () => handlersRef.current.onClearSelection(),
      onLayoutChange: (layout) => handlersRef.current.onLayoutChange(layout),
      onLitChange: (lit) => handlersRef.current.onLitChange(lit),
      onCameraChange: (camera) => handlersRef.current.onCameraChange(camera),
      onContextMenu: (index, x, y, link) => handlersRef.current.onContextMenu(index, x, y, link),
      onIconsLegible: (on) => handlersRef.current.onIconsLegible(on),
      onContextLost: () => handlersRef.current.onContextLost(),
      covered: () => handlersRef.current.covered(),
      labels: () => ({
        elements: labelRefs.current,
        links: linkLabelRefs.current,
        rings: ringRefs.current,
        owned: ownedRefs.current,
        icons: iconRefs.current,
        reticles: reticleRefs.current,
        marquee: marqueeRef.current,
        clusters: clusterRefs.current,
        selected: selectedRef.current,
        routes: routesRef.current,
      }),
    });

    viewRef.current.setPlacedCap(CAPS.placed);
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    labelRefs.current.length = nodes.length;
    linkLabelRefs.current.length = links.length;
    ringRefs.current.length = nodes.length;
    ownedRefs.current.length = nodes.length;
    iconRefs.current.length = nodes.length;
    const change = changeRef.current;
    changeRef.current = null;
    viewRef.current?.setTopology(nodes, links, change);

    setClusters(viewRef.current?.clusters ?? []);

    if (restoring.current) {
      restoring.current = false;
      setLoading(false);
    }
  }, [nodes, links]);

  useEffect(() => {
    if (inspecting === null) return;
    const at = nodes.findIndex((node) => node.id === inspecting);
    setSelectedIndex(at >= 0 ? at : null);
  }, [nodes, inspecting]);

  useEffect(() => { viewRef.current?.setSelected(selectedIndex); }, [selectedIndex]);

  useEffect(() => { viewRef.current?.highlight(selectedIndex); }, [selectedIndex, nodes, links]);

  useEffect(() => { clusterRefs.current.length = clusters.length; }, [clusters]);

  useEffect(() => { viewRef.current?.setLabelMode(labels); }, [labels]);
  useEffect(() => { viewRef.current?.setTinted(tinted); }, [tinted, nodes]);
  useEffect(() => {
    viewRef.current?.setLayoutMode(layoutMode);

    setClusters(viewRef.current?.clusters ?? []);
  }, [layoutMode]);
  useEffect(() => { viewRef.current?.setKinds(kinds); }, [kinds]);

  useEffect(() => { viewRef.current?.setPointScale(pointScale); }, [pointScale, nodes]);

  const overlay = notice ?? (empty && !loading ? "NONE" : null);

  const overlayText = useRef("");
  if (overlay) overlayText.current = overlay;

  useEffect(() => {
    viewRef.current?.setDimmed(overlay !== null || loading);
  }, [overlay, loading]);

  const selectedRef = useRef(null);
  selectedRef.current = selectedIndex;

  const nodeLabels = useMemo(() => nodes.map((node, i) => html`
    <div className="node-label mono" key=${i} data-index=${i}
      ref=${(el) => { labelRefs.current[i] = el; }}><span className="node-name-full">${node.label}</span><span className="node-name-short">${shortName(node.label, node.kind)}</span><span className="node-kind">${node.kind}</span></div>`), [nodes]);
  const tierRings = useMemo(() => nodes.map((node, i) => node.tierZeroSeed && html`
    <div className="tier-ring" key=${`ring-${i}`}
      ref=${(el) => { ringRefs.current[i] = el; }}></div>`), [nodes]);
  const ownedMarks = useMemo(() => nodes.map((node, i) => node.owned && html`
    <div className="owned-mark" key=${`owned-${i}`}
      ref=${(el) => { ownedRefs.current[i] = el; }}><${OwnedFlag} /></div>`), [nodes]);
  const nodeIcons = useMemo(() => glyphsLegible
    && nodes.map((node, i) => html`
      <div className=${`node-icon ${glyphClass(node.kind)}`} key=${`icon-${node.id}`}
        ref=${(el) => { iconRefs.current[i] = el; }}></div>`), [nodes, glyphsLegible]);

  const linkLabels = useMemo(() => links.length <= LINK_LABEL_MAX && links.map((link, i) => html`
    <div className="link-label mono" key=${i}
      ref=${(el) => { linkLabelRefs.current[i] = el; }}>${summariseKinds(link.kinds)}</div>`), [links]);
  const clusterLabels = useMemo(() => clusters.map((cluster, i) => html`
    <div className="cluster-label mono" key=${`cluster-${i}-${cluster.kind}`}
      ref=${(el) => { clusterRefs.current[i] = el; }}>
      <span className="cluster-label-name">${KIND_LABELS[cluster.kind] ?? cluster.kind}</span>
      <span className="cluster-label-count">${count(cluster.count)}</span>
    </div>`), [clusters]);

  const status = database ? database.name : "none";

  const fixedLayout = activeQuery === DOMAIN_VIEW ? DEFAULT_LAYOUT : null;
  const settings = { full, labels, tinted, kinds, pointScale, edgeCensus, hiddenEdgeKinds, census, hiddenKinds, layoutMode, fixedLayout };

  const edgeKindsOff = edgeCensus.filter((c) => hiddenEdgeKinds.includes(c.kind)).length;

  const nodePanelOpen = nodesOpen && savedReady && bench.length > 0;

  const [frameReady, framePart] = useReadiness(PANEL_FRAME);
  useEffect(() => { if (savedReady) framePart("view"); }, [savedReady]);
  useEffect(() => { if (catalogReady) framePart("catalogue"); }, [catalogReady]);
  const panelShown = panelOpen && frameReady;

  const headingValue = level === "databases" ? databases.length
    : level === "route" ? "Route"
    : level === "zones" ? "Privilege zones"
    : level === "delegations" ? "ACL delegations" : "Filters";

  return html`<div data-panel-frame className=${"panel panel--graph" + (nodePanelOpen ? " panel--graph-right" : "")}>
    <div className="toolbar">
      <${Button} text="Domain" active=${panelOpen}
        onClick=${() => setPanelOpen(!panelOpen)} />
      <${Button} text="Nodes" active=${nodesOpen && bench.length > 0}
        disabled=${bench.length === 0}
        title="Objects you have opened, up to five at once"
        onClick=${() => setNodesOpen(!nodesOpen)} />
      <${ViewMenu} rows=${viewRows(settings)} onAct=${runAction} />
      <${PathBar} database=${database} pinned=${pinned} target=${pathTarget}
        searchOpen=${searchOpen} onSearchOpen=${setSearchOpen}
        onTarget=${setPathTarget} selected=${nodes[selectedIndex]}
        onPinSelected=${pinNode} onPin=${setPinned} onRun=${runPath} onShow=${showOnly}
        scripting=${scriptOpen}
        onScript=${() => {
          if (scriptOpen) setScriptError(null);
          setScriptOpen(!scriptOpen);
        }}
        />
    </div>

    <div className=${"graph-box" + (empty && !loading ? " graph-box--empty" : "")
        + (tinted ? " graph-box--tinted" : "")
        + (full ? " graph-box--full" : "")
        + (panelShown ? " graph-box--panel" : "")
        + (nodePanelOpen ? " graph-box--panel-right" : "")}>
      <${CanvasMenu} at=${menu} node=${menu?.index != null ? nodes[menu.index] : null} link=${menu?.link ?? null}
        pinned=${pinned} settings=${settings} around=${around}
        onClose=${closeMenu} onAct=${runAction} />
      <div className="graph-scene" ref=${sceneRef}>
        <div className="graph-host" ref=${hostRef}></div>
        <canvas className="graph-routes" ref=${routesRef}></canvas>
        ${ ""}
        ${linkLabels}
        ${nodeLabels}
        ${ ""}
        <svg className="reticle reticle--hover" viewBox="0 0 100 100"
          ref=${(el) => { reticleRefs.current.hover = el; }}><rect x="2" y="2" width="96" height="96" rx="0" /></svg>
        <svg className="reticle reticle--select" viewBox="0 0 100 100"
          ref=${(el) => { reticleRefs.current.select = el; }}><rect x="2" y="2" width="96" height="96" rx="0" /></svg>
        <div className="reticle-group" ref=${(el) => { reticleRefs.current.group = el; }}></div>
        ${tierRings}
        ${ ""}
        ${nodeIcons}
        ${ ""}
        ${ownedMarks}
        ${clusterLabels}
        <div className="graph-marquee" ref=${(el) => { marqueeRef.current.box = el; }}></div>
        <div className="graph-marquee-count mono" ref=${(el) => { marqueeRef.current.count = el; }}></div>
      </div>

      <div className=${"graph-empty mono" + (overlay ? " graph-empty--shown" : "")}>
        ${overlayText.current}
      </div>

      <${Loading} shown=${loading && !overlay} />

      ${ ""}
      ${nodes.length > 0 && html`<span className="graph-keys"><${Keys} keys="shift+drag" /> Select</span>`}

      ${ ""}
      <span className=${"graph-counts label mono"
        + (coverage?.truncated ? " graph-counts--partial" : "")
        + (edgeKindsOff > 0 ? " graph-counts--filtered" : "")}>
        <span className="graph-counts-db">${status}</span>
        <span>${count(nodes.length)} nodes</span>
        <span>${count(links.length)} edges</span>
        ${edgeKindsOff > 0 && html`<span>${edgeCensus.length - edgeKindsOff} of ${edgeCensus.length} edge types</span>`}
        ${coverage?.truncated && html`<span>of ${count(coverage.total)} ${coverage.counting}</span>`}
      </span>

      <${FilterPanel} open=${panelShown} level=${level} heading=${headingValue} onBack=${back}
        databaseId=${database?.id} databases=${databases} listFault=${listFault} queries=${queries}
        routes=${routes.filter((path) => !routesDismissed.includes(routeKey(path)))}
        population=${routePopulation}
        openRoute=${openRoute} onOpenRoute=${openReachPath} onDismissRoute=${dismissRoute}
        zones=${zones} onOpenCrossing=${openCrossing} findings=${findings} coverage=${notCollected}
        delegations=${delegations}
        onOpenLevel=${setReadingFold}
        onOpenNode=${(id) => openNode(id)}
        onOpenReview=${(item) => (item.kind === "crossing"
          ? openCrossing({ sourceId: item.source, sourceLabel: item.sourceLabel,
                           targetId: item.target, targetLabel: item.targetLabel })
          : openNode(item.id))}
        activeQuery=${activeQuery}
        savedFilters=${savedFilters} onRunSaved=${runSaved} onEditSaved=${editSaved} onDeleteSaved=${deleteSaved}
        onRenameSaved=${setRenamingFilter} onCopySaved=${copySaved}
        onPickDatabase=${pickDatabase} onRunQuery=${runQuery}
        onFullDomain=${showFullDomain} />

      ${ ""}
      <${SaveDialog} isOpen=${Boolean(renamingFilter)} editing=${renamingFilter} taken=${nameTaken}
        sentence=${renamingFilter?.body?.source ?? renamingFilter?.body?.script ?? ""}
        keepsView=${Boolean(renamingFilter?.body?.view)}
        onSave=${({ title, description, asNew }) => saveFilter({
          id: asNew ? null : renamingFilter.id, title, description, body: renamingFilter.body })}
        onClose=${() => setRenamingFilter(null)} />

      ${ ""}
      <${ScriptEditor} shown=${scriptOpen && Boolean(database)} dbId=${database?.id} text=${scriptText}
        catalog=${queries} saved=${savedFilters}
        error=${scriptError} busy=${loading}
        onText=${typeScript} onRun=${runScript}
        frame=${scriptFrame} onFrame=${(frame) => save({ scriptFrame: frame })}
        editing=${editingFilter} onSave=${saveFilter} onStopEditing=${() => setEditingFilter(null)}
        keepsView=${(text, id) => Boolean(keptView(text, id))} taken=${nameTaken}
        onClose=${() => setScriptOpen(false)} />

      <${NodePanel} open=${nodePanelOpen}
        bench=${bench} activeNode=${activeNode} details=${details} standings=${standings}
        nodes=${nodes}
        onActivate=${openNode} onDrop=${dropNode}
        onIsolate=${isolate} onFollow=${followEdge}
        history=${history} busy=${writing} onApply=${apply} />
    </div>
  </div>`;
}

function coveredShare(box) {
  if (!box || !box.clientWidth || !box.clientHeight) return null;
  const w = box.clientWidth, h = box.clientHeight;
  const side = (selector, fromRight) => {
    const panel = box.querySelector(selector);
    if (!panel || !panel.classList.contains("side-panel--open")) return 0;
    const air = fromRight ? w - panel.offsetLeft - panel.offsetWidth : panel.offsetLeft;
    return (panel.offsetWidth + 2 * air) / w;
  };
  const toolbar = box.classList.contains("graph-box--full") ? null : box.parentElement?.querySelector(":scope > .toolbar");

  const counts = box.querySelector(":scope > .graph-counts");
  const countsAir = counts ? h - counts.offsetTop - counts.offsetHeight : 0;
  return {
    left: side(".side-panel:not(.side-panel--right)", false),
    right: side(".side-panel--right", true),
    top: toolbar ? toolbar.offsetHeight / h : 0,
    bottom: counts ? (counts.offsetHeight + 2 * countsAir) / h : 0,
  };
}

export const aimGraph = (changes, { reset = false } = {}) => aim("graph", (view) => ({
  ...(reset || (changes.databaseId && changes.databaseId !== view.databaseId) ? perDatabase() : {}),
  expanded: [], hidden: [], layout: null, camera: null,
  ...changes,
}));

export const findOnGraph = async (databaseId = null) => {
  if (databaseId) {
    await aim("graph", (view) => (databaseId === view.databaseId
      ? view
      : { ...view, ...perDatabase(), databaseId }));
  }
  sendCommand("graph", "find");
};

const MOTIF = html`
    <path d="M2 74L52 16L108 48M52 16L12 8L20 52M12 8L-8 -6M108 48L82 84M162 -6L172 74M108 48L222 74M52 16L20 52M108 48L164 26L200 8" stroke="currentColor" stroke-width="1.6" fill="none"></path>
    ${[[52, 16], [108, 48], [82, 84], [172, 74], [20, 52], [164, 26], [12, 8]].map(([x, y]) => html`<circle key=${x} cx=${x} cy=${y} r="6" fill="currentColor"></circle>`)}`;

export default defineModule({
  id: "graph",
  title: "Graph",
  motif: MOTIF,
  Panel: GraphPanel,
  styles: [new URL("./graph.css", import.meta.url)],
});

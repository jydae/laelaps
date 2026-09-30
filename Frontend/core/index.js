export const { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, createElement, forwardRef, Fragment, Component } = window.React;
export const { createRoot, createPortal } = window.ReactDOM;
export const html = window.htm.bind(createElement);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const count = (n) => (n ?? 0).toLocaleString("en-US");

export const NA = "n/a";

const KB = 1000, MB = KB * 1000, GB = MB * 1000;
const scaled = (n) => {
  if (!n) return { value: 0, unit: "KB", decimals: 0 };
  if (n >= GB) return { value: n / GB, unit: "GB", decimals: n < 10 * GB ? 1 : 0 };
  if (n >= MB) return { value: n / MB, unit: "MB", decimals: n < 10 * MB ? 1 : 0 };
  return { value: Math.max(1, n / KB), unit: "KB", decimals: 0 };
};
export const bytes = (n) => {
  const { value, unit, decimals } = scaled(n);
  return `${value.toFixed(decimals)} ${unit}`;
};

export const utcMinute = (at) => at.toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function message(res) {
  try {
    const body = await res.json();
    return body?.error?.message ?? body?.message ?? body?.reason ?? null;
  } catch {
    return null;
  }
}

export async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const detail = await message(res);
    const error = new Error(detail ?? `${options?.method ?? "GET"} ${url} failed (${res.status})`);
    error.status = res.status;

    if (res.status === 401 && !url.startsWith("/api/project")) window.dispatchEvent(new Event("session-lost"));
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const send = (method, url, body, extra = {}) =>
  json(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...extra,
  });

export const post = (url, body) => send("POST", url, body);

const INGEST = "/api/ingest";

export const listDatabases = () => json(`${INGEST}/databases`);

export const fetchDatabase = (dbId) => json(`${INGEST}/database/${encodeURIComponent(dbId)}`);

export const uploadFile = (dbId, file, name) =>
  json(`${INGEST}/database/${encodeURIComponent(dbId)}/file/${encodeURIComponent(file.name)}`
    + (name ? `?name=${encodeURIComponent(name)}` : ""), { method: "POST", body: file });

export const analyzeDatabase = (dbId) =>
  json(`${INGEST}/database/${encodeURIComponent(dbId)}/analyze`, { method: "POST" });

export const listMergeCandidates = () => json(`${INGEST}/merge-candidates`).then((pairs) => pairs ?? []);

export const mergeDatabases = (sources, name) =>
  send("POST", `${INGEST}/merge`, { sources, name }).then((merged) => { databasesChanged(); return merged; });

export const deleteDatabase = (dbId) =>
  json(`${INGEST}/database/${encodeURIComponent(dbId)}`, { method: "DELETE" }).then(databasesChanged);

const DATABASES_CHANGED = "databases-changed";
export const databasesChanged = () => window.dispatchEvent(new Event(DATABASES_CHANGED));
export function useDatabasesChanged(fn) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const on = () => latest.current();
    window.addEventListener(DATABASES_CHANGED, on);
    return () => window.removeEventListener(DATABASES_CHANGED, on);
  }, []);
}

const PROJECT = "/api/project";

export const listProjects = () => json(PROJECT);
export const createProject = (body) => send("POST", PROJECT, body);
export const openProject = (id, password) => send("POST", `${PROJECT}/${encodeURIComponent(id)}/open`, { password });

export const currentSession = () => json(`${PROJECT}/me`);
export const closeProject = () => send("POST", `${PROJECT}/close`, {});
export const updateSettings = (changes) => send("PUT", `${PROJECT}/settings`, changes);
export const deleteProject = (password) => send("DELETE", PROJECT, { password });

const STATE = "/api/state";
const SAVE_DELAY = 400;

const DESCRIPTOR_BUDGET = 256 * 1024;

const ID_BYTES = 56;

const LAYOUT_ENTRY_BYTES = ID_BYTES + 18;

export const CAPS = {
  placed: Math.floor((DESCRIPTOR_BUDGET * 0.45) / LAYOUT_ENTRY_BYTES),
  opened: Math.floor((DESCRIPTOR_BUDGET * 0.125) / ID_BYTES),
  hidden: Math.floor((DESCRIPTOR_BUDGET * 0.125) / ID_BYTES),
  dismissed: Math.floor((DESCRIPTOR_BUDGET * 0.025) / (2 * ID_BYTES)),

  lit: Math.floor((DESCRIPTOR_BUDGET * 0.025) / (2 * ID_BYTES)),
};

const mounted = new Map();

export const aim = async (tab, changes) => {
  const resolve = (view) => ({ ...view, ...(typeof changes === "function" ? changes(view) : changes) });
  const hook = mounted.get(tab);
  if (hook) return hook(resolve);
  const url = `${STATE}/${encodeURIComponent(tab)}`;
  const view = (await json(url).catch(() => null))?.view ?? {};
  await send("PUT", url, resolve(view));
};

export function useViewState(tab, initial, onOversize) {
  const [view, setView] = useState(initial);
  const [ready, setReady] = useState(false);
  const [aimed, setAimed] = useState(0);

  const latest = useRef(initial);
  const timer = useRef(0);

  useEffect(() => {
    let live = true;
    json(`${STATE}/${encodeURIComponent(tab)}`)
      .then((data) => {
        if (!live) return;
        latest.current = { ...initial, ...(data?.view ?? {}) };
        setView(latest.current);
        setReady(true);
      })

      .catch(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [tab]);

  const pending = useRef(null);

  const flush = () => {
    if (!pending.current) return;
    const body = pending.current;
    pending.current = null;
    clearTimeout(timer.current);
    send("PUT", `${STATE}/${encodeURIComponent(tab)}`, body, { keepalive: true }).catch(() => {});
  };

  useEffect(() => flush, []);

  useEffect(() => {
    const take = (resolve) => {
      clearTimeout(timer.current);
      pending.current = null;
      latest.current = resolve(latest.current);
      setView(latest.current);
      setAimed((n) => n + 1);
      return send("PUT", `${STATE}/${encodeURIComponent(tab)}`, latest.current);
    };
    mounted.set(tab, take);
    return () => { if (mounted.get(tab) === take) mounted.delete(tab); };
  }, [tab]);

  const patch = (changes) => {
    const next = { ...latest.current, ...changes };
    const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
    if (Object.keys(next).every((key) => same(next[key], latest.current[key]))) return;

    latest.current = next;
    setView(next);

    clearTimeout(timer.current);
    const body = JSON.stringify(next);
    pending.current = body;
    timer.current = setTimeout(() => {
      pending.current = null;
      send("PUT", `${STATE}/${encodeURIComponent(tab)}`, body)
        .catch((error) => {

          if (error?.status === 413 || error?.status === 431) {
            onOversize?.(new Blob([body]).size);
          }
        });
    }, SAVE_DELAY);
  };

  return [view, patch, ready, aimed];
}

export function defineModule(manifest) {
  for (const key of ["id", "title", "Panel"]) {
    if (!manifest[key]) throw new Error(`Module is missing "${key}"`);
  }
  return Object.freeze({ styles: [], enabled: () => true, ...manifest });
}

export function loadModuleStyles(modules) {
  return Promise.all(modules.flatMap((module) => module.styles.map((href) => new Promise((done) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = String(href);
    link.dataset.module = module.id;
    link.onload = link.onerror = done;
    document.head.append(link);
  }))));
}

const GRAPH = "/api/graph";
const ASSERT = "/api/assert";

const q = encodeURIComponent;

export const listQueries = () => json(`${GRAPH}/queries`);

export const fetchFindings = (dbId) => json(`${GRAPH}/findings?db=${q(dbId)}`);

export const fetchQuery = (queryId, dbId) =>
  json(`${GRAPH}/query/${q(queryId)}?db=${q(dbId)}`);

export const runScript = (script, dbId) => post(`${GRAPH}/script`, { db: dbId, script });

export const complete = (prefix, dbId) => post(`${GRAPH}/complete`, { db: dbId, script: prefix });

export const searchNodes = (term, dbId, from = 0) =>
  json(`${GRAPH}/search?db=${q(dbId)}&q=${q(term)}&from=${from}`);

export const fetchRoutes = (dbId) => json(`${GRAPH}/routes?db=${q(dbId)}`);

export const fetchZones = (dbId) => json(`${GRAPH}/zones?db=${q(dbId)}`);

export const fetchCoverage = (dbId) => json(`${GRAPH}/coverage?db=${q(dbId)}`);

export const fetchDelegations = (dbId) => json(`${GRAPH}/delegations?db=${q(dbId)}`);

export const fetchNode = (id, dbId) => json(`${GRAPH}/node/${q(id)}?db=${q(dbId)}`);

export const fetchNeighbors = (id, dbId, { kind, direction } = {}) =>
  json(`${GRAPH}/node/${q(id)}/neighbors?db=${q(dbId)}`
    + (kind ? `&kind=${q(Array.isArray(kind) ? kind.join(",") : kind)}` : "")
    + (direction ? `&direction=${q(direction)}` : ""));

export const fetchAround = (id, dbId) => json(`${GRAPH}/node/${q(id)}/around?db=${q(dbId)}`);

export const fetchStanding = (id, dbId) => json(`${GRAPH}/node/${q(id)}/standing?db=${q(dbId)}`);

export const libraryId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const listLibrary = (dbId, kind) => json(`/api/library?db=${q(dbId)}&kind=${q(kind)}`).then((items) => items ?? []);

export const saveLibrary = (dbId, item) => send("PUT", `/api/library/${q(item.id)}`, {
  db: dbId, kind: item.kind, title: item.title, description: item.description ?? "", body: item.body ?? {},
});

export const deleteLibrary = (id) => json(`/api/library/${q(id)}`, { method: "DELETE" });

export const apply = (db, change, reason) =>
  post(ASSERT, { db, reason, change }).then((outcome) => { databasesChanged(); return outcome; });

export const history = (db) => json(`${ASSERT}?db=${q(db)}`);

export const change = {
  rename: (id, label) => ({
    subject: id, subjectKind: "node", op: "rename", value: { label },
  }),
  owned: (id, owned, reason) => ({
    subject: id, subjectKind: "node", op: "owned", value: { owned }, reason,
  }),
  zone: (id, member, reason) => ({
    subject: id, subjectKind: "node", op: "zone", value: { member }, reason,
  }),
  annotate: (id, text, key = "note") => ({
    subject: id, subjectKind: "node", op: "annotate", value: { key, text },
  }),
  link: (source, kind, target) => ({
    subject: `${source}|${kind}|${target}`, subjectKind: "edge", op: "link", value: {},
  }),
};

import {
  count, listDatabases, fetchDatabase, analyzeDatabase, listMergeCandidates, mergeDatabases,
  deleteDatabase, databasesChanged, useDatabasesChanged, useViewState,
} from "../../core/index.js";
import {
  html, useCallback, useEffect, useRef, useState, Button, Popover, dropdown, Menu, MenuItem,
  MenuDivider, ProgressBar, mark, PageSection, ConfirmDialog,
} from "../../ui/index.js";
import { ingestBatch, newDatabaseId, ACCEPT } from "./upload.js";
import { DatabaseTable, settling } from "./databaseTable.js";
import { Inspector } from "./inspector.js";
import { DomainMap } from "./domainMap.js";

const VIEW = { databaseId: null };

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

const DROP_NOTE = "The collector's .zip or its .json files. Every upload is analysed when it finishes.";

const SETTLE_POLL_MS = 2500;

const doing = ({ phase, done, total, name }) => ({
  unpack: `Unpacking ${name}`,
  upload: `Uploading ${done + 1} of ${total}: ${name}`,
  analyse: `Analysing ${name}`,
  merge: `Merging ${name}`,
  delete: `Deleting ${name}`,
}[phase] ?? name);

function Destination({ databases, value, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const current = databases.find((d) => d.id === value) ?? null;
  const pick = (id) => { onChange(id); setOpen(false); };
  return html`<${Popover} ...${dropdown} isOpen=${open} disabled=${disabled}
    onInteraction=${(next) => setOpen(next)}
    content=${html`<${Menu} className="ing-destinations">
      <${MenuItem} text="New database" roleStructure="listoption" selected=${!current} onClick=${() => pick(null)} />
      ${databases.length > 0 && html`<${MenuDivider} />`}
      ${databases.map((db) => html`<${MenuItem} key=${db.id} text=${db.name}
        label=${`${count(db.fileCount)} files`} roleStructure="listoption"
        selected=${current?.id === db.id} onClick=${() => pick(db.id)} />`)}
    <//>`}>
    <${Button} className="ing-destination" ellipsizeText alignText="left" disabled=${disabled}
      text=${current ? current.name : "New database"} active=${open}
      rightIcon=${mark(open ? "chevron-up" : "chevron-down")} aria-label="Upload destination" />
  <//>`;
}

function Skipped({ skipped }) {
  const [open, setOpen] = useState(false);
  if (!skipped?.length) return null;
  return html`<${Popover} ...${dropdown} placement="bottom-end" isOpen=${open}
    onInteraction=${(next) => setOpen(next)}
    content=${html`<div className="ing-skipped">
      ${skipped.map((s, i) => html`<div key=${i} className="ing-skipped-row">
        <span className="mono ing-skipped-name">${s.name}</span>
        <span className="ing-skipped-why">${s.reason}</span>
      </div>`)}
    </div>`}>
    <${Button} small minimal text=${`${count(skipped.length)} skipped`}
      rightIcon=${mark(open ? "chevron-up" : "chevron-down")} />
  <//>`;
}

function StatusLine({ progress, result, onDismiss }) {
  if (progress) {
    const value = progress.phase === "upload" && progress.total > 0 ? progress.done / progress.total : undefined;
    return html`<div className="ing-status" role="status" aria-live="polite">
      <span className="ing-status-text">${doing(progress)}</span>
      <div className="ing-status-bar"><${ProgressBar} value=${value} animate=${value === undefined} stripes=${false} /></div>
    </div>`;
  }
  if (result) {
    return html`<div className=${"ing-status" + (result.fault ? " is-fault" : "")} role="status" aria-live="polite">
      <span className="ing-status-text" title=${result.note}>${result.note}</span>
      <${Skipped} skipped=${result.skipped} />
      <${Button} small minimal icon=${mark("cross")} aria-label="Dismiss" title="Dismiss" onClick=${onDismiss} />
    </div>`;
  }
  return html`<div className="ing-status"><span className="ing-status-text is-hint">${DROP_NOTE}</span></div>`;
}

export function IngestorPanel() {
  const [view, patch, ready] = useViewState("ingestor", VIEW);
  const [databases, setDatabases] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [pairs, setPairs] = useState([]);
  const [fault, setFault] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [destination, setDestination] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [doomed, setDoomed] = useState(null);
  const input = useRef(null);

  const pickInto = useRef(undefined);
  const drags = useRef(0);
  const reads = useRef(0);

  const busy = progress !== null;

  const load = useCallback(async () => {
    const seq = ++reads.current;
    const [list, candidates] = await Promise.allSettled([listDatabases(), listMergeCandidates()]);
    if (seq !== reads.current) return;
    if (list.status === "fulfilled") {
      setDatabases(list.value ?? []);
      setFault(null);
    } else {
      setFault(`The databases could not be read: ${list.reason?.message ?? list.reason}`);
    }
    setPairs(candidates.status === "fulfilled" ? candidates.value : []);
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);
  useDatabasesChanged(load);

  const outstanding = databases.some(settling);
  useEffect(() => {
    if (!outstanding || busy) return;
    const timer = setInterval(() => databasesChanged(), SETTLE_POLL_MS);
    return () => clearInterval(timer);
  }, [outstanding, busy]);

  const selected = databases.find((d) => d.id === view.databaseId) ?? databases[0] ?? null;
  const select = (id) => patch({ databaseId: id });

  useEffect(() => {
    if (destination && !databases.some((d) => d.id === destination)) setDestination(null);
  }, [databases, destination]);

  const stamp = selected ? `${selected.id}|${selected.fileCount}|${selected.analyzed}|${selected.nodeCount}` : "";
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let live = true;
    setDetailError(null);
    setDetail((was) => (was?.id === selected.id ? was : null));
    fetchDatabase(selected.id)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setDetailError(`The file ledger could not be read: ${e.message}`); });
    return () => { live = false; };
  }, [stamp]);

  const upload = async (files, into) => {
    if (!files?.length || busy) return;
    setResult(null);
    const target = into ?? newDatabaseId();
    try {
      const r = await ingestBatch(files, {
        into: target, onProgress: (step) => setProgress({ ...step, db: target }),
      });
      if (r) {
        const name = databases.find((d) => d.id === target)?.name;
        setResult({ ...r, note: name && into ? `${name}: ${r.note}` : r.note });

        if (r.files > 0) select(target);
      }
    } catch (e) {
      setResult({ note: `Upload failed: ${e.message}`, fault: true });
    }
    setProgress(null);
    load();
  };

  const choose = (into) => {
    pickInto.current = into;
    input.current?.click();
  };

  const analyse = async (db) => {
    setResult(null);
    setProgress({ phase: "analyse", name: db.name, db: db.id });
    try {
      const a = await analyzeDatabase(db.id);
      setResult({ note: `${db.name} analysed: ${count(a.tierZeroCount)} Tier Zero objects`, db: db.id });
      databasesChanged();
    } catch (e) {
      setResult({ note: `Analysis of ${db.name} failed: ${e.message}`, fault: true });
    }
    setProgress(null);
    load();
  };

  const merge = async (pair) => {
    setResult(null);
    const name = `${pair.aName} + ${pair.bName}`;
    setProgress({ phase: "merge", name });
    try {
      const merged = await mergeDatabases([pair.a, pair.b], name);
      setResult({ note: `Merged into ${merged.name} (${count(merged.nodeCount)} objects)`, db: merged.id });
      select(merged.id);
    } catch (e) {
      setResult({ note: `Merge failed: ${e.message}`, fault: true });
    }
    setProgress(null);
    load();
  };

  const remove = async () => {
    const db = doomed;
    if (!db) return;
    setProgress({ phase: "delete", name: db.name });
    try {
      await deleteDatabase(db.id);
      setResult({ note: `Deleted ${db.name}` });
      if (selected?.id === db.id) patch({ databaseId: null });
    } catch (e) {
      setResult({ note: `Delete failed: ${e.message}`, fault: true });
    }
    setDoomed(null);
    setProgress(null);
    load();
  };

  const carriesFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const drag = {
    onDragEnter: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); drags.current += 1; setDragging(true); },
    onDragOver: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = busy ? "none" : "copy"; },
    onDragLeave: () => { drags.current = Math.max(0, drags.current - 1); if (drags.current === 0) setDragging(false); },
    onDrop: (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      drags.current = 0;
      setDragging(false);
      if (!busy) upload(e.dataTransfer.files, destination);
    },
  };

  const target = databases.find((d) => d.id === destination);
  const dropInto = target ? target.name : "a new database";
  const deletedSources = doomed ? databases.filter((d) => d.sources.includes(doomed.id)) : [];
  const offers = new Map();
  for (const p of pairs) {
    offers.set(p.a, [...(offers.get(p.a) ?? []), p.bName]);
    offers.set(p.b, [...(offers.get(p.b) ?? []), p.aName]);
  }
  const empty = loaded && databases.length === 0;

  return html`<div className="panel lae-page ingestor" ...${drag}>
    <input ref=${input} type="file" multiple accept=${ACCEPT} hidden
      onChange=${(e) => { const into = pickInto.current; pickInto.current = undefined;
        upload(Array.from(e.target.files), into === undefined ? destination : into); e.target.value = ""; }} />

    <div className=${"ing-drop" + (dragging && !busy ? " is-over" : "") + (empty ? " is-empty" : "")}>
      <div className="ing-drop-text">
        <span className="ing-drop-title">${dragging && !busy
          ? `Drop to upload into ${dropInto}` : empty ? "No databases yet. Drop SharpHound output here" : "Drop SharpHound output here"}</span>
        <${StatusLine} progress=${progress} result=${result} onDismiss=${() => setResult(null)} />
      </div>
      <div className="ing-drop-controls">
        <span className="label">Into</span>
        <${Destination} databases=${databases} value=${destination} disabled=${busy} onChange=${setDestination} />
        <${Button} intent="primary" text="Choose files" disabled=${busy} onClick=${() => choose(undefined)} />
      </div>
    </div>

    ${fault && html`<div className="ing-fault" role="alert">${fault}</div>`}

    ${ready && loaded && !empty && html`<div className="ing-cols">
      <div className="ing-main">
        <${PageSection} title="Databases" count=${databases.length} className="ing-databases"
          note=${pairs.length > 0 ? plural(pairs.length, "merge") + " suggested" : `${count(databases.reduce((t, d) => t + d.nodeCount, 0))} objects`}>
          <${DatabaseTable} databases=${databases} selected=${selected?.id} busyId=${progress?.db}
            offers=${offers} onSelect=${select} />
        <//>
        ${selected && html`<${PageSection} title="Domains, trusts and merges" className="ing-map"
          note="Lines are trusts, arrows show which way authentication flows">
          <${DomainMap} key=${selected.id} db=${selected} census=${detail?.id === selected.id ? detail.census : null}
            databases=${databases} pairs=${pairs} busy=${busy} onMerge=${merge} onSelect=${select} />
        <//>`}
      </div>
      ${selected && html`<${Inspector} key=${selected.id} db=${selected}
        detail=${detail?.id === selected.id ? detail : null} detailError=${detailError}
        databases=${databases} busy=${busy} analysing=${progress?.db === selected.id}
        onAnalyse=${() => analyse(selected)} onUpload=${() => choose(selected.id)}
        onDelete=${() => setDoomed(selected)} />`}
    </div>`}

    <${ConfirmDialog} isOpen=${Boolean(doomed)} title="Delete database" subject=${doomed?.name}
      busy=${progress?.phase === "delete"}
      detail=${doomed && `Deletes ${count(doomed.nodeCount)} objects, ${count(doomed.edgeCount)} relationships, `
        + "the file ledger and every note, owned mark and assertion made in this database. "
        + (deletedSources.length > 0
          ? `${deletedSources.map((d) => d.name).join(", ")} keeps its own copy of the merged data. ` : "")
        + "This cannot be undone."}
      onConfirm=${remove} onClose=${() => { if (progress?.phase !== "delete") setDoomed(null); }} />
  </div>`;
}

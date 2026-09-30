import {
  html, useEffect, useRef, useState, useDismiss, Button, InputGroup, Popover, dropdown, Menu, MenuItem,
  MenuDivider, Tag, Spinner, Dismiss, Keys, Dialog, DialogBody, DialogFooter, FormGroup, TextArea,
  Fragment, Mark,
} from "../../ui/index.js";
import * as api from "../../core/index.js";
import { splitTerms, dropTerm, bracketed, atTermStart, sections } from "./graphModel.js";

const VERBS = new Set(["find", "path", "reach"]);
const KEYWORDS = new Set([
  "to", "where", "with", "not", "and", "or", "named", "in", "older", "than", "tier", "zero",
  "owned", "via", "within", "show",
]);
const SHOWS = new Set(["paths", "objects", "count"]);

const OPERATORS = new Set(["plus", "minus", "shared"]);

const KINDS = Object.fromEntries([
  ["user", "user"], ["group", "group"], ["computer", "computer"], ["domain", "domain"], ["gpo", "gpo"],
  ["ou", "ou"], ["container", "container"], ["certtemplate", "certtemplate"],
  ["enterpriseca", "enterpriseca"], ["rootca", "rootca"], ["aiaca", "aiaca"],
  ["ntauthstore", "ntauthstore"], ["base", "base"], ["object", null],
].flatMap(([word, kind]) => [[word, kind], [`${word}s`, kind]]));

const TOKEN = /("[^"]*"?)|(\s+)|(!=|>=|<=|=|>|<)|([(),])|([^\s"(),=!<>]+)/g;

const kindOf = (word) => KINDS[String(word ?? "").toLowerCase()];

function ink(text) {
  const out = [];
  let previous = null;
  let inVia = false;
  let afterSelector = false;
  let kindValue = false;
  let beforeWith = null;
  for (const m of text.matchAll(TOKEN)) {
    const [whole, quoted, space, op, punct, word] = m;
    const token = { text: whole, from: m.index, to: m.index + whole.length };
    if (space) token.role = "space";
    else if (quoted) token.role = "value";
    else if (op || punct) {
      token.role = "op";
      if (punct !== ",") inVia = false;
      if (punct === ")") kindValue = false;
      if (punct === "(" || punct === ")") { beforeWith = previous; previous = punct; }
    }
    else {
      const lower = word.toLowerCase();
      const opened = previous === null || previous === "(" || OPERATORS.has(previous)
        || (previous === "with" && beforeWith === "shared");
      if (VERBS.has(lower) && opened) { token.role = "verb"; afterSelector = true; inVia = false; }
      else if (OPERATORS.has(lower)) { token.role = "keyword"; inVia = false; kindValue = false; }
      else if (afterSelector && lower in KINDS) { token.role = "kind"; token.kind = KINDS[lower]; afterSelector = false; }
      else if (previous === "show" && SHOWS.has(lower)) token.role = "keyword";
      else if (KEYWORDS.has(lower)) {
        token.role = "keyword";
        inVia = lower === "via";
        afterSelector = lower === "to";
      } else if (inVia) token.role = "edge";
      else if (kindValue && lower in KINDS) { token.role = "kind"; token.kind = KINDS[lower]; }
      else if (previous === "where" || previous === "not"
        || (previous === "with" && beforeWith !== "shared")) token.role = "field";
      else token.role = "value";
      if (token.role === "field") kindValue = lower === "kind";
      else if (token.role === "keyword" && lower !== "in") kindValue = false;
      beforeWith = previous;
      previous = lower;
    }
    out.push(token);
  }
  return out;
}

function roleOf(word, before = "") {
  const lower = String(word).toLowerCase();
  const previous = before.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  if (VERBS.has(lower)) return "sentence";
  if (previous === "where" || previous === "with" || (previous === "not" && !KEYWORDS.has(lower))) return "field";
  if (previous === "via" || previous.endsWith(",")) return KEYWORDS.has(lower) ? "keyword" : "relationship";
  if (lower in KINDS) return "kind";
  if (KEYWORDS.has(lower) || SHOWS.has(lower)) return "keyword";
  return "";
}

function columnIn(text, source, column) {
  const at = [];
  let collapsed = "";
  let pendingSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) { pendingSpace = collapsed.length > 0; continue; }
    if (pendingSpace) { collapsed += " "; at.push(i - 1); pendingSpace = false; }
    collapsed += text[i];
    at.push(i);
  }
  if (collapsed !== source) return -1;
  return column >= 1 && column <= at.length ? at[column - 1] : at.length > 0 ? at[at.length - 1] + 1 : 0;
}

function useLookup(term, fetch, deps) {
  const [got, setGot] = useState({ answer: null, term: "" });
  useEffect(() => {
    if (term == null) { setGot({ answer: null, term: "" }); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      fetch(term)
        .then((answer) => { if (live) setGot({ answer, term }); })
        .catch(() => { if (live) setGot({ answer: null, term: "" }); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [term, ...deps]);
  return got;
}

function PathSearch({ label, dbId, exclude, onPick, open: given, onOpen }) {
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = (next) => (onOpen ? onOpen(next) : setOwn(next));
  const [text, setText] = useState("");
  const [lit, setLit] = useState(0);
  const anchor = useRef(null);

  const drop = (rows) => (rows ?? []).filter((n) => n.id !== exclude);

  const found = useLookup(open && text.trim().length >= 2 ? text.trim() : null,
    (term) => api.searchNodes(term, dbId).then((data) => [
      ...(data.kind ? [{ header: data.kind }] : []),
      ...drop(data.ofKind),
      ...(drop(data.byName).length > 0 ? [{ header: "By name" }] : []),
      ...drop(data.byName),
    ]), [dbId, exclude]);
  const rows = found.answer ?? [];
  const hits = rows.filter((row) => !row.header);
  useEffect(() => setLit(0), [found.answer]);

  const close = () => { setOpen(false); setText(""); };
  const choose = (hit) => { close(); onPick(hit); };

  useDismiss(anchor, open, close, { portal: ".bp5-popover", resize: true });

  if (!open) return html`<${Button} text=${label} onClick=${() => setOpen(true)} />`;

  const current = hits[lit];
  return html`<span ref=${anchor}>
    <${Popover} ...${dropdown} isOpen=${hits.length > 0}
      autoFocus=${false} enforceFocus=${false}
      content=${html`<${Menu}>
        ${rows.map((row, i) => (row.header !== undefined
          ? html`<${MenuDivider} key=${`h${i}`} title=${row.header} />`
          : html`<${MenuItem} key=${row.id} className="lae-data" text=${row.label} label=${row.kind}
              active=${row === current} onClick=${() => choose(row)} />`))}
      <//>`}>
      <${InputGroup} autoFocus placeholder=${label} value=${text}
        className="graph-search"
        onChange=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Escape") close();
          if (e.key === "ArrowDown" && hits.length) { e.preventDefault(); setLit((lit + 1) % hits.length); }
          if (e.key === "ArrowUp" && hits.length) { e.preventDefault(); setLit((lit + hits.length - 1) % hits.length); }
          if (e.key === "Enter" && current && found.term === text.trim()) choose(current);
        }}
        rightElement=${html`<${Dismiss} label="Close search" onClick=${close} />`} />
    <//>
  </span>`;
}

export function PathBar({
  database, pinned, target, selected, scripting, searchOpen, onSearchOpen,
  onPinSelected, onPin, onTarget, onRun, onShow, onScript,
}) {
  if (!database) return null;

  const search = html`
    <${PathSearch} label="Search" dbId=${database.id} onPick=${onShow}
      open=${searchOpen} onOpen=${onSearchOpen} />
    <${Button} text="Script" active=${scripting} onClick=${onScript} />`;

  if (!pinned) {
    return html`<div className="path-bar">
      ${search}
      ${selected && html`<${Button} text=${`Path from ${selected.label}`} onClick=${onPinSelected} />`}
    </div>`;
  }

  return html`<div className="path-bar">
    ${search}
    <${Tag} large interactive className="path-chip" title="Clear path start"
      onClick=${() => onPin(null)} onRemove=${(e) => { e.stopPropagation(); onPin(null); }}>from ${pinned.label}<//>
    ${target
      ? html`<${Tag} large interactive className="path-chip" title="Clear path target"
          onClick=${() => onTarget(null)} onRemove=${(e) => { e.stopPropagation(); onTarget(null); }}>to ${target.label}<//>`
      : html`<${PathSearch} label="Find a target" dbId=${database.id} exclude=${pinned.id}
          onPick=${(hit) => onRun(hit.id, hit.label)} />`}
  </div>`;
}

const oneLine = (text) => (text ?? "").replace(/\s+/g, " ").trim();

const lineCol = (text, index) => {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, col: index - before.lastIndexOf("\n") };
};

const PLATE_MIN = { w: 380, h: 200 };
const GRIPS = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function reframe(mode, start, dx, dy, box, inset) {
  if (mode === "move") {
    return {
      ...start,
      x: clamp(start.x + dx, inset, box.w - inset - start.w),
      y: clamp(start.y + dy, inset, box.h - inset - start.h),
    };
  }
  let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
  if (mode.includes("w")) left = clamp(left + dx, inset, right - PLATE_MIN.w);
  if (mode.includes("e")) right = clamp(right + dx, left + PLATE_MIN.w, box.w - inset);
  if (mode.includes("n")) top = clamp(top + dy, inset, bottom - PLATE_MIN.h);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + PLATE_MIN.h, box.h - inset);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const BUILT_IN = [
  { id: "owned", title: "Marked owned", script: "find objects where owned = true" },
  { id: "tierzero", title: "Tier Zero", script: "find objects where tierzero = true" },
  { id: "controlplane", title: "The control plane", script: "find objects where zonetier = 0" },
];

const Inked = ({ tokens, mark = -1 }) => tokens.map((t, k) => html`<span key=${k}
  className=${(mark >= 0 && t.role !== "space" && t.from <= mark && mark < Math.max(t.to, t.from + 1))
    ? "ink-refused" : undefined}
  style=${t.kind ? { color: `var(--k-${t.kind})` } : undefined}>${t.text}</span>`);

export function ScriptEditor({
  shown, dbId, text, error, busy, onText, onRun, editing = null, onSave, onStopEditing, onClose,
  keepsView, taken, frame: kept = null, onFrame, catalog, saved,
}) {
  const box = useRef(null);
  const plate = useRef(null);

  const [asking, setAsking] = useState(false);

  const [frame, setFrame] = useState(kept);
  const drag = useRef(null);
  const moving = useRef(null);
  const keptKey = kept ? `${kept.x},${kept.y},${kept.w},${kept.h}` : "";
  useEffect(() => { if (!drag.current) setFrame(kept); }, [keptKey]);

  const [caret, setCaret] = useState(null);
  const [active, setActive] = useState(0);
  const prefix = caret == null ? null : text.slice(0, caret);
  const hints = useLookup(prefix, (p) => api.complete(p, dbId), [dbId]);
  const words = hints.term === prefix ? (hints.answer?.options ?? []) : [];
  const typed = hints.term === prefix ? (hints.answer?.partial ?? "") : "";

  const named = prefix !== null && atTermStart(prefix.slice(0, prefix.length - typed.length))
    ? [
      ["Built-in", BUILT_IN],
      ...sections(catalog ?? []),
      ...(saved?.length ? [["Almanac", saved.map((f) => ({
        id: f.id, title: f.title, script: f.body?.source ?? f.body?.script ?? "",
      }))]] : []),
    ].flatMap(([section, rows]) => (rows ?? [])
      .filter((row) => (row.script ?? "").trim() && row.title.toLowerCase().includes(typed))
      .map((row) => ({ key: `${section}:${row.id}`, label: row.title, role: section, insert: bracketed(row.script) })))
    : [];

  const asWords = words.map((word) => ({ key: `w:${word}`, label: word, word, insert: word }));
  const options = typed ? [...asWords, ...named] : [...named, ...asWords];
  useEffect(() => {
    if (!frame || !shown) return undefined;
    const refit = () => {
      const host = plate.current?.offsetParent;
      if (!host) return;
      const inset = parseFloat(getComputedStyle(host).getPropertyValue("--graph-inset")) || 0;
      const room = { w: host.clientWidth, h: host.clientHeight };
      setFrame((f) => {
        if (!f) return f;
        const sized = { ...f, w: Math.min(f.w, room.w - 2 * inset), h: Math.min(f.h, room.h - 2 * inset) };
        const next = reframe("move", sized, 0, 0, room, inset);
        return next.x === f.x && next.y === f.y && next.w === f.w && next.h === f.h ? f : next;
      });
    };
    const first = requestAnimationFrame(refit);
    window.addEventListener("resize", refit);
    return () => { cancelAnimationFrame(first); window.removeEventListener("resize", refit); };
  }, [frame !== null, shown]);
  if (!shown) return null;

  const at = /^col (\d+): ([\s\S]*)$/.exec(error?.line ?? "");
  const message = at ? at[2] : error?.line;

  const errorAt = at && error?.source ? columnIn(text, error.source, Number(at[1])) : -1;
  const refused = Boolean(error) && !busy && errorAt >= 0;
  const where = refused ? lineCol(text, errorAt) : null;

  const modified = Boolean(editing) && oneLine(text) !== (editing.body?.script ?? "");
  const empty = text.trim().length === 0;

  const lines = [[]];
  for (const t of ink(text)) {
    t.text.split("\n").forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...t, text: part });
    });
  }

  const terms = splitTerms(text);
  const startsTerm = new Map(terms.length > 1
    ? terms.map((term, i) => [text.slice(0, term.from).split("\n").length - 1, i]) : []);

  let hintsTop;
  if (options.length > 0 && plate.current) {
    const row = text.slice(0, caret ?? 0).split("\n").length - 1;
    const line = plate.current.querySelectorAll(".ink-line")[row];
    const editor = plate.current.querySelector(".script-console-editor");
    if (line && editor) hintsTop = line.offsetTop + line.offsetHeight - editor.scrollTop + 4;
  }
  const run = () => { if (!busy && !empty) { setCaret(null); onRun(text); } };
  const moved = (el) => { setCaret(el.selectionStart); setActive(0); };

  const accept = (option) => {
    const el = box.current;
    const before = text.slice(0, el.selectionStart - typed.length);
    const next = before + option.insert + " " + text.slice(el.selectionStart);
    const pos = before.length + option.insert.length + 1;
    onText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); moved(el); });
  };

  const drop = (i) => {
    onText(dropTerm(text, i));
    requestAnimationFrame(() => box.current?.focus());
  };
  const save = ({ title, description, asNew }) => Promise.resolve(onSave?.({
    id: asNew ? null : editing?.id ?? null, title, description, script: text,
  })).then(() => onStopEditing?.());

  const begin = (mode) => (e) => {
    if (e.button !== 0 || (mode === "move" && e.target.closest("button"))) return;
    const el = plate.current;
    const host = el?.offsetParent;
    if (!el || !host) return;
    e.preventDefault();
    const inset = parseFloat(getComputedStyle(host).getPropertyValue("--graph-inset")) || 0;
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1;
    drag.current = {
      mode, x0: e.clientX, y0: e.clientY, zoom, inset,
      start: frame ?? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight },
      room: { w: host.clientWidth, h: host.clientHeight },
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const follow = (e) => {
    const d = drag.current;
    if (!d) return;
    moving.current = reframe(d.mode, d.start, (e.clientX - d.x0) / d.zoom, (e.clientY - d.y0) / d.zoom, d.room, d.inset);
    setFrame(moving.current);
  };
  const end = () => {
    drag.current = null;
    if (moving.current) onFrame?.(moving.current);
    moving.current = null;
  };
  const dragging = { onPointerMove: follow, onPointerUp: end, onPointerCancel: end };

  return html`<section ref=${plate} aria-label="Script"
    className=${"script-console" + (frame ? " is-framed" : "")}
    style=${frame ? { left: frame.x, top: frame.y, width: frame.w, height: frame.h } : undefined}>
    <header className="script-console-head" title="Drag to move; double-click to put it back"
      onPointerDown=${begin("move")} ...${dragging} onDoubleClick=${(e) => { if (!e.target.closest("button")) { setFrame(null); onFrame?.(null); } }}>
      <span className="script-console-title">${editing
        ? html`Editing <span className="script-console-name">${editing.title}</span>${modified
          && html`<span className="script-console-state">Modified</span>`}`
        : "Script"}</span>
      ${editing && html`<${Dismiss} label="Stop editing" onClick=${() => onStopEditing?.()} />`}
      <span className="script-console-tools">
        <${Dismiss} label="Close" onClick=${() => onClose?.()} />
      </span>
    </header>

    <div className="script-console-body">
    <div className="script-field">
    ${ ""}
    <div className=${"script-console-editor" + (refused ? " is-refused" : "")}>
      ${ ""}
      <div className="script-ink">${lines.map((line, n) => html`<div key=${n}
        className=${"ink-line" + (startsTerm.has(n) ? " is-term" : "")}>
        ${startsTerm.has(n) && html`<button type="button" className="ink-drop" tabIndex=${-1}
          title="Drop this set" aria-label="Drop this set"
          onMouseDown=${(e) => e.preventDefault()} onClick=${() => drop(startsTerm.get(n))}><${Mark} name="cross" /><//>`}
        <span className=${"ink-no" + (where?.line === n + 1 ? " is-refused" : "")}>${n + 1}</span>
        <span className="ink-text"><${Inked} tokens=${line} mark=${errorAt} />${
          n === lines.length - 1 && errorAt >= 0 && errorAt >= text.length ? html`<span className="ink-refused ink-end">${" "}</span>` : ""}${"​"}</span>
      </div>`)}</div>
      <textarea ref=${box} className="script-input" rows="1" spellCheck=${false} autoComplete="off"
        placeholder="find users where admincount = true"
        value=${text}
        onChange=${(e) => { onText(e.target.value); moved(e.target); }}
        onFocus=${(e) => moved(e.target)}
        onClick=${(e) => moved(e.target)}
        onKeyUp=${(e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") moved(e.target); }}
        onBlur=${() => {

          setTimeout(() => setCaret(null), 180);
        }}
        onKeyDown=${(e) => {

          if (e.key === "Escape") { setCaret(null); return; }

          const n = options.length;
          if (n === 0) return;
          if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); accept(options[active]); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % n); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((active + n - 1) % n); }
        }} />
    </div>

    ${options.length > 0 && html`<ul className="script-hints" role="listbox"
      style=${hintsTop === undefined ? undefined : { top: hintsTop }}>
      ${options.map((option, i) => {

        const role = option.word
          ? roleOf(option.word, (prefix ?? "").slice(0, (prefix ?? "").length - typed.length))
          : option.role;

        const kind = option.word && role === "kind" ? kindOf(option.word) : null;
        const heads = !option.word && (i === 0 || options[i - 1]?.role !== option.role);
        return html`<${Fragment} key=${option.key}>
          ${heads && html`<li className="script-hint-section" role="presentation">${option.role}</li>`}
          <li role="option" aria-selected=${i === active}
            className=${"script-hint" + (i === active ? " is-active" : "") + (option.word ? "" : " is-named")}
            onMouseDown=${(e) => e.preventDefault()} onClick=${() => accept(option)}>
            <span className="script-hint-word" style=${kind ? { color: `var(--k-${kind})` } : undefined}>${option.word
              ? html`<span className=${kind ? undefined : "script-hint-typed"}>${option.label.slice(0, typed.length)}</span>${option.label.slice(typed.length)}`
              : option.label}</span>
            ${option.word && role && html`<span className="script-hint-role">${role}</span>`}
          </li>
        <//>`;
      })}
    </ul>`}
    </div>

    ${ ""}
    ${error && !busy && (refused || !at) && html`<div className="script-refusal" role="alert">
      ${where && html`<span className="script-refusal-at">Ln ${where.line}, Col ${where.col}</span>`}
      <span className="script-refusal-text">${message}</span>
    </div>`}
    </div>

    <footer className="script-console-foot">
      <span className="script-console-keys">
        <span className="script-console-key"><${Keys} keys="tab" /> Autocomplete</span>
      </span>
      <span className="script-buttons">
        ${ ""}
        <${Button} text="Save"
          title=${editing ? `Save “${editing.title}” in the Almanac` : "Save to the Almanac"}
          disabled=${empty} onClick=${() => setAsking(true)} />
        <${Button} intent="primary" icon="play" text="Run" loading=${busy} disabled=${empty} onClick=${run} />
      </span>
    </footer>
    ${GRIPS.map((edge) => html`<div key=${edge} className=${`script-console-grip script-console-grip--${edge}`}
      aria-hidden="true" onPointerDown=${begin(edge)} ...${dragging} />`)}
    <${SaveDialog} isOpen=${asking} editing=${editing} sentence=${text}
      keepsView=${asking ? Boolean(keepsView?.(text, editing?.id ?? null)) : false}
      taken=${taken} onSave=${save} onClose=${() => setAsking(false)} />
  </section>`;
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

const Counted = ({ label, info, count, max }) => html`<span className="almanac-label">
  <span>${label}${info && html`<span className="bp5-text-muted">${info}</span>`}</span>
  <span className=${"almanac-count mono" + (count >= max * 0.9 ? " is-near" : "")}>${count} / ${max}</span>
</span>`;

export function SaveDialog({ isOpen, editing, sentence = "", keepsView = false, taken, onSave, onClose }) {

  const wasOpen = useRef(false);
  const shown = useRef({ entry: null, sentence: "", keepsView: false });
  if (isOpen && !wasOpen.current) shown.current = { entry: editing, sentence, keepsView };
  wasOpen.current = isOpen;
  const entry = shown.current.entry;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState(null);
  useEffect(() => {
    if (!isOpen) return;
    setTitle(entry?.title ?? "");
    setDescription(entry?.description ?? "");
    setFault(null);
  }, [isOpen]);
  const name = title.trim();

  const clash = Boolean(name) && Boolean(taken?.(name, entry?.id ?? null));
  const copyClash = Boolean(name) && Boolean(taken?.(name, null));
  const commit = (asNew = false) => {
    if (!name || busy || (asNew ? copyClash : clash)) return;
    setBusy(true);
    setFault(null);
    Promise.resolve(onSave({ title: name, description: description.trim(), asNew }))
      .then(onClose)
      .catch((e) => setFault(e.message))
      .finally(() => setBusy(false));
  };

  return html`<${Dialog} isOpen=${isOpen} onClose=${onClose} className="lae-dialog almanac-dialog"
    title="Save to Almanac" icon="floppy-disk" style=${{ width: 520 }}>
    <${DialogBody}>
      <${FormGroup} labelFor="almanac-name" intent=${clash ? "danger" : "none"}
        label=${html`<${Counted} label="Name" count=${title.length} max=${NAME_MAX} />`}
        helperText=${clash ? "Another entry in this Almanac has this name." : undefined}>
        <${InputGroup} id="almanac-name" autoFocus value=${title} maxLength=${NAME_MAX}
          placeholder="Enter a name" intent=${clash ? "danger" : "none"}
          onChange=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") commit(); }} />
      <//>
      <${FormGroup} labelFor="almanac-description"
        label=${html`<${Counted} label="Description" info="optional" count=${description.length} max=${DESCRIPTION_MAX} />`}>
        <${TextArea} id="almanac-description" fill autoResize rows="3" value=${description} maxLength=${DESCRIPTION_MAX}
          placeholder="Enter a description"
          onChange=${(e) => setDescription(e.target.value)} />
      <//>
      ${ ""}
      <div className="almanac-kept">
        <span className="label">Script</span>
        <div className="almanac-kept-sentence mono"><${Inked} tokens=${ink(shown.current.sentence.trim())} /></div>
        <div className=${"almanac-kept-note" + (shown.current.keepsView ? "" : " is-bare")}>${shown.current.keepsView
          ? "Kept with the canvas as it stands: its layout, where objects were moved, and what was opened and hidden."
          : "Kept as the sentence alone. Run it to keep the canvas with it."}</div>
      </div>
      ${fault && html`<div className="lae-dialog-fault" role="alert">${fault}</div>`}
    <//>
    <${DialogFooter} actions=${html`<${Button} text="Cancel" onClick=${onClose} />
      ${entry && html`<${Button} text="Save as new"
        title=${copyClash ? "A copy needs a name of its own" : "Keep this as a new entry; the original stays as it was"}
        disabled=${!name || copyClash || busy} onClick=${() => commit(true)} />`}
      <${Button} intent="primary" text="Save" loading=${busy} disabled=${!name || clash} onClick=${() => commit()} />`} />
  <//>`;
}

const LOADING_AFTER_MS = 1000;

export function Loading({ shown }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!shown) { setLate(false); return undefined; }
    const timer = setTimeout(() => setLate(true), LOADING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const on = shown && late;
  return html`<div className=${"graph-loading" + (on ? " graph-loading--shown" : "")} aria-hidden=${!on}>
    <${Spinner} size=${28} />
    <span className="graph-loading-text mono">LOADING</span>
  </div>`;
}

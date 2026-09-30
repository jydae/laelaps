import { html, createElement, forwardRef, useEffect, useRef, useState, Component, clamp } from "../core/index.js";
export {
  html, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback,
  createElement, Fragment, createRoot, createPortal,
} from "../core/index.js";

export const { animate } = window.Motion;
const { motionValue } = window.Motion;

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const DUR = (seconds) => (REDUCED ? 0 : seconds);
export const FADE = (seconds) => (REDUCED ? Math.min(seconds, 0.1) : seconds);

export const reveal = (el) => {
  if (!el) return;
  animate(el, { opacity: [0, 1] }, { duration: DUR(0.12), ease: "easeOut" });
};

const PATHS = {

  cross: { box: 16, d: "M9.41 8l2.29-2.29c.19-.18.3-.43.3-.71a1.003 1.003 0 00-1.71-.71L8 6.59l-2.29-2.3a1.003 1.003 0 00-1.42 1.42L6.59 8 4.3 10.29c-.19.18-.3.43-.3.71a1.003 1.003 0 001.71.71L8 9.41l2.29 2.29c.18.19.43.3.71.3a1.003 1.003 0 00.71-1.71L9.41 8z", size: 16, fill: true },
  chevron: { box: 12, d: "M4 2l4 4-4 4", size: 12, stroke: 1.5 },

  tick: { box: 16, d: "M12 5c-.28 0-.53.11-.71.29L7 9.59l-2.29-2.3a1.003 1.003 0 00-1.42 1.42l3 3c.18.18.43.29.71.29s.53-.11.71-.29l5-5A1.003 1.003 0 0012 5z", size: 16, fill: true },
  arrow: { box: 12, d: "M1.5 6h9M7 2.5L10.5 6 7 9.5", size: 12, stroke: 1.4 },
};
const TURN = { right: 0, down: 90, left: 180, up: 270 };

export const Mark = forwardRef(({ name, className = "", style, title }, ref) => {
  const [shape, direction] = name.split("-");
  const path = PATHS[shape] ?? PATHS.chevron;
  const turn = shape === "chevron" || shape === "arrow" ? TURN[direction ?? "right"] : 0;
  return html`<span ref=${ref} aria-hidden=${title ? undefined : "true"} title=${title}
    className=${`bp5-icon lae-mark ${className}`.trim()} style=${{ color: "inherit", ...style }}>
    <svg width=${path.size} height=${path.size} viewBox=${`0 0 ${path.box} ${path.box}`}
      style=${turn ? { transform: `rotate(${turn}deg)` } : undefined}>
      ${path.fill
        ? html`<path d=${path.d} fill="currentColor" />`
        : html`<path d=${path.d} fill="none" stroke="currentColor" strokeWidth=${path.stroke}
          strokeLinecap="round" strokeLinejoin="round" />`}
    </svg>
  </span>`;
});

const BLUEPRINT_MARKS = {
  SmallCross: "cross",
  Cross: "cross",
  ChevronRight: "chevron-right",
  CaretRight: "chevron-right",
  ChevronDown: "chevron-down",
  CaretDown: "chevron-down",
  ChevronUp: "chevron-up",
  Tick: "tick",
  SmallTick: "tick",
};

export const mark = (name) => html`<${Mark} name=${name} />`;

const Core = window.Blueprint.Core;
const IconsModule = window.Blueprint.Icons;

for (const [component, name] of Object.entries(BLUEPRINT_MARKS)) {
  IconsModule[component] = forwardRef(({ className, title }, ref) =>
    createElement(Mark, { name, className, title, ref }));
}
const OTHER_ICONS = {
  InfoSign: "info-sign", WarningSign: "warning-sign", Error: "error", DoubleCaretVertical: "double-caret-vertical",
};
for (const [component, icon] of Object.entries(OTHER_ICONS)) {
  IconsModule[component] ??= forwardRef((props, ref) => createElement(Core.Icon, { icon, ...props, ref }));
}
IconsModule.Icons.setLoaderOptions({ loader: async (name, size) => IconsModule.getIconPaths(name, size) });

export const iconsReady = IconsModule.Icons.loadAll();

export const {
  Button, ButtonGroup, Tabs, Tab, Menu, MenuItem, MenuDivider, Popover, ContextMenuPopover,
  Dialog, DialogBody, DialogFooter, InputGroup, TextArea, FormGroup, Switch, EditableText,
  Card, Section, SectionCard, Tag, NonIdealState, Collapse, Spinner, ProgressBar, Icon,
} = Core;
const { HTMLTable, FocusStyleManager } = Core;

export const dropdown = {
  minimal: true,
  placement: "bottom-start",
  modifiers: { offset: { enabled: true, options: { offset: [0, 2] } } },
};

FocusStyleManager.onlyShowFocusOnTabs();

export const token = (name, fallback = "") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export const zoomOf = () => Number(token("--zoom")) || 1;

export function beginSidePanelResize(event, direction = 1, cssVar = "--panel-w") {
  event.preventDefault();
  const handle = event.currentTarget;
  const panel = handle.closest(".side-panel");
  const frame = handle.closest("[data-panel-frame]");
  if (!panel || !frame) return;

  const fromX = event.clientX;
  const fromWidth = parseFloat(getComputedStyle(panel).width);
  const min = parseFloat(token("--panel-min")) || 0;
  const max = parseFloat(token("--panel-max")) || Infinity;
  let width = fromWidth, animationFrame = 0;
  frame.classList.add("is-panel-resizing");

  const zoom = zoomOf();
  const move = (moveEvent) => {
    width = clamp(fromWidth + direction * (moveEvent.clientX - fromX) / zoom, min, max);
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      frame.style.setProperty(cssVar, `${Math.round(width)}px`);
    });
  };
  const stop = () => {
    cancelAnimationFrame(animationFrame);
    frame.classList.remove("is-panel-resizing");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
}

export function resetSidePanelWidth(event, cssVar = "--panel-w") {
  event.preventDefault();
  event.currentTarget.closest("[data-panel-frame]")?.style.removeProperty(cssVar);
}

export function useTick(tick, ms) {
  useEffect(() => {
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, []);
}

export function useEscape(active, onEscape) {
  useEffect(() => {
    if (!active) return;
    const key = (event) => { if (event.key === "Escape") onEscape(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active]);
}

export function useDismiss(ref, active, onClose, { portal = null, resize = false } = {}) {
  useEffect(() => {
    if (!active) return;
    const away = (event) => {
      if (ref.current?.contains(event.target)) return;
      if (portal && event.target.closest?.(portal)) return;
      onClose();
    };
    const key = (event) => { if (event.key === "Escape") onClose(); };

    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key);
    if (resize) window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key);
      if (resize) window.removeEventListener("resize", onClose);
    };
  }, [active]);
}

export const Caret = ({ open }) => html`<svg
  className=${"caret" + (open ? " caret--open" : "")}
  viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" /></svg>`;
export const Field = ({ label, value, onChange, type = "text", placeholder, autoFocus, onEnter }) => html`
  <label className="field">
    <span className="label">${label}</span>
    <input className=${"field-box" + (type === "password" ? " mono" : "")} type=${type} value=${value}
      placeholder=${placeholder} autoFocus=${autoFocus} spellCheck="false" autoComplete="off"
      onInput=${(e) => onChange(e.target.value)}
      onKeyDown=${(e) => { if (e.key === "Enter" && onEnter) onEnter(); }} />
  </label>`;

export const ToggleRow = ({ name, note, on, onToggle }) => html`
  <button type="button" className="switch" role="switch" aria-checked=${on} onClick=${onToggle}>
    <span className="switch-text"><span className="name">${name}</span>${note && html`<span className="note">${note}</span>`}</span>
    <span className=${"tag-mark" + (on ? "" : " tag-mark--off")}>${on ? "On" : "Off"}</span>
  </button>`;

export const Dismiss = ({ label = "Close", onClick }) => html`<${Button} minimal
  className="lae-dismiss" icon=${mark("cross")} aria-label=${label} title=${label}
  onClick=${onClick} />`;

const KEY_NAMES = {
  mod: /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "Cmd" : "Ctrl",
  esc: "Esc",
};
export const Keys = ({ keys }) => html`<span className="bp5-key-combo">
  ${keys.split("+").map((key) => html`<kbd key=${key} className="bp5-key">${KEY_NAMES[key] ?? key[0].toUpperCase() + key.slice(1)}</kbd>`)}
</span>`;

export const Figure = ({ label, value }) => html`
  <div className="figure">
    <span className="label">${label}</span>
    <span className="mono">${value}</span>
  </div>`;

export const PageSection = ({ icon, title, count: n, note, tools, sub, className = "", bodyClassName = "", children }) => html`
  <section className=${`sec ${className}`.trim()}>
    <div className="sec-head">
      ${icon && html`<${Icon} icon=${icon} size=${14} className="sec-icon" />`}
      <h2 className="label sec-title">${title}</h2>
      ${n !== undefined && n !== null && html`<span className="mono sec-count">${n}</span>`}
      ${note && html`<span className="label sec-note">${note}</span>`}
      ${tools && html`<span className="sec-tools">${tools}</span>`}
    </div>
    ${sub && html`<div className="sec-sub">${sub}</div>`}
    <div className=${`sec-body ${bodyClassName}`.trim()}>${children}</div>
  </section>`;

export const KeyValue = ({ label, value, sub, onPick, flag, title }) => html`
  <${onPick ? "button" : "div"} className=${"row" + (onPick ? " row--pick" : "")} onClick=${onPick}
    type=${onPick ? "button" : undefined} title=${title}>
    ${typeof label === "string" ? html`<span className="row-t">${label}</span>` : label}
    <span className=${"mono row-v" + (flag ? " row-v--flag" : "")}>${value}${
      sub && html`<small className="label row-sub">${sub}</small>`}</span>
  <//>`;

export const StatusTag = ({ tone = "ok", children, title }) => html`
  <span className=${`lae-status lae-status--${tone}`} title=${title}>${children}</span>`;

export function ConfirmDialog({ isOpen, title, icon = "trash", subject, detail, confirm = "Delete", busy = false, onConfirm, onClose }) {
  return html`<${Dialog} isOpen=${isOpen} onClose=${onClose} title=${title} icon=${icon}
    className="lae-dialog lae-dialog--danger lae-confirm">
    <${DialogBody}>
      ${subject && html`<div className="lae-confirm-subject">${subject}</div>`}
      ${detail && html`<p className="lae-confirm-detail">${detail}</p>`}
    <//>
    <${DialogFooter} actions=${html`<${Button} text="Cancel" autoFocus onClick=${onClose} />
      <${Button} intent="danger" text=${confirm} loading=${busy} onClick=${onConfirm} />`} />
  <//>`;
}

export const MenuPop = ({ items, onPick, className = "" }) => {

  const el = useRef(null);
  useEffect(() => { reveal(el.current); }, []);

  return html`<div role="menu" className=${"menu-pop" + (className ? ` ${className}` : "")} ref=${el}>
    ${items.map((item) => {
      const on = item.active;
      return html`<button
        className=${"metric-option label" + (on ? " is-active" : "") + (item.plain ? " is-plain" : "")
          + (item.note === undefined ? "" : " has-note")}
        role=${on === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked=${on === undefined ? undefined : Boolean(on)}
        key=${item.id} onMouseDown=${(e) => e.preventDefault()} onClick=${() => onPick(item.id, item)}>
        ${item.note === undefined ? item.label : html`<span className="menu-text">${item.label}</span><span className="menu-note">${item.note}</span>`}
      </button>`;
    })}
  </div>`;
};

const FRET_SCALE = 60 / 238;
const FRET_EDGE = 6 * FRET_SCALE;
const FRET_CORNERS = {
  bl: { y: "100%", transform: "translate(0 -60)" },
  tl: { transform: "translate(0 60) scale(1 -1)" },
  br: { x: "-100%", y: "100%", transform: "translate(0 -60) scale(-1 1)" },
  tr: { x: "-100%", transform: "translate(0 60) scale(-1 -1)" },
};
export const Ornament = ({ children, className = "" }) => html`
  <div className=${`ornament ${className}`.trim()}>
    <div className="ornament-cells" aria-hidden="true"></div>
    <svg className="ornament-frame" aria-hidden="true">
      <defs>
        <g id="fret" transform=${`scale(${FRET_SCALE})`} fill="none" stroke="currentColor">
          <path d="M6 0V110H67V232H104V195H6V232H43V135H6V172H127V232H238" strokeWidth="4.4" />
          <path d="M28 31V89H86V154H146V211H204" strokeWidth="2.7" />
        </g>
      </defs>
      ${Object.entries(FRET_CORNERS).map(([at, place]) => html`<use key=${at} href="#fret" ...${place} />`)}
      <g stroke="currentColor" strokeWidth=${4.4 * FRET_SCALE}>
        <line x1="118" y1=${FRET_EDGE} x2="100%" y2=${FRET_EDGE} transform="translate(-59 0)" />
        <line x1="118" y1="100%" x2="100%" y2="100%" transform=${`translate(-59 ${-FRET_EDGE})`} />
        <line x1=${FRET_EDGE} y1="118" x2=${FRET_EDGE} y2="100%" transform="translate(0 -59)" />
        <line x1="100%" y1="118" x2="100%" y2="100%" transform=${`translate(${-FRET_EDGE} -59)`} />
      </g>
    </svg>
    <div className="ornament-body">${children}</div>
  </div>`;

export class PanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Panel failed to render:", error, info?.componentStack ?? "");
  }

  render() {
    const { error } = this.state;
    const slot = (children) => html`<div className="panel-slot" hidden=${Boolean(this.props.hidden)}>
      ${children}
    </div>`;
    if (!error) return slot(this.props.children);
    return slot(html`<div className="panel panel--failed">
      <div className="label">This panel stopped</div>
      <div className="mono panel-error">${String(error?.message ?? error)}</div>
      <div className="label">
        Retry mounts the panel again, from its saved view.
      </div>
      <${Button} text="Retry" onClick=${() => this.setState({ error: null })} />
    </div>`);
  }
}

const keptWidths = new Map();

export function Table({ id, columns, interactive = false, keyed = false, flush = false, children }) {
  const defaults = columns.map((c) => c.width ?? 100 / columns.length);
  const [widths, setWidths] = useState(() => keptWidths.get(id) ?? defaults);
  const ref = useRef(null);
  const keep = (next) => { setWidths(next); if (id) keptWidths.set(id, next); };

  const drag = (i) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const table = ref.current?.getBoundingClientRect();
    if (!table) return;
    const startX = event.clientX, start = widths.slice(), MIN = 8;
    const move = (e) => {
      const delta = ((e.clientX - startX) / table.width) * 100;
      const left = Math.min(Math.max(start[i] + delta, MIN), start[i] + start[i + 1] - MIN);
      const next = start.slice();
      next[i] = left;
      next[i + 1] = start[i] + start[i + 1] - left;
      keep(next);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.documentElement.classList.remove("lae-col-dragging");
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.documentElement.classList.add("lae-col-dragging");
  };

  return html`<div className="lae-table-frame" ref=${ref}>
    <${HTMLTable} compact bordered interactive=${interactive}
    className=${"lae-table" + (keyed ? " lae-keyed" : "") + (flush ? " lae-table--flush" : "")}>
    <colgroup>${widths.map((w, i) => html`<col key=${i} style=${{ width: `${w}%` }} />`)}</colgroup>
    <thead><tr>${columns.map((c, i) => html`<th key=${i} className=${c.align === "right" ? "lae-num" : ""}>
      ${c.label}
      ${i < columns.length - 1 && html`<span className="lae-col-grip" title="Drag to resize, double-click to reset"
        onMouseDown=${drag(i)} onDblClick=${() => keep(defaults)}></span>`}
    </th>`)}</tr></thead>
    ${children}
  <//></div>`;
}

export const THEMES = [
  { id: "graphite", name: "Graphite", note: "Graphite panels, neutral borders, red only for pressed and Tier Zero." },
];

const DEFAULT_THEME = THEMES[0].id;

const KEY = "laelaps.theme";
const EVENT = "laelaps:theme";

const known = (id) => (THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME);

export const currentTheme = () => known(document.documentElement.dataset.theme);

export function applyTheme(id) {
  const theme = known(id);
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch {  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const on = (e) => setTheme(e.detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return theme;
}

const MASK_AT = "translate(35.84 43.7) scale(0.86)";
const OUTLINE = "M256 130 L298 138 L384 18 L374 172 L386 262 L332 306 L306 404 L280.5 500 L267.6 452 L244.4 452 L231.5 500 L206 404 L180 306 L126 262 L138 172 L128 18 L214 138 Z";
const LIGHT = "M128 18 L138 172 L176 155 Z M256 130 L214 138 L164 222 L256 262 Z";
const SHADE = "M384 18 L374 172 L336 155 Z M298 138 L374 172 L386 262 L352 246 L348 222 Z M266 283.4 L352 246 L386 262 L332 306 L320 440 L320 520 L256 520 L256 283.4 Z";
const BODY = OUTLINE + " M164 222 L256 262 L348 222 L352 246 L266 283.4 L266 392 L274 392 L256 423 L238 392 L246 392 L246 283.4 L160 246 Z";

const LENS = {
  radius: 320,
  solid: 0.75,
  rest: { x: 256, y: 278 },
  grow: { type: "spring", stiffness: 220, damping: 24 },
  follow: { type: "spring", stiffness: 420, damping: 34 },
  shrink: { duration: 0.3, ease: "easeOut" },
};

let instances = 0;

function Mask({ id, tone }) {
  return html`<g transform=${MASK_AT}>
    <clipPath id=${id}><path d=${BODY} clipRule="evenodd" /></clipPath>
    <path d=${BODY} fillRule="evenodd" style=${{ fill: `var(--logo-${tone})` }} />
    <g clipPath=${`url(#${id})`}>
      <path d=${LIGHT} style=${{ fill: `var(--logo-${tone}-light)` }} />
      <path d=${SHADE} style=${{ fill: `var(--logo-${tone}-shade)` }} />
    </g>
  </g>`;
}

function Lens({ fill }) {
  return html`<circle className="logo-lens" cx=${LENS.rest.x} cy=${LENS.rest.y} r="0" fill=${fill} />`;
}

export function Logo({ size, className }) {
  const svg = useRef(null);
  const key = useRef(null);
  if (!key.current) key.current = `logo-${++instances}`;
  const k = key.current;

  useEffect(() => {
    const el = svg.current;
    const circles = el.querySelectorAll(".logo-lens");
    const r = motionValue(0);
    const x = motionValue(LENS.rest.x);
    const y = motionValue(LENS.rest.y);
    const stop = [[r, "r"], [x, "cx"], [y, "cy"]].map(([value, attr]) =>
      value.on("change", (v) => circles.forEach((c) => c.setAttribute(attr, v))));
    const still = DUR(1) === 0;
    const to = (value, target, how) => (still ? value.jump(target) : animate(value, target, how));
    const at = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(el.getScreenCTM().inverse());
    const enter = (e) => { const p = at(e); x.jump(p.x); y.jump(p.y); to(r, LENS.radius, LENS.grow); };
    const move = (e) => { const p = at(e); to(x, p.x, LENS.follow); to(y, p.y, LENS.follow); };
    const leave = () => to(r, 0, LENS.shrink);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      stop.forEach((off) => off());
      [r, x, y].forEach((value) => value.destroy());
    };
  }, []);

  return html`<svg ref=${svg} className=${className} viewBox="0 0 512 512" width=${size} height=${size}
      aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id=${`${k}-show`}><stop offset=${LENS.solid} stopColor="#fff" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
      <radialGradient id=${`${k}-hide`}><stop offset=${LENS.solid} stopColor="#000" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
      <mask id=${`${k}-lens`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
        <${Lens} fill=${`url(#${k}-show)`} />
      </mask>
      <mask id=${`${k}-rest`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
        <rect width="512" height="512" fill="#fff" /><${Lens} fill=${`url(#${k}-hide)`} />
      </mask>
    </defs>
    <g mask=${`url(#${k}-rest)`}><${Mask} id=${`${k}-marble`} tone="marble" /></g>
    <g mask=${`url(#${k}-lens)`}><${Mask} id=${`${k}-oxblood`} tone="oxblood" /></g>
  </svg>`;
}

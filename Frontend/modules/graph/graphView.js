import { html, token, useEffect, useTheme, animate, DUR, FADE, zoomOf } from "../../ui/index.js";
import { clamp } from "../../core/index.js";
import { SPACE, CENTER, NODE_GAP, MAX_RADIUS, LAYOUTS, DEFAULT_LAYOUT, layoutWith, FOOTPRINT, footprints, shortName, placeArrivals, slideStop } from "./graphLayout.js";

export const OwnedFlag = () => html`<svg className="owned-flag" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M2.99 2.99c-.55 0-1 .45-1 1v11c0 .55.45 1 1 1s1-.45 1-1v-11c0-.55-.45-1-1-1zm0-3c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm2 3.03v7.23c2.07-2.11 5.92 1.75 9 0V3.02c-3 2.07-6.94-2.03-9 0z"
    vector-effect="non-scaling-stroke" />
</svg>`;

const KIND_GLYPHS = {

  Base: {
    viewBox: "0 0 24 24",
    shapes: `<path d="M12 5.2L17.9 8.6V15.4L12 18.8L6.1 15.4V8.6Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>`,
  },

  User: {
    viewBox: "0 0 24 24",
    bleed: true,
    shapes: `<path d="M7.6 14.6H16.4L23 26H1Z" /> <circle cx="12" cy="8.4" r="4.2" />`,
  },

  Group: {
    viewBox: "0 0 24 24",
    bleed: true,
    shapes: `<path d="M2.8 15.8H10.2L11.4 24H0.4Z" /> <circle cx="6.5" cy="11.4" r="3" /> <path d="M14 13.4H21.6L23.6 24H12.8Z" /> <circle cx="17.8" cy="8.8" r="3.4" />`,
  },

  Computer: {
    viewBox: "-1.9 -1.9 27.8 27.8",
    scale: 0.9,
    root: 'fill-rule="evenodd"',
    shapes: `<path d="M2.2 5.6H21.8V11H2.2ZM4.6 7.6V9H6.6V7.6ZM11 7.6V9H19.4V7.6Z" /> <path d="M2.2 12.6H21.8V18H2.2ZM4.6 14.6V16H6.6V14.6ZM11 14.6V16H19.4V14.6Z" />`,
  },

  Domain: {
    viewBox: "0 0 24 24",
    shapes: `<path transform="translate(4.2 4.2) scale(0.78)" fill-rule="evenodd" d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm7.39 7h-3.63c-.31-1.99-.92-3.66-1.72-4.73 2.45.65 4.41 2.42 5.35 4.73zM13 10c0 .69-.04 1.36-.11 2H7.11a18.419 18.419 0 010-4h5.77c.08.64.12 1.31.12 2zm-3-8c1.07 0 2.25 2.05 2.75 5h-5.5c.5-2.95 1.68-5 2.75-5zm-2.04.27C7.16 3.34 6.55 5.01 6.24 7H2.61c.94-2.31 2.9-4.08 5.35-4.73zM2 10c0-.69.11-1.36.28-2h3.83a18.419 18.419 0 000 4H2.28c-.17-.64-.28-1.31-.28-2zm.61 3h3.63c.31 1.99.92 3.66 1.72 4.73A7.996 7.996 0 012.61 13zM10 18c-1.07 0-2.25-2.05-2.75-5h5.5c-.5 2.95-1.68 5-2.75 5zm2.04-.27c.79-1.07 1.4-2.74 1.72-4.73h3.63a7.996 7.996 0 01-5.35 4.73zM13.89 12a18.419 18.419 0 000-4h3.83c.17.64.28 1.31.28 2s-.11 1.36-.28 2h-3.83z"/>`,
  },

  OU: {
    viewBox: "0 0 24 24",
    shapes: `<path transform="translate(5 5) scale(0.7)" d="M0 17c0 .55.45 1 1 1h18c.55 0 1-.45 1-1V7H0v10zM19 4H9.41l-1.7-1.71A.997.997 0 007 2H1c-.55 0-1 .45-1 1v3h20V5c0-.55-.45-1-1-1z"/> <g fill="none" stroke="{fg}" stroke-width="1"><path d="M12 12.25V13.55M9.6 15.05V13.55H14.4V15.05"/></g> <g fill="{fg}"><rect x="11.1" y="11.05" width="1.8" height="1.3"/><rect x="8.7" y="15.05" width="1.8" height="1.3"/><rect x="13.5" y="15.05" width="1.8" height="1.3"/></g>`,
  },

  Container: {
    viewBox: "0 0 24 24",
    scale: 0.9,
    shapes: `<path d="M12 3.8L19.3 8V16L12 20.2L4.7 16V8Z" /> <path d="M4.7 8L12 12.2L19.3 8M12 12.2V20.2" fill="none" stroke="{fg}" stroke-width="1.25" stroke-linejoin="round"/>`,
  },

  GPO: {
    viewBox: "0 0 24 24",
    scale: 0.95,
    shapes: `<path d="M12 3.6L19.2 6.4V12C19.2 16 16.2 18.8 12 20.2C7.8 18.8 4.8 16 4.8 12V6.4Z" /> <path d="M8.9 12L11.1 14.2L15.3 9.9" fill="none" stroke="{fg}" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/>`,
  },

  CertTemplate: {
    viewBox: "0 0 24 24",
    shapes: `<path d="M7 4.6H13.9L17 7.7V19.4H7Z" /> <path d="M9.2 9H12.6M9.2 11.6H14.8" stroke="{fg}" stroke-width="1.1"/> <circle cx="13.3" cy="15.6" r="1.8" fill="{fg}"/>`,
  },

  EnterpriseCA: {
    viewBox: "0 0 24 24",
    shapes: `<path d="M9 14.4L7.4 20.6L10.1 19.2L11.6 16.3ZM15 14.4L16.6 20.6L13.9 19.2L12.4 16.3Z" /> <circle cx="12" cy="10.2" r="6" /> <circle cx="12" cy="10.2" r="3.3" fill="none" stroke="{fg}" stroke-width="1.2"/>`,
  },

  RootCA: {
    viewBox: "0 0 24 24",
    root: 'fill-rule="evenodd"',
    shapes: `<path d="M7.6 7.6A4.4 4.4 0 1 1 7.6 16.4A4.4 4.4 0 1 1 7.6 7.6ZM7.6 10.3A1.7 1.7 0 1 0 7.6 13.7A1.7 1.7 0 1 0 7.6 10.3Z" /> <path d="M11.6 11H20V13H11.6ZM15.6 13H17.4V15.6H15.6ZM18.2 13H20V14.8H18.2Z" />`,
  },

  AIACA: {
    viewBox: "0 0 24 24",
    shapes: `<g fill="none" stroke="currentColor" stroke-width="2.3"><rect x="3.8" y="9.3" width="9.4" height="5.4" rx="2.7" transform="rotate(-45 8.5 12)"/><rect x="10.8" y="9.3" width="9.4" height="5.4" rx="2.7" transform="rotate(-45 15.5 12)"/></g>`,
  },

  NTAuthStore: {
    viewBox: "0 0 24 24",
    scale: 0.95,
    shapes: `<rect x="4.8" y="5.6" width="14.4" height="13" /> <path d="M4.8 9.6H19.2" stroke="{fg}" stroke-width="1.1"/> <path d="M12 11.6A1.6 1.6 0 1 1 11.99 11.6ZM11.4 13.6H12.6L13 16.2H11Z" fill="{fg}"/> <path d="M6.2 18.6H8.4V19.8H6.2ZM15.6 18.6H17.8V19.8H15.6Z" />`,
  },

  IssuancePolicy: {
    viewBox: "0 0 24 24",
    scale: 0.95,
    shapes: `<circle cx="12" cy="6.6" r="2.7" /> <path d="M10.8 9H13.2V12.4H10.8Z" /> <path d="M5.6 12.4H18.4V15.8H5.6Z" /> <path d="M6.6 17.2H17.4V18.8H6.6Z" />`,
  },

};

export const slug = (kind) => String(kind).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

export const glyphClass = (kind) => `node-icon--${slug(KIND_GLYPHS[kind] ? kind : "Base")}`;

const drawn = (glyph, cx, cy) => (glyph.scale
  ? `<g transform="translate(${cx} ${cy}) scale(${glyph.scale}) translate(${-cx} ${-cy})">${glyph.shapes}</g>`
  : glyph.shapes);

function glyphStyleSheet() {
  const fg = token("--fg", "#fff"), bg = token("--bg", "#000");

  return Object.entries(KIND_GLYPHS).map(([kind, glyph]) => {
    const [x, y, w, h] = glyph.viewBox.split(/\s+/).map(Number);
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2;

    const rim = (w * 4) / 60;
    const root = glyph.root ? ` ${glyph.root}` : "";

    const face = (ring, square) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${glyph.viewBox}">`
        + (square
          ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fg}"/>`

          : `<clipPath id="c"><circle cx="${cx}" cy="${cy}" r="${glyph.bleed ? r - rim * 0.45 : r}"/></clipPath>`
            + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fg}"/>`)

        + (ring
          ? (square
            ? `<rect x="${x + rim / 2}" y="${y + rim / 2}" width="${w - rim}" height="${h - rim}" fill="none" stroke="${ring}" stroke-width="${rim}"/>`
            : `<circle cx="${cx}" cy="${cy}" r="${r - rim / 2}" fill="none" stroke="${ring}" stroke-width="${rim}"/>`)
          : "")

        + `<g${square ? "" : ' clip-path="url(#c)"'} fill="${bg}" color="${bg}"${root}>${drawn(glyph, cx, cy).replaceAll("{fg}", fg)}</g></svg>`;
      return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    };

    const ring = kind === "User" ? "" : token(`--k-${slug(kind)}`, "");
    return `.${glyphClass(kind)}{--face:${face("")};--face-tinted:${face(ring)};`
      + `--face-square:${face("", true)};--face-square-tinted:${face(ring, true)}}`;
  }).join("\n");
}

export function useKindGlyphs() {
  const theme = useTheme();
  useEffect(() => {
    let el = document.getElementById("kind-glyphs");
    if (!el) {
      el = document.createElement("style");
      el.id = "kind-glyphs";
      document.head.append(el);
    }
    if (el.dataset.theme !== theme) {
      el.textContent = glyphStyleSheet();
      el.dataset.theme = theme;
    }
  }, [theme]);
  return theme;
}

const { Graph } = window.Cosmos;

const STAR_MAX = 16;
const STAR_AIR = 1.15;
const MIN_EXTENT = 180;

const FIT_PADDING = 0.06;
const FULL_CANVAS = Object.freeze({ left: 0, top: 0, width: 1, height: 1 });

const DOT_SHARE = FOOTPRINT.dot;
const DOT_SHARE_MIN = 0.32;
const CROWDED = 20;
const DOT_MIN = 4;
const DOT_MAX = 22;

const POINT_SCALE = FOOTPRINT.drawn;

export const POINT_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

const ZOOM_HEADROOM = 4;
const ZOOM_UNNEEDED_ABOVE = 160;

const ZOOM_HEADROOM_MIN = 1.5;
const POINT_CAP_FALLBACK = 64;

const POINT_CAP_MIN = 16;

const LINK_RATIO = 0.082;
const LINK_MIN = 0.76;

const ARROW_RATIO = 0.68;
const LINK_OPACITY = 0.72;

const PORTS_MAX = 3000;

const PORT_TURN = 0.7;

const LABEL_RATIO = FOOTPRINT.label;
const LABEL_DROP = FOOTPRINT.drop;

const LABEL_SHOW_PX = 4;

const LABEL_FLOOR_PX = 7;

const LABEL_MIN_PX = 12;

const LABEL_MAX_PX = 17;

const GAP_PX_MAX = LABEL_MAX_PX / (FOOTPRINT.dot * FOOTPRINT.label);

const POINT_FLOOR_PX = 2.5;

const CULL_MARGIN = 260;

export const LINK_LABEL_MAX = 500;

const ICON_SHARE = 1;
const ICON_MIN_PX = 10;
const RING_GAP = [0.12, 1.5, 4];
const RING_WIDTH = [0.06, 1, 1.5];
const OWNED_FLAG = [0.33, 9, 22];

const RING_MIN_PX = 7;

const CLUSTER_LABEL = [0.035, 11, 14];

const CLUSTER_MIN_PX = 64;

const SETTLE_MS = 180;
const OPEN_SECONDS = 0.41;

const REARRANGE_SECONDS = 0.95;
const FADE_SECONDS = 0.3;
const DOUBLE_CLICK_MS = 350;
const SELECT_SECONDS = 0.25;

const RETICLE_CORNER = 26;
const RETICLE_HOVER_CORNER = 18;
const RETICLE_DASH = (c, gap) => [c, gap, 2 * c, gap, 2 * c, gap, 2 * c, gap, c].join(" ");
const RETICLE_OPEN = RETICLE_DASH(RETICLE_CORNER, 96 - 2 * RETICLE_CORNER);
const RETICLE_CLOSED = RETICLE_DASH(RETICLE_CORNER, 0);
const RETICLE_HOVER = RETICLE_DASH(RETICLE_HOVER_CORNER, 96 - 2 * RETICLE_HOVER_CORNER);
const RETICLE_STROKE = 1.5;
const HOVER_SECONDS = 0.12;

const GRAB_PX = 12;
const DRAG_SLOP_PX = 3;

const SLIDE_GRAB_PX = 6;

const SLIDE_SETTLE_SECONDS = 0.22;

const GROUP_RELATED_MAX = 60;

const UNRELATED = 0.14;

const LINK_HIT_PX = 8;

export const PAINTS = ["white", "red", "orange", "yellow", "green", "camo", "cyan", "violet", "magenta"];

const segmentDistance = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const LABEL_MODES = ["auto", "none"];

const linkBuffer = (links) => {
  const out = new Float32Array(links.length * 2);
  links.forEach((link, i) => { out[i * 2] = link.source; out[i * 2 + 1] = link.target; });
  return out;
};

export class GraphView {

  constructor(host, scene, handlers) {
    this.host = host;
    this.scene = scene;
    this.handlers = handlers;

    this.count = 0;
    this.dot = DOT_MAX;
    this.gap = NODE_GAP;
    this.cap = 0;
    this.sizes = null;
    this.pointScale = 1;
    this.sizedAt = -1;
    this.ids = [];
    this.links = [];
    this.paints = new Map();
    this.lastPaint = "white";
    this.label = 0;
    this.awakeUntil = 0;
    this.pump = 0;
    this.frame = 0;
    this.entrance = 0;
    this.flow = false;
    this.fixedLayout = null;
    this.fade = null;
    this.dimmed = false;
    this.repaint = false;
    this.entering = false;
    this.fits = 0;
    this.ring = null;
    this.reach = 0;
    this.reachRun = null;
    this.hoverFade = null;
    this.hoverShown = null;
    this.hovered = null;
    this.lastClick = { index: null, at: 0 };

    this.group = new Set();
    this.handles = null;
    this.slideHover = null;
    this.caught = null;
    this.rings = [];
    this.swallowClick = false;

    this.ui = zoomOf();
    this.onResize = () => {
      const ui = zoomOf();
      if (ui !== this.ui && this.deviceReady) {
        this.graph.setZoomLevel(this.graph.getZoomLevel() * (ui / this.ui), 0);
      }
      this.ui = ui;
      this.wake();
    };

    this.positions = new Float32Array(0);

    this.placed = new Map();
    this.placedMax = Infinity;

    this.iconsHidden = false;
    this.labelsHidden = false;
    this.arriving = null;
    this.sizeScale = 1;
    this.linkLift = 1;
    this.iconSizedAt = 0;
    this.iconsLegible = false;

    this.tierZeroHidden = false;
    this.ownedHidden = false;

    this.press = null;
    this.pendingCamera = null;

    this.from = null;
    this.progress = 1;
    this.scratch = null;
    this.adjacency = null;
    this.related = null;
    this.labelMode = "auto";
    this.kinds = [];

    this.clusters = [];

    this.tinted = false;
    this.palette = new Map();

    this.selectedIndex = null;

    this.deviceReady = false;
    this.pending = null;

    this.graph = new Graph(host, {
      enableSimulation: false,

      enableDrag: false,
      spaceSize: SPACE,
      backgroundColor: token("--bg"),
      transitionDuration: 0,
      fitViewOnInit: false,

      onTransition: (progress) => {
        if (!this.from) return;
        this.progress = progress;
        this.layoutLabels();
      },
      onTransitionEnd: () => {
        if (!this.from) return;
        const landed = this.arriving;
        this.from = null;
        this.progress = 1;
        this.arriving = null;
        this.graph.setConfigPartial({ transitionDuration: 0, transitionEasing: "cubic-in-out" });
        if (landed) this.landed(landed);
        if (this.repaint) this.highlight(this.selectedIndex);
        this.wake();
      },

      pointDefaultColor: token("--fg"),
      scalePointsOnZoom: true,

      linkDefaultColor: token("--edge"),

      linkVisibilityDistanceRange: [0, 600],
      linkVisibilityMinTransparency: 1,
      linkDefaultArrows: true,
      scaleLinksOnZoom: true,

      hoveredPointCursor: "pointer",

      renderHoveredPointRing: false,

      onZoom: () => { this.floorPoints(); this.wake(); },

      onZoomEnd: (_event, userDriven) => { if (userDriven) this.cameraSettled(); else this.fitted(); },
      onPointMouseOver: (index) => { this.hoverByName = false; this.hovered = index; this.setHover(true); },
      onPointMouseOut: () => { this.hovered = null; this.setHover(false); },

    });

    host.addEventListener("dblclick", (e) => e.stopPropagation(), true);

    this.onDown = (e) => this.pointerDown(e);
    this.onMove = (e) => { this.pointerMove(e); this.nameHover(e); };
    this.onUp = (e) => this.pointerUp(e);
    this.onMouseDown = (e) => { if (this.press?.index != null) e.stopPropagation(); };

    this.onContext = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const index = this.hit(e);
      this.handlers.onContextMenu?.(index, e.clientX, e.clientY, index === null ? this.linkAt(e) : null);
    };
    host.addEventListener("contextmenu", this.onContext, true);
    host.addEventListener("pointerdown", this.onDown, true);
    host.addEventListener("mousedown", this.onMouseDown, true);
    host.addEventListener("pointermove", this.onMove);
    host.addEventListener("pointerup", this.onUp);
    host.addEventListener("pointercancel", this.onUp);

    this.onScenePress = (e) => this.scenePress(e);
    this.onSceneMove = (e) => this.slideHoverAt(e);
    this.onSceneLeave = () => this.setSlideHover(null);
    this.onSceneMouseDown = (e) => { if (this.press?.kind) e.stopPropagation(); };
    this.onKey = (e) => this.key(e);
    this.onSelectStart = (e) => { if (this.press?.kind) e.preventDefault(); };
    scene.addEventListener("selectstart", this.onSelectStart);
    scene.addEventListener("pointerdown", this.onScenePress, true);
    scene.addEventListener("mousedown", this.onSceneMouseDown, true);
    scene.addEventListener("pointermove", this.onSceneMove);
    scene.addEventListener("pointerleave", this.onSceneLeave);
    window.addEventListener("keydown", this.onKey);

    const nameIndex = (target) => {
      const el = target?.closest?.(".node-label");
      const i = el ? Number(el.dataset.index) : NaN;
      return Number.isInteger(i) ? i : null;
    };
    this.onNameOver = (e) => {
      const i = nameIndex(e.target);

      if (this.press || i === null || this.hovered === i || this.slideHover !== null) return;
      this.hovered = i; this.hoverByName = true; this.setHover(true);
    };
    this.onNameOut = (e) => {
      const i = nameIndex(e.target);
      if (i === null || nameIndex(e.relatedTarget) === i || !this.hoverByName || this.hovered !== i) return;
      this.hoverByName = false; this.hovered = null; this.setHover(false);
    };
    this.onNameClick = (e) => {

      if (this.swallowClick) { this.swallowClick = false; return; }
      const i = nameIndex(e.target);
      if (i === null || this.dead) return;
      const text = window.getSelection?.();
      if (text && !text.isCollapsed && text.toString().trim()) return;
      this.handlers.onSelect(i);
    };
    this.onNameWheel = (e) => {
      if (!e.target.closest?.(".node-label, .link-label") || !this.canvas) return;
      e.preventDefault();
      this.canvas.dispatchEvent(new WheelEvent("wheel", e));
    };
    scene.addEventListener("pointerover", this.onNameOver);
    scene.addEventListener("pointerout", this.onNameOut);
    scene.addEventListener("click", this.onNameClick);
    scene.addEventListener("wheel", this.onNameWheel, { passive: false });

    Promise.resolve(this.graph.ready).then(() => {
      if (this.dead) return;
      this.deviceReady = true;
      this.watchContext();
      const held = this.pending;
      this.pending = null;
      held?.();
    }).catch(() => {});

    this.onContextLost = (event) => {
      event.preventDefault();
      this.deviceReady = false;
      this.handlers.onContextLost?.();
    };
    this.onContextRestored = () => {
      this.deviceReady = true;
      this.watchContext();
      const held = this.pending;
      this.pending = null;
      held?.();
    };

    this.watchContext = () => {
      const canvas = host.querySelector("canvas");
      if (!canvas || canvas === this.canvas) return;
      this.canvas = canvas;
      canvas.addEventListener("webglcontextlost", this.onContextLost);
      canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    };

    this.tick = this.tick.bind(this);
    window.addEventListener("resize", this.onResize);

    this.whenSized = new ResizeObserver(() => {
      if (!this.unframed || !this.scene.clientWidth) return;
      this.resize(this.gap, this.framed);
      this.reframe(this.unframed, 0, this.unframedFit);
    });
    this.whenSized.observe(this.scene);
  }

  pointCap() {
    if (this.cap) return this.cap;
    const ratio = window.devicePixelRatio || 1;
    const canvas = this.host?.querySelector("canvas");
    const gl = canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
    const range = gl && gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    if (!range?.[1]) return POINT_CAP_FALLBACK / ratio;
    this.cap = Math.max(POINT_CAP_MIN, range[1] / ratio);
    return this.cap;
  }

  wake(ms = SETTLE_MS) {
    if (this.dead) return;
    this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms);
    if (!this.pump) this.pump = requestAnimationFrame(this.tick);
  }

  tick() {
    if (this.dead) return;

    if (!this.from) this.layoutLabels();
    if (performance.now() < this.awakeUntil) this.pump = requestAnimationFrame(this.tick);
    else this.pump = 0;
  }

  tap(index, event) {
    if (this.dead) return;
    if (index === null) {
      const link = event ? this.linkAt(event) : null;
      if (link !== null) { this.toggleLit(link); return; }
      this.handlers.onClearSelection();
      return;
    }

    const reading = this.handlers.labels().selected;
    this.setGroup([this.ids[index]]);
    if (index === reading) this.highlight(index);
    const now = Date.now();
    const { index: last, at } = this.lastClick;
    this.lastClick = { index, at: now };
    if (last === index && now - at < DOUBLE_CLICK_MS) this.handlers.onExpand(index);
    else this.handlers.onSelect(index);
  }

  linkKey(k) {
    const link = this.links[k];
    return `${this.ids[link.source]}>${this.ids[link.target]}`;
  }

  paintOf(k) {
    return this.paints.size > 0 ? this.paints.get(this.linkKey(k)) ?? null : null;
  }

  isLit(k) {
    return this.paintOf(k) !== null;
  }

  lit() {
    return Object.fromEntries(this.paints);
  }

  setLit(lit) {
    const next = new Map(Object.entries(lit ?? {}).filter(([, paint]) => PAINTS.includes(paint)));
    if (next.size === this.paints.size && [...next].every(([key, paint]) => this.paints.get(key) === paint)) return;
    this.paints = next;
    this.highlight(this.selectedIndex);
  }

  paintLink(k, paint) {
    const key = this.linkKey(k);
    if (paint === null) this.paints.delete(key);
    else if (PAINTS.includes(paint)) { this.paints.set(key, paint); this.lastPaint = paint; }
    else return;
    this.highlight(this.selectedIndex);
    this.handlers.onLitChange?.(this.lit());
  }

  toggleLit(k) {
    this.paintLink(k, this.isLit(k) ? null : this.lastPaint);
  }

  linkInfo(k) {
    const link = this.links[k];
    return { index: k, from: this.labelTexts[link.source], to: this.labelTexts[link.target], paint: this.paintOf(k) };
  }

  paintColor(paint) {
    const key = `paint:${paint}`;
    if (this.palette.has(key)) return this.palette.get(key);
    const value = paint === "white" ? token("--fg") : token(`--paint-${paint}`);
    if (!value) return rgba(token("--fg"));
    const rgb = rgba(value);
    this.palette.set(key, rgb);
    return rgb;
  }

  linkAt(event) {
    if (this.count === 0 || this.links.length === 0) return null;
    const [px, py] = this.screenAt(event);
    let best = null, nearest = LINK_HIT_PX;
    this.links.forEach((_, k) => {
      const pts = this.linkShape(k);
      if (!pts) return;
      for (let i = 1; i < pts.length; i += 1) {
        const d = segmentDistance(px, py, pts[i - 1], pts[i]);
        if (d < nearest) { nearest = d; best = k; }
      }
    });
    return best;
  }

  linkShape(k, positions = this.currentPositions()) {
    const link = this.links[k];
    if (!link) return null;
    const toScreen = (x, y) => this.graph.spaceToScreenPosition([x, y]);
    const a = toScreen(positions[link.source * 2], positions[link.source * 2 + 1]);
    const b = toScreen(positions[link.target * 2], positions[link.target * 2 + 1]);
    if (!a || !b) return null;

    if (this.twin?.[k] !== undefined && this.twin[k] !== -1) {
      const head = this.headPx ?? LINK_HIT_PX;
      const ctrl = controlOf(a, b, bowOf(Math.hypot(b[0] - a[0], b[1] - a[1]), head));
      const pts = [];
      for (let i = 0; i <= BOW_STEPS; i += 1) {
        const t = i / BOW_STEPS, u = 1 - t;
        pts.push([
          u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0],
          u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1],
        ]);
      }
      return pts;
    }

    const pts = [a];
    const bends = this.routes?.[k];
    if (bends) for (let q = 0; q < bends.length; q += 2) pts.push(toScreen(bends[q], bends[q + 1]));
    pts.push(b);
    return pts.some((p) => !p) ? null : pts;
  }

  screenAt(event) {
    const rect = this.host.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  perPixel() {
    const r = this.graph.spaceToScreenRadius(1);
    return r > 0 ? 1 / r : 1;
  }

  hit(event) {
    return this.discAt(event) ?? this.nameAt(event);
  }

  discAt(event) {
    if (this.count === 0 || this.positions.length < this.count * 2) return null;
    const at = this.graph.screenToSpacePosition(this.screenAt(event));
    if (!Number.isFinite(at[0]) || !Number.isFinite(at[1])) return null;
    const reach = Math.max(this.dot / 2, GRAB_PX * this.perPixel());
    const limit = reach * reach;
    let best = null;
    let nearest = Infinity;
    for (let i = 0; i < this.count; i += 1) {
      const dx = this.positions[i * 2] - at[0];
      const dy = this.positions[i * 2 + 1] - at[1];
      const d = dx * dx + dy * dy;
      if (d <= limit && d < nearest) { nearest = d; best = i; }
    }
    return best;
  }

  nameAt(event) {
    const shown = this.shownNames;
    if (!shown || shown.length === 0) return null;
    const [x, y] = this.screenAt(event);
    for (let k = shown.length - 1; k >= 0; k -= 1) {
      const [i, r] = shown[k];
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return i;
    }
    return null;
  }

  nameHover(event) {
    if (this.dead || this.press) return;
    const i = this.nameAt(event);
    if (i !== null && this.hovered === null) {
      this.hovered = i; this.hoverByName = true; this.host.style.cursor = "pointer"; this.setHover(true);
    } else if (i === null && this.hoverByName) {
      this.hoverByName = false; this.host.style.cursor = "";
      if (this.hovered !== null) { this.hovered = null; this.setHover(false); }
    }
  }

  pointerDown(event) {
    if (this.dead || !event.isPrimary || event.button !== 0) return;

    const text = document.getSelection?.();
    if (text && !text.isCollapsed && this.scene.contains(text.anchorNode)) text.removeAllRanges();
    const index = this.hit(event);
    const at = index === null ? null : this.graph.screenToSpacePosition(this.screenAt(event));
    const members = index !== null && this.group.size > 1 && this.group.has(this.ids[index])
      ? this.groupIndices() : null;
    this.press = {
      id: event.pointerId,
      index,

      dx: index === null ? 0 : this.positions[index * 2] - at[0],
      dy: index === null ? 0 : this.positions[index * 2 + 1] - at[1],
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
      frame: 0,
      at: null,

      members,
      base: members && Float32Array.from(this.positions),
    };
    if (index === null) return;

    try { this.host.setPointerCapture(event.pointerId); } catch {  }
    this.graph.setConfigPartial({ transitionDuration: 0 });
  }

  pointerMove(event) {
    const press = this.press;
    if (this.dead || !press || event.pointerId !== press.id) return;
    if (!press.moved) {
      if (Math.abs(event.clientX - press.fromX) <= DRAG_SLOP_PX
        && Math.abs(event.clientY - press.fromY) <= DRAG_SLOP_PX) return;
      press.moved = true;
    }
    if (press.kind === "shift") { this.drawMarquee(event); return; }
    if (press.index === null && press.kind !== "slide") return;
    press.at = this.graph.screenToSpacePosition(this.screenAt(event));

    if (press.frame) return;
    press.frame = requestAnimationFrame(() => {
      press.frame = 0;
      if (this.dead || this.press !== press || !press.at) return;
      if (press.kind === "slide") this.slideTo(press);
      else if (press.members) {
        const i = press.index;
        const dx = press.at[0] + press.dx - press.base[i * 2], dy = press.at[1] + press.dy - press.base[i * 2 + 1];
        for (const j of press.members) {
          this.positions[j * 2] = press.base[j * 2] + dx;
          this.positions[j * 2 + 1] = press.base[j * 2 + 1] + dy;
        }
      } else {
        this.positions[press.index * 2] = press.at[0] + press.dx;
        this.positions[press.index * 2 + 1] = press.at[1] + press.dy;
      }
      this.graph.setPointPositions(this.positions, true);
      this.graph.render();
      this.wake();
    });
  }

  pointerUp(event) {
    const press = this.press;
    if (!press || event.pointerId !== press.id) return;
    cancelAnimationFrame(press.frame);
    this.press = null;
    this.scene.classList.remove("graph-scene--pressing");
    try { this.host.releasePointerCapture(event.pointerId); } catch {  }
    if (this.dead) return;
    if (press.kind === "shift") { this.endShift(press); return; }
    if (press.kind === "slide") { this.endSlide(press); return; }
    if (!press.moved) { this.tap(press.index, event); return; }
    if (press.index === null) return;

    this.dropRoutes();
    this.keepPlaced(press.members ?? [press.index]);
  }

  keepPlaced(indices, positions = this.positions) {
    for (const i of indices) {
      const id = this.ids[i];
      if (id === undefined) continue;

      this.placed.delete(id);
      this.placed.set(id, [positions[i * 2], positions[i * 2 + 1]]);
    }
    while (this.placed.size > this.placedMax) this.placed.delete(this.placed.keys().next().value);
    this.handlers.onLayoutChange?.(this.layout());
  }

  groupIndices() {
    const out = [];
    for (let i = 0; i < this.count; i += 1) if (this.group.has(this.ids[i])) out.push(i);
    return out;
  }

  setGroup(ids) {
    this.group = new Set(ids);
    this.handles = null;
    this.setSlideHover(null);
    this.wake();
  }

  handleLinks() {
    if (this.handles) return this.handles;
    const inside = (i) => this.group.has(this.ids[i]);
    this.handles = [];
    this.links.forEach((link, k) => {
      if (link.source !== link.target && inside(link.source) !== inside(link.target)) this.handles.push(k);
    });
    return this.handles;
  }

  slideLinkAt(event) {
    if (this.group.size === 0 || this.count === 0) return null;
    const handles = this.handleLinks();
    if (handles.length === 0) return null;
    const [x, y] = this.screenAt(event);
    const radius = Math.max(this.graph.spaceToScreenRadius(this.dot / 2), (POINT_FLOOR_PX * this.ui) / 2);
    const reach = SLIDE_GRAB_PX * this.ui;
    let best = null, nearest = reach;
    for (const k of handles) {
      const { source, target } = this.links[k];
      const a = this.graph.spaceToScreenPosition([this.positions[source * 2], this.positions[source * 2 + 1]]);
      const b = this.graph.spaceToScreenPosition([this.positions[target * 2], this.positions[target * 2 + 1]]);
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (!(length > 2 * radius)) continue;
      const along = ((x - a[0]) * dx + (y - a[1]) * dy) / length;
      if (along < radius || along > length - radius) continue;
      const off = Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / length;
      if (off < nearest) { nearest = off; best = k; }
    }
    return best;
  }

  slideCursor(k) {
    const { source, target } = this.links[k];
    const a = this.graph.spaceToScreenPosition([this.positions[source * 2], this.positions[source * 2 + 1]]);
    const b = this.graph.spaceToScreenPosition([this.positions[target * 2], this.positions[target * 2 + 1]]);
    const angle = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 180) % 180;
    return ["ew", "nwse", "ns", "nesw"][Math.round(angle / 45) % 4];
  }

  slideHoverAt(event) {
    if (this.dead || this.press) return;
    const k = this.group.size > 0 && this.discAt(event) === null ? this.slideLinkAt(event) : null;
    this.setSlideHover(k);
  }

  setSlideHover(k) {
    if (k === this.slideHover) return;
    this.slideHover = k;
    if (k === null) delete this.scene.dataset.slide;
    else {
      this.scene.dataset.slide = this.slideCursor(k);

      if (this.hoverByName) { this.hoverByName = false; this.hovered = null; this.setHover(false); }
    }
    this.wake();
  }

  scenePress(event) {
    this.swallowClick = false;
    if (this.dead || !event.isPrimary || event.button !== 0 || this.count === 0) return;
    if (!this.host.contains(event.target) && !event.target.closest?.(".node-label, .link-label")) return;
    let kind = null, link = null;
    if (event.shiftKey) kind = "shift";
    else if (this.group.size > 0 && this.discAt(event) === null) {
      link = this.slideLinkAt(event);
      if (link !== null) kind = "slide";
    }
    if (!kind) return;

    event.preventDefault();
    event.stopPropagation();
    window.getSelection?.()?.removeAllRanges();
    this.scene.classList.add("graph-scene--pressing");
    this.swallowClick = true;
    const [x, y] = this.screenAt(event);
    this.press = {
      kind, id: event.pointerId, index: kind === "shift" ? this.hit(event) : null,
      fromX: event.clientX, fromY: event.clientY, x0: x, y0: y, moved: false, frame: 0, at: null,
    };
    if (kind === "slide") this.beginSlide(this.press, link, event);
    try { this.host.setPointerCapture(event.pointerId); } catch {  }
  }

  beginSlide(press, k, event) {
    const { source, target } = this.links[k];
    const own = this.group.has(this.ids[source]) ? source : target;
    const far = own === source ? target : source;
    const P = this.positions;
    const dx = P[far * 2] - P[own * 2], dy = P[far * 2 + 1] - P[own * 2 + 1];
    const length = Math.hypot(dx, dy) || 1;
    press.link = k;
    press.members = this.groupIndices();
    press.base = Float32Array.from(P);
    press.ux = dx / length;
    press.uy = dy / length;
    press.length = length;
    press.s = 0;
    press.start = this.graph.screenToSpacePosition(this.screenAt(event));

    const xs = new Float64Array(this.count), ys = new Float64Array(this.count);
    for (let i = 0; i < this.count; i += 1) { xs[i] = P[i * 2]; ys[i] = -P[i * 2 + 1]; }
    const names = this.names === "short" ? this.shortTexts : this.labelTexts;
    press.rail = slideStop(xs, ys, press.members, press.ux, -press.uy, length,
      footprints(this.count, names, this.gap));
    this.graph.setConfigPartial({ transitionDuration: 0 });
    this.wake();
  }

  slideTo(press) {
    const along = (press.at[0] - press.start[0]) * press.ux + (press.at[1] - press.start[1]) * press.uy;
    const s = clamp(along, -1.5 * press.length, press.rail.stop);
    press.s = s;
    for (const i of press.members) {
      this.positions[i * 2] = press.base[i * 2] + press.ux * s;
      this.positions[i * 2 + 1] = press.base[i * 2 + 1] + press.uy * s;
    }
  }

  endSlide(press) {
    if (!press.moved) { this.wake(); return; }
    const t = press.rail.nearest(press.s);
    this.dropRoutes();
    if (Math.abs(t - press.s) > 1e-6) {
      const to = Float32Array.from(this.positions);
      for (const i of press.members) {
        to[i * 2] = press.base[i * 2] + press.ux * t;
        to[i * 2 + 1] = press.base[i * 2 + 1] + press.uy * t;
      }
      this.place(to, DUR(SLIDE_SETTLE_SECONDS) * 1000);
      this.keepPlaced(press.members, to);
      return;
    }
    this.keepPlaced(press.members);
  }

  drawMarquee(event) {
    const press = this.press;
    const [x, y] = this.screenAt(event);
    press.x1 = x; press.y1 = y;
    press.marquee = true;
    const { marquee } = this.handlers.labels();
    const x0 = Math.min(press.x0, x), x1 = Math.max(press.x0, x);
    const y0 = Math.min(press.y0, y), y1 = Math.max(press.y0, y);
    const radius = Math.max(this.graph.spaceToScreenRadius(this.dot / 2), (POINT_FLOOR_PX * this.ui) / 2);
    const caught = new Set();
    for (let i = 0; i < this.count; i += 1) {
      const at = this.graph.spaceToScreenPosition([this.positions[i * 2], this.positions[i * 2 + 1]]);
      const cx = clamp(at[0], x0, x1), cy = clamp(at[1], y0, y1);
      if (Math.hypot(at[0] - cx, at[1] - cy) <= radius) caught.add(i);
    }
    this.caught = caught;
    if (marquee?.box) {
      Object.assign(marquee.box.style, { display: "block", width: `${x1 - x0}px`, height: `${y1 - y0}px`,
        transform: `translate(${x0}px, ${y0}px)` });
    }
    if (marquee?.count) {
      marquee.count.textContent = String(caught.size);
      marquee.count.style.display = "block";
      marquee.count.style.transform = `translate(${x + 4}px, ${y + 6}px)`;
    }
    this.wake();
  }

  hideMarquee() {
    const { marquee } = this.handlers.labels();
    if (marquee?.box) marquee.box.style.display = "none";
    if (marquee?.count) marquee.count.style.display = "none";
    this.caught = null;
    this.wake();
  }

  endShift(press) {
    const selected = this.handlers.labels().selected ?? null;
    if (press.marquee) {
      const caught = [...(this.caught ?? [])];
      this.hideMarquee();
      if (caught.length === 0) { this.handlers.onClearSelection(); return; }
      const start = this.graph.screenToSpacePosition([press.x0, press.y0]);
      let first = caught[0], nearest = Infinity;
      for (const i of caught) {
        const d = Math.hypot(this.positions[i * 2] - start[0], this.positions[i * 2 + 1] - start[1]);
        if (d < nearest) { nearest = d; first = i; }
      }
      const reading = caught.includes(selected) ? selected : first;
      this.setGroup(caught.map((i) => this.ids[i]));
      if (reading === selected) this.highlight(selected);
      else this.handlers.onSelect(reading);
      return;
    }
    const i = press.index;
    if (i === null) return;
    const id = this.ids[i];
    const next = new Set(this.group);
    if (next.has(id)) {
      next.delete(id);
      this.setGroup(next);
      if (i === selected) {

        const rest = this.groupIndices();
        if (rest.length === 0) this.handlers.onClearSelection();
        else this.handlers.onSelect(rest[0]);
        return;
      }
    } else {
      next.add(id);
      this.setGroup(next);
      if (selected === null) { this.handlers.onSelect(i); return; }
    }
    this.highlight(selected);
  }

  key(event) {
    if (event.key !== "Escape" || this.dead) return;
    const press = this.press;
    if (press?.kind || press?.members) {
      cancelAnimationFrame(press.frame);
      this.press = null;
      this.scene.classList.remove("graph-scene--pressing");
      try { this.host.releasePointerCapture(press.id); } catch {  }
      if (press.kind === "shift") { this.hideMarquee(); return; }
      if (press.base) {
        this.positions.set(press.base);
        this.graph.setPointPositions(this.positions, true);
        this.graph.render();
        this.wake();
      }
      return;
    }
    if (this.group.size === 0) return;
    const at = document.activeElement;
    if (at?.closest?.("input, textarea, [contenteditable], .bp5-overlay, .script-console")) return;
    if (document.querySelector(".bp5-overlay-open") || this.scene.closest(".graph-box--full")) return;
    this.handlers.onClearSelection();
  }

  setPlacedCap(max) {
    this.placedMax = Number.isFinite(max) && max >= 0 ? max : Infinity;
    while (this.placed.size > this.placedMax) this.placed.delete(this.placed.keys().next().value);
  }

  applyPlaced(positions) {
    if (this.placed.size === 0) return positions;
    this.ids.forEach((id, i) => {
      const at = this.placed.get(id);
      if (!at) return;
      positions[i * 2] = at[0];
      positions[i * 2 + 1] = at[1];
    });
    return positions;
  }

  replacePlaced(layout) {
    if (this.dead) return;
    this.placed.clear();
    this.restore(layout, null);
  }

  layout() {
    const out = {};
    const short = (v) => Math.round(v * 10) / 10;
    for (const [id, at] of this.placed) out[id] = [short(at[0]), short(at[1])];
    return out;
  }

  camera() {
    if (this.dead || this.count === 0) return null;
    const ref = this.framing(this.positions, 1);
    if (!(ref.width > 0) || !(ref.height > 0)) return null;
    const a = this.graph.screenToSpacePosition([0, 0]);
    const b = this.graph.screenToSpacePosition(
      [this.host.clientWidth || 1, this.host.clientHeight || 1],
    );
    if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return null;
    return {
      u0: (Math.min(a[0], b[0]) - ref.x0) / ref.width,
      v0: (Math.min(a[1], b[1]) - ref.y0) / ref.height,
      u1: (Math.max(a[0], b[0]) - ref.x0) / ref.width,
      v1: (Math.max(a[1], b[1]) - ref.y0) / ref.height,
    };
  }

  boxForCamera(camera, ref) {
    const usable = 1 - FIT_PADDING * 2;
    const x0 = ref.x0 + camera.u0 * ref.width;
    const x1 = ref.x0 + camera.u1 * ref.width;
    const y0 = ref.y0 + camera.v0 * ref.height;
    const y1 = ref.y0 + camera.v1 * ref.height;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const width = Math.max(MIN_EXTENT, (x1 - x0) * usable);
    const height = Math.max(MIN_EXTENT, (y1 - y0) * usable);
    return {
      x0: cx - width / 2, y0: cy - height / 2,
      x1: cx + width / 2, y1: cy + height / 2,
      width, height,
    };
  }

  cameraSettled() {
    if (this.dead) return;
    const box = this.camera();
    if (box) this.handlers.onCameraChange?.(box);
  }

  restore(layout, camera) {
    if (this.dead) return;
    if (layout) {
      for (const [id, at] of Object.entries(layout)) {
        if (Array.isArray(at) && at.length === 2 && at.every(Number.isFinite)) {
          this.placed.set(id, [at[0], at[1]]);
        }
      }
    }

    if (camera && [camera.u0, camera.v0, camera.u1, camera.v1].every(Number.isFinite)) {
      this.pendingCamera = camera;
    }
  }

  setTopology(nodes, links, change) {
    if (this.dead) return;
    cancelAnimationFrame(this.frame);
    this.arriving = null;

    if (change?.flow !== undefined || change?.fixedLayout !== undefined) {
      this.flow = change.flow === true;
      this.fixedLayout = change.fixedLayout ?? null;
      change = null;
    } else if (!change) { this.flow = false; this.fixedLayout = null; }

    const previous = this.count > 0 ? this.positions : null;
    const settled = new Map(previous ? this.ids.map((id, i) => [id, i]) : []);

    if (!change) {
      const reading = this.ids[this.handlers.labels().selected ?? -1];
      this.group = new Set(reading !== undefined && nodes.some((n) => n.id === reading) ? [reading] : []);
    }
    this.handles = null;
    this.setSlideHover(null);
    this.ids = nodes.map((n) => n.id);
    this.links = links;
    this.twin = twinsOf(links, nodes.length);
    this.kinds = nodes.map((n) => n.kind ?? "");
    this.labelTexts = nodes.map((n) => n.label ?? "");
    this.shortTexts = nodes.map((n) => shortName(n.label, n.kind));
    this.tierZero = nodes.map((n) => n.tierZeroSeed === true);
    this.labelOrder = labelPriority(nodes, links);
    this.adjacency = null;
    this.related = null;

    if (nodes.length === 0) {

      this.graph.setLinks(new Float32Array(0));
      this.place(new Float32Array(0), 0);
      this.count = 0;

      const { routes, reticles } = this.handlers.labels();
      this.drawRoutes(routes, 0);
      for (const el of [reticles?.hover, reticles?.select, ...this.rings]) if (el) el.style.display = "none";
      this.group = new Set();

      this.clusters = [];
      return;
    }

    this.count = nodes.length;
    this.graph.setLinks(linkBuffer(links));

    if (!change || !previous) {
      const { positions, gap } = this.arrange(nodes.length, links);
      if (this.placed.size > 0 && this.ids.some((id) => this.placed.has(id))) this.dropRoutes();
      this.applyPlaced(positions);

      const framed = this.notCloser(this.framing(
        positions, nodes.length <= STAR_MAX ? STAR_AIR : 1, gap,
      ), gap);
      const restored = this.pendingCamera;
      this.pendingCamera = null;
      this.resize(gap, framed);
      this.place(positions, 0);

      this.reframe(
        restored ? this.boxForCamera(restored, this.framing(positions, 1)) : this.closer(framed), 0,
        { avoid: !restored },
      );
      this.dimmed = false;

      this.fade?.cancel();
      this.scene.style.opacity = "0";
      cancelAnimationFrame(this.entrance);
      this.entering = true;
      return;
    }

    this.dropRoutes();
    const positions = new Float32Array(nodes.length * 2);
    const arrivals = [];
    nodes.forEach((node, i) => {
      const was = settled.get(node.id);
      if (was === undefined) { arrivals.push(i); return; }
      positions[i * 2] = previous[was * 2];
      positions[i * 2 + 1] = previous[was * 2 + 1];
    });

    if (arrivals.length === 0) {
      this.place(positions, 0);
      this.wake();
      return;
    }

    const opened = change.open !== undefined ? change.open : -1;
    const hub = opened >= 0
      ? [positions[opened * 2], positions[opened * 2 + 1]]
      : [CENTER, CENTER];
    const arriving = new Set(arrivals);
    const count = nodes.length;
    const xs = new Float64Array(count), ys = new Float64Array(count);
    for (let i = 0; i < count; i += 1) { xs[i] = positions[i * 2]; ys[i] = -positions[i * 2 + 1]; }
    const names = this.names === "short" ? this.shortTexts : this.labelTexts;
    const kinds = this.kinds, labels = this.labelTexts;
    placeArrivals(xs, ys, arrivals, opened, links, footprints(count, names, this.gap),
      (a, b) => String(kinds[a]).localeCompare(String(kinds[b])) || String(labels[a]).localeCompare(String(labels[b])) || a - b);
    for (const i of arrivals) { positions[i * 2] = xs[i]; positions[i * 2 + 1] = -ys[i]; }

    const seed = Float32Array.from(positions);
    for (const i of arrivals) {
      seed[i * 2] = hub[0];
      seed[i * 2 + 1] = hub[1];
    }
    this.place(seed, 0);

    const shrunk = Float32Array.from(this.sizes);
    for (const i of arrivals) shrunk[i] = 0;
    this.graph.setPointSizes(shrunk);
    this.arriving = arriving;

    this.applyPlaced(positions);

    const ms = DUR(OPEN_SECONDS) * 1000;
    this.wake(ms);
    this.graph.setConfigPartial({ transitionEasing: "cubic-out" });
    this.frame = requestAnimationFrame(() => { this.place(positions, ms); this.showArrivals(positions, arrivals, opened, ms); });
  }

  showArrivals(positions, arrivals, opened, ms) {
    const view = this.viewBox();
    if (!view) return;
    const inside = (b) => b.x0 >= view.x0 && b.x1 <= view.x1 && b.y0 >= view.y0 && b.y1 <= view.y1;
    const fits = (b) => b.width <= view.x1 - view.x0 && b.height <= view.y1 - view.y0;
    const pick = (members) => {
      const foot = footprints(this.count, this.names === "short" ? this.shortTexts : this.labelTexts, this.gap);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of members) {
        x0 = Math.min(x0, positions[i * 2] - foot.left[i]); x1 = Math.max(x1, positions[i * 2] + foot.right[i]);
        y0 = Math.min(y0, positions[i * 2 + 1] - foot.down[i]); y1 = Math.max(y1, positions[i * 2 + 1] + foot.up[i]);
      }
      return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
    };
    const near = pick(opened >= 0 ? [opened, ...arrivals] : arrivals);
    if (inside(near)) return;
    const all = this.framing(positions, 1, this.gap);
    if (fits(all)) this.panTo(all, ms);
    else if (fits(near)) this.panTo(near, ms);
    else this.reframe(near, ms, { avoid: true });
  }

  viewBox() {
    const width = this.scene.clientWidth || 0, height = this.scene.clientHeight || 0;
    if (!width || !height) return null;
    const open = this.open();
    const a = this.graph.screenToSpacePosition([width * open.left, height * open.top]);
    const b = this.graph.screenToSpacePosition([width * (open.left + open.width), height * (open.top + open.height)]);
    if (!a || !b) return null;
    return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  }

  landed(indices) {
    const { elements, rings, owned } = this.handlers.labels();
    for (const i of indices) {
      for (const set of [elements, rings, owned]) {
        if (set?.[i]) set[i].style.opacity = "";
      }
    }
  }

  arrivalFade() {
    return this.from ? clamp((this.progress - 0.3) / 0.7, 0, 1) : 1;
  }

  floorPoints() {
    if (this.dead || this.count === 0 || !this.deviceReady) return;
    const drawn = this.graph.spaceToScreenRadius(this.dot / 2) * 2;
    const floor = POINT_FLOOR_PX * this.ui;
    const scale = drawn > 0 && drawn < floor ? floor / drawn : 1;
    const linkPx = this.linkSpace > 0 ? this.graph.spaceToScreenRadius(this.linkSpace) : 0;
    const lift = linkPx > 0 && linkPx < LINK_MIN ? LINK_MIN / linkPx : 1;
    if (scale === this.sizeScale && lift === this.linkLift) return;
    this.sizeScale = scale;
    this.linkLift = lift;
    this.graph.setConfigPartial({
      pointSizeScale: scale,
      linkWidthScale: lift,
      linkArrowsSizeScale: this.linkSpace > 0 ? this.arrowSpace / (2 * this.linkSpace * lift) : 1,
    });
  }

  arrange(count, links) {
    const result = layoutWith(this.flow ? "hierarchy-lr" : this.fixedLayout ?? this.layoutMode, count, links, {
      kinds: this.kinds, labels: this.labelTexts ?? [], aspect: this.aspect(), root: this.selectedIndex,
      room: this.room(), gapPx: GAP_PX_MAX,
    });
    this.layoutUsed = result.layout;
    this.layoutAuto = result.auto === true;

    this.names = result.names ?? "full";

    this.clusters = result.clusters ?? [];

    this.routes = result.routes ?? null;
    return result;
  }

  rearrange({ reframe = false } = {}) {
    if (this.dead || this.count === 0) return;
    cancelAnimationFrame(this.frame);

    const had = this.placed.size > 0;
    this.placed.clear();

    const { positions, gap } = this.arrange(this.count, this.links);
    if (reframe) {

      const framed = this.notCloser(this.framing(positions, this.count <= STAR_MAX ? STAR_AIR : 1, gap), gap);
      const ms = DUR(REARRANGE_SECONDS) * 1000;
      this.resize(gap, framed);
      this.wake(ms + SETTLE_MS);
      this.frame = requestAnimationFrame(() => {
        this.place(positions, ms);
        this.reframe(this.closer(framed), ms, { avoid: true });
      });
      if (had) this.handlers.onLayoutChange?.({});
      setTimeout(() => this.cameraSettled(), ms + 16);
      return;
    }

    const drawnGap = this.matchSpacing(positions, gap);

    if (drawnGap < this.gap * (1 - 1e-3)) this.shrinkTo(drawnGap);
    const ms = DUR(REARRANGE_SECONDS) * 1000;
    this.wake(ms + SETTLE_MS);
    this.frame = requestAnimationFrame(() => {
      this.place(positions, ms);
      this.panTo(this.framing(positions, 1, drawnGap), ms);
    });

    if (had) this.handlers.onLayoutChange?.({});

    setTimeout(() => this.cameraSettled(), ms + 16);
  }

  matchSpacing(positions, gap) {
    const drawnFor = this.gap;
    if (!(drawnFor > 0) || !(gap > 0)) return gap;
    let reach = 0;
    for (let i = 0; i < positions.length; i += 1) reach = Math.max(reach, Math.abs(positions[i] - CENTER));
    const scale = Math.min(drawnFor / gap, reach > 0 ? MAX_RADIUS / reach : Infinity);
    if (Math.abs(scale - 1) < 1e-3) return gap;
    for (let i = 0; i < positions.length; i += 1) positions[i] = CENTER + (positions[i] - CENTER) * scale;
    for (const r of this.routes ?? []) if (r) for (let k = 0; k < r.length; k += 1) r[k] = CENTER + (r[k] - CENTER) * scale;
    for (const c of this.clusters) {
      c.x = CENTER + (c.x - CENTER) * scale;
      c.y = CENTER + (c.y - CENTER) * scale;
      c.w *= scale;
      if (c.h) c.h *= scale;
    }
    return gap * scale;
  }

  panTo(box, ms) {
    if (this.dead) return;
    const width = this.scene.clientWidth || 1, height = this.scene.clientHeight || 1;
    const topLeft = this.graph.screenToSpacePosition([0, 0]);
    const bottomRight = this.graph.screenToSpacePosition([width, height]);
    if (!topLeft || !bottomRight) return;
    const spanX = Math.abs(bottomRight[0] - topLeft[0]);
    const spanY = Math.abs(bottomRight[1] - topLeft[1]);
    const open = this.open();
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const x0 = cx - spanX * (open.left + open.width / 2);
    const fromTop = spanY * (open.top + open.height / 2);
    const [y0, y1] = topLeft[1] < bottomRight[1]
      ? [cy - fromTop, cy - fromTop + spanY] : [cy + fromTop - spanY, cy + fromTop];
    this.graph.fitViewByPointPositions(new Float32Array([x0, y0, x0 + spanX, y1]), ms, 0, false);
  }

  currentPositions() {
    const to = this.positions;
    if (!to) return new Float32Array(0);
    const from = this.from;
    if (this.progress >= 1 || !from || from.length !== to.length) return to;
    if (!this.scratch || this.scratch.length !== to.length) this.scratch = new Float32Array(to.length);
    const p = this.progress, out = this.scratch;
    for (let i = 0; i < to.length; i += 1) out[i] = from[i] + (to[i] - from[i]) * p;
    return out;
  }

  resize(gap, box) {
    if (this.dead) return;

    const usable = 1 - FIT_PADDING * 2;
    const open = this.open();
    const zoom = Math.min(
      ((this.scene.clientWidth || MIN_EXTENT) * open.width / this.ui * usable) / box.width,
      ((this.scene.clientHeight || MIN_EXTENT) * open.height / this.ui * usable) / box.height,
    );
    const spacing = gap * zoom;
    const share = clamp((spacing / CROWDED) * DOT_SHARE, DOT_SHARE_MIN, DOT_SHARE);

    const headroom = clamp(ZOOM_UNNEEDED_ABOVE / spacing, ZOOM_HEADROOM_MIN, ZOOM_HEADROOM);
    const ceiling = clamp(this.pointCap() / headroom, DOT_MIN + 1, DOT_MAX);

    const base = Math.min(spacing * share, ceiling);

    this.dot = Math.min(base * POINT_SCALE * this.pointScale, this.pointCap()) / zoom;
    this.gap = gap;

    this.framed = box;

    const link = base * LINK_RATIO;

    this.linkSpace = link / zoom;
    this.arrowSpace = (base * ARROW_RATIO) / zoom;
    this.graph.setConfigPartial({

      pointDefaultSize: this.dot,
      linkDefaultWidth: link / zoom,
      linkArrowsSizeScale: (base * ARROW_RATIO) / (2 * link),
      linkWidthScale: 1,

      linkOpacity: LINK_OPACITY,
    });

    this.linkLift = 1;
  }

  shrinkTo(gap) {
    const f = gap / this.gap;
    this.dot *= f;
    this.linkSpace *= f;
    this.arrowSpace *= f;
    this.gap = gap;
    this.graph.setConfigPartial({ pointDefaultSize: this.dot, linkDefaultWidth: this.linkSpace });
    this.floorPoints();
  }

  setPointScale(scale) {
    const next = clamp(scale, POINT_STEPS[0], POINT_STEPS.at(-1));
    if (this.dead || next === this.pointScale) return;
    this.pointScale = next;
    if (!this.framed || this.count === 0) return;
    this.resize(this.gap, this.framed);
    this.place(this.positions, 0);
    this.floorPoints();
    this.wake();
  }

  place(positions, ms) {
    if (this.dead) return;
    const count = positions.length / 2;
    if (!this.sizes || this.sizes.length !== count || this.sizedAt !== this.dot) {
      this.sizes = new Float32Array(count).fill(this.dot);
      this.sizedAt = this.dot;
    }

    const moving = ms > 0 && this.positions?.length === positions.length;
    this.from = moving ? Float32Array.from(this.positions) : null;
    this.positions = positions;
    this.progress = moving ? 0 : 1;

    if (!moving) this.arriving = null;
    if (!this.deviceReady) {

      this.pending = () => this.place(positions, ms);
      return;
    }
    this.graph.setConfigPartial({ transitionDuration: moving ? ms : 0 });
    this.graph.setPointPositions(positions, true);
    this.graph.setPointSizes(this.sizes);
    this.graph.render();
    this.floorPoints();

    this.wake(Math.max(ms, SETTLE_MS));
  }

  aspect() {
    return (this.scene.clientWidth || 1) / (this.scene.clientHeight || 1);
  }

  room() {
    const open = this.open();
    return { width: (this.scene.clientWidth || 0) * open.width / this.ui, height: (this.scene.clientHeight || 0) * open.height / this.ui };
  }

  framing(positions, air = 1, gap = 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const foot = gap > 0
      ? footprints(positions.length / 2, this.names === "short" ? this.shortTexts : this.labelTexts, gap) : null;
    for (let i = 0; i < positions.length; i += 2) {
      const k = i / 2;
      minX = Math.min(minX, positions[i] - (foot ? foot.left[k] : 0));
      maxX = Math.max(maxX, positions[i] + (foot ? foot.right[k] : 0));
      minY = Math.min(minY, positions[i + 1] - (foot ? foot.down[k] : 0));
      maxY = Math.max(maxY, positions[i + 1] + (foot ? foot.up[k] : 0));
    }
    if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = CENTER; }

    const widen = (lo, hi) => {
      const grown = Math.max(MIN_EXTENT, (hi - lo) * air);
      const pad = (grown - (hi - lo)) / 2;
      return [lo - pad, hi + pad];
    };
    const [x0, x1] = widen(minX, maxX);
    const [y0, y1] = widen(minY, maxY);
    return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
  }

  reframe(box, ms, { avoid = false } = {}) {
    if (this.dead) return;
    this.unframed = this.scene.clientWidth ? null : box;
    this.unframedFit = { avoid };
    if (this.unframed) return;
    this.fits += 1;
    const open = avoid ? this.open() : FULL_CANVAS;
    if (open === FULL_CANVAS || (open.left === 0 && open.top === 0 && open.width === 1 && open.height === 1)) {
      this.graph.fitViewByPointPositions(
        new Float32Array([box.x0, box.y0, box.x1, box.y1]), ms, FIT_PADDING, false,
      );
      return;
    }

    const aspect = this.aspect();
    const usable = 1 - FIT_PADDING * 2;
    const spanX = Math.max(box.width / (open.width * usable), (aspect * box.height) / (open.height * usable));
    const spanY = spanX / aspect;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const x0 = cx - spanX * (open.left + open.width / 2);
    const top = this.graph.screenToSpacePosition([0, 0])[1];
    const bottom = this.graph.screenToSpacePosition([0, this.scene.clientHeight || 1])[1];
    const fromTop = spanY * (open.top + open.height / 2);
    const [y0, y1] = top < bottom ? [cy - fromTop, cy - fromTop + spanY] : [cy + fromTop - spanY, cy + fromTop];
    this.graph.fitViewByPointPositions(new Float32Array([x0, y0, x0 + spanX, y1]), ms, 0, false);
  }

  open() {
    const c = this.handlers.covered?.() ?? null;
    if (!c) return FULL_CANVAS;
    const left = clamp(c.left || 0, 0, 0.7), right = clamp(c.right || 0, 0, 0.7 - left);
    const top = clamp(c.top || 0, 0, 0.5), bottom = clamp(c.bottom || 0, 0, 0.5 - top);
    return { left, top, width: 1 - left - right, height: 1 - top - bottom };
  }

  notCloser(box, gap) {
    const open = this.open();
    const usable = 1 - FIT_PADDING * 2;
    const width = ((this.scene.clientWidth || 0) * open.width / this.ui) * usable * gap / GAP_PX_MAX;
    const height = ((this.scene.clientHeight || 0) * open.height / this.ui) * usable * gap / GAP_PX_MAX;
    if (!(width > box.width || height > box.height)) return box;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const w = Math.max(box.width, width), h = Math.max(box.height, height);
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, width: w, height: h };
  }

  closer(box) {
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const width = box.width / this.ui, height = box.height / this.ui;
    return { x0: cx - width / 2, y0: cy - height / 2, x1: cx + width / 2, y1: cy + height / 2, width, height };
  }

  buildAdjacency() {
    const out = Array.from({ length: this.count }, () => []);
    const back = Array.from({ length: this.count }, () => []);
    for (const link of this.links) {
      if (link.source === link.target) continue;
      if (out[link.source]) out[link.source].push(link.target);
      if (back[link.target]) back[link.target].push(link.source);
    }
    this.adjacency = { out, back };
    return this.adjacency;
  }

  reachable(index) {
    const { out, back } = this.adjacency ?? this.buildAdjacency();
    const seen = new Uint8Array(this.count);
    seen[index] = 1;
    for (const edges of [out, back]) {
      const queue = [index];
      while (queue.length > 0) {
        const at = queue.pop();
        for (const next of edges[at] ?? []) {
          if (seen[next]) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    return seen;
  }

  relatedTo(index) {
    if (index === null || index === undefined) return null;
    const members = this.group.size > 1 ? this.groupIndices() : [];
    if (members.length <= 1) return this.reachable(index);
    if (members.length > GROUP_RELATED_MAX) return null;
    const all = new Uint8Array(this.count);
    for (const i of members) {
      const seen = this.reachable(i);
      for (let j = 0; j < this.count; j += 1) all[j] |= seen[j];
    }
    return all;
  }

  highlight(index) {
    if (this.dead || this.count === 0) return;
    this.selectedIndex = index ?? null;
    this.related = this.relatedTo(index);

    this.repaint = Boolean(this.from);
    if (this.repaint) return;
    const fg = rgba(token("--fg"));
    const edge = rgba(token("--edge"));
    const points = new Float32Array(this.count * 4);

    const faced = this.iconsLegible;
    for (let i = 0; i < this.count; i += 1) {
      const alpha = faced ? 0 : !this.related || this.related[i] ? 1 : UNRELATED;

      const c = this.tinted && !this.iconsLegible ? this.kindColor(this.kinds[i], fg) : fg;
      points.set([c[0], c[1], c[2], alpha], i * 4);
    }
    const lines = new Float32Array(this.links.length * 4);
    this.links.forEach((link, i) => {
      const paint = this.paintOf(i);
      if (paint) { const c = this.paintColor(paint); lines.set([c[0], c[1], c[2], 1], i * 4); return; }
      const lit = !this.related
        || (this.related[link.source] && this.related[link.target]);
      lines.set([edge[0], edge[1], edge[2], lit ? 1 : UNRELATED], i * 4);
    });
    this.graph.setPointColors(points);
    this.graph.setLinkColors(lines);
    this.graph.render();
    this.wake();
  }

  setLayoutMode(id) {
    if (this.dead) return;
    const next = LAYOUTS.some((l) => l.id === id) ? id : DEFAULT_LAYOUT;
    if (next === this.layoutMode) return;
    const first = this.layoutMode === undefined;
    this.layoutMode = next;
    if (!first && !this.flow && !this.fixedLayout && this.count > 0) this.rearrange({ reframe: true });
  }

  retheme() {
    if (this.dead) return;
    this.graph.setConfigPartial({ backgroundColor: token("--bg") });
    this.palette.clear();
    this.edgeColor = null;
    this.textColor = null;
    this.highlight(this.selectedIndex);
  }

  setTinted(on) {
    if (this.dead) return;
    if (this.tinted === (on === true)) return;
    this.tinted = on === true;
    this.palette.clear();

    this.highlight(this.selectedIndex);
  }

  setKinds(on) {
    if (this.dead) return;
    this.scene.classList.toggle("graph-scene--kinds", on === true);
  }

  kindColor(kind, fallback) {
    if (this.palette.has(kind)) return this.palette.get(kind);

    const value = token(`--k-${slug(kind)}`);
    if (!value) return fallback;
    const rgb = rgba(value);
    this.palette.set(kind, rgb);
    return rgb;
  }

  setLabelMode(mode) {
    this.labelMode = LABEL_MODES.includes(mode) ? mode : "auto";
    this.wake();
  }

  setHover(on) {
    if (this.dead) return;
    const { reticles } = this.handlers.labels();
    const el = reticles?.hover;
    if (!el) return;
    this.hoverFade?.stop();
    if (on) {
      this.hoverShown = this.hovered;
      el.firstElementChild.style.strokeDasharray = RETICLE_HOVER;
      el.style.display = "none";
      this.hoverFade = animate(el, { opacity: [0, 1] }, { duration: FADE(HOVER_SECONDS), ease: "easeOut" });
    } else {
      this.hoverFade = animate(el, { opacity: 0 }, { duration: FADE(HOVER_SECONDS), ease: "easeOut" });
      this.hoverFade.finished.then(() => { this.hoverShown = null; this.wake(); });
    }
    this.wake(FADE(HOVER_SECONDS) * 1000);
  }

  setSelected(index) {
    if (this.dead) return;

    const id = index === null || index === undefined ? undefined : this.ids[index];
    if (id === undefined) { if (this.group.size > 0) this.setGroup([]); }
    else if (!this.group.has(id)) this.setGroup([id]);
    const { reticles } = this.handlers.labels();
    const el = reticles?.select;
    this.ring?.stop();
    const to = index === null || index === undefined ? 0 : 1;
    if (!el) return;
    if (to === 1) {
      const rect = el.firstElementChild;

      el.style.display = "none";
      el.style.opacity = 1;
      rect.style.strokeDasharray = RETICLE_OPEN;
      this.ring = animate(rect,
        { rx: [0, 48], strokeDasharray: [RETICLE_OPEN, RETICLE_CLOSED] },
        { duration: DUR(SELECT_SECONDS * 0.7), ease: "easeOut" });

      this.reach = 0;
      this.reachRun?.stop();
      if (this.tierZero[index]) {
        this.reachRun = animate(0, 1, {
          duration: DUR(SELECT_SECONDS * 0.7), ease: "easeOut",
          onUpdate: (v) => { this.reach = v; },
        });
      }
    } else {
      this.ring = animate(el, { opacity: 0 }, { duration: FADE(SELECT_SECONDS), ease: "easeOut" });
    }
    this.wake(FADE(SELECT_SECONDS) * 1000);
  }

  fitted() {
    this.fits = Math.max(0, this.fits - 1);
    if (this.dead || this.fits > 0 || !this.entering) return;
    this.entering = false;
    this.entrance = requestAnimationFrame(() => {
      this.entrance = requestAnimationFrame(() => {

        if (this.dead || this.dimmed) return;
        this.fade = animate(this.scene, { opacity: [0, 1] },
          { duration: FADE(FADE_SECONDS), ease: "easeOut" });
        this.wake(FADE(FADE_SECONDS) * 1000);
      });
    });
  }

  setDimmed(dimmed) {
    if (this.dead) return;
    if (this.dimmed === dimmed) return;
    this.dimmed = dimmed;

    if (this.entering) return;
    this.fade?.stop();
    this.fade = animate(
      this.scene, { opacity: dimmed ? 0 : 1 },
      { duration: FADE(FADE_SECONDS), ease: "easeOut" },
    );
    this.wake(FADE(FADE_SECONDS) * 1000);
  }

  layoutLabels() {
    if (this.dead) return;
    if (this.count === 0) return;
    const { elements, links, rings, owned, icons, clusters, selected, reticles, routes } = this.handlers.labels();
    if (!elements) return;

    const named = this.labelMode !== "none";

    const positions = this.currentPositions();

    if (positions.length < elements.length * 2) return;

    const radius = Math.max(
      this.graph.spaceToScreenRadius(this.dot / 2), (POINT_FLOOR_PX * this.ui) / 2);

    const perSpace = this.gap > 0 ? this.graph.spaceToScreenRadius(this.gap) / this.gap : 0;
    const wanted = this.gap * perSpace * DOT_SHARE * LABEL_RATIO;
    this.resizeLabels(clamp(wanted, LABEL_FLOOR_PX * this.ui, LABEL_MAX_PX * this.ui));
    const offset = radius * LABEL_DROP;

    const lifted = Math.max(this.label, LABEL_MIN_PX * this.ui);

    const namedAll = named && wanted >= LABEL_SHOW_PX * this.ui;
    const arriving = this.arriving;
    const fade = arriving ? String(this.arrivalFade()) : "";
    const nameOf = (i) => named && (namedAll || i === selected || i === this.hovered);

    const revealing = this.hovered != null && this.hovered !== selected && !(this.drawnNames?.has(this.hovered));

    const box = this.scene.getBoundingClientRect();
    const edge = radius * 2 + CULL_MARGIN;
    const screen = elements.map((_, i) => {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const at = this.graph.spaceToScreenPosition([x, y]);
      if (!at) return null;
      if (at[0] < -edge || at[1] < -edge
        || at[0] > box.width + edge || at[1] > box.height + edge) return null;
      return at;
    });

    const noneNamed = !namedAll && selected == null && this.hovered == null;
    if (noneNamed && this.labelsHidden) {

      this.nameGrid = this.discGrid = null;
      this.shownNames = null;
      this.drawnNames = null;
      this.markName("selected", null);
    } else {
      this.labelsHidden = noneNamed;
      const wanted = (i) => nameOf(i) && screen[i]

        && (!this.related || this.related[i]);

      const size = `${this.label}|${this.scene.classList.contains("graph-scene--kinds")}`;
      const unmeasured = [];
      const forcedOf = (i) => (i === selected || (revealing && i === this.hovered)) && lifted > this.label;
      elements.forEach((el, i) => {
        if (!el || !wanted(i)) return;
        const own = forcedOf(i) ? `${lifted}px` : "";
        if (el.style.fontSize !== own) el.style.fontSize = own;
        const key = `${size}|${own}|${el.textContent}`;
        if (el.measured !== key) { el.style.display = "block"; el.measured = key; unmeasured.push(el); }
      });

      for (const el of unmeasured) el.dataset.name = "full";
      for (const el of unmeasured) el.box = [el.offsetWidth, el.offsetHeight];
      for (const el of unmeasured) el.dataset.name = "short";
      for (const el of unmeasured) el.boxShort = [el.offsetWidth, el.offsetHeight];

      const taken = new NameGrid();

      const discs = new NameGrid();
      this.nameGrid = taken; this.discGrid = discs;
      screen.forEach((at) => { if (at) discs.add([at[0] - radius, at[1] - radius, at[0] + radius, at[1] + radius]); });

      const order = [selected, ...(this.labelOrder ?? [])];

      const dropOf = (i) => (i === selected ? Math.max(offset, (this.selectRing ?? 0) + 2 * this.ui) : offset);
      const rectOf = (at, [w, h], i) => [at[0] - w / 2, at[1] + dropOf(i), at[0] + w / 2, at[1] + dropOf(i) + h];
      const free = (rect, own = null) => !taken.hits(rect, own) && !discs.hits(rect);
      const placed = [];
      const open = this.open();
      const view = [open.left * box.width, open.top * box.height, (open.left + open.width) * box.width, (open.top + open.height) * box.height];
      const within = (r) => r[0] >= view[0] && r[1] >= view[1] && r[2] <= view[2] && r[3] <= view[3];
      const done = new Set();
      for (const i of order) {
        if (i == null || done.has(i)) continue;
        done.add(i);
        if (revealing && i === this.hovered) continue;
        const el = elements[i];
        if (!el) continue;
        if (!wanted(i)) { el.style.display = "none"; continue; }
        const at = screen[i];
        const forced = i === selected;
        let form = forced || this.names !== "short" ? "full" : "short";
        let rect = rectOf(at, form === "full" ? el.box ?? [0, 0] : el.boxShort ?? el.box ?? [0, 0], i);
        if (!forced && !free(rect) && form === "full") { form = "short"; rect = rectOf(at, el.boxShort ?? el.box ?? [0, 0], i); }
        if (!forced && !free(rect)) { el.style.display = "none"; continue; }
        taken.add(rect);
        placed.push([i, form, rect]);
      }
      for (const [i, form, rect] of placed) {
        const el = elements[i];
        let shown = form;
        if (form === "short" && this.names === "short") {
          const full = rectOf(screen[i], el.box ?? [0, 0], i);

          if (free(full, rect) && (within(full) || !within(rect))) { rect.splice(0, 4, ...full); taken.add(rect); shown = "full"; }
        }
        if (el.dataset.name !== shown) el.dataset.name = shown;
        if (arriving && arriving.has(i)) el.style.opacity = fade;
        const [x, y] = screen[i];
        showAt(el, `translate(-50%, 0) translate(${x}px, ${y + dropOf(i)}px)`);
      }
      this.drawnNames = new Set(placed.map(([i]) => i));

      const shown = elements[this.hovered];
      if (revealing && shown && wanted(this.hovered)) {
        const i = this.hovered;
        const rect = rectOf(screen[i], shown.box ?? [0, 0], i);
        if (shown.dataset.name !== "full") shown.dataset.name = "full";
        showAt(shown, `translate(-50%, 0) translate(${screen[i][0]}px, ${screen[i][1] + dropOf(i)}px)`);
        placed.push([i, "full", rect]);
      } else if (revealing && shown) shown.style.display = "none";

      this.shownNames = placed.map(([i, , rect]) => [i, rect]);

      this.markName("selected", elements[selected] ?? null);
    }

    this.layoutClusterLabels(clusters);
    this.drawRoutes(routes, radius);
    this.layoutLinkLabels(links, screen, radius);
    this.layoutRings(rings, screen, radius);
    this.layoutOwned(owned, screen, radius);
    this.layoutIcons(icons, screen, radius);
    this.layoutReticles(reticles, screen, radius, selected);
  }

  layoutReticles(reticles, screen, radius, selected) {
    if (!reticles) return;
    const dot = radius * 2;
    const gap = clamp(dot * RING_GAP[0], RING_GAP[1], RING_GAP[2]);
    const corners = (dot + gap) / 0.96;

    const outside = (dot + 4 * gap) / 0.96;
    const place = (el, index, reach = 0, selecting = false) => {
      if (!el) return;
      const at = index === null || index === undefined ? null : screen[index];
      if (!at) { el.style.display = "none"; return; }
      let size = this.tierZero[index] ? corners + (outside - corners) * reach : corners;
      if (selecting) this.selectRing = size / 2;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.setProperty("--rw", `${(RETICLE_STROKE * 100) / size}`);
      showAt(el, `translate(-50%, -50%) translate(${at[0]}px, ${at[1]}px)`);
    };

    const hovered = this.hovered ?? this.hoverShown ?? null;
    place(reticles.hover, hovered === selected ? null : hovered);
    place(reticles.select, selected, this.reach, true);

    const members = [];
    if (this.group.size > 1) for (const i of this.groupIndices()) if (i !== selected) members.push(i);
    const caught = this.caught ? [...this.caught] : [];
    const need = members.length + caught.length;
    const layer = reticles.group;
    while (layer && this.rings.length < need) {
      const el = reticles.select.cloneNode(true);
      el.removeAttribute("style");
      el.firstElementChild.removeAttribute("style");
      el.classList.remove("reticle--select");
      layer.append(el);
      this.rings.push(el);
    }
    this.rings.forEach((el, n) => {
      if (n >= need) { el.style.display = "none"; return; }
      const member = n < members.length;
      el.classList.toggle("reticle--member", member);
      el.classList.toggle("reticle--caught", !member);
      el.firstElementChild.setAttribute("rx", member ? "48" : "0");
      el.firstElementChild.style.strokeDasharray = member ? RETICLE_CLOSED : RETICLE_HOVER;
      place(el, member ? members[n] : caught[n - members.length], member ? 1 : 0);
    });
  }

  markName(role, el) {
    const key = `${role}Name`;
    if (this[key] === el) return;
    this[key]?.classList.remove(`node-label--${role}`);
    el?.classList.add(`node-label--${role}`);
    this[key] = el;
  }

  layoutClusterLabels(elements) {
    if (!elements) return;

    const named = this.clusters.length > 0;

    elements.forEach((el, i) => {
      const cluster = named ? this.clusters[i] : null;
      if (!el || !cluster) { if (el) el.style.display = "none"; return; }

      const left = this.graph.spaceToScreenPosition([cluster.x - cluster.w / 2, cluster.y]);
      const right = this.graph.spaceToScreenPosition([cluster.x + cluster.w / 2, cluster.y]);
      const at = this.graph.spaceToScreenPosition([cluster.x, cluster.y]);
      if (!left || !right || !at) { el.style.display = "none"; return; }
      const width = Math.abs(right[0] - left[0]);
      if (width < CLUSTER_MIN_PX * this.ui) { el.style.display = "none"; return; }

      el.style.fontSize =
        `${clamp(width * CLUSTER_LABEL[0], CLUSTER_LABEL[1], CLUSTER_LABEL[2])}px`;
      showAt(el, `translate(-50%, -50%) translate(${at[0]}px, ${at[1]}px)`);
    });
  }

  dropRoutes() {
    if (!this.routes) return;
    this.routes = null;
    this.wake();
  }

  drawRoutes(canvas, radius) {
    if (!canvas) return;

    const show = (Boolean(this.routes) || this.links.length <= PORTS_MAX) && this.count > 0;
    if (show !== this.routesShown) {
      this.routesShown = show;
      this.graph.setConfigPartial({ renderLinks: !show });
      canvas.style.display = show ? "block" : "none";

      if (!show) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }
    if (!show) return;

    const width = this.scene.clientWidth, height = this.scene.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const o = this.graph.spaceToScreenPosition([CENTER, CENTER]);
    const u = this.graph.spaceToScreenPosition([CENTER + 1000, CENTER + 1000]);
    if (!o || !u) return;
    const sx = (u[0] - o[0]) / 1000, sy = (u[1] - o[1]) / 1000;
    const toScreen = (x, y) => [o[0] + (x - CENTER) * sx, o[1] + (y - CENTER) * sy];
    const scale = Math.abs(sx);
    const lineWidth = Math.max(LINK_MIN, (this.linkSpace ?? 1) * scale);
    const head = Math.max(4, (this.arrowSpace ?? 6) * scale);

    this.headPx = head;
    this.edgeColor ??= rgba(token("--edge"));
    this.textColor ??= rgba(token("--fg"));
    const [r, g, b] = this.edgeColor.map((v) => Math.round(v * 255));
    const [fr, fg, fb] = this.textColor.map((v) => Math.round(v * 255));

    const lit = this.press?.kind === "slide" ? this.press.link : this.slideHover;
    const positions = this.currentPositions();

    const moving = Boolean(this.from);
    const bendsOf = (k) => {
      const bends = this.routes?.[k];
      if (!bends || !moving) return bends ?? null;
      if (bends.length !== 4) return null;
      const s0 = this.links[k].source * 2, t0 = this.links[k].target * 2, to = this.positions;
      return [positions[s0] + bends[0] - to[s0], positions[s0 + 1] + bends[1] - to[s0 + 1],
        positions[t0] + bends[2] - to[t0], positions[t0 + 1] + bends[3] - to[t0 + 1]];
    };

    const arriving = this.arriving;
    const fade = arriving ? this.arrivalFade() : 1;
    const grown = arriving ? clamp(this.progress, 0, 1) : 1;
    const arrives = (link) => Boolean(arriving) && (arriving.has(link.source) || arriving.has(link.target));
    const radiusOf = (i) => (arriving?.has(i) ? radius * grown : radius);
    const mids = (this.routeMids ??= []);
    mids.length = this.links.length;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";

    const screenAt = (i) => toScreen(positions[i * 2], positions[i * 2 + 1]);
    const ports = new Float64Array(this.links.length * 2).fill(NaN);
    if (this.links.length <= PORTS_MAX && radius > 2) {
      const around = new Map();
      const add = (i, angle, slot) => { (around.get(i) ?? around.set(i, []).get(i)).push([angle, slot]); };
      this.links.forEach((link, k) => {
        if (link.source === link.target || (arrives(link) && fade <= 0)) return;
        const a = screenAt(link.source), b = screenAt(link.target);
        const bowed = this.twin[k] !== -1;

        const bends = bowed ? null : bendsOf(k);
        const ctrl = bowed ? controlOf(a, b, bowOf(Math.hypot(b[0] - a[0], b[1] - a[1]), head)) : null;
        const next = ctrl ?? (bends ? toScreen(bends[0], bends[1]) : b);
        const prev = ctrl ?? (bends ? toScreen(bends[bends.length - 2], bends[bends.length - 1]) : a);
        add(link.source, Math.atan2(next[1] - a[1], next[0] - a[0]), k * 2);
        add(link.target, Math.atan2(prev[1] - b[1], prev[0] - b[0]), k * 2 + 1);
      });
      const want = (head * 0.9) / radius;
      for (const list of around.values()) {
        if (list.length < 2) { for (const [angle, slot] of list) ports[slot] = angle; continue; }
        list.sort((x, y) => x[0] - y[0]);

        let gapAt = 0, widest = -1;
        for (let n = 0; n < list.length; n += 1) {
          const gap = n + 1 < list.length ? list[n + 1][0] - list[n][0] : list[0][0] + Math.PI * 2 - list[n][0];
          if (gap > widest) { widest = gap; gapAt = (n + 1) % list.length; }
        }
        const ring = list.slice(gapAt).concat(list.slice(0, gapAt));
        const angles = ring.map(([angle]) => angle);
        for (let n = 1; n < angles.length; n += 1) while (angles[n] < angles[n - 1]) angles[n] += Math.PI * 2;
        const span = angles[angles.length - 1] - angles[0];
        const step = Math.min(want, (span + 2 * PORT_TURN) / (angles.length - 1), (Math.PI * 1.8) / angles.length);
        const bv = [], bw = [], bn = [];
        angles.forEach((angle, n) => {
          let v = angle - n * step, w = 1, c = 1;
          while (bv.length && bv[bv.length - 1] > v) { const pv = bv.pop(), pw = bw.pop(); v = (v * w + pv * pw) / (w + pw); w += pw; c += bn.pop(); }
          bv.push(v); bw.push(w); bn.push(c);
        });
        let n = 0;
        for (let q = 0; q < bv.length; q += 1) for (let r2 = 0; r2 < bn[q]; r2 += 1) { ports[ring[n][1]] = bv[q] + n * step; n += 1; }
      }
    }
    const portOf = (slot, centre, r) => (Number.isNaN(ports[slot]) ? null
      : [centre[0] + Math.cos(ports[slot]) * r, centre[1] + Math.sin(ports[slot]) * r]);

    this.links.forEach((link, k) => {
      mids[k] = null;
      if (link.source === link.target) return;
      const bowed = this.twin[k] !== -1;
      const coming = arrives(link);
      if (coming && fade <= 0) return;
      const pts = [toScreen(positions[link.source * 2], positions[link.source * 2 + 1])];

      const bends = bowed ? null : bendsOf(k);
      if (bends) for (let q = 0; q < bends.length; q += 2) pts.push(toScreen(bends[q], bends[q + 1]));
      pts.push(toScreen(positions[link.target * 2], positions[link.target * 2 + 1]));

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      if (maxX < -50 || minX > width + 50 || maxY < -50 || minY > height + 50) return;

      const trim = (from, to, by) => {
        const dx = to[0] - from[0], dy = to[1] - from[1], d = Math.hypot(dx, dy) || 1;
        return [from[0] + (dx / d) * Math.min(by, d * 0.9), from[1] + (dy / d) * Math.min(by, d * 0.9)];
      };
      const n = pts.length - 1;
      const rs = radiusOf(link.source), rt = radiusOf(link.target);

      if (Math.hypot(pts[n][0] - pts[0][0], pts[n][1] - pts[0][1]) < rs + rt + head) return;

      const ctrl = bowed ? controlOf(pts[0], pts[n], bowOf(Math.hypot(pts[n][0] - pts[0][0], pts[n][1] - pts[0][1]), head)) : null;
      const from = portOf(k * 2, pts[0], rs), to = portOf(k * 2 + 1, pts[n], rt);
      pts[0] = from ?? trim(pts[0], ctrl ?? pts[1], rs);
      const tip = to ?? trim(pts[n], ctrl ?? pts[n - 1], rt);
      const tail = trim(tip, ctrl ?? pts[n - 1], head);

      const near = !this.related || (this.related[link.source] && this.related[link.target]);
      const alpha = LINK_OPACITY * (near ? 1 : UNRELATED) * (coming ? fade : 1);
      const paint = this.paintOf(k);
      const on = k === lit || paint !== null;
      const [pr, pg, pb] = paint ? this.paintColor(paint).map((v) => Math.round(v * 255)) : [fr, fg, fb];
      ctx.strokeStyle = ctx.fillStyle = on ? `rgb(${pr},${pg},${pb})` : `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = on ? Math.max(1.5, lineWidth * 2) : lineWidth;

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (ctrl) ctx.quadraticCurveTo(ctrl[0], ctrl[1], tail[0], tail[1]);
      else {
        for (let q = 1; q < n; q += 1) ctx.lineTo(pts[q][0], pts[q][1]);
        ctx.lineTo(tail[0], tail[1]);
      }
      ctx.stroke();

      const dx = tip[0] - tail[0], dy = tip[1] - tail[1], d = Math.hypot(dx, dy) || 1;
      const wx = (-dy / d) * head * 0.5, wy = (dx / d) * head * 0.5;
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(tail[0] + wx, tail[1] + wy);
      ctx.lineTo(tail[0] - wx, tail[1] - wy);
      ctx.closePath();
      ctx.fill();

      let best = 1, longest = -1;
      for (let q = 1; q < pts.length; q += 1) {
        const len = Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
        if (len > longest) { longest = len; best = q; }
      }
      mids[k] = [pts[best - 1], pts[best]];
    });
  }

  layoutLinkLabels(elements, screen, radius) {
    if (!elements) return;

    const show = this.links.length <= LINK_LABEL_MAX;
    elements.forEach((el, k) => {
      if (!el) return;
      const link = show ? this.links[k] : null;

      const bowed = this.twin[k] !== -1;
      const mid = this.routesShown && !bowed ? this.routeMids?.[k] : null;
      const a = mid ? mid[0] : link && screen[link.source];
      const b = mid ? mid[1] : link && screen[link.target];
      if (!link || !a || !b) { el.style.display = "none"; return; }

      const opacity = this.arriving && (this.arriving.has(link.source) || this.arriving.has(link.target))
        ? String(this.arrivalFade()) : "";
      if (el.style.opacity !== opacity) el.style.opacity = opacity;
      let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const flipped = angle > Math.PI / 2 || angle <= -Math.PI / 2;
      if (flipped) angle += angle > 0 ? -Math.PI : Math.PI;

      const key = `${this.label}|${el.textContent}`;
      if (el.measured !== key) {
        el.style.display = "block";
        el.measured = key;
        el.half = [el.offsetWidth / 2, el.offsetHeight / 2];
      }

      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      if (bowed && this.routesShown) {

        const head = Math.max(4, (this.arrowSpace ?? 6) * (this.pointScale ?? 1));
        const dx = b[0] - a[0], dy = b[1] - a[1], d = length || 1;
        const h = bowOf(length, head) / 2;
        cx -= (dy / d) * h; cy += (dx / d) * h;
      }
      let nx = b[1] - a[1], ny = a[0] - b[0];
      const norm = Math.hypot(nx, ny) || 1;
      const side = ny > 0 || (ny === 0 && nx < 0) ? -1 : 1;
      nx *= side / norm; ny *= side / norm;
      cx += nx * (el.half[1] + 2); cy += ny * (el.half[1] + 2);
      showAt(el, `translate(-50%, -50%) translate(${cx}px, ${cy}px) rotate(${angle}rad)`);
    });
  }

  layoutIcons(elements, screen, radius) {
    if (!elements) return;
    const size = radius * 2 * ICON_SHARE;
    const legible = size >= ICON_MIN_PX * this.ui;

    if (legible !== this.iconsLegible) {
      this.iconsLegible = legible;
      this.handlers.onIconsLegible?.(legible);

      this.highlight(this.selectedIndex);
    }

    if (legible && size !== this.iconSizedAt) {
      this.iconSizedAt = size;
      this.scene.style.setProperty("--icon-size", `${size}px`);
    }

    if (!legible) {
      if (this.iconsHidden) return;
      this.iconsHidden = true;
      for (const el of elements) if (el) el.style.display = "none";
      return;
    }
    this.iconsHidden = false;

    const related = this.related;

    const arriving = this.arriving;
    const grow = arriving ? ` scale(${this.from ? this.progress : 0})` : "";
    elements.forEach((el, i) => {
      if (!el) return;
      const at = screen[i];
      if (!at) { el.style.display = "none"; return; }
      el.style.opacity = !related || related[i] ? "" : String(UNRELATED);
      showAt(el, `translate(-50%, -50%) translate(${at[0]}px, ${at[1]}px)`
        + (arriving && arriving.has(i) ? grow : ""));
    });
  }

  layoutRings(elements, screen, radius) {
    const dot = radius * 2;
    const size = dot + 2 * clamp(dot * RING_GAP[0], RING_GAP[1], RING_GAP[2]);
    const width = clamp(dot * RING_WIDTH[0], RING_WIDTH[1], RING_WIDTH[2]);
    this.placeMarks(elements, screen, radius, "tierZeroHidden", (el, at) => {
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderWidth = `${width}px`;
      showAt(el, `translate(-50%, -50%) translate(${at[0]}px, ${at[1]}px)`);
    });
  }

  layoutOwned(elements, screen, radius) {
    const size = clamp(radius * 2 * OWNED_FLAG[0], OWNED_FLAG[1], OWNED_FLAG[2]);
    this.placeMarks(elements, screen, radius, "ownedHidden", (el, at) => {
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;

      showAt(el, `translate(${at[0] + radius * 0.47}px, ${at[1] - radius * 1.22}px)`);
    });
  }

  placeMarks(elements, screen, radius, hidden, place) {
    if (!elements) return;
    if (radius * 2 < RING_MIN_PX * this.ui) {
      if (this[hidden]) return;
      this[hidden] = true;
      for (const el of elements) if (el) el.style.display = "none";
      return;
    }
    this[hidden] = false;
    const arriving = this.arriving;
    const fade = arriving ? String(this.arrivalFade()) : "";
    elements.forEach((el, i) => {
      if (!el) return;
      const at = screen[i];
      if (!at) { el.style.display = "none"; return; }
      if (arriving && arriving.has(i)) el.style.opacity = fade;
      place(el, at);
    });
  }

  resizeLabels(px) {
    const size = Math.round(px * 4) / 4;
    if (size === this.label) return;
    this.label = size;
    this.scene.style.setProperty("--label-size", `${size}px`);
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    cancelAnimationFrame(this.pump);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.entrance);
    cancelAnimationFrame(this.press?.frame ?? 0);
    this.pump = 0;
    this.frame = 0;
    this.entrance = 0;
    this.press = null;
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    window.removeEventListener("resize", this.onResize);
    this.whenSized.disconnect();
    this.host.removeEventListener("contextmenu", this.onContext, true);
    this.host.removeEventListener("pointerdown", this.onDown, true);
    this.host.removeEventListener("mousedown", this.onMouseDown, true);
    this.host.removeEventListener("pointermove", this.onMove);
    this.host.removeEventListener("pointerup", this.onUp);
    this.host.removeEventListener("pointercancel", this.onUp);
    this.scene.removeEventListener("selectstart", this.onSelectStart);
    this.scene.removeEventListener("pointerdown", this.onScenePress, true);
    this.scene.removeEventListener("mousedown", this.onSceneMouseDown, true);
    this.scene.removeEventListener("pointermove", this.onSceneMove);
    this.scene.removeEventListener("pointerleave", this.onSceneLeave);
    window.removeEventListener("keydown", this.onKey);
    this.scene.removeEventListener("pointerover", this.onNameOver);
    this.scene.removeEventListener("pointerout", this.onNameOut);
    this.scene.removeEventListener("click", this.onNameClick);
    this.scene.removeEventListener("wheel", this.onNameWheel);
    this.fade?.stop();
    this.ring?.stop();
    this.graph.destroy();
  }
}

function rgba(value) {
  const hex = (value || "").trim().replace("#", "");
  if (hex.length !== 6) return [1, 1, 1];
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function twinsOf(links, count) {
  const twin = new Int32Array(links.length).fill(-1);
  const first = new Map();
  links.forEach((l, k) => {
    if (l.source === l.target) return;
    const key = Math.min(l.source, l.target) * count + Math.max(l.source, l.target);
    const seen = first.get(key);
    if (seen === undefined) { first.set(key, k); return; }
    if (twin[seen] !== -1) return;
    twin[seen] = k;
    twin[k] = seen;
  });
  return twin;
}

const BOW = 0.09;
const BOW_MAX = 36;

const BOW_STEPS = 8;
const bowOf = (length, head) => clamp(length * BOW, head, BOW_MAX);

function controlOf(a, b, h) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
  return [(a[0] + b[0]) / 2 - (dy / d) * h, (a[1] + b[1]) / 2 + (dx / d) * h];
}

function showAt(el, transform) {
  el.style.display = "block";
  el.style.visibility = "visible";
  el.style.transform = transform;
}

function labelPriority(nodes, links) {
  const degree = new Int32Array(nodes.length);
  for (const { source, target } of links) { degree[source] += 1; degree[target] += 1; }
  const rank = (n) => (n.tierZeroSeed || n.tierZero ? 2 : 0) + (n.owned ? 1 : 0);
  return nodes.map((_, i) => i).sort((a, b) => rank(nodes[b]) - rank(nodes[a])
    || degree[b] - degree[a] || (nodes[a].label ?? "").length - (nodes[b].label ?? "").length);
}

class NameGrid {
  constructor(cell = 96) { this.cell = cell; this.buckets = new Map(); }
  *cells([x0, y0, x1, y1]) {
    const c = this.cell;
    for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx += 1)
      for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy += 1) yield `${gx},${gy}`;
  }

  hits(r, except = null) {
    for (const k of this.cells(r)) {
      for (const o of this.buckets.get(k) ?? []) {
        if (o !== except && r[0] < o[2] && o[0] < r[2] && r[1] < o[3] && o[1] < r[3]) return true;
      }
    }
    return false;
  }
  add(r) {
    for (const k of this.cells(r)) {
      const list = this.buckets.get(k);
      if (list) list.push(r); else this.buckets.set(k, [r]);
    }
  }
}

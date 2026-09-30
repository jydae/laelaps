import { count } from "../../core/index.js";
import { html, useLayoutEffect, useRef, useState, Button, StatusTag } from "../../ui/index.js";

const KIND = { SameForestTrust: "same forest", CrossForestTrust: "cross-forest" };
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

export function plan({ db, census, databases, pairs }) {
  const here = census?.domains ?? [];
  const held = new Set(here.map((d) => d.id));
  const trusts = census?.trusts ?? [];
  const pairOf = (other) => pairs.find((p) => (p.a === db.id && p.b === other) || (p.b === db.id && p.a === other));
  const groups = new Map();
  const group = (key, init) => {
    if (!groups.has(key)) groups.set(key, { key, domains: new Map(), ...init() });
    return groups.get(key);
  };

  const inside = [];
  const outside = [];
  for (const t of trusts) {
    const localFrom = held.has(t.from), localTo = held.has(t.to);
    if (localFrom && localTo) { inside.push(t); continue; }
    if (!localFrom && !localTo) continue;
    const far = localFrom ? { id: t.to, label: t.toLabel } : { id: t.from, label: t.fromLabel };
    const near = localFrom ? t.from : t.to;

    const holders = databases.filter((d) => d.id !== db.id && d.domains.some((x) => x.id === far.id));
    const holder = holders.find((d) => d.sources.includes(db.id))
      ?? holders.find((d) => pairOf(d.id)) ?? holders[0];
    const g = holder
      ? group(holder.id, () => ({ database: holder, pair: pairOf(holder.id), merged: holder.sources.includes(db.id) }))
      : group("", () => ({ database: null, pair: null, merged: false }));
    g.domains.set(far.id, { ...far, meta: `${KIND[t.kind] ?? t.kind}, ${t.bidirectional ? "two-way" : "one-way"}` });

    outside.push({ near, far: far.id, key: g.key, both: t.bidirectional, outward: localFrom, kind: t.kind });
  }

  for (const p of pairs) {
    const other = p.a === db.id ? p.b : p.b === db.id ? p.a : null;
    const database = other && databases.find((d) => d.id === other);
    if (database) group(other, () => ({ database, pair: p, merged: false }));
  }

  const order = (g) => (g.database ? (g.pair ? 0 : g.merged ? 1 : 2) : 3);
  return {
    here, inside, outside,
    groups: [...groups.values()].sort((a, b) => order(a) - order(b)),
  };
}

function measure(root) {
  if (!root) return null;
  const origin = root.getBoundingClientRect();
  const at = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - origin.left, right: r.right - origin.left, mid: r.top - origin.top + r.height / 2 };
  };
  const find = (selector) => root.querySelector(selector);
  return { width: origin.width, height: origin.height, at, find };
}

function Links({ layout, stamp }) {
  const svg = useRef(null);
  const [paths, setPaths] = useState({ width: 0, height: 0, lines: [] });
  useLayoutEffect(() => {
    const root = svg.current?.parentElement;
    const draw = () => {
      const m = measure(root);
      if (!m) return;
      const lines = [];
      const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : s);
      for (const [i, link] of layout.outside.entries()) {
        const a = m.find(`[data-near="${esc(link.near)}"]`);
        const b = m.find(`[data-far="${esc(link.key)}|${esc(link.far)}"]`);
        if (!a || !b) continue;

        const from = m.at(a), to = m.at(b);
        const x1 = m.at(a.closest(".map-card")).right, x2 = m.at(b.closest(".map-card")).left;
        const bend = (x2 - x1) / 2;
        lines.push({
          key: `t${i}`, d: `M${x1} ${from.mid} C${x1 + bend} ${from.mid} ${x2 - bend} ${to.mid} ${x2} ${to.mid}`,
          missing: !link.key, start: link.both || !link.outward, end: link.both || link.outward,
        });
      }

      for (const [i, t] of layout.inside.entries()) {
        const a = m.find(`[data-near="${esc(t.from)}"]`), b = m.find(`[data-near="${esc(t.to)}"]`);
        if (!a || !b) continue;
        const p = m.at(a), q = m.at(b), x = Math.min(p.left, q.left) - 2;
        lines.push({
          key: `i${i}`, d: `M${x} ${p.mid} C${x - 14} ${p.mid} ${x - 14} ${q.mid} ${x} ${q.mid}`,
          inner: true, start: t.bidirectional, end: true,
        });
      }
      setPaths({ width: m.width, height: m.height, lines });
    };
    draw();
    const observer = new ResizeObserver(draw);
    if (root) observer.observe(root);
    return () => observer.disconnect();
  }, [stamp]);

  return html`<svg ref=${svg} className="map-links" width=${paths.width} height=${paths.height} aria-hidden="true">
    <defs>
      <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0.5L7.5 4L0 7.5" />
      </marker>
    </defs>
    ${paths.lines.map((l) => html`<path key=${l.key} d=${l.d}
      className=${"map-link" + (l.missing ? " map-link--missing" : "") + (l.inner ? " map-link--inner" : "")}
      markerStart=${l.start ? "url(#map-arrow)" : undefined} markerEnd=${l.end ? "url(#map-arrow)" : undefined} />`)}
  </svg>`;
}

const Chip = ({ label, meta, dataset, missing, title }) => html`<div
  className=${"map-chip" + (missing ? " map-chip--missing" : "")} title=${title} ...${dataset}>
  <span className="map-chip-name">${label}</span>
  ${meta && html`<span className="map-chip-meta">${meta}</span>`}
</div>`;

function Group({ g, busy, onMerge, onSelect }) {
  const domains = [...g.domains.values()];
  if (!g.database) {
    return html`<div className="map-card map-card--missing">
      <div className="map-card-head">
        <span className="map-card-title">Not collected</span>
        <span className="map-card-note">in any database of this project</span>
      </div>
      <div className="map-chips">
        ${domains.map((d) => html`<${Chip} key=${d.id} label=${d.label} missing title=${d.id}
          meta=${d.meta} dataset=${{ "data-far": `|${d.id}` }} />`)}
      </div>
    </div>`;
  }
  return html`<div className=${"map-card" + (g.pair ? " map-card--offer" : "")}>
    <div className="map-card-head">
      <button type="button" className="map-card-title ing-link" title=${`Open ${g.database.name}`}
        onClick=${() => onSelect(g.database.id)}>${g.database.name}</button>
      ${g.pair && html`<${Button} small text="Merge" disabled=${busy} onClick=${() => onMerge(g.pair)} />`}
      ${!g.pair && g.merged && html`<${StatusTag} tone="ok">Merged<//>`}
    </div>
    <div className="map-card-note">${g.pair
      ? `Merging resolves ${plural(g.pair.resolves, "reference")}${g.pair.overlapping ? ". Same domain: the newer collection wins" : ""}`
      : g.merged ? "Already holds this database's data" : "Holds the domains these trusts reach"}</div>
    ${domains.length > 0 && html`<div className="map-chips">
      ${domains.map((d) => html`<${Chip} key=${d.id} label=${d.label} title=${d.id}
        meta=${d.meta} dataset=${{ "data-far": `${g.key}|${d.id}` }} />`)}
    </div>`}
  </div>`;
}

export function DomainMap({ db, census, databases, pairs, busy, onMerge, onSelect }) {
  const layout = plan({ db, census, databases, pairs });
  const stamp = JSON.stringify([db.id, census?.computed, layout.groups.map((g) => [g.key, [...g.domains.keys()]]), pairs.length]);

  if (layout.here.length === 0) {
    return html`<p className="map-empty">${db.analysisError
      ? "The last analysis did not finish, so this database's domains and trusts are not known."
      : db.analyzed
        ? "No domain was found by the last analysis of this database."
        : "Domains, trusts and merges are drawn when the analysis finishes."}</p>`;
  }
  const inbound = new Set(layout.inside.flatMap((t) => [t.from, t.to]));

  return html`<div className="map">
    <${Links} layout=${layout} stamp=${stamp} />
    <div className="map-col">
      <div className="map-card map-card--here">
        <div className="map-card-head">
          <span className="map-card-title" title=${db.name}>${db.name}</span>
          <span className="map-card-note">this database</span>
        </div>
        ${db.sources.length > 0 && html`<div className="map-card-note">Merged from ${db.sources
          .map((id) => databases.find((d) => d.id === id)?.name ?? "a deleted database").join(" + ")}</div>`}
        <div className=${"map-chips" + (inbound.size > 0 ? " map-chips--linked" : "")}>
          ${layout.here.map((d) => html`<${Chip} key=${d.id} label=${d.label} title=${d.id}
            meta=${`${plural(d.objects, "object")}, ${count(d.tierZero)} Tier Zero`}
            dataset=${{ "data-near": d.id }} />`)}
        </div>
      </div>
    </div>
    <div className="map-col">
      ${layout.groups.length === 0
        ? html`<p className="map-empty">${layout.inside.length > 0
          ? "Every trust ends at a domain this database holds. Nothing to merge."
          : "No trusts reported, and no other database fills in this one's references."}</p>`
        : layout.groups.map((g) => html`<${Group} key=${g.key || "none"} g=${g} busy=${busy}
          onMerge=${onMerge} onSelect=${onSelect} />`)}
    </div>
  </div>`;
}

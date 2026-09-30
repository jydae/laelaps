import { clamp } from "../../core/index.js";

export const FOOTPRINT = Object.freeze({ dot: 0.4, drawn: 2, label: 0.9, drop: 1.15, char: 0.63, line: 1.2 });

const RADIUS = (FOOTPRINT.dot * FOOTPRINT.drawn) / 2;
const FONT = FOOTPRINT.dot * FOOTPRINT.label;
const AIR = 0.35;
const LINK_AIR = 0.3;
const LANE = 0.1;
const LANE_AIR = 0.22;
const LAYER_AIR = 1.1;
const STEEP = Math.tan((Math.PI * 13) / 36);
const PASS_BY = 0.9;
const PART_AIR = 2.4;
const LONG_COLUMN = 80;
const SIFT_MAX = 6000;
const FAN_ANGLE = 0.045;
const FAN_MOST = 3;
const TWIN = 0.14;

export function shortName(label, kind) {
  const s = String(label ?? "");
  if (kind === "Domain") return s;
  const at = s.indexOf("@");
  if (at > 0) return s.slice(0, at);
  if (kind === "Computer") { const dot = s.indexOf("."); if (dot > 0) return s.slice(0, dot); }
  return s;
}

export function footprints(count, labels, G) {
  const left = new Float64Array(count), right = new Float64Array(count);
  const up = new Float64Array(count), down = new Float64Array(count);
  const box = new Float64Array(count * 4);
  const r = RADIUS * G, drop = RADIUS * FOOTPRINT.drop * G, tall = FONT * FOOTPRINT.line * G;
  for (let i = 0; i < count; i += 1) {
    const w = String(labels?.[i] ?? "").length * FONT * FOOTPRINT.char * G;
    left[i] = right[i] = Math.max(r, w / 2); up[i] = r; down[i] = drop + tall;
    box.set([-w / 2, drop, w / 2, drop + tall], i * 4);
  }
  return { left, right, up, down, box, radius: r, G };
}

export function split(count, links) {
  const seen = new Set();
  const edges = [];
  for (const l of links) {
    const s = l.source, t = l.target;
    if (s === t || s < 0 || t < 0 || s >= count || t >= count) continue;
    const key = s * count + t;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ s, t });
  }
  const adj = Array.from({ length: count }, () => []);
  for (const e of edges) { adj[e.s].push(e.t); adj[e.t].push(e.s); }
  const part = new Int32Array(count).fill(-1);
  const parts = [], lone = [];
  for (let i = 0; i < count; i += 1) {
    if (part[i] >= 0) continue;
    if (adj[i].length === 0) { lone.push(i); part[i] = -2; continue; }
    const members = [i];
    part[i] = parts.length;
    for (let k = 0; k < members.length; k += 1) {
      for (const j of adj[members[k]]) if (part[j] === -1) { part[j] = parts.length; members.push(j); }
    }
    parts.push({ members, edges: [] });
  }
  for (const e of edges) parts[part[e.s]].edges.push(e);
  parts.sort((a, b) => b.members.length - a.members.length || a.members[0] - b.members[0]);
  return { parts, lone, edges, adj };
}

function flowColumns(members, edges) {
  const outs = new Map(members.map((i) => [i, []])), ins = new Map(members.map((i) => [i, []]));
  for (const e of edges) { outs.get(e.s).push(e.t); ins.get(e.t).push(e.s); }
  const left = new Set(members);
  const outDeg = new Map(), inDeg = new Map();
  for (const i of members) { outDeg.set(i, outs.get(i).length); inDeg.set(i, ins.get(i).length); }
  const head = [], tail = [];
  const drop = (i) => {
    left.delete(i);
    for (const j of outs.get(i)) if (left.has(j)) inDeg.set(j, inDeg.get(j) - 1);
    for (const j of ins.get(i)) if (left.has(j)) outDeg.set(j, outDeg.get(j) - 1);
  };
  while (left.size > 0) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const i of [...left]) {
        if (outDeg.get(i) === 0) { tail.unshift(i); drop(i); moved = true; }
        else if (inDeg.get(i) === 0) { head.push(i); drop(i); moved = true; }
      }
    }
    if (left.size === 0) break;
    let best = null, score = -Infinity;
    for (const i of left) { const d = outDeg.get(i) - inDeg.get(i); if (d > score) { score = d; best = i; } }
    head.push(best); drop(best);
  }
  const sequence = [...head, ...tail];
  const rank = new Map(sequence.map((i, k) => [i, k]));
  const succ = new Map(members.map((i) => [i, []])), pred = new Map(members.map((i) => [i, []]));
  for (const e of edges) {
    const [a, b] = rank.get(e.s) < rank.get(e.t) ? [e.s, e.t] : [e.t, e.s];
    succ.get(a).push(b); pred.get(b).push(a);
  }
  const col = new Map(members.map((i) => [i, 0]));
  for (const i of sequence) for (const j of succ.get(i)) col.set(j, Math.max(col.get(j), col.get(i) + 1));

  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const i of sequence) {
      const p = pred.get(i), s = succ.get(i);
      const lo = p.length ? Math.max(...p.map((j) => col.get(j))) + 1 : -Infinity;
      const hi = s.length ? Math.min(...s.map((j) => col.get(j))) - 1 : Infinity;
      let want = col.get(i);
      if (p.length > s.length) want = lo;
      else if (s.length > p.length) want = hi;
      if (!Number.isFinite(want)) continue;
      want = Math.max(Number.isFinite(lo) ? lo : want, Math.min(Number.isFinite(hi) ? hi : want, want));
      if (want !== col.get(i)) { col.set(i, want); changed = true; }
    }
    if (!changed) break;
  }
  return { col, rank };
}

function treeColumns(members, adj, root) {
  const inPart = new Set(members);
  if (root == null || !inPart.has(root)) {
    root = members[0];
    for (const i of members) if (adj[i].length > adj[root].length || (adj[i].length === adj[root].length && i < root)) root = i;
  }
  const col = new Map([[root, 0]]);
  const rank = new Map([[root, 0]]);
  const queue = [root];
  for (let h = 0; h < queue.length; h += 1) {
    const i = queue[h];
    for (const j of adj[i]) if (inPart.has(j) && !col.has(j)) { col.set(j, col.get(i) + 1); rank.set(j, queue.length); queue.push(j); }
  }
  return { col, rank };
}

function unlineColumns(members, adj, col, rank) {
  const byCol = new Map();
  for (const i of members) (byCol.get(col.get(i)) ?? byCol.set(col.get(i), []).get(col.get(i))).push(i);
  const keys = [...byCol.keys()].sort((a, b) => a - b);
  const out = new Map();
  const from = [];
  let next = 0;
  for (const c of keys) {
    const group = byCol.get(c).sort((a, b) => rank.get(a) - rank.get(b));
    const sub = new Map();
    let height = 1;
    for (const i of group) {
      let s = 0;
      for (const j of adj[i]) if (sub.has(j) && col.get(j) === c) s = Math.max(s, sub.get(j) + 1);
      sub.set(i, s);
      height = Math.max(height, s + 1);
    }
    for (const i of group) out.set(i, next + sub.get(i));
    for (let k = 0; k < height; k += 1) from.push(c);
    next += height;
  }
  return { col: out, from };
}

const AXES = {
  right: { at: (a, c) => [a, c], ext: (l, r, u, d) => [l, r, u, d], box: (x0, y0, x1, y1) => [x0, x1, y0, y1] },
  left: { at: (a, c) => [-a, c], ext: (l, r, u, d) => [r, l, u, d], box: (x0, y0, x1, y1) => [-x1, -x0, y0, y1] },
  down: { at: (a, c) => [c, a], ext: (l, r, u, d) => [u, d, l, r], box: (x0, y0, x1, y1) => [y0, y1, x0, x1] },
  up: { at: (a, c) => [c, -a], ext: (l, r, u, d) => [d, u, l, r], box: (x0, y0, x1, y1) => [-y1, -y0, x0, x1] },
};

function layeredPart(members, edges, col, foot, direction = "right", { centre = 0 } = {}) {
  const G = foot.G;
  const axes = AXES[direction] ?? AXES.right;
  const columns = Math.max(...members.map((i) => col.get(i))) + 1;

  const items = [];
  const itemOf = new Map();
  for (const i of members) {
    itemOf.set(i, items.length);
    items.push({
      id: i, col: col.get(i), lane: false, ext: axes.ext(foot.left[i], foot.right[i], foot.up[i], foot.down[i]),

      name: axes.box(...foot.box.subarray(i * 4, i * 4 + 4)),
    });
  }
  const laneExt = [LANE * G, LANE * G, LANE * G, LANE * G];
  const chains = [];
  for (const e of edges) {
    let a = e.s, b = e.t;
    if (col.get(a) === col.get(b)) continue;
    if (col.get(a) > col.get(b)) [a, b] = [b, a];
    const chain = [itemOf.get(a)];
    for (let c = col.get(a) + 1; c < col.get(b); c += 1) {
      chain.push(items.length);
      items.push({ id: -1, col: c, lane: true, ext: laneExt });
    }
    chain.push(itemOf.get(b));
    chains.push(chain);
  }
  const up = items.map(() => []), down = items.map(() => []);
  const chainOf = new Int32Array(items.length).fill(-1);
  chains.forEach((chain, n) => {
    for (let k = 0; k + 1 < chain.length; k += 1) { down[chain[k]].push(chain[k + 1]); up[chain[k + 1]].push(chain[k]); }
    for (let k = 1; k + 1 < chain.length; k += 1) chainOf[chain[k]] = n;
  });
  const layers = Array.from({ length: columns }, () => []);
  items.forEach((it, k) => layers[it.col].push(k));

  orderColumns(items, layers, up, down);

  const air = (a, b) => (items[a].lane && items[b].lane ? LANE_AIR : items[a].lane || items[b].lane ? LINK_AIR : AIR) * G;
  const gapAfter = (a, b) => items[a].ext[3] + air(a, b) + items[b].ext[2];

  const secant = new Float64Array(items.length).fill(1);
  const slopeOf = new Float64Array(items.length);
  const at = new Float64Array(items.length);
  const stack = () => {
    for (const layer of layers) {
      let c = 0;
      layer.forEach((k, n) => { if (n > 0) c += gapAfter(layer[n - 1], k); at[k] = c; });
      for (const k of layer) at[k] -= c / 2;
    }
  };

  const A = new Float64Array(columns);
  const objs = layers.map((layer) => layer.filter((k) => !items[k].lane));
  let widest = 0;
  for (const it of items) if (!it.lane) widest = Math.max(widest, it.ext[0], it.ext[1]);

  const index = new Int32Array(items.length);

  const tanAt = (k, dir) => {
    if (items[k].lane) return STEEP;
    const layer = layers[items[k].col];
    for (let n = index[k] + dir; n >= 0 && n < layer.length; n += dir) {
      const m = layer[n];
      if (items[m].lane) continue;

      const least = dir > 0 ? items[k].ext[3] + AIR * G + items[m].ext[2] : items[m].ext[3] + AIR * G + items[k].ext[2];
      const q = Math.max(Math.abs(at[m] - at[k]), least) / (PASS_BY * G);
      return q <= 1.05 ? 0.3 : Math.min(STEEP, Math.sqrt(q * q - 1));
    }
    return STEEP;
  };
  const alongGaps = (grow = false) => {
    const was = Float64Array.from(A);
    const pad = (AIR * G) / 2;
    for (let c = 1; c < columns; c += 1) {
      let steep = 0;

      for (const k of layers[c - 1]) {
        for (const n of down[k]) {
          if (items[k].lane && items[n].lane) continue;
          const d = at[n] - at[k], dir = d > 0 ? 1 : -1;
          if (Math.abs(d) < 1e-6) continue;
          steep = Math.max(steep, Math.abs(d) / Math.min(tanAt(k, dir), tanAt(n, -dir)));
        }
      }
      let a = A[c - 1] + Math.max(2 * foot.radius + LAYER_AIR * G, steep, grow ? was[c] - was[c - 1] : 0);
      for (let d = c - 1; d >= 0 && a - A[d] < 2 * widest + LAYER_AIR * G; d -= 1) {
        for (const p of objs[d]) {
          const p0 = at[p] - items[p].ext[2] - pad, p1 = at[p] + items[p].ext[3] + pad;
          for (const q of objs[c]) {
            if (at[q] + items[q].ext[3] + pad <= p0 || at[q] - items[q].ext[2] - pad >= p1) continue;
            a = Math.max(a, A[d] + items[p].ext[1] + items[q].ext[0] + LAYER_AIR * G);
          }
        }
      }
      A[c] = a;
    }
  };
  const weight = (a, b) => (items[a].lane && items[b].lane ? 8 : items[a].lane || items[b].lane ? 2 : 1);
  let straight = false;
  const aimOf = (k, sides) => {
    if (straight && items[k].lane) {
      const chain = chains[chainOf[k]];
      const a = chain[0], b = chain[chain.length - 1];
      const t = (A[items[k].col] - A[items[a].col]) / ((A[items[b].col] - A[items[a].col]) || 1);
      return { aim: at[a] + (at[b] - at[a]) * t, w: 12 };
    }
    let sum = 0, w = 0;
    for (const side of sides) {
      for (const n of side[k]) {
        let to = at[n], q = weight(k, n);
        if (straight && items[n].lane && !items[k].lane) {

          const chain = chains[chainOf[n]];
          const o = chain[0] === k ? chain[chain.length - 1] : chain[0];
          const t = (A[items[n].col] - A[items[o].col]) / ((A[items[k].col] - A[items[o].col]) || 1);
          if (Math.abs(t) > 1e-6) { to = at[o] + (at[n] - at[o]) / t; q = 4; }
        }
        sum += to * q; w += q;
      }
    }

    if (centre > 0 && !items[k].lane) { w += centre; }
    return w > 0 ? { aim: sum / w, w } : { aim: at[k], w: 0.05 };
  };
  const settle = (layer, sides) => fit(layer, layer.map((k) => aimOf(k, sides)));

  const fit = (layer, aims) => {
    if (layer.length === 0) return;
    const floor = [0];
    for (let n = 1; n < layer.length; n += 1) floor.push(floor[n - 1] + gapAfter(layer[n - 1], layer[n]));
    const blocks = [];
    aims.forEach(({ aim, w }, n) => {
      blocks.push({ v: aim - floor[n], w, n: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
        const b = blocks.pop(), a = blocks.pop();
        blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
      }
    });
    let n = 0;
    for (const b of blocks) for (let r = 0; r < b.n; r += 1) { at[layer[n]] = b.v + floor[n]; n += 1; }
  };
  const rounds = () => {
    for (let round = 0; round < 9; round += 1) {
      if (round % 3 === 0) for (let c = 1; c < columns; c += 1) settle(layers[c], [up]);
      else if (round % 3 === 1) for (let c = columns - 2; c >= 0; c -= 1) settle(layers[c], [down]);
      else for (let c = 0; c < columns; c += 1) settle(layers[c], [up, down]);
    }
  };
  const firstPlace = () => {
    stack();
    A.fill(0); secant.fill(1); slopeOf.fill(0); straight = false;
    for (const layer of layers) layer.forEach((k, n) => { index[k] = n; });
    for (let outer = 0; outer < 4; outer += 1) {
      rounds();
      alongGaps();

      straight = true;
    }
  };

  const lanesOf = chains.map((chain) => chain.slice(1, -1));
  const endA = new Int32Array(items.length), endB = new Int32Array(items.length);
  const tOf = new Float64Array(items.length);
  chains.forEach((chain, n) => { for (const k of lanesOf[n]) { endA[k] = chain[0]; endB[k] = chain[chain.length - 1]; } });
  const pos = (k) => (items[k].lane ? at[endA[k]] + (at[endB[k]] - at[endA[k]]) * tOf[k] : at[k]);
  const shareEnd = (p, q) => endA[p] === endA[q] || endA[p] === endB[q] || endB[p] === endA[q] || endB[p] === endB[q];
  const disc = PASS_BY * G;

  const fanNeed = (p, q) => {
    const [small, other] = linked[p].length <= linked[q].length ? [p, q] : [q, p];
    let most = 0;
    for (const e of linked[small]) {
      if (!linkedTo[other].has(e)) continue;
      const D = Math.abs(A[items[e].col] - A[items[p].col]);
      if (D < 1e-6) continue;
      const y = (at[p] + at[q]) / 2 - at[e];
      most = Math.max(most, Math.min(FAN_MOST * G, (FAN_ANGLE * (D * D + y * y)) / D));
    }
    return most;
  };
  const need = (p, q) => {
    if (!items[p].lane && !items[q].lane) return Math.max(items[p].ext[3] + AIR * G + items[q].ext[2], fanNeed(p, q));
    if (items[p].lane && items[q].lane) return shareEnd(p, q) ? 0 : LANE_AIR * G;
    return items[p].lane
      ? Math.max(items[q].ext[2] + LINK_AIR * G, disc * secant[p], nameClear(p, q, -1))
      : Math.max(items[p].ext[3] + LINK_AIR * G, disc * secant[q], nameClear(q, p, 1));
  };

  const nameClear = (k, v, dir) => {
    const [a0, a1, c0, c1] = items[v].name, s = slopeOf[k];
    return dir > 0 ? c1 + LINK_AIR * G - Math.min(s * a0, s * a1) : -c0 + LINK_AIR * G + Math.max(s * a0, s * a1);
  };

  const spacing = (layer) => {
    const g = new Float64Array(Math.max(0, layer.length - 1));
    for (let n = 0; n + 1 < layer.length; n += 1) g[n] = need(layer[n], layer[n + 1]);
    for (let n = 0; n < layer.length; n += 1) {
      const v = layer[n];
      if (items[v].lane) continue;
      for (const dir of [1, -1]) {
        let run = 0;
        for (let m = n + 2 * dir; m >= 0 && m < layer.length; m += dir) {
          const k = layer[m];
          if (!items[k].lane) break;
          run += g[dir > 0 ? m - 1 : m];
          const clear = dir > 0 ? need(v, k) : need(k, v);
          const at0 = dir > 0 ? n : n - 1;
          if (clear - run > g[at0]) g[at0] = clear - run;
        }
      }
    }
    return g;
  };

  const linked = items.map(() => []);
  for (const chain of chains) { const a = chain[0], b = chain[chain.length - 1]; linked[a].push(b); linked[b].push(a); }
  const linkedTo = linked.map((list) => new Set(list));
  const objects = items.map((_, k) => k).filter((k) => !items[k].lane);
  const OVER = 1.4;
  const tv = new Int32Array(4), tc = new Float64Array(4);
  let tn = 0;
  const addTerms = (k, sign) => {
    if (!items[k].lane) { tv[tn] = k; tc[tn] = sign; tn += 1; return; }
    tv[tn] = endA[k]; tc[tn] = sign * (1 - tOf[k]); tn += 1;
    tv[tn] = endB[k]; tc[tn] = sign * tOf[k]; tn += 1;
  };
  const projectPair = (p, q, gap) => {
    const short = gap - (pos(q) - pos(p));
    if (short <= 1e-9) return 0;
    tn = 0;
    addTerms(q, 1); addTerms(p, -1);
    let norm = 0;
    for (let i = 0; i < tn; i += 1) norm += tc[i] * tc[i];
    if (norm < 1e-12) return 0;
    const f = (OVER * short) / norm;
    for (let i = 0; i < tn; i += 1) at[tv[i]] += f * tc[i];
    return short;
  };

  let gaps = [];
  const project = () => {
    let worst = 0;
    layers.forEach((layer, c) => {
      const g = gaps[c];
      for (let n = 0; n + 1 < layer.length; n += 1) worst = Math.max(worst, projectPair(layer[n], layer[n + 1], g[n]));
      for (let n = layer.length - 2; n >= 0; n -= 1) worst = Math.max(worst, projectPair(layer[n], layer[n + 1], g[n]));
    });
    return worst;
  };

  const pinFit = (layer, g) => {
    if (layer.length < 2) return;
    const floor = new Float64Array(layer.length);
    for (let n = 1; n < layer.length; n += 1) floor[n] = floor[n - 1] + g[n - 1];
    const bv = [], bw = [], bn = [];
    for (let n = 0; n < layer.length; n += 1) {
      const k = layer[n];
      let v = pos(k) - floor[n], w = items[k].lane ? 1e6 : 1, c = 1;
      while (bv.length && bv[bv.length - 1] > v) {
        const pv = bv.pop(), pw = bw.pop(), pc = bn.pop();
        v = (v * w + pv * pw) / (w + pw); w += pw; c += pc;
      }
      bv.push(v); bw.push(w); bn.push(c);
    }
    let n = 0;
    for (let b = 0; b < bv.length; b += 1) {
      for (let r = 0; r < bn[b]; r += 1) { const k = layer[n]; if (!items[k].lane) at[k] = bv[b] + floor[n]; n += 1; }
    }
  };
  const level = () => {
    const next = new Float64Array(objects.length);
    objects.forEach((k, n) => {
      const list = linked[k];
      if (list.length === 0) { next[n] = at[k]; return; }
      let sum = 0;
      for (const j of list) sum += at[j];
      next[n] = at[k] + 0.12 * (sum / list.length - at[k]);
    });
    objects.forEach((k, n) => { at[k] = next[n]; });
  };
  const big = layers.some((layer) => layer.length > LONG_COLUMN);
  const OUTER = big ? 8 : 12, INNER = big ? 150 : 300;

  const relines = () => {
    for (const [n, chain] of chains.entries()) {
      if (chain.length < 3) continue;
      const a = chain[0], b = chain[chain.length - 1];
      const ca = items[a].col, cb = items[b].col;
      const slope = (at[b] - at[a]) / (A[cb] - A[ca]);
      for (const k of lanesOf[n]) {
        tOf[k] = (A[items[k].col] - A[ca]) / (A[cb] - A[ca]);
        secant[k] = Math.sqrt(1 + slope * slope);
        slopeOf[k] = slope;
      }
    }
  };
  const straighten = () => {
    for (let outer = 0; outer < OUTER; outer += 1) {
      alongGaps(false);
      relines();

      for (const layer of layers) {
        const was = new Map(layer.map((k, n) => [k, n]));
        layer.sort((x, y) => pos(x) - pos(y) || was.get(x) - was.get(y));
        layer.forEach((k, n) => { index[k] = n; });
      }
      gaps = layers.map(spacing);
      for (let it = 0; it < INNER; it += 1) {
        if (outer < OUTER - 4 && it < 60 && it % 6 === 0) level();

        if (big && it % 3 === 1) layers.forEach((layer, c) => pinFit(layer, gaps[c]));
        if (project() < 1e-3 * G && it > 6) break;
      }
    }
  };

  const escape = (layer) => {
    for (const v of layer) {
      if (items[v].lane) continue;
      let start = -Infinity, end = -Infinity, lines = [], inside = null;
      for (const k of layer) {
        if (!items[k].lane) continue;
        const s0 = pos(k) - Math.max(items[v].ext[3] + LINK_AIR * G, disc * secant[k]);
        const s1 = pos(k) + Math.max(items[v].ext[2] + LINK_AIR * G, disc * secant[k]);
        if (s0 > end) {
          if (at[v] > start + 1e-3 * G && at[v] < end - 1e-3 * G) { inside = [start, end, lines]; break; }
          start = s0; end = s1; lines = [k];
        } else { end = Math.max(end, s1); lines.push(k); }
      }
      if (!inside && at[v] > start + 1e-3 * G && at[v] < end - 1e-3 * G) inside = [start, end, lines];
      if (!inside) continue;
      const before = inside[2].filter((k) => pos(k) < at[v]).length;
      at[v] = before <= inside[2].length - before ? inside[0] - 1e-3 * G : inside[1] + 1e-3 * G;
    }
  };
  const finish = () => {
    for (let round = 0; round < 100; round += 1) {
      relines();
      if (round >= 30 && round % 5 === 0) for (const layer of layers) { layer.sort((x, y) => pos(x) - pos(y)); escape(layer); }
      let short = 0;
      for (const layer of layers) layer.sort((x, y) => pos(x) - pos(y));
      gaps = layers.map(spacing);
      layers.forEach((layer, c) => {
        const g = gaps[c];
        for (let n = 0; n + 1 < layer.length; n += 1) short = Math.max(short, g[n] - (pos(layer[n + 1]) - pos(layer[n])));
      });
      if (short < 1e-3 * G) break;
      for (let it = 0; it < 20; it += 1) project();

      relines();
      layers.forEach((layer) => { layer.sort((x, y) => pos(x) - pos(y)); pinFit(layer, spacing(layer)); });
    }
    for (let k = 0; k < items.length; k += 1) if (items[k].lane) at[k] = pos(k);
  };

  firstPlace(); straighten(); finish();

  const place = new Map();
  for (const i of members) place.set(i, axes.at(A[col.get(i)], at[itemOf.get(i)]));
  const span = layers.map((layer) => {
    let lo = Infinity, hi = -Infinity;
    for (const k of layer) if (!items[k].lane) { lo = Math.min(lo, at[k] - items[k].ext[2]); hi = Math.max(hi, at[k] + items[k].ext[3]); }
    return [lo, hi];
  });
  return { place, along: A, span, axes };
}

function orderColumns(items, layers, up, down) {
  const columns = layers.length;
  const pos = new Float64Array(items.length);
  const seen = new Uint8Array(items.length);
  const walk = [];
  for (const layer of layers) {
    for (const s of layer) {
      if (seen[s] || up[s].length > 0) continue;
      const stack = [s];
      while (stack.length) {
        const k = stack.pop();
        if (seen[k]) continue;
        seen[k] = 1; walk.push(k);
        for (let n = down[k].length - 1; n >= 0; n -= 1) stack.push(down[k][n]);
      }
    }
  }
  items.forEach((_, k) => { if (!seen[k]) walk.push(k); });
  const order = new Int32Array(items.length);
  walk.forEach((k, n) => { order[k] = n; });
  for (const layer of layers) layer.sort((a, b) => order[a] - order[b]);
  const index = () => { for (const layer of layers) layer.forEach((k, n) => { pos[k] = n; }); };
  index();

  const crossingsBetween = (c) => {
    const pairs = [];
    for (const k of layers[c]) for (const n of down[k]) pairs.push([pos[k], pos[n]]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const size = (layers[c + 1]?.length ?? 0) + 1;
    const tree = new Int32Array(size + 1);
    let n = 0, so = 0;
    for (const [, lower] of pairs) {
      let atMost = 0;
      for (let i = lower + 1; i > 0; i -= i & -i) atMost += tree[i];
      n += so - atMost;
      for (let i = lower + 1; i <= size; i += i & -i) tree[i] += 1;
      so += 1;
    }
    return n;
  };
  const total = () => { let n = 0; for (let c = 0; c + 1 < columns; c += 1) n += crossingsBetween(c); return n; };
  const median = (list) => {
    if (list.length === 0) return null;
    const v = list.map((k) => pos[k]).sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const between = (u, v, side) => {
    let n = 0;
    for (const a of side[u]) for (const b of side[v]) if (pos[a] > pos[b]) n += 1;
    return n;
  };
  const size = items.length + up.reduce((n, l) => n + l.length, 0);
  const transpose = () => {
    let better = true, rounds = 0;
    const most = size > 1500 ? 2 : 6;
    while (better && rounds < most) {
      better = false; rounds += 1;
      for (const layer of layers) {
        for (let n = 0; n + 1 < layer.length; n += 1) {
          const u = layer[n], v = layer[n + 1];
          const now = between(u, v, up) + between(u, v, down);
          const swapped = between(v, u, up) + between(v, u, down);
          if (swapped < now) { layer[n] = v; layer[n + 1] = u; pos[v] = n; pos[u] = n + 1; better = true; }
        }
      }
    }
  };
  let best = layers.map((l) => l.slice()), bestCount = total();
  const sweeps = (start) => {
    start.forEach((l, c) => { layers[c] = l.slice(); });
    index();
    for (let sweep = 0; sweep < 24 && bestCount > 0; sweep += 1) {
      const downward = sweep % 2 === 0;
      for (let q = 0; q < columns - 1; q += 1) {
        const c = downward ? q + 1 : columns - 2 - q;
        const layer = layers[c];
        const key = new Map(layer.map((k) => [k, median(downward ? up[k] : down[k]) ?? pos[k]]));
        layer.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
        layer.forEach((k, n) => { pos[k] = n; });
      }
      transpose();
      const now = total();
      if (now < bestCount) { bestCount = now; best = layers.map((l) => l.slice()); }
    }
  };
  const first = layers.map((l) => l.slice());
  sweeps(first);
  sweeps(first.map((l) => l.slice().reverse()));
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  const restarts = Math.floor(Math.min(12, 6000 / Math.max(size, 1)));
  for (let r = 0; r < restarts && bestCount > 0; r += 1) {
    sweeps(first.map((l) => l.map((k) => [random(), k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k)));
  }
  best.forEach((l, c) => { layers[c] = l; });
  index();
  if (size <= SIFT_MAX) {
    let count = total();
    for (let pass = 0; pass < 6; pass += 1) {
      const order = pass % 2 === 0 ? [...layers.keys()] : [...layers.keys()].reverse();
      for (const c of order) {
        const layer = layers[c];
        if (layer.length < 3) continue;
        const byLinks = layer.slice().sort((a, b) => (up[b].length + down[b].length) - (up[a].length + down[a].length) || a - b);
        for (const u of byLinks) {
          const from = layer.indexOf(u);
          layer.splice(from, 1);
          layer.forEach((k, n) => { pos[k] = n; });

          const before = layer.map((v) => between(u, v, up) + between(u, v, down));
          const after = layer.map((v) => between(v, u, up) + between(v, u, down));

          let cost = before.reduce((t, x) => t + x, 0), bestAt = 0, bestCost = cost;
          for (let n = 0; n < layer.length; n += 1) {
            cost += after[n] - before[n];
            if (cost < bestCost || (cost === bestCost && n + 1 === from)) { bestCost = cost; bestAt = n + 1; }
          }
          layer.splice(bestAt, 0, u);
          layer.forEach((k, n) => { pos[k] = n; });
        }
      }
      const now = total();
      if (now >= count) break;
      count = now;
    }
  }
}

function stressPart(members, adj, foot, xs, ys, iterations = 90, fromScratch = false) {
  const m = members.length;
  if (m < 2) return;
  const G = foot.G;
  const local = new Map(members.map((i, k) => [i, k]));

  const widths = members.map((i) => foot.left[i] + foot.right[i] + AIR * G).sort((a, b) => a - b);
  const heights = members.map((i) => foot.up[i] + foot.down[i] + AIR * G).sort((a, b) => a - b);
  const W = widths[Math.floor(m / 2)], H = heights[Math.floor(m / 2)];
  const stretch = Math.sqrt(W / H);
  const L = Math.max(2.4 * G, Math.sqrt(W * H) * 1.05);
  const hops = new Int32Array(m * m).fill(-1);
  for (let s0 = 0; s0 < m; s0 += 1) {
    const row = s0 * m;
    hops[row + s0] = 0;
    const queue = [s0];
    for (let h = 0; h < queue.length; h += 1) {
      const u = queue[h];
      for (const j of adj[members[u]]) {
        const v = local.get(j);
        if (v === undefined || hops[row + v] >= 0) continue;
        hops[row + v] = hops[row + u] + 1;
        queue.push(v);
      }
    }
  }
  const x = new Float64Array(m), y = new Float64Array(m);
  if (fromScratch) {

    const d2 = new Float64Array(m * m), rowMean = new Float64Array(m);
    let all = 0;
    for (let a = 0; a < m; a += 1) {
      for (let b = 0; b < m; b += 1) {
        const h = hops[a * m + b] < 0 ? m : hops[a * m + b];
        d2[a * m + b] = h * h; rowMean[a] += h * h;
      }
      all += rowMean[a]; rowMean[a] /= m;
    }
    all /= m * m;
    const B = (a, b) => -0.5 * (d2[a * m + b] - rowMean[a] - rowMean[b] + all);
    const vectors = [];
    for (let e = 0; e < 2; e += 1) {
      let v = Float64Array.from({ length: m }, (_, k) => Math.sin(k * 12.9898 + e * 78.233));
      let value = 0;
      for (let it = 0; it < 60; it += 1) {
        const next = new Float64Array(m);
        for (let a = 0; a < m; a += 1) { let sum = 0; for (let b = 0; b < m; b += 1) sum += B(a, b) * v[b]; next[a] = sum; }
        for (const u of vectors) { let dot = 0; for (let k = 0; k < m; k += 1) dot += next[k] * u[k]; for (let k = 0; k < m; k += 1) next[k] -= dot * u[k]; }
        let norm = 0; for (let k = 0; k < m; k += 1) norm += next[k] * next[k];
        norm = Math.sqrt(norm) || 1; value = norm;
        for (let k = 0; k < m; k += 1) next[k] /= norm;
        v = next;
      }
      vectors.push(v);
      const scale = Math.sqrt(Math.max(value, 1e-9));
      for (let k = 0; k < m; k += 1) (e === 0 ? x : y)[k] = v[k] * scale;
    }

    for (let k = 0; k < m; k += 1) { x[k] += 0.05 * Math.cos(k * 2.39996) * Math.sqrt(k + 1); y[k] += 0.05 * Math.sin(k * 2.39996) * Math.sqrt(k + 1); }
  } else members.forEach((i, k) => { x[k] = xs[i] / stretch; y[k] = ys[i]; });

  let sum = 0, n = 0;
  for (let a = 0; a < m; a += 1) for (const j of adj[members[a]]) {
    const b = local.get(j);
    if (b !== undefined && b > a) { sum += Math.hypot(x[a] - x[b], y[a] - y[b]); n += 1; }
  }
  const start = n > 0 && sum > 0 ? (L * n) / sum : 1;
  for (let k = 0; k < m; k += 1) { x[k] *= start; y[k] *= start; }

  const sweeps = Math.round(Math.min(iterations, Math.max(30, (iterations * 250) / m)));
  for (let it = 0; it < sweeps; it += 1) {
    for (let a = 0; a < m; a += 1) {
      let nx = 0, ny = 0, w = 0;
      const row = a * m, xa = x[a], ya = y[a];
      for (let b = 0; b < m; b += 1) {
        const h = hops[row + b];
        if (h <= 0) continue;
        const d = h * L, wij = 1 / (d * d);
        let dx = xa - x[b], dy = ya - y[b];
        let len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) {

          const turn = ((a * 7 + b * 13) % 31) * 0.2027;
          dx = 1e-3 * Math.cos(turn) * (a < b ? 1 : -1); dy = 1e-3 * Math.sin(turn) * (a < b ? 1 : -1);
          len = 1e-3;
        }
        const f = d / len;
        nx += wij * (x[b] + f * dx);
        ny += wij * (y[b] + f * dy);
        w += wij;
      }
      if (w > 0) { x[a] = nx / w; y[a] = ny / w; }
    }
  }
  members.forEach((i, k) => { xs[i] = x[k] * stretch; ys[i] = y[k]; });
}

const FORCE = {
  scaling: 2,
  gravity: 1,
  theta: 1.2,
  jitter: 1,
  linLog: true,
  dissuade: false,
  iterations: (m) => Math.round(Math.min(700, Math.max(250, 250000 / m))),
};

function forcePart(members, edges, foot, xs, ys) {
  const m = members.length;
  if (m < 2) return;
  const local = new Map(members.map((i, k) => [i, k]));
  const src = [], dst = [];
  const seen = new Set();
  for (const e of edges) {
    const a = local.get(e.s), b = local.get(e.t);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a * m + b : b * m + a;
    if (seen.has(key)) continue;
    seen.add(key); src.push(a); dst.push(b);
  }
  const mass = new Float64Array(m).fill(1);
  for (let k = 0; k < src.length; k += 1) { mass[src[k]] += 1; mass[dst[k]] += 1; }

  const order = Array.from({ length: m }, (_, k) => k).sort((a, b) => mass[b] - mass[a] || a - b);
  const x = new Float64Array(m), y = new Float64Array(m);
  const R0 = Math.sqrt(m) * 10;
  order.forEach((k, r) => {
    const rad = R0 * Math.sqrt((r + 0.5) / m), ang = r * 2.39996323;
    x[k] = rad * Math.cos(ang); y[k] = rad * Math.sin(ang);
  });
  let meanMass = 0;
  for (let k = 0; k < m; k += 1) meanMass += mass[k];
  meanMass /= m;
  const fx = new Float64Array(m), fy = new Float64Array(m);
  const ox = new Float64Array(m), oy = new Float64Array(m);
  let speed = 1, efficiency = 1;
  const { scaling, gravity, theta, jitter } = FORCE;
  const iterations = FORCE.iterations(m);

  const cap = 4 * m + 8;
  const cm = new Float64Array(cap), cx = new Float64Array(cap), cy = new Float64Array(cap);
  const cxMin = new Float64Array(cap), cyMin = new Float64Array(cap), cSize = new Float64Array(cap);
  const child = new Int32Array(cap * 4), body = new Int32Array(cap);
  let cells = 0;
  const cell = (x0, y0, size) => {
    const c = cells++;
    cm[c] = 0; cx[c] = 0; cy[c] = 0; cxMin[c] = x0; cyMin[c] = y0; cSize[c] = size;
    child[c * 4] = child[c * 4 + 1] = child[c * 4 + 2] = child[c * 4 + 3] = -1; body[c] = -1;
    return c;
  };
  const quadrant = (c, px, py) => {
    const half = cSize[c] / 2;
    return (px >= cxMin[c] + half ? 1 : 0) + (py >= cyMin[c] + half ? 2 : 0);
  };
  const childOf = (c, q) => {
    let n = child[c * 4 + q];
    if (n < 0) {
      const half = cSize[c] / 2;
      n = cell(cxMin[c] + (q & 1 ? half : 0), cyMin[c] + (q & 2 ? half : 0), half);
      child[c * 4 + q] = n;
    }
    return n;
  };
  const insert = (root, k) => {
    let c = root;
    for (let depth = 0; ; depth += 1) {
      const w = mass[k];
      if (cm[c] === 0 && body[c] < 0 && child[c * 4] < 0 && child[c * 4 + 1] < 0 && child[c * 4 + 2] < 0 && child[c * 4 + 3] < 0) {
        body[c] = k; cm[c] = w; cx[c] = x[k]; cy[c] = y[k];
        return;
      }

      cx[c] = (cx[c] * cm[c] + x[k] * w) / (cm[c] + w);
      cy[c] = (cy[c] * cm[c] + y[k] * w) / (cm[c] + w);
      cm[c] += w;
      if (body[c] >= 0) {
        const other = body[c];
        body[c] = -1;
        if (depth > 40) { continue; }
        const q = quadrant(c, x[other], y[other]);
        const n = childOf(c, q);
        body[n] = other; cm[n] = mass[other]; cx[n] = x[other]; cy[n] = y[other];
      }
      if (depth > 40) return;
      c = childOf(c, quadrant(c, x[k], y[k]));
    }
  };
  const stack = new Int32Array(cap);
  for (let it = 0; it < iterations; it += 1) {
    fx.fill(0); fy.fill(0);

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < m; k += 1) { x0 = Math.min(x0, x[k]); x1 = Math.max(x1, x[k]); y0 = Math.min(y0, y[k]); y1 = Math.max(y1, y[k]); }
    cells = 0;
    const root = cell(x0, y0, Math.max(x1 - x0, y1 - y0, 1) * 1.0001);
    for (let k = 0; k < m; k += 1) insert(root, k);
    for (let k = 0; k < m; k += 1) {
      let top = 0;
      stack[top++] = root;
      while (top > 0) {
        const c = stack[--top];
        if (cm[c] === 0 || body[c] === k) continue;
        const dx = x[k] - cx[c], dy = y[k] - cy[c];
        const d2 = dx * dx + dy * dy;
        const leaf = body[c] >= 0 || (child[c * 4] < 0 && child[c * 4 + 1] < 0 && child[c * 4 + 2] < 0 && child[c * 4 + 3] < 0);
        if (leaf || cSize[c] * cSize[c] < theta * theta * d2) {
          if (d2 > 0) {
            const f = (scaling * mass[k] * cm[c]) / d2;
            fx[k] += dx * f; fy[k] += dy * f;
          }
        } else {
          for (let q = 0; q < 4; q += 1) { const n = child[c * 4 + q]; if (n >= 0) stack[top++] = n; }
        }
      }
    }

    for (let k = 0; k < m; k += 1) {
      const d = Math.hypot(x[k], y[k]);
      if (d > 0) { const f = (gravity * mass[k]) / d; fx[k] -= x[k] * f; fy[k] -= y[k] * f; }
    }

    for (let e = 0; e < src.length; e += 1) {
      const a = src[e], b = dst[e];
      const dx = x[a] - x[b], dy = y[a] - y[b];
      const d = Math.hypot(dx, dy);
      if (d <= 0) continue;
      const pull = FORCE.linLog ? Math.log(1 + d) : d;
      const f = FORCE.dissuade ? (meanMass * pull) / d / Math.max(mass[a], mass[b]) : pull / d;
      fx[a] -= dx * f; fy[a] -= dy * f;
      fx[b] += dx * f; fy[b] += dy * f;
    }

    let swinging = 0, traction = 0;
    for (let k = 0; k < m; k += 1) {
      swinging += mass[k] * Math.hypot(ox[k] - fx[k], oy[k] - fy[k]);
      traction += mass[k] * Math.hypot(ox[k] + fx[k], oy[k] + fy[k]) / 2;
    }
    const estimate = 0.05 * Math.sqrt(m);
    const minJ = Math.sqrt(estimate), maxJ = 10;
    let tolerance = jitter * Math.max(minJ, Math.min(maxJ, (estimate * traction) / (m * m)));
    const minSpeedEfficiency = 0.05;
    if (traction > 0 && swinging / traction > 2) {
      if (efficiency > minSpeedEfficiency) efficiency *= 0.5;
      tolerance = Math.max(tolerance, jitter);
    }
    const target = swinging > 0 ? (tolerance * efficiency * traction) / swinging : speed;
    if (swinging > tolerance * traction) { if (efficiency > minSpeedEfficiency) efficiency *= 0.7; }
    else if (speed < 1000) efficiency *= 1.3;
    speed += Math.min(target - speed, 0.5 * speed);
    for (let k = 0; k < m; k += 1) {
      const swing = mass[k] * Math.hypot(ox[k] - fx[k], oy[k] - fy[k]);
      const f = Math.hypot(fx[k], fy[k]);
      let factor = speed / (1 + Math.sqrt(speed * swing));

      if (f * factor > 10) factor = 10 / f;
      x[k] += fx[k] * factor; y[k] += fy[k] * factor;
      ox[k] = fx[k]; oy[k] = fy[k];
    }
  }

  const G = foot.G;
  const W = members.map((i) => foot.left[i] + foot.right[i] + AIR * G).sort((a, b) => a - b)[Math.floor(m / 2)];
  const H = members.map((i) => foot.up[i] + foot.down[i] + AIR * G).sort((a, b) => a - b)[Math.floor(m / 2)];
  const L = Math.max(2.4 * G, Math.sqrt(W * H) * 1.05);
  const lengths = [];
  for (let e = 0; e < src.length; e += 1) lengths.push(Math.hypot(x[src[e]] - x[dst[e]], y[src[e]] - y[dst[e]]));
  lengths.sort((a, b) => a - b);
  const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 1;

  const near = Array.from({ length: m }, () => []);
  for (let e = 0; e < src.length; e += 1) { near[src[e]].push(dst[e]); near[dst[e]].push(src[e]); }
  const typical = (o) => {
    const own = near[o].map((q) => Math.hypot(x[o] - x[q], y[o] - y[q])).sort((a, b) => a - b);
    return own.length > 1 ? own[Math.floor(own.length / 2)] : median;
  };
  const tails = Array.from({ length: m }, (_, k) => k).filter((k) => near[k].length <= 2)
    .sort((a, b) => near[a].length - near[b].length || Math.hypot(x[b], y[b]) - Math.hypot(x[a], y[a]));
  for (const k of tails) {

    let mx = 0, my = 0;
    for (const o of near[k]) { mx += x[o]; my += y[o]; }
    mx /= near[k].length; my /= near[k].length;
    const reach = LEAF_REACH * Math.min(...near[k].map(typical));
    const dx = x[k] - mx, dy = y[k] - my, d = Math.hypot(dx, dy);
    if (d > reach) { x[k] = mx + (dx / d) * reach; y[k] = my + (dy / d) * reach; }
  }
  const s = median > 0 ? L / median : 1;
  members.forEach((i, k) => { xs[i] = x[k] * s; ys[i] = y[k] * s; });
}
const LEAF_REACH = 1.5;

export function inflate(xs, ys, members, foot) {
  const n = members.length;
  if (n < 2) return;
  let cx = 0, cy = 0;
  for (const i of members) { cx += xs[i]; cy += ys[i]; }
  cx /= n; cy /= n;
  const bx = members.map((i) => xs[i] - cx), by = members.map((i) => ys[i] - cy);
  const touching = (s) => {
    for (let k = 0; k < n; k += 1) { xs[members[k]] = cx + bx[k] * s; ys[members[k]] = cy + by[k] * s; }
    return overlaps(xs, ys, members, foot, null);
  };
  let s = 1;
  for (let step = 0; step < 40 && touching(s) > Math.floor(n / 6); step += 1) s *= 1.1;
}

function overlaps(xs, ys, members, foot, each) {
  const { left, right, up, down, G } = foot;
  const pad = (AIR * G) / 2;
  let widest = 0, tallest = 0;
  for (const i of members) { widest = Math.max(widest, left[i], right[i]); tallest = Math.max(tallest, up[i], down[i]); }
  const cw = 2 * widest + 2 * pad, ch = 2 * tallest + 2 * pad;
  const grid = new Map();
  for (const i of members) {
    const key = `${Math.floor(xs[i] / cw)},${Math.floor(ys[i] / ch)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)).push(i);
  }
  let count = 0;
  for (const i of members) {
    const gx = Math.floor(xs[i] / cw), gy = Math.floor(ys[i] / ch);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= i) continue;
          const ox = Math.min(xs[i] + right[i], xs[j] + right[j]) - Math.max(xs[i] - left[i], xs[j] - left[j]) + 2 * pad;
          const oy = Math.min(ys[i] + down[i], ys[j] + down[j]) - Math.max(ys[i] - up[i], ys[j] - up[j]) + 2 * pad;
          if (ox > 0 && oy > 0) { count += 1; if (each) each(i, j, ox, oy); }
        }
      }
    }
  }
  return count;
}

function intrusion(ax, ay, bx, by, v, vx, vy, foot, withName = true) {
  const { radius, box, G } = foot;
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const clear = LINK_AIR * G;

  const t = (vx - ax) * ux + (vy - ay) * uy;
  const side = (vx - ax) * nx + (vy - ay) * ny;
  let need = 0, sign = side >= 0 ? 1 : -1;
  const pass = Math.max(radius + clear, PASS_BY * G);
  if (t > -radius && t < len + radius && Math.abs(side) < pass) need = pass - Math.abs(side);

  const x0 = vx + box[v * 4], y0 = vy + box[v * 4 + 1], x1 = vx + box[v * 4 + 2], y1 = vy + box[v * 4 + 3];
  let lo = Infinity, hi = -Infinity, tlo = Infinity, thi = -Infinity;
  for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const s = (px - ax) * nx + (py - ay) * ny, q = (px - ax) * ux + (py - ay) * uy;
    lo = Math.min(lo, s); hi = Math.max(hi, s); tlo = Math.min(tlo, q); thi = Math.max(thi, q);
  }
  if (withName && thi > 0 && tlo < len && lo < clear && hi > -clear) {

    const toPlus = clear - lo, toMinus = hi + clear;
    const [n, s] = toPlus < toMinus ? [toPlus, 1] : [toMinus, -1];
    if (n > need) { need = n; sign = s; }
  }
  return need > 0 ? [nx * sign, ny * sign, need] : null;
}

export function clear(xs, ys, members, edges, foot, rounds = members.length > 250 ? 80 : 200, linksToo = edges.length < 20000) {
  const n = members.length;
  if (n < 2) return;
  let widest = 0;
  for (const v of members) widest = Math.max(widest, foot.left[v], foot.right[v], foot.up[v], foot.down[v]);
  const reach = widest + foot.G, cell = Math.max(2 * widest, 3 * foot.G);
  for (let round = 0; round < rounds; round += 1) {
    let moved = 0;
    overlaps(xs, ys, members, foot, (i, j, ox, oy) => {
      moved += 1;
      if (ox < oy * 1.4) {
        const s = xs[i] < xs[j] || (xs[i] === xs[j] && i < j) ? -1 : 1;
        xs[i] += (s * ox) / 2; xs[j] -= (s * ox) / 2;
      } else {
        const s = ys[i] < ys[j] || (ys[i] === ys[j] && i < j) ? -1 : 1;
        ys[i] += (s * oy) / 2; ys[j] -= (s * oy) / 2;
      }
    });
    if (linksToo) {

      const grid = new Map();
      for (const v of members) {
        const key = Math.floor(xs[v] / cell) * 65536 + Math.floor(ys[v] / cell);
        (grid.get(key) ?? grid.set(key, []).get(key)).push(v);
      }
      for (const e of edges) {
        const ax = xs[e.s], ay = ys[e.s], bx = xs[e.t], by = ys[e.t];
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);

        const near = [], seen = new Set();
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
        const span = Math.ceil(reach / cell);
        for (let q = 0; q <= steps; q += 1) {
          const cx = Math.floor((ax + ((bx - ax) * q) / steps) / cell), cy = Math.floor((ay + ((by - ay) * q) / steps) / cell);
          for (let gx = cx - span; gx <= cx + span; gx += 1) {
            for (let gy = cy - span; gy <= cy + span; gy += 1) {
              const key = gx * 65536 + gy;
              if (seen.has(key)) continue;
              seen.add(key);
              const list = grid.get(key);
              if (list) for (const v of list) near.push(v);
            }
          }
        }
        for (const v of near) {
          if (v === e.s || v === e.t) continue;
          if (xs[v] + foot.right[v] < x0 - foot.G || xs[v] - foot.left[v] > x1 + foot.G
            || ys[v] + foot.down[v] < y0 - foot.G || ys[v] - foot.up[v] > y1 + foot.G) continue;

          const hit = intrusion(ax, ay, bx, by, v, xs[v], ys[v], foot, round < rounds / 2);
          if (!hit) continue;
          moved += 1;
          const [nx, ny, d] = hit;

          const ends = round < rounds / 2 ? 0.2 : 0.05;
          xs[v] += nx * d * (1 - 2 * ends); ys[v] += ny * d * (1 - 2 * ends);
          xs[e.s] -= nx * d * ends; ys[e.s] -= ny * d * ends;
          xs[e.t] -= nx * d * ends; ys[e.t] -= ny * d * ends;
        }
      }
    }
    if (moved === 0) break;
  }
}

function pack(boxes, aspect, air, cap = Infinity) {
  const n = boxes.length;
  if (n === 0) return { at: [], shapes: [], width: 0, height: 0 };
  const shapeSets = boxes.map((b) => [{ w: b.w, h: b.h }, ...(b.shapes ?? [])]);
  const order = boxes.map((_, k) => k);
  let best = null;
  const tryWith = (shapes, strip) => {
    const seq = order.slice().sort((a, b) => shapes[b].h * shapes[b].w - shapes[a].h * shapes[a].w || a - b);
    let sky = [{ x: 0, w: Infinity, y: 0 }];
    const at = new Array(n);
    let W = 0, H = 0;
    for (const k of seq) {
      const w = shapes[k].w + air, h = shapes[k].h + air;
      let pick = null;
      for (let s = 0; s < sky.length; s += 1) {
        const x = sky[s].x;
        if (x > 0 && x + w > strip) break;
        let y = 0, reach = x;
        for (let t = s; t < sky.length && reach < x + w; t += 1) { y = Math.max(y, sky[t].y); reach = sky[t].x + sky[t].w; }
        if (!pick || y < pick.y - 1e-6) pick = { x, y };
      }
      at[k] = [pick.x, pick.y];
      W = Math.max(W, pick.x + w); H = Math.max(H, pick.y + h);

      const next = [];
      for (const seg of sky) {
        const s0 = seg.x, s1 = seg.x + seg.w;
        if (s1 <= pick.x || s0 >= pick.x + w) { next.push(seg); continue; }
        if (s0 < pick.x) next.push({ x: s0, w: pick.x - s0, y: seg.y });
        if (s1 > pick.x + w) next.push({ x: pick.x + w, w: s1 - (pick.x + w), y: seg.y });
      }
      next.push({ x: pick.x, w, y: pick.y + h });
      next.sort((a, b) => a.x - b.x);
      sky = next;
    }
    const fit = Math.min(aspect / W, 1 / H, cap);
    if (!best || fit > best.fit * (1 + 1e-9) || (fit >= best.fit * (1 - 1e-9) && H < best.height + air - 1e-9)) {
      best = { fit, at, shapes, width: W - air, height: H - air };
    }
  };

  const flexible = boxes.map((b, k) => (b.shapes?.length ? k : -1)).filter((k) => k >= 0);
  const variants = [shapeSets.map((s) => s[0])];
  for (const k of flexible) {
    for (const shape of shapeSets[k].slice(1)) {
      const v = shapeSets.map((s) => s[0]);
      v[k] = shape;
      variants.push(v);
    }
  }
  for (const shapes of variants) {
    let widest = 0, sum = 0;
    for (const s of shapes) { widest = Math.max(widest, s.w + air); sum += s.w + air; }
    const steps = 18;
    for (let q = 0; q <= steps; q += 1) tryWith(shapes, widest + ((sum - widest) * q) / steps + 1e-6);
  }

  const { at, shapes } = best;
  for (const axis of [1, 0]) {
    for (let k = 0; k < n; k += 1) {
      const size = (m) => (axis ? shapes[m].h : shapes[m].w), side = (m) => (axis ? shapes[m].w : shapes[m].h);
      let lo = 0, hi = (axis ? best.height : best.width) - size(k);
      for (let m = 0; m < n; m += 1) {
        if (m === k) continue;
        const o = 1 - axis;
        if (at[m][o] >= at[k][o] + side(k) + air - 1e-9 || at[k][o] >= at[m][o] + side(m) + air - 1e-9) continue;
        if (at[m][axis] + size(m) <= at[k][axis] + 1e-9) lo = Math.max(lo, at[m][axis] + size(m) + air);
        else hi = Math.min(hi, at[m][axis] - air - size(k));
      }
      if (hi >= lo) at[k][axis] = (lo + hi) / 2;
    }
  }
  return best;
}

const GATHER_STEP = 0.25, GATHER_AIR = 1.2, GATHER_MAX = 1500;
function gather(groups, xs, ys, foot, edges) {
  const offsets = groups.map(() => [0, 0]);
  const count = groups.reduce((n, g) => n + g.length, 0);
  if (groups.length < 2 || count + edges.length > GATHER_MAX) return offsets;
  const { left, right, up, down, G } = foot;
  const groupOf = new Map();
  groups.forEach((g, k) => g.forEach((i) => groupOf.set(i, k)));
  const air = GATHER_AIR * G;
  const own = groups.map(() => []);
  for (const e of edges) own[groupOf.get(e.s)]?.push(e);
  const cross = (a, b, c, d) => {
    const o = (p, q, r) => Math.sign((xs[q] - xs[p]) * (ys[r] - ys[p]) - (ys[q] - ys[p]) * (xs[r] - xs[p]));
    return a !== c && a !== d && b !== c && b !== d && o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };

  const clear = (k) => {
    for (const i of groups[k]) {
      for (let m = 0; m < groups.length; m += 1) {
        if (m === k) continue;
        for (const j of groups[m]) {
          if (xs[i] + right[i] + air <= xs[j] - left[j] || xs[j] + right[j] + air <= xs[i] - left[i]) continue;
          if (ys[i] + down[i] + air <= ys[j] - up[j] || ys[j] + down[j] + air <= ys[i] - up[i]) continue;
          return false;
        }
      }
    }
    for (let m = 0; m < groups.length; m += 1) {
      if (m === k) continue;
      for (const e of own[m]) for (const i of groups[k]) if (intrusion(xs[e.s], ys[e.s], xs[e.t], ys[e.t], i, xs[i], ys[i], foot)) return false;
      for (const e of own[k]) {
        for (const j of groups[m]) if (intrusion(xs[e.s], ys[e.s], xs[e.t], ys[e.t], j, xs[j], ys[j], foot)) return false;
        for (const f of own[m]) if (cross(e.s, e.t, f.s, f.t)) return false;
      }
    }
    return true;
  };
  const move = (k, dx, dy) => { for (const i of groups[k]) { xs[i] += dx; ys[i] += dy; } offsets[k][0] += dx; offsets[k][1] += dy; };
  const middle = (members) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of members) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  const order = groups.map((_, k) => k).sort((a, b) => groups[b].length - groups[a].length || a - b).slice(1).reverse();
  for (const k of order) {
    const rest = groups.flatMap((g, m) => (m === k ? [] : g));
    for (const axis of ["both", "x", "y"]) {
      const [cx, cy] = middle(rest), [gx, gy] = middle(groups[k]);
      let dx = axis === "y" ? 0 : cx - gx, dy = axis === "x" ? 0 : cy - gy;
      const far = Math.hypot(dx, dy);
      if (far < GATHER_STEP * G) continue;
      dx *= (GATHER_STEP * G) / far; dy *= (GATHER_STEP * G) / far;
      for (let n = Math.floor(far / (GATHER_STEP * G)); n > 0; n -= 1) {
        move(k, dx, dy);
        if (!clear(k)) { move(k, -dx, -dy); break; }
      }
    }
  }
  return offsets;
}

const EXPAND_FAN = Math.tan((55 * Math.PI) / 180);
const EXPAND_LINK = 4, EXPAND_STEP = 0.5, EXPAND_GROW = 0.04, EXPAND_REACH = 60, EXPAND_FAR = 1.5, EXPAND_TRIES = 20000;
const EXPAND_CROSS = 2, EXPAND_OVER = 5, EXPAND_FELLOW = 0.5, EXPAND_OWN = 8, EXPAND_TURN = 2, EXPAND_TAKEN = 4;
export function placeArrivals(xs, ys, arrivals, opened, links, foot, order = null) {
  const { left, right, up, down, box, G } = foot;
  const count = xs.length;
  const arriving = new Uint8Array(count);
  for (const i of arrivals) arriving[i] = 1;
  const stay = [];
  for (let i = 0; i < count; i += 1) if (!arriving[i]) stay.push(i);
  const list = order ? arrivals.slice().sort(order) : arrivals.slice();
  if (opened == null || opened < 0) {

    const [x0, , x1, y1] = stay.length ? boundsOf(xs, ys, stay, foot) : [0, 0, 0, 0];
    const blocks = loneBlocks(list, foot);
    const block = blocks.find((b) => b.w <= Math.max(x1 - x0, 12 * G)) ?? blocks[blocks.length - 1];
    list.forEach((i, n) => { xs[i] = (x0 + x1) / 2 - block.w / 2 + block.spots[n][0]; ys[i] = y1 + PART_AIR * G + block.spots[n][1]; });
    return;
  }
  const ox = xs[opened], oy = ys[opened];

  let mx = 0, my = 0;
  for (const l of links) {
    const other = l.source === opened ? l.target : l.target === opened ? l.source : -1;
    if (other < 0 || arriving[other]) continue;
    const dx = xs[other] - ox, dy = ys[other] - oy, d = Math.hypot(dx, dy) || 1;
    mx += dx / d; my += dy / d;
  }
  const norm = Math.hypot(mx, my);

  let outward = 0;
  for (const l of links) {
    if (l.source === opened && arriving[l.target]) outward += 1;
    else if (l.target === opened && arriving[l.source]) outward -= 1;
  }
  const flowX = outward >= 0 ? 1 : -1;
  const air = AIR * G, pass = LINK_AIR * G + Math.max(foot.radius, PASS_BY * G);

  const drawnLinks = [];
  for (const l of links) {
    if (arriving[l.source] || arriving[l.target] || l.source === l.target) continue;
    const ax = xs[l.source], ay = ys[l.source], bx = xs[l.target], by = ys[l.target];
    drawnLinks.push({ l, x0: Math.min(ax, bx) - pass, x1: Math.max(ax, bx) + pass, y0: Math.min(ay, by) - pass, y1: Math.max(ay, by) + pass });
  }
  const ownLinks = links.filter((l) => (arriving[l.source] || arriving[l.target]) && l.source !== l.target);
  const toOpened = (l) => l.source === opened || l.target === opened;
  const toLines = ownLinks.filter(toOpened);

  const hits = footprintGrid(stay, xs, ys, foot, air);
  const clash = (i) => hits(i, xs[i], ys[i]);
  const orient = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const crosses = (a, b, c, d) => a !== c && a !== d && b !== c && b !== d
    && orient(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c]) * orient(xs[a], ys[a], xs[b], ys[b], xs[d], ys[d]) < 0
    && orient(xs[c], ys[c], xs[d], ys[d], xs[a], ys[a]) * orient(xs[c], ys[c], xs[d], ys[d], xs[b], ys[b]) < 0;

  const overName = (a, b, v) => {
    const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay;
    const trim = foot.radius / (Math.hypot(dx, dy) || 1);
    let t0 = trim, t1 = 1 - trim;
    const x0 = xs[v] + box[v * 4], y0 = ys[v] + box[v * 4 + 1], x1 = xs[v] + box[v * 4 + 2], y1 = ys[v] + box[v * 4 + 3];
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
    return true;
  };

  const judge = () => {
    for (const i of list) if (clash(i)) return null;
    for (const i of list) {
      const x0 = xs[i] - left[i], x1 = xs[i] + right[i], y0 = ys[i] - up[i], y1 = ys[i] + down[i];
      for (const e of drawnLinks) {
        if (e.x1 < x0 || e.x0 > x1 || e.y1 < y0 || e.y0 > y1) continue;
        const { source: a, target: b } = e.l;
        if (intrusion(xs[a], ys[a], xs[b], ys[b], i, xs[i], ys[i], foot)) return null;
      }
    }
    let price = 0, struck = 0;
    for (const l of toLines) if (overName(l.source, l.target, l.source) || overName(l.source, l.target, l.target)) struck += 1;
    if (toLines.length) price += (EXPAND_OWN * struck) / toLines.length;
    for (const l of ownLinks) {
      const hard = toOpened(l);
      const ax = xs[l.source], ay = ys[l.source], bx = xs[l.target], by = ys[l.target];
      const lx0 = Math.min(ax, bx) - pass, lx1 = Math.max(ax, bx) + pass, ly0 = Math.min(ay, by) - pass, ly1 = Math.max(ay, by) + pass;
      for (let v = 0; v < count; v += 1) {
        if (v === l.source || v === l.target) continue;
        if (xs[v] + right[v] < lx0 || xs[v] - left[v] > lx1 || ys[v] + down[v] < ly0 || ys[v] - up[v] > ly1) continue;
        if (!intrusion(ax, ay, bx, by, v, xs[v], ys[v], foot)) continue;
        if (hard && intrusion(ax, ay, bx, by, v, xs[v], ys[v], foot, false)) return null;

        price += arriving[v] ? EXPAND_FELLOW : EXPAND_OVER;
      }
      for (const e of drawnLinks) {
        if (e.x1 < lx0 || e.x0 > lx1 || e.y1 < ly0 || e.y0 > ly1) continue;
        if (crosses(l.source, l.target, e.l.source, e.l.target)) price += EXPAND_CROSS;
      }
    }
    return price;
  };

  const colPitch = Math.max(...list.map((i) => up[i] + down[i])) + air * 1.01;
  const rowPitch = Math.max(...list.map((i) => 2 * Math.max(left[i], right[i]))) + air * 1.6;
  const files = [[1, 0], [-1, 0], [0, 1], [0, -1]].map((dir) => {
    const column = dir[0] !== 0;

    const turn = column ? (dir[0] === flowX ? 0 : EXPAND_TURN) : EXPAND_TURN / 2 + (dir[1] < 0 ? 0.25 : 0);
    const taken = norm > 0 ? EXPAND_TAKEN * Math.max(0, ((dir[0] * mx + dir[1] * my) / norm - 0.3) / 0.7) : 0;
    const pitch = column ? colPitch : rowPitch;
    return { dir, column, pitch, half: ((list.length - 1) * pitch) / 2, extra: turn + taken };
  });

  const lined = list.filter((i) => toLines.some((l) => l.source === i || l.target === i));
  const measured = lined.length ? lined : list;
  let best = null, tries = 0;
  for (let d = EXPAND_LINK * G; d <= EXPAND_REACH * G && tries < EXPAND_TRIES; d += Math.max(EXPAND_STEP * G, d * EXPAND_GROW)) {

    if (best && (d / G >= best.price || d / G >= best.length * EXPAND_FAR + EXPAND_LINK)) break;
    const step = Math.max(EXPAND_STEP * G, d * EXPAND_GROW);
    for (const file of files) {
      const { dir, column, pitch, half, extra } = file;
      if (best && d / G + extra >= best.price) continue;

      const reach = Math.floor((d * EXPAND_FAN - half) / step + 1e-9);
      for (let k = 0; k <= 2 * reach; k += 1) {
        const shift = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * step;
        if (best && Math.hypot(d, shift) / G + extra >= best.price) break;
        const cx = ox + dir[0] * d + (column ? 0 : shift), cy = oy + dir[1] * d + (column ? shift : 0);
        list.forEach((i, n) => {
          const t = n * pitch - half;
          xs[i] = column ? cx : cx + t;
          ys[i] = column ? cy + t : cy;
        });
        let length = 0;
        for (const i of measured) length += Math.hypot(xs[i] - ox, ys[i] - oy);
        length /= measured.length * G;
        if (best && length + extra >= best.price) continue;
        tries += 1;
        const price = judge();
        if (price === null) continue;
        const total = length + extra + price;
        if (!best || total < best.price) best = { price: total, length: best ? Math.min(best.length, length) : length, at: list.map((i) => [xs[i], ys[i]]) };
      }
    }
  }
  if (!best) {

    const [x0, , x1] = boundsOf(xs, ys, stay, foot);
    const reach = Math.max(...list.map((i) => Math.max(left[i], right[i])));
    const x = flowX > 0 ? x1 + reach + LAYER_AIR * G : x0 - reach - LAYER_AIR * G;
    const half = ((list.length - 1) * colPitch) / 2;
    list.forEach((i, n) => { xs[i] = x; ys[i] = oy + n * colPitch - half; });
    return;
  }
  list.forEach((i, n) => { [xs[i], ys[i]] = best.at[n]; });
}

function loneBlock(lone, foot, rows) {
  const { left, right, up, down, G } = foot;
  const n = lone.length;
  let widest = 0, tallest = 0, top = 0;
  for (const i of lone) {
    widest = Math.max(widest, 2 * Math.max(left[i], right[i]));
    tallest = Math.max(tallest, up[i] + down[i]);
    top = Math.max(top, up[i]);
  }
  const across = widest + AIR * G * 1.6, down_ = tallest + AIR * G * 1.4;
  const short = Math.floor(n / rows), long = n - short * rows;
  const most = short + (long > 0 ? 1 : 0);
  const spots = [];
  for (let r = 0; r < rows; r += 1) {
    const count = r < rows - long ? short : short + 1;
    const indent = ((most - count) * across) / 2;
    for (let k = 0; k < count; k += 1) spots.push([indent + widest / 2 + k * across, r * down_ + top]);
  }
  return { w: most * across - (across - widest), h: rows * down_ - (down_ - tallest), spots, rows };
}

function loneBlocks(lone, foot) {
  const n = lone.length, rows = new Set();
  for (let r = 1; r <= Math.min(n, 40); r += 1) rows.add(r);
  for (let c = 1; c <= Math.min(n, 40); c += 1) rows.add(Math.ceil(n / c));
  return [...rows].sort((a, b) => a - b).map((r) => loneBlock(lone, foot, r));
}

function footprintGrid(stay, xs, ys, foot, air) {
  const { left, right, up, down, G } = foot;
  const cell = 4 * G, buckets = new Map();
  const keyOf = (cx, cy) => cx * 73856093 ^ cy * 19349663;
  for (const j of stay) {
    const cx0 = Math.floor((xs[j] - left[j] - air) / cell), cx1 = Math.floor((xs[j] + right[j] + air) / cell);
    const cy0 = Math.floor((ys[j] - up[j] - air) / cell), cy1 = Math.floor((ys[j] + down[j] + air) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) for (let cy = cy0; cy <= cy1; cy += 1) {
      const k = keyOf(cx, cy);
      (buckets.get(k) ?? buckets.set(k, []).get(k)).push(j);
    }
  }
  return (i, x, y) => {
    const cx0 = Math.floor((x - left[i]) / cell), cx1 = Math.floor((x + right[i]) / cell);
    const cy0 = Math.floor((y - up[i]) / cell), cy1 = Math.floor((y + down[i]) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) for (let cy = cy0; cy <= cy1; cy += 1) {
      for (const j of buckets.get(keyOf(cx, cy)) ?? []) {
        if (x + right[i] + air <= xs[j] - left[j] || xs[j] + right[j] + air <= x - left[i]) continue;
        if (y + down[i] + air <= ys[j] - up[j] || ys[j] + down[j] + air <= y - up[i]) continue;
        return true;
      }
    }
    return false;
  };
}

const SLIDE_STEP = 0.05;
export function slideStop(xs, ys, members, ux, uy, length, foot) {
  const { G } = foot;
  const air = AIR * G, step = SLIDE_STEP * G;
  const moving = new Uint8Array(xs.length);
  for (const i of members) moving[i] = 1;

  const stay = [];
  for (let j = 0; j < xs.length; j += 1) if (!moving[j]) stay.push(j);
  const hits = footprintGrid(stay, xs, ys, foot, air);
  const clear = (s) => {
    const dx = ux * s, dy = uy * s;
    for (const i of members) if (hits(i, xs[i] + dx, ys[i] + dy)) return false;
    return true;
  };
  let stop = 0;
  for (let s = step; s < length; s += step) if (clear(s)) stop = s;
  const nearest = (at) => {
    if (clear(at)) return at;
    for (let d = step; d <= 2 * length + step; d += step) {
      if (at - d >= -2 * length && clear(at - d)) return at - d;
      if (at + d <= stop && clear(at + d)) return at + d;
    }
    return 0;
  };
  return { stop, clear, nearest };
}

function boundsOf(xs, ys, members, foot) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of members) {
    x0 = Math.min(x0, xs[i] - foot.left[i]); x1 = Math.max(x1, xs[i] + foot.right[i]);
    y0 = Math.min(y0, ys[i] - foot.up[i]); y1 = Math.max(y1, ys[i] + foot.down[i]);
  }
  return [x0, y0, x1, y1];
}

function twinRoutes(positions, links, count, G) {
  const routes = new Array(links.length).fill(null);
  const pairOf = new Map();
  links.forEach((l, id) => {
    if (l.source === l.target) return;
    const key = Math.min(l.source, l.target) * count + Math.max(l.source, l.target);
    (pairOf.get(key) ?? pairOf.set(key, []).get(key)).push(id);
  });
  let any = false;
  for (const ids of pairOf.values()) {
    if (ids.length < 2) continue;
    any = true;
    ids.forEach((id, k) => {
      const l = links[id];
      const ax = positions[l.source * 2], ay = positions[l.source * 2 + 1];
      const bx = positions[l.target * 2], by = positions[l.target * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const sign = (l.source < l.target ? 1 : -1) * (k % 2 === 0 ? 1 : -1) * Math.ceil((k + 1) / 2);
      const nx = (-(by - ay) / len) * TWIN * G * sign, ny = ((bx - ax) / len) * TWIN * G * sign;
      routes[id] = [ax + nx, ay + ny, bx + nx, by + ny];
    });
  }
  return any ? routes : null;
}

export const SPACE = 4096;
export const CENTER = SPACE / 2;
export const MAX_RADIUS = SPACE / 2 - 150;
const TAU = Math.PI * 2;

export const NODE_GAP = 80;

const LINK_LENGTH = 1.38;

const SPREAD_NEAR = 1;
const SPREAD_FAR = 2.5;
const SPREAD_FROM = 4;
const SPREAD_TO = 10;
const spreadFor = (n) => SPREAD_NEAR + (SPREAD_FAR - SPREAD_NEAR)
  * clamp((n - SPREAD_FROM) / (SPREAD_TO - SPREAD_FROM), 0, 1);

const ROW_MAX = 6;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const SPIRAL_C = 1.546;

const JITTER = 0.22;
const JITTER_ALLOWANCE = 1.1282;

const STRETCH = 0.5;
const ASPECT_MAX = 2.6;

function scatter(n, aspect, count) {
  const out = new Float32Array(n * 2);
  if (n === 1) return { positions: out, shrink: 1 };
  const spread = spreadFor(count);

  if (n <= ROW_MAX) {
    const step = NODE_GAP * spread * LINK_LENGTH;
    const left = -((n - 1) * step) / 2;
    for (let i = 0; i < n; i += 1) out[i * 2] = left + i * step;
    return { positions: out, shrink: 1 };
  }

  const stretch = clamp(aspect, 1 / ASPECT_MAX, ASPECT_MAX) ** STRETCH;

  const reach = Math.max(stretch, 1 / stretch);
  const ideal = (NODE_GAP * spread * Math.sqrt(n) * JITTER_ALLOWANCE * reach) / SPIRAL_C;
  const radius = Math.min(MAX_RADIUS / reach, ideal);

  const squeeze = radius / ideal;
  const nudge = NODE_GAP * JITTER;
  for (let i = 0; i < n; i += 1) {

    const r = radius * Math.sqrt((i + 0.5) / n);
    const a = i * GOLDEN_ANGLE;

    const jx = ((i * 0.7548776662) % 1 - 0.5) * nudge;
    const jy = ((i * 0.5698402910) % 1 - 0.5) * nudge;
    out[i * 2] = (r * Math.cos(a) + jx) * stretch;
    out[i * 2 + 1] = (r * Math.sin(a) + jy) / stretch;
  }
  return { positions: out, shrink: squeeze };
}

const SCAN_RADIUS = 7;

const FAN_MAX = Math.PI * 0.62;

const FAN_MIN = Math.PI * 0.28;

const FAN_DEFAULT = 0;

const RELAX_PASSES = 24;
const FAN_SLACK = Math.PI * 0.18;

const LEVEL_ANGLE = 0.55;

const LEVEL_MAX = 6;

const REACH_SLACK = 1.5;

const FAN_WIDENING = [1, 1.6, 2.6, 4.5];

const LEVEL_SEARCH_MAX = 150;

const LEVEL_FLAT_MAX = 4;

const LEVEL_STEP = 0.62;

const EDGE_CLEAR = 0.55;
const EDGE_PASSES = 8;

const isPlaced = (placed, i) => (placed ? placed[i] === 1 : true);

function freeBearing(positions, count, hub, skip, gap, placed) {
  const range = gap * SCAN_RADIUS;
  const blocked = [];
  for (let i = 0; i < count; i += 1) {
    if (skip.has(i) || !isPlaced(placed, i)) continue;
    const dx = positions[i * 2] - hub[0];
    const dy = positions[i * 2 + 1] - hub[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-3 || d > range) continue;
    blocked.push({ at: Math.atan2(dy, dx), half: Math.asin(Math.min(1, gap / 2 / d)) });
  }

  if (blocked.length === 0) return { bearing: FAN_DEFAULT, half: Math.PI, full: true };

  const edges = blocked
    .map((b) => ({ from: b.at - b.half, to: b.at + b.half }))
    .sort((a, b) => a.from - b.from);
  let best = { bearing: FAN_DEFAULT, half: 0 };
  let reach = edges[0].to;
  for (let i = 1; i <= edges.length; i += 1) {

    const next = i < edges.length ? edges[i] : { from: edges[0].from + TAU, to: 0 };
    const opening = next.from - reach;
    if (opening > best.half * 2) {
      best = { bearing: (reach + next.from) / 2, half: opening / 2 };
    }
    reach = Math.max(reach, next.to);
  }
  return { bearing: best.bearing, half: clamp(best.half, FAN_MIN, FAN_MAX), full: false };
}

function relax(
  positions, count, arrivals, hub, gap, bearing, half, placed,
  aimed = null, mutual = gap,
) {
  const moving = new Set(arrivals);
  const limit = bearing === null ? 0 : Math.min(Math.PI * 0.92, half + FAN_SLACK);
  const near = neighbours(positions, count, arrivals, moving, placed, Math.max(gap, mutual));
  for (let pass = 0; pass < RELAX_PASSES; pass += 1) {
    let worst = 0;
    for (const i of arrivals) {
      let around = near.around(i);
      for (let k = 0; k < around.length; k += 1) {
        const j = around[k];
        if (j === i) continue;
        let dx = positions[i * 2] - positions[j * 2];
        let dy = positions[i * 2 + 1] - positions[j * 2 + 1];
        let d = Math.hypot(dx, dy);
        const owed = moving.has(j) ? mutual : gap;
        if (d >= owed) continue;
        if (d < 1e-6) {
          const a = Math.atan2(positions[i * 2 + 1] - hub[1], positions[i * 2] - hub[0]);
          dx = Math.cos(a) || 1; dy = Math.sin(a); d = 1;
        }

        const push = ((owed - d) / d) * (moving.has(j) ? 0.5 : 1);
        positions[i * 2] += dx * push;
        positions[i * 2 + 1] += dy * push;
        worst = Math.max(worst, owed - d);

        if (near.strayed(i)) { around = near.around(i, j); k = -1; }
      }

      if (bearing !== null && !aimed?.has(i)) {
        const ax = positions[i * 2] - hub[0];
        const ay = positions[i * 2 + 1] - hub[1];
        let off = Math.atan2(ay, ax) - bearing;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        if (Math.abs(off) > limit) {
          const r = Math.hypot(ax, ay);
          const to = bearing + Math.sign(off) * limit;
          positions[i * 2] = hub[0] + r * Math.cos(to);
          positions[i * 2 + 1] = hub[1] + r * Math.sin(to);
        }
      }
      near.moved(i);
    }
    if (worst < gap * 0.01) break;
  }
}

function neighbours(positions, count, movers, moving, placed, reach) {
  const cell = reach > 0 && Number.isFinite(reach) ? reach : 1;
  const slack = cell, span = cell + slack;
  const at = (v) => Math.floor(v / cell);
  const key = (cx, cy) => (cx & 0xfffff) * 0x100000 + (cy & 0xfffff);
  let cells = new Map();
  let box = null;
  const home = new Map();
  const anchor = [0, 0];

  const put = (j) => {
    const k = key(at(positions[j * 2]), at(positions[j * 2 + 1]));
    const held = cells.get(k);
    if (held) held.push(j); else cells.set(k, [j]);
    return k;
  };
  const index = (x0, y0, x1, y1) => {
    cells = new Map();
    box = [x0, y0, x1, y1];
    for (const i of movers) home.set(i, put(i));
    for (let j = 0; j < count; j += 1) {
      if (!isPlaced(placed, j) || moving.has(j)) continue;
      const x = positions[j * 2], y = positions[j * 2 + 1];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) put(j);
    }
  };

  return {

    around(i, after = -1) {
      const x = positions[i * 2], y = positions[i * 2 + 1];
      anchor[0] = x; anchor[1] = y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {

        const all = [];
        for (let j = after + 1; j < count; j += 1) if (moving.has(j) || isPlaced(placed, j)) all.push(j);
        return all;
      }
      if (!box || x - span < box[0] || y - span < box[1] || x + span > box[2] || y + span > box[3]) {
        const room = span * 8;
        index(
          Math.min(box ? box[0] : Infinity, x - room), Math.min(box ? box[1] : Infinity, y - room),
          Math.max(box ? box[2] : -Infinity, x + room), Math.max(box ? box[3] : -Infinity, y + room));
      }
      const out = [];
      for (let cx = at(x - span); cx <= at(x + span); cx += 1) {
        for (let cy = at(y - span); cy <= at(y + span); cy += 1) {
          const held = cells.get(key(cx, cy));
          if (held) for (const j of held) if (j > after) out.push(j);
        }
      }
      return out.sort((a, b) => a - b);
    },
    strayed(i) {
      return !(Math.hypot(positions[i * 2] - anchor[0], positions[i * 2 + 1] - anchor[1]) <= slack);
    },

    moved(i) {
      const was = home.get(i);
      const now = key(at(positions[i * 2]), at(positions[i * 2 + 1]));
      if (was === now) return;
      const held = cells.get(was);
      held.splice(held.indexOf(i), 1);
      home.set(i, put(i));
    },
  };
}

function clearLinks(positions, links, movable, gap, exempt = null) {
  const free = movable instanceof Set ? movable : new Set(movable);
  const moved = new Set();
  if (free.size === 0 || links.length === 0) return moved;

  const margin = gap * EDGE_CLEAR * 0.95;
  const along = beside(positions, free, margin);

  for (let pass = 0; pass < EDGE_PASSES; pass += 1) {
    let worst = 0;
    for (const { source: a, target: b } of links) {
      if (a === b) continue;
      const ax = positions[a * 2], ay = positions[a * 2 + 1];
      const dx = positions[b * 2] - ax, dy = positions[b * 2 + 1] - ay;
      const length = dx * dx + dy * dy;
      if (length < 1e-9) continue;
      for (const i of along.link(ax, ay, dx, dy)) {
        if (i === a || i === b) continue;
        if (exempt && exempt(a, b, i)) continue;
        const px = positions[i * 2] - ax, py = positions[i * 2 + 1] - ay;
        const t = (px * dx + py * dy) / length;
        if (t <= 0 || t >= 1) continue;
        const ox = px - t * dx, oy = py - t * dy;
        let d = Math.hypot(ox, oy);
        let nx, ny;
        if (d < 1e-6) {

          const flip = i % 2 === 0 ? 1 : -1;
          const norm = Math.hypot(dx, dy);
          nx = (-dy / norm) * flip; ny = (dx / norm) * flip; d = 0;
        } else { nx = ox / d; ny = oy / d; }
        if (d >= margin) continue;
        positions[i * 2] += nx * (margin - d);
        positions[i * 2 + 1] += ny * (margin - d);
        along.moved(i);
        moved.add(i);
        worst = Math.max(worst, margin - d);
      }
    }
    if (worst < gap * 0.02) break;
  }
  return moved;
}

function beside(positions, free, margin) {
  const cell = margin > 0 && Number.isFinite(margin) ? margin * 2 : 1;
  const at = (v) => Math.floor(v / cell);
  const key = (cx, cy) => (cx & 0xfffff) * 0x100000 + (cy & 0xfffff);
  const everyone = [...free];
  const nobody = [];
  const rank = new Map(everyone.map((i, order) => [i, order]));
  const cells = new Map();
  const home = new Map();

  const box = [Infinity, Infinity, -Infinity, -Infinity];

  let wild = false;
  const put = (i) => {
    const x = positions[i * 2], y = positions[i * 2 + 1];
    const k = key(at(x), at(y));
    const held = cells.get(k);
    if (held) held.push(i); else cells.set(k, [i]);
    home.set(i, k);
  };
  const grow = (i) => {
    const x = positions[i * 2], y = positions[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) { wild = true; return; }
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  };
  for (const i of everyone) { put(i); grow(i); }

  return {
    link(ax, ay, dx, dy) {
      if (wild) return everyone;
      if (Math.max(ax, ax + dx) + margin < box[0] || Math.min(ax, ax + dx) - margin > box[2]
        || Math.max(ay, ay + dy) + margin < box[1] || Math.min(ay, ay + dy) - margin > box[3]) return nobody;
      const steps = Math.ceil(Math.hypot(dx, dy) / (cell / 2));
      if (!Number.isFinite(steps) || steps * 9 > everyone.length) return everyone;
      const seen = new Set();
      const out = [];
      for (let s = 0; s <= steps; s += 1) {
        const t = steps === 0 ? 0 : s / steps;
        const cx = at(ax + dx * t), cy = at(ay + dy * t);
        for (let ox = -1; ox <= 1; ox += 1) {
          for (let oy = -1; oy <= 1; oy += 1) {
            const k = key(cx + ox, cy + oy);
            if (seen.has(k)) continue;
            seen.add(k);
            const held = cells.get(k);
            if (held) for (const i of held) out.push(i);
          }
        }
      }
      return out.sort((p, q) => rank.get(p) - rank.get(q));
    },
    moved(i) {
      grow(i);
      const was = home.get(i);
      const now = key(at(positions[i * 2]), at(positions[i * 2 + 1]));
      if (was === now) return;
      const held = cells.get(was);
      held.splice(held.indexOf(i), 1);
      put(i);
    },
  };
}

function orderArrivals(arrivals, links, hubIndex, placed) {
  if (!links || arrivals.length < 3) return arrivals;
  const at = new Map(arrivals.map((v, i) => [v, i]));
  const adjacency = arrivals.map(() => []);

  const expecting = new Map();
  let any = false;
  for (const { source, target } of links) {
    const a = at.get(source), b = at.get(target);
    if (a !== undefined && b !== undefined) {
      if (a === b) continue;
      adjacency[a].push(b);
      adjacency[b].push(a);
      any = true;
      continue;
    }

    const inside = a !== undefined ? a : b;
    if (inside === undefined) continue;
    const outside = a !== undefined ? target : source;
    if (outside === hubIndex || isPlaced(placed, outside)) continue;
    const group = expecting.get(outside);
    if (group) group.push(inside); else expecting.set(outside, [inside]);
  }

  for (const group of expecting.values()) {
    for (let i = 1; i < group.length; i += 1) {
      if (group[i] === group[0]) continue;
      adjacency[group[0]].push(group[i]);
      adjacency[group[i]].push(group[0]);
      any = true;
    }
  }
  if (!any) return arrivals;

  const seen = new Uint8Array(arrivals.length);
  const out = [];
  for (let start = 0; start < arrivals.length; start += 1) {
    if (seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      out.push(arrivals[queue[head]]);
      for (const j of adjacency[queue[head]]) {
        if (seen[j]) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return out;
}

function crowded(around, level, R, delta, target) {
  const { order, turn, angle } = around;
  const n = order.length;
  const x = new Float64Array(n), y = new Float64Array(n), r = new Float64Array(n);
  for (let p = 0; p < n; p += 1) {
    const k = order[p];
    r[p] = R + level[k] * delta;

    x[p] = r[p] * Math.cos(angle[k]);
    y[p] = r[p] * Math.sin(angle[k]);
  }

  const bound = target * (1 + 1e-9);
  const reach = R > bound ? Math.asin(bound / R) : Infinity;
  for (let p = 0; p < n; p += 1) {
    for (let step = 1; step < n; step += 1) {
      const q = (p + step) % n;

      if (reach !== Infinity && (turn[q] - turn[p] + TAU) % TAU >= reach) break;
      if (Math.hypot(x[p] - x[q], y[p] - y[q]) < target) return true;
      const t = (x[p] * x[q] + y[p] * y[q]) / (r[q] * r[q]);
      if (t > 0 && t < 1 && Math.hypot(x[p] - t * x[q], y[p] - t * y[q]) / EDGE_CLEAR < target) return true;
      const u = (x[q] * x[p] + y[q] * y[p]) / (r[p] * r[p]);
      if (u > 0 && u < 1 && Math.hypot(x[q] - u * x[p], y[q] - u * y[p]) / EDGE_CLEAR < target) return true;
    }
  }
  return false;
}

function fanRadius(angle, level, delta, target, n) {

  const order = Array.from({ length: angle.length }, (_, k) => k);
  const wrapped = (k) => ((angle[k] % TAU) + TAU) % TAU;
  order.sort((a, b) => wrapped(a) - wrapped(b) || a - b);
  const around = { order, turn: Float64Array.from(order, wrapped), angle };

  let lo = 0;

  let hi = target / (2 * Math.sin(Math.PI / Math.max(n, 3))) + target;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (crowded(around, level, mid, delta, target)) lo = mid; else hi = mid;
  }
  return hi;
}

function fanOut(
  positions, count, arrivals, hubIndex, gap, placed = null, links = null,
  spread = null, tighten = 1,
) {
  if (arrivals.length === 0) return positions;
  const hub = hubIndex >= 0
    ? [positions[hubIndex * 2], positions[hubIndex * 2 + 1]]
    : [CENTER, CENTER];

  const own = new Set(arrivals);
  const skip = new Set(arrivals);
  skip.add(hubIndex);
  const { bearing, half, full } = freeBearing(positions, count, hub, skip, gap, placed);

  const target = gap * (spread ?? spreadFor(count));

  const inner = target * tighten;

  const order = orderArrivals(arrivals, links, hubIndex, placed);
  const n = order.length;

  const widths = [];
  for (const factor of FAN_WIDENING) {
    const w = full ? Math.PI : Math.min(Math.PI, half * factor);
    if (!widths.some((v) => Math.abs(v - w) < 1e-6)) widths.push(w);
    if (w >= Math.PI) break;
  }

  const want = new Map();
  if (links) {
    for (const a of order) {
      let sx = 0, sy = 0, seen = 0;
      for (const l of links) {
        const other = l.source === a ? l.target : (l.target === a ? l.source : -1);
        if (other < 0 || other === hubIndex || own.has(other) || !isPlaced(placed, other)) continue;
        sx += positions[other * 2] - hub[0];
        sy += positions[other * 2 + 1] - hub[1];
        seen += 1;
      }
      if (seen > 0 && (sx !== 0 || sy !== 0)) want.set(a, Math.atan2(sy, sx));
    }
  }

  const level = new Float64Array(n);
  const angle = new Float64Array(n);
  const slot = order.slice();
  const delta = target * LEVEL_STEP;
  const shape = (width) => {
    const closed = width >= Math.PI - 1e-6;
    const span = closed ? TAU : 2 * width;
    const stepAt = n > 1 ? (closed ? TAU / n : span / (n - 1)) : 0;
    const start = closed ? bearing : bearing - span / 2;
    for (let k = 0; k < n; k += 1) { angle[k] = start + k * stepAt; slot[k] = order[k]; }
    if (want.size === 0) return { closed, stepAt };

    const free = new Set(angle.keys());
    const rest = [];
    for (const a of order) {
      const aim = want.get(a);
      if (aim === undefined) { rest.push(a); continue; }
      let pick = -1, near = Infinity;
      for (const k of free) {
        const off = Math.abs(Math.atan2(Math.sin(angle[k] - aim), Math.cos(angle[k] - aim)));
        if (off < near) { near = off; pick = k; }
      }
      slot[pick] = a;
      angle[pick] = aim;
      free.delete(pick);
    }
    let at = 0;
    for (const k of [...free].sort((x, y) => x - y)) { slot[k] = rest[at]; at += 1; }
    return { closed, stepAt };
  };

  let best = null;
  if (n === 1) {
    shape(widths[0]);
    level[0] = 0;
    best = { base: target * LINK_LENGTH, levels: 1, width: widths[0], closed: false };
  } else {
    for (const width of widths) {
      const { closed, stepAt } = shape(width);
      const ceiling = n > LEVEL_SEARCH_MAX
        ? clamp(Math.round(LEVEL_ANGLE / Math.max(stepAt, 1e-6)), 2, Math.min(LEVEL_MAX, n))
        : Math.min(LEVEL_MAX, n);

      const floor = n > LEVEL_SEARCH_MAX ? ceiling : (n <= LEVEL_FLAT_MAX ? 1 : 2);
      let here = null;
      for (let levels = floor; levels <= ceiling; levels += 1) {
        for (let k = 0; k < n; k += 1) level[k] = k % levels;
        const base = fanRadius(angle, level, delta, target, n);
        const outer = base + (levels - 1) * delta;

        const ratio = outer / base;
        if (!here || outer < here.outer - 1e-6
          || (Math.abs(outer - here.outer) < 1e-6 && ratio < here.ratio)) {
          here = { base, levels, outer, ratio, width, closed, stepAt };
        }
      }
      if (!best || here.outer < best.outer - 1e-6
        || (Math.abs(here.outer - best.outer) < 1e-6 && here.width < best.width)) {
        best = here;
      }
    }
  }

  const { closed } = shape(best.width);
  for (let k = 0; k < n; k += 1) level[k] = k % best.levels;
  const wedge = best.width;

  const base = Math.max(best.base, target * LINK_LENGTH) * tighten;

  for (let k = 0; k < n; k += 1) {
    const r = base + level[k] * delta * tighten;
    positions[slot[k] * 2] = hub[0] + r * Math.cos(angle[k]);
    positions[slot[k] * 2 + 1] = hub[1] + r * Math.sin(angle[k]);
  }

  if (want.size > 0) {
    let cx = 0, cy = 0, seen = 0;
    for (let j = 0; j < count; j += 1) {
      if (own.has(j) || !isPlaced(placed, j)) continue;
      cx += positions[j * 2]; cy += positions[j * 2 + 1]; seen += 1;
    }
    if (seen > 0) {
      cx /= seen; cy /= seen;
      for (const [a, ] of want) {

        let other = -1, many = false;
        for (const l of links) {
          const o = l.source === a ? l.target : (l.target === a ? l.source : -1);
          if (o < 0 || o === hubIndex || own.has(o) || !isPlaced(placed, o)) continue;
          if (other >= 0) { many = true; break; }
          other = o;
        }
        if (many || other < 0) continue;
        const dx = positions[other * 2] - hub[0], dy = positions[other * 2 + 1] - hub[1];
        const apart = Math.hypot(dx, dy);
        const reach = Math.max(base, apart / 2 + 1e-6);
        if (apart < 1e-6 || apart > 2 * reach) continue;
        const half = apart / 2;
        const rise = Math.sqrt(Math.max(0, reach * reach - half * half));
        const mx = hub[0] + dx / 2, my = hub[1] + dy / 2;
        const px = -dy / apart, py = dx / apart;
        const one = [mx + px * rise, my + py * rise];
        const two = [mx - px * rise, my - py * rise];
        const pick = Math.hypot(one[0] - cx, one[1] - cy)
          >= Math.hypot(two[0] - cx, two[1] - cy) ? one : two;
        positions[a * 2] = pick[0];
        positions[a * 2 + 1] = pick[1];
      }
    }
  }

  const aim = closed ? null : bearing;
  relax(positions, count, arrivals, hub, target, aim, wedge, placed, want, inner);
  if (links) {

    const drawn = placed
      ? links.filter((l) => isPlaced(placed, l.source) && isPlaced(placed, l.target))
      : links;
    const moved = clearLinks(positions, drawn, arrivals, target,
      (a2, b2, i) => own.has(i)
        && ((a2 === hubIndex && own.has(b2)) || (b2 === hubIndex && own.has(a2))));
    if (moved.size > 0) {
      relax(positions, count, [...moved], hub, target, aim, wedge, placed, want, inner);
    }

    const again = clearLinks(positions, drawn, arrivals, target,
      (a2, b2, i) => own.has(i)
        && ((a2 === hubIndex && own.has(b2)) || (b2 === hubIndex && own.has(a2))));
    if (again.size > 0) {
      relax(positions, count, [...again], hub, target, aim, wedge, placed, want, inner);
    }
  }

  const laid = base + (best.levels - 1) * delta * tighten;
  const ceiling = laid * REACH_SLACK;
  for (let round = 0; round < 2; round += 1) {
    let far = 0;
    for (const i of arrivals) {
      far = Math.max(far, Math.hypot(
        positions[i * 2] - hub[0], positions[i * 2 + 1] - hub[1]));
    }
    if (far <= ceiling) break;
    const pull = ceiling / far;
    for (const i of arrivals) {
      positions[i * 2] = hub[0] + (positions[i * 2] - hub[0]) * pull;
      positions[i * 2 + 1] = hub[1] + (positions[i * 2 + 1] - hub[1]) * pull;
    }
    if (round === 0) {
      relax(positions, count, arrivals, hub, target, aim, wedge, placed, want, inner);
    }
  }
  return positions;
}

function components(count, links) {
  const adjacency = Array.from({ length: count }, () => []);
  for (const { source: a, target: b } of links) {
    if (a === b) continue;
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  const seen = new Uint8Array(count);
  const out = [];
  for (let start = 0; start < count; start += 1) {
    if (seen[start]) continue;
    const members = [start];
    seen[start] = 1;
    for (let head = 0; head < members.length; head += 1) {
      for (const next of adjacency[members[head]]) {
        if (seen[next]) continue;
        seen[next] = 1;
        members.push(next);
      }
    }
    out.push({ members, adjacency });
  }
  return out;
}

function placeComponent(members, adjacency, count) {
  const n = members.length;
  const out = new Float32Array(n * 2);
  const local = new Map(members.map((global, i) => [global, i]));

  let focus = 0;
  for (let i = 1; i < n; i += 1) {
    if (adjacency[members[i]].length > adjacency[members[focus]].length) focus = i;
  }

  const inner = [];
  for (let i = 0; i < n; i += 1) {
    for (const neighbour of adjacency[members[i]]) {
      const j = local.get(neighbour);
      if (j !== undefined && j > i) inner.push({ source: i, target: j });
    }
  }

  const placed = new Uint8Array(n);
  const parent = new Int32Array(n).fill(-1);
  placed[focus] = 1;
  const queue = [focus];
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head];
    const arrivals = [];
    for (const neighbour of adjacency[members[i]]) {
      const j = local.get(neighbour);
      if (j === undefined || placed[j]) continue;
      placed[j] = 1;
      arrivals.push(j);
      queue.push(j);
    }

    if (arrivals.length === 0) continue;
    for (const j of arrivals) parent[j] = i;

    fanOut(out, n, arrivals, i, NODE_GAP, placed, inner, spreadFor(count));
  }

  const every = Array.from({ length: n }, (_, i) => i);
  const target = NODE_GAP * spreadFor(count);
  const sameFan = (a, b, i) => parent[i] >= 0
    && ((parent[b] === parent[i] && parent[i] === a)
      || (parent[a] === parent[i] && parent[i] === b));
  const moved = clearLinks(out, inner, every, target, sameFan);
  if (moved.size > 0) {

    relax(out, n, [...moved], [0, 0], target, null, 0, null);
  }

  let reach = 0;
  for (let i = 0; i < n; i += 1) {
    reach = Math.max(reach, Math.hypot(out[i * 2], out[i * 2 + 1]));
  }
  const shrink = reach > MAX_RADIUS ? MAX_RADIUS / reach : 1;
  if (shrink < 1) for (let k = 0; k < n * 2; k += 1) out[k] *= shrink;
  return { positions: out, shrink };
}

function boundsOfPositions(positions) {
  const n = positions.length / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i += 1) {
    x0 = Math.min(x0, positions[i * 2]); x1 = Math.max(x1, positions[i * 2]);
    y0 = Math.min(y0, positions[i * 2 + 1]); y1 = Math.max(y1, positions[i * 2 + 1]);
  }
  if (!Number.isFinite(x0)) { x0 = x1 = y0 = y1 = 0; }
  return { x0, y0, x1, y1, w: x1 - x0 + NODE_GAP, h: y1 - y0 + NODE_GAP };
}

const TILE_GAP = NODE_GAP * 1.9;

const tileGapFor = (spread) => TILE_GAP * (1 + (spread - 1) * 0.2);

const FULLNESS_WEIGHT = 0.35;

function shelve(order, target, tileGap) {
  const shelves = [];
  for (const { tile, i } of order) {
    const width = tile.w + tileGap;
    let shelf = shelves.find((s) => s.width + width <= target);
    if (!shelf) { shelf = { width: 0, height: 0, items: [] }; shelves.push(shelf); }
    shelf.items.push({ i, tile, at: shelf.width });
    shelf.width += width;
    shelf.height = Math.max(shelf.height, tile.h + tileGap);
  }
  return shelves;
}

function place(shelves, tiles, tileGap) {
  const total = shelves.reduce((sum, s) => sum + s.height, 0);
  const offsets = new Array(tiles.length);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let y = -total / 2;
  for (const shelf of shelves) {
    for (const { i, tile, at } of shelf.items) {
      const cx = (tile.x0 + tile.x1) / 2;
      const cy = (tile.y0 + tile.y1) / 2;
      const dx = at - shelf.width / 2 + (tile.w + tileGap) / 2 - cx;
      const dy = y + shelf.height / 2 - cy;
      offsets[i] = { dx, dy };
      x0 = Math.min(x0, tile.x0 + dx); x1 = Math.max(x1, tile.x1 + dx);
      y0 = Math.min(y0, tile.y0 + dy); y1 = Math.max(y1, tile.y1 + dy);
    }
    y += shelf.height;
  }
  return { offsets, width: x1 - x0, height: y1 - y0 };
}

const PACK_TRIES = 256;

function packTiles(tiles, aspect, spread) {
  if (tiles.length === 1) return [{ dx: 0, dy: 0 }];

  const order = tiles.map((tile, i) => ({ tile, i }))
    .sort((a, b) => b.tile.h - a.tile.h || b.tile.w - a.tile.w || a.i - b.i);
  const shape = clamp(aspect, 1 / ASPECT_MAX, ASPECT_MAX);

  const candidates = [];
  let running = 0;
  const tileGap = tileGapFor(spread);
  for (const { tile } of order) { running += tile.w + tileGap; candidates.push(running); }

  const tries = candidates.length <= PACK_TRIES ? candidates : Array.from(
    { length: PACK_TRIES },
    (_, k) => candidates[Math.round((k * (candidates.length - 1)) / (PACK_TRIES - 1))]);

  let best = null;
  for (const target of tries) {
    const laid = place(shelve(order, target, tileGap), tiles, tileGap);
    if (!(laid.width > 0) || !(laid.height > 0)) {

      if (!best) best = { cost: Infinity, offsets: laid.offsets };
      continue;
    }

    const cost = Math.abs(Math.log((laid.width / laid.height) / shape))
      + FULLNESS_WEIGHT * Math.log(laid.width * laid.height);
    if (!best || cost < best.cost - 1e-9) best = { cost, offsets: laid.offsets };
  }
  return best.offsets;
}

export function layout(count, links, aspect = 1) {
  const positions = new Float32Array(count * 2);
  if (count === 0) return { positions, gap: NODE_GAP, clusters: [] };

  const singles = [];
  const tiles = [];
  let shrink = 1;

  for (const { members, adjacency } of components(count, links)) {
    if (members.length === 1) { singles.push(members[0]); continue; }
    const placed = placeComponent(members, adjacency, count);
    shrink = Math.min(shrink, placed.shrink);
    tiles.push({ members, positions: placed.positions, ...boundsOfPositions(placed.positions) });
  }

  if (singles.length > 0) {
    const field = scatter(singles.length, aspect, count);
    shrink = Math.min(shrink, field.shrink);
    tiles.push({
      members: singles, positions: field.positions, ...boundsOfPositions(field.positions),
    });
  }

  const offsets = packTiles(tiles, aspect, spreadFor(count));

  let reach = 0;
  tiles.forEach((tile, t) => {
    const { dx, dy } = offsets[t];
    reach = Math.max(reach,
      Math.abs(tile.x0 + dx), Math.abs(tile.x1 + dx),
      Math.abs(tile.y0 + dy), Math.abs(tile.y1 + dy));
  });
  const fit = reach > MAX_RADIUS ? MAX_RADIUS / reach : 1;

  tiles.forEach((tile, t) => {
    const { dx, dy } = offsets[t];
    tile.members.forEach((global, i) => {
      positions[global * 2] = CENTER + (tile.positions[i * 2] + dx) * fit;
      positions[global * 2 + 1] = CENTER + (tile.positions[i * 2 + 1] + dy) * fit;
    });
  });

  return { positions, gap: NODE_GAP * shrink * fit };
}

export const LAYOUTS = [
  { id: "auto", label: "Auto", group: "auto" },
  { id: "hierarchy-lr", label: "Hierarchy, left to right", group: "layers" },
  { id: "hierarchy-tb", label: "Hierarchy, top to bottom", group: "layers" },
  { id: "organic", label: "Organic", group: "force" },
  { id: "tree", label: "Tree, top down", group: "tree" },
  { id: "tree-bt", label: "Tree, bottom up", group: "tree" },
  { id: "tree-lr", label: "Tree, left to right", group: "tree" },
  { id: "tree-rl", label: "Tree, right to left", group: "tree" },
  { id: "radial-tree", label: "Radial tree", group: "tree" },
  { id: "cluster", label: "Cluster by type", group: "kind" },
];
export const DEFAULT_LAYOUT = "auto";
const FLOWS = { "hierarchy-lr": "right", "hierarchy-tb": "down" };
const TREES = { tree: "down", "tree-bt": "up", "tree-lr": "right", "tree-rl": "left" };
const FREE = { organic: true, "radial-tree": true };

export function layoutWith(id, count, links, context = {}) {
  if (count === 0) return { positions: new Float32Array(0), gap: NODE_GAP, clusters: [], routes: null, layout: id };
  if (!(id in FLOWS || id in TREES || id in FREE || id === "cluster" || id === "auto")) id = "auto";
  const auto = id === "auto";
  const chosen = auto ? autoPick(count, links, context) : { id, ...named(id, count, links, context) };
  id = chosen.id;
  const { drawn, names } = chosen;
  const { xs, ys, heads } = drawn;
  const G = NODE_GAP;
  spread(xs, ys, heads, drawn.foot, links.length > 0, context);

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < count; i += 1) {
    x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const reach = Math.max((x1 - x0) / 2, (y1 - y0) / 2, 1);
  const fit = reach > MAX_RADIUS ? MAX_RADIUS / reach : 1;
  const positions = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    positions[i * 2] = CENTER + (xs[i] - mx) * fit;
    positions[i * 2 + 1] = CENTER - (ys[i] - my) * fit;
  }
  const clusters = heads.map((h) => ({
    kind: h.kind, count: h.count,
    x: CENTER + (h.x - mx) * fit,
    y: CENTER - (h.y - my) * fit,
    w: h.w * fit, h: G * fit,
  }));
  return { positions, gap: G * fit, clusters, routes: twinRoutes(positions, links, count, G * fit), names, layout: id, auto };
}

const AUTO_LEGIBLE = 0.75;
const AUTO_COMPARE_MAX = 300;
const AUTO_DENSE = 1.5;
function autoPick(count, links, context) {
  const only = (id) => ({ id, ...named(id, count, links, context) });
  if (links.length === 0) return only("hierarchy-lr");
  if (count > AUTO_COMPARE_MAX || links.length > AUTO_DENSE * count) return only("organic");
  const room = context.room ?? { width: 1166, height: 870 };
  const most = context.gapPx ? context.gapPx * FOOTPRINT_NAME : Infinity;
  const [flow, organic] = ["hierarchy-lr", "organic"].map((id) => {
    const one = only(id);
    return { ...one, size: Math.min(most, legible(one.drawn, room)), crossings: crossingsOf(one.drawn, links) };
  });
  return flow.crossings <= organic.crossings && flow.size >= AUTO_LEGIBLE * organic.size ? flow : organic;
}
function crossingsOf({ xs, ys }, links) {
  const orient = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  let n = 0;
  for (let p = 0; p < links.length; p += 1) {
    const a = links[p].source, b = links[p].target;
    for (let q = p + 1; q < links.length; q += 1) {
      const c = links[q].source, d = links[q].target;
      if (a === c || a === d || b === c || b === d) continue;
      if (orient(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c]) * orient(xs[a], ys[a], xs[b], ys[b], xs[d], ys[d]) < 0
        && orient(xs[c], ys[c], xs[d], ys[d], xs[a], ys[a]) * orient(xs[c], ys[c], xs[d], ys[d], xs[b], ys[b]) < 0) n += 1;
    }
  }
  return n;
}

const SPREAD_FILL = 0.72;
const SPREAD_MAX = 3.2;
const SPREAD_SKEW = 1.6;
const ROOM_USED = 0.88;
function spread(xs, ys, heads, foot, linked, { room, gapPx } = {}) {
  const count = xs.length;
  if (!room || !gapPx || count < 2) return;
  const all = Array.from({ length: count }, (_, i) => i);
  const [fx0, fy0, fx1, fy1] = boundsOf(xs, ys, all, foot);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const i of all) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }

  const unit = Math.max(foot.G / gapPx, (fx1 - fx0) / (room.width * ROOM_USED), (fy1 - fy0) / (room.height * ROOM_USED));
  const along = (span, total, px) => (span > 1e-9 ? (px * SPREAD_FILL * unit - (total - span)) / span : Infinity);
  let kx = Math.min(SPREAD_MAX, Math.max(1, along(x1 - x0, fx1 - fx0, room.width)));
  let ky = Math.min(SPREAD_MAX, Math.max(1, along(y1 - y0, fy1 - fy0, room.height)));
  if (linked) {

    if (x1 - x0 < 1e-9) kx = ky; else if (y1 - y0 < 1e-9) ky = kx;
    kx = Math.min(kx, ky * SPREAD_SKEW); ky = Math.min(ky, kx * SPREAD_SKEW);
  }
  if (!(kx > 1 + 1e-6 || ky > 1 + 1e-6)) return;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  for (const i of all) { xs[i] = mx + (xs[i] - mx) * kx; ys[i] = my + (ys[i] - my) * ky; }

  for (const h of heads) { h.w += (kx - 1) * (h.inner ?? 0); h.x = mx + (h.x - mx) * kx; h.y += (ky - 1) * (y0 - my); }
}

function named(id, count, links, context) {
  const kinds = context.kinds ?? [];
  const full = context.labels ?? [];
  const short = full.map((label, i) => shortName(label, kinds[i]));
  const shorter = context.room && short.some((name, i) => name !== full[i]);
  let names = shorter && count > FULL_NAMES_MAX ? "short" : "full";
  let drawn = arrangeOn(id, count, links, context, names === "full" ? full : short);
  if (shorter && names === "full" && legible(drawn, context.room) < LEGIBLE_PX) {
    const other = arrangeOn(id, count, links, context, short);
    if (legible(other, context.room) > legible(drawn, context.room)) { drawn = other; names = "short"; }
  }
  return { drawn, names };
}

const LEGIBLE_PX = 8;
const FULL_NAMES_MAX = 200;
function legible({ xs, ys, foot }, room) {
  const count = xs.length;
  const [x0, y0, x1, y1] = boundsOf(xs, ys, Array.from({ length: count }, (_, i) => i), foot);
  const perSpace = Math.min((room.width * 0.88) / Math.max(x1 - x0, 1), (room.height * 0.88) / Math.max(y1 - y0, 1));
  return perSpace * foot.G * FOOTPRINT_NAME;
}

function arrangeOn(id, count, links, context, names) {
  const G = NODE_GAP;
  const aspect = clampAspect(context.aspect ?? 1.6);
  const kinds = context.kinds ?? [];
  const xs = new Float64Array(count), ys = new Float64Array(count);
  const { parts, lone, edges, adj } = split(count, links);

  const loneSet = new Set(lone);
  const all = Array.from({ length: count }, (_, i) => i).filter((i) => !loneSet.has(i));
  const flow = FLOWS[id] ?? TREES[id] ?? (id === "cluster" ? "right" : null);
  const lined = new Map();
  if (id === "cluster" && all.length > 0) {

    const kindsOf = kindColumns(all, edges, adj, kinds);
    for (const part of parts) {
      const present = [...new Set(part.members.map((i) => kinds[i] || ""))]
        .sort((a, b) => kindsOf.kindCol.get(a) - kindsOf.kindCol.get(b));
      const at = new Map(present.map((k, n) => [k, n]));
      const col = new Map(part.members.map((i) => [i, at.get(kinds[i] || "")]));
      const columns = unlineColumns(part.members, adj, col, kindsOf.rank);
      lined.set(part, { lined: columns, order: present, kindCol: at });
    }
  } else if (flow) {
    for (const part of parts) {
      const { col, rank } = id in FLOWS ? flowColumns(part.members, part.edges) : treeColumns(part.members, adj, context.root);
      const columns = unlineColumns(part.members, adj, col, rank);
      lined.set(part, columns);
    }
  }
  const foot = footprints(count, names, G);

  const boxes = [];
  let heads = [];
  if (id === "cluster") {

    for (const part of parts) {
      const own = byKind(part.members, part.edges, lined.get(part), kinds, foot, xs, ys);
      const b = boundsOf(xs, ys, part.members, foot);
      for (const h of own) { b[0] = Math.min(b[0], h.x - h.w / 2); b[1] = Math.min(b[1], h.y - G); b[2] = Math.max(b[2], h.x + h.w / 2); }
      boxes.push({ members: part.members, bounds: b, heads: own });
    }
  } else {
    for (const part of parts) {
      drawPart(id, part, adj, foot, context.root, aspect, xs, ys, lined.get(part));
      boxes.push({ members: part.members, bounds: boundsOf(xs, ys, part.members, foot) });
    }
  }
  if (lone.length > 0) {

    const labels = context.labels ?? [];
    lone.sort((a, b) => String(kinds[a] ?? "").localeCompare(String(kinds[b] ?? ""))
      || String(labels[a] ?? "").localeCompare(String(labels[b] ?? "")) || a - b);
    boxes.push({ lone, shapes: loneBlocks(lone, foot) });
  }

  const packed = pack(boxes.map((b) => (b.lone
    ? { w: b.shapes[0].w, h: b.shapes[0].h, shapes: b.shapes.slice(1) }
    : { w: b.bounds[2] - b.bounds[0], h: b.bounds[3] - b.bounds[1] })), aspect, PART_AIR * G,
  context.room && context.gapPx ? Math.min(context.gapPx, PACK_NAME_PX / FOOTPRINT_NAME) / (G * context.room.height * ROOM_USED) : Infinity);

  const shift = boxes.map((b, k) => {
    const [px, py] = packed.at[k];
    if (b.lone) {
      const shape = packed.shapes[k];
      const block = b.shapes.find((s) => s.w === shape.w && s.h === shape.h) ?? b.shapes[0];
      b.lone.forEach((i, n) => { xs[i] = px + block.spots[n][0]; ys[i] = py + block.spots[n][1]; });
      return [0, 0];
    }
    const dx = px - b.bounds[0], dy = py - b.bounds[1];
    for (const i of b.members) { xs[i] += dx; ys[i] += dy; }
    return [dx, dy];
  });

  const drawnIn = id === "cluster" ? boxes.map(() => [0, 0]) : gather(boxes.map((b) => b.lone ?? b.members), xs, ys, foot, edges);
  boxes.forEach((b, k) => {
    for (const h of b.heads ?? []) heads.push({ ...h, x: h.x + shift[k][0] + drawnIn[k][0], y: h.y + shift[k][1] + drawnIn[k][1] });
  });

  return { xs, ys, heads, foot };
}

const PACK_NAME_PX = 11;
const FOOTPRINT_NAME = FOOTPRINT.dot * FOOTPRINT.label;
const clampAspect = (a) => Math.min(Math.max(Number.isFinite(a) && a > 0 ? a : 1.6, 0.5), 3);

function drawPart(id, part, adj, foot, root, aspect, xs, ys, lined) {
  const { members, edges } = part;
  if (id in FLOWS || id in TREES) {
    const { place } = layeredPart(members, edges, lined.col, foot, FLOWS[id] ?? TREES[id]);
    for (const i of members) { const [x, y] = place.get(i); xs[i] = x; ys[i] = y; }
    return;
  }

  if (id === "organic" && members.length > FORCE_MIN) {
    forcePart(members, edges, foot, xs, ys);
    inflate(xs, ys, members, foot);
    clear(xs, ys, members, edges, foot, 80, false);
    return;
  }

  const local = new Map(members.map((i, k) => [i, k]));
  const sub = edges.map((e) => ({ source: local.get(e.s), target: local.get(e.t) }));
  const r = local.has(root) ? local.get(root) : null;

  const scratch = id === "organic" && members.length > FAN_START_MAX && members.length <= STRESS_MAX;
  if (!scratch) {
    const drawn = id === "radial-tree" ? radialTree(members.length, sub, r) : layout(members.length, sub, aspect);
    members.forEach((i, k) => {
      xs[i] = drawn.positions[k * 2] - CENTER;
      ys[i] = -(drawn.positions[k * 2 + 1] - CENTER);
    });
  }
  if (id === "organic" && members.length <= STRESS_MAX) stressPart(members, adj, foot, xs, ys, 90, scratch);
  inflate(xs, ys, members, foot);
  clear(xs, ys, members, edges, foot);
}
const STRESS_MAX = 900;

const FORCE_MIN = 250;
const FAN_START_MAX = 150;

function kindOrder(byFlow, edges, kinds) {
  const n = byFlow.length;
  if (n < 3) return byFlow;
  const at = new Map(byFlow.map((k, i) => [k, i]));
  const w = Array.from({ length: n }, () => new Float64Array(n));
  for (const e of edges) {
    const a = at.get(kinds[e.s] || ""), b = at.get(kinds[e.t] || "");
    if (a !== b) { w[a][b] += 1; w[b][a] += 1; }
  }
  const cost = (perm) => {
    const place = new Int32Array(n);
    perm.forEach((k, i) => { place[k] = i; });
    let c = 0;
    for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) if (w[a][b]) c += w[a][b] * (Math.abs(place[a] - place[b]) - 1);

    let drift = 0;
    for (let i = 0; i < n; i += 1) drift += Math.abs(place[i] - i);
    return c + drift * 1e-6;
  };
  let best = byFlow.map((_, i) => i), bestCost = cost(best);
  if (n <= 8) {
    const perm = best.slice();
    const walk = (i) => {
      if (i === n) { const c = cost(perm); if (c < bestCost) { bestCost = c; best = perm.slice(); } return; }
      for (let j = i; j < n; j += 1) {
        [perm[i], perm[j]] = [perm[j], perm[i]];
        walk(i + 1);
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
    };
    walk(0);
  } else {
    let better = true;
    while (better) {
      better = false;
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const next = best.slice();
          [next[i], next[j]] = [next[j], next[i]];
          const c = cost(next);
          if (c < bestCost - 1e-9) { best = next; bestCost = c; better = true; }
        }
      }
    }
  }
  return best.map((i) => byFlow[i]);
}

function kindColumns(all, edges, adj, kinds) {
  const { col: flow, rank } = flowColumns(all, edges);
  const score = new Map(), size = new Map();
  for (const i of all) {
    const k = kinds[i] || "";
    size.set(k, (size.get(k) ?? 0) + 1);
    if (adj[i].length === 0) continue;
    const s = score.get(k) ?? [0, 0];
    s[0] += flow.get(i); s[1] += 1;
    score.set(k, s);
  }
  const mean = (k) => (score.get(k) ? score.get(k)[0] / score.get(k)[1] : Infinity);
  const byFlow = [...size.keys()].sort((a, b) => mean(a) - mean(b) || size.get(b) - size.get(a) || (a < b ? -1 : 1));
  const order = kindOrder(byFlow, edges, kinds);
  const kindCol = new Map(order.map((k, n) => [k, n]));
  const col = new Map(all.map((i) => [i, kindCol.get(kinds[i] || "")]));
  return { lined: unlineColumns(all, adj, col, rank), order, kindCol, size, rank };
}

function byKind(all, edges, { lined, order, kindCol }, kinds, foot, xs, ys) {
  const { place, along, span } = layeredPart(all, edges, lined.col, foot, "right", { centre: 0.6 });
  for (const i of all) { const [x, y] = place.get(i); xs[i] = x; ys[i] = y; }

  const G = foot.G;
  let top = Infinity;
  for (const [lo] of span) top = Math.min(top, lo);
  return order.map((kind) => {
    const cols = lined.from.map((c, n) => (c === kindCol.get(kind) ? n : -1)).filter((n) => n >= 0);
    let widest = 0;
    for (const i of all) if ((kinds[i] || "") === kind) widest = Math.max(widest, foot.left[i], foot.right[i]);
    const a0 = along[cols[0]], a1 = along[cols[cols.length - 1]];
    let count = 0;
    for (const i of all) if ((kinds[i] || "") === kind) count += 1;
    return { kind, count, x: (a0 + a1) / 2, y: top - G * 1.1, w: a1 - a0 + 2 * widest, inner: a1 - a0 };
  });
}

function fitted(offsets, count, gap) {
  const positions = new Float32Array(count * 2);
  let reach = 0;
  for (let i = 0; i < count; i += 1) {
    reach = Math.max(reach, Math.abs(offsets[i * 2]), Math.abs(offsets[i * 2 + 1]));
  }
  const fit = reach > MAX_RADIUS ? MAX_RADIUS / reach : 1;
  for (let i = 0; i < count; i += 1) {
    positions[i * 2] = CENTER + offsets[i * 2] * fit;
    positions[i * 2 + 1] = CENTER + offsets[i * 2 + 1] * fit;
  }
  return { positions, gap: gap * fit, clusters: [] };
}

function adjacencyOf(count, links) {
  const adj = Array.from({ length: count }, () => []);
  for (const { source, target } of links) {
    if (source === target) continue;
    adj[source].push(target); adj[target].push(source);
  }
  return adj;
}

function spanningForest(count, links, root) {
  const adj = adjacencyOf(count, links);
  const seen = new Uint8Array(count);
  const children = Array.from({ length: count }, () => []);
  const depth = new Int32Array(count);
  const roots = [];
  const grow = (r) => {
    seen[r] = 1; roots.push(r); depth[r] = 0;
    const queue = [r];
    for (let h = 0; h < queue.length; h += 1) {
      const i = queue[h];
      for (const j of adj[i]) if (!seen[j]) { seen[j] = 1; depth[j] = depth[i] + 1; children[i].push(j); queue.push(j); }
    }
  };
  if (root != null && root >= 0 && root < count) grow(root);
  const byDegree = Array.from({ length: count }, (_, i) => i).sort((a, b) => adj[b].length - adj[a].length || a - b);
  for (const i of byDegree) if (!seen[i]) grow(i);

  const leaves = new Float64Array(count);
  const post = (i) => { let n = 0; for (const j of children[i]) n += post(j); leaves[i] = Math.max(1, n); return leaves[i]; };
  for (const r of roots) post(r);
  for (const kids of children) {
    kids.sort((a, b) => leaves[a] - leaves[b]);

    const out = []; kids.forEach((k, n) => (n % 2 ? out.push(k) : out.unshift(k)));
    kids.splice(0, kids.length, ...out);
  }
  return { roots, children, depth, leaves, adj };
}

function orderByCrossLinks(forest, pos) {
  const { roots, children, adj } = forest;
  const parentOf = new Int32Array(adj.length).fill(-1);
  children.forEach((kids, i) => kids.forEach((k) => { parentOf[k] = i; }));
  const key = new Float64Array(adj.length), weight = new Float64Array(adj.length);
  const walk = (i) => {
    let sum = 0, n = 0;
    for (const j of adj[i]) if (j !== parentOf[i] && parentOf[j] !== i) { sum += pos[j]; n += 1; }
    for (const k of children[i]) { walk(k); sum += key[k] * weight[k]; n += weight[k]; }
    weight[i] = n; key[i] = n ? sum / n : pos[i];
  };
  for (const r of roots) walk(r);
  for (const kids of children) kids.sort((a, b) => key[a] - key[b]);
}

function radialTree(count, links, root) {
  const forest = spanningForest(count, links, root);
  const { roots, children, leaves } = forest;
  const angle = new Float64Array(count);
  const ring = new Float64Array(count);
  const total = roots.reduce((t, r) => t + leaves[r], 0);
  const lone = roots.length === 1;
  const spread = (i, a0, a1, level) => {
    angle[i] = (a0 + a1) / 2;
    ring[i] = level;
    let a = a0;
    for (const j of children[i]) {
      const share = ((a1 - a0) * leaves[j]) / leaves[i];
      spread(j, a, a + share, level + 1);
      a += share;
    }
  };
  const layOut = () => {
    let a = 0;
    for (const r of roots) {
      const share = (TAU * leaves[r]) / total;
      spread(r, a, a + share, lone ? 0 : 1);
      a += share;
    }
  };
  layOut();
  for (let pass = 0; pass < 3; pass += 1) { orderByCrossLinks(forest, angle); layOut(); }

  let deepest = 0;
  for (let i = 0; i < count; i += 1) deepest = Math.max(deepest, ring[i]);
  const step = Math.max(NODE_GAP * 3, (total * NODE_GAP * 1.6) / TAU / Math.max(deepest, 1));
  const offsets = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    offsets[i * 2] = Math.cos(angle[i] - Math.PI / 2) * ring[i] * step;
    offsets[i * 2 + 1] = Math.sin(angle[i] - Math.PI / 2) * ring[i] * step;
  }
  return fitted(offsets, count, NODE_GAP * 1.4);
}

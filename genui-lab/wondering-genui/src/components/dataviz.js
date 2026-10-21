// Data-viz components: flowchart, timeline, bar chart, concept map, cycle, comparison.
// Prop shapes follow the shipped components (FlowchartVisualization @3763043,
// TimelineVisualization @3838112, BarChartVisualization @3778896,
// ConceptMapVisualization @3765098, CycleVisualization @3831670,
// ComparisonVisualization @3816625). The shipped flowchart uses dagre + React Flow;
// here a small layered layout (pure, testable) feeds an SVG renderer.

import { h, s, asRecord, str, normalizeStringList, inlineText, getAccentColor, nextId } from "./dom.js";
import { formatWithUnit } from "./visual.js";

const INK = "#2a1d16"; // INTERACTIVE_COLORS.ink (dark brown)

function emptyState(message) {
  return h("div", { class: "w-empty" }, message);
}

export function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function svgText(lines, x, y, opts = {}) {
  const lh = opts.lineHeight ?? 16;
  const startY = y - ((lines.length - 1) * lh) / 2;
  return s(
    "text",
    { x, y: startY, "text-anchor": opts.anchor ?? "middle", "dominant-baseline": "middle", class: opts.class ?? "w-svg-text", "font-size": opts.size ?? 13, "font-weight": opts.weight ?? 600 },
    lines.map((ln, i) => s("tspan", { x, dy: i === 0 ? 0 : lh }, ln))
  );
}

function arrowMarker(id) {
  return s("defs", null, s("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0,0 L10,5 L0,10 z", fill: "currentColor" })));
}

// ====================================================================== flowchart

// Node dimensions copied from the bundle (PROCESS 172x62, TERMINAL 160x50, DECISION 116).
export function nodeDimensions(type) {
  if (type === "decision") return { width: 116, height: 116 };
  if (type === "start" || type === "end") return { width: 160, height: 50 };
  return { width: 172, height: 62 };
}
// typeColor$1: decision -> accent 4, end -> accent 5, otherwise accent 0.
export function flowTypeColor(type) {
  return getAccentColor(type === "decision" ? 4 : type === "end" ? 5 : 0);
}

const NODESEP = 54;
const RANKSEP = 64;
const MARGIN_X = 32;
const MARGIN_Y = 24;
const BACK_EDGE_LANE = 26;

/** Pure layered (Sugiyama-lite) layout. Returns node boxes + orthogonal edge polylines. */
export function layoutFlowchart(data) {
  const d = asRecord(data);
  const rawNodes = Array.isArray(d.nodes) ? d.nodes : [];
  const rawConns = Array.isArray(d.connections) ? d.connections : [];
  const nodes = rawNodes
    .filter((n, i, arr) => n && typeof n.id === "string" && n.id.trim() && typeof n.label === "string" && n.label.trim() && arr.findIndex((m) => m && m.id === n.id) === i)
    .slice(0, 8);
  const ids = new Set(nodes.map((n) => n.id));
  const conns = rawConns.filter((c) => c && ids.has(c.from) && ids.has(c.to)).slice(0, 12);

  // 1. cycle removal by DFS (start nodes first), marking back edges.
  const out = new Map(nodes.map((n) => [n.id, []]));
  conns.forEach((c, i) => out.get(c.from).push({ to: c.to, i }));
  const state = new Map();
  const back = new Set();
  const order = [...nodes].sort((a, b) => (a.type === "start" ? -1 : 0) - (b.type === "start" ? -1 : 0));
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const st = state.get(e.to);
      if (st === 1) back.add(e.i);
      else if (!st) visit(e.to);
    }
    state.set(id, 2);
  };
  order.forEach((n) => state.get(n.id) || visit(n.id));

  // 2. longest-path ranking over forward edges (self loops ignored).
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  const fwd = conns.map((c, i) => ({ ...c, i })).filter((c) => !back.has(c.i) && c.from !== c.to);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const c of fwd) {
      if (rank.get(c.to) < rank.get(c.from) + 1) {
        rank.set(c.to, rank.get(c.from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxRank = Math.max(0, ...rank.values());
  const ranks = Array.from({ length: maxRank + 1 }, () => []);
  nodes.forEach((n) => ranks[rank.get(n.id)].push(n.id));

  // 3. barycenter ordering, two downward sweeps.
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let r = 1; r < ranks.length; r++) {
      const prev = ranks[r - 1];
      const bary = (id) => {
        const parents = fwd.filter((c) => c.to === id && prev.includes(c.from)).map((c) => prev.indexOf(c.from));
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : ranks[r].indexOf(id);
      };
      ranks[r] = [...ranks[r]].sort((a, b) => bary(a) - bary(b));
    }
  }

  // 4. coordinates.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rowWidth = (row) => row.reduce((acc, id) => acc + nodeDimensions(byId.get(id).type).width, 0) + NODESEP * Math.max(0, row.length - 1);
  const hasBack = back.size > 0;
  const backLabelW = Math.max(0, ...conns.filter((c, i) => back.has(i) && (str(c.condition) || str(c.label))).map((c) => Math.min(140, (str(c.condition) || str(c.label)).length * 7 + 12)));
  const leftPad = MARGIN_X + (hasBack ? BACK_EDGE_LANE * Math.min(back.size, 3) + (backLabelW ? backLabelW + 8 : 0) : 0);
  const contentW = Math.max(...ranks.map(rowWidth), 0);
  const boxes = new Map();
  let y = MARGIN_Y;
  ranks.forEach((row) => {
    const rowH = Math.max(...row.map((id) => nodeDimensions(byId.get(id).type).height));
    let x = leftPad + (contentW - rowWidth(row)) / 2;
    row.forEach((id) => {
      const n = byId.get(id);
      const dim = nodeDimensions(n.type);
      boxes.set(id, {
        id,
        label: n.label.trim(),
        description: str(n.description),
        type: n.type === "start" || n.type === "end" || n.type === "decision" ? n.type : "process",
        highlighted: !!n.highlighted,
        color: n.colorIndex !== undefined ? getAccentColor(n.colorIndex) : flowTypeColor(n.type),
        x,
        y: y + (rowH - dim.height) / 2,
        width: dim.width,
        height: dim.height,
        rank: rank.get(id),
      });
      x += dim.width + NODESEP;
    });
    y += rowH + RANKSEP;
  });
  const width = leftPad + contentW + MARGIN_X;
  const height = y - RANKSEP + MARGIN_Y;

  // 5. edges.
  let lane = 0;
  const edges = conns.map((c, i) => {
    const a = boxes.get(c.from);
    const b = boxes.get(c.to);
    const label = str(c.condition) || str(c.label);
    const isBack = back.has(i) || a.rank >= b.rank;
    if (!isBack) {
      const sx = a.x + a.width / 2;
      const sy = a.y + a.height;
      const tx = b.x + b.width / 2;
      const ty = b.y;
      const midY = sy + (ty - sy) / 2;
      const points = sx === tx ? [[sx, sy], [tx, ty]] : [[sx, sy], [sx, midY], [tx, midY], [tx, ty]];
      return { from: c.from, to: c.to, label, back: false, dashed: c.style === "dashed", points, labelAt: [(sx + tx) / 2, midY] };
    }
    lane += 1;
    const laneX = leftPad - BACK_EDGE_LANE * Math.min(lane, 3) + 6;
    const sy = a.y + a.height / 2;
    const ty = b.y + b.height / 2;
    const points = [[a.x, sy], [laneX, sy], [laneX, ty], [b.x, ty]];
    // back-edge labels sit just left of their lane so they never sit under a node
    const lw = label ? Math.min(140, label.length * 7 + 12) : 0;
    return { from: c.from, to: c.to, label, back: true, dashed: c.style === "dashed", points, labelAt: [laneX - lw / 2 - 4, (sy + ty) / 2] };
  });
  return { nodes: [...boxes.values()], edges, width, height };
}

function nodeShape(n, selected) {
  const g = s("g", { class: `w-flow-node${selected ? " is-selected" : ""}`, tabindex: "0", role: "button", "aria-label": `${n.type}: ${n.label}`, "data-id": n.id });
  if (n.type === "decision") {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    g.appendChild(s("polygon", { points: `${cx},${n.y} ${n.x + n.width},${cy} ${cx},${n.y + n.height} ${n.x},${cy}`, fill: n.color, stroke: INK, "stroke-width": 2 }));
    g.appendChild(svgText(wrapText(n.label, 12), cx, cy, { size: 12, lineHeight: 14 }));
  } else {
    const rx = n.type === "process" ? 8 : n.height / 2;
    g.appendChild(s("rect", { x: n.x, y: n.y, width: n.width, height: n.height, rx, fill: n.color, stroke: INK, "stroke-width": 2 }));
    g.appendChild(svgText(wrapText(n.label, n.type === "process" ? 20 : 18), n.x + n.width / 2, n.y + n.height / 2));
  }
  return g;
}

export function FlowchartVisualization({ data } = {}) {
  const layout = layoutFlowchart(data);
  if (layout.nodes.length === 0) return emptyState("No steps defined");
  const d = asRecord(data);
  let selected = layout.nodes.find((n) => n.highlighted)?.id;
  const markerId = nextId("arrow");
  const detail = h("figcaption", { class: "w-viz__detail", "aria-live": "polite" });
  const svg = s("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, class: "w-svg w-flow", role: "img", "aria-label": str(d.title) || "Flowchart", style: { minWidth: layout.width > 520 ? `${Math.round(layout.width * 0.62)}px` : undefined, maxWidth: `${Math.round(layout.width * 1.15)}px`, margin: "0 auto" } });
  const render = () => {
    svg.replaceChildren(arrowMarker(markerId));
    for (const e of layout.edges) {
      const dAttr = e.points.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
      svg.appendChild(s("path", { d: dAttr, class: "w-flow-edge", fill: "none", stroke: INK, "stroke-width": 2, "stroke-dasharray": e.dashed ? "5 4" : undefined, "marker-end": `url(#${markerId})` }));
      if (e.label) {
        const w = Math.min(140, e.label.length * 7 + 12);
        svg.appendChild(s("rect", { x: e.labelAt[0] - w / 2, y: e.labelAt[1] - 10, width: w, height: 20, rx: 4, class: "w-flow-edge-label-bg" }));
        svg.appendChild(svgText([e.label.length > 20 ? e.label.slice(0, 19) + "…" : e.label], e.labelAt[0], e.labelAt[1], { size: 11 }));
      }
    }
    for (const n of layout.nodes) {
      const g = nodeShape(n, n.id === selected);
      const pick = () => {
        selected = selected === n.id ? undefined : n.id;
        render();
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()));
      svg.appendChild(g);
    }
    const sel = layout.nodes.find((n) => n.id === selected);
    detail.replaceChildren(sel ? h("span", null, h("strong", null, sel.label), sel.description ? ` — ${sel.description}` : ` (${sel.type})`) : h("span", { class: "w-hint" }, "Tap a step to focus it."));
  };
  render();
  return h("figure", { class: "w-viz w-viz--flow" }, str(d.title) ? h("div", { class: "w-viz__title" }, d.title) : null, h("div", { class: "w-viz__scroll" }, svg), detail);
}

// ====================================================================== timeline

export function TimelineVisualization({ data } = {}) {
  if (!data || typeof data !== "object") return emptyState("No timeline data provided");
  const events = (Array.isArray(data.events) ? data.events : []).filter((e) => e && typeof e === "object");
  if (events.length === 0) return emptyState("No events defined");
  let selected = events.findIndex((e) => e.highlighted);
  if (selected < 0) selected = null;
  const detail = h("div", { class: "w-viz__detail", "aria-live": "polite" });
  const list = h("ol", { class: `w-timeline${data.direction === "vertical" ? " is-vertical" : ""}`, style: { "--n": String(events.length) } });
  const items = events.map((ev, i) => {
    const btn = h(
      "button",
      { type: "button", class: "w-timeline__event", "aria-pressed": "false", onClick: () => { selected = selected === i ? null : i; update(); } },
      h("span", { class: "w-timeline__dot", style: { background: getAccentColor(i) } }),
      h("span", { class: "w-timeline__date" }, String(ev.date ?? "")),
      h("span", { class: "w-timeline__label" }, inlineText(String(ev.label ?? ev.title ?? "")))
    );
    list.appendChild(h("li", { class: "w-timeline__item" }, btn));
    return btn;
  });
  function update() {
    items.forEach((b, i) => {
      b.setAttribute("aria-pressed", String(i === selected));
      b.classList.toggle("is-selected", i === selected);
    });
    const ev = selected === null ? null : events[selected];
    detail.replaceChildren(
      ev ? h("div", null, h("div", { class: "w-eyebrow" }, String(ev.date ?? "")), h("strong", null, inlineText(String(ev.label ?? ""))), ev.description ? h("p", { class: "w-secondary" }, inlineText(ev.description)) : null) : h("span", { class: "w-hint" }, "Tap an event for details.")
    );
  }
  update();
  return h("div", { class: "w-viz w-viz--timeline" }, str(data.title) ? h("div", { class: "w-viz__title" }, data.title) : null, list, detail);
}

// ====================================================================== bar chart

const DOMAIN_LIMIT = 1e15;
export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return f <= 1 ? p : f <= 2 ? 2 * p : f <= 5 ? 5 * p : 10 * p;
}
function roundTo(v, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v.toFixed(Math.min(decimals, 12)));
}
/** Port of niceScale(min, max, count=4) (@3776213). */
export function niceScale(a, b, count = 4) {
  const clamp = (v) => Math.max(-DOMAIN_LIMIT, Math.min(DOMAIN_LIMIT, v));
  let lo = clamp(Math.min(a, b));
  let hi = clamp(Math.max(a, b));
  if (lo === hi) {
    lo = lo > 0 ? 0 : lo - 1;
    hi = hi + 1;
  }
  const step = niceStep((hi - lo) / count);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = min; t <= max + step / 1e6; t += step) ticks.push(roundTo(t, step));
  return { min, max, ticks };
}
export function formatTick(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(2));
}

export function BarChartVisualization({ data } = {}) {
  if (!data || typeof data !== "object") return emptyState("No bar chart data provided");
  const unit = typeof data.unit === "string" ? data.unit.trim() : "";
  const bars = (Array.isArray(data.bars) ? data.bars : []).filter((b) => b && typeof b === "object" && typeof b.value === "number" && isFinite(b.value));
  if (bars.length === 0) return emptyState("No bars defined");
  let selected = bars.findIndex((b) => b.highlighted);
  if (selected < 0) selected = null;
  const max = Math.max(0, ...bars.map((b) => b.value));
  const scale = niceScale(0, max || 1);
  const top = scale.max || 1;
  const plotH = 200;
  const tickW = Math.max(26, Math.round(Math.max(...scale.ticks.map((t) => formatTick(t).length)) * 6.5) + 10);
  const yTitleW = data.yLabel ? 22 : 0;
  const left = tickW + yTitleW;
  const colW = 88;
  const W = left + bars.length * colW + 12;
  const labelLines = bars.map((b) => wrapText(String(b.label ?? ""), 11).slice(0, 3));
  const labelH = Math.max(...labelLines.map((l) => l.length)) * 14 + 10;
  const H = 24 + plotH + labelH + (data.xLabel ? 22 : 0);
  const y0 = 24 + plotH;
  const yOf = (v) => y0 - (Math.max(v, 0) / top) * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "w-svg w-bars", role: "img", "aria-label": str(data.title) || "Bar chart", style: { maxWidth: `${Math.round(W * 1.3)}px`, margin: "0 auto", minWidth: W > 420 ? `${Math.round(W * 0.7)}px` : undefined } });
  const detail = h("div", { class: "w-viz__detail", "aria-live": "polite" });
  function render() {
    svg.replaceChildren();
    for (const t of scale.ticks) {
      const y = yOf(t);
      svg.appendChild(s("line", { x1: left, x2: W - 6, y1: y, y2: y, class: "w-grid-line" }));
      svg.appendChild(s("text", { x: left - 6, y, "text-anchor": "end", "dominant-baseline": "middle", class: "w-svg-tick", "font-size": 11 }, formatTick(t)));
    }
    if (data.yLabel) svg.appendChild(s("text", { x: 12, y: 24 + plotH / 2, transform: `rotate(-90 12 ${24 + plotH / 2})`, "text-anchor": "middle", class: "w-svg-tick", "font-size": 11, "font-weight": 600 }, data.yLabel));
    bars.forEach((b, i) => {
      const x = left + i * colW + 14;
      const w = colW - 28;
      const y = yOf(b.value);
      const g = s("g", { class: `w-bar${selected === i ? " is-selected" : ""}${selected !== null && selected !== i ? " is-dim" : ""}`, tabindex: "0", role: "button", "aria-label": `${b.label}: ${formatWithUnit(b.value, unit)}` });
      g.appendChild(s("rect", { x, y, width: w, height: Math.max(2, y0 - y), rx: 6, fill: getAccentColor(i), stroke: INK, "stroke-width": selected === i ? 3 : 1.5 }));
      g.appendChild(s("text", { x: x + w / 2, y: y - 8, "text-anchor": "middle", class: "w-svg-val", "font-size": 12, "font-weight": 700 }, formatWithUnit(b.value, unit)));
      labelLines[i].forEach((ln, k) => g.appendChild(s("text", { x: x + w / 2, y: y0 + 16 + k * 14, "text-anchor": "middle", class: "w-svg-tick", "font-size": 11.5, "font-weight": 600 }, ln)));
      const pick = () => {
        selected = selected === i ? null : i;
        render();
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()));
      svg.appendChild(g);
    });
    svg.appendChild(s("line", { x1: left, x2: W - 6, y1: y0, y2: y0, stroke: INK, "stroke-width": 1.5 }));
    if (data.xLabel) svg.appendChild(s("text", { x: left + (W - left) / 2, y: H - 6, "text-anchor": "middle", class: "w-svg-tick", "font-size": 11, "font-weight": 600 }, data.xLabel));
    const b = selected === null ? null : bars[selected];
    detail.replaceChildren(b ? h("span", null, h("strong", null, `${b.label}: ${formatWithUnit(b.value, unit)}`), b.description ? ` — ${b.description}` : "") : h("span", { class: "w-hint" }, "Tap a bar to compare."));
  }
  render();
  return h("div", { class: "w-viz w-viz--bars" }, str(data.title) ? h("div", { class: "w-viz__title" }, data.title) : null, h("div", { class: "w-viz__scroll" }, svg), detail);
}

// ====================================================================== concept map

export function conceptNodeBox(label) {
  const lines = wrapText(String(label), 13);
  return { lines, width: Math.max(...lines.map((l) => l.length)) * 7.6 + 22, height: lines.length * 15 + 16 };
}

/**
 * Pure elliptical layout: center concept in the middle, level-1 nodes on the inner
 * ring, level-2 nodes fanned out next to the level-1 node they connect to.
 * Returns positions plus a viewBox that fits every node box.
 */
export function layoutConceptMap(data) {
  const d = asRecord(data);
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).filter((n) => n && typeof n === "object" && (str(n.id) || str(n.label)));
  const conns = (Array.isArray(d.connections) ? d.connections : []).filter((c) => c && typeof c === "object");
  const keyOf = (n) => str(n.id) || str(n.label);
  const level1 = nodes.filter((n) => n.level !== 2);
  const level2 = nodes.filter((n) => n.level === 2);
  const RX1 = 175, RY1 = 120, RX2 = 300, RY2 = 205;
  const angle = new Map();
  const start = level1.length === 2 ? 0 : -Math.PI / 2;
  level1.forEach((n, i) => angle.set(keyOf(n), start + (i / level1.length) * Math.PI * 2));
  const l1Keys = new Set(level1.map(keyOf));
  const parentOf = (n) => {
    const k = keyOf(n);
    const c = conns.find((x) => (x.from === k && l1Keys.has(x.to)) || (x.to === k && l1Keys.has(x.from)));
    return c ? (c.from === k ? c.to : c.from) : null;
  };
  const groups = new Map();
  const orphans = [];
  level2.forEach((n) => {
    const p = parentOf(n);
    if (p) groups.set(p, [...(groups.get(p) ?? []), n]);
    else orphans.push(n);
  });
  groups.forEach((kids, p) => kids.forEach((n, j) => angle.set(keyOf(n), angle.get(p) + (j - (kids.length - 1) / 2) * 0.6)));
  orphans.forEach((n, i) => angle.set(keyOf(n), -Math.PI / 2 + Math.PI / Math.max(level1.length, 1) + (i / orphans.length) * Math.PI * 2));
  const pos = new Map();
  nodes.forEach((n) => {
    const a = angle.get(keyOf(n));
    const outer = n.level === 2;
    pos.set(keyOf(n), { x: (outer ? RX2 : RX1) * Math.cos(a), y: (outer ? RY2 : RY1) * Math.sin(a), node: n, box: conceptNodeBox(n.label ?? n.id) });
  });
  const centerLabel = str(d.centerConcept);
  const centerLines = centerLabel ? wrapText(centerLabel, 14) : [];
  const centerBox = { width: centerLines.length ? Math.max(...centerLines.map((l) => l.length)) * 8.5 + 28 : 0, height: centerLines.length * 16 + 20 };
  const boxes = [{ x: 0, y: 0, ...centerBox }, ...[...pos.values()].map((p) => ({ x: p.x, y: p.y, ...p.box }))];
  const M = 16;
  const minX = Math.min(...boxes.map((b) => b.x - b.width / 2)) - M;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width / 2)) + M;
  const minY = Math.min(...boxes.map((b) => b.y - b.height / 2)) - M;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height / 2)) + M;
  pos.forEach((p) => {
    p.x -= minX;
    p.y -= minY;
  });
  return { center: { x: -minX, y: -minY, label: centerLabel, lines: centerLines, box: centerBox }, positions: pos, width: maxX - minX, height: maxY - minY };
}

export function ConceptMapVisualization({ data } = {}) {
  if (!data || typeof data !== "object") return emptyState("No concept map data provided");
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter((n) => n && typeof n === "object");
  const conns = (Array.isArray(data.connections) ? data.connections : []).filter((c) => c && typeof c === "object");
  if (nodes.length === 0 && !data.centerConcept) return emptyState("No concepts to display");
  const layout = layoutConceptMap(data);
  const centerKey = (id) => id === "center" || id === layout.center.label || id === str(data.centerConcept);
  const point = (id) => (centerKey(id) ? layout.center : layout.positions.get(id));
  let selected = nodes.find((n) => n.highlighted)?.id ?? null;
  const svg = s("svg", { viewBox: `0 0 ${Math.round(layout.width)} ${Math.round(layout.height)}`, class: "w-svg w-cmap", style: { maxWidth: `${Math.round(layout.width * 1.15)}px` }, role: "img", "aria-label": str(data.title) || "Concept map" });
  const detail = h("div", { class: "w-viz__detail", "aria-live": "polite" });
  // nodes referenced by no connection hang off the center implicitly
  const connected = new Set(conns.flatMap((c) => [c.from, c.to]));
  function render() {
    svg.replaceChildren();
    const lines = [...conns.map((c) => ({ ...c, implicit: false })), ...nodes.filter((n) => (n.level ?? 1) === 1 && !connected.has(n.id)).map((n) => ({ from: "center", to: n.id, relationship: "", implicit: true }))];
    for (const c of lines) {
      const a = point(c.from);
      const b = point(c.to);
      if (!a || !b) continue;
      const active = selected && (c.from === selected || c.to === selected);
      svg.appendChild(s("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `w-cmap-edge${active ? " is-active" : ""}${c.implicit ? " is-implicit" : ""}` }));
      if (c.relationship) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const t = c.relationship.length > 18 ? c.relationship.slice(0, 17) + "…" : c.relationship;
        const w = t.length * 6.4 + 10;
        svg.appendChild(s("rect", { x: mx - w / 2, y: my - 9, width: w, height: 18, rx: 9, class: `w-cmap-rel-bg${active ? " is-active" : ""}` }));
        svg.appendChild(svgText([t], mx, my, { size: 10.5, weight: 500, class: "w-svg-tick" }));
      }
    }
    if (layout.center.label) {
      const { width: w, height: ch } = layout.center.box;
      svg.appendChild(s("rect", { x: layout.center.x - w / 2, y: layout.center.y - ch / 2, width: w, height: ch, rx: 14, fill: INK }));
      svg.appendChild(svgText(layout.center.lines, layout.center.x, layout.center.y, { size: 14, weight: 700, class: "w-svg-text-inv", lineHeight: 16 }));
    }
    nodes.forEach((n, i) => {
      const key = str(n.id) || str(n.label);
      const p = layout.positions.get(key);
      if (!p) return;
      const { lines: lines2, width: w, height: hgt } = p.box;
      const g = s("g", { class: `w-cmap-node${selected === n.id ? " is-selected" : ""}`, tabindex: "0", role: "button", "aria-label": String(n.label ?? n.id) });
      g.appendChild(s("rect", { x: p.x - w / 2, y: p.y - hgt / 2, width: w, height: hgt, rx: 10, fill: getAccentColor(n.colorIndex ?? n.level ?? 1), stroke: INK, "stroke-width": selected === n.id ? 3 : 1.5 }));
      g.appendChild(svgText(lines2, p.x, p.y, { size: 12, lineHeight: 15 }));
      const pick = () => {
        selected = selected === n.id ? null : n.id;
        render();
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()));
      svg.appendChild(g);
    });
    const sel = nodes.find((n) => n.id === selected);
    const rels = sel ? conns.filter((c) => c.from === sel.id || c.to === sel.id) : [];
    const name = (id) => (centerKey(id) ? layout.center.label : nodes.find((n) => n.id === id)?.label ?? id);
    detail.replaceChildren(
      sel
        ? h("div", null, h("strong", null, String(sel.label)), sel.description ? h("p", { class: "w-secondary" }, sel.description) : null, rels.length ? h("ul", { class: "w-dots" }, rels.map((c) => h("li", null, `${name(c.from)} → ${c.relationship} → ${name(c.to)}`))) : null)
        : h("span", { class: "w-hint" }, "Tap a concept to see how it connects.")
    );
  }
  render();
  return h("div", { class: "w-viz w-viz--cmap" }, str(data.title) ? h("div", { class: "w-viz__title" }, data.title) : null, svg, detail);
}

// ====================================================================== cycle

export function CycleVisualization({ data } = {}) {
  if (!data || typeof data !== "object") return emptyState("No cycle data provided");
  const stages = (Array.isArray(data.stages) ? data.stages : []).filter((st) => st && typeof st === "object");
  if (stages.length === 0) return emptyState("No stages defined");
  let selected = stages.findIndex((st) => st.highlighted);
  if (selected < 0) selected = null;
  const size = 440;
  const c = size / 2;
  const r = size * 0.34;
  const markerId = nextId("cyc");
  const svg = s("svg", { viewBox: `0 0 ${size} ${size}`, class: "w-svg w-cycle", role: "img", "aria-label": str(data.title) || "Cycle" });
  const detail = h("div", { class: "w-viz__detail", "aria-live": "polite" });
  const angle = (i) => -Math.PI / 2 + (i / stages.length) * Math.PI * 2;
  function render() {
    svg.replaceChildren(arrowMarker(markerId));
    svg.appendChild(s("circle", { cx: c, cy: c, r, class: "w-cycle-ring" }));
    // arrows along the ring between consecutive stages
    stages.forEach((_, i) => {
      const a0 = angle(i) + 0.32;
      const a1 = angle(i + 1) - 0.32;
      if (a1 <= a0) return;
      const p0 = [c + r * Math.cos(a0), c + r * Math.sin(a0)];
      const p1 = [c + r * Math.cos(a1), c + r * Math.sin(a1)];
      svg.appendChild(s("path", { d: `M${p0[0]},${p0[1]} A${r},${r} 0 0 1 ${p1[0]},${p1[1]}`, fill: "none", stroke: INK, "stroke-width": 2.5, "marker-end": `url(#${markerId})` }));
    });
    if (str(data.centerLabel)) svg.appendChild(svgText(wrapText(data.centerLabel, 14), c, c, { size: 15, weight: 700 }));
    stages.forEach((st, i) => {
      const x = c + r * Math.cos(angle(i));
      const y = c + r * Math.sin(angle(i));
      const lines = wrapText(String(st.label ?? ""), 12).slice(0, 3);
      const w = Math.max(...lines.map((l) => l.length)) * 7.4 + 24;
      const hgt = lines.length * 15 + 18;
      const g = s("g", { class: `w-cycle-stage${selected === i ? " is-selected" : ""}`, tabindex: "0", role: "button", "aria-label": `Stage ${i + 1}: ${st.label}` });
      g.appendChild(s("rect", { x: x - w / 2, y: y - hgt / 2, width: w, height: hgt, rx: 12, fill: getAccentColor(i), stroke: INK, "stroke-width": selected === i ? 3 : 1.5 }));
      g.appendChild(svgText(lines, x, y, { size: 12, lineHeight: 15 }));
      const pick = () => {
        selected = selected === i ? null : i;
        render();
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()));
      svg.appendChild(g);
    });
    const st = selected === null ? null : stages[selected];
    detail.replaceChildren(st ? h("span", null, h("strong", null, `${selected + 1}. ${st.label}`), st.description ? ` — ${st.description}` : "") : h("span", { class: "w-hint" }, "Tap a stage. The loop repeats."));
  }
  render();
  return h("div", { class: "w-viz w-viz--cycle" }, str(data.title) ? h("div", { class: "w-viz__title" }, data.title) : null, svg, detail);
}

// ====================================================================== comparison

function toRecord(v) {
  if (Array.isArray(v)) return Object.fromEntries(v.filter((x) => x && typeof x === "object" && x.name).map((x) => [x.name, x.value]));
  return asRecord(v);
}

/** Port of attributeKeys(items, attributeLabels) (@3816106). */
export function attributeKeys(items, attributeLabels) {
  const keys = Object.keys(attributeLabels ?? {});
  for (const it of items) for (const k of Object.keys(toRecord(it.attributes))) if (!keys.includes(k)) keys.push(k);
  return keys;
}

export function ComparisonVisualization({ data } = {}) {
  if (!data || typeof data !== "object") return emptyState("No comparison data provided");
  const items = (Array.isArray(data.items) ? data.items : []).filter((it) => it && typeof it === "object");
  const common = normalizeStringList(data.commonFeatures);
  if (items.length === 0) return emptyState("No items to compare");
  const labels = asRecord(data.attributeLabels);
  const keys = attributeKeys(items, labels);
  const cols = h(
    "div",
    { class: "w-cmp", style: { "--cols": String(items.length) } },
    items.map((it, i) => {
      const attrs = toRecord(it.attributes);
      const details = toRecord(it.details);
      const detailKeys = Object.keys(details);
      const panel = detailKeys.length ? h("dl", { class: "w-cmp__details", hidden: true }, detailKeys.map((k) => [h("dt", null, k), h("dd", null, String(details[k]))])) : null;
      return h(
        "div",
        { class: "w-cmp__col" },
        h("div", { class: "w-cmp__head", style: { background: getAccentColor(i) } }, inlineText(String(it.label ?? it.name ?? `Item ${i + 1}`))),
        h("dl", { class: "w-cmp__attrs" }, keys.map((k) => [h("dt", null, labels[k] ?? k), h("dd", null, attrs[k] !== undefined ? inlineText(String(attrs[k])) : "—")])),
        panel
          ? h("button", { type: "button", class: "w-link-btn", onClick: (e) => { panel.hidden = !panel.hidden; e.currentTarget.textContent = panel.hidden ? "More details" : "Hide details"; } }, "More details")
          : null,
        panel
      );
    })
  );
  return h(
    "div",
    { class: "w-viz w-viz--cmp" },
    str(data.title) ? h("div", { class: "w-viz__title" }, data.title) : null,
    common.length ? h("div", { class: "w-cmp__common" }, h("span", { class: "w-eyebrow" }, "In common"), " ", common.join(" · ")) : null,
    h("div", { class: "w-viz__scroll" }, cols)
  );
}

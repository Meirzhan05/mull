// "visual-*" widgets. Normalizers ported from @3439885 (list), @3445712 (stepper),
// @3450015 (cards), @3466223 (quadrant), @3469798 (venn), @3471370 (stat bars),
// @3474988 (transform). Colors follow INTERACTIVE_COLORS accents (@3436064).

import { h, asRecord, str, firstStr, normalizeStringList, inlineText, getAccentColor } from "./dom.js";

// ---------------------------------------------------------------- list

const LIST_VARIANTS = new Set(["bullet", "ordered", "checklist", "stepper"]);
const CHECKED_STATUSES = new Set(["done", "complete", "completed", "checked", "yes"]);

export function normalizeVisualList({ data, title, description, variant, items, steps, layout } = {}) {
  const d = asRecord(data);
  const stepsArr = Array.isArray(steps) ? steps : Array.isArray(d.steps) ? d.steps : undefined;
  const itemsArr = Array.isArray(items) ? items : Array.isArray(d.items) ? d.items : undefined;
  const source = itemsArr ?? stepsArr ?? [];
  const v = (LIST_VARIANTS.has(variant) ? variant : LIST_VARIANTS.has(d.variant) ? d.variant : undefined) ?? (stepsArr && !itemsArr ? "stepper" : "bullet");
  const norm = source
    .map((it) => {
      if (typeof it === "string") {
        const t = it.trim();
        return t ? { text: t, checked: false } : null;
      }
      if (!it || typeof it !== "object") return null;
      if (v === "stepper") {
        const label = str(it.label);
        const text = firstStr(it.text, it.description) || "";
        return !label && !text ? null : { label, text, checked: false };
      }
      const text = String(it.text ?? it.label ?? "").trim();
      if (!text) return null;
      const status = typeof it.status === "string" ? it.status.trim() : undefined;
      const checked = typeof it.checked === "boolean" ? it.checked : status ? CHECKED_STATUSES.has(status.toLowerCase()) : false;
      const emphasis = str(it.emphasis);
      return { text, checked, status, emphasis };
    })
    .filter(Boolean);
  const lay = layout ?? d.layout ?? "auto";
  const labels = norm.map((x) => x.label ?? x.text);
  const hasBoth = norm.some((x) => x.label && x.text);
  const allShort = labels.every((x) => x.length <= 16);
  const horizontal = v === "stepper" && (lay === "horizontal" || (lay === "auto" && !hasBoth && allShort && norm.length > 0 && norm.length <= 4));
  return { title: firstStr(title, d.title), description: firstStr(description, d.description), variant: v, items: norm, horizontal };
}

export function VisualList(props) {
  const n = normalizeVisualList(props);
  if (n.items.length === 0) return null;
  const head = [n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null, n.description ? h("p", { class: "w-secondary" }, inlineText(n.description)) : null];
  if (n.variant === "stepper" && n.horizontal) {
    return h(
      "div",
      { class: "w-panel" },
      head,
      h(
        "ol",
        { class: "w-hsteps" },
        n.items.map((it, i) => h("li", { class: "w-hsteps__item" }, h("span", { class: "w-hsteps__dot", style: { background: getAccentColor(i) } }, String(i + 1)), h("span", { class: "w-hsteps__label" }, inlineText(it.label ?? it.text))))
      )
    );
  }
  const tag = n.variant === "ordered" || n.variant === "stepper" ? "ol" : "ul";
  return h(
    "div",
    { class: "w-panel" },
    head,
    h(
      tag,
      { class: `w-vlist w-vlist--${n.variant}` },
      n.items.map((it, i) => {
        let marker;
        if (n.variant === "checklist") marker = h("span", { class: `w-check${it.checked ? " is-checked" : ""}`, "aria-hidden": "true" }, it.checked ? "✓" : "");
        else if (n.variant === "bullet") marker = h("span", { class: "w-bullet", style: { background: getAccentColor(i) }, "aria-hidden": "true" });
        else marker = h("span", { class: "w-num", style: { background: getAccentColor(i) }, "aria-hidden": "true" }, String(i + 1));
        return h(
          "li",
          { class: "w-vlist__item" },
          marker,
          h(
            "div",
            { class: "w-vlist__content" },
            it.label ? h("div", { class: "w-strong" }, inlineText(it.label)) : null,
            it.text ? h("div", null, inlineText(it.text)) : null,
            it.emphasis ? h("div", { class: "w-emph" }, inlineText(it.emphasis)) : null,
            n.variant === "checklist" && it.status ? h("span", { class: "w-chip" }, it.status) : null
          )
        );
      })
    )
  );
}

// ---------------------------------------------------------------- stepper (visual)

export function normalizeVisualStepper({ data, steps, items, title } = {}) {
  const d = asRecord(data);
  const src = Array.isArray(steps) ? steps : Array.isArray(items) ? items : Array.isArray(d.steps) ? d.steps : Array.isArray(d.items) ? d.items : [];
  const norm = src
    .map((s) => {
      if (typeof s === "string") return s.trim() ? { text: s.trim() } : null;
      if (!s || typeof s !== "object") return null;
      const out = { label: str(s.label), text: firstStr(s.text, s.description), example: str(s.example) };
      return out.label || out.text ? out : null;
    })
    .filter(Boolean);
  return { title: firstStr(title, d.title), steps: norm };
}

export function VisualStepper(props) {
  const n = normalizeVisualStepper(props);
  if (n.steps.length === 0) return null;
  return VisualList({ title: n.title, variant: "stepper", steps: n.steps.map((s) => ({ label: s.label, text: [s.text, s.example ? `e.g. ${s.example}` : ""].filter(Boolean).join(" — ") })) });
}

// ---------------------------------------------------------------- cards

const CARD_VARIANTS = new Set(["simple", "comparison", "category"]);

export function normalizeVisualCards({ data, title, description, variant, cards } = {}) {
  const d = asRecord(data);
  const list = Array.isArray(cards) ? cards : Array.isArray(d.cards) ? d.cards : [];
  const norm = list
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const t = firstStr(c.title ?? c.label);
      const desc = firstStr(c.description ?? c.text);
      const its = [...normalizeStringList(c.items), ...normalizeStringList(c.points)];
      if (!t && !desc && its.length === 0) return null;
      return { title: t, category: str(c.category), description: desc, items: its, tone: c.tone === "primary" ? "primary" : "secondary" };
    })
    .filter(Boolean);
  return {
    title: firstStr(title ?? d.title),
    description: firstStr(description ?? d.description),
    variant: CARD_VARIANTS.has(variant) ? variant : CARD_VARIANTS.has(d.variant) ? d.variant : "simple",
    cards: norm,
  };
}

export function VisualCards(props) {
  const n = normalizeVisualCards(props);
  if (n.cards.length === 0) return null;
  return h(
    "div",
    { class: "w-block" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    n.description ? h("p", { class: "w-secondary" }, inlineText(n.description)) : null,
    h(
      "div",
      { class: "w-grid2" },
      n.cards.map((c, i) =>
        h(
          "div",
          { class: "w-tile", style: { background: `${getAccentColor(i)}${c.tone === "primary" ? "33" : "1f"}` } },
          c.category ? h("div", { class: "w-eyebrow" }, c.category) : null,
          c.title ? h("div", { class: "w-strong" }, inlineText(c.title)) : null,
          c.description ? h("p", { class: "w-tile__desc" }, inlineText(c.description)) : null,
          c.items.length ? h("ul", { class: "w-dots" }, c.items.map((x) => h("li", null, inlineText(x)))) : null
        )
      )
    )
  );
}

// ---------------------------------------------------------------- stat bars

export function normalizeStatBars({ data } = {}) {
  const d = asRecord(data);
  const raw = Array.isArray(d.items) ? d.items : [];
  const items = raw
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      const label = typeof it.label === "string" ? it.label.trim() : "";
      const value = typeof it.value === "number" && isFinite(it.value) ? it.value : null;
      return !label || value === null ? null : { label, value, note: str(it.note) };
    })
    .filter(Boolean);
  const maxDecl = raw.reduce((acc, it) => (it && typeof it.max === "number" && isFinite(it.max) ? Math.max(acc, it.max) : acc), 0);
  const maxVal = items.reduce((acc, it) => Math.max(acc, it.value), 0);
  return { title: str(d.title), unit: typeof d.unit === "string" ? d.unit.trim() : "", items, scaleMax: maxDecl > 0 ? maxDecl : maxVal > 0 ? maxVal : 1 };
}

export function formatWithUnit(value, unit) {
  const currency = /^[$€£¥₹₩₽]$/.test(unit);
  const spaced = !currency && !!unit && /^[\p{L}\p{N}]/u.test(unit);
  if (currency) return `${value < 0 ? "-" : ""}${unit}${Math.abs(value)}`;
  return `${value}${spaced ? " " : ""}${unit}`;
}

export function VisualStatBars(props) {
  const n = normalizeStatBars(props);
  if (n.items.length === 0) return null;
  return h(
    "div",
    { class: "w-block" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    h(
      "div",
      { class: "w-statbars" },
      n.items.map((it, i) => {
        const pct = Math.max(2, Math.min(100, (it.value / n.scaleMax) * 100));
        return h(
          "div",
          { class: "w-statbar" },
          h("div", { class: "w-row-between" }, h("span", { class: "w-strong-sm" }, inlineText(it.label)), h("span", { class: "w-num-val", dir: "ltr" }, formatWithUnit(it.value, n.unit))),
          h("div", { class: "w-statbar__track" }, h("div", { class: "w-statbar__fill", style: { width: `${pct}%`, background: getAccentColor(i) } })),
          it.note ? h("div", { class: "w-note" }, inlineText(it.note)) : null
        );
      })
    )
  );
}

// ---------------------------------------------------------------- venn

export function normalizeVenn({ data } = {}) {
  const d = asRecord(data);
  const L = str(d.leftLabel) || "A";
  const R = str(d.rightLabel) || "B";
  return {
    title: str(d.title),
    leftLabel: L,
    rightLabel: R,
    onlyLeftHeading: str(d.onlyLeftHeading) || L,
    sharedHeading: str(d.sharedHeading) || `${L} ∩ ${R}`,
    onlyRightHeading: str(d.onlyRightHeading) || R,
    onlyLeft: normalizeStringList(d.onlyLeft),
    shared: normalizeStringList(d.shared),
    onlyRight: normalizeStringList(d.onlyRight),
  };
}

export function VisualVenn(props) {
  const n = normalizeVenn(props);
  if (!(n.onlyLeft.length || n.shared.length || n.onlyRight.length)) return null;
  const col = (heading, items, color) =>
    h("div", { class: "w-tile", style: { background: `${color}1f` } }, h("div", { class: "w-strong-sm" }, heading), h("ul", { class: "w-dots" }, items.map((x) => h("li", null, inlineText(x)))));
  return h(
    "div",
    { class: "w-block" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    h(
      "div",
      { class: "w-venn-diagram", "aria-hidden": "true" },
      h("span", { class: "w-venn-circle w-venn-circle--l", style: { background: `${getAccentColor(0)}55` } }, n.leftLabel),
      h("span", { class: "w-venn-circle w-venn-circle--r", style: { background: `${getAccentColor(3)}55` } }, n.rightLabel)
    ),
    h("div", { class: "w-grid3" }, col(n.onlyLeftHeading, n.onlyLeft, getAccentColor(0)), col(n.sharedHeading, n.shared, getAccentColor(1)), col(n.onlyRightHeading, n.onlyRight, getAccentColor(3)))
  );
}

// ---------------------------------------------------------------- transform

function normalizeTransformSide(v) {
  if (!v || typeof v !== "object") return { items: [] };
  return { label: str(v.label), text: str(v.text), items: normalizeStringList(v.items) };
}
const sideHasContent = (s) => !!(s.label || s.text || s.items.length > 0);

export function normalizeTransform({ data } = {}) {
  const d = asRecord(data);
  const after = normalizeTransformSide(d.after);
  const changes = normalizeStringList(d.changes);
  if (changes.length > 0) after.items = [...after.items, ...changes];
  return { title: str(d.title), before: normalizeTransformSide(d.before), after, transformLabel: str(d.transformLabel) };
}

export function VisualTransform(props) {
  const n = normalizeTransform(props);
  if (!sideHasContent(n.before) || !sideHasContent(n.after)) return null;
  const card = (side, color, tag) =>
    h(
      "div",
      { class: "w-tile w-transform__side", style: { background: `${color}1f` } },
      h("div", { class: "w-eyebrow" }, tag),
      side.label ? h("div", { class: "w-strong" }, inlineText(side.label)) : null,
      side.text ? h("p", { class: "w-tile__desc" }, inlineText(side.text)) : null,
      side.items.length ? h("ul", { class: "w-dots" }, side.items.map((x) => h("li", null, inlineText(x)))) : null
    );
  return h(
    "div",
    { class: "w-block" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    h(
      "div",
      { class: "w-transform" },
      card(n.before, getAccentColor(3), "Before"),
      h("div", { class: "w-transform__arrow" }, h("span", { class: "w-arrow", "aria-hidden": "true" }, "→"), n.transformLabel ? h("span", { class: "w-transform__label" }, n.transformLabel) : null),
      card(n.after, getAccentColor(2), "After")
    )
  );
}

// ---------------------------------------------------------------- quadrant

export const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const POSITION_COLOR = { "top-left": 0, "top-right": 1, "bottom-left": 3, "bottom-right": 5 };

export function normalizeQuadrant({ data } = {}) {
  const d = asRecord(data);
  const byPosition = new Map();
  if (Array.isArray(d.quadrants)) {
    d.quadrants.forEach((q, i) => {
      if (!q || typeof q !== "object") return;
      const pos = q.position && POSITIONS.includes(q.position) ? q.position : POSITIONS[i] ?? "top-left";
      byPosition.set(pos, { ...q, position: pos });
    });
  }
  return { title: str(d.title), xAxis: asRecord(d.xAxis), yAxis: asRecord(d.yAxis), byPosition };
}

export function VisualQuadrant(props) {
  const n = normalizeQuadrant(props);
  if (n.byPosition.size === 0) return null;
  const cell = (pos) => {
    const q = n.byPosition.get(pos) ?? { position: pos };
    const items = normalizeStringList(q.items);
    const color = getAccentColor(POSITION_COLOR[pos]);
    return h(
      "div",
      { class: "w-tile w-quad__cell", style: { background: `${color}1f` } },
      str(q.label) ? h("div", { class: "w-strong-sm" }, inlineText(q.label)) : null,
      items.length ? h("ul", { class: "w-dots" }, items.map((x) => h("li", null, inlineText(x)))) : null
    );
  };
  return h(
    "div",
    { class: "w-block" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    h(
      "div",
      { class: "w-quad" },
      str(n.yAxis.label) ? h("div", { class: "w-quad__ylabel" }, h("span", null, n.yAxis.label)) : null,
      h(
        "div",
        { class: "w-quad__main" },
        str(n.yAxis.high) ? h("div", { class: "w-axis-note" }, `↑ ${n.yAxis.high}`) : null,
        h("div", { class: "w-quad__grid", dir: "ltr" }, POSITIONS.map(cell)),
        str(n.yAxis.low) ? h("div", { class: "w-axis-note" }, `↓ ${n.yAxis.low}`) : null,
        h(
          "div",
          { class: "w-quad__x" },
          h("span", null, str(n.xAxis.low) ? `← ${n.xAxis.low}` : ""),
          h("span", { class: "w-strong-sm" }, str(n.xAxis.label) || ""),
          h("span", null, str(n.xAxis.high) ? `${n.xAxis.high} →` : "")
        )
      )
    )
  );
}

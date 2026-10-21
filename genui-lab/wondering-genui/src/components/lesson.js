// "lesson-*" widgets + wondering-lens. Normalizers are ports of the useMemo
// blocks at @3399056 (stepper), @3401276 (worked example), @3407608 (lens),
// @3408476 (reveal), @3411796 (compare), @3415922 (slider), @3422601 (table).
// Every normalizer accepts spread props OR data={...} and is alias tolerant.

import { h, asRecord, str, firstStr, normalizeStringList, inlineText, nextId } from "./dom.js";

// ---------------------------------------------------------------- stepper

export function normalizeLessonStepper({ data, title, steps } = {}) {
  const d = asRecord(data);
  const list = Array.isArray(steps) ? steps : Array.isArray(d.steps) ? d.steps : [];
  const norm = list
    .map((s) => (s && typeof s === "object" ? { label: str(s.label), text: firstStr(s.text, s.description) } : null))
    .filter((s) => s && (s.label || s.text));
  return { title: firstStr(title, d.title) || "Step-by-step", steps: norm };
}

function stepperShell(title, count, extraTop) {
  return h(
    "div",
    { class: "w-stepper not-prose" },
    h("div", { class: "w-stepper__header" }, h("span", { class: "w-muted-title" }, inlineText(title)), h("bdi", { class: "w-count" }, `${count} ${count === 1 ? "step" : "steps"}`)),
    extraTop
  );
}

export function LessonStepper(props) {
  const n = normalizeLessonStepper(props);
  if (n.steps.length === 0) return null;
  const root = stepperShell(n.title, n.steps.length);
  const ol = h("ol", { class: "w-stepper__list" });
  n.steps.forEach((step, i) => {
    const last = i === n.steps.length - 1;
    ol.appendChild(
      h(
        "li",
        { class: `w-stepper__step${last ? " is-last" : ""}` },
        h("div", { class: "w-stepper__rail" }, last ? null : h("span", { class: "w-stepper__connector", "aria-hidden": "true" }), h("span", { class: "w-stepper__dot", "aria-hidden": "true" }, String(i + 1))),
        h("h3", { class: "w-stepper__label" }, inlineText(step.label || `Step ${i + 1}`)),
        step.text ? h("p", { class: "w-stepper__text" }, inlineText(step.text)) : null
      )
    );
  });
  root.appendChild(ol);
  return root;
}

// ---------------------------------------------------------------- worked example

export function normalizeWorkedExample({ data, title, context, steps, revealVariant = "prose", revealLabel } = {}) {
  const d = asRecord(data);
  const list = Array.isArray(steps) ? steps : Array.isArray(d.steps) ? d.steps : [];
  const norm = list
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      return {
        label: str(s.label),
        text: firstStr(s.text, s.description),
        example: str(s.example),
        hints: Array.isArray(s.hints) ? normalizeStringList(s.hints) : undefined,
        image: s.image && s.image.src ? { src: s.image.src, alt: s.image.alt ?? "" } : undefined,
      };
    })
    .filter((s) => s && (s.label || s.text));
  return {
    title: firstStr(title, d.title) || "Worked Example",
    context: firstStr(context, d.context),
    steps: norm,
    revealVariant: str(revealVariant) || str(d.revealVariant) || "prose",
    revealLabel: firstStr(revealLabel, d.revealLabel) || "Show worked step",
  };
}

export function LessonStepperWorkedExample(props) {
  const n = normalizeWorkedExample(props);
  if (n.steps.length === 0) return null;
  const root = stepperShell(n.title, n.steps.length, n.context ? h("div", { class: "w-pad" }, h("p", { class: "w-secondary" }, inlineText(n.context))) : null);
  const ol = h("ol", { class: "w-stepper__list" });
  n.steps.forEach((step, i) => {
    const last = i === n.steps.length - 1;
    const hasReveal = step.example || (step.hints && step.hints.length) || step.image;
    const panelId = nextId("we");
    const panel = hasReveal
      ? h(
          "div",
          { class: "w-reveal-panel", id: panelId, hidden: true },
          step.example ? h("pre", { class: "w-example" }, step.example) : null,
          step.hints && step.hints.length ? h("ul", { class: "w-hints" }, step.hints.map((x) => h("li", null, inlineText(x)))) : null,
          step.image ? h("img", { src: step.image.src, alt: step.image.alt, class: "w-step-img", loading: "lazy" }) : null
        )
      : null;
    const btn = hasReveal
      ? h("button", {
          type: "button",
          class: "w-link-btn",
          "aria-expanded": "false",
          "aria-controls": panelId,
          onClick: (e) => {
            const open = panel.hidden;
            panel.hidden = !open;
            e.currentTarget.setAttribute("aria-expanded", String(open));
            e.currentTarget.textContent = open ? "Hide" : n.revealLabel;
          },
        }, n.revealLabel)
      : null;
    ol.appendChild(
      h(
        "li",
        { class: `w-stepper__step${last ? " is-last" : ""}` },
        h("div", { class: "w-stepper__rail" }, last ? null : h("span", { class: "w-stepper__connector" }), h("span", { class: "w-stepper__dot" }, String(i + 1))),
        h("h3", { class: "w-stepper__label" }, inlineText(step.label || `Step ${i + 1}`)),
        h("div", { class: "w-stepper__body" }, step.text ? h("p", { class: "w-stepper__text" }, inlineText(step.text)) : null, btn, panel)
      )
    );
  });
  root.appendChild(ol);
  return root;
}

// ---------------------------------------------------------------- wondering lens

export function normalizeWonderingLens({ data, title, body, content } = {}) {
  const d = asRecord(data);
  return { title: firstStr(title, d.title), body: firstStr(body, content, d.body, d.content) };
}

export function WonderingLensCard(props) {
  const n = normalizeWonderingLens(props);
  if (!n.title && !n.body) return null;
  return h(
    "aside",
    { class: `w-lens${props && props.className ? " " + props.className : ""}` },
    h("div", { class: "w-lens__eyebrow" }, "Wondering lens"),
    n.title ? h("h3", { class: "w-lens__title" }, inlineText(n.title)) : null,
    n.body ? h("p", { class: "w-lens__body" }, inlineText(n.body)) : null
  );
}

// ---------------------------------------------------------------- reveal

export function normalizeLessonReveal({ data, title, items, startCollapsed = false } = {}) {
  const d = asRecord(data);
  const list = Array.isArray(items) ? items : Array.isArray(d.items) ? d.items : [];
  const norm = list
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      const label = str(it.label);
      const content = typeof it.content === "string" ? it.content.trim() : typeof it.text === "string" ? it.text.trim() : typeof it.description === "string" ? it.description.trim() : undefined;
      return label || content ? { label, content } : null;
    })
    .filter(Boolean);
  return {
    title: firstStr(title, d.title) || "Key ideas",
    items: norm,
    startCollapsed: startCollapsed === true || d.startCollapsed === true,
  };
}

export function LessonReveal(props) {
  const n = normalizeLessonReveal(props);
  if (n.items.length === 0) return null;
  // Title "Wondering lens" renders the items as lens cards (@3408476).
  if (n.title.toLowerCase() === "wondering lens") {
    return h("div", { class: "w-stack" }, n.items.map((it, i) => WonderingLensCard({ title: it.label || `Item ${i + 1}`, body: it.content })));
  }
  const open = new Set(n.items.length === 1 && !n.startCollapsed ? [0] : []);
  const root = h("div", { class: "w-card w-reveal" }, h("div", { class: "w-muted-title" }, inlineText(n.title)));
  const list = h("div", { class: "w-reveal__list" });
  n.items.forEach((it, i) => {
    const id = nextId("rv");
    const body = h("div", { class: "w-reveal__body", id, hidden: !open.has(i) }, h("p", null, inlineText(it.content || "")));
    const item = h("div", { class: `w-reveal__item${open.has(i) ? " is-open" : ""}` });
    const btn = h(
      "button",
      {
        type: "button",
        class: "w-reveal__btn",
        "aria-expanded": String(open.has(i)),
        "aria-controls": id,
        onClick: () => {
          const now = body.hidden;
          body.hidden = !now;
          btn.setAttribute("aria-expanded", String(now));
          item.classList.toggle("is-open", now);
        },
      },
      h("span", { class: "w-reveal__label" }, inlineText(it.label || `Item ${i + 1}`)),
      h("span", { class: "w-reveal__chev", "aria-hidden": "true" }, "+")
    );
    item.append(btn, body);
    list.appendChild(item);
  });
  root.appendChild(list);
  return root;
}

// ---------------------------------------------------------------- compare toggle

function normalizeSide(side) {
  if (!side || typeof side !== "object") return undefined;
  const label = str(side.label);
  const points = Array.isArray(side.points) ? side.points.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean) : [];
  return label || points.length ? { label, points } : undefined;
}

export function normalizeCompareToggle({ data, title, left, right } = {}) {
  const d = asRecord(data);
  return { title: firstStr(title, d.title) || "Compare", left: normalizeSide(left ?? d.left), right: normalizeSide(right ?? d.right) };
}

export function LessonCompareToggle(props) {
  const n = normalizeCompareToggle(props);
  if (!n.left || !n.right) return null;
  const labels = [n.left.label || "Option A", n.right.label || "Option B"];
  const root = h("div", { class: "w-compare", "data-active": "left" });
  const seg = h("div", { class: "w-segmented", role: "group", "aria-label": n.title });
  const buttons = ["left", "right"].map((side, i) =>
    h("button", { type: "button", class: "w-seg-btn", "aria-pressed": String(side === "left"), onClick: () => setActive(side) }, labels[i])
  );
  seg.append(...buttons);
  function setActive(side) {
    root.dataset.active = side;
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String((i === 0 ? "left" : "right") === side)));
  }
  const col = (sideKey, side, i) =>
    h(
      "div",
      { class: `w-compare__col w-compare__col--${sideKey}` },
      h("div", { class: "w-compare__label" }, labels[i]),
      h("ul", { class: "w-compare__points" }, side.points.map((p) => h("li", null, inlineText(p))))
    );
  root.append(h("div", { class: "w-muted-title" }, n.title), seg, h("div", { class: "w-compare__grid" }, col("left", n.left, 0), col("right", n.right, 1)));
  return root;
}

// ---------------------------------------------------------------- input/output slider

export function normalizeInputOutputSlider({ data, title, inputLabel, outputLabel, unit, stops } = {}) {
  const d = asRecord(data);
  const list = Array.isArray(stops) ? stops : Array.isArray(d.stops) ? d.stops : [];
  const norm = list
    .map((st, i) => {
      if (!st || typeof st !== "object") return null;
      const value = typeof st.value === "number" ? st.value : i + 1;
      const label = typeof st.label === "string" ? st.label.trim() : undefined;
      const output = typeof st.output === "string" ? st.output.trim() : typeof st.description === "string" ? st.description.trim() : undefined;
      const description = typeof st.description === "string" ? st.description.trim() : undefined;
      return output || description || label ? { value, label, output, description } : null;
    })
    .filter(Boolean);
  return {
    title: firstStr(title, d.title) || "Input to Output",
    inputLabel: firstStr(inputLabel, d.inputLabel) || "Input",
    outputLabel: firstStr(outputLabel, d.outputLabel) || "Output",
    unit: firstStr(unit, d.unit) || "",
    stops: norm,
  };
}

export function LessonInputOutputSlider(props) {
  const n = normalizeInputOutputSlider(props);
  if (n.stops.length === 0) return null;
  let index = Math.floor((n.stops.length - 1) / 2);
  const badge = h("span", { class: "w-badge" });
  const out = h("div", { class: "w-slider__output", "aria-live": "polite" });
  const range = h("input", {
    type: "range",
    min: "0",
    max: String(n.stops.length - 1),
    step: "1",
    value: String(index),
    class: "w-range",
    "aria-label": n.inputLabel,
    onInput: (e) => {
      index = Number(e.target.value);
      update();
    },
  });
  const ticks = h(
    "div",
    { class: "w-slider__ticks" },
    n.stops.map((st, i) =>
      h("button", { type: "button", class: "w-tick", onClick: () => { index = i; range.value = String(i); update(); } }, st.label || String(st.value))
    )
  );
  function update() {
    const st = n.stops[index];
    badge.textContent = `${st.label || String(st.value ?? index + 1)}${n.unit ? ` ${n.unit}` : ""}`;
    const pct = n.stops.length > 1 ? (index / (n.stops.length - 1)) * 100 : 50;
    range.style.setProperty("--pct", `${pct}%`);
    [...ticks.children].forEach((t, i) => t.classList.toggle("is-active", i === index));
    out.replaceChildren(
      h("div", { class: "w-slider__out-label" }, n.outputLabel),
      h("div", { class: "w-slider__out-value" }, inlineText(st.output || st.description || "")),
      st.description && st.output && st.description !== st.output ? h("p", { class: "w-secondary" }, inlineText(st.description)) : null
    );
  }
  const root = h(
    "div",
    { class: "w-slider" },
    h("div", { class: "w-row-between" }, h("span", { class: "w-muted-title" }, n.title), badge),
    h("div", { class: "w-card w-slider__card" }, h("div", { class: "w-slider__in-label" }, n.inputLabel), range, ticks, out)
  );
  update();
  return root;
}

// ---------------------------------------------------------------- table

export function normalizeLessonTable({ data, title, columns, rows } = {}) {
  const d = asRecord(data);
  const cols = (Array.isArray(columns) ? columns : Array.isArray(d.columns) ? d.columns : [])
    .filter((c) => typeof c === "string" || typeof c === "number")
    .map((c) => String(c).trim())
    .filter(Boolean)
    .slice(0, 4);
  const rws = (Array.isArray(rows) ? rows : Array.isArray(d.rows) ? d.rows : [])
    .map((r) => {
      if (!Array.isArray(r)) return null;
      const cells = r.filter((c) => typeof c === "string" || typeof c === "number").map((c) => String(c).trim()).slice(0, 4);
      return cells.length > 0 ? cells : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  const width = Math.max(cols.length, ...rws.map((r) => r.length), 0);
  const finalCols = cols.length > 0 ? cols : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const padded = rws.map((r) => (r.length >= width ? r : [...r, ...Array.from({ length: width - r.length }, () => "N/A")]));
  return { title: firstStr(title, d.title), columns: finalCols, rows: padded };
}

export function LessonTable(props) {
  const n = normalizeLessonTable(props);
  if (n.columns.length === 0 || n.rows.length === 0) return null;
  return h(
    "div",
    { class: "w-table-wrap" },
    n.title ? h("div", { class: "w-muted-title" }, inlineText(n.title)) : null,
    h(
      "div",
      { class: "w-table-scroll" },
      h(
        "table",
        { class: "w-table" },
        h("caption", { class: "sr-only" }, n.title || "Lesson table"),
        h("thead", null, h("tr", null, n.columns.map((c) => h("th", { scope: "col" }, inlineText(c))))),
        h("tbody", null, n.rows.map((r) => h("tr", null, r.map((c, i) => (i === 0 ? h("th", { scope: "row" }, inlineText(c)) : h("td", null, inlineText(c)))))))
      )
    )
  );
}

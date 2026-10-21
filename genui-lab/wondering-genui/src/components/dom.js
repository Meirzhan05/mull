// Tiny DOM helpers. Nothing here touches `document` at import time, so modules
// that import it stay loadable in Node (only rendering needs a DOM).

const SVG_NS = "http://www.w3.org/2000/svg";

function append(el, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    child.forEach((c) => append(el, c));
    return;
  }
  if (typeof child === "string" || typeof child === "number") {
    el.appendChild(document.createTextNode(String(child)));
    return;
  }
  el.appendChild(child);
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class" || key === "className") {
      if (isSvg) el.setAttribute("class", value);
      else el.className = value;
    } else if (key === "style" && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null) continue;
        if (k.startsWith("--")) el.style.setProperty(k, v);
        else el.style[k] = v;
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "text") {
      el.textContent = value;
    } else if (key === "html") {
      throw new Error("raw html is not allowed");
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

/** h("div", {class:"x", onClick}, ...children) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  append(el, children);
  return el;
}

/** s("rect", {x:1}) creates an SVG element. */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// --- shared normalisation helpers (pure) ----------------------------------

export function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function str(v) {
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

export function firstStr(...vals) {
  for (const v of vals) {
    const t = str(v);
    if (t) return t;
  }
  return undefined;
}

export function normalizeStringList(v) {
  return Array.isArray(v)
    ? v.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean)
    : [];
}

// Accent palette from INTERACTIVE_COLORS (@3436064) + getAccentColor (@3436904).
export const ACCENTS = ["#7BCAFF", "#879A39", "#FF7562", "#FFA01E", "#DFB431", "#5ABDAC", "#7992FF", "#62A2CC"];
export function getAccentColor(i) {
  return ACCENTS[((i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
}

let uid = 0;
export function nextId(prefix = "w") {
  uid += 1;
  return `${prefix}-${uid}`;
}

/** Small inline-markdown renderer used inside components (bold/italic/code only). */
export function inlineText(text) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) frag.appendChild(h("strong", null, tok.slice(2, -2)));
    else if (tok.startsWith("`")) frag.appendChild(h("code", null, tok.slice(1, -1)));
    else frag.appendChild(h("em", null, tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

// Markdown pipeline modelled on MemoizedReactMarkdown (@4105554):
//   normalizeLatexDelimiters -> processInteractiveComponents -> markdown -> placeholder swap
// plus SourceGroundedAnswer citation handling (replaceSourceMarkers @2880293) and
// keyword highlighting (parseKeywordsInText @4133885).
// Everything above the "DOM rendering" divider is pure and Node-testable.

import { processInteractiveComponents } from "./markers.js";

// ============================================================ LaTeX delimiters
// Exact port of normalizeLatexDelimiters and its helpers (@4100300-@4103340).

const countBacktickRun = (s, i) => {
  let j = i;
  while (s[j] === "`") j += 1;
  return j - i;
};

const findFenceMarkerStart = (s, lineStart, lineEnd, depth) => {
  let i = lineStart;
  for (let d = 0; d < depth; d += 1) {
    const limit = Math.min(i + 3, lineEnd);
    while (i < limit && s[i] === " ") i += 1;
    if (s[i] !== ">") return null;
    i += 1;
    if (s[i] === " " || s[i] === "\t") i += 1;
  }
  const limit = Math.min(i + 3, lineEnd);
  while (i < limit && s[i] === " ") i += 1;
  return i;
};

const getOpeningBlockquoteDepth = (s, lineStart, pos) => {
  let depth = 0;
  for (;;) {
    const at = findFenceMarkerStart(s, lineStart, pos, depth);
    if (at === pos) return depth;
    if (at === null || s[at] !== ">") return null;
    depth += 1;
  }
};

const findTildeFenceEnd = (s, pos) => {
  const lineStart = s.lastIndexOf("\n", pos - 1) + 1;
  const depth = getOpeningBlockquoteDepth(s, lineStart, pos);
  if (depth === null) return null;
  let i = pos;
  while (s[i] === "~") i += 1;
  const run = i - pos;
  if (run < 3) return null;
  const nl = s.indexOf("\n", i);
  if (nl === -1) return s.length;
  let line = nl + 1;
  while (line < s.length) {
    const next = s.indexOf("\n", line);
    const end = next === -1 ? s.length : next;
    const at = findFenceMarkerStart(s, line, end, depth);
    if (at === null) return line;
    let k = at;
    while (s[k] === "~") k += 1;
    if (k - at >= run && /^[\t ]*\r?$/.test(s.slice(k, end))) return next === -1 ? end : next + 1;
    if (next === -1) return s.length;
    line = next + 1;
  }
  return s.length;
};

const findClosingDelimiter = (s, delim, from) => {
  let i = s.indexOf(delim, from);
  while (i !== -1) {
    let bs = 0;
    for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) bs += 1;
    if (bs % 2 === 0) return i;
    i = s.indexOf(delim, i + delim.length);
  }
  return -1;
};

const isEscaped = (s, i) => {
  let bs = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k -= 1) bs += 1;
  return bs % 2 === 1;
};

const findClosingSingleDollar = (s, from) => {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "\n") return -1;
    if (s[i] === "$" && s[i - 1] !== "$" && s[i + 1] !== "$" && !isEscaped(s, i)) return i;
  }
  return -1;
};

export const isLikelySingleDollarMath = (t) => {
  if (!t || t.trim() !== t) return false;
  if (/\\[A-Za-z]+/.test(t) || /^\p{L}$/u.test(t) || /^\(\s*[\p{L}\p{N}.']+\s*(?:,\s*[\p{L}\p{N}.']+\s*)+\)$/u.test(t)) return true;
  const hasOp = /[=^_{}<>+*/-]/.test(t);
  const mathy = /^[\p{L}\p{N}\s\\()[\]{},.'=^_{}<>+*/-]+$/u.test(t);
  return hasOp && mathy ? true : /^\p{L}[\p{L}\p{N}]*\([^\n)]*\)$/u.test(t);
};

/** Rewrites \( \), \[ \] and likely-math $…$ to $$…$$, skipping code spans/fences and existing $$…$$. */
export const normalizeLatexDelimiters = (s) => {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "~") {
      const end = findTildeFenceEnd(s, i);
      if (end !== null) {
        out += s.slice(i, end);
        i = end;
        continue;
      }
    }
    if (s[i] === "`") {
      const run = countBacktickRun(s, i);
      const fence = "`".repeat(run);
      const close = s.indexOf(fence, i + run);
      if (close === -1) {
        out += s.slice(i);
        break;
      }
      const end = close + run;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (s.startsWith("\\\\", i)) {
      out += "\\\\";
      i += 2;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "\\(" || two === "\\[") {
      const closer = two === "\\(" ? "\\)" : "\\]";
      const close = findClosingDelimiter(s, closer, i + two.length);
      if (close !== -1) {
        out += `$$${s.slice(i + 2, close)}$$`;
        i = close + closer.length;
        continue;
      }
    }
    if (s.startsWith("$$", i)) {
      const close = s.indexOf("$$", i + 2);
      if (close === -1) {
        out += s.slice(i);
        break;
      }
      const end = close + 2;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (s[i] === "$" && !isEscaped(s, i)) {
      const close = findClosingSingleDollar(s, i + 1);
      if (close !== -1) {
        const inner = s.slice(i + 1, close);
        // "$5+$3" style prices are not math.
        if (!(/^\d[\d,.]*[+*/=\-–—]$/.test(inner) && /^\d$/.test(s[close + 1] ?? "")) && isLikelySingleDollarMath(inner)) {
          out += `$$${inner}$$`;
          i = close + 1;
          continue;
        }
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
};

// ============================================================ citations
// Exact ports of replaceSourceMarkers / sourceMarkerHoldIndex / sourceCitationContent.

export function replaceSourceMarkers(text, resolve) {
  return text.replace(/\[\[?SOURCE:[^\]\n]*\](?:[ \t]*[,;][ \t]*\[SOURCE:[^\]\n]*\])*\]?/g, (m) =>
    [...m.matchAll(/SOURCE:([^\]\n]+)/g)]
      .map((x) => resolve(x[1].trim()))
      .filter(Boolean)
      .join(", ")
  );
}

/** Index at which a (possibly partial) trailing source marker starts, or -1. */
export function sourceMarkerHoldIndex(text) {
  const prefixes = ["[[SOURCE:", "[SOURCE:"];
  for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1)) {
    const rest = text.slice(i);
    if (prefixes.some((p) => p.startsWith(rest))) return i;
    const prefix = prefixes.find((p) => rest.startsWith(p));
    if (!prefix) continue;
    const closer = prefix.startsWith("[[") ? "]]" : "]";
    const end = text.indexOf(closer, i + prefix.length);
    if (end < 0) return i;
    i = end + closer.length - 1;
  }
  return -1;
}

/**
 * citations: [{passageId, quote, ...}] (only ones with a quote are numbered).
 * Produces markdown where markers become `[n](#<prefix>-n)` citation links; a
 * partial trailing marker is held back so `[[SOU` never flashes while streaming.
 */
export function sourceCitationContent(text, citations = [], prefix = "cite") {
  const quoted = citations.filter((c) => c.quote);
  const hold = sourceMarkerHoldIndex(text);
  const visible = hold < 0 ? text : text.slice(0, hold);
  return replaceSourceMarkers(visible, (pid) => {
    const i = quoted.findIndex((c) => c.passageId === pid);
    return i < 0 ? "" : `[S${i + 1}]`;
  }).replace(/([ \t]*)(\[S\d+\](?:[ \t]*[,;]?[ \t]*\[S\d+\])*)/g, (m, space, group) =>
    [...new Set([...group.matchAll(/\d+/g)].map(([n]) => Number(n)))]
      .filter((n) => quoted[n - 1])
      .sort((a, b) => a - b)
      .map((n) => `[${n}](#${prefix}-${n})`)
      .join("") || space
  );
}

// ============================================================ keywords

/**
 * Port of parseKeywordsInText: whole-word, case-insensitive, longest term first,
 * non-overlapping. Returns segments: string | {term, definition, matchedText}.
 */
export function parseKeywordsInText(text, keywords) {
  if (!keywords || keywords.length === 0) return [text];
  const sorted = [...keywords].sort((a, b) => b.term.length - a.term.length);
  const hits = [];
  for (const kw of sorted) {
    const escaped = kw.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = hits.some((h) => (start >= h.start && start < h.end) || (end > h.start && end <= h.end) || (start <= h.start && end >= h.end));
      if (!overlaps) hits.push({ start, end, term: kw.term, definition: kw.definition, matchedText: m[0] });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const hit of hits) {
    if (hit.start > pos) out.push(text.substring(pos, hit.start));
    out.push({ term: hit.term, definition: hit.definition, matchedText: hit.matchedText });
    pos = hit.end;
  }
  if (pos < text.length) out.push(text.substring(pos));
  return out;
}

/** withoutPageMarkers (@4111915): strips `<!-- page N -->`. */
export function withoutPageMarkers(text) {
  return text.replace(/^[ \t]*<!--\s*page\s+\d+\s*-->[ \t]*\n?/gim, "");
}

// ============================================================ block parser

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

export function parseBlocks(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", text: para.join("\n") });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(FENCE))) {
      flushPara();
      const marker = m[1];
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && lines[i].trim().replace(new RegExp(`^\\${marker[0]}+`), "").trim() === "")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang: m[2] || "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    if ((m = line.match(HEADING))) {
      flushPara();
      blocks.push({ type: "heading", level: m[1].length, text: m[2] });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      flushPara();
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
        inner.push(lines[i].match(QUOTE)[1]);
        i += 1;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner.join("\n")) });
      continue;
    }
    const ul = line.match(UL_ITEM);
    const ol = line.match(OL_ITEM);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const start = ordered ? Number(ol[2]) : 1;
      const items = [];
      const itemRe = ordered ? OL_ITEM : UL_ITEM;
      while (i < lines.length) {
        const cur = lines[i];
        const im = cur.match(itemRe);
        if (im) {
          items.push(ordered ? im[3] : im[2]);
          i += 1;
          continue;
        }
        if (!cur.trim()) {
          // blank line: continue the list only if the next non-blank line is another item
          let k = i + 1;
          while (k < lines.length && !lines[k].trim()) k += 1;
          if (k < lines.length && itemRe.test(lines[k])) {
            i = k;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(cur) && items.length) {
          // continuation / nested item: flatten into the current item
          const nested = cur.match(UL_ITEM) || cur.match(OL_ITEM);
          items[items.length - 1] += nested ? `\n• ${nested[nested.length - 1]}` : `\n${cur.trim()}`;
          i += 1;
          continue;
        }
        if (HEADING.test(cur) || QUOTE.test(cur) || FENCE.test(cur) || (ordered ? UL_ITEM : OL_ITEM).test(cur)) break;
        // lazy continuation
        items[items.length - 1] += `\n${cur.trim()}`;
        i += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}

// ============================================================ inline parser

const PLACEHOLDER_AT = /^%%%INTERACTIVE_\d+%%%/;
const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

function findClosing(text, delim, from) {
  let i = text.indexOf(delim, from);
  while (i !== -1 && text[i - 1] === "\\") i = text.indexOf(delim, i + 1);
  return i;
}

function matchBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseLinkTarget(text, at) {
  // at points to "(" ; returns {href,title,end}
  if (text[at] !== "(") return null;
  const close = text.indexOf(")", at);
  if (close === -1) return null;
  const inner = text.slice(at + 1, close).trim();
  const m = inner.match(/^<?([^\s>]*)>?(?:\s+["'](.*)["'])?$/);
  if (!m) return null;
  return { href: m[1], title: m[2], end: close + 1 };
}

/** Inline tokens: text, strong, em, code, math, link, image, placeholder. */
export function parseInline(text) {
  const tokens = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      tokens.push({ type: "text", value: buf });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    let m;
    if (ch === "%" && (m = rest.match(PLACEHOLDER_AT))) {
      flush();
      tokens.push({ type: "placeholder", key: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!$%>~|]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = countBacktickRun(text, i);
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close !== -1) {
        flush();
        tokens.push({ type: "code", value: text.slice(i + run, close).replace(/^ (.*) $/, "$1") });
        i = close + run;
        continue;
      }
    }
    if (rest.startsWith("$$")) {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1) {
        flush();
        tokens.push({ type: "math", tex: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const d = rest.slice(0, 2);
      const close = findClosing(text, d, i + 2);
      if (close > i + 2) {
        flush();
        tokens.push({ type: "strong", children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] && !/\s/.test(text[i + 1])) {
      const leftOk = ch === "*" || i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]);
      if (leftOk) {
        let close = i + 1;
        while ((close = text.indexOf(ch, close)) !== -1) {
          if (text[close + 1] === ch) {
            close += 2;
            continue;
          }
          if (!/\s/.test(text[close - 1]) && (ch === "*" || !/[\p{L}\p{N}]/u.test(text[close + 1] ?? ""))) break;
          close += 1;
        }
        if (close !== -1 && close > i + 1) {
          flush();
          tokens.push({ type: "em", children: parseInline(text.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }
    if (ch === "!" && text[i + 1] === "[") {
      const end = matchBracket(text, i + 1);
      const target = end !== -1 ? parseLinkTarget(text, end + 1) : null;
      if (target) {
        flush();
        tokens.push({ type: "image", alt: text.slice(i + 2, end), src: target.href, title: target.title });
        i = target.end;
        continue;
      }
    }
    if (ch === "[") {
      const end = matchBracket(text, i);
      const target = end !== -1 ? parseLinkTarget(text, end + 1) : null;
      if (target) {
        flush();
        tokens.push({ type: "link", href: target.href, title: target.title, children: parseInline(text.slice(i + 1, end)) });
        i = target.end;
        continue;
      }
    }
    if (rest.startsWith("http://") || rest.startsWith("https://")) {
      const um = rest.match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/);
      if (um) {
        flush();
        tokens.push({ type: "link", href: um[0], children: [{ type: "text", value: um[0] }] });
        i += um[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/** Full pure pipeline result (used by tests and by the DOM renderer). */
export function prepareMarkdown(content, opts = {}) {
  const normalized = normalizeLatexDelimiters(withoutPageMarkers(content));
  if (opts.disableEmbeddedContent) return { processedContent: normalized, placeholderMap: new Map(), blocks: parseBlocks(normalized) };
  const { processedContent, placeholderMap } = processInteractiveComponents(normalized, opts.experimentContext, {
    rejectInvalidMarkers: !!opts.rejectInvalidEmbeddedContent,
    isStreaming: !!opts.isContentStreaming,
    track: opts.track,
    warn: opts.warn,
    ...(opts.getComponent ? { getComponent: opts.getComponent } : {}),
  });
  return { processedContent, placeholderMap, blocks: parseBlocks(processedContent) };
}

/** Plain-text projection (what a user would "see" ignoring components) – handy for tests. */
export function visibleText(content, opts = {}) {
  const { processedContent } = prepareMarkdown(content, opts);
  return processedContent.replace(/%%%INTERACTIVE_\d+%%%/g, "");
}

// ============================================================ TeX-lite
// No KaTeX (dependency-free): a tiny display transform for common TeX.

const TEX_SYMBOLS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ",
  tau: "τ", phi: "φ", omega: "ω", Sigma: "Σ", Delta: "Δ", cdot: "·", times: "×", div: "÷", pm: "±", leq: "≤", geq: "≥",
  neq: "≠", approx: "≈", infty: "∞", sum: "∑", prod: "∏", rightarrow: "→", to: "→", leftarrow: "←", in: "∈", sqrt: "√",
  ldots: "…", cdots: "⋯", log: "log", exp: "exp", max: "max", min: "min", softmax: "softmax",
};

function readGroup(t, i) {
  // t[i] === "{" ; returns [content, endIndexExclusive]
  let depth = 0;
  for (let k = i; k < t.length; k++) {
    if (t[k] === "{") depth += 1;
    else if (t[k] === "}") {
      depth -= 1;
      if (depth === 0) return [t.slice(i + 1, k), k + 1];
    }
  }
  return [t.slice(i + 1), t.length];
}

/** \frac{a}{b} -> (a)/(b) with balanced braces (nested fractions too). */
export function expandFractions(tex) {
  let out = "";
  let i = 0;
  while (i < tex.length) {
    if (tex.startsWith("\\frac", i) && tex[i + 5] === "{") {
      const [num, a] = readGroup(tex, i + 5);
      if (tex[a] === "{") {
        const [den, b] = readGroup(tex, a);
        out += `(${expandFractions(num)})/(${expandFractions(den)})`;
        i = b;
        continue;
      }
    }
    out += tex[i];
    i += 1;
  }
  return out;
}

export function texToTokens(tex) {
  // returns [{t:'text'|'sup'|'sub', v}]
  const out = [];
  let s = expandFractions(tex)
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^{}]*)\}/g, "$1")
    .replace(/\\(left|right)/g, "")
    .replace(/\\([A-Za-z]+)/g, (m, name) => (name in TEX_SYMBOLS ? TEX_SYMBOLS[name] : name))
    .replace(/\\,|\\;|\\!/g, " ");
  let i = 0;
  let buf = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "^" || c === "_") {
      if (buf) {
        out.push({ t: "text", v: buf });
        buf = "";
      }
      let v;
      if (s[i + 1] === "{") {
        const close = s.indexOf("}", i + 2);
        v = s.slice(i + 2, close === -1 ? s.length : close);
        i = close === -1 ? s.length : close + 1;
      } else {
        v = s[i + 1] ?? "";
        i += 2;
      }
      out.push({ t: c === "^" ? "sup" : "sub", v });
      continue;
    }
    if (c !== "{" && c !== "}") buf += c;
    i += 1;
  }
  if (buf) out.push({ t: "text", v: buf });
  return out;
}

// ==================================================================================
// ============================================================ DOM rendering (browser)
// ==================================================================================

function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function renderMath(tex, display) {
  const node = el(display ? "div" : "span", display ? "md-math md-math--display" : "md-math");
  node.setAttribute("title", tex);
  node.setAttribute("role", "math");
  node.setAttribute("aria-label", tex);
  for (const tok of texToTokens(tex)) node.append(tok.t === "text" ? document.createTextNode(tok.v) : el(tok.t, null, tok.v));
  return node;
}

/** Error boundary equivalent of InteractiveComponentErrorBoundary (@4090500). */
export function renderInteractiveEntry(entry, opts = {}) {
  const wrap = el("div", "md-embed");
  wrap.dataset.component = entry.componentName;
  if (entry.instanceId) wrap.dataset.instanceId = entry.instanceId;
  try {
    const node = entry.Component({ ...entry.params });
    if (!node) return document.createDocumentFragment();
    wrap.append(node);
  } catch (err) {
    console.error(err);
    opts.track?.("interactive_component_render_failed", { componentName: entry.componentName, message: String(err && err.message), ...(entry.experimentContext || {}) });
    wrap.className = "md-embed md-embed--error";
    wrap.append(el("p", null, `Interactive component failed to load: ${entry.componentName}`));
  }
  if (entry.altText) wrap.append(el("span", "sr-only", entry.altText));
  return wrap;
}

function renderTextWithKeywords(text, opts) {
  if (!opts.keywords || !opts.keywords.length) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  for (const seg of parseKeywordsInText(text, opts.keywords)) {
    if (typeof seg === "string") frag.append(seg);
    else {
      const b = el("button", "md-keyword", seg.matchedText);
      b.type = "button";
      b.title = seg.definition || seg.term;
      b.addEventListener("click", () => opts.onExplain?.(seg.term, seg.definition));
      frag.append(b);
    }
  }
  return frag;
}

function renderInlineTokens(tokens, ctx, opts) {
  const frag = document.createDocumentFragment();
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        frag.append(ctx.inLink ? document.createTextNode(t.value) : renderTextWithKeywords(t.value, opts));
        break;
      case "strong":
        frag.append(el("strong", null, renderInlineTokens(t.children, ctx, opts)));
        break;
      case "em":
        frag.append(el("em", null, renderInlineTokens(t.children, ctx, opts)));
        break;
      case "code":
        frag.append(el("code", null, t.value));
        break;
      case "math":
        frag.append(renderMath(t.tex, false));
        break;
      case "image": {
        if (t.src === "PLACEHOLDER" || !SAFE_HREF.test(t.src)) break;
        const img = el("img", "md-img");
        img.src = t.src;
        img.alt = t.alt;
        img.loading = "lazy";
        frag.append(img);
        break;
      }
      case "link": {
        if (!SAFE_HREF.test(t.href)) {
          frag.append(renderInlineTokens(t.children, ctx, opts));
          break;
        }
        const isCitation = t.href.startsWith("#") && opts.citationPrefix && t.href.startsWith(`#${opts.citationPrefix}-`);
        const a = el("a", isCitation ? "md-cite" : "md-link", renderInlineTokens(t.children, { ...ctx, inLink: true }, opts));
        a.href = t.href;
        if (t.title) a.title = t.title;
        if (!t.href.startsWith("#")) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        frag.append(a);
        break;
      }
      case "placeholder": {
        const entry = ctx.placeholderMap.get(t.key);
        frag.append(entry ? renderInteractiveEntry(entry, opts) : document.createTextNode(""));
        break;
      }
    }
  }
  return frag;
}

function renderParagraph(text, ctx, opts, parent) {
  const tokens = parseInline(text);
  // Hoist placeholders out of <p> (block widgets can't live inside a paragraph).
  let run = [];
  const flushRun = () => {
    const hasContent = run.some((t) => t.type !== "text" || t.value.trim());
    if (hasContent) {
      if (run[0]?.type === "text") run[0] = { ...run[0], value: run[0].value.replace(/^\s*\n/, "") };
      const last = run[run.length - 1];
      if (last?.type === "text") run[run.length - 1] = { ...last, value: last.value.replace(/\n\s*$/, "") };
      // a paragraph that is only $$…$$ is display math
      if (run.length === 1 && run[0].type === "math") parent.append(renderMath(run[0].tex, true));
      else parent.append(el("p", "md-p", renderInlineTokens(run, ctx, opts)));
    }
    run = [];
  };
  for (const t of tokens) {
    if (t.type === "placeholder") {
      flushRun();
      const entry = ctx.placeholderMap.get(t.key);
      if (entry) parent.append(renderInteractiveEntry(entry, opts));
    } else run.push(t);
  }
  flushRun();
}

function renderBlocks(blocks, ctx, opts, parent) {
  for (const b of blocks) {
    switch (b.type) {
      case "heading": {
        const lvl = Math.min(6, b.level + (opts.headingOffset ?? 0));
        parent.append(el(`h${lvl}`, `md-h md-h${b.level}`, renderInlineTokens(parseInline(b.text), ctx, opts)));
        break;
      }
      case "paragraph":
        renderParagraph(b.text, ctx, opts, parent);
        break;
      case "list": {
        const list = el(b.ordered ? "ol" : "ul", "md-list");
        if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
        for (const item of b.items) {
          const li = el("li", null);
          renderParagraph(item, ctx, opts, li);
          // unwrap single <p> inside li
          if (li.childNodes.length === 1 && li.firstChild.tagName === "P") li.replaceChildren(...li.firstChild.childNodes);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "blockquote": {
        const q = el("blockquote", "md-quote");
        renderBlocks(b.children, ctx, opts, q);
        parent.append(q);
        break;
      }
      case "code": {
        const code = el("code", b.lang ? `language-${b.lang}` : null, b.text);
        const pre = el("pre", "md-pre", code);
        pre.dir = "ltr";
        parent.append(pre);
        break;
      }
      case "hr":
        parent.append(el("hr", "md-hr"));
        break;
    }
  }
}

/**
 * Renders markdown with interactive markers to a <div>.
 * opts: { rejectInvalidEmbeddedContent, isContentStreaming, disableEmbeddedContent,
 *         keywords:[{term,definition}], onExplain, citationPrefix, experimentContext, track }
 */
export function renderMarkdown(content, opts = {}) {
  const root = el("div", `md${opts.className ? " " + opts.className : ""}`);
  const { blocks, placeholderMap } = prepareMarkdown(content ?? "", opts);
  renderBlocks(blocks, { placeholderMap, inLink: false }, opts, root);
  return root;
}

/** SourceGroundedAnswer: citation markers -> numbered links + a source list. */
export function renderSourceGroundedAnswer(content, citations = [], opts = {}) {
  const prefix = opts.citationPrefix || "cite";
  const md = sourceCitationContent(content, citations, prefix);
  const root = renderMarkdown(md, { ...opts, citationPrefix: prefix });
  const quoted = citations.filter((c) => c.quote);
  if (quoted.length && !opts.isContentStreaming) {
    const list = el("ol", "md-sources");
    quoted.forEach((c, i) => {
      const li = el("li", null);
      li.id = `${prefix}-${i + 1}`;
      const a = el("a", "md-link", c.title || c.url || `Source ${i + 1}`);
      if (c.url && /^https?:/.test(c.url)) {
        a.href = c.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      li.append(a, el("q", "md-source-quote", c.quote));
      list.append(li);
    });
    root.append(el("div", "md-sources-wrap", el("div", "md-sources-title", "Sources"), list));
  }
  return root;
}

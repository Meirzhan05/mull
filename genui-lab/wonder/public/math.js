// Math typesetting. chatgpt-dil's host renders the `math` primitive as plain text (README:
// "Math is a plain-text fallback with no KaTeX"); Wonder keeps the host unmodified and
// typesets rendered math nodes with KaTeX (served read-only from /vendor/katex/). The host's
// own text spans stay in place (hidden by math.css) so its streaming updates keep working; the
// typeset output lives in a sibling <span class="wonder-math-out"> and is re-rendered only when
// the LaTeX text changes. If KaTeX cannot load, the same span shows a Unicode rewrite instead
// (prettyLatex: \frac{1}{\lambda^4} -> 1⁄λ⁴), which is also what shows while KaTeX loads.

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  propto: '∝', times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', approx: '≈', sim: '∼', equiv: '≡', neq: '≠', ne: '≠', le: '≤', leq: '≤',
  ge: '≥', geq: '≥', ll: '≪', gg: '≫', infty: '∞', to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', leftrightarrow: '↔', implies: '⇒',
  sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇', degree: '°', circ: '°', ldots: '…', cdots: '⋯', dots: '…', in: '∈', notin: '∉',
  subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', log: 'log', ln: 'ln', exp: 'exp', sin: 'sin',
  cos: 'cos', tan: 'tan', lim: 'lim', max: 'max', min: 'min', percent: '%',
};
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', t: 'ᵗ', x: 'ˣ', k: 'ᵏ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', m: 'ᵐ', r: 'ʳ', T: 'ᵀ', '−': '⁻' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', n: 'ₙ', o: 'ₒ', r: 'ᵣ', t: 'ₜ', x: 'ₓ', k: 'ₖ', m: 'ₘ', p: 'ₚ', s: 'ₛ' };

const script = (body, map, mark) => {
  const chars = [...body.replace(/\s+/g, '')];
  return chars.every((c) => map[c]) ? chars.map((c) => map[c]).join('') : `${mark}(${body})`;
};
const group = (s) => (/^[\w.⁰-⁹α-ωΑ-Ω√]+$/u.test(s.trim()) ? s.trim() : `(${s.trim()})`);

export function prettyLatex(src) {
  let s = String(src ?? '');
  if (!/[\\^_{}]/.test(s)) return s;
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf|mbox)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(?:left|right|big|Big|bigg|displaystyle)\b/g, '');
  s = s.replace(/\\([A-Za-z]+)/g, (m, name) => SYMBOLS[name] ?? m);
  for (let k = 0; k < 4; k++) {
    s = s.replace(/\^\{([^{}]*)\}/g, (_, b) => script(b, SUP, '^')).replace(/_\{([^{}]*)\}/g, (_, b) => script(b, SUB, '_'));
    s = s.replace(/\^([\w+\-−])/g, (_, b) => script(b, SUP, '^')).replace(/_([\w])/g, (_, b) => script(b, SUB, '_'));
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, b) => `√${group(b)}`);
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${group(a)}⁄${group(b)}`);
  }
  s = s.replace(/\\[,;:!> ]/g, ' ').replace(/\\\\/g, ' ').replace(/\\%/g, '%').replace(/[{}]/g, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

export const KATEX_OPTIONS = Object.freeze({ throwOnError: false, trust: false, output: 'htmlAndMathml', strict: 'ignore' });
const KATEX_SRC = '/vendor/katex/katex.min.js';
const MATH_SELECTOR = '.dil-root [data-d-component="math"], .dil-root .d-math-inline';

let katexPromise = null;
/** Load KaTeX once (classic script -> window.katex). Resolves to the library, or null on failure. */
export function loadKatex({ src = KATEX_SRC, timeoutMs = 5000, doc = globalThis.document } = {}) {
  if (globalThis.katex?.render) return Promise.resolve(globalThis.katex);
  if (katexPromise) return katexPromise;
  katexPromise = new Promise((resolve) => {
    if (!doc) return resolve(null);
    const s = doc.createElement('script');
    const done = (lib) => { clearTimeout(timer); resolve(lib); };
    const timer = setTimeout(() => done(globalThis.katex?.render ? globalThis.katex : null), timeoutMs);
    s.src = src;
    s.async = true;
    s.onload = () => done(globalThis.katex?.render ? globalThis.katex : null);
    s.onerror = () => done(null);
    doc.head.appendChild(s);
  });
  return katexPromise;
}

/** The LaTeX a host math node currently holds (its own text, never our typeset output). */
export function mathSource(node) {
  if (node.classList.contains('d-math-inline')) return node.__wonderLatex ?? node.textContent;
  let s = '';
  for (const c of node.childNodes) if (!(c.nodeType === 1 && c.classList.contains('wonder-math-out'))) s += c.textContent;
  return s.trim();
}

/**
 * Typeset one math node with `katex` (or the Unicode fallback when it is null). No-op when the
 * LaTeX and the renderer are unchanged, so streaming re-renders only touch formulas that moved.
 */
export function typesetMath(node, katex) {
  const latex = mathSource(node);
  const mode = katex ? 'katex' : 'text';
  if (node.__wonderLatex === latex && node.__wonderMode === mode) return false;
  const inlineMd = node.classList.contains('d-math-inline'); // the host's own markdown inline math span
  let out = inlineMd ? node : [...node.children].find((c) => c.classList.contains('wonder-math-out'));
  if (!out) {
    out = node.ownerDocument.createElement('span');
    out.className = 'wonder-math-out';
    node.appendChild(out);
  }
  // A formula appearing in a surface that is streaming (the host only creates fading
  // [data-d-streaming-word] spans for streamed text) fades in with the words around it
  // instead of popping in. Restored lessons render without word spans, so they don't animate.
  if (node.__wonderLatex === undefined && node.closest?.('.dil-root')?.querySelector('[data-d-streaming-word]')) {
    out.setAttribute('data-wonder-math-enter', '');
  }
  const display = node.hasAttribute('data-display');
  let rendered = false;
  if (katex && latex) {
    try { katex.render(latex, out, { ...KATEX_OPTIONS, displayMode: display }); rendered = true; } catch {}
  }
  if (!rendered) out.textContent = prettyLatex(latex);
  node.__wonderLatex = latex;
  node.__wonderMode = rendered ? 'katex' : mode;
  node.setAttribute('data-wonder-math', rendered ? 'katex' : 'text');
  if (!rendered) node.setAttribute('title', latex);
  else node.removeAttribute('title');
  return true;
}

/**
 * Keep every rendered math node in `root` typeset. Runs synchronously in the MutationObserver
 * callback (a microtask after the host's frame flush, before paint), so raw LaTeX never shows.
 */
export function observeMath(root = document.body, { load = loadKatex } = {}) {
  let katex = null;
  const fix = () => {
    for (const node of root.querySelectorAll(MATH_SELECTOR)) typesetMath(node, katex);
  };
  root.ownerDocument?.documentElement?.classList.add('wonder-math-on');
  const mo = new MutationObserver((records) => {
    // ignore mutations made by our own output
    if (records.every((r) => r.target.closest?.('.wonder-math-out') || r.target.parentElement?.closest('.wonder-math-out'))) return;
    fix();
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  fix();
  Promise.resolve(load()).then((lib) => { if (lib) { katex = lib; fix(); } }, () => {});
  return () => mo.disconnect();
}

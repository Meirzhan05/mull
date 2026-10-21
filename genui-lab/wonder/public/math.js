// Readable math without KaTeX. chatgpt-dil's host renders the `math` primitive as plain text
// (README: "Math is a plain-text fallback with no KaTeX"); Wonder keeps the host unmodified
// and post-processes rendered math nodes into Unicode: \frac{1}{\lambda^4} -> 1⁄λ⁴.

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

/** Keep every rendered math node in `root` prettified (the host may rewrite text later). */
export function observeMath(root = document.body) {
  const fix = () => {
    for (const node of root.querySelectorAll('.dil-root [data-d-component="math"], .dil-root .d-math-inline')) {
      const targets = node.matches('.d-math-inline') ? [node] : node.querySelectorAll('[data-d-text]');
      for (const t of targets) {
        const raw = t.textContent;
        if (t.__wonderPretty === raw) continue;
        const pretty = prettyLatex(raw);
        t.__wonderPretty = pretty;
        if (pretty !== raw) { t.textContent = pretty; node.setAttribute('title', raw); }
      }
    }
  };
  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fix(); });
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  fix();
  return () => mo.disconnect();
}

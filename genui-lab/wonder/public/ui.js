// Tiny DOM helpers (no innerHTML for any model- or user-provided text) and UI icons.

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const PATHS = {
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  send: ['M5 12h13', 'M12 5l7 7-7 7'],
  chat: ['M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  sparkles: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 19V5'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  play: ['M8 5l11 7-11 7z'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5'],
  teacher: ['M4 9l8-4 8 4-8 4z', 'M8 11v4c0 1.5 2 3 4 3s4-1.5 4-3v-4', 'M20 9v5'],
  brain: ['M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3z', 'M15 4a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 10a3 3 0 0 1-1 2.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3h0a3 3 0 0 1-3-3'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v5', 'M16 3v5'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
};

export function icon(name, cls = 'ui-icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, ms);
}

/** Minimal inline markdown (bold/italic/code) into DOM nodes. */
export function inlineMd(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  const s = String(text ?? '');
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) frag.append(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) frag.append(el('strong', null, t.slice(2, -2)));
    else if (t.startsWith('`')) frag.append(el('code', null, t.slice(1, -1)));
    else frag.append(el('em', null, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < s.length) frag.append(s.slice(last));
  return frag;
}

export function lessonTitleFrom(markdown, fallback = 'Lesson') {
  const m = /^#\s+(.+)$/m.exec(String(markdown || ''));
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim() : fallback;
}

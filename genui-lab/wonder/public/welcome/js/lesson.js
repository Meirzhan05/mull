// A small renderer for Wonder lesson markdown: headings, paragraphs, lists, and the
// learning-catalog tags Claude writes inline (<Quiz/>, <BarChart/>, <KeyTerm/>, ...).
// It follows the real compiler's streaming rule: a tag that is still being written at
// the tail is cut, never shown half-parsed. Finished tags become working widgets.
// Blocks are cached by their source text, so a widget keeps its state while the
// stream keeps writing below it.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Inline markdown on already-escaped text: **bold**, *italic*, `code`. */
function md(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Parse a tag that starts at s[i] === '<'. Returns {name, props, end, body} or
 * {partial: true} when the tag (or its JSON props) is not finished yet.
 */
export function parseTagAt(s, i) {
  const m = /^<([A-Z][A-Za-z]*)/.exec(s.slice(i, i + 40));
  if (!m) return null;
  let j = i + m[0].length;
  // A name that runs into the end of the text may still be growing ("Re" before "Reveal").
  const name = j < s.length ? m[1] : '';
  const props = {};
  const n = s.length;
  while (j < n) {
    while (j < n && /\s/.test(s[j])) j++;
    if (j >= n) return { partial: true, name };
    if (s.startsWith('/>', j)) return { name, props, end: j + 2 };
    if (s[j] === '>') {
      const close = s.indexOf(`</${name}>`, j + 1);
      if (close < 0) return { partial: true, name };
      return { name, props, end: close + name.length + 3, body: s.slice(j + 1, close) };
    }
    const pm = /^([A-Za-z_]+)=/.exec(s.slice(j, j + 40));
    if (!pm) return { partial: true, name };
    const key = pm[1];
    j += pm[0].length;
    if (s[j] === '"') {
      let k = j + 1;
      while (k < n && s[k] !== '"') k += s[k] === '\\' ? 2 : 1;
      if (k >= n) return { partial: true, name };
      props[key] = s.slice(j + 1, k);
      j = k + 1;
    } else if (s[j] === '{') {
      let depth = 0, k = j, inStr = false;
      for (; k < n; k++) {
        const c = s[k];
        if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      if (k >= n) return { partial: true, name };
      try { props[key] = JSON.parse(s.slice(j + 1, k)); } catch { props[key] = null; }
      j = k + 1;
    } else if (j >= n) return { partial: true, name };
    else return { partial: true, name };
  }
  return { partial: true, name };
}

/** Inline content with <KeyTerm/> and <Cite/>; a half-written inline tag at the end is cut. */
function inline(s, ctx) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += md(s.slice(i)); break; }
    out += md(s.slice(i, lt));
    const t = parseTagAt(s, lt);
    if (!t) { out += esc('<'); i = lt + 1; continue; }
    if (t.partial) break;
    if (t.name === 'KeyTerm') {
      const id = `kt-${ctx.uid()}`;
      out += `<span class="kt" tabindex="0" aria-describedby="${id}">${esc(t.props.term || '')}<span class="kt__def" role="tooltip" id="${id}">${esc(t.props.definition || '')}</span></span>`;
    } else if (t.name === 'Cite') {
      for (const ref of t.props.refs || []) {
        const src = ctx.sources[ref];
        if (src) out += `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title)}">${esc(src.domain.replace(/^www\./, ''))}</a>`;
      }
    }
    i = t.end;
  }
  return out;
}

/** Split markdown into source blocks. The last block may be partial. */
export function splitBlocks(text) {
  const blocks = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] === '\n') i++;
    if (i >= n) break;
    if (text[i] === '<' && /[A-Z]/.test(text[i + 1] || '')) {
      const t = parseTagAt(text, i);
      if (t && !t.partial) { blocks.push({ src: text.slice(i, t.end), complete: true }); i = t.end; continue; }
      if (t && t.partial) { blocks.push({ src: text.slice(i), complete: false, tag: t.name }); break; }
    }
    const end = text.indexOf('\n\n', i);
    if (end < 0) { blocks.push({ src: text.slice(i), complete: false }); break; }
    blocks.push({ src: text.slice(i, end), complete: true });
    i = end + 2;
  }
  return blocks;
}

// ------------------------------------------------------------------- widgets
const WIDGETS = {
  CompareToggle(p) {
    const el = div('w w-compare');
    const sides = [p.left || {}, p.right || {}];
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p>
      <div class="seg" role="tablist">${sides.map((sd, k) => `<button role="tab" aria-selected="${k === 1}" data-k="${k}">${esc(sd.label || '')}</button>`).join('')}</div>
      <ul class="w-compare__list"></ul>`;
    const list = el.querySelector('ul');
    const show = (k) => {
      el.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.k === k)));
      list.innerHTML = (sides[k].points || []).map((x) => `<li>${md(x)}</li>`).join('');
    };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) show(+b.dataset.k); });
    show(1);
    return el;
  },
  BarChart(p) {
    const el = div('w w-bars');
    const bars = p.bars || [];
    const max = Math.max(...bars.map((b) => +b.value || 0), 1);
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p>
      <div class="w-bars__rows">${bars.map((b) => `
        <div class="w-bars__row${b.highlighted ? ' is-hi' : ''}">
          <span class="w-bars__label">${esc(b.label)}</span>
          <span class="w-bars__track"><span class="w-bars__fill" style="--v:${(+b.value || 0) / max}"></span></span>
          <span class="w-bars__val">${esc(b.value)} <small>${esc(p.unit || '')}</small></span>
        </div>`).join('')}</div>`;
    return el;
  },
  Callout(p, body) {
    const el = div(`w w-callout w-callout--${esc(p.tone || 'note')}`);
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p><p>${md(body || '')}</p>`;
    return el;
  },
  Reveal(p) {
    const el = div('w w-reveal');
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p>${(p.items || []).map((it) => `
      <details><summary>${md(it.label || '')}</summary><p>${md(it.content || '')}</p></details>`).join('')}`;
    return el;
  },
  LessonStepper(p) {
    const el = div('w w-steps');
    const steps = p.steps || [];
    let k = 0;
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p>
      <ol class="w-steps__dots" aria-hidden="true">${steps.map(() => '<li></li>').join('')}</ol>
      <div class="w-steps__body" aria-live="polite"></div>
      <div class="w-steps__nav"><button data-d="-1">Back</button><button data-d="1" class="is-primary">Next step</button></div>`;
    const body = el.querySelector('.w-steps__body');
    const show = () => {
      const st = steps[k] || {};
      body.innerHTML = `<p class="w-steps__label">${md(st.label || '')}</p><p>${md(st.text || '')}</p>`;
      el.querySelectorAll('.w-steps__dots li').forEach((d, i) => d.classList.toggle('is-on', i <= k));
      el.querySelector('[data-d="-1"]').disabled = k === 0;
      el.querySelector('[data-d="1"]').disabled = k === steps.length - 1;
    };
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) { k = Math.max(0, Math.min(steps.length - 1, k + +b.dataset.d)); show(); } });
    show();
    return el;
  },
  Quiz(p) {
    const el = div('w w-quiz');
    const qs = p.questions || [];
    const answered = new Map();
    el.innerHTML = `<p class="w__title">${esc(p.title || 'Quiz')}</p>${qs.map((q, qi) => `
      <fieldset class="w-quiz__q" data-q="${qi}">
        <legend>${md(q.prompt || '')}</legend>
        <div class="w-quiz__opts">${(q.options || []).map((o) => `<button type="button" data-v="${esc(o.value)}">${md(o.label || '')}</button>`).join('')}</div>
        <p class="w-quiz__fb" aria-live="polite"></p>
      </fieldset>`).join('')}<p class="w-quiz__score" aria-live="polite"></p>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const fs = b.closest('[data-q]');
      const qi = +fs.dataset.q;
      if (answered.has(qi)) return;
      const q = qs[qi];
      const ok = (q.correct_values || []).includes(b.dataset.v);
      answered.set(qi, ok);
      fs.querySelectorAll('button').forEach((x) => {
        x.disabled = true;
        if ((q.correct_values || []).includes(x.dataset.v)) x.classList.add('is-right');
      });
      if (!ok) b.classList.add('is-wrong');
      fs.querySelector('.w-quiz__fb').innerHTML = `<strong>${ok ? 'Right.' : 'Not quite.'}</strong> ${md(q.explanation || '')}`;
      if (answered.size === qs.length) {
        const right = [...answered.values()].filter(Boolean).length;
        el.querySelector('.w-quiz__score').textContent = `${right} of ${qs.length} right.`;
      }
    });
    return el;
  },
  Timeline(p) {
    const el = div('w w-timeline');
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p><ol class="w-timeline__list">${(p.events || []).map((ev) => `
      <li><span class="w-timeline__date">${esc(ev.date || '')}</span><span class="w-timeline__label">${md(ev.label || '')}</span>${ev.description ? `<span class="w-timeline__desc">${md(ev.description)}</span>` : ''}</li>`).join('')}</ol>`;
    return el;
  },
  Cycle(p) {
    const el = div('w w-cycle');
    const stages = p.stages || [];
    el.innerHTML = `<p class="w__title">${esc(p.title || '')}</p>
      ${p.centerLabel ? `<p class="w-cycle__center">${md(p.centerLabel)}</p>` : ''}
      <ol class="w-cycle__list">${stages.map((st) => `<li><span class="w-cycle__label">${md(st.label || '')}</span>${st.description ? `<span class="w-cycle__desc">${md(st.description)}</span>` : ''}</li>`).join('')}</ol>
      <p class="w-cycle__loop">…and back to the start, faster each time.</p>`;
    return el;
  },
  // In Wonder the answer is graded against the rubric. This page can't grade, so it shows the
  // points and a model answer instead of pretending to.
  ExplainBack(p) {
    const el = div('w w-explain');
    el.innerHTML = `<p class="w__title">Explain it back</p><p>${md(p.prompt || '')}</p>
      <textarea class="w-explain__field" rows="3" placeholder="Your answer, in your own words"></textarea>
      <div class="w-steps__nav"><button type="button" class="is-primary" data-show>Show a model answer</button></div>
      <div class="w-explain__answer" hidden>
        <p class="w-steps__label">In Wonder, your answer is checked for these points:</p>
        <ul class="w-compare__list">${(p.rubric || []).map((r) => `<li>${md(r)}</li>`).join('')}</ul>
        <p class="w-steps__label">A model answer</p><p>${md(p.sampleAnswer || '')}</p>
      </div>`;
    el.querySelector('[data-show]').addEventListener('click', (e) => { el.querySelector('.w-explain__answer').hidden = false; e.currentTarget.disabled = true; });
    return el;
  },
  Sources(_p, _b, ctx) {
    const el = div('w w-sources');
    const list = Object.values(ctx.sources).sort((a, b) => a.n - b.n);
    el.innerHTML = `<p class="w__title">${list.length} sources</p><ol>${list.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title.replace(/ - [^-]+$/, ''))}</a> <span>${esc(s.domain.replace(/^www\./, ''))}</span></li>`).join('')}</ol>`;
    return el;
  },
};

function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }

function renderBlock(b, ctx) {
  const s = b.src;
  if (s.startsWith('<') && /^<[A-Z]/.test(s)) {
    if (!b.complete) {
      // The tag is still being written: the compiler cuts it. We show where it will land.
      const el = div('w w-pending');
      // In words a reader understands, not the tag name (cold readers took "<BarChart>" for a bug).
      const doing = { Timeline: 'Laying out a timeline', Cycle: 'Drawing the loop', ExplainBack: 'Writing a question for you', BarChart: 'Drawing a chart', Quiz: 'Writing the quiz', CompareToggle: 'Building a comparison', LessonStepper: 'Laying out a worked example', Reveal: 'Writing a quick check', Callout: 'Adding a note', Sources: 'Listing the sources' }[b.tag] || 'Adding something you can use';
      el.innerHTML = `<span class="w-pending__name">${esc(doing)}…</span><span class="w-pending__bar"></span>`;
      return el;
    }
    const t = parseTagAt(s, 0);
    const fn = t && WIDGETS[t.name];
    if (!fn) return div('w-none');
    const el = fn(t.props || {}, t.body, ctx);
    el.dataset.tag = t.name;
    return el;
  }
  let h;
  if (s.startsWith('## ')) { h = document.createElement('h3'); h.className = 'l-page'; h.innerHTML = inline(s.slice(3), ctx); return h; }
  if (s.startsWith('# ')) { h = document.createElement('h3'); h.className = 'l-title'; h.innerHTML = inline(s.slice(2), ctx); return h; }
  if (/^(\d+\.|-) /.test(s)) {
    const ordered = /^\d+\./.test(s);
    const list = document.createElement(ordered ? 'ol' : 'ul');
    list.className = 'l-list';
    list.innerHTML = s.split('\n').filter(Boolean).map((li) => `<li>${inline(li.replace(/^(\d+\.|-) /, ''), ctx)}</li>`).join('');
    return list;
  }
  const p = document.createElement('p');
  p.innerHTML = inline(s, ctx);
  return p;
}

/**
 * A live lesson view. update(markdown, forward) diffs blocks against the cache and
 * returns the nodes that just finished (so the caller can snap them in).
 */
export function createLessonView(root, sources) {
  let n = 0;
  const ctx = { sources, uid: () => ++n };
  let nodes = []; // [{src, complete, el}]
  return {
    update(text) {
      const blocks = splitBlocks(text);
      const fresh = [];
      const next = blocks.map((b, i) => {
        const prev = nodes[i];
        if (prev && prev.src === b.src && prev.complete === b.complete) return prev;
        const el = renderBlock(b, ctx);
        const wasPending = prev && !prev.complete && prev.src.startsWith('<') && b.complete;
        if (b.complete && b.src.startsWith('<') && (wasPending || !prev)) fresh.push(el);
        return { src: b.src, complete: b.complete, el };
      });
      // Reconcile the DOM in order, touching only what changed.
      next.forEach((b, i) => {
        const at = root.children[i];
        if (at !== b.el) {
          if (at) root.insertBefore(b.el, at); else root.appendChild(b.el);
        }
      });
      while (root.children.length > next.length) root.lastElementChild.remove();
      nodes = next;
      return fresh;
    },
  };
}

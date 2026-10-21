// Demo page wiring: stream replay, live playground, LearningQuiz.

import { compile, resolutionIdsFromProgram } from './compiler.js';
import { createHost } from './host.js';
import { ConversationSourceParser, ConversationTurn, replayRecords } from './stream.js';
import { PLAYGROUND_SAMPLE, QUIZ_MARKUP, QUIZ_APP_DATA, QUIZ_RESOLUTION_ID } from './demo-data.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- DIL surface
// One sandbox worker + one DOM host per surface (the real client keeps one DILRenderer per
// message). Viewport width is forwarded so DIL.useBreakpoint / useIsMobile work.
class DilSurface {
  constructor(mount, { onAction, onError, onFlush } = {}) {
    this.mount = mount;
    this.onAction = onAction || (() => {});
    this.onError = onError || ((e) => console.warn('[dil]', e.phase, e.message));
    this.generation = 0;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.host = createHost(mount, {
      invoke: (fnId, args) => this.worker.postMessage({ type: 'invokeFunction', fnId, args }),
      onAction: (a) => this.onAction(a),
      allowRemoteImages: $('remote-images')?.checked,
      onFlush,
    });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ops') this.host.apply(m);
      else if (m.type === 'hostAction') this.onAction(m.action);
      else if (m.type === 'error') this.onError(m.error);
    };
    this.worker.onerror = (e) => this.onError({ phase: 'worker', message: e.message || 'worker failed to load' });
    this.worker.postMessage({ type: 'init', viewportWidth: mount.clientWidth || 800, binary: true });
    this.ro = new ResizeObserver(() => {
      const w = Math.round(this.mount.clientWidth);
      if (w && w !== this.lastWidth) { this.lastWidth = w; this.worker.postMessage({ type: 'viewport', width: w }); }
    });
    this.ro.observe(mount);
  }
  render({ code, constants, appData }, { animated = false } = {}) {
    this.worker.postMessage({ type: 'render', source: code, constants, appData, animated, sourceGeneration: ++this.generation });
  }
  reset() {
    this.worker.postMessage({ type: 'reset' });
    this.host.clear();
  }
}

// ---------------------------------------------------------------- shared UI bits
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function describeAction(a) {
  const p = a.payload || {};
  switch (a.type) {
    case 'open_url': return `open_url → ${p.url}`;
    case 'open_entity_detail': return `open_entity_detail → ${p.category}: ${p.query}`;
    case 'issue_new_turn': return `issue_new_turn → "${p.query}"`;
    case 'open_image_lightbox': return `open_image_lightbox → ${p.images?.length ?? 0} image(s)`;
    default: return `${a.type} ${JSON.stringify(p).slice(0, 120)}`;
  }
}

function actionLogger(listId) {
  return (a) => {
    const list = $(listId);
    if (list.querySelector('.muted')) list.textContent = '';
    const li = document.createElement('li');
    const h = document.createElement('span');
    h.className = 't';
    h.textContent = `${a.handler}`;
    const b = document.createElement('span');
    b.textContent = describeAction(a);
    li.append(h, b);
    list.prepend(li);
    // Client actions are not executed against real services in this lab: they are surfaced.
    toast(a.type === 'open_url' ? `Would open ${a.payload.url}` : describeAction(a));
  };
}

// ---------------------------------------------------------------- tabs
const tabs = ['replay', 'playground', 'quiz'];
function selectTab(name) {
  for (const t of tabs) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'playground') ensurePlayground();
  if (name === 'quiz') ensureQuiz();
}
for (const t of tabs) $(`tab-${t}`).addEventListener('click', () => selectTab(t));

// ---------------------------------------------------------------- (a) replay
let replaySurface = null;
let replay = null;
let records = null;
const fmt = (n) => n.toLocaleString('en-US');

async function loadRecords() {
  if (records) return records;
  const res = await fetch(new URL('../fixtures/stream.redacted.ndjson', import.meta.url));
  const text = await res.text();
  const out = [];
  const parser = new ConversationSourceParser((r) => out.push(r));
  parser.push(text);
  parser.finish();
  records = out;
  return records;
}

function renderRecordLog(recs, current) {
  const log = $('record-log');
  if (log.childElementCount !== recs.length) {
    log.textContent = '';
    recs.forEach((r, i) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = `t ${r.type}`;
      t.textContent = r.type;
      const d = document.createElement('span');
      d.textContent = r.type === 'content' ? `rev ${r.revision} ${r.mode}${r.dil ? ' +dil' : ''} ${r.markdown ? `+${r.markdown.length}ch` : ''}`
        : r.type === 'control' ? r.detail?.kind ?? ''
          : r.type === 'reasoning' ? r.status?.text ?? 'activity' : '';
      li.append(t, d);
      li.style.opacity = '0.35';
      log.appendChild(li);
    });
  }
  [...log.children].forEach((li, i) => {
    li.style.opacity = i <= current ? '1' : '0.35';
    li.classList.toggle('cur', i === current);
  });
  log.children[current]?.scrollIntoView({ block: 'nearest' });
}

function mode() { return document.querySelector('input[name="mode"]:checked').value; }

async function startReplay() {
  stopReplay();
  const recs = await loadRecords();
  if (!replaySurface) {
    replaySurface = new DilSurface($('replay-surface'), {
      onAction: actionLogger('action-log-replay'),
      onFlush: (s) => { $('st-ops').textContent = fmt(s.ops); $('st-frames').textContent = fmt(s.frames); },
    });
  } else replaySurface.reset();
  $('replay-empty').hidden = true;
  $('replay-btn').disabled = true;
  $('stop-btn').disabled = false;
  const chip = $('status-chip');
  const turn = new ConversationTurn();
  const useLocal = mode() === 'local';
  let pending = null;
  let frame = 0;
  const delay = Number($('speed').value);

  // rAF coalescing of streaming content (findings §1.2): at most one render per frame,
  // immediately for a non-streaming (complete) status.
  const flushContent = () => {
    frame = 0;
    const msg = pending;
    pending = null;
    if (!msg) return;
    const animated = msg.status === 'streaming';
    let program;
    if (useLocal) {
      const ids = msg.dil ? resolutionIdsFromProgram(msg.dil.code, msg.dil.constants) : undefined;
      const r = compile(msg.markdown, { partial: msg.status !== 'complete', resolutionIdFor: ids });
      program = { code: r.code, constants: r.constants, appData: msg.dil?.appData ?? {} };
    } else {
      if (!msg.dil) return;
      program = msg.dil;
    }
    $('st-code').textContent = `${fmt(program.code.length)} B`;
    replaySurface.render(program, { animated });
  };

  replay = replayRecords(recs, (rec, i) => {
    const r = turn.apply(rec);
    $('st-record').textContent = `${i + 1} / ${recs.length}`;
    renderRecordLog(recs, i);
    if (r.type === 'content') {
      const m = r.message;
      $('st-rev').textContent = `${m.revision} (${m.status})`;
      $('st-md').textContent = `${fmt(m.markdown.length)} chars`;
      pending = m;
      if (m.status !== 'streaming' || delay === 0) { if (frame) cancelAnimationFrame(frame); flushContent(); }
      else if (!frame) frame = requestAnimationFrame(flushContent);
    } else if (r.type === 'reasoning') {
      const s = r.reasoning.status;
      chip.hidden = !s;
      if (s) { chip.textContent = s.text || 'Thinking'; chip.classList.toggle('live', !!s.active); }
    } else if (r.type === 'control' && r.detail?.kind === 'terminal-received') {
      chip.hidden = true;
    }
  }, { delay: (rec) => (delay === 0 ? 0 : rec.type === 'content' && rec.markdown ? delay * 2 : delay) });

  try {
    const res = await replay.done;
    if (!res.cancelled) {
      $('turn-sub').textContent = `Replayed ${recs.length} records · final revision ${turn.primary?.revision} · ${useLocal ? 'local compiler' : 'server dil.code'}`;
    }
  } catch (err) {
    toast(`Replay failed: ${err.message}`);
    console.error(err);
  } finally {
    $('replay-btn').disabled = false;
    $('stop-btn').disabled = true;
    chip.hidden = true;
  }
}
function stopReplay() {
  if (replay) { replay.cancel(); replay = null; }
}
$('replay-btn').addEventListener('click', startReplay);
$('stop-btn').addEventListener('click', stopReplay);
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => {
    $('mode-hint').innerHTML = mode() === 'local'
      ? 'Re-compiling the accumulated <code>markdown</code> with <code>src/compiler.js</code> on every revision; component data still comes from the record\'s <code>appData</code>.'
      : 'Running the <code>dil.code</code> the server sent in each content record.';
  });
}
$('remote-images').addEventListener('change', (e) => {
  for (const s of [replaySurface, pgSurface, quizSurface]) s?.host.setAllowRemoteImages(e.target.checked);
});

// ---------------------------------------------------------------- (b) playground
let pgSurface = null;
let pgTimer = null;
let typing = null;
function compileAndRender(text, { partial = false, animated = false } = {}) {
  const t0 = performance.now();
  try {
    const r = compile(text, { partial });
    const ms = performance.now() - t0;
    $('pg-code').textContent = r.code;
    $('pg-constants').textContent = JSON.stringify(r.constants, null, 2);
    $('pg-code-meta').textContent = `· ${fmt(r.code.length)} B · ${Object.keys(r.constants).length} constants · ${r.requiredComponents.join(', ') || 'no components'} · ${ms.toFixed(1)} ms`;
    pgSurface.render({ code: r.code, constants: r.constants, appData: { opGenui: { componentResults: {}, modelDataBindings: {} } } }, { animated });
    $('pg-status').textContent = '';
  } catch (err) {
    $('pg-status').textContent = `Compile error: ${err.message}`;
  }
}
function ensurePlayground() {
  if (pgSurface) return;
  pgSurface = new DilSurface($('pg-surface'), { onAction: actionLogger('action-log-pg'), onError: (e) => { $('pg-status').textContent = `${e.phase}: ${e.message}`; } });
  const ta = $('markup');
  ta.value = PLAYGROUND_SAMPLE;
  ta.addEventListener('input', () => {
    if (typing) { clearInterval(typing); typing = null; }
    clearTimeout(pgTimer);
    pgTimer = setTimeout(() => compileAndRender(ta.value), 60);
  });
  compileAndRender(ta.value);
}
$('type-btn').addEventListener('click', () => {
  ensurePlayground();
  const full = $('markup').value;
  if (typing) clearInterval(typing);
  pgSurface.reset();
  let n = 0;
  // Every tick compiles a prefix in partial mode, just like the server recompiling each revision.
  typing = setInterval(() => {
    n = Math.min(full.length, n + 6 + Math.floor(Math.random() * 18));
    compileAndRender(full.slice(0, n), { partial: n < full.length, animated: n < full.length });
    $('pg-status').textContent = n < full.length ? `streaming ${n} / ${full.length} chars` : 'complete';
    if (n >= full.length) { clearInterval(typing); typing = null; }
  }, 50);
});
$('reset-btn').addEventListener('click', () => {
  ensurePlayground();
  if (typing) { clearInterval(typing); typing = null; }
  $('markup').value = PLAYGROUND_SAMPLE;
  compileAndRender(PLAYGROUND_SAMPLE);
});

// ---------------------------------------------------------------- (c) quiz
let quizSurface = null;
function renderQuiz() {
  const r = compile(QUIZ_MARKUP, { resolutionIdFor: (name) => (name === 'LearningQuiz' ? QUIZ_RESOLUTION_ID : undefined) });
  quizSurface.render({ code: r.code, constants: r.constants, appData: QUIZ_APP_DATA });
}
function ensureQuiz() {
  if (quizSurface) return;
  $('quiz-markup').textContent = QUIZ_MARKUP;
  quizSurface = new DilSurface($('quiz-surface'), { onAction: actionLogger('action-log-quiz') });
  renderQuiz();
}
$('quiz-reset').addEventListener('click', () => { quizSurface.reset(); renderQuiz(); });

// ---------------------------------------------------------------- boot
selectTab(tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'replay');
loadRecords().then((r) => { $('st-record').textContent = `0 / ${r.length}`; renderRecordLog(r, -1); }).catch((e) => toast(`Could not load fixture: ${e.message}`));

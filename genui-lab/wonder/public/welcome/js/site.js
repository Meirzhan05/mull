// Wonder landing page: the bespoke parts. The engine (scrollcraft.js) pins acts and
// publishes --sc-p on each; everything below reads that and drives this page's own markup.
import { STREAM, SOURCES, TEACHER } from './data.js';
import { createLessonView } from './lesson.js';
import { fsrs, createEmptyCard, Rating, forgettingCurve } from './fsrs.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const APP = document.querySelector('meta[name="wonder-app"]')?.content || '/';
const $ = (s, r = document) => r.querySelector(s);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const actP = (el) => parseFloat(el.style.getPropertyValue('--sc-p')) || 0;
// Every way in goes through the app's #/start route (public/start-core.js): with accounts on it
// signs in with Google, then onboarding offers the topic as the first lesson; without accounts it
// opens onboarding or the lesson straight away.
const startUrl = (topic = '') => `${APP}#/start${topic ? `/${encodeURIComponent(topic)}` : ''}`;
// Sign-in first until /api/account says otherwise (accounts off, or already signed in).
let signInFirst = true;

// ------------------------------------------------------------------ composers
document.querySelectorAll('[data-composer]').forEach((form) => {
  // The whole box reads as one field, but the input is only part of it: a press on its padding or
  // the gap before the button focused nothing. Anywhere in the box but the button focuses it.
  const field = form.querySelector('input');
  form.addEventListener('pointerdown', (e) => {
    if (e.target === field || e.target.closest('button, a, label')) return;
    // the visible box: .composer__row where there is one, else the hero form itself
    const box = e.target.closest('.composer__row') || (e.target === form && !form.querySelector('.composer__row') ? form : null);
    if (!box) return;
    e.preventDefault();
    field.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const topic = input.value.trim();
    if (!topic) {
      // An example is showing in the field: hand it over, so a second press starts it.
      if (input.dataset.example) { input.value = input.dataset.example; input.focus(); return; }
      // Continue with Google needs no topic: onboarding's last step picks one after sign-in.
      if (signInFirst) { location.href = startUrl(); return; }
      form.classList.remove('is-empty'); void form.offsetWidth; form.classList.add('is-empty');
      input.focus();
      return;
    }
    location.href = startUrl(topic);
  });
});

// ------------------------------------------------------------------ what happens next
// With accounts on, everything in Wonder needs a signed-in user: the composers say "Continue with
// Google" and the notes say what comes after it (the same steps onboarding shows). Accounts off,
// or already signed in, they go straight to a lesson. Without the app behind this page (the
// standalone build), /api/account is missing and the page keeps its sign-in wording.
fetch('/api/account', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((a) => {
    if (!a) return;
    if (!a.sync || a.signedIn) {
      signInFirst = false;
      document.querySelectorAll('[data-composer] button[type="submit"]').forEach((b) => { b.textContent = 'Start a lesson'; });
      document.querySelectorAll('[data-steps]').forEach((n) => { n.hidden = true; });
      return;
    }
    const barIn = $('#bar-in');
    barIn.textContent = 'Sign in';
    barIn.href = `${APP}#/signin`;
    document.querySelectorAll('[data-next]').forEach((n) => {
      // The hero's note stays one line (it sits under the headline); it also offers the lesson on
      // this page that needs no sign-in.
      n.innerHTML = n.hasAttribute('data-try')
        ? "Then pick your pace, and it's your first lesson. Or <a href=\"#p2\">try a real one first</a>, no sign-in."
        : "Sign in with Google, pick your pace, and it's your first lesson.";
      n.hidden = false;
    });
  })
  .catch(() => {});

// ------------------------------------------------------------------ example questions
// A blank box asks people to have an idea first. Real topics Wonder suggests type themselves in.
const EXAMPLES = ['Why some chords sound sad', 'How index funds work', 'Black holes for beginners', 'Why we procrastinate', 'How vaccines train your immune system', 'The birthday paradox'];
const exInput = $('[data-examples]');
if (exInput && !reduce) {
  let ex = 0, len = 0, dir = 1, hold = 0;
  const base = exInput.placeholder;
  setInterval(() => {
    if (document.activeElement === exInput || exInput.value || scrollY > innerHeight * 0.4) return;
    const word = EXAMPLES[ex];
    if (hold > 0) { hold--; return; }
    len += dir;
    if (len >= word.length) { len = word.length; dir = -1; hold = 34; }
    if (len <= 0) { len = 0; dir = 1; hold = 6; ex = (ex + 1) % EXAMPLES.length; }
    exInput.placeholder = len ? `${word.slice(0, len)}` : base;
    exInput.dataset.example = len === word.length ? word : '';
  }, 55);
}

// ------------------------------------------------------------------ the bar
const bar = $('#bar');
const where = $('#where');
const pages = [...document.querySelectorAll('[data-page]')];
const segs = new Map([...document.querySelectorAll('[data-seg]')].map((a) => [a.dataset.seg, a]));
function updateBar() {
  const vh = innerHeight;
  bar.classList.toggle('is-solid', scrollY > vh * 0.55);
  let current = null;
  for (const sec of pages) {
    const r = sec.getBoundingClientRect();
    const f = clamp01((vh * 0.5 - r.top) / r.height);
    const seg = segs.get(sec.id);
    seg.style.setProperty('--f', f.toFixed(3));
    if (r.top <= vh * 0.5 && r.bottom > vh * 0.5) current = sec;
    seg.toggleAttribute('aria-current', false);
  }
  if (current) {
    segs.get(current.id).setAttribute('aria-current', 'step');
    where.textContent = `Page ${current.dataset.page} of 5`;
  } else {
    where.textContent = '';
  }
}

// ------------------------------------------------------------------ hero depth
const heroStage = $('.hero__stage');
const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
if (fine && !reduce) {
  addEventListener('pointermove', (e) => {
    ptr.tx = (e.clientX / innerWidth) * 2 - 1;
    ptr.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
}
function updateHero() {
  updateSpill();
  if (!fine || reduce) return;
  ptr.x += (ptr.tx - ptr.x) * 0.06;
  ptr.y += (ptr.ty - ptr.y) * 0.06;
  heroStage.style.setProperty('--mx', ptr.x.toFixed(4));
  heroStage.style.setProperty('--my', ptr.y.toFixed(4));
}

// ------------------------------------------------------------------ hero: the spectrum becomes the lesson
// Positions are in the generated image's own coordinates (percent), measured off the two crops:
// E is where the spectrum leaves the prism; each piece lands on its own band of the fan.
const SPILL = {
  wide: { img: [1536, 1024], pos: [0.70, 0.38], E: [68.5, 41],
    T: [[80, 45], [71, 55], [83, 62], [73, 70], [82, 78]] },
  tall: { img: [1024, 1536], pos: [0.5, 0], E: [63, 29.5],
    T: [[62, 36], null, [42, 43], [60, 50], null] },
};
const hero = $('.hero');
const spill = $('#spill');
const rays = $('.spill__rays');
const frags = [...spill.querySelectorAll('.frag')];
const tallMQ = matchMedia('(max-width: 760px)');
let spillKey = '';
let spillBox = { w: 1, h: 1 };
function layoutSpill() {
  const L = tallMQ.matches ? SPILL.tall : SPILL.wide;
  const plane = spill.parentElement;
  const pw = plane.clientWidth, ph = plane.clientHeight;
  const key = `${pw}x${ph}:${tallMQ.matches}`;
  if (key === spillKey) return L;
  spillKey = key;
  // object-fit: cover, with the same object-position the prism image uses.
  const s = Math.max(pw / L.img[0], ph / L.img[1]);
  const w = L.img[0] * s, h = L.img[1] * s;
  Object.assign(spill.style, { width: `${w}px`, height: `${h}px`, left: `${(pw - w) * L.pos[0]}px`, top: `${(ph - h) * L.pos[1]}px` });
  spillBox = { w, h };
  rays.innerHTML = L.T.map((t, k) => t ? `<line x1="${L.E[0]}" y1="${L.E[1]}" x2="${t[0]}" y2="${t[1]}" pathLength="1" stroke-dasharray="1 1" stroke="url(#ray${k})"/>` : '').join('')
    + `<defs>${frags.map((f, k) => {
      const t = L.T[k]; if (!t) return '';
      const hue = f.style.getPropertyValue('--hue');
      return `<linearGradient id="ray${k}" gradientUnits="userSpaceOnUse" x1="${L.E[0]}" y1="${L.E[1]}" x2="${t[0]}" y2="${t[1]}"><stop offset="0" stop-color="${hue}" stop-opacity="0"/><stop offset="0.6" stop-color="${hue}" stop-opacity="0.55"/><stop offset="1" stop-color="${hue}" stop-opacity="0.9"/></linearGradient>`;
    }).join('')}</defs>`;
  return L;
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
function updateSpill() {
  const L = layoutSpill();
  const p = actP(hero);
  const lines = rays.querySelectorAll('line');
  let li = 0;
  frags.forEach((el, k) => {
    const t = L.T[k];
    if (!t) { el.style.display = 'none'; return; }
    el.style.display = '';
    // Each band leaves the prism a beat after the last; under reduced motion they are already landed.
    const f = reduce ? 1 : clamp01((p - 0.16 - k * 0.07) / 0.4);
    const e = easeOut(f);
    const x = (L.E[0] + (t[0] - L.E[0]) * e) / 100 * spillBox.w;
    const y = (L.E[1] + (t[1] - L.E[1]) * e) / 100 * spillBox.h;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${(0.35 + 0.65 * e).toFixed(3)})`;
    el.style.opacity = Math.min(1, f * 2.2).toFixed(3);
    const ln = lines[li++];
    if (ln) { ln.style.strokeDashoffset = (1 - e).toFixed(3); ln.style.opacity = Math.min(1, f * 3).toFixed(3); }
  });
}
addEventListener('resize', () => { spillKey = ''; });

// ------------------------------------------------------------------ page 1: anything
// Rows of the topics Wonder offers at onboarding (public/progress-core.js), drifting in opposite
// directions as you scroll (pure CSS off --sc-p). Every topic starts a lesson.
const FALLBACK_INTERESTS = {
  science: { label: 'Science', topics: ['Why the sky is blue', 'How vaccines train your immune system', 'What is entropy, really?', 'How photosynthesis powers life'] },
  space: { label: 'Space', topics: ['Black holes for beginners', 'How rockets reach orbit', 'Why planets are round', 'What is dark matter?'] },
  money: { label: 'Money', topics: ['Compound interest', 'How index funds work', 'What causes inflation', 'How credit scores are calculated'] },
  psychology: { label: 'Mind', topics: ['How habits form', 'Cognitive biases that fool us', 'Why we procrastinate', 'How memory works'] },
};
async function buildTopics() {
  let interests = FALLBACK_INTERESTS;
  try { interests = (await import('/progress-core.js')).INTERESTS || interests; } catch {}
  const all = Object.values(interests).flatMap((it) => it.topics.map((t) => ({ tag: it.label, t })));
  const ROWS = 4;
  const rows = Array.from({ length: ROWS }, () => []);
  all.forEach((x, i) => rows[i % ROWS].push(x)); // deal round-robin so each row mixes subjects
  $('#topics').innerHTML = rows.map((row, r) => `<div class="topics__row" style="--dir:${r % 2 ? 1 : -1};--spd:${180 + r * 40}px">${
    row.map((x) => `<a class="chip" href="${esc(startUrl(x.t))}"><span class="chip__tag">${esc(x.tag)}</span>${esc(x.t)}</a>`).join('')}</div>`).join('');
}
buildTopics();

// ------------------------------------------------------------------ page 2: the stream (peak)
// Precompute the lesson at every record, so scrubbing in either direction is a lookup.
const WIDGET_DONE = /<(?:Timeline|Cycle|CompareToggle|BarChart|Reveal|LessonStepper|Quiz)\b[\s\S]*?\/>/;
const frames = [];
{
  let md = '', status = 'Planning the lesson…', steered = false, done = false, searched = false, widget = false;
  let activity = [];
  for (const [k, v] of STREAM) {
    if (k === 'a') md += v;
    else if (k === 'r') md = v;
    else if (k === 's') { status = v; if (/^Searching/.test(v)) searched = true; if (!md) activity = [...activity, v]; }
    else if (k === 'steer') { steered = true; status = `Steering: ${v}`; }
    else if (k === 'done') done = true;
    if (!widget && (k === 'a' || k === 'r') && WIDGET_DONE.test(md.slice(-4000))) widget = true;
    frames.push({ md, status, steered, done, searched, widget, kind: k, activity: md ? null : activity });
  }
  const last = frames[frames.length - 1];
  const pages = (last.md.match(/^## /gm) || []).length;
  const questions = (last.md.match(/"question_type"/g) || []).length;
  last.status = `Finished: ${pages} pages and a ${questions}-question check.`;
}
// Scroll weight per record: the searches and the steer get room to be read.
const WEIGHT = { a: 1, r: 6, s: 12, steer: 40, done: 70 };
const cum = [];
frames.reduce((acc, f, i) => (cum[i] = acc + WEIGHT[f.kind]), 0);
const TOTAL = cum[cum.length - 1];

const stream = $('#stream');
const p2 = $('#p2');
const lessonEl = $('#lesson');
const viewEl = $('#reader-view');
const statusText = $('#status-text');
const steerEl = $('#steer');
const titleEl = $('#reader-title');
const segEls = [...document.querySelectorAll('#reader-segs i')];
const noteEls = Object.fromEntries([...document.querySelectorAll('#notes [data-note]')].map((n) => [n.dataset.note, n]));
const activityEl = $('#activity');
const yourTurn = $('#yourturn');
const view = createLessonView(lessonEl, SOURCES);
let shown = -1;
let follow = 0;

function frameAt(u) {
  const w = clamp01(u) * TOTAL;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < w) lo = mid + 1; else hi = mid; }
  return lo;
}
function showFrame(i) {
  if (i === shown) return;
  const forward = i > shown;
  const f = frames[i];
  const fresh = view.update(f.md);
  // Before the first word, the reader shows what Wonder is doing, as the app's activity rows do.
  activityEl.hidden = !f.activity;
  if (f.activity) activityEl.innerHTML = f.activity.map((a, k) => `<li class="${k === f.activity.length - 1 ? 'is-now' : ''}">${esc(a)}</li>`).join('');
  if (forward && !reduce) fresh.forEach((el) => {
    el.classList.add('is-snapped');
    el.addEventListener('animationend', () => el.classList.remove('is-snapped'), { once: true });
  });
  // The reader's own bar: the title once it's written, one segment per page.
  const title = /^# (.+)\n/.exec(f.md);
  titleEl.textContent = title ? title[1] : 'New lesson';
  const pages = (f.md.match(/^## /gm) || []).length;
  segEls.forEach((s, k) => { s.className = k < pages - 1 || (f.done && k < pages) ? 'is-done' : k === pages - 1 ? 'is-now' : ''; });
  statusText.textContent = f.status;
  if (f.steered && steerEl.hidden) { steerEl.hidden = false; if (!reduce) steerEl.classList.add('is-fresh'); }
  if (!f.steered) { steerEl.hidden = true; steerEl.classList.remove('is-fresh'); }
  // Margin notes light up at the moment in the recording they describe, and stay lit.
  noteEls.search?.classList.toggle('is-on', f.searched);
  noteEls.widget?.classList.toggle('is-on', f.widget);
  noteEls.steer?.classList.toggle('is-on', f.steered);
  noteEls.done?.classList.toggle('is-on', f.done);
  stream.classList.toggle('is-done', f.done);
  // The moment the lesson is finished is the moment to ask for theirs.
  if (yourTurn.classList.contains('is-on') !== f.done) {
    yourTurn.classList.toggle('is-on', f.done);
    yourTurn.querySelectorAll('input, button').forEach((x) => (x.tabIndex = f.done ? 0 : -1));
  }
  stream.dataset.scVerifyState = String(i);
  shown = i;
}
function updateStream() {
  const u = (actP(p2) - 0.03) / 0.88;
  showFrame(frameAt(u));
  // Keep the writing head in view, the way the app follows a stream.
  const last = lessonEl.lastElementChild;
  const bottom = last ? last.offsetTop + last.offsetHeight : 0;
  const quiz = frames[shown]?.done && lessonEl.querySelector('[data-tag="Quiz"]');
  const target = quiz ? Math.max(0, quiz.offsetTop - 64) : Math.max(0, bottom - viewEl.clientHeight * 0.78);
  follow += (target - follow) * (reduce ? 1 : 0.14);
  if (Math.abs(target - follow) < 0.5) follow = target;
  lessonEl.style.transform = `translate3d(0, ${-follow.toFixed(1)}px, 0)`;
}

// ------------------------------------------------------------------ page 4: the lesson's own cards
{
  const final = frames[frames.length - 1].md;
  const terms = [...final.matchAll(/<KeyTerm term="([^"]+)" definition="([^"]+)"\/>/g)].map((m) => ({ term: m[1], def: m[2] }));
  $('#keep').innerHTML = terms.slice(0, 4).map((t, k) => `<li class="kc" style="--i:${k}"><p class="kc__t">${esc(t.term)}</p><p class="kc__d">${esc(t.def)}</p></li>`).join('');
}

// ------------------------------------------------------------------ page 3: Guide me
const log = $('#tutor-log');
const choices = $('#tutor-choices');
let wrong = 0;
const HINTS = {
  fall: "Not quite. Picture a seller who notices your coin holds less silver than it used to. Would they give you more for it, or ask for more of it?",
  same: "People did notice, though. Once a seller knows a coin holds less silver, how many of those coins would they want for the same loaf of bread?",
};
function say(cls, html) {
  const li = document.createElement('li');
  li.className = `msg ${cls}`;
  li.innerHTML = html;
  log.appendChild(li);
}
choices.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b || b.disabled) return;
  say('msg--you', esc(b.textContent));
  b.disabled = true;
  if (b.dataset.a === 'rise') {
    say('msg--tutor msg--right', 'Exactly. Each coin is worth less, so sellers ask for more of them and prices climb. A soldier\'s pay bought less and less. That\'s <strong>debasement</strong>, and you just worked out why it mattered.<br><span class="chip-saved">Saved to your cards: debasement</span>');
    choices.querySelectorAll('button').forEach((x) => (x.disabled = true));
    return;
  }
  wrong++;
  if (wrong < 2) { say('msg--tutor msg--hint', HINTS[b.dataset.a]); return; }
  say('msg--tutor', 'You\'ve tried twice, so here it is: prices <strong>rise</strong>. Each coin is worth less, so it takes more of them to buy the same thing, and a soldier\'s pay buys less. That\'s debasement.<br><span class="chip-saved">Saved to your cards: debasement</span>');
  choices.querySelectorAll('button').forEach((x) => (x.disabled = true));
});

// ------------------------------------------------------------------ page 4: the forgetting curve
// One card you keep getting right, scheduled by the FSRS-5 defaults Wonder ships.
const sched = [];
{
  const f = fsrs();
  const start = new Date('2026-10-21T09:00:00Z');
  let card = createEmptyCard(start);
  let now = start;
  for (let i = 0; i < 6; i++) {
    const next = f.repeat(card, now)[Rating.Good].card;
    sched.push({ t: (now - start) / 864e5, S: next.stability, gap: next.scheduled_days });
    card = next;
    now = next.due;
  }
}
const S0 = sched[0].S;
const reviews = sched.slice(1).map((s) => s.t).filter((t) => t > 0.5);
const gaps = sched.slice(1, 5).map((s) => s.gap);
$('#p4-body').textContent = `When you finish a lesson, its key ideas become cards. Wonder brings each one back just before you'd forget it, and the gaps keep growing: ${gaps[0]} days, then ${gaps[1]}, then ${gaps[2]}, then ${gaps[3]}.`;
const TMAX = 190;
const X0 = 48, X1 = 700, Y0 = 24, Y1 = 330;
const xOf = (t) => X0 + (X1 - X0) * Math.sqrt(Math.min(t, TMAX) / TMAX);
const yOf = (r) => Y1 - (Y1 - Y0) * r;
const rOn = (t) => {
  let seg = sched[0];
  for (const s of sched) if (s.t <= t) seg = s;
  return forgettingCurve(t - seg.t, seg.S);
};
const rOff = (t) => forgettingCurve(t, S0);
const path = (fn) => {
  let d = '';
  for (let k = 0; k <= 600; k++) {
    const u = k / 600, t = TMAX * u * u;
    d += `${k ? 'L' : 'M'}${xOf(t).toFixed(1)},${yOf(fn(t)).toFixed(1)}`;
  }
  return d;
};
{
  const svg = $('#curve-svg');
  const ticksX = [[1, '1 day'], [7, '1 week'], [30, '1 month'], [91, '3 months'], [182, '6 months']];
  const ticksY = [1, 0.75, 0.5, 0.25];
  // The "with reviews" line drops straight back to full recall at each review.
  let onD = '';
  for (let k = 0; k <= 900; k++) {
    const u = k / 900, t = TMAX * u * u;
    const hit = reviews.find((rt) => rt > TMAX * ((k - 1) / 900) ** 2 && rt <= t);
    if (hit != null && k) onD += `L${xOf(hit).toFixed(1)},${yOf(rOn(hit - 1e-6)).toFixed(1)}L${xOf(hit).toFixed(1)},${yOf(1).toFixed(1)}`;
    onD += `${k ? 'L' : 'M'}${xOf(t).toFixed(1)},${yOf(rOn(t)).toFixed(1)}`;
  }
  svg.insertAdjacentHTML('beforeend', `
    <defs>
      <linearGradient id="cvfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#52A8FF" stop-opacity="0.16"/><stop offset="1" stop-color="#52A8FF" stop-opacity="0"/></linearGradient>
      <clipPath id="cvclip"><rect id="cv-clip" x="0" y="0" width="${X0}" height="380"/></clipPath>
    </defs>
    ${ticksY.map((r) => `<line class="cv-grid" x1="${X0}" x2="${X1}" y1="${yOf(r)}" y2="${yOf(r)}"/><text class="cv-axis" x="${X0 - 10}" y="${yOf(r) + 4}" text-anchor="end">${r * 100}%</text>`).join('')}
    <line class="cv-grid" x1="${X0}" x2="${X1}" y1="${Y1}" y2="${Y1}"/>
    ${ticksX.map(([t, l]) => `<text class="cv-axis" x="${xOf(t)}" y="${Y1 + 22}" text-anchor="middle">${l}</text>`).join('')}
    <g clip-path="url(#cvclip)">
      <path class="cv-area" d="${onD}L${xOf(TMAX)},${Y1}L${X0},${Y1}Z"/>
      <path class="cv-off" d="${path(rOff)}"/>
      <path class="cv-on" d="${onD}"/>
    </g>
    ${reviews.filter((t) => t < TMAX).map((t, i) => `<g class="cv-rev" data-t="${t}"><circle class="cv-dot" cx="${xOf(t)}" cy="${yOf(1)}" r="5"/><text class="cv-lbl" x="${xOf(t)}" y="${yOf(1) - 12}" text-anchor="middle">Day ${Math.round(t)}</text></g>`).join('')}
    <line class="cv-head" id="cv-head" x1="${X0}" x2="${X0}" y1="${Y0 - 6}" y2="${Y1}"/>
  `);
}
const p4 = $('#p4');
const memory = $('#memory');
const cvClip = $('#cv-clip');
const cvHead = $('#cv-head');
const cvRevs = [...document.querySelectorAll('.cv-rev')];
const crDay = $('#cr-day'), crNext = $('#cr-next');
let lastDay = -1;
function updateCurve() {
  const u = clamp01((actP(p4) - 0.06) / 0.84);
  const t = TMAX * u * u;
  const x = xOf(t);
  cvClip.setAttribute('width', (x + 1).toFixed(1));
  cvHead.setAttribute('x1', x.toFixed(1)); cvHead.setAttribute('x2', x.toFixed(1));
  cvRevs.forEach((g) => { g.style.opacity = t >= +g.dataset.t ? 1 : 0; });
  const day = Math.round(t);
  if (day !== lastDay) {
    lastDay = day;
    crDay.textContent = day;
    const next = reviews.find((rt) => rt > t);
    const left = next == null ? null : Math.max(1, Math.round(next - t));
    crNext.textContent = left == null ? 'months away' : `in ${left} day${left === 1 ? '' : 's'}`;
    memory.dataset.scVerifyState = String(day);
  }
}

// ------------------------------------------------------------------ page 5: the Teacher's week
{
  const rail = $('#rail');
  const end = $('#approval');
  $('#goal').textContent = `${TEACHER.plan.goal} · ${TEACHER.plan.days.length} days`;
  $('#ask').textContent = `“${TEACHER.prompt}”`;
  $('#memchips').innerHTML = TEACHER.memory.map((m) => `<li><b>Remembered</b> ${esc(m.fact)}</li>`).join('');
  const days = TEACHER.plan.days;
  days.forEach((d, k) => {
    const art = document.createElement('article');
    art.className = 'day';
    art.style.setProperty('--i', k + 1);
    art.innerHTML = `<p class="day__n">Day ${d.day}</p><h3 class="day__f">${esc(d.focus)}</h3><ul>${d.items.map((it) => `<li><span class="kind kind--${esc(it.kind)}">${esc(it.kind)}</span><span>${esc(it.title)}</span></li>`).join('')}</ul>`;
    rail.appendChild(art);
  });
  end.style.setProperty('--i', days.length + 1);
  const a = TEACHER.approval;
  end.innerHTML = `
    <div class="approval">
      <p class="approval__k">Suggested lesson · ${esc(a.level)}</p>
      <h3 class="approval__t">${esc(a.topic)}</h3>
      <p class="approval__r">${esc(a.reason)}</p>
      <div class="approval__go"><a class="btn btn--primary" href="${esc(startUrl(a.topic))}">Start this lesson</a></div>
    </div>
    <p class="rail__note">A real plan the Teacher made for one learner, who asked the question above. You can see and delete anything it remembers.</p>`;
}

// ------------------------------------------------------------------ close
const close = $('#close');
const closeAct = $('#cards');
function updateClose() {
  close.dataset.scVerifyState = (Math.round(clamp01((actP(closeAct) - 0.04) * 2.3) * 20)).toString();
}

// ------------------------------------------------------------------ one loop
function frame() {
  updateBar();
  updateHero();
  updateStream();
  updateCurve();
  updateClose();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Today (#/): input first. The hero is one large composer (a question as the headline, an
// auto-growing field, and a footer with the mode, the level and send), with quick-start chips
// under it. Below it, a short "Up next" queue (the three most pressing items). The streak, the deck
// and recent reading live in the sidebar and the nav badges, so Today does not repeat them.
// Phases 9-10: the header carries the Teacher's brief when a deadline or the streak is at stake,
// Up next has "Refresh" rows for fading lessons and dated plan rows, and the command bar takes the
// learner's own material.

import { el, icon, toast, relTime } from './ui.js';
import { currentStreak, deckStats } from './deck.js';
import { studiedToday, upNext, suggestedTopics, greeting, courseProgress, topicInterest, readingMinutes, LEVELS, levelOf } from './progress-core.js';
import { pageCount } from './steering-core.js';
import { practiceConcepts } from './mastery-screen.js'; // Phase 6
import { dayLabel } from './plan-core.js'; // Phase 10
import { dailyBrief } from './brief-core.js'; // Phase 10
import { postJson } from './stream-client.js';

const MODES = [
  { id: 'lesson', label: 'Lesson', icon: 'book', title: 'What do you want to learn?', placeholder: 'Ask about anything: how vaccines work, Bayes’ theorem, the French Revolution…', action: 'Begin' },
  { id: 'course', label: 'Course', icon: 'layers', title: 'What do you want to study?', placeholder: 'A subject to learn over several lessons, e.g. statistics from scratch', action: 'Plan' },
  { id: 'teacher', label: 'Teacher', icon: 'teacher', title: 'What do you need help with?', placeholder: 'A goal, a question, or a plan you need', action: 'Send' },
  { id: 'material', label: 'Material', icon: 'download', title: 'What should Mull teach from?', placeholder: 'A title for your notes (optional)', action: 'Begin' },
];
const UP_NEXT_ROWS = 3; // upNext() lists the most pressing first
const TEACHER_CHIPS = ['What should I study today?', 'Make me a 5-day plan for a goal', 'Quiz me on my last lesson', 'How am I doing?'];
const MATERIAL_ACCEPT = '.txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf';

// PDFs larger than one part go up in parts, so no request passes the host's body cap (4.5 MB on
// Vercel, which answers 413). The sizes come from /api/status (server/materials.js); these are
// only for when it could not be read.
const MATERIAL_LIMITS = { maxPdfBytes: 20 * 1024 * 1024, partBytes: 2 * 1024 * 1024 };

function readAs(blob, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read that file'));
    r.onload = () => resolve(String(r.result));
    if (how === 'base64') r.readAsDataURL(blob); else r.readAsText(blob);
  });
}
const base64Of = async (blob) => (await readAs(blob, 'base64')).replace(/^data:[^,]*,/, '');

/** Phase 10: read an attached file into a /api/materials body (a large PDF is uploaded in parts first). */
async function readMaterialFile(file, { maxPdfBytes, partBytes } = MATERIAL_LIMITS) {
  const pdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!pdf) return { kind: 'text', text: await readAs(file, 'text'), filename: file.name };
  if (file.size > maxPdfBytes) throw new Error(`That PDF is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${maxPdfBytes / 1048576} MB.`);
  if (file.size <= partBytes) return { kind: 'pdf', base64: await base64Of(file), filename: file.name };
  const total = Math.ceil(file.size / partBytes);
  let upload = null;
  for (let index = 0; index < total; index++) {
    const base64 = await base64Of(file.slice(index * partBytes, (index + 1) * partBytes));
    ({ upload } = await postJson('/api/materials/part', { upload, index, total, base64 }));
  }
  return { kind: 'pdf', upload, parts: total, filename: file.name };
}

/**
 * @param {{app: HTMLElement, store: object, status: object, actions: object}} ctx
 *   actions: startLesson(topic, level), planCourse(topic, level) → Promise, askTeacher(text),
 *            openPlanItem(planId, dayIndex, itemIndex), openCourseLesson(courseId, si, li)
 */
export function renderToday(ctx) {
  const { app, store, actions } = ctx;
  const d = store.data;
  const settings = d.settings || {};
  const now = new Date();
  const studied = studiedToday(d.stats, now);
  const streak = currentStreak(d.stats, now);
  const name = String(settings.name || '').trim();

  // -- header (Phase 10: the brief's headline when a deadline or the streak is at stake)
  const brief = dailyBrief(d, now);
  const sub = brief.urgent ? brief.headline : studied
    ? `Day ${streak} of the streak.`
    : streak > 0 ? `Keep the ${streak}-day streak going.` : 'Pick up where you left off, or start something new.';
  const heroTitle = el('h1', { class: 'hero-title' });
  const head = el('div', { class: 'hero-top' },
    el('p', { class: 'hero-greet' }, `${greeting(now)}${name ? `, ${name}` : ''}`, el('span', { class: 'hero-dot', 'aria-hidden': 'true' }, '·'), el('span', { class: brief.urgent ? 'hero-urgent' : '' }, sub)),
    heroTitle);

  // -- command bar
  let mode = 'lesson';
  let level = levelOf(settings);
  const input = el('textarea', { rows: '1', maxlength: '300', autocomplete: 'off', class: 'composer-input', 'aria-label': 'What do you want to learn?' });
  const go = el('button', { class: 'composer-send', type: 'submit', 'aria-label': 'Begin', title: 'Begin (Enter)' }, icon('arrow-up'));
  const goLabel = el('span', { class: 'composer-hint' });
  const modeSeg = el('div', { class: 'composer-modes', role: 'tablist', 'aria-label': 'What to start' }, ...MODES.map((m) => el('button', {
    class: 'composer-mode', type: 'button', role: 'tab', 'aria-selected': String(m.id === mode), dataset: { mode: m.id },
    onclick: () => { setMode(m.id); input.focus(); },
  }, icon(m.icon), el('span', null, m.label))));
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px`; };
  input.addEventListener('input', () => { autosize(); go.classList.toggle('ready', !!input.value.trim() || mode === 'material'); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  const levelSel = el('select', { class: 'cmd-level', 'aria-label': 'Level', onchange: (e) => { level = e.target.value; } }, ...LEVELS.map((lv) => el('option', { value: lv.id, selected: lv.id === level }, lv.label)));
  // -- Phase 10: "Material": paste notes or attach a file; Begin writes a lesson from it, or a course
  let file = null;
  const notes = el('textarea', { class: 'cmd-notes', rows: '5', maxlength: '200000', placeholder: 'Paste your notes, a chapter or a syllabus. Mull teaches from it and cites it.', 'aria-label': 'Your material' });
  const fileInput = el('input', { type: 'file', accept: MATERIAL_ACCEPT, hidden: true });
  const fileChip = el('span', { class: 'file-chip', hidden: true });
  const courseBtn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => submit('course') }, 'Make a course');
  const materialBox = el('div', { class: 'cmd-material', hidden: true },
    notes,
    el('div', { class: 'cmd-material-foot' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => fileInput.click() }, icon('plus'), 'Attach .txt, .md or .pdf'),
      fileChip,
      el('span', { class: 'cmd-material-note' }, 'Stored on this Mull server'),
      courseBtn),
    fileInput);
  fileInput.addEventListener('change', () => {
    file = fileInput.files?.[0] || null;
    fileInput.value = '';
    fileChip.hidden = !file;
    fileChip.replaceChildren(...(file ? [el('span', null, file.name), el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove file', onclick: () => { file = null; fileChip.hidden = true; } }, icon('x'))] : []));
  });
  async function uploadMaterial() {
    const body = file ? await readMaterialFile(file, ctx.status?.materials || MATERIAL_LIMITS) : { kind: 'text', text: notes.value };
    if (input.value.trim()) body.title = input.value.trim();
    return (await postJson('/api/materials', body)).item;
  }
  function setMode(m) {
    mode = m;
    const def = MODES.find((x) => x.id === m);
    for (const b of modeSeg.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    input.placeholder = def.placeholder;
    heroTitle.textContent = def.title;
    go.setAttribute('aria-label', def.action);
    go.title = `${def.action} (Enter)`;
    goLabel.textContent = 'Enter to ' + def.action.toLowerCase() + ' · Shift+Enter for a new line';
    levelSel.hidden = m === 'teacher';
    materialBox.hidden = m !== 'material';
    composer.classList.toggle('has-material', m === 'material');
    go.classList.toggle('ready', !!input.value.trim() || m === 'material');
    drawChips();
  }
  async function submit(as = 'lesson') {
    const t = input.value.trim();
    if (mode === 'material') {
      if (!notes.value.trim() && !file) { notes.focus(); toast('Paste some material or attach a file first'); return; }
      go.disabled = true;
      courseBtn.disabled = true;
      go.classList.add('busy');
      try {
        const item = await uploadMaterial();
        if (as === 'course') { if (!(await actions.planCourse(item.title, level, item))) throw new Error('Could not plan the course'); }
        else actions.startMaterialLesson(item, level);
      } catch (e) {
        toast(e.message || 'Could not add that material');
        go.disabled = false;
        go.classList.remove('busy');
        courseBtn.disabled = false;
        setMode('material');
      }
      return;
    }
    if (!t) { input.focus(); toast(mode === 'teacher' ? 'Write a message first' : 'Name a subject first'); return; }
    if (mode === 'lesson') actions.startLesson(t, level);
    else if (mode === 'teacher') actions.askTeacher(t);
    else {
      go.disabled = true;
      go.classList.add('busy');
      const ok = await actions.planCourse(t, level);
      if (!ok) { go.disabled = false; go.classList.remove('busy'); setMode('course'); }
    }
  }
  // quick starts under the composer: topics for lessons and courses, prompts for the Teacher
  const topics = suggestedTopics(settings, d.lessons, now, 5);
  const chips = el('div', { class: 'hero-chips', 'aria-label': 'Suggestions' });
  function drawChips() {
    if (mode === 'material') { chips.replaceChildren(); return; }
    const list = mode === 'teacher' ? TEACHER_CHIPS : topics;
    chips.replaceChildren(...list.map((t) => el('button', { class: 'hero-chip', type: 'button', onclick: () => { input.value = t; autosize(); submit(); } },
      mode === 'teacher' ? null : el('span', { class: 'hero-chip-tag' }, topicInterest(t) || 'General'), t)),
    ...(mode === 'teacher' ? [] : [el('a', { class: 'hero-chip hero-chip-link', href: '#/interests' }, 'Interests', icon('arrow-right'))]));
  }
  const composer = el('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('label', { class: 'composer-field' }, input),
    materialBox,
    el('div', { class: 'composer-bar' }, modeSeg, el('span', { class: 'composer-spacer' }), goLabel, levelSel, go));
  composer.addEventListener('click', (e) => { if (e.target === composer) input.focus(); });
  setMode('lesson');
  const cmd = el('section', { class: 'hero', 'aria-label': 'Start something' }, head, composer, chips);
  if (window.matchMedia?.('(min-width: 900px)').matches) setTimeout(() => input.focus({ preventScroll: true }), 50);

  // -- Up next
  const next = upNext(d, now).slice(0, UP_NEXT_ROWS);
  const queue = el('section', { class: 'panel-section' },
    sectionHead('Up next', next[0]?.kind === 'start' ? null : `${next.length}`, el('button', { class: 'link-btn', type: 'button', onclick: () => actions.teacherCheckIn?.() }, 'Ask your Teacher', icon('arrow-right'))),
    el('ol', { class: 'queue' }, ...next.map((n, i) => queueRow(n, i, ctx)), ...(next[0]?.kind === 'start' ? quickRows(ctx) : [])));


  app.replaceChildren(el('div', { class: 'today' }, cmd, el('div', { class: 't-below' }, queue)));
}

function sectionHead(title, count, extra) {
  return el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, title, count ? el('span', { class: 'count' }, count) : null), extra || null);
}

function queueRow(n, i, ctx) {
  const { actions, store } = ctx;
  const row = ({ kind, title, meta, body, cta, onclick, href }) => {
    const act = href ? el('a', { class: `btn ${i ? 'btn-secondary' : ''} btn-sm`, href }, cta) : el('button', { class: `btn ${i ? 'btn-secondary' : ''} btn-sm`, type: 'button', onclick }, cta);
    return el('li', { class: `q ${i === 0 ? 'q-first' : ''}` },
      el('span', { class: 'q-idx' }, String(i + 1).padStart(2, '0')),
      el('div', { class: 'q-body' },
        el('span', { class: 'q-kind' }, kind),
        el('span', { class: 'q-title' }, title),
        body && i === 0 ? el('span', { class: 'q-text' }, body) : null,
        meta ? el('span', { class: 'q-meta' }, meta) : null),
      act);
  };
  if (n.kind === 'continue') {
    const l = store.data.lessons[n.lessonId];
    const pages = pageCount(l?.markdown);
    const course = n.courseId ? store.data.courses.find((c) => c.id === n.courseId) : null;
    return row({ kind: n.interrupted ? 'Unfinished lesson' : 'Continue reading', title: n.title,
      body: n.interrupted ? 'Stopped before the end. Resume continues from the last complete paragraph.' : null,
      meta: [pages ? `${pages} pages` : null, readingMinutes(l?.markdown) ? `${readingMinutes(l.markdown)} min` : null, n.page > 1 ? `on page ${n.page}` : null, course?.title, l?.updatedAt ? relTime(l.updatedAt) : null].filter(Boolean).join(' · '),
      cta: n.interrupted ? 'Resume' : 'Continue', href: `#/lesson/${n.lessonId}` });
  }
  if (n.kind === 'review') {
    return row({ kind: 'Review', title: `${n.due} card${n.due === 1 ? '' : 's'} due`, body: 'Recall each card just before you would forget it.',
      meta: `about ${Math.max(1, Math.round(Math.min(n.due, 12) * 0.4))} min`, cta: 'Review', href: '#/review' });
  }
  if (n.kind === 'strengthen') {
    return row({ kind: 'Strengthen', title: `Firm up ${n.concepts.length === 1 ? n.concepts[0] : `${n.concepts.length} shaky concepts`}`,
      body: `Your recent answers suggest these need another look: ${n.concepts.join(', ')}. Your Teacher will quiz you on them.`,
      meta: n.concepts.length > 1 ? n.concepts.join(' · ') : 'shaky in your recent answers', cta: 'Quiz me', onclick: () => practiceConcepts(actions, n.concepts) });
  }
  if (n.kind === 'refresh') { // Phase 9: a lesson that did not stick
    const measured = n.recall != null;
    return row({ kind: 'Refresh', title: `“${n.title}” is fading`,
      body: measured ? `You recalled ${n.recall}% of its cards when they came back days later. A short review now brings it back.` : 'Your review history says this one is slipping. A short review now brings it back.',
      meta: [measured ? `${n.recall}% recall over ${n.reviews} reviews` : n.memoryToday != null ? `about ${n.memoryToday}% remembered today` : null, n.slipping ? `${n.slipping} card${n.slipping === 1 ? '' : 's'} keep slipping` : null].filter(Boolean).join(' · '),
      cta: 'Refresh', href: `#/review/lesson/${n.lessonId}` });
  }
  if (n.kind === 'course-review') { // a course slipping as a whole: mixed recall across its lessons
    return row({ kind: 'Course review', title: `Review all of “${n.title}”`,
      body: 'Cards from every lesson, mixed together. Recalling ideas side by side is what makes a course stick.',
      meta: [`about ${n.memory}% remembered across ${n.lessons} lessons`, n.due ? `${n.due} due` : null].filter(Boolean).join(' · '),
      cta: 'Review', href: `#/review/course/${n.courseId}` });
  }
  if (n.kind === 'plan') { // Phase 10: by calendar day
    const when = n.when === 'overdue' ? `Study plan · overdue since ${dayLabel(n.date)}` : n.when === 'upcoming' ? `Study plan · ahead, ${dayLabel(n.date)}` : `Study plan · today, day ${n.day}`;
    return row({ kind: when, title: n.title, body: n.goal, cta: n.itemKind === 'quiz' ? 'Quiz' : 'Open', onclick: () => actions.openPlanItem(n.planId, n.dayIndex, n.itemIndex) });
  }
  if (n.kind === 'course') {
    return row({ kind: n.courseTitle, title: n.title, body: n.summary, meta: `lesson ${n.done + 1} of ${n.total}`, cta: n.done ? 'Next lesson' : 'Start', onclick: () => actions.openCourseLesson(n.courseId, n.si, n.li) });
  }
  const t = suggestedTopics(store.data.settings, store.data.lessons, new Date(), 1)[0];
  return row({ kind: n.first ? 'First lesson' : 'All caught up', title: n.first ? `Start with “${t}”` : `Read “${t}”`,
    body: 'Lessons are written for you as you read: short pages, working diagrams, a quiz, and a tutor beside the text.', meta: 'about 10 min', cta: 'Start', onclick: () => actions.startLesson(t, 'beginner') });
}

function quickRows(ctx) {
  const { actions } = ctx;
  const r = (i, kind, title, cta, onclick, href) => el('li', { class: 'q' },
    el('span', { class: 'q-idx' }, String(i).padStart(2, '0')),
    el('div', { class: 'q-body' }, el('span', { class: 'q-kind' }, kind), el('span', { class: 'q-title' }, title)),
    href ? el('a', { class: 'btn btn-secondary btn-sm', href }, cta) : el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick }, cta));
  return [
    r(2, 'Teacher', 'Plan a week of study around a goal', 'Plan', null, '#/teacher'),
    r(3, 'Teacher', 'Ask what to study today', 'Ask', () => actions.askTeacher('What should I study today?')),
  ];
}

export { courseProgress, deckStats };

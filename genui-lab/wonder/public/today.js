// Today (#/): just the composer. A question as the headline, an auto-growing field, and a footer
// with the mode, the level and send, with quick-start chips under it. What to do next lives in the
// sidebar, the nav badges and the Teacher, so Today does not repeat it.
// Phase 10: the command bar also takes the learner's own material.

import { el, icon, toast } from './ui.js';
import { suggestedTopics, LEVELS, levelOf } from './progress-core.js';
import { postJson } from './stream-client.js';

const MODES = [
  { id: 'lesson', label: 'Lesson', icon: 'book', title: 'What do you want to learn?', placeholder: 'Type a topic', action: 'Begin' },
  { id: 'course', label: 'Course', icon: 'layers', title: 'What do you want to study?', placeholder: 'Type a subject', action: 'Plan' },
  { id: 'teacher', label: 'Teacher', icon: 'teacher', title: 'What do you need help with?', placeholder: 'Ask your Teacher', action: 'Send' },
  { id: 'material', label: 'Material', icon: 'download', title: 'Learn from your notes', placeholder: 'Title (optional)', action: 'Begin' },
];
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
  const heroTitle = el('h1', { class: 'hero-title' });

  // -- command bar
  let mode = 'lesson';
  let level = levelOf(settings);
  const input = el('textarea', { rows: '1', maxlength: '300', autocomplete: 'off', class: 'composer-input', 'aria-label': 'What do you want to learn?' });
  const go = el('button', { class: 'composer-send', type: 'submit', 'aria-label': 'Begin', title: 'Begin (Enter)' }, icon('arrow-up'));
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
  const notes = el('textarea', { class: 'cmd-notes', rows: '5', maxlength: '200000', placeholder: 'Paste your notes here', 'aria-label': 'Your material' });
  const fileInput = el('input', { type: 'file', accept: MATERIAL_ACCEPT, hidden: true });
  const fileChip = el('span', { class: 'file-chip', hidden: true });
  const courseBtn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => submit('course') }, 'Make a course');
  const materialBox = el('div', { class: 'cmd-material', hidden: true },
    notes,
    el('div', { class: 'cmd-material-foot' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => fileInput.click() }, icon('plus'), 'Attach a file'),
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
    chips.replaceChildren(...list.map((t) => el('button', { class: 'hero-chip', type: 'button', onclick: () => { input.value = t; autosize(); submit(); } }, t)),
    ...(mode === 'teacher' ? [] : [el('a', { class: 'hero-chip hero-chip-link', href: '#/interests' }, 'Interests', icon('arrow-right'))]));
  }
  const composer = el('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('label', { class: 'composer-field' }, input),
    materialBox,
    el('div', { class: 'composer-bar' }, modeSeg, el('span', { class: 'composer-spacer' }), levelSel, go));
  composer.addEventListener('click', (e) => { if (e.target === composer) input.focus(); });
  setMode('lesson');
  const cmd = el('section', { class: 'hero', 'aria-label': 'Start something' }, heroTitle, composer, chips);
  if (window.matchMedia?.('(min-width: 900px)').matches) setTimeout(() => input.focus({ preventScroll: true }), 50);

  app.replaceChildren(el('div', { class: 'today' }, cmd));
}

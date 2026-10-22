// You (#/you): profile name, totals, an activity heatmap, settings (daily goal, theme, reading
// size), learner memory, and data export / reset.

import { el, icon, toast } from './ui.js';
import { learnerTotals, activityGrid, DAILY_GOALS, goalOf } from './progress-core.js';
import { memoryPanel } from './memory-screen.js';

export const TEXT_SIZES = [['0.92', 'Small'], ['1', 'Default'], ['1.1', 'Large'], ['1.2', 'Larger']];

/** @param {{app: HTMLElement, store: object, shell: object, refresh: Function}} ctx */
export function renderYou(ctx) {
  const { app, store, shell } = ctx;
  const d = store.data;
  const t = learnerTotals(d);
  const settings = () => store.data.settings || {};
  const setSetting = (patch) => { store.update((dd) => { dd.settings = { ...(dd.settings || {}), ...patch }; return dd; }); ctx.refresh?.(); };

  // -- profile
  const nameInput = el('input', { type: 'text', maxlength: '40', value: settings().name || '', placeholder: 'Your name', 'aria-label': 'Your name' });
  const avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' }, (settings().name || 'W').trim()[0]?.toUpperCase() || 'W');
  nameInput.addEventListener('change', () => { setSetting({ name: nameInput.value.trim() }); avatar.textContent = (nameInput.value.trim() || 'W')[0].toUpperCase(); toast('Name saved'); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
  const head = el('header', { class: 'profile-head' }, avatar,
    el('div', { style: { flex: '1', minWidth: '200px', display: 'grid', gap: '2px' } },
      el('label', { class: 'profile-name' }, nameInput, icon('edit')),
      el('span', { class: 'muted small' }, t.activeDays ? `Learning on ${t.activeDays} day${t.activeDays === 1 ? '' : 's'} so far` : 'Your learning profile')));

  // -- totals
  const tile = (_ic, _cls, value, label) => el('div', { class: 'stat-tile' }, el('span', { class: 'ledger-label' }, label), el('strong', null, String(value)));
  const stats = el('section', { class: 'stat-grid', 'aria-label': 'Totals' },
    tile('', '', t.streak, 'Streak, days'),
    tile('', '', t.bestStreak, 'Longest streak'),
    tile('bolt', '', t.xp, 'Total XP'),
    tile('check', 'green', t.lessonsFinished, 'Lessons finished'),
    tile('cards', '', t.cards, 'Cards in deck'),
    tile('', '', t.mastered, 'Cards mastered'));

  // -- heatmap
  const weeks = window.innerWidth < 560 ? 15 : 22;
  const grid = activityGrid(d.stats, new Date(), { weeks });
  const heat = el('section', { class: 'card heat-card', 'aria-label': 'Activity' },
    el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, 'Activity'), el('span', { class: 'muted small' }, `Last ${weeks} weeks`)),
    el('div', { class: 'heat', role: 'img', 'aria-label': `XP per day over the last ${weeks} weeks` }, ...grid.map((col) => el('div', { class: 'heat-col' },
      ...col.map((c) => el('span', { class: `heat-cell ${c.future ? 'future' : ''}`, dataset: { level: String(c.level) }, title: c.future ? '' : `${c.key}: ${c.xp} XP` }))))),
    el('div', { class: 'heat-legend' }, 'Less', ...[0, 1, 2, 3, 4].map((l) => el('span', { class: 'heat-cell', dataset: { level: String(l) } })), 'More'));

  // -- settings
  const radioSeg = (label, options, current, onPick) => {
    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, ...options.map(([v, l, ic]) => el('button', {
      class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': String(String(v) === String(current)), dataset: { v: String(v) },
      onclick: () => { for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.v === String(v))); onPick(v); },
    }, ic ? icon(ic) : null, l)));
    return seg;
  };
  const goal = goalOf(settings());
  const settingsCard = el('section', { class: 'section' },
    el('h2', { class: 'rubric' }, 'Settings'),
    el('div', { class: 'card settings' },
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Daily goal'), el('p', { class: 'muted small' }, 'XP to earn each day. A finished lesson gives 50 or more; each review 1 to 5.')),
        radioSeg('Daily goal', DAILY_GOALS.map((g) => [g.xp, `${g.label} · ${g.xp}`]), goal, (v) => { setSetting({ dailyGoal: Number(v) }); toast(`Daily goal: ${v} XP`); })),
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Theme')),
        radioSeg('Theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], shell.theme, (v) => shell.setTheme(v))),
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Lesson text size'), el('p', { class: 'muted small' }, 'Also in each lesson’s menu.')),
        radioSeg('Lesson text size', TEXT_SIZES, String(settings().fontScale || 1), (v) => setSetting({ fontScale: Number(v) })))));

  // -- data
  const exportBtn = el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => {
    const blob = new Blob([JSON.stringify(store.data, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `wonder-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } }, icon('download'), 'Export my data');
  const resetBtn = el('button', { class: 'btn btn-secondary btn-danger', type: 'button', onclick: () => {
    if (!confirm('Erase all lessons, courses, Teacher chats, cards, XP and streaks from this browser? This cannot be undone. (Memory is separate, above.)')) return;
    store.reset();
    store.flush();
    toast('All progress erased');
    location.hash = '#/';
    ctx.reroute?.();
  } }, icon('trash'), 'Erase progress');
  const dataCard = el('section', { class: 'section' },
    el('h2', { class: 'rubric' }, 'Your data'),
    el('div', { class: 'card settings' },
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Stored in this browser'), el('p', { class: 'muted small' }, store.persistent ? 'Lessons, chats, cards and progress live in this browser’s local storage.' : 'Storage is blocked here, so progress lasts only until you close the tab.')),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, exportBtn, resetBtn))));

  // settings-style layout: a section nav beside the content; the nav follows your scroll
  const SECTIONS = [['profile', 'Profile'], ['activity', 'Activity'], ['preferences', 'Preferences'], ['memory', 'Memory'], ['data', 'Data']];
  const sec = (id, ...kids) => el('section', { class: 'you-sec', id: `you-${id}` }, ...kids);
  const navLinks = SECTIONS.map(([id, label]) => el('a', { class: 'you-nav-link', href: `#/you`, dataset: { sec: id }, onclick: (e) => {
    e.preventDefault();
    document.getElementById(`you-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, label));
  const nav = el('nav', { class: 'you-nav', 'aria-label': 'Sections' }, ...navLinks);
  const mark = (id) => { for (const a of navLinks) a.toggleAttribute('aria-current', a.dataset.sec === id); };
  mark('profile');
  const content = el('div', { class: 'you-content' },
    sec('profile', head, stats),
    sec('activity', heat),
    sec('preferences', settingsCard),
    sec('memory', memoryPanel(ctx)),
    sec('data', dataCard));
  app.replaceChildren(el('div', { class: 'you' }, el('h1', { class: 'h-xl you-title' }, 'You'), el('div', { class: 'you-layout' }, nav, content)));
  const io = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) mark(vis.target.id.replace('you-', ''));
  }, { rootMargin: '-15% 0px -70% 0px' });
  for (const n of content.children) io.observe(n);
  ctx.teardown?.push(() => io.disconnect());
  if (location.hash === '#/memory') requestAnimationFrame(() => document.getElementById('you-memory')?.scrollIntoView({ block: 'start' }));
}

// You (#/you): profile name, totals, an activity heatmap, settings (daily goal, theme, reading
// size), learner memory, and data export / reset.

import { el, icon, toast } from './ui.js';
import { learnerTotals, activityGrid, DAILY_GOALS, goalOf } from './progress-core.js';
import { memoryPanel } from './memory-screen.js';
import { insightsPanel } from './insights-panel.js'; // Phase 6

export const TEXT_SIZES = [['0.92', 'Small'], ['1', 'Default'], ['1.1', 'Large'], ['1.2', 'Larger']];

/**
 * Phase 7: the learner's materials (stored on the Wonder server, not in this browser): open the
 * original, teach a new lesson from it, or delete it.
 */
function materialsPanel(ctx) {
  const list = el('div', { class: 'materials-list' }, el('p', { class: 'muted small' }, 'Loading…'));
  const size = (m) => (m.kind === 'pdf' ? `PDF · ${(m.bytes / 1048576).toFixed(1)} MB` : `Text · ${Math.max(1, Math.round(m.chars / 1000))}k characters`);
  const draw = (items) => {
    if (!items.length) { list.replaceChildren(el('p', { class: 'muted small' }, 'Nothing yet. On Today, choose “My material” to paste notes or attach a PDF; Wonder teaches from it and cites it.')); return; }
    list.replaceChildren(...items.map((m) => el('div', { class: 'card material-row' },
      el('span', { class: 'icon-tile' }, icon('file')),
      el('span', { class: 'up-item-text' }, el('strong', null, m.title), el('span', { class: 'muted small' }, `${size(m)} · added ${new Date(m.createdAt).toLocaleDateString()}`)),
      el('a', { class: 'btn btn-ghost btn-sm', href: `/api/materials/file?id=${m.id}`, target: '_blank', rel: 'noopener' }, 'Open'),
      el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => ctx.actions?.startMaterialLesson?.(m) }, icon('play'), 'Lesson'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${m.title}`, onclick: async () => {
        if (!confirm(`Delete “${m.title}” from the Wonder server? Lessons already written from it stay.`)) return;
        try {
          const r = await fetch(`/api/materials?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error);
          draw(r.items || []);
          toast('Material deleted');
        } catch (e) { toast(e.message || 'Could not delete it'); }
      } }, icon('trash')))));
  };
  fetch('/api/materials').then((r) => r.json()).then((r) => draw(r.items || [])).catch(() => list.replaceChildren(el('p', { class: 'muted small' }, 'Could not load your materials.')));
  return el('section', { class: 'section', id: 'materials' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Your material'), el('span', { class: 'muted small' }, 'Stored on this Wonder server')),
    list);
}

/** A row with a switch. */
function switchSetting(title, note, on, onChange) {
  const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': title }, el('span', { class: 'switch-knob' }));
  sw.addEventListener('click', () => { const next = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(next)); onChange(next); });
  return el('div', { class: 'setting' }, el('div', { class: 'setting-text' }, el('strong', null, title), el('p', { class: 'muted small' }, note)), sw);
}

/**
 * Phase 7: daily study reminder. A browser notification at this time while a Wonder tab is open
 * (if today's goal isn't met), and the time used for plan events added to a calendar.
 */
function reminderSetting(settings, setSetting) {
  const r = () => ({ enabled: false, time: '18:00', ...(settings().reminder || {}) });
  const supported = typeof Notification !== 'undefined';
  const note = el('p', { class: 'muted small' });
  const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(r().enabled && supported && Notification.permission === 'granted'), 'aria-label': 'Daily reminder', disabled: !supported });
  sw.append(el('span', { class: 'switch-knob' }));
  const time = el('input', { type: 'time', value: r().time, 'aria-label': 'Reminder time', class: 'time-input' });
  const describe = () => {
    note.textContent = !supported ? 'This browser has no notifications. Use “Add to calendar” on your study plan instead.'
      : Notification.permission === 'denied' ? 'Notifications are blocked for this site in your browser settings. “Add to calendar” on your plan still works.'
        : r().enabled ? `Wonder nudges you at ${r().time} on days you haven’t met your goal, while a Wonder tab is open. Plan events added to your calendar use this time too.`
          : 'A nudge at this time on days you haven’t met your goal. Plan events added to your calendar use this time too.';
  };
  sw.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    if (next && Notification.permission !== 'granted') {
      let p = 'denied';
      try { p = await Notification.requestPermission(); } catch {}
      if (p !== 'granted') { describe(); toast('Notifications were not allowed'); return; }
    }
    setSetting({ reminder: { ...r(), enabled: next } });
    sw.setAttribute('aria-checked', String(next));
    describe();
    toast(next ? `Daily reminder at ${r().time}` : 'Reminder off');
  });
  time.addEventListener('change', () => { if (/^\d{2}:\d{2}$/.test(time.value)) { setSetting({ reminder: { ...r(), time: time.value } }); describe(); } });
  describe();
  return el('div', { class: 'setting' }, el('div', { class: 'setting-text' }, el('strong', null, 'Daily reminder'), note), el('div', { class: 'reminder-controls' }, time, sw));
}

/** @param {{app: HTMLElement, store: object, shell: object, refresh: Function, createLesson: Function}} ctx */
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
  const tile = (ic, cls, value, label) => el('div', { class: 'card stat-tile' }, el('div', { class: 'stat-tile-top' }, el('span', { class: `icon-tile ${cls}`, style: { width: '32px', height: '32px', borderRadius: '10px' } }, icon(ic))), el('strong', null, String(value)), el('span', null, label));
  const stats = el('section', { class: 'stat-grid', 'aria-label': 'Totals' },
    tile('flame', 'flame', t.streak, 'Day streak'),
    tile('trophy', 'amber', t.bestStreak, 'Best streak'),
    tile('bolt', '', t.xp, 'Total XP'),
    tile('check', 'green', t.lessonsFinished, 'Lessons finished'),
    tile('cards', '', t.cards, 'Cards in deck'),
    tile('sparkles', 'green', t.mastered, 'Cards mastered'));

  // -- heatmap
  const weeks = window.innerWidth < 560 ? 15 : 22;
  const grid = activityGrid(d.stats, new Date(), { weeks });
  const heat = el('section', { class: 'card heat-card', 'aria-label': 'Activity' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h-md' }, 'Activity'), el('span', { class: 'muted small' }, `Last ${weeks} weeks`)),
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
    el('h2', { class: 'h-md' }, 'Settings'),
    el('div', { class: 'card settings' },
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Daily goal'), el('p', { class: 'muted small' }, 'XP to earn each day to keep the goal ring full. Lessons give 50+, reviews 1–5 each.')),
        radioSeg('Daily goal', DAILY_GOALS.map((g) => [g.xp, `${g.label} · ${g.xp}`]), goal, (v) => { setSetting({ dailyGoal: Number(v) }); toast(`Daily goal: ${v} XP`); })),
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Theme')),
        radioSeg('Theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], shell.theme, (v) => shell.setTheme(v))),
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Lesson text size'), el('p', { class: 'muted small' }, 'Also in each lesson’s menu.')),
        radioSeg('Lesson text size', TEXT_SIZES, String(settings().fontScale || 1), (v) => setSetting({ fontScale: Number(v) }))),
      reminderSetting(settings, setSetting),
      switchSetting('Teacher check-in', 'The first time you open the Teacher each day, it looks at your progress and suggests the best next step.', settings().teacherCheckIn !== false, (on) => setSetting({ teacherCheckIn: on }))));

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
    el('h2', { class: 'h-md' }, 'Your data'),
    el('div', { class: 'card settings' },
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Stored in this browser'), el('p', { class: 'muted small' }, store.persistent ? 'Lessons, chats, cards and progress live in this browser’s local storage.' : 'Storage is blocked here, so progress lasts only until you close the tab.')),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, exportBtn, resetBtn))));

  app.replaceChildren(el('div', { class: 'you' }, head, stats, heat, insightsPanel(ctx), materialsPanel(ctx), settingsCard, memoryPanel(ctx), dataCard));
  if (location.hash === '#/memory') requestAnimationFrame(() => document.getElementById('memory')?.scrollIntoView({ block: 'start' }));
}

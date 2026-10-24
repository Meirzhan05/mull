// You (#/you): profile name, totals, an activity heatmap, settings (daily goal, theme, reading
// size), learner memory, and data export / reset.

import { el, icon, toast } from './ui.js';
import { learnerTotals, activityGrid, DAILY_GOALS, LEVELS, goalOf, levelOf } from './progress-core.js';
import { interestGrid } from './onboarding.js';
import { memoryPanel } from './memory-screen.js';
import { masteryPanel } from './mastery-screen.js'; // Phase 6
import { insightsPanel } from './insights-panel.js'; // Phase 9
import { accountInfo, signedInAccount, currentSyncStatus, onSyncStatus, syncEngine, signIn, signOut, switchToSignedIn, accountLabel, pushAvailable, enablePush, disablePush } from './account.js'; // account sync

export const TEXT_SIZES = [['0.92', 'Small'], ['1', 'Default'], ['1.1', 'Large'], ['1.2', 'Larger']];

/**
 * Phase 10: the learner's materials (stored on the Wonder server, not in this browser): open the
 * original, teach a new lesson from it, or delete it.
 */
function materialsPanel(ctx) {
  const card = el('div', { class: 'card materials-card' }, el('p', { class: 'muted small materials-empty' }, 'Loading…'));
  const count = el('span', { class: 'count', hidden: true });
  const size = (m) => (m.kind === 'pdf' ? `PDF, ${(m.bytes / 1048576).toFixed(1)} MB` : `Text, ${Math.max(1, Math.round(m.chars / 1000))}k characters`);
  const draw = (items) => {
    count.hidden = !items.length;
    count.textContent = String(items.length);
    if (!items.length) { card.replaceChildren(el('p', { class: 'muted small materials-empty' }, 'Nothing yet. On Today, choose Material to paste notes or attach a PDF. Wonder teaches from it and cites it.')); return; }
    card.replaceChildren(el('ul', { class: 'materials-list' }, ...items.map((m) => el('li', { class: 'material-row' },
      el('div', { class: 'mastery-text' }, el('strong', null, m.title), el('span', { class: 'muted small' }, `${size(m)} · added ${new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)),
      el('div', { class: 'works-actions' },
        el('a', { class: 'btn btn-ghost btn-sm', href: `/api/materials/file?id=${m.id}`, target: '_blank', rel: 'noopener' }, 'Open'),
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => ctx.actions?.startMaterialLesson?.(m) }, 'New lesson'),
        el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': `Delete ${m.title}`, title: 'Delete', onclick: async () => {
          if (!confirm(`Delete “${m.title}” from the Wonder server? Lessons already written from it stay.`)) return;
          try {
            const r = await fetch(`/api/materials?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' }).then((x) => x.json());
            if (!r.ok) throw new Error(r.error);
            draw(r.items || []);
            toast('Material deleted');
          } catch (e) { toast(e.message || 'Could not delete it'); }
        } }, icon('trash')))))));
  };
  fetch('/api/materials').then((r) => r.json()).then((r) => draw(r.items || [])).catch(() => card.replaceChildren(el('p', { class: 'muted small materials-empty' }, 'Could not load your materials.')));
  return el('div', { class: 'mastery', id: 'materials' },
    el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, 'Your material', count), el('span', { class: 'muted small' }, signedInAccount() ? 'Stored in your account' : 'Stored on this Wonder server')),
    card);
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/**
 * Account sync: sign in to keep lessons, cards, progress, memory and material in an account and
 * on every browser signed in to it. Shown only when the server has accounts configured.
 */
function accountPanel(ctx) {
  const body = el('div', { class: 'card settings' });
  const sec = el('div', { class: 'account-sync', hidden: true, style: { marginBottom: '12px' } }, body);
  const btn = (label, cls, onclick) => el('button', { class: `btn ${cls}`, type: 'button', onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await onclick(); } catch (err) { toast(err.message || 'That did not work'); } finally { b.disabled = false; }
  } }, label);
  const row = (title, note, ...actions) => el('div', { class: 'setting' }, el('div', { class: 'setting-text' }, el('strong', null, title), el('p', { class: 'muted small' }, note)), el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, ...actions));
  const draw = () => {
    const info = accountInfo();
    sec.hidden = !info?.sync;
    if (!info?.sync) return;
    const acct = signedInAccount();
    const st = currentSyncStatus();
    if (!acct) {
      body.replaceChildren(row('Sync across your devices', 'Sign in to keep your lessons, cards, progress, memory and material in an account, on every browser you sign in on. What this browser has comes with you.',
        btn('Sign in', 'btn-primary', signIn)));
    } else if (st.state === 'mismatch') {
      body.replaceChildren(row('Signed in as someone else', 'This browser holds another account’s copy. Switch to the account that is signed in now, or sign out.',
        btn('Use this account', 'btn-secondary', switchToSignedIn), btn('Sign out', 'btn-secondary', signOut)));
    } else if (st.state === 'signedOut') {
      body.replaceChildren(row('Your session ended', 'Sign in again to keep syncing. Changes made here meanwhile are kept and sync once you are back.',
        btn('Sign in', 'btn-primary', signIn), btn('Sign out', 'btn-secondary', signOut)));
    } else {
      const pending = syncEngine()?.pending() || 0;
      const line = st.state === 'syncing' ? 'Syncing…'
        : st.state === 'offline' ? `Offline. ${pending ? `${pending} change${pending === 1 ? '' : 's'} will sync when you are back.` : 'Everything here is saved.'}`
          : st.state === 'error' ? `Could not sync (${st.error || 'error'}). Retrying.`
            : st.state === 'unavailable' ? 'Sync is unavailable on this server right now; this browser keeps your changes.'
              : st.at ? `Synced ${ago(st.at)}${pending ? ` · ${pending} waiting` : ''}.` : 'Connecting…';
      const usageLine = el('p', { class: 'muted small', style: { margin: '4px 0 0' } });
      body.replaceChildren(row(accountLabel() ? `Signed in as ${accountLabel()}` : 'Signed in', `${line} Lessons, cards, progress, memory and material are kept in your account.`,
        btn('Sync now', 'btn-secondary', async () => { await syncEngine()?.syncNow(); toast('Synced'); }),
        btn('Sign out', 'btn-secondary', async () => { if (await signOut()) toast('Signed out'); })), usageLine);
      showUsage(usageLine);
    }
  };
  draw();
  const off = onSyncStatus(draw);
  const timer = setInterval(draw, 30_000);
  ctx.teardown?.push(() => { off(); clearInterval(timer); });
  return sec;
}

/** Today's use of the daily caps (server/usage.js), from /api/account; empty when there are none. */
async function showUsage(line) {
  let u = null;
  try { u = (await (await fetch('/api/account', { headers: { Accept: 'application/json' } })).json()).usage; } catch {}
  const kinds = u?.kinds || {};
  const part = (k, noun) => (kinds[k]?.max != null ? `${kinds[k].used} of ${kinds[k].max} ${noun}` : null);
  const parts = [part('lesson', 'lessons'), part('tutor', 'tutor messages'), part('teacher', 'Teacher messages')].filter(Boolean);
  line.textContent = parts.length ? `Today: ${parts.join(' · ')}. Resets at midnight UTC.` : '';
  line.hidden = !parts.length;
}

/** A row with a switch. */
function switchSetting(title, note, on, onChange) {
  const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': title }, el('span', { class: 'switch-knob' }));
  sw.addEventListener('click', () => { const next = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(next)); onChange(next); });
  return el('div', { class: 'setting' }, el('div', { class: 'setting-text' }, el('strong', null, title), el('p', { class: 'muted small' }, note)), sw);
}

/**
 * Phase 10: daily study reminder. A browser notification at this time while a Wonder tab is open
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
        : r().enabled ? `Wonder nudges you at ${r().time} on days you haven’t met your goal, ${pushAvailable() ? 'on this device even when Wonder is closed' : 'while a Wonder tab is open'}. Plan events added to your calendar use this time too.`
          : 'A nudge at this time on days you haven’t met your goal. Plan events added to your calendar use this time too.';
  };
  sw.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    if (next && Notification.permission !== 'granted') {
      let p = 'denied';
      try { p = await Notification.requestPermission(); } catch {}
      if (p !== 'granted') { describe(); toast('Notifications were not allowed'); return; }
    }
    // signed in with push on the server: the reminder also arrives with no tab open (Web Push)
    if (pushAvailable()) {
      try { if (next) await enablePush(); else await disablePush(); } catch { /* the in-tab reminder still works */ }
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
        Object.assign(radioSeg('Daily goal', DAILY_GOALS.map((g) => [g.xp, `${g.label} · ${g.xp}`]), goal, (v) => { setSetting({ dailyGoal: Number(v) }); toast(`Daily goal: ${v} XP`); }), { className: 'seg seg-grid' })),
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Lesson level'), el('p', { class: 'muted small' }, 'Where new lessons start. Each lesson can still pick its own.')),
        radioSeg('Lesson level', LEVELS.map((l) => [l.id, l.label]), levelOf(settings()), (v) => setSetting({ level: v }))),
      el('div', { class: 'setting setting-stack', id: 'interests' },
        el('div', { class: 'setting-text' }, el('strong', null, 'Interests'), el('p', { class: 'muted small' }, 'They shape the suggested topics on Today.')),
        interestGrid(new Set(settings().interests || []), (k, on) => {
          const now = new Set(settings().interests || []);
          if (on) now.add(k); else now.delete(k);
          setSetting({ interests: [...now] });
        })),
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
    if (!confirm(signedInAccount()
      ? 'Erase all lessons, courses, Teacher chats, cards, XP and streaks from your account, on every device? This cannot be undone. (Memory is separate, above.)'
      : 'Erase all lessons, courses, Teacher chats, cards, XP and streaks from this browser? This cannot be undone. (Memory is separate, above.)')) return;
    store.reset();
    store.flush();
    toast('All progress erased');
    location.hash = '#/';
    ctx.reroute?.();
  } }, icon('trash'), 'Erase progress');
  const dataCard = el('section', { class: 'section' },
    el('h2', { class: 'rubric' }, 'Your data'),
    accountPanel(ctx),
    el('div', { class: 'card settings' },
      el('div', { class: 'setting' },
        el('div', { class: 'setting-text' }, el('strong', null, signedInAccount() ? 'Stored in your account' : 'Stored in this browser'), el('p', { class: 'muted small' }, signedInAccount() ? 'Lessons, chats, cards and progress live in your account, with a copy in this browser for offline use.' : store.persistent ? 'Lessons, chats, cards and progress live in this browser’s local storage.' : 'Storage is blocked here, so progress lasts only until you close the tab.')),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, exportBtn, resetBtn))));

  // settings-style layout: a section nav beside the content; the nav follows your scroll
  const SECTIONS = [['profile', 'Profile'], ['knowledge', 'What you know'], ['works', 'What works'], ['activity', 'Activity'], ['preferences', 'Preferences'], ['memory', 'Memory'], ['material', 'Material'], ['data', 'Data']];
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
    sec('knowledge', masteryPanel(ctx)), // Phase 6
    sec('works', insightsPanel(ctx)), // Phase 9
    sec('activity', heat),
    sec('preferences', settingsCard),
    sec('memory', memoryPanel(ctx)),
    sec('material', materialsPanel(ctx)), // Phase 10
    sec('data', dataCard));
  app.replaceChildren(el('div', { class: 'you' }, el('h1', { class: 'h-xl you-title' }, 'You'), el('div', { class: 'you-layout' }, nav, content)));
  const io = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) mark(vis.target.id.replace('you-', ''));
  }, { rootMargin: '-15% 0px -70% 0px' });
  for (const n of content.children) io.observe(n);
  ctx.teardown?.push(() => io.disconnect());
  if (location.hash === '#/mastery') requestAnimationFrame(() => document.getElementById('you-knowledge')?.scrollIntoView({ block: 'start' }));
  if (location.hash === '#/memory') requestAnimationFrame(() => document.getElementById('you-memory')?.scrollIntoView({ block: 'start' }));
  if (location.hash === '#/interests') requestAnimationFrame(() => document.getElementById('interests')?.scrollIntoView({ block: 'center' }));
}

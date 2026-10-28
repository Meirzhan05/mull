// You (#/you): profile name, account, totals, what you know, an activity heatmap, and settings
// (level, interests, theme, reading size, reminder). Memory, material and data export are still
// kept and synced; they just have no place on this screen.

import { el, icon, toast } from './ui.js';
import { learnerTotals, activityGrid, LEVELS, levelOf } from './progress-core.js';
import { interestGrid } from './onboarding.js';
import { masteryPanel } from './mastery-screen.js'; // Phase 6
import { accountInfo, signedInAccount, currentSyncStatus, onSyncStatus, syncEngine, signIn, signOut, switchToSignedIn, accountLabel, pushAvailable, enablePush, disablePush } from './account.js'; // account sync

export const TEXT_SIZES = [['0.92', 'Small'], ['1', 'Default'], ['1.1', 'Large'], ['1.2', 'Larger']];

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/**
 * Account sync: sign in to keep lessons, cards and progress in an account and on every browser
 * signed in to it. Shown only when the server has accounts configured.
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
      body.replaceChildren(row('Sync across your devices', 'Sign in to keep your lessons, cards and progress in an account, on every browser you sign in on. What this browser has comes with you.',
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
      body.replaceChildren(row(accountLabel() ? `Signed in as ${accountLabel()}` : 'Signed in', `${line} Lessons, cards and progress are kept in your account.`,
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
 * (if nothing was studied yet that day), and the time used for plan events added to a calendar.
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
        : r().enabled ? `Wonder nudges you at ${r().time} on days you haven’t studied yet, ${pushAvailable() ? 'on this device even when Wonder is closed' : 'while a Wonder tab is open'}. Plan events added to your calendar use this time too.`
          : 'A nudge at this time on days you haven’t studied yet. Plan events added to your calendar use this time too.';
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
      el('span', { class: 'muted small' }, 'Your learning profile')));

  // -- totals
  const tile = (_ic, _cls, value, label) => el('div', { class: 'stat-tile' }, el('span', { class: 'ledger-label' }, label), el('strong', null, String(value)));
  const stats = el('section', { class: 'stat-grid', 'aria-label': 'Totals' },
    tile('', '', t.streak, 'Streak, days'),
    tile('', '', t.bestStreak, 'Longest streak'),
    tile('', '', t.activeDays, 'Days active'),
    tile('check', 'green', t.lessonsFinished, 'Lessons finished'),
    tile('cards', '', t.cards, 'Cards in deck'),
    tile('', '', t.mastered, 'Cards mastered'));

  // -- heatmap
  const weeks = window.innerWidth < 560 ? 15 : 22;
  const grid = activityGrid(d.stats, new Date(), { weeks });
  const heat = el('section', { class: 'card heat-card', 'aria-label': 'Activity' },
    el('div', { class: 'section-head' }, el('h2', { class: 'rubric' }, 'Activity'), el('span', { class: 'muted small' }, `Last ${weeks} weeks`)),
    el('div', { class: 'heat', role: 'img', 'aria-label': `Activity per day over the last ${weeks} weeks` }, ...grid.map((col) => el('div', { class: 'heat-col' },
      ...col.map((c) => el('span', { class: `heat-cell ${c.future ? 'future' : ''}`, dataset: { level: String(c.level) }, title: c.future ? '' : `${c.key}: ${c.count} ${c.count === 1 ? 'activity' : 'activities'}` }))))),
    el('div', { class: 'heat-legend' }, 'Less', ...[0, 1, 2, 3, 4].map((l) => el('span', { class: 'heat-cell', dataset: { level: String(l) } })), 'More'));

  // -- settings
  const radioSeg = (label, options, current, onPick) => {
    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, ...options.map(([v, l, ic]) => el('button', {
      class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': String(String(v) === String(current)), dataset: { v: String(v) },
      onclick: () => { for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.v === String(v))); onPick(v); },
    }, ic ? icon(ic) : null, l)));
    return seg;
  };
  const settingsCard = el('section', { class: 'section' },
    el('h2', { class: 'rubric' }, 'Settings'),
    el('div', { class: 'card settings' },
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

  // settings-style layout: a section nav beside the content; the nav follows your scroll
  const SECTIONS = [['profile', 'Profile'], ['knowledge', 'What you know'], ['activity', 'Activity'], ['preferences', 'Preferences']];
  const sec = (id, ...kids) => el('section', { class: 'you-sec', id: `you-${id}` }, ...kids);
  const navLinks = SECTIONS.map(([id, label]) => el('a', { class: 'you-nav-link', href: `#/you`, dataset: { sec: id }, onclick: (e) => {
    e.preventDefault();
    document.getElementById(`you-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, label));
  const nav = el('nav', { class: 'you-nav', 'aria-label': 'Sections' }, ...navLinks);
  const mark = (id) => { for (const a of navLinks) a.toggleAttribute('aria-current', a.dataset.sec === id); };
  mark('profile');
  const content = el('div', { class: 'you-content' },
    sec('profile', head, accountPanel(ctx), stats),
    sec('knowledge', masteryPanel(ctx)), // Phase 6
    sec('activity', heat),
    sec('preferences', settingsCard));
  app.replaceChildren(el('div', { class: 'you' }, el('h1', { class: 'h-xl you-title' }, 'You'), el('div', { class: 'you-layout' }, nav, content)));
  const io = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) mark(vis.target.id.replace('you-', ''));
  }, { rootMargin: '-15% 0px -70% 0px' });
  for (const n of content.children) io.observe(n);
  ctx.teardown?.push(() => io.disconnect());
  if (location.hash === '#/mastery') requestAnimationFrame(() => document.getElementById('you-knowledge')?.scrollIntoView({ block: 'start' }));
  if (location.hash === '#/interests') requestAnimationFrame(() => document.getElementById('interests')?.scrollIntoView({ block: 'center' }));
}

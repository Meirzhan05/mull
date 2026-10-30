// You (#/you): profile name, totals, what you know, an activity heatmap, settings (level,
// interests, theme, reading size, reminder), and the account at the end. Memory, material and data export are still
// kept and synced; they just have no place on this screen.

import { el, icon, toast } from './ui.js';
import { learnerTotals, activityGrid, LEVELS, levelOf } from './progress-core.js';
import { interestGrid } from './onboarding.js';
import { masteryPanel } from './mastery-screen.js'; // Phase 6
import { accountInfo, signedInAccount, currentSyncStatus, onSyncStatus, syncEngine, signIn, signOut, switchToSignedIn, deleteAccount, accountLabel, pushAvailable, enablePush, disablePush } from './account.js'; // account sync

export const TEXT_SIZES = [['0.92', 'Small'], ['1', 'Default'], ['1.1', 'Large'], ['1.2', 'Larger']];

/**
 * Account, at the end of the page: sign in or out, and delete the account. Shown only when the
 * server has accounts configured.
 */
function accountPanel(ctx) {
  const body = el('div', { class: 'card settings' });
  const sec = el('section', { class: 'you-sec', id: 'you-account', hidden: true }, el('h2', { class: 'rubric' }, 'Account'), body);
  const btn = (label, cls, onclick, busy = label) => el('button', { class: `btn ${cls}`, type: 'button', onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = busy;
    try { await onclick(); } catch (err) { toast(err.message || 'That did not work'); } finally { b.disabled = false; b.textContent = label; }
  } }, label);
  const row = (title, note, ...actions) => el('div', { class: 'setting' }, el('div', { class: 'setting-text' }, el('strong', null, title), note ? el('p', { class: 'muted small' }, note) : null), el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, ...actions));
  // redrawn on every sync status change; replaced only when the text changes, so a button
  // being clicked stays put
  let drawn = '';
  const show = (key, ...rows) => { if (key !== drawn) { drawn = key; body.replaceChildren(...rows); } };
  // the plan, fetched once per sign-in rather than on every sync status change
  const planEl = el('div', { class: 'setting', hidden: true });
  let planFor = null;
  const planRow = () => { if (planFor !== accountLabel()) { planFor = accountLabel(); showPlan(planEl); } return planEl; };
  const draw = () => {
    const info = accountInfo();
    sec.hidden = !info?.sync;
    ctx.onAccountShown?.(!sec.hidden);
    if (!info?.sync) return;
    const acct = signedInAccount();
    const st = currentSyncStatus();
    if (!acct) {
      show('signedOut', row('Sign in', 'Use Mull with your Google account. What this browser has comes with you.',
        btn('Sign in', 'btn-primary', signIn)));
    } else if (st.state === 'mismatch') {
      show('mismatch', row('Signed in as someone else', 'This browser holds another account’s copy. Switch to the account that is signed in now, or sign out.',
        btn('Use this account', 'btn-secondary', switchToSignedIn), btn('Sign out', 'btn-secondary', signOut)));
    } else if (st.state === 'signedOut') {
      show('ended', row('Your session ended', 'Sign in again to keep syncing. Changes made here meanwhile are kept and sync once you are back.',
        btn('Sign in', 'btn-primary', signIn), btn('Sign out', 'btn-secondary', signOut)));
    } else {
      const title = accountLabel() ? `Signed in as ${accountLabel()}` : 'Signed in';
      // no "synced" status: only a problem worth knowing about before signing out
      const pending = st.state === 'offline' ? syncEngine()?.pending() || 0 : 0;
      const problem = pending ? `Offline. ${pending} change${pending === 1 ? '' : 's'} will sync when you are back.`
        : st.state === 'error' ? `Could not sync (${st.error || 'error'}). Retrying.`
          : st.state === 'unavailable' ? 'Sync is unavailable on this server right now; this browser keeps your changes.' : null;
      show(`in:${title}:${problem}`,
        row(title, problem, btn('Sign out', 'btn-secondary', async () => { if (await signOut()) toast('Signed out'); })),
        planRow(),
        row('Delete account', 'Deletes your lessons, cards, progress, memory and material for good.',
          btn('Delete account', 'btn-danger', async () => {
            if (confirm('Delete your Mull account? Your lessons, cards, progress, memory and material are deleted for good. This cannot be undone.')) await deleteAccount();
          }, 'Deleting…')));
    }
  };
  draw();
  const off = onSyncStatus(draw);
  ctx.teardown?.push(off);
  return sec;
}

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The account's plan (server/plans.js) and today's use of its daily caps (server/usage.js), from
 * /api/account. Hidden when the server sends no plan. No upgrade button until payments are wired.
 */
async function showPlan(row) {
  let a = null;
  try { a = await (await fetch('/api/account', { headers: { Accept: 'application/json' } })).json(); } catch {}
  if (!a?.plan) return;
  const { plan, usage } = a;
  const kinds = usage?.kinds || {};
  const part = (k, noun) => (kinds[k]?.max != null ? `${kinds[k].used} of ${kinds[k].max} ${noun}` : null);
  const parts = [part('lesson', 'lessons'), part('tutor', 'tutor messages'), part('teacher', 'Teacher messages')].filter(Boolean);
  const standing = plan.source === 'comped' ? 'Given to you by this Mull server.'
    : plan.endsAt ? `Ends ${shortDate(plan.endsAt)}.`
      : plan.renewsAt ? `Renews ${shortDate(plan.renewsAt)}.`
        : plan.id === 'pro' ? '' : 'Every account starts here.';
  const today = parts.length ? `Today: ${parts.join(' · ')}. Resets at midnight UTC.` : '';
  row.replaceChildren(el('div', { class: 'setting-text' },
    el('strong', null, `${plan.name} plan`),
    el('p', { class: 'muted small' }, [standing, today].filter(Boolean).join(' '))));
  row.hidden = false;
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
        : r().enabled ? `Mull nudges you at ${r().time} on days you haven’t studied yet, ${pushAvailable() ? 'on this device even when Mull is closed' : 'while a Mull tab is open'}. Plan events added to your calendar use this time too.`
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
  const SECTIONS = [['profile', 'Profile'], ['knowledge', 'What you know'], ['activity', 'Activity'], ['preferences', 'Preferences'], ['account', 'Account']];
  const sec = (id, ...kids) => el('section', { class: 'you-sec', id: `you-${id}` }, ...kids);
  const navLinks = SECTIONS.map(([id, label]) => el('a', { class: 'you-nav-link', href: `#/you`, dataset: { sec: id }, onclick: (e) => {
    e.preventDefault();
    document.getElementById(`you-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, label));
  const nav = el('nav', { class: 'you-nav', 'aria-label': 'Sections' }, ...navLinks);
  const mark = (id) => { for (const a of navLinks) a.toggleAttribute('aria-current', a.dataset.sec === id); };
  mark('profile');
  const accountLink = navLinks.find((a) => a.dataset.sec === 'account');
  const content = el('div', { class: 'you-content' },
    sec('profile', head, stats),
    sec('knowledge', masteryPanel(ctx)), // Phase 6
    sec('activity', heat),
    sec('preferences', settingsCard),
    accountPanel({ ...ctx, onAccountShown: (on) => { accountLink.hidden = !on; } }));
  app.replaceChildren(el('div', { class: 'you' }, el('h1', { class: 'h-xl you-title' }, 'You'), el('div', { class: 'you-layout' }, nav, content)));
  // scrolled to the end: the last section, which may be too short to reach the band below
  const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  const markEnd = () => { if (atEnd()) mark([...content.children].filter((n) => !n.hidden).pop().id.replace('you-', '')); };
  const io = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) mark(vis.target.id.replace('you-', ''));
    markEnd();
  }, { rootMargin: '-15% 0px -70% 0px' });
  for (const n of content.children) io.observe(n);
  window.addEventListener('scroll', markEnd, { passive: true });
  ctx.teardown?.push(() => { io.disconnect(); window.removeEventListener('scroll', markEnd); });
  if (location.hash === '#/mastery') requestAnimationFrame(() => document.getElementById('you-knowledge')?.scrollIntoView({ block: 'start' }));
  if (location.hash === '#/interests') requestAnimationFrame(() => document.getElementById('interests')?.scrollIntoView({ block: 'center' }));
}

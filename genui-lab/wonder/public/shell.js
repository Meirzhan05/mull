// App shell: the desktop sidebar, the mobile top bar and bottom tabs, the daily-goal mini ring,
// the theme switch, the demo notice and the ⌘K command palette. Screens render into #app;
// the shell only reflects the current route and the learner's stats.

import { el, icon, toast } from './ui.js';
import { deckStats, currentStreak } from './deck.js';
import { dailyProgress, matchScore } from './progress-core.js';

const NAV = [
  { id: 'today', label: 'Today', icon: 'home', href: '#/' },
  { id: 'library', label: 'Library', icon: 'library', href: '#/library' },
  { id: 'review', label: 'Review', icon: 'repeat', href: '#/review' },
  { id: 'teacher', label: 'Teacher', icon: 'teacher', href: '#/teacher' },
  { id: 'you', label: 'You', icon: 'user', href: '#/you' },
];
// which nav entry a screen belongs to
const SECTION = { home: 'today', course: 'library', lesson: 'library', library: 'library', review: 'review', teacher: 'teacher', you: 'you', memory: 'you' };

const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export function createShell({ store, getStatus, actions }) {
  const sidebar = document.getElementById('sidebar');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');
  const banner = document.getElementById('demo-banner');

  const brand = () => el('a', { class: 'brand', href: '#/', 'aria-label': 'Wonder, today' },
    el('span', { class: 'brand-name' }, 'Wonder'), el('span', { class: 'brand-dot', 'aria-hidden': 'true' }, '.'));

  // -- theme
  let theme = 'system';
  try { theme = localStorage.getItem('wonder.theme') || 'system'; } catch {}
  const applyTheme = () => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  };
  applyTheme();
  const themeBtn = el('button', { class: 'side-theme', type: 'button' });
  const setTheme = (t) => {
    theme = THEMES.includes(t) ? t : 'system';
    applyTheme();
    try { localStorage.setItem('wonder.theme', theme); } catch {}
    drawThemeBtn();
  };
  const drawThemeBtn = () => {
    themeBtn.replaceChildren(icon(THEME_ICON[theme]), el('span', { class: 'side-theme-label' }, theme === 'dark' ? 'Night reading' : theme === 'light' ? 'Day reading' : 'Match system'));
    themeBtn.setAttribute('aria-label', `Color theme: ${theme}. Switch theme`);
  };
  themeBtn.addEventListener('click', () => { setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]); toast(`Theme: ${theme}`); });
  drawThemeBtn();

  // -- sidebar (desktop)
  const navLinks = {};
  const navBadges = {};
  const nav = el('nav', { class: 'nav', 'aria-label': 'Sections' }, ...NAV.map((n) => {
    navBadges[n.id] = el('span', { class: 'badge', hidden: true });
    navLinks[n.id] = el('a', { class: 'nav-link', href: n.href, title: n.label }, icon(n.icon), el('span', { class: 'nav-label' }, n.label), navBadges[n.id]);
    return navLinks[n.id];
  }));
  const searchBtn = el('button', { class: 'search-trigger', type: 'button', 'aria-label': 'Search or start a lesson', onclick: () => openPalette() },
    icon('search'), el('span', { class: 'search-trigger-text' }, 'Search or begin…'), el('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  const goalMini = el('a', { class: 'goal-mini', href: '#/you', title: 'Daily goal' });
  sidebar.replaceChildren(brand(), searchBtn, nav, el('div', { class: 'sidebar-foot' }, goalMini, themeBtn));

  // -- top bar (mobile)
  const streakChip = el('a', { class: 'chip chip-streak', href: '#/you', title: 'Streak' });
  const xpChip = el('a', { class: 'chip chip-xp', href: '#/you', title: 'Today against your daily goal' });
  topbar.replaceChildren(brand(), el('div', { class: 'topbar-right' }, streakChip, xpChip,
    el('button', { class: 'icon-btn plain', type: 'button', 'aria-label': 'Search or start a lesson', onclick: () => openPalette() }, icon('search'))));

  // -- tabs (mobile)
  const tabLinks = {};
  const tabBadges = {};
  tabbar.replaceChildren(...NAV.map((n) => {
    tabBadges[n.id] = el('span', { class: 'badge', hidden: true });
    tabLinks[n.id] = el('a', { class: 'tab', href: n.href }, icon(n.icon), el('span', null, n.label), tabBadges[n.id]);
    return tabLinks[n.id];
  }));

  function setActive(screen) {
    const section = SECTION[screen] || 'today';
    for (const n of NAV) {
      for (const m of [navLinks, tabLinks]) {
        if (n.id === section) m[n.id].setAttribute('aria-current', 'page');
        else m[n.id].removeAttribute('aria-current');
      }
    }
  }

  function refresh() {
    const d = store.data;
    const streak = currentStreak(d.stats);
    const day = dailyProgress(d.stats, d.settings);
    const due = deckStats(d.deck).due;
    for (const b of [navBadges.review, tabBadges.review]) { b.hidden = !due; b.textContent = due > 99 ? '99+' : String(due); }
    streakChip.classList.toggle('lit', streak > 0);
    streakChip.replaceChildren(el('span', { class: 'chip-unit' }, 'Day'), ` ${streak}`);
    streakChip.setAttribute('aria-label', `${streak} day streak`);
    xpChip.replaceChildren(`${day.xp}`, el('span', { class: 'chip-unit' }, ` / ${day.goal} XP`));
    xpChip.setAttribute('aria-label', `${day.xp} of ${day.goal} XP today`);
    goalMini.classList.toggle('met', day.met);
    goalMini.setAttribute('aria-label', `Today ${day.xp} of ${day.goal} XP, ${streak} day streak`);
    goalMini.replaceChildren(
      el('span', { class: 'goal-mini-text' },
        el('span', { class: 'goal-mini-label' }, 'Today'),
        el('strong', null, String(day.xp), el('small', null, ` / ${day.goal} XP`))),
      el('span', { class: `ledger-bar ${day.met ? 'met' : ''}`, 'aria-hidden': 'true' }, el('i', { style: { width: `${Math.round(day.pct * 100)}%` } })),
      el('span', { class: 'goal-mini-note' }, streak ? `Day ${streak} of the streak` : 'No streak yet'));
  }

  function bump() {
    for (const n of [xpChip, goalMini]) { n.classList.remove('bump'); void n.offsetWidth; n.classList.add('bump'); }
  }

  function showBanner(mode) {
    banner.hidden = mode !== 'demo';
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('wonder.demoDismissed') === '1'; } catch {}
    if (dismissed) banner.hidden = true;
    banner.replaceChildren(
      el('strong', null, 'Demo mode'),
      el('span', null, 'Lessons are pre-written samples. Set ', el('code', null, 'ANTHROPIC_API_KEY'), ' to have Claude write them live.'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => { banner.hidden = true; try { sessionStorage.setItem('wonder.demoDismissed', '1'); } catch {} } }, icon('x')));
  }

  // -- command palette
  let paletteOpen = null;
  function openPalette(initial = '') {
    if (paletteOpen) return;
    const prevFocus = document.activeElement;
    const input = el('input', { type: 'text', placeholder: 'Search lessons, or type a topic to learn…', 'aria-label': 'Search or start a lesson', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' });
    input.value = initial;
    const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    const overlay = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      el('div', { class: 'palette' },
        el('div', { class: 'palette-input' }, icon('search'), input, el('kbd', null, 'esc')),
        list,
        el('div', { class: 'palette-foot' },
          el('span', null, el('kbd', null, '↑'), el('kbd', null, '↓'), 'move'),
          el('span', null, el('kbd', null, '↵'), 'open'),
          el('span', null, el('kbd', null, 'esc'), 'close'))));
    let items = [];
    let sel = 0;

    function build() {
      const q = input.value.trim();
      const d = store.data;
      const groups = [];
      if (q) {
        groups.push(['Learn', [
          { icon: 'play', text: `Start a lesson: “${q}”`, hint: 'Lesson', run: () => actions.startLesson(q) },
          { icon: 'layers', text: `Plan a course: “${q}”`, hint: 'Course', run: () => actions.planCourse(q) },
          { icon: 'teacher', text: `Ask your Teacher: “${q}”`, hint: 'Teacher', run: () => actions.askTeacher(q) },
        ]]);
      }
      const lessons = Object.values(d.lessons)
        .map((l) => ({ l, s: matchScore(l.title || l.topic, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || (b.l.updatedAt || '').localeCompare(a.l.updatedAt || ''))
        .slice(0, q ? 6 : 4)
        .map(({ l }) => ({ icon: l.finished ? 'check' : 'book', text: l.title || l.topic, hint: l.finished ? 'Finished' : 'Lesson', run: () => { location.hash = `#/lesson/${l.id}`; } }));
      if (lessons.length) groups.push([q ? 'Lessons' : 'Recent lessons', lessons]);
      const courses = d.courses.filter((c) => matchScore(c.title, q) > 0).slice(0, 4)
        .map((c) => ({ icon: 'layers', text: c.title, hint: 'Course', run: () => { location.hash = `#/course/${c.id}`; } }));
      if (courses.length) groups.push(['Courses', courses]);
      const threads = q ? (d.teacherThreads || []).filter((t) => matchScore(t.title, q) > 0).slice(0, 3)
        .map((t) => ({ icon: 'chat', text: t.title, hint: 'Teacher chat', run: () => { location.hash = `#/teacher/${t.id}`; } })) : [];
      if (threads.length) groups.push(['Teacher chats', threads]);
      const due = deckStats(d.deck).due;
      const go = [
        { icon: 'home', text: 'Today', run: () => { location.hash = '#/'; } },
        { icon: 'repeat', text: due ? `Review ${due} due card${due === 1 ? '' : 's'}` : 'Review', run: () => { location.hash = '#/review'; } },
        { icon: 'library', text: 'Library', run: () => { location.hash = '#/library'; } },
        { icon: 'teacher', text: 'Teacher', run: () => { location.hash = '#/teacher'; } },
        { icon: 'user', text: 'You: stats, settings and memory', run: () => { location.hash = '#/you'; } },
        { icon: THEME_ICON[THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]], text: `Switch theme (now ${theme})`, run: () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]) },
      ].filter((x) => matchScore(x.text, q) > 0);
      if (go.length) groups.push(['Go to', go]);
      items = groups.flatMap(([, g]) => g);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      let i = 0;
      list.replaceChildren(...(items.length ? groups.flatMap(([title, g]) => [
        el('div', { class: 'palette-group', role: 'presentation' }, title),
        ...g.map((it) => {
          const idx = i++;
          return el('button', { class: 'palette-item', type: 'button', role: 'option', id: `pal-${idx}`, 'aria-selected': String(idx === sel), onclick: () => choose(idx), onmousemove: () => { if (sel !== idx) { sel = idx; mark(); } } },
            icon(it.icon), el('span', { class: 'palette-item-text' }, it.text), it.hint ? el('span', { class: 'palette-item-hint' }, it.hint) : null);
        }),
      ]) : [el('div', { class: 'palette-empty' }, 'Type a topic to start a lesson on it.')]));
      mark();
    }
    function mark() {
      for (const b of list.querySelectorAll('.palette-item')) b.setAttribute('aria-selected', String(b.id === `pal-${sel}`));
      input.setAttribute('aria-activedescendant', `pal-${sel}`);
      list.querySelector(`#pal-${sel}`)?.scrollIntoView({ block: 'nearest' });
    }
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      paletteOpen = null;
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    }
    function choose(i) {
      const it = items[i];
      close();
      it?.run();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); mark(); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); choose(sel); }
    }
    input.addEventListener('input', () => { sel = 0; build(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    paletteOpen = { close };
    build();
    input.focus();
    input.select();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen ? paletteOpen.close() : openPalette(); return; }
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!typing && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('.modal-overlay, .pack-overlay')) { e.preventDefault(); openPalette(); }
  });

  return { refresh, setActive, bump, showBanner, openPalette, setTheme, get theme() { return theme; } };
}

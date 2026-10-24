// App shell: the desktop sidebar (sections, then recent lessons and courses to jump back into),
// the mobile top bar and bottom tabs, the daily-goal mini ring, the theme switch, the demo
// notice and the ⌘K (or /) command palette, which also searches the learner's lessons,
// courses, cards and Teacher chats (search-core.js). Screens render into #app; the shell only
// reflects the current route and the learner's stats.

import { el, icon, toast } from './ui.js';
import { deckStats, currentStreak } from './deck.js';
import { dailyProgress, matchScore, courseProgress, recentLessons, lessonState } from './progress-core.js';
import { searchStoreGroups, openResult, resultBody, hasTitleHit, TYPE_ICON, resultCount } from './search-ui.js';

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

const RECENT_LESSONS = 5;
const RECENT_COURSES = 4;

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
  const recent = el('nav', { class: 'side-recent', 'aria-label': 'Recent lessons and courses' });
  sidebar.replaceChildren(brand(), searchBtn, nav, recent, el('div', { class: 'sidebar-foot' }, goalMini, themeBtn));

  // Rebuilt only when what it shows changes: refresh() runs on every store write (a streaming
  // lesson saves each second), and replacing the links would drop focus and in-flight clicks.
  let recentKey = '';
  function drawRecent(d) {
    const lessons = recentLessons(d, RECENT_LESSONS).map((l) => {
      const [state, label] = lessonState(l);
      return { href: `#/lesson/${l.id}`, label: l.title || l.topic || l.materialTitle || 'Untitled lesson', state, note: label };
    });
    const courses = d.courses.slice(0, RECENT_COURSES).map((c) => {
      const p = courseProgress(d, c);
      return { href: `#/course/${c.id}`, label: c.title || 'Untitled course', meta: `${p.done}/${p.total}` };
    });
    const key = JSON.stringify([lessons, courses]);
    if (key !== recentKey) {
      recentKey = key;
      const group = (id, title, items) => el('div', { role: 'group', 'aria-labelledby': id }, el('h2', { class: 'side-head', id }, title), ...items);
      recent.replaceChildren(
        group('side-recent-h', 'Recent', lessons.length
          ? lessons.map((l) => el('a', { class: 'side-item', href: l.href, title: `${l.label} · ${l.note}` },
            el('span', { class: `dotmark ${l.state}`, 'aria-hidden': 'true' }), el('span', { class: 'side-item-label' }, l.label)))
          : [el('p', { class: 'side-empty' }, 'Lessons you start show up here.')]),
        ...(courses.length ? [group('side-courses-h', 'Courses', courses.map((c) => el('a', { class: 'side-item', href: c.href, title: c.label },
          icon('library'), el('span', { class: 'side-item-label' }, c.label), el('span', { class: 'side-item-meta' }, c.meta))))] : []));
    }
    for (const a of recent.querySelectorAll('.side-item')) {
      if (a.getAttribute('href') === location.hash) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

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
    tabLinks[n.id] = el('a', { class: 'tab', href: n.href }, icon(n.icon), el('span', { class: 'tab-label' }, n.label), tabBadges[n.id]);
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
    drawRecent(d);
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
    const input = el('input', { type: 'text', placeholder: 'Search your lessons, cards and chats, or type a topic…', 'aria-label': 'Search or start a lesson', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list' });
    input.value = initial;
    const list = el('div', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
    const live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const overlay = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search and commands' },
      el('div', { class: 'palette' },
        el('div', { class: 'palette-input' }, icon('search'), input, el('kbd', null, 'esc')),
        list, live,
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
      const learn = q ? ['Learn', [
        { icon: 'play', text: `Start a lesson: “${q}”`, hint: 'Lesson', run: () => actions.startLesson(q) },
        { icon: 'layers', text: `Plan a course: “${q}”`, hint: 'Course', run: () => actions.planCourse(q) },
        { icon: 'teacher', text: `Ask your Teacher: “${q}”`, hint: 'Teacher', run: () => actions.askTeacher(q) },
      ]] : null;
      let found = 0;
      if (q) {
        // full-text search grouped by type, the group with the best match first (Enter opens
        // it); a title hit at the top means "find", so results come before "Learn"
        const grouped = searchStoreGroups(store, q, { perType: 4 }).sort((a, b) => b.results[0].score - a.results[0].score);
        found = grouped.reduce((n, g) => n + g.total, 0);
        const searchGroups = grouped.map((g) => [g.total > g.results.length ? `${g.label} · ${g.results.length} of ${g.total}` : g.label,
          g.results.map((r) => ({ icon: TYPE_ICON[r.type], result: r, run: () => openResult(r) }))]);
        if (grouped.some((g) => g.total > g.results.length)) {
          searchGroups.push(['More', [{ icon: 'library', text: `See all ${found} results in the Library`, run: () => { try { sessionStorage.setItem('wonder.libQuery', q); } catch {} if (location.hash === '#/library') window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = '#/library'; } }]]);
        }
        const top = grouped[0]?.results[0];
        if (top && hasTitleHit(top)) groups.push(...searchGroups, learn);
        else groups.push(learn, ...searchGroups);
      } else {
        const lessons = recentLessons(d, 4)
          .map((l) => ({ icon: l.finished ? 'check' : 'book', text: l.title || l.topic, hint: l.finished ? 'Finished' : 'Lesson', run: () => { location.hash = `#/lesson/${l.id}`; } }));
        if (lessons.length) groups.push(['Recent lessons', lessons]);
        const courses = d.courses.slice(0, 4).map((c) => ({ icon: 'layers', text: c.title, hint: 'Course', run: () => { location.hash = `#/course/${c.id}`; } }));
        if (courses.length) groups.push(['Courses', courses]);
      }
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
      list.replaceChildren(...(items.length ? groups.map(([title, g], gi) => el('div', { class: 'palette-section', role: 'group', 'aria-labelledby': `pal-g${gi}` },
        el('div', { class: 'palette-group', id: `pal-g${gi}`, role: 'presentation' }, title),
        ...g.map((it) => {
          const idx = i++;
          return el('div', { class: `palette-item ${it.result ? 'palette-result' : ''}`, role: 'option', id: `pal-${idx}`, 'aria-selected': String(idx === sel), onclick: () => choose(idx), onmousemove: () => { if (sel !== idx) { sel = idx; mark(); } } },
            icon(it.icon), it.result ? resultBody(it.result) : el('span', { class: 'palette-item-text' }, it.text), it.hint ? el('span', { class: 'palette-item-hint' }, it.hint) : null);
        }))) : [el('div', { class: 'palette-empty' }, 'Type a topic to start a lesson on it.')]));
      live.textContent = q ? (found ? `${resultCount(found)} in your lessons, cards and chats` : 'Nothing in your lessons, cards or chats yet') : '';
      mark();
    }
    function mark() {
      for (const b of list.querySelectorAll('.palette-item')) b.setAttribute('aria-selected', String(b.id === `pal-${sel}`));
      if (items.length) input.setAttribute('aria-activedescendant', `pal-${sel}`); else input.removeAttribute('aria-activedescendant');
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
      else if ((e.key === 'Home' || e.key === 'End') && (e.ctrlKey || e.metaKey) && items.length) { e.preventDefault(); sel = e.key === 'Home' ? 0 : items.length - 1; mark(); }
      else if (e.key === 'Tab') { e.preventDefault(); input.focus(); } // focus stays in the dialog
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); choose(sel); }
    }
    input.addEventListener('input', () => { sel = 0; build(); });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
      else if (e.target !== input) e.preventDefault(); // clicks on results keep focus (and the keyboard) in the field
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    paletteOpen = { close };
    build();
    input.focus();
    input.select();
  }

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.onboard')) return; // the first-run welcome has the keyboard to itself
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen ? paletteOpen.close() : openPalette(); return; }
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!typing && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('.modal-overlay, .pack-overlay')) { e.preventDefault(); openPalette(); }
  });

  return { refresh, setActive, bump, showBanner, openPalette, setTheme, get theme() { return theme; } };
}

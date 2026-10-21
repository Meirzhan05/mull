// Small overflow ("more") menu for the lesson bar. Holds rarely used lesson actions, such as
// "Reset interactive widgets" (clears the lesson's saved widget state, see view-state.js).
// Keyboard: Enter/Space/ArrowDown opens and focuses the first item, Arrow keys move, Escape
// closes and returns focus, and a click outside closes it.

import { el } from './ui.js';

function moreIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const cx of [5.5, 12, 18.5]) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', '12');
    c.setAttribute('r', '1.1');
    svg.appendChild(c);
  }
  return svg;
}

let seq = 0;

/** @param {{label?:string, items:{label:string, hint?:string, onSelect:()=>void}[]}} o */
export function createOverflowMenu({ label = 'More lesson options', items = [] } = {}) {
  const id = `overflow-menu-${++seq}`;
  const button = el('button', { class: 'icon-btn overflow-btn', type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id }, moreIcon());
  const entries = items.map((it) => el('button', { class: 'overflow-item', type: 'button', role: 'menuitem', tabindex: '-1' },
    el('span', { class: 'overflow-item-label' }, it.label),
    it.hint ? el('span', { class: 'overflow-item-hint' }, it.hint) : null));
  const menu = el('div', { class: 'overflow-menu', id, role: 'menu', 'aria-label': label, hidden: true }, ...entries);
  const wrap = el('div', { class: 'overflow' }, button, menu);

  const isOpen = () => !menu.hidden;
  function open(focusFirst = false) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEscape);
    if (focusFirst) entries[0]?.focus();
  }
  function close(returnFocus = false) {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEscape);
    if (returnFocus) button.focus();
  }
  function onOutside(e) { if (!wrap.contains(e.target)) close(); }
  function onEscape(e) { if (e.key === 'Escape') { e.preventDefault(); close(true); } }

  button.addEventListener('click', (e) => (isOpen() ? close() : open(e.detail === 0))); // keyboard activation focuses the first item
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(true); }
  });
  menu.addEventListener('keydown', (e) => {
    const i = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); entries[(i + 1) % entries.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(i - 1 + entries.length) % entries.length]?.focus(); }
    else if (e.key === 'Tab') close();
  });
  entries.forEach((b, i) => b.addEventListener('click', () => { close(true); items[i].onSelect?.(); }));

  return { el: wrap, close, destroy() { close(); } };
}

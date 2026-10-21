// Review session: due practice items (mcq / cloze / binary_choice / flashcard), graded with
// practice-core.js and rescheduled with FSRS (deck.js). Answering awards XP and keeps the
// streak alive.

import { el, icon, inlineMd } from './ui.js';
import { dueEntries, reviewEntry, previewDue, deckStats, awardXp, currentStreak, formatDue, XP, Rating } from './deck.js';
import { gradePracticeItem } from './practice-core.js';

const SESSION_SIZE = 12;
const TYPE_LABEL = { mcq: 'Multiple choice', cloze: 'Fill the blank', binary_choice: 'True or false', flashcard: 'Recall' };

function shuffle(list, seed) {
  const a = list.slice();
  let x = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) >>> 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function renderReview(root, { store, onExit, onXp }) {
  const now = new Date();
  const queue = dueEntries(store.data.deck, now, SESSION_SIZE);
  const session = { index: 0, correct: 0, answered: 0, xp: 0, results: [] };

  root.replaceChildren();
  const wrap = el('section', { class: 'review' });
  root.append(wrap);

  if (!queue.length) {
    const stats = deckStats(store.data.deck, now);
    wrap.append(el('div', { class: 'card empty-review' },
      el('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon('check', 'big-icon')),
      el('h1', { class: 'h-lg' }, stats.total ? 'All caught up' : 'No practice cards yet'),
      el('p', { class: 'muted' }, stats.total
        ? `Your next review is ${stats.nextDue ? formatDue(stats.nextDue, now) : 'later'}. Spacing reviews out is what makes them stick.`
        : 'Finish a lesson to collect knowledge cards and practice questions. They show up here when they are due.'),
      el('button', { class: 'btn', type: 'button', onclick: onExit }, 'Back home')));
    return () => {};
  }

  const header = el('div', { class: 'review-head' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'End review', onclick: () => finish() }, icon('x')),
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(queue.length) }, el('span', { class: 'progress-fill' })),
    el('span', { class: 'review-count' }));
  const stage = el('div', { class: 'review-stage' });
  wrap.append(header, stage);

  function setProgress() {
    const pct = (session.index / queue.length) * 100;
    header.querySelector('.progress-fill').style.width = `${pct}%`;
    header.querySelector('.progress').setAttribute('aria-valuenow', String(session.index));
    header.querySelector('.review-count').textContent = `${Math.min(session.index + 1, queue.length)} / ${queue.length}`;
  }

  function record(entry, rating, correct) {
    const t = new Date();
    let nextDue = null;
    store.update((d) => {
      const r = reviewEntry(d.deck, entry.id, rating, t);
      d.deck = r.deck;
      nextDue = r.entry.card.due;
      const gained = correct ? XP.reviewCorrect : XP.reviewAttempt;
      d.stats = awardXp(d.stats, gained, t);
      session.xp += gained;
      return d;
    });
    onXp?.();
    session.answered++;
    if (correct) session.correct++;
    session.results.push({ entry, correct, nextDue });
    return nextDue;
  }

  function feedback(card, { correct, expected, explanation, nextDue, typo }) {
    const box = el('div', { class: `feedback ${correct ? 'ok' : 'bad'}`, role: 'status' },
      el('div', { class: 'feedback-title' }, icon(correct ? 'check' : 'x'), correct ? (typo ? 'Correct (watch the spelling)' : 'Correct!') : 'Not quite'),
      !correct && expected !== '' ? el('p', null, 'Answer: ', el('strong', null, String(expected))) : null,
      explanation ? el('p', { class: 'muted' }, inlineMd(explanation)) : null,
      el('p', { class: 'next-due' }, `Next review ${formatDue(nextDue)}`));
    const next = el('button', { class: 'btn btn-lg', type: 'button', onclick: () => { session.index++; show(); } }, session.index === queue.length - 1 ? 'See results' : 'Continue');
    card.append(box, el('div', { class: 'review-actions' }, next));
    next.focus();
  }

  function show() {
    setProgress();
    if (session.index >= queue.length) return finish();
    const entry = queue[session.index];
    const item = entry.item;
    const card = el('article', { class: 'card review-card', 'aria-live': 'polite' },
      el('div', { class: 'review-meta' }, el('span', { class: 'pill' }, TYPE_LABEL[item.type] || 'Practice'), entry.lessonTitle ? el('span', { class: 'muted small' }, entry.lessonTitle) : null));
    stage.replaceChildren(card);

    if (item.type === 'mcq') {
      card.append(el('h2', { class: 'review-prompt' }, inlineMd(item.prompt)));
      const list = el('div', { class: 'choices' });
      const choices = shuffle(item.choices, entry.id.length + session.index);
      choices.forEach((c, i) => {
        const b = el('button', { class: 'choice', type: 'button', onclick: () => {
          const g = gradePracticeItem(item, c.id);
          for (const btn of list.children) {
            btn.disabled = true;
            const cc = choices[[...list.children].indexOf(btn)];
            if (cc.isCorrect) btn.classList.add('is-correct');
          }
          if (!g.correct) b.classList.add('is-wrong');
          const due = record(entry, g.rating, g.correct);
          feedback(card, { ...g, explanation: item.explanation, nextDue: due });
        } }, el('span', { class: 'choice-letter' }, 'ABCDE'[i]), el('span', null, inlineMd(c.text)));
        list.append(b);
      });
      card.append(list);
    } else if (item.type === 'binary_choice') {
      card.append(el('p', { class: 'muted small' }, 'Is this statement true or false?'), el('h2', { class: 'review-prompt' }, inlineMd(item.prompt)));
      const row = el('div', { class: 'tf-row' });
      for (const [label, val] of [['True', true], ['False', false]]) {
        row.append(el('button', { class: 'choice tf', type: 'button', onclick: (e) => {
          const g = gradePracticeItem(item, val);
          for (const b of row.children) b.disabled = true;
          e.currentTarget.classList.add(g.correct ? 'is-correct' : 'is-wrong');
          const due = record(entry, g.rating, g.correct);
          feedback(card, { ...g, explanation: item.explanation, nextDue: due });
        } }, label));
      }
      card.append(row);
    } else if (item.type === 'cloze') {
      const [before, after = ''] = item.prompt.split('____');
      const input = el('input', { class: 'cloze-input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Missing word' });
      const check = el('button', { class: 'btn', type: 'submit' }, 'Check');
      const form = el('form', { class: 'cloze', onsubmit: (e) => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        input.disabled = true;
        check.disabled = true;
        const g = gradePracticeItem(item, input.value);
        input.classList.add(g.correct ? 'is-correct' : 'is-wrong');
        const due = record(entry, g.rating, g.correct);
        feedback(card, { ...g, explanation: item.explanation, nextDue: due });
      } }, el('p', { class: 'review-prompt cloze-text' }, inlineMd(before), input, inlineMd(after)), el('div', { class: 'review-actions' }, check));
      card.append(form);
      setTimeout(() => input.focus(), 30);
    } else {
      card.append(el('h2', { class: 'review-prompt' }, inlineMd(item.front)));
      const reveal = el('button', { class: 'btn btn-lg', type: 'button', onclick: () => {
        reveal.remove();
        const preview = previewDue(entry);
        const grades = el('div', { class: 'grade-row' });
        for (const [label, key, r] of [['Again', 'again', Rating.Again], ['Hard', 'hard', Rating.Hard], ['Good', 'good', Rating.Good], ['Easy', 'easy', Rating.Easy]]) {
          grades.append(el('button', { class: `grade grade-${key}`, type: 'button', onclick: () => {
            const g = gradePracticeItem(item, key);
            const due = record(entry, g.rating, g.correct);
            session.index++;
            stage.querySelector('.grade-row')?.replaceChildren(el('p', { class: 'next-due' }, `Next review ${formatDue(due)}`));
            setTimeout(show, 450);
          } }, el('strong', null, label), el('span', null, formatDue(preview[r]))));
        }
        card.append(el('div', { class: 'flash-answer' }, inlineMd(item.back)), el('p', { class: 'muted small' }, 'How well did you remember it?'), grades);
      } }, 'Show answer');
      card.append(el('div', { class: 'review-actions' }, reveal));
    }
  }

  function finish() {
    const stats = deckStats(store.data.deck, new Date());
    const acc = session.answered ? Math.round((session.correct / session.answered) * 100) : 0;
    header.remove();
    stage.replaceChildren(el('article', { class: 'card review-done' },
      el('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon('sparkles', 'big-icon')),
      el('h1', { class: 'h-lg' }, session.answered ? 'Review complete' : 'Review ended'),
      el('div', { class: 'stat-row' },
        el('div', { class: 'stat' }, el('strong', null, String(session.answered)), el('span', null, 'reviewed')),
        el('div', { class: 'stat' }, el('strong', null, `${acc}%`), el('span', null, 'correct')),
        el('div', { class: 'stat' }, el('strong', null, `+${session.xp}`), el('span', null, 'XP')),
        el('div', { class: 'stat' }, el('strong', null, String(currentStreak(store.data.stats))), el('span', null, 'day streak'))),
      session.results.length ? el('ul', { class: 'next-list' }, ...session.results.slice(0, 6).map((r) => el('li', null,
        el('span', { class: `dot ${r.correct ? 'ok' : 'bad'}` }),
        el('span', { class: 'next-q' }, inlineMd(r.entry.item.prompt || r.entry.item.front)),
        el('span', { class: 'muted small' }, formatDue(r.nextDue))))) : null,
      el('p', { class: 'muted' }, stats.due ? `${stats.due} more card${stats.due === 1 ? '' : 's'} due now.` : stats.nextDue ? `Next card due ${formatDue(stats.nextDue)}.` : ''),
      el('div', { class: 'review-actions' },
        stats.due ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => renderReview(root, { store, onExit, onXp }) }, 'Keep going') : null,
        el('button', { class: 'btn', type: 'button', onclick: onExit }, 'Done'))));
  }

  show();
  return () => {};
}

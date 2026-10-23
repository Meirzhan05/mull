// Review session: due practice items (mcq / cloze / binary_choice / flashcard), graded with
// practice-core.js and rescheduled with FSRS (deck.js). Answering awards XP and keeps the
// streak alive.

import { el, icon, inlineMd } from './ui.js';
import { dueEntries, lessonEntries, reviewEntry, previewDue, deckStats, awardXp, currentStreak, formatDue, XP, Rating } from './deck.js';
import { gradePracticeItem } from './practice-core.js';
import { recordEvidence, ratingScore } from './mastery-core.js';
import { postJson } from './stream-client.js';
import { createVisualPractice, isVisualItem, visualFeedbackTitle, VISUAL_TYPE_LABEL } from './review-visual.js';

const SESSION_SIZE = 12;
const TYPE_LABEL = { mcq: 'Multiple choice', cloze: 'Fill the blank', binary_choice: 'True or false', flashcard: 'Recall', explain: 'Explain it' };
const GRADE_WORDS = ['Not yet', 'Partly there', 'Nearly there', 'Spot on'];
Object.assign(TYPE_LABEL, VISUAL_TYPE_LABEL); // number_line / chart_select / order_steps

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

// `entries` (optional): a ready-made queue, e.g. a whole-course review (course-review-core.js);
// `summary(results)` (optional) adds a node to the end-of-session card.
export function renderReview(root, { store, onExit, onXp, lessonId = null, entries = null, summary = null }) {
  const now = new Date();
  // a lesson refresh (Phase 9) reviews that lesson's weakest cards, due or not
  const queue = entries || (lessonId ? lessonEntries(store.data.deck, lessonId, now, SESSION_SIZE) : dueEntries(store.data.deck, now, SESSION_SIZE));
  const session = { index: 0, correct: 0, answered: 0, xp: 0, results: [] };
  // keyboard: digits pick choices / grades, T and F answer true-false, Space reveals, Enter continues
  let keys = {};
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !root.isConnected) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && e.key !== 'Enter') return;
    if (t?.closest?.('.dil-root') && (e.key === 'Enter' || e.key === ' ')) return; // a focused widget button handles these itself
    const k = e.key === ' ' ? 'space' : e.key.toLowerCase();
    const fn = keys[k];
    if (fn) { e.preventDefault(); fn(); }
  };
  document.addEventListener('keydown', onKey);
  const visual = createVisualPractice(); // one sandboxed DIL surface for the session's visual cards
  const cleanup = () => { document.removeEventListener('keydown', onKey); visual.destroy(); };

  root.replaceChildren();
  const wrap = el('section', { class: 'review' });
  root.append(wrap);

  if (!queue.length) {
    const stats = deckStats(store.data.deck, now);
    wrap.append(el('div', { class: 'card empty-review' },
      el('p', { class: 'kicker' }, 'Review'),
      el('h1', { class: 'h-lg' }, stats.total ? 'All caught up' : 'No practice cards yet'),
      el('p', { class: 'muted' }, stats.total
        ? `Your next review is ${stats.nextDue ? formatDue(stats.nextDue, now) : 'later'}. Spacing reviews out is what makes them stick.`
        : 'Finish a lesson to collect knowledge cards and practice questions. They show up here when they are due.'),
      el('button', { class: 'btn', type: 'button', onclick: onExit }, 'Back to Today')));
    cleanup();
    return cleanup;
  }

  const header = el('div', { class: 'review-head' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'End review', onclick: () => finish() }, icon('x')),
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(queue.length) }, el('span', { class: 'progress-fill' })),
    el('span', { class: 'review-count' }));
  const stage = el('div', { class: 'review-stage' });
  // session panel: where you are, how it is going, what the deck holds, and the keys
  const deckAtStart = deckStats(store.data.deck, now);
  const sRows = el('dl', { class: 'kv' });
  const queueList = el('ol', { class: 'r-queue', 'aria-label': 'This session' }, ...queue.map((e, i) => el('li', { dataset: { i: String(i) } },
    el('span', { class: 'r-q-mark', 'aria-hidden': 'true' }), el('span', { class: 'r-q-text' }, (e.item.prompt || e.item.front || '').replace(/[*_`]/g, '').replace('____', '…')))));
  const panel = el('aside', { class: 'review-panel', 'aria-label': 'Session' },
    el('section', { class: 'stat-panel' }, el('span', { class: 'stat-label' }, 'Session'), sRows),
    el('section', { class: 'stat-panel' }, el('span', { class: 'stat-label' }, 'Queue', el('span', { class: 'count' }, String(queue.length))), queueList),
    el('section', { class: 'stat-panel' }, el('span', { class: 'stat-label' }, 'Deck'),
      el('dl', { class: 'kv' },
        el('dt', null, 'Due now'), el('dd', null, String(deckAtStart.due)),
        el('dt', null, 'Learning'), el('dd', null, String(deckAtStart.learning + deckAtStart.new)),
        el('dt', null, 'Mastered'), el('dd', null, String(deckAtStart.review)),
        el('dt', null, 'Total'), el('dd', null, String(deckAtStart.total)))),
    el('section', { class: 'stat-panel keys-panel' }, el('span', { class: 'stat-label' }, 'Keys'),
      el('dl', { class: 'kv' },
        el('dt', null, el('kbd', null, '1'), '–', el('kbd', null, '5')), el('dd', null, 'Choose / grade'),
        el('dt', null, el('kbd', null, 'T'), ' ', el('kbd', null, 'F')), el('dd', null, 'True / false'),
        el('dt', null, el('kbd', null, 'Space')), el('dd', null, 'Show answer'),
        el('dt', null, el('kbd', null, '↵')), el('dd', null, 'Continue'))));
  const main = el('div', { class: 'review-main' }, header, stage);
  wrap.classList.add('review-layout');
  wrap.append(main, panel);

  function updatePanel() {
    const acc = session.answered ? Math.round((session.correct / session.answered) * 100) : null;
    sRows.replaceChildren(
      el('dt', null, 'Card'), el('dd', null, `${Math.min(session.index + 1, queue.length)} of ${queue.length}`),
      el('dt', null, 'Correct'), el('dd', null, `${session.correct} / ${session.answered}`),
      el('dt', null, 'Accuracy'), el('dd', null, acc == null ? '—' : `${acc}%`),
      el('dt', null, 'Earned'), el('dd', null, `+${session.xp} XP`));
    for (const li of queueList.children) {
      const i = Number(li.dataset.i);
      const r = session.results[i];
      li.className = i === session.index ? 'now' : r ? (r.correct ? 'ok' : 'bad') : '';
    }
  }

  function setProgress() {
    const pct = (session.index / queue.length) * 100;
    header.querySelector('.progress-fill').style.width = `${pct}%`;
    header.querySelector('.progress').setAttribute('aria-valuenow', String(session.index));
    header.querySelector('.review-count').textContent = `${Math.min(session.index + 1, queue.length)} / ${queue.length}`;
    updatePanel();
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
      // Phase 6: a tagged review is mastery evidence (personalization follows the memory switch)
      if (entry.item?.concept && d.settings?.memoryEnabled !== false) {
        d.mastery = recordEvidence(d.mastery, [{ concept: entry.item.concept, score: ratingScore(rating), source: 'review', topic: entry.lessonTitle }], t);
      }
      return d;
    });
    onXp?.();
    session.answered++;
    if (correct) session.correct++;
    session.results.push({ entry, correct, nextDue });
    updatePanel();
    return nextDue;
  }

  function feedback(card, { correct, expected, explanation, nextDue, typo, title, extra }) {
    const box = el('div', { class: `feedback ${correct ? 'ok' : 'bad'}`, role: 'status' },
      el('div', { class: 'feedback-title' }, icon(correct ? 'check' : 'x'), title || (correct ? (typo ? 'Correct (watch the spelling)' : 'Correct!') : 'Not quite')),
      !correct && expected !== '' ? el('p', null, 'Answer: ', el('strong', null, String(expected))) : null,
      explanation ? el('p', { class: 'muted' }, inlineMd(explanation)) : null,
      extra || null,
      el('p', { class: 'next-due' }, icon('clock'), `Next review ${formatDue(nextDue)}`));
    const go = () => { session.index++; show(); };
    const next = el('button', { class: 'btn btn-lg', type: 'button', onclick: go }, session.index === queue.length - 1 ? 'See results' : 'Continue', icon('arrow-right'));
    for (const r of card.querySelectorAll('.review-actions')) r.remove(); // the answer hints
    card.append(box, el('div', { class: 'review-actions' }, hint(['↵', 'continue']), next));
    keys = { enter: go, space: go };
    next.focus();
  }

  const hint = (...pairs) => el('span', { class: 'kbd-hint' }, ...pairs.flatMap(([k, label]) => [el('kbd', null, k), label]));

  function show() {
    keys = {};
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
      card.append(list, el('div', { class: 'review-actions' }, hint([`1–${choices.length}`, 'choose'])));
      [...list.children].forEach((btn, i) => { keys[String(i + 1)] = () => btn.click(); keys['abcde'[i]] = () => btn.click(); });
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
      card.append(row, el('div', { class: 'review-actions' }, hint(['T', 'true'], ['F', 'false'])));
      keys = { t: () => row.children[0].click(), f: () => row.children[1].click(), 1: () => row.children[0].click(), 2: () => row.children[1].click() };
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
    } else if (item.type === 'explain') {
      // Phase 8: free response, graded on the server against the item's rubric
      card.append(el('p', { class: 'muted small' }, 'Explain it in your own words.'), el('h2', { class: 'review-prompt' }, inlineMd(item.prompt)));
      const input = el('textarea', { class: 'explain-input', rows: '4', maxlength: '1500', placeholder: 'A few sentences is plenty.', 'aria-label': 'Your explanation' });
      const check = el('button', { class: 'btn', type: 'submit' }, 'Check my answer');
      const status = el('p', { class: 'muted small explain-status', role: 'status' });
      const form = el('form', { class: 'explain-form', onsubmit: async (e) => {
        e.preventDefault();
        if (input.value.trim().length < 12) { status.textContent = 'Write a sentence or two first.'; input.focus(); return; }
        input.disabled = true;
        check.disabled = true;
        status.textContent = 'Grading your answer…';
        try {
          const r = await postJson('/api/widget_action', { componentName: 'Review', action_type: 'practice_grade', payload: { item, answer: input.value } });
          const grade = r.result?.grade || { score: 0, criteria: [], feedback: '' };
          status.remove();
          const g = gradePracticeItem(item, grade);
          const due = record(entry, g.rating, g.correct);
          const extra = el('div', { class: 'explain-grade' },
            el('ul', { class: 'explain-criteria' }, ...(grade.criteria || []).map((c) => el('li', { class: c.met ? 'met' : '' }, icon(c.met ? 'check' : 'x'), el('span', null, c.criterion)))),
            item.sampleAnswer ? el('details', { class: 'explain-model' }, el('summary', null, 'Show a model answer'), el('p', null, inlineMd(item.sampleAnswer))) : null);
          feedback(card, { correct: g.correct, expected: '', explanation: grade.feedback, nextDue: due, title: `${GRADE_WORDS[grade.score] || ''} · ${grade.score}/3`, extra });
        } catch (err) {
          input.disabled = false;
          check.disabled = false;
          status.textContent = err.message || 'Could not grade that. Try again.';
        }
      } }, input, el('div', { class: 'review-actions' }, status, check));
      card.append(form);
      setTimeout(() => input.focus(), 30);
    } else if (isVisualItem(item)) {
      keys = visual.show(card, item, (g) => {
        const due = record(entry, g.rating, g.correct);
        feedback(card, { ...g, explanation: item.explanation, nextDue: due, title: visualFeedbackTitle(item, g) });
      }, hint);
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
        keys = {};
        [...grades.children].forEach((g, i) => { keys[String(i + 1)] = () => g.click(); });
        card.append(el('div', { class: 'flash-answer' }, inlineMd(item.back)), el('p', { class: 'muted small' }, 'How well did you remember it?'), grades);
      } }, 'Show answer');
      card.append(el('div', { class: 'review-actions' }, hint(['Space', 'show answer'], ['1–4', 'grade']), reveal));
      keys = { space: () => reveal.click(), enter: () => reveal.click() };
    }
  }

  function finish() {
    keys = {};
    const stats = deckStats(store.data.deck, new Date());
    const acc = session.answered ? Math.round((session.correct / session.answered) * 100) : 0;
    header.remove();
    panel.remove();
    wrap.classList.remove('review-layout');
    stage.replaceChildren(el('article', { class: 'card review-done' },
      el('p', { class: 'kicker' }, 'Review'),
      el('h1', { class: 'h-lg' }, session.answered ? 'Session complete' : 'Session ended'),
      el('div', { class: 'stat-row' },
        el('div', { class: 'stat' }, el('strong', null, String(session.answered)), el('span', null, 'reviewed')),
        el('div', { class: 'stat' }, el('strong', null, `${acc}%`), el('span', null, 'correct')),
        el('div', { class: 'stat' }, el('strong', null, `+${session.xp}`), el('span', null, 'XP')),
        el('div', { class: 'stat' }, el('strong', null, String(currentStreak(store.data.stats))), el('span', null, 'day streak'))),
      summary ? summary(session.results) : null,
      session.results.length ? el('ul', { class: 'next-list' }, ...session.results.slice(0, 6).map((r) => el('li', null,
        el('span', { class: `dot ${r.correct ? 'ok' : 'bad'}` }),
        el('span', { class: 'next-q' }, inlineMd(r.entry.item.prompt || r.entry.item.front)),
        el('span', { class: 'muted small' }, formatDue(r.nextDue))))) : null,
      el('p', { class: 'muted' }, stats.due ? `${stats.due} more card${stats.due === 1 ? '' : 's'} due now.` : stats.nextDue ? `Next card due ${formatDue(stats.nextDue)}.` : ''),
      el('div', { class: 'review-actions' },
        stats.due && !lessonId && !entries ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { cleanup(); renderReview(root, { store, onExit, onXp }); } }, 'Keep going') : null,
        el('button', { class: 'btn', type: 'button', onclick: onExit }, 'Done'))));
  }

  show();
  return cleanup;
}

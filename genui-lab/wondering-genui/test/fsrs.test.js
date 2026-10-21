import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fsrs,
  FSRS,
  createEmptyCard,
  Rating,
  State,
  DEFAULT_W,
  forgettingCurve,
  generatorParameters,
  ratingFromCorrect,
  getFsrsRatingFromGradingResult,
  isGradingCriterionPassed,
} from "../src/fsrs.js";

const T0 = new Date("2026-01-01T09:00:00Z");
const days = (d, n) => new Date(d.getTime() + n * 864e5);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("shipped defaults: 19 weights, retention .9, max 36500, no fuzz, short-term on", () => {
  const p = generatorParameters();
  assert.deepEqual(p.w, [...DEFAULT_W]);
  assert.equal(p.w.length, 19);
  assert.equal(p.request_retention, 0.9);
  assert.equal(p.maximum_interval, 36500);
  assert.equal(p.enable_fuzz, false);
  assert.equal(p.enable_short_term, true);
  assert.equal(new FSRS().intervalModifier, 1, "retention .9 makes interval == stability");
});

test("retrievability at t = S is 0.9, decreasing with time", () => {
  for (const s of [0.5, 3.173, 15.69, 120]) close(forgettingCurve(s, s), 0.9);
  assert.equal(forgettingCurve(0, 5), 1);
  assert.ok(forgettingCurve(10, 5) < forgettingCurve(5, 5));
  const f = fsrs({ enable_short_term: false });
  const { card } = f.next(createEmptyCard(T0), T0, Rating.Good);
  close(f.get_retrievability(card, days(T0, Math.round(card.stability))), forgettingCurve(Math.round(card.stability), card.stability));
  assert.equal(f.get_retrievability(createEmptyCard(T0), T0), 0);
});

test("initial stability/difficulty follow w[0..3] and w[4] - e^((g-1) w[5]) + 1", () => {
  const f = fsrs();
  assert.deepEqual([1, 2, 3, 4].map((g) => f.init_stability(g)), [0.40255, 1.18385, 3.173, 15.69105]);
  close(f.init_difficulty(Rating.Good), DEFAULT_W[4] - Math.exp(2 * DEFAULT_W[5]) + 1, 1e-7);
  assert.ok(f.init_difficulty(Rating.Again) > f.init_difficulty(Rating.Easy));
});

test("first Good review: 3 days (long-term), or a 10-minute learning step then ~4 days (short-term)", () => {
  const lt = fsrs({ enable_short_term: false });
  const first = lt.next(createEmptyCard(T0), T0, Rating.Good).card;
  assert.equal(first.scheduled_days, 3);
  assert.equal(first.state, State.Review);
  assert.equal(first.due.getTime(), days(T0, 3).getTime());

  const st = fsrs();
  const step = st.next(createEmptyCard(T0), T0, Rating.Good).card;
  assert.equal(step.state, State.Learning);
  assert.equal(step.scheduled_days, 0);
  assert.equal(step.due.getTime() - T0.getTime(), 10 * 6e4);
  close(step.stability, 3.173);
  const graduate = st.next(step, step.due, Rating.Good).card;
  assert.equal(graduate.state, State.Review);
  assert.equal(graduate.scheduled_days, 4);
  const easy = st.next(createEmptyCard(T0), T0, Rating.Easy).card;
  assert.equal(easy.scheduled_days, 16);
});

test("repeated Good reviews give strictly increasing intervals", () => {
  for (const f of [fsrs(), fsrs({ enable_short_term: false })]) {
    let card = createEmptyCard(T0);
    let now = T0;
    const intervals = [];
    for (let i = 0; i < 7; i++) {
      card = f.next(card, now, Rating.Good).card;
      if (card.state === State.Review) intervals.push(card.scheduled_days);
      now = card.due;
    }
    for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i] > intervals[i - 1], `intervals ${intervals}`);
    assert.ok(intervals.length >= 5);
  }
});

test("Again on a review card lowers stability, raises difficulty, counts a lapse", () => {
  const f = fsrs();
  let card = createEmptyCard(T0);
  card = f.next(card, T0, Rating.Good).card;
  card = f.next(card, card.due, Rating.Good).card;
  card = f.next(card, card.due, Rating.Good).card;
  assert.equal(card.state, State.Review);
  const before = card;
  const failed = f.next(before, before.due, Rating.Again).card;
  assert.ok(failed.stability < before.stability);
  assert.ok(failed.difficulty > before.difficulty);
  assert.equal(failed.lapses, before.lapses + 1);
  assert.equal(failed.state, State.Relearning);
  assert.equal(failed.due.getTime() - before.due.getTime(), 5 * 6e4);
});

test("repeat() previews four ordered outcomes for a review card", () => {
  const f = fsrs();
  let card = f.next(createEmptyCard(T0), T0, Rating.Good).card;
  card = f.next(card, card.due, Rating.Good).card;
  const p = f.repeat(card, card.due);
  const ivl = [Rating.Hard, Rating.Good, Rating.Easy].map((r) => p[r].card.scheduled_days);
  assert.ok(ivl[0] < ivl[1] && ivl[1] < ivl[2], `${ivl}`);
  assert.equal(p[Rating.Again].card.scheduled_days, 0);
  assert.equal(p[Rating.Good].log.rating, Rating.Good);
});

test("17-weight sets are migrated to 19", () => {
  const w17 = DEFAULT_W.slice(0, 17);
  const p = generatorParameters({ w: w17 });
  assert.equal(p.w.length, 19);
  assert.deepEqual(p.w.slice(17), [0, 0]);
});

test("rating mapping: binary Good/Again; rubric >0.7 Good, >0.3 Hard, else Again", () => {
  assert.equal(ratingFromCorrect(true), Rating.Good);
  assert.equal(ratingFromCorrect(false), Rating.Again);
  const rubric = (passed, total) => ({ criteriaResults: Array.from({ length: total }, (_, i) => ({ passed: i < passed })) });
  assert.equal(getFsrsRatingFromGradingResult(rubric(8, 10)), Rating.Good);
  assert.equal(getFsrsRatingFromGradingResult(rubric(7, 10)), Rating.Hard, "exactly 0.7 is Hard");
  assert.equal(getFsrsRatingFromGradingResult(rubric(4, 10)), Rating.Hard);
  assert.equal(getFsrsRatingFromGradingResult(rubric(3, 10)), Rating.Again, "exactly 0.3 is Again");
  assert.equal(getFsrsRatingFromGradingResult({ passed: true }), Rating.Good);
  assert.equal(getFsrsRatingFromGradingResult({ passed: false, criteriaResults: [] }), Rating.Again);
  assert.equal(isGradingCriterionPassed({ score: 3, maxPoints: 5 }), true, "0.6 x maxPoints passes");
  assert.equal(isGradingCriterionPassed({ score: 2.9, maxPoints: 5 }), false);
  assert.equal(getFsrsRatingFromGradingResult({ criteriaResults: [{ score: 6, maxPoints: 10 }, { score: 1, maxPoints: 10 }] }), Rating.Hard);
});

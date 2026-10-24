// FSRS v5 scheduler: port of the ts-fsrs build bundled at @4316800-@4332400
// (generatorParameters, FSRSAlgorithm, BasicScheduler, LongTermScheduler) with the
// shipped defaults (findings §5) and the rating mapping from @4340378. DOM-free.

export const Rating = Object.freeze({ Manual: 0, Again: 1, Hard: 2, Good: 3, Easy: 4 });
export const State = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });
export const RATING_NAMES = ["Manual", "Again", "Hard", "Good", "Easy"];
export const STATE_NAMES = ["New", "Learning", "Review", "Relearning"];
const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export const DEFAULT_REQUEST_RETENTION = 0.9;
export const DEFAULT_MAXIMUM_INTERVAL = 36500;
export const DEFAULT_W = Object.freeze([0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621]);
export const DEFAULT_ENABLE_FUZZ = false;
export const DEFAULT_ENABLE_SHORT_TERM = true;

const S_MIN = 0.01;
const S_MAX_CLAMP = 100;
const W_BOUNDS = [
  [S_MIN, S_MAX_CLAMP], [S_MIN, S_MAX_CLAMP], [S_MIN, S_MAX_CLAMP], [S_MIN, S_MAX_CLAMP],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],
  [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2],
];

export const DECAY = -0.5;
export const FACTOR = 19 / 81; // = 0.9^(1/DECAY) - 1, so R(t=S) = 0.9

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fix8 = (v) => +v.toFixed(8);

/** Port of generatorParameters (`z`), including the 17 -> 19 weight migration. */
export function generatorParameters(props = {}) {
  let w = [...DEFAULT_W];
  if (props.w) {
    if (props.w.length === 19) w = [...props.w];
    else if (props.w.length === 17) {
      w = props.w.concat([0, 0]);
      w[4] = fix8(w[5] * 2 + w[4]);
      w[5] = fix8(Math.log(w[5] * 3 + 1) / 3);
      w[6] = fix8(w[6] + 0.5);
      console.debug("[FSRS V5]auto fill w to 19 length");
    }
  }
  w = w.map((x, i) => clamp(x, W_BOUNDS[i][0], W_BOUNDS[i][1]));
  return {
    request_retention: props.request_retention || DEFAULT_REQUEST_RETENTION,
    maximum_interval: props.maximum_interval || DEFAULT_MAXIMUM_INTERVAL,
    w,
    enable_fuzz: props.enable_fuzz ?? DEFAULT_ENABLE_FUZZ,
    enable_short_term: props.enable_short_term ?? DEFAULT_ENABLE_SHORT_TERM,
  };
}

/** R(t, S) = (1 + FACTOR * t / S)^DECAY */
export function forgettingCurve(elapsedDays, stability) {
  return fix8(Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY));
}

export function dateDiffInDays(last, now) {
  if (!last || !now) throw new Error("Invalid date");
  const a = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((b - a) / 864e5);
}

const addTime = (date, amount, isDay) => new Date(date.getTime() + (isDay ? amount * 864e5 : amount * 6e4));

export function createEmptyCard(now = new Date()) {
  return { due: new Date(now), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: State.New, last_review: undefined };
}

const cloneCard = (c) => ({ ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined });

export class FSRSAlgorithm {
  constructor(params) {
    this.param = generatorParameters(params);
    this.intervalModifier = this.calculateIntervalModifier(this.param.request_retention);
  }
  calculateIntervalModifier(r) {
    if (r <= 0 || r > 1) throw new Error("Requested retention rate should be in the range (0,1]");
    return fix8((Math.pow(r, 1 / DECAY) - 1) / FACTOR);
  }
  forgetting_curve(t, s) {
    return forgettingCurve(t, s);
  }
  init_stability(g) {
    return Math.max(this.param.w[g - 1], 0.1);
  }
  init_difficulty(g) {
    return this.constrain_difficulty(this.param.w[4] - Math.exp((g - 1) * this.param.w[5]) + 1);
  }
  next_interval(s, _elapsed) {
    // enable_fuzz is false in the shipped config, so apply_fuzz == Math.round
    return Math.min(Math.max(1, Math.round(s * this.intervalModifier)), this.param.maximum_interval);
  }
  linear_damping(delta, d) {
    return fix8((delta * (10 - d)) / 9);
  }
  next_difficulty(d, g) {
    const delta = -this.param.w[6] * (g - 3);
    const next = d + this.linear_damping(delta, d);
    return this.constrain_difficulty(this.mean_reversion(this.init_difficulty(Rating.Easy), next));
  }
  constrain_difficulty(d) {
    return Math.min(Math.max(fix8(d), 1), 10);
  }
  mean_reversion(init, current) {
    return fix8(this.param.w[7] * init + (1 - this.param.w[7]) * current);
  }
  next_recall_stability(d, s, r, g) {
    const w = this.param.w;
    const hard = g === Rating.Hard ? w[15] : 1;
    const easy = g === Rating.Easy ? w[16] : 1;
    return fix8(clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, 36500));
  }
  next_forget_stability(d, s, r) {
    const w = this.param.w;
    return fix8(clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, 36500));
  }
  next_short_term_stability(s, g) {
    const w = this.param.w;
    return fix8(clamp(s * Math.exp(w[17] * (g - 3 + w[18])), S_MIN, 36500));
  }
}

class AbstractScheduler {
  constructor(card, now, algorithm) {
    this.algorithm = algorithm;
    this.last = cloneCard(card);
    this.current = cloneCard(card);
    this.review_time = new Date(now);
    this.next = new Map();
    const { state, last_review } = this.current;
    let elapsed = 0;
    if (state !== State.New && last_review) elapsed = dateDiffInDays(last_review, this.review_time);
    this.current.last_review = this.review_time;
    this.current.elapsed_days = elapsed;
    this.current.reps += 1;
  }
  preview() {
    return Object.fromEntries(GRADES.map((g) => [g, this.review(g)]));
  }
  review(g) {
    let out;
    switch (this.last.state) {
      case State.New:
        out = this.newState(g);
        break;
      case State.Learning:
      case State.Relearning:
        out = this.learningState(g);
        break;
      case State.Review:
        out = this.reviewState(g);
        break;
    }
    if (out) return out;
    throw new Error("Invalid grade");
  }
  buildLog(rating) {
    const { last_review, due, elapsed_days } = this.last;
    return {
      rating,
      state: this.current.state,
      due: last_review || due,
      stability: this.current.stability,
      difficulty: this.current.difficulty,
      elapsed_days: this.current.elapsed_days,
      last_elapsed_days: elapsed_days,
      scheduled_days: this.current.scheduled_days,
      review: this.review_time,
    };
  }
}

/** Short-term enabled scheduler (ts-fsrs BasicScheduler `V`): learning steps 1/5/10 min. */
export class BasicScheduler extends AbstractScheduler {
  newState(g) {
    if (this.next.has(g)) return this.next.get(g);
    const c = cloneCard(this.current);
    c.difficulty = this.algorithm.init_difficulty(g);
    c.stability = this.algorithm.init_stability(g);
    switch (g) {
      case Rating.Again:
        c.scheduled_days = 0;
        c.due = addTime(this.review_time, 1, false);
        c.state = State.Learning;
        break;
      case Rating.Hard:
        c.scheduled_days = 0;
        c.due = addTime(this.review_time, 5, false);
        c.state = State.Learning;
        break;
      case Rating.Good:
        c.scheduled_days = 0;
        c.due = addTime(this.review_time, 10, false);
        c.state = State.Learning;
        break;
      case Rating.Easy: {
        const ivl = this.algorithm.next_interval(c.stability, this.current.elapsed_days);
        c.scheduled_days = ivl;
        c.due = addTime(this.review_time, ivl, true);
        c.state = State.Review;
        break;
      }
      default:
        throw new Error("Invalid grade");
    }
    const out = { card: c, log: this.buildLog(g) };
    this.next.set(g, out);
    return out;
  }
  learningState(g) {
    if (this.next.has(g)) return this.next.get(g);
    const { state, difficulty, stability } = this.last;
    const c = cloneCard(this.current);
    const elapsed = this.current.elapsed_days;
    c.difficulty = this.algorithm.next_difficulty(difficulty, g);
    c.stability = this.algorithm.next_short_term_stability(stability, g);
    switch (g) {
      case Rating.Again:
        c.scheduled_days = 0;
        c.due = addTime(this.review_time, 5, false);
        c.state = state;
        break;
      case Rating.Hard:
        c.scheduled_days = 0;
        c.due = addTime(this.review_time, 10, false);
        c.state = state;
        break;
      case Rating.Good: {
        const ivl = this.algorithm.next_interval(c.stability, elapsed);
        c.scheduled_days = ivl;
        c.due = addTime(this.review_time, ivl, true);
        c.state = State.Review;
        break;
      }
      case Rating.Easy: {
        const goodS = this.algorithm.next_short_term_stability(stability, Rating.Good);
        const goodIvl = this.algorithm.next_interval(goodS, elapsed);
        const ivl = Math.max(this.algorithm.next_interval(c.stability, elapsed), goodIvl + 1);
        c.scheduled_days = ivl;
        c.due = addTime(this.review_time, ivl, true);
        c.state = State.Review;
        break;
      }
      default:
        throw new Error("Invalid grade");
    }
    const out = { card: c, log: this.buildLog(g) };
    this.next.set(g, out);
    return out;
  }
  reviewState(g) {
    if (this.next.has(g)) return this.next.get(g);
    const elapsed = this.current.elapsed_days;
    const { difficulty: d, stability: s } = this.last;
    const r = this.algorithm.forgetting_curve(elapsed, s);
    const [again, hard, good, easy] = GRADES.map(() => cloneCard(this.current));
    const w = this.algorithm.param.w;
    again.difficulty = this.algorithm.next_difficulty(d, Rating.Again);
    again.stability = clamp(fix8(s / Math.exp(w[17] * w[18])), S_MIN, this.algorithm.next_forget_stability(d, s, r));
    hard.difficulty = this.algorithm.next_difficulty(d, Rating.Hard);
    hard.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Hard);
    good.difficulty = this.algorithm.next_difficulty(d, Rating.Good);
    good.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Good);
    easy.difficulty = this.algorithm.next_difficulty(d, Rating.Easy);
    easy.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Easy);
    let hIvl = this.algorithm.next_interval(hard.stability, elapsed);
    let gIvl = this.algorithm.next_interval(good.stability, elapsed);
    hIvl = Math.min(hIvl, gIvl);
    gIvl = Math.max(gIvl, hIvl + 1);
    const eIvl = Math.max(this.algorithm.next_interval(easy.stability, elapsed), gIvl + 1);
    again.scheduled_days = 0;
    again.due = addTime(this.review_time, 5, false);
    hard.scheduled_days = hIvl;
    hard.due = addTime(this.review_time, hIvl, true);
    good.scheduled_days = gIvl;
    good.due = addTime(this.review_time, gIvl, true);
    easy.scheduled_days = eIvl;
    easy.due = addTime(this.review_time, eIvl, true);
    again.state = State.Relearning;
    hard.state = good.state = easy.state = State.Review;
    again.lapses += 1;
    this.next.set(Rating.Again, { card: again, log: this.buildLog(Rating.Again) });
    this.next.set(Rating.Hard, { card: hard, log: this.buildLog(Rating.Hard) });
    this.next.set(Rating.Good, { card: good, log: this.buildLog(Rating.Good) });
    this.next.set(Rating.Easy, { card: easy, log: this.buildLog(Rating.Easy) });
    return this.next.get(g);
  }
}

/** Long-term-only scheduler (ts-fsrs LongTermScheduler `B`), used when enable_short_term=false. */
export class LongTermScheduler extends AbstractScheduler {
  newState(g) {
    if (this.next.has(g)) return this.next.get(g);
    this.current.scheduled_days = 0;
    this.current.elapsed_days = 0;
    const cards = GRADES.map(() => cloneCard(this.current));
    GRADES.forEach((gr, i) => {
      cards[i].difficulty = this.algorithm.init_difficulty(gr);
      cards[i].stability = this.algorithm.init_stability(gr);
    });
    this.#intervals(cards, 0);
    this.#store(cards);
    return this.next.get(g);
  }
  learningState(g) {
    return this.reviewState(g);
  }
  reviewState(g) {
    if (this.next.has(g)) return this.next.get(g);
    const elapsed = this.current.elapsed_days;
    const { difficulty: d, stability: s } = this.last;
    const r = this.algorithm.forgetting_curve(elapsed, s);
    const cards = GRADES.map(() => cloneCard(this.current));
    const [again, hard, good, easy] = cards;
    again.difficulty = this.algorithm.next_difficulty(d, Rating.Again);
    again.stability = clamp(s, S_MIN, this.algorithm.next_forget_stability(d, s, r));
    hard.difficulty = this.algorithm.next_difficulty(d, Rating.Hard);
    hard.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Hard);
    good.difficulty = this.algorithm.next_difficulty(d, Rating.Good);
    good.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Good);
    easy.difficulty = this.algorithm.next_difficulty(d, Rating.Easy);
    easy.stability = this.algorithm.next_recall_stability(d, s, r, Rating.Easy);
    this.#intervals(cards, elapsed);
    again.lapses += 1;
    this.#store(cards);
    return this.next.get(g);
  }
  #intervals([again, hard, good, easy], elapsed) {
    let a = this.algorithm.next_interval(again.stability, elapsed);
    let hh = this.algorithm.next_interval(hard.stability, elapsed);
    let gg = this.algorithm.next_interval(good.stability, elapsed);
    let e = this.algorithm.next_interval(easy.stability, elapsed);
    a = Math.min(a, hh);
    hh = Math.max(hh, a + 1);
    gg = Math.max(gg, hh + 1);
    e = Math.max(e, gg + 1);
    [[again, a], [hard, hh], [good, gg], [easy, e]].forEach(([c, ivl]) => {
      c.scheduled_days = ivl;
      c.due = addTime(this.review_time, ivl, true);
      c.state = State.Review;
    });
  }
  #store(cards) {
    GRADES.forEach((g, i) => this.next.set(g, { card: cards[i], log: this.buildLog(g) }));
  }
}

export class FSRS extends FSRSAlgorithm {
  constructor(params) {
    super(params);
    this.Scheduler = this.param.enable_short_term ? BasicScheduler : LongTermScheduler;
  }
  /** Preview all four outcomes: {1:{card,log},2:…,3:…,4:…} */
  repeat(card, now) {
    return new this.Scheduler(card, now, this).preview();
  }
  next(card, now, grade) {
    if (grade === Rating.Manual) throw new Error("Cannot review a manual rating");
    return new this.Scheduler(card, now, this).review(grade);
  }
  get_retrievability(card, now = new Date()) {
    if (card.state === State.New) return 0;
    const t = Math.max(dateDiffInDays(card.last_review, now), 0);
    return this.forgetting_curve(t, fix8(card.stability));
  }
}

/** `fsrsInstance = nt()` in the bundle: defaults, no per-user optimisation. */
export function fsrs(params) {
  return new FSRS(params);
}

// ============================================================ rating mapping (@4338581-@4340378)

/** Binary correct/incorrect practice -> Good / Again. */
export function ratingFromCorrect(correct) {
  return correct ? Rating.Good : Rating.Again;
}

export function isGradingCriterionPassed(c) {
  if (typeof c.passed === "boolean") return c.passed;
  return typeof c.score === "number" && typeof c.maxPoints === "number" ? c.score >= c.maxPoints * 0.6 : false;
}

export function getPassedCriteriaCount(result) {
  const list = result.criteriaResults ?? [];
  return list.length === 0 ? (result.passed ? 1 : 0) : list.filter(isGradingCriterionPassed).length;
}

/** Rubric-graded answers: passedRatio > .7 Good, > .3 Hard, else Again. */
export function getFsrsRatingFromGradingResult(result) {
  const list = result.criteriaResults ?? [];
  if (list.length === 0) return result.passed ? Rating.Good : Rating.Again;
  const ratio = getPassedCriteriaCount(result) / list.length;
  return ratio > 0.7 ? Rating.Good : ratio > 0.3 ? Rating.Hard : Rating.Again;
}

export const VISUAL_FSRS_RATINGS = Object.freeze({ good: Rating.Good, hard: Rating.Hard, again: Rating.Again });

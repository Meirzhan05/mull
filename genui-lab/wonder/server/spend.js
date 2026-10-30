// What Claude costs this server, across every user: each response's token usage (claude.js
// reportUsage) is priced and added to today's total in the database, and once the total reaches
// WONDER_DAILY_BUDGET_USD no new Claude request starts until midnight UTC. The per-user caps
// (server/usage.js) bound one account; this bounds all of them, sign-ups included.
import { usageDay, hoursLeft } from './usage.js';

/**
 * USD per million tokens, Claude API list prices (October 2026). Cache writes are the 5-minute
 * kind (1.25x input). Haiku has a second rate card for prompts over 100K tokens (`long`).
 * An unknown model is priced as Opus, so the ceiling never undercounts.
 */
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
});
export const SEARCH_USD = 0.01; // web search: $10 per 1,000
export const DEFAULT_DAILY_BUDGET_USD = 50;
const LONG_PROMPT = 100_000;

/** Dollars for one reportUsage entry ({model, input, cacheRead, cacheWrite, output, searches}). */
export function usageCost(e) {
  const base = PRICES[e.model] || PRICES['claude-opus-5-5'];
  const p = base.long && (e.input || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0) > LONG_PROMPT ? base.long : base;
  return ((e.input || 0) * p.input + (e.cacheRead || 0) * p.cacheRead + (e.cacheWrite || 0) * p.cacheWrite + (e.output || 0) * p.output) / 1e6 + (e.searches || 0) * SEARCH_USD;
}

/** WONDER_DAILY_BUDGET_USD: dollars a day for all users together; `off` (or a negative) for none. */
export function dailyBudget(env = process.env) {
  const v = String(env.WONDER_DAILY_BUDGET_USD ?? '').trim().toLowerCase();
  if (!v) return DEFAULT_DAILY_BUDGET_USD;
  if (v === 'off') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) ? (n < 0 ? Infinity : n) : DEFAULT_DAILY_BUDGET_USD;
}

/** The 429 body once today's budget is spent. `limited` tells the browser not to retry. */
export function budgetBody(now = Date.now()) {
  const { resetsAt } = usageDay(now);
  return {
    ok: false,
    error: `Mull has reached its limit for today across everyone, so new lessons and replies are paused. They're back ${hoursLeft(resetsAt - now)} (midnight UTC).`,
    limited: { kind: 'budget', max: null, resetsAt: new Date(resetsAt).toISOString() },
  };
}

/**
 * The server-wide ceiling. `record(entry)` adds a response's cost to today's total and returns the
 * write (it never rejects; a failure is logged), which the request waits for before its response
 * ends, as a serverless function may be frozen after that. `reached()` says whether today's total
 * is at the budget. It is read from the database at most every `cacheMs` per instance, plus what
 * this instance spent since, so requests already running when the budget is reached still finish
 * (the overshoot is those requests). A failed read throws: the caller refuses the request rather
 * than spend blind.
 */
export function createSpendGuard({ db, budgetUsd = dailyBudget(), now = () => Date.now(), cacheMs = 15_000, logger = console } = {}) {
  let cached = null; // {day, usd, at}
  let local = 0; // USD this instance has recorded, ever: what a read in flight may have missed
  return {
    budgetUsd,
    record(entry) {
      if (budgetUsd === Infinity) return null;
      const usd = usageCost(entry);
      if (!(usd > 0)) return null;
      const { day } = usageDay(now());
      local += usd;
      if (cached?.day === day) cached.usd += usd;
      return db.addSpend(day, Math.round(usd * 1e6)).catch((e) => logger.warn?.(`[wonder] spend not recorded: ${e.message}`));
    },
    async reached() {
      if (budgetUsd === Infinity) return false;
      const t = now();
      const { day } = usageDay(t);
      if (!cached || cached.day !== day || t - cached.at >= cacheMs) {
        const mark = local;
        const usd = (await db.spendToday(day)) / 1e6;
        // spend recorded during the read may be missing from it: count it (at worst twice, never not at all)
        cached = { day, usd: usd + (local - mark), at: t };
      }
      return cached.usd >= budgetUsd;
    },
  };
}

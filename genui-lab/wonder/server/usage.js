// Who may spend Claude, and how much. With accounts on (server/sync/), every route that calls
// Claude needs a signed-in user, and each user has daily caps per kind of call so one person
// cannot run up the server's Anthropic bill. Counts live in the sync database
// (useQuota in memory-db.js / pg-db.js), so they hold across serverless instances. Days are UTC.
//
// Limits apply only in Claude mode (demo mode costs nothing) and only with accounts on; a local
// single-user Wonder without accounts is unchanged. Override a cap with WONDER_LIMIT_<KIND>
// (e.g. WONDER_LIMIT_LESSON=50); "off" or a negative number removes it, 0 blocks the kind.
// Pro users (server/plans.js) get the higher Pro caps instead, overridden with
// WONDER_PRO_LIMIT_<KIND>.

/** Default daily caps per Free user. */
export const DEFAULT_LIMITS = Object.freeze({
  lesson: 20, // POST /api/lesson/stream: new lessons, steers, resumes and revisions
  tutor: 100, // POST /api/tutor/stream
  teacher: 60, // POST /api/teacher/stream
  course: 10, // POST /api/course/plan
  extract: 60, // POST /api/practice/extract and /api/memory/extract (after each lesson)
  grade: 150, // free-response grading (widget action explain_grade)
});

/** Default daily caps per Pro user. */
export const DEFAULT_PRO_LIMITS = Object.freeze({ lesson: 100, tutor: 500, teacher: 300, course: 50, extract: 300, grade: 750 });

const NOUN = { lesson: 'lessons', tutor: 'tutor messages', teacher: 'Teacher messages', course: 'course plans', extract: 'card and memory extractions', grade: 'graded answers' };

/** Routes that call Claude. A function decides from the body (widget actions vary). */
const CLAUDE_ROUTES = {
  'POST /api/lesson/stream': 'lesson',
  'POST /api/tutor/stream': 'tutor',
  'POST /api/teacher/stream': 'teacher',
  'POST /api/course/plan': 'course',
  'POST /api/practice/extract': 'extract',
  'POST /api/memory/extract': 'extract',
  'POST /api/widget_action': (body) => (body?.action_type === 'explain_grade' ? 'grade' : null),
};

/** The usage kind a request spends, or null when it does not call Claude. */
export function usageKind(method, pathname, body) {
  const k = CLAUDE_ROUTES[`${method} ${pathname}`];
  return typeof k === 'function' ? k(body) : k || null;
}

/** A plan's daily caps: defaults with WONDER_LIMIT_<KIND> (Free) or WONDER_PRO_LIMIT_<KIND> (Pro) overrides. Infinity means no cap. */
export function usageLimits(env = process.env, plan = 'free') {
  const out = {};
  const pro = plan === 'pro';
  for (const [kind, def] of Object.entries(pro ? DEFAULT_PRO_LIMITS : DEFAULT_LIMITS)) {
    const raw = env[`WONDER_${pro ? 'PRO_' : ''}LIMIT_${kind.toUpperCase()}`];
    if (raw == null || String(raw).trim() === '') { out[kind] = def; continue; }
    const s = String(raw).trim().toLowerCase();
    const n = Number(s);
    out[kind] = s === 'off' || (Number.isFinite(n) && n < 0) ? Infinity : Number.isInteger(n) ? n : def;
  }
  return out;
}

/** The UTC day a request counts against, and when that day ends. */
export function usageDay(now = Date.now()) {
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);
  const resetsAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return { day, resetsAt };
}

export const RETRY_FREE = 2;
export const RETRY_WINDOW_MS = 10 * 60 * 1000;

const hoursLeft = (ms) => { const h = Math.ceil(ms / 3_600_000); return h <= 1 ? 'within the hour' : `in about ${h} hours`; };

/**
 * The 429 body for a used-up cap. `limited` tells the browser not to retry. `units` > 1: the
 * request counted as several (a lesson from a long material, server/materials.js materialCharge).
 */
export function limitBody(kind, max, now = Date.now(), { plan = 'free', units = 1 } = {}) {
  const { resetsAt } = usageDay(now);
  const what = NOUN[kind] || 'requests';
  const more = `More ${hoursLeft(resetsAt - now)} (midnight UTC).`;
  const error = max === 0
    ? `${what[0].toUpperCase()}${what.slice(1)} are turned off on this server.`
    : units > 1
      ? `Your material is long, so each one taught from it counts as ${units} of today's ${max} ${what}, and not enough are left. ${more}`
      : `You've used today's ${max} ${what}. ${more}`;
  return { ok: false, error, limited: { kind, max, plan, resetsAt: new Date(resetsAt).toISOString() } };
}

/**
 * Per-user spending gate. `charge(userId, kind, {retryKey, units, plan})` resolves {ok:true} or
 * {ok:false, body} (send it with HTTP 429). `plan` ('free' or 'pro') picks `limits` or `proLimits`. The browser retries a dropped stream with the same
 * retryKey, so up to RETRY_FREE retries within RETRY_WINDOW_MS of a charged request are free;
 * any reuse beyond that is charged like a new request (a reused key is not a free pass).
 */
export function createUsageGate({ db, limits = usageLimits(), proLimits = limits, now = () => Date.now(), logger = console } = {}) {
  const capsFor = (plan) => (plan === 'pro' ? proLimits : limits);
  const recent = new Map(); // `${userId}|${kind}|${retryKey}` -> {at, free}, best effort per instance
  const RECENT_MAX = 2000;
  return {
    limits,
    proLimits,
    async charge(userId, kind, { retryKey, units = 1, plan = 'free' } = {}) {
      const max = capsFor(plan)[kind];
      if (max === undefined || max === Infinity) return { ok: true };
      const t = now();
      const { day } = usageDay(t);
      if (max <= 0) return { ok: false, body: limitBody(kind, 0, t, { plan }) };
      const rk = retryKey ? `${userId}|${kind}|${retryKey}` : null;
      const prev = rk ? recent.get(rk) : null;
      if (prev && t - prev.at < RETRY_WINDOW_MS && prev.free < RETRY_FREE) { prev.free++; return { ok: true, retried: true }; }
      let r;
      try {
        r = await db.useQuota(userId, day, kind, max, units);
      } catch (e) {
        // fail open: a database hiccup should not lock everyone out; the miss is logged
        logger.warn?.(`[wonder] usage count failed (${kind}): ${e.message}`);
        return { ok: true };
      }
      if (!r.ok) return { ok: false, body: limitBody(kind, max, t, { plan, units }) };
      if (rk) {
        recent.delete(rk);
        recent.set(rk, { at: t, free: 0 });
        while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
      }
      return { ok: true, used: r.used };
    },
    /** Today's counts for one user on their plan (the You page); `unlimited`: no caps (admins). */
    async today(userId, plan = 'free', { unlimited = false } = {}) {
      const { day, resetsAt } = usageDay(now());
      const used = await db.quotaUsed(userId, day).catch(() => ({}));
      return { day, plan, resetsAt: new Date(resetsAt).toISOString(), kinds: Object.fromEntries(Object.entries(capsFor(plan)).map(([k, max]) => [k, { used: used[k] || 0, max: unlimited || max === Infinity ? null : max }])) };
    },
  };
}

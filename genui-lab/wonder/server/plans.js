// Free and Pro plans (accounts on). Every signed-in user is on Free unless their plan record says
// Pro and is in good standing, or the server comps them with WONDER_PRO_USERS. The plan only
// picks which daily caps apply (server/usage.js); nothing else in the app changes with it.
// Admins (WONDER_ADMIN_USERS) show as Pro and have no daily caps at all.
//
// Pro is bought through Polar (server/billing.js), whose webhooks write plan records with
// setPlan(). The record is provider-neutral, so another provider could write it too.

export const PLAN_IDS = Object.freeze(['free', 'pro']);
export const PLAN_NAMES = Object.freeze({ free: 'Free', pro: 'Pro' });
/** Subscription states that keep Pro. past_due keeps it while the provider retries the card. */
export const GOOD_STANDING = Object.freeze(['active', 'trialing', 'past_due']);
export const PLAN_STATUSES = Object.freeze([...GOOD_STANDING, 'canceled', 'unpaid', 'incomplete', 'expired', 'paused']);
/** Pro outlasts its period end by this much, so a late renewal webhook never drops a payer to Free. */
export const PERIOD_GRACE_MS = 3 * 24 * 3600_000;

const userList = (v) => new Set(String(v || '').split(/[\s,]+/).filter(Boolean));

/** User ids comped to Pro (WONDER_PRO_USERS, comma or space separated). */
export function compedUsers(env = process.env) {
  return userList(env.WONDER_PRO_USERS);
}

/** Admin user ids (WONDER_ADMIN_USERS, comma or space separated): Pro, with no daily caps. */
export function adminUsers(env = process.env) {
  return userList(env.WONDER_ADMIN_USERS);
}

/**
 * A plan record as stored, from any provider's data. Throws on a plan or status it does not know.
 * {plan, status, provider, customerId, subscriptionId, periodEnd (ms or null), cancelAtPeriodEnd,
 * syncedAt}. syncedAt (ms or null) is when the provider was read: a write older than the stored
 * one is dropped, so of two webhooks handled at once the later read wins.
 */
export function cleanPlanRecord(r) {
  if (!PLAN_IDS.includes(r?.plan)) throw new Error(`Unknown plan: ${r?.plan}`);
  if (!PLAN_STATUSES.includes(r.status)) throw new Error(`Unknown plan status: ${r.status}`);
  const id = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const ms = (v) => { const n = v == null ? NaN : Number(new Date(v)); return Number.isFinite(n) ? n : null; };
  return {
    plan: r.plan,
    status: r.status,
    provider: id(r.provider),
    customerId: id(r.customerId),
    subscriptionId: id(r.subscriptionId),
    periodEnd: ms(r.periodEnd),
    cancelAtPeriodEnd: !!r.cancelAtPeriodEnd,
    syncedAt: ms(r.syncedAt),
  };
}

/** 'pro' or 'free' for a stored record (or none) at time `now`. */
export function effectivePlan(record, { now = Date.now(), comped = false } = {}) {
  if (comped) return 'pro';
  if (record?.plan !== 'pro' || !GOOD_STANDING.includes(record.status)) return 'free';
  return record.periodEnd == null || record.periodEnd + PERIOD_GRACE_MS > now ? 'pro' : 'free';
}

/**
 * Plans for signed-in users, over the sync database (getPlan/setPlan in memory-db.js / pg-db.js).
 * planOf never throws: a database error is logged and counts as Free.
 */
export function createPlans({ db, env = process.env, now = () => Date.now(), logger = console } = {}) {
  const admins = adminUsers(env);
  const comped = new Set([...compedUsers(env), ...admins]);
  async function record(userId) {
    try {
      return await db.getPlan(userId);
    } catch (e) {
      logger.warn?.(`[wonder] plan lookup failed: ${e.message}`);
      return null;
    }
  }
  return {
    /** The stored record (or null); unlike the rest, a database error throws. */
    stored: (userId) => db.getPlan(userId),
    /** The stored record, or null on a database error (logged). */
    record,
    /** Admins skip the daily caps (server/usage.js) entirely. */
    isAdmin: (userId) => admins.has(userId),
    /** Just the plan id, for the usage gate. */
    async planId(userId) {
      if (comped.has(userId)) return 'pro';
      return effectivePlan(await record(userId), { now: now() });
    },
    /** What the You page shows; `stored` is the record when the caller already read it. */
    async describe(userId, stored) {
      const r = comped.has(userId) ? null : stored !== undefined ? stored : await record(userId);
      const id = effectivePlan(r, { now: now(), comped: comped.has(userId) });
      return {
        id,
        name: PLAN_NAMES[id],
        source: admins.has(userId) ? 'admin' : comped.has(userId) ? 'comped' : id === 'pro' ? 'subscription' : null,
        status: id === 'pro' && r ? r.status : null,
        renewsAt: id === 'pro' && r?.periodEnd && !r.cancelAtPeriodEnd ? new Date(r.periodEnd).toISOString() : null,
        endsAt: id === 'pro' && r?.periodEnd && r.cancelAtPeriodEnd ? new Date(r.periodEnd).toISOString() : null,
      };
    },
    /** Store a user's plan (a provider webhook). False when a newer read is already stored. */
    async setPlan(userId, rec) {
      return (await db.setPlan(userId, cleanPlanRecord(rec))) !== false;
    },
  };
}

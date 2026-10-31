// Pro subscriptions through Polar (polar.sh), the merchant of record: Polar sells the
// subscription, charges sales tax and VAT, and pays the seller out. Wonder only sends a signed-in
// user to Polar's hosted checkout, opens Polar's customer portal to manage or cancel, and turns
// Polar's subscription webhooks into plan records (server/plans.js setPlan).
//
// Off unless POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET and POLAR_PRODUCT_ID are all set (a checkout
// without the webhook would take money and never grant Pro). POLAR_SERVER picks the API:
// "sandbox" (the default, test cards only) or "production".
//
// The checkout carries the user id as Polar's external customer id, so every subscription event
// names its user (customer.external_id, or the metadata it carries). Events can arrive late, twice
// or out of order, so an event only says which user to look at: their subscriptions are read from
// Polar as they are now and the best one becomes the plan record, versioned by Polar's own change
// times so an older read never overwrites a newer one. A user with two subscriptions stays Pro
// while either is live. The same sync runs when the browser comes back from checkout
// (POST /api/billing/sync), so a late or lost webhook never leaves a payer on Free.
//
// POLAR_PRODUCT_ID may list several products (comma separated): the first is the one checkout
// sells, and a subscription to any of them is Pro (a yearly price, or one a user switched to).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GOOD_STANDING } from './plans.js';

export const POLAR_API = Object.freeze({ sandbox: 'https://sandbox-api.polar.sh/v1', production: 'https://api.polar.sh/v1' });
/** Polar's dated API version, pinned so a new "current" version cannot change these calls. */
export const POLAR_VERSION = '2026-10';
/** Webhook timestamps further than this from now are refused (Standard Webhooks replay window). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
const PRICE_TTL_MS = 60 * 60_000;
/** How long GET /api/account waits for a first price label before answering without one. */
const PRICE_WAIT_MS = 1500;

/** Polar settings from the environment, or null when billing is off. */
export function polarConfig(env = process.env) {
  const v = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const token = v('POLAR_ACCESS_TOKEN');
  const webhookSecret = v('POLAR_WEBHOOK_SECRET');
  const productIds = (v('POLAR_PRODUCT_ID') || '').split(/[\s,]+/).filter(Boolean);
  if (!token || !webhookSecret || !productIds.length) return null;
  const server = v('POLAR_SERVER')?.toLowerCase() === 'production' ? 'production' : 'sandbox';
  return { token, webhookSecret, productId: productIds[0], productIds, server, apiBase: POLAR_API[server] };
}

/**
 * HMAC keys a Polar webhook secret may sign with: secrets made since 2026-09-08 follow Standard
 * Webhooks (base64 after "whsec_"); older ones sign with the secret's own UTF-8 bytes. Both are
 * tried, as Polar's SDKs do.
 */
function webhookKeys(secret) {
  const keys = [Buffer.from(secret, 'utf8')];
  if (secret.startsWith('whsec_')) {
    const b = Buffer.from(secret.slice(6), 'base64');
    if (b.length) keys.unshift(b);
  }
  return keys;
}

/**
 * Check a webhook's Standard Webhooks signature over its raw body.
 * @param {string} raw the body exactly as received
 * @param {(name: string) => string|null|undefined} header request header lookup
 * @returns {boolean}
 */
export function verifyWebhook(raw, header, secret, now = Date.now()) {
  const id = header('webhook-id');
  const ts = header('webhook-timestamp');
  const sigs = header('webhook-signature');
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(now - Number(ts) * 1000) > WEBHOOK_TOLERANCE_MS) return false;
  const given = String(sigs).split(' ').map((s) => s.split(',')).filter(([v, sig]) => v === 'v1' && sig).map(([, sig]) => Buffer.from(sig, 'base64'));
  const content = `${id}.${ts}.${raw}`;
  return webhookKeys(secret).some((key) => {
    const want = createHmac('sha256', key).update(content).digest();
    return given.some((g) => g.length === want.length && timingSafeEqual(g, want));
  });
}

/** Subscription statuses that are over: nothing more will be charged. */
export const ENDED = Object.freeze(['canceled', 'incomplete_expired']);
/** Statuses that count as already subscribed (checkout refuses a second one). */
const SUBSCRIBED = Object.freeze([...GOOD_STANDING, 'paused']);

/** Polar subscription statuses as plan statuses (server/plans.js PLAN_STATUSES). */
const STATUS = { incomplete: 'incomplete', incomplete_expired: 'expired', trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'unpaid', paused: 'paused' };

/** A plan record from a Polar subscription object. */
export function planFromSubscription(sub) {
  return {
    plan: 'pro',
    status: STATUS[sub.status] || 'canceled',
    provider: 'polar',
    customerId: sub.customer_id || sub.customer?.id || null,
    subscriptionId: sub.id,
    periodEnd: sub.ended_at || sub.current_period_end || null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

const time = (v) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : 0; };

/**
 * The subscription that decides a user's plan: a live one (renewing first, then latest period
 * end), else the most recently changed one. Null for none.
 */
export function bestSubscription(subs) {
  // a renewing one before one set to cancel, then the latest period end
  const live = subs.filter((s) => GOOD_STANDING.includes(s.status))
    .sort((a, b) => (a.cancel_at_period_end ? 1 : 0) - (b.cancel_at_period_end ? 1 : 0) || time(b.current_period_end) - time(a.current_period_end));
  if (live.length) return live[0];
  return [...subs].sort((a, b) => time(b.modified_at || b.created_at) - time(a.modified_at || a.created_at))[0] || null;
}

/**
 * A Polar error that retrying cannot fix: a 4xx about the request itself. 401/403 (a bad or
 * under-scoped token) and 429 are retried, since fixing the token or waiting does fix them.
 */
const permanent = (e) => e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status);

/** "$8 / month" style label for a Polar product's first fixed price, or null. */
export function priceLabel(product) {
  const p = (product?.prices || []).find((x) => x.amount_type === 'fixed' && !x.is_archived);
  if (!p || !Number.isFinite(p.price_amount)) return null;
  let amount;
  try {
    amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: String(p.price_currency || 'usd').toUpperCase(), minimumFractionDigits: p.price_amount % 100 ? 2 : 0 }).format(p.price_amount / 100);
  } catch {
    return null;
  }
  const n = product.recurring_interval_count > 1 ? `${product.recurring_interval_count} ` : '';
  return product.recurring_interval ? `${amount} / ${n}${product.recurring_interval}${n ? 's' : ''}` : amount;
}

/**
 * Billing over Polar for one server.
 * @param {{config: ReturnType<typeof polarConfig>, plans: ReturnType<import('./plans.js').createPlans>, fetch?: typeof fetch, now?: () => number, logger?: Console}} opts
 */
export function createPolarBilling({ config, plans, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console }) {
  async function api(method, path, body) {
    const res = await fetchImpl(`${config.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, 'Polar-Version': POLAR_VERSION, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`Polar ${method} ${path.split('?')[0]} failed (${res.status})`), { status: res.status, detail: data });
    return data;
  }

  const isPro = (sub) => config.productIds.includes(sub.product_id);
  const namesUser = (sub, userId) => sub?.customer?.external_id === userId || sub?.metadata?.wonderUserId === userId;

  /** One subscription by id, or null when Polar has no such one (or it is not this user's). */
  async function subscription(id, userId) {
    try {
      const sub = await api('GET', `/subscriptions/${encodeURIComponent(id)}`);
      return namesUser(sub, userId) ? sub : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Every subscription of this user: those under their external customer id, plus `extraIds`
   * (the stored one, the one an event named) when they name the user only in their metadata,
   * as when checkout linked an existing Polar customer that has no external id.
   */
  async function userSubscriptions(userId, extraIds = []) {
    const out = new Map();
    for (let page = 1, max = 1; page <= max && page <= 10; page++) {
      let r;
      try {
        r = await api('GET', `/subscriptions/?external_customer_id=${encodeURIComponent(userId)}&limit=100&page=${page}`);
      } catch (e) {
        if (e.status === 404 && page === 1) break; // no Polar customer with this id yet
        throw e;
      }
      for (const sub of r?.items || []) out.set(sub.id, sub);
      max = r?.pagination?.max_page || 1;
    }
    for (const id of new Set(extraIds.filter(Boolean))) {
      if (out.has(id)) continue;
      const sub = await subscription(id, userId);
      if (sub) out.set(sub.id, sub);
    }
    return [...out.values()];
  }

  // the price is only a button label: a cold cache waits briefly, a stale one refreshes behind
  let price = { label: null, at: -Infinity };
  let pricePending = null;
  const refreshPrice = () => (pricePending ??= api('GET', `/products/${encodeURIComponent(config.productId)}`)
    .then((p) => { price = { label: priceLabel(p), at: now() }; })
    .catch((e) => {
      logger.warn?.(`[wonder] Pro price lookup failed: ${e.message}`);
      price = { label: price.label, at: now() - PRICE_TTL_MS + 60_000 }; // try again in a minute
    })
    .finally(() => { pricePending = null; }));
  async function currentPrice() {
    if (now() - price.at >= PRICE_TTL_MS) {
      const p = refreshPrice();
      if (price.label == null) await Promise.race([p, new Promise((r) => setTimeout(r, PRICE_WAIT_MS).unref?.())]);
    }
    return price.label;
  }

  /**
   * Store the user's plan from their subscriptions as Polar has them now; resolves whether it
   * stored. A user with no record and only ended subscriptions is left alone (a deleted account is
   * not brought back by the cancellation its deletion caused).
   */
  async function syncUser(userId, { eventId = null } = {}) {
    const prev = await plans.stored(userId);
    const all = await userSubscriptions(userId, [eventId, prev?.provider === 'polar' ? prev.subscriptionId : null]);
    // the version of this read: Polar's latest change time, so no instance clock decides which of
    // two reads is newer (with nothing listed, now: a customer deleted since)
    const changed = Math.max(0, ...all.map((sub) => time(sub.modified_at || sub.created_at)));
    const syncedAt = changed || now();
    const best = bestSubscription(all.filter(isPro));
    if (!best) {
      // every Pro subscription is gone (or moved off Pro): a stored live one has ended
      if (prev?.provider !== 'polar' || !GOOD_STANDING.includes(prev.status)) return false;
      return plans.setPlan(userId, { ...prev, status: 'canceled', cancelAtPeriodEnd: false, syncedAt });
    }
    const next = { ...planFromSubscription(best), syncedAt };
    // an ended one for a user with no record is not stored; a paused or unpaid one is (it can
    // still charge, so account deletion must know of it)
    if (!prev && (next.status === 'canceled' || next.status === 'expired')) return false;
    return plans.setPlan(userId, next);
  }

  return {
    provider: 'polar',
    server: config.server,

    /** What the browser may offer this user (GET /api/account `billing`). */
    async offer(record, plan) {
      const canUpgrade = plan.id === 'free';
      return {
        provider: 'polar',
        sandbox: config.server === 'sandbox',
        price: canUpgrade ? await currentPrice() : null,
        canUpgrade,
        canManage: record?.provider === 'polar' && !!record.customerId,
      };
    },

    /** The Pro price label ("$8 / month"), or null while Polar cannot say (the pricing page). */
    price: () => currentPrice(),

    /** Bring the user's plan up to date from Polar now (back from checkout, or on request). */
    sync: (userId) => syncUser(userId),

    /**
     * A hosted checkout for Pro; resolves its URL. When Polar already has a live or paused Pro
     * subscription the plan record missed, it syncs the plan from it and refuses (409, resynced).
     */
    async checkout(userId, { origin, back = '/#/you' }) {
      if ((await userSubscriptions(userId)).some((sub) => isPro(sub) && SUBSCRIBED.includes(sub.status))) {
        await syncUser(userId);
        throw Object.assign(new Error('You already have a Pro subscription. Your plan is updated.'), { status: 409, resynced: true });
      }
      const c = await api('POST', '/checkouts/', {
        products: [config.productId],
        external_customer_id: userId,
        metadata: { wonderUserId: userId },
        success_url: `${origin}/?checkout_id={CHECKOUT_ID}#/you`,
        return_url: `${origin}${back}`,
      });
      if (typeof c?.url !== 'string') throw new Error('Polar sent no checkout URL');
      return c.url;
    },

    /** Polar's customer portal for this user (manage card, cancel); resolves its URL. */
    async portal(userId, record, { origin }) {
      const who = record?.provider === 'polar' && record.customerId ? { customer_id: record.customerId } : { external_customer_id: userId };
      const s = await api('POST', '/customer-sessions/', { ...who, return_url: `${origin}/#/you` });
      if (typeof s?.customer_portal_url !== 'string') throw new Error('Polar sent no portal URL');
      return s.customer_portal_url;
    },

    /**
     * Account deletion, before the data goes: end every subscription the user has at Polar that is
     * not over yet (paused, unpaid and not-yet-recorded ones too). A refused revoke counts only
     * once Polar shows the subscription ended. Resolves how many were ended; throws when Polar
     * cannot be reached or refuses, so the caller keeps the account.
     */
    async cancelAll(userId, record) {
      const subs = await userSubscriptions(userId, [record?.provider === 'polar' ? record.subscriptionId : null]);
      let ended = 0;
      for (const sub of subs.filter((x) => !ENDED.includes(x.status))) {
        try {
          await api('DELETE', `/subscriptions/${encodeURIComponent(sub.id)}`);
          ended++;
        } catch (e) {
          if (e.status !== 403 && e.status !== 404) throw e;
          // 403 is also a missing scope or a state Polar will not revoke: only an ended one is fine
          const now = await subscription(sub.id, userId);
          if (now && !ENDED.includes(now.status)) throw Object.assign(new Error(`Polar would not end subscription ${sub.id} (${e.status}, ${now.status})`), { status: e.status });
        }
      }
      return ended;
    },

    /**
     * After the data is gone: delete and anonymize the Polar customer (clearing its external id).
     * Best effort; a customer left behind has nothing billing it.
     */
    async forgetCustomer(userId) {
      try {
        await api('DELETE', `/customers/external/${encodeURIComponent(userId)}?anonymize=true`);
        return true;
      } catch (e) {
        if (e.status !== 404) logger.warn?.(`[wonder] could not delete the Polar customer: ${e.message}`);
        return false;
      }
    },

    /**
     * One webhook delivery. Resolves the HTTP status to answer: 401 for a bad signature, 2xx once
     * handled or deliberately ignored; a throw (500) makes Polar retry. Polar disables an endpoint
     * after 10 failed deliveries in a row, so an error retrying cannot fix answers 202 (logged).
     */
    async webhook(raw, header) {
      if (!verifyWebhook(raw, header, config.webhookSecret, now())) return { status: 401 };
      let event;
      try { event = JSON.parse(raw); } catch { return { status: 400 }; }
      const sub = event?.data;
      if (!String(event?.type || '').startsWith('subscription.') || !sub?.id) return { status: 202 };
      const userId = sub.customer?.external_id || sub.metadata?.wonderUserId;
      if (typeof userId !== 'string' || !userId) {
        logger.warn?.(`[wonder] Polar subscription ${sub.id} names no user`);
        return { status: 202 };
      }
      try {
        const stored = await syncUser(userId, { eventId: sub.id });
        logger.info?.(`[wonder] plan from Polar ${event.type}: ${stored ? 'stored' : 'unchanged'}`);
      } catch (e) {
        if (!permanent(e)) throw e;
        logger.error?.(`[wonder] Polar webhook ${event.type} dropped: ${e.message}`);
        return { status: 202 };
      }
      return { status: 200 };
    },
  };
}

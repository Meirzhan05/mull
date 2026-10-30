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
// names its user (customer.external_id). Events can arrive late or out of order, so each one is
// answered by fetching the subscription as it is now and storing that.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GOOD_STANDING } from './plans.js';

export const POLAR_API = Object.freeze({ sandbox: 'https://sandbox-api.polar.sh/v1', production: 'https://api.polar.sh/v1' });
/** Polar's dated API version, pinned so a new "current" version cannot change these calls. */
export const POLAR_VERSION = '2026-10';
/** Webhook timestamps further than this from now are refused (Standard Webhooks replay window). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
const PRICE_TTL_MS = 60 * 60_000;

/** Polar settings from the environment, or null when billing is off. */
export function polarConfig(env = process.env) {
  const v = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const token = v('POLAR_ACCESS_TOKEN');
  const webhookSecret = v('POLAR_WEBHOOK_SECRET');
  const productId = v('POLAR_PRODUCT_ID');
  if (!token || !webhookSecret || !productId) return null;
  const server = v('POLAR_SERVER')?.toLowerCase() === 'production' ? 'production' : 'sandbox';
  return { token, webhookSecret, productId, server, apiBase: POLAR_API[server] };
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
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`Polar ${method} ${path.split('?')[0]} failed (${res.status})`), { status: res.status, detail: data });
    return data;
  }

  let price = { label: null, at: -Infinity };
  async function currentPrice() {
    if (now() - price.at < PRICE_TTL_MS) return price.label;
    try {
      price = { label: priceLabel(await api('GET', `/products/${encodeURIComponent(config.productId)}`)), at: now() };
    } catch (e) {
      logger.warn?.(`[wonder] Pro price lookup failed: ${e.message}`);
      price = { label: price.label, at: now() - PRICE_TTL_MS + 60_000 }; // try again in a minute
    }
    return price.label;
  }

  return {
    provider: 'polar',
    server: config.server,

    /** What the browser may offer this user (GET /api/account `billing`). */
    async offer(record, plan) {
      return {
        provider: 'polar',
        sandbox: config.server === 'sandbox',
        price: await currentPrice(),
        canUpgrade: plan.id === 'free',
        canManage: record?.provider === 'polar' && !!record.customerId,
      };
    },

    /** A hosted checkout for Pro; resolves its URL. */
    async checkout(userId, { origin }) {
      const c = await api('POST', '/checkouts/', {
        products: [config.productId],
        external_customer_id: userId,
        metadata: { wonderUserId: userId },
        success_url: `${origin}/?checkout_id={CHECKOUT_ID}#/you`,
        return_url: `${origin}/#/you`,
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

    /** End a user's subscription now (account deletion). Already-ended ones are fine. */
    async cancelNow(record) {
      if (record?.provider !== 'polar' || !record.subscriptionId || !GOOD_STANDING.includes(record.status)) return false;
      try {
        await api('DELETE', `/subscriptions/${encodeURIComponent(record.subscriptionId)}`);
      } catch (e) {
        if (e.status === 403 || e.status === 404) return false; // already canceled, or gone
        throw e;
      }
      return true;
    },

    /**
     * One webhook delivery. Resolves the HTTP status to answer: 401 for a bad signature, 2xx once
     * handled or deliberately ignored; a throw (500) makes Polar retry.
     */
    async webhook(raw, header) {
      if (!verifyWebhook(raw, header, config.webhookSecret, now())) return { status: 401 };
      let event;
      try { event = JSON.parse(raw); } catch { return { status: 400 }; }
      if (!String(event?.type || '').startsWith('subscription.') || !event.data?.id) return { status: 202 };
      const sub = await api('GET', `/subscriptions/${encodeURIComponent(event.data.id)}`);
      if (sub.product_id !== config.productId) return { status: 202 };
      const userId = sub.customer?.external_id || sub.metadata?.wonderUserId;
      if (typeof userId !== 'string' || !userId) {
        logger.warn?.(`[wonder] Polar subscription ${sub.id} names no user`);
        return { status: 202 };
      }
      const next = planFromSubscription(sub);
      const prev = await plans.stored(userId);
      // a late event for an old subscription never replaces a live one, and a deleted account
      // is not brought back by the cancellation its deletion caused
      if (prev && prev.subscriptionId !== next.subscriptionId && GOOD_STANDING.includes(prev.status) && !GOOD_STANDING.includes(next.status)) return { status: 202 };
      if (!prev && !GOOD_STANDING.includes(next.status)) return { status: 202 };
      await plans.setPlan(userId, next);
      logger.info?.(`[wonder] plan from Polar ${event.type}: pro/${next.status}`);
      return { status: 200 };
    },
  };
}

// Buying Pro through Polar (server/billing.js): webhook signatures, subscription -> plan record,
// and over HTTP the checkout, the customer portal, webhooks and account deletion, against a fake
// Polar API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWonderServer, createWonderCore } from '../server/app.js';
import { handleWebRequest } from '../server/web.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { polarConfig, verifyWebhook, planFromSubscription, priceLabel, bestSubscription, POLAR_API, POLAR_VERSION, WEBHOOK_TOLERANCE_MS } from '../server/billing.js';
import { cleanPlanRecord, createPlans } from '../server/plans.js';
import { fakeClient } from './helpers.js';

const quiet = { warn() {}, error() {}, log() {}, info() {} };
const DAY = 24 * 3600_000;
const ENV = { POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_WEBHOOK_SECRET: `whsec_${Buffer.from('k'.repeat(32)).toString('base64')}`, POLAR_PRODUCT_ID: 'prod_pro' };

/** Standard Webhooks headers for `raw`, signed with `key` (bytes). */
function signed(raw, key, { id = 'msg_1', ts = Math.floor(Date.now() / 1000) } = {}) {
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` };
}
const standardKey = (secret) => Buffer.from(secret.slice(6), 'base64');

test('polar config: off unless token, webhook secret and product are all set; sandbox by default', () => {
  assert.equal(polarConfig({}), null);
  assert.equal(polarConfig({ ...ENV, POLAR_WEBHOOK_SECRET: ' ' }), null, 'no webhook secret: off');
  assert.equal(polarConfig(ENV).server, 'sandbox');
  assert.equal(polarConfig(ENV).apiBase, POLAR_API.sandbox);
  assert.equal(polarConfig({ ...ENV, POLAR_SERVER: 'Production' }).apiBase, POLAR_API.production);
  const two = polarConfig({ ...ENV, POLAR_PRODUCT_ID: 'prod_pro, prod_year' });
  assert.equal(two.productId, 'prod_pro', 'checkout sells the first');
  assert.deepEqual(two.productIds, ['prod_pro', 'prod_year']);
});

test('webhook signatures: Standard Webhooks and legacy keys, multiple signatures, replay window', () => {
  const raw = '{"type":"subscription.updated","data":{"id":"sub_1"}}';
  const secret = ENV.POLAR_WEBHOOK_SECRET;
  const h = (headers) => (n) => headers[n];
  const now = Date.now();
  assert.equal(verifyWebhook(raw, h(signed(raw, standardKey(secret))), secret, now), true, 'whsec_: base64 key');
  assert.equal(verifyWebhook(raw, h(signed(raw, Buffer.from(secret))), secret, now), true, 'older secrets: the UTF-8 bytes');
  assert.equal(verifyWebhook(raw, h(signed(raw, Buffer.from('polar_whs_old'))), 'polar_whs_old', now), true, 'legacy prefix');
  const good = signed(raw, standardKey(secret));
  assert.equal(verifyWebhook(raw, h({ ...good, 'webhook-signature': `v1,AAAA ${good['webhook-signature']}` }), secret, now), true, 'any listed v1 signature');
  assert.equal(verifyWebhook(`${raw} `, h(good), secret, now), false, 'a changed body');
  assert.equal(verifyWebhook(raw, h(signed(raw, Buffer.from('other'))), secret, now), false, 'another key');
  assert.equal(verifyWebhook(raw, h({ ...good, 'webhook-id': 'msg_2' }), secret, now), false, 'id is signed');
  assert.equal(verifyWebhook(raw, h(good), secret, now + WEBHOOK_TOLERANCE_MS + 2000), false, 'too old');
  assert.equal(verifyWebhook(raw, h({}), secret, now), false, 'no headers');
});

test('subscription -> plan record, and price labels', () => {
  const end = '2026-11-24T00:00:00Z';
  assert.deepEqual(cleanPlanRecord(planFromSubscription({ id: 'sub_1', status: 'active', customer_id: 'cus_1', current_period_end: end, cancel_at_period_end: true })),
    { plan: 'pro', status: 'active', provider: 'polar', customerId: 'cus_1', subscriptionId: 'sub_1', periodEnd: Date.parse(end), cancelAtPeriodEnd: true, syncedAt: null });
  assert.equal(planFromSubscription({ id: 's', status: 'incomplete_expired' }).status, 'expired');
  assert.equal(cleanPlanRecord(planFromSubscription({ id: 's', status: 'paused' })).status, 'paused');
  assert.equal(planFromSubscription({ id: 's', status: 'canceled', current_period_end: end, ended_at: '2026-11-01T00:00:00Z' }).periodEnd, '2026-11-01T00:00:00Z');
  assert.equal(priceLabel({ recurring_interval: 'month', prices: [{ amount_type: 'fixed', price_amount: 800, price_currency: 'usd' }] }), '$8 / month');
  assert.equal(priceLabel({ recurring_interval: 'year', recurring_interval_count: 1, prices: [{ amount_type: 'fixed', price_amount: 7999, price_currency: 'usd' }] }), '$79.99 / year');
  assert.equal(priceLabel({ recurring_interval: 'month', recurring_interval_count: 3, prices: [{ amount_type: 'fixed', price_amount: 2000, price_currency: 'eur' }] }), '€20 / 3 months');
  assert.equal(priceLabel({ prices: [{ amount_type: 'custom' }] }), null);
  const s = (id, status, end, mod) => ({ id, status, current_period_end: end, modified_at: mod });
  assert.equal(bestSubscription([]), null);
  assert.equal(bestSubscription([s('a', 'canceled', '2026-12-01'), s('b', 'active', '2026-11-01'), s('c', 'past_due', '2026-11-15')]).id, 'c', 'live first, latest period end');
  assert.equal(bestSubscription([s('a', 'canceled', null, '2026-10-01'), s('b', 'paused', null, '2026-10-20')]).id, 'b', 'else the latest change');
  assert.equal(bestSubscription([{ ...s('a', 'active', '2026-11-20'), cancel_at_period_end: true }, s('b', 'active', '2026-11-10')]).id, 'b', 'a renewing one before one set to cancel');
});

test('plan records: an older provider read never overwrites a newer one', async () => {
  const plans = createPlans({ db: createMemoryDb(), env: {}, logger: quiet });
  const rec = (status, syncedAt) => ({ plan: 'pro', status, provider: 'polar', subscriptionId: 's', syncedAt });
  assert.equal(await plans.setPlan('alice', rec('canceled', 2000)), true);
  assert.equal(await plans.setPlan('alice', rec('active', 1000)), false, 'read earlier: dropped');
  assert.equal((await plans.stored('alice')).status, 'canceled');
  assert.equal(await plans.setPlan('alice', rec('active', 3000)), true);
  assert.equal(await plans.setPlan('alice', rec('trialing', null)), true, 'no stamp: always written');
  assert.equal((await plans.stored('alice')).status, 'trialing');
});

/** A fake Polar API: records calls; subscriptions live in `subs`, keyed by id. */
function fakePolar() {
  const calls = [];
  const subs = new Map();
  const fail = { revoke: false, list: null, products: 0, page2: false, pausedForbidden: false, customer: false };
  const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: p, query: Object.fromEntries(u.searchParams), body, headers: init.headers, origin: u.origin });
    if (init.method === 'POST' && p === '/checkouts/') return reply(201, { id: 'chk_1', url: 'https://sandbox.polar.sh/checkout/chk_1' });
    if (init.method === 'POST' && p === '/customer-sessions/') return reply(201, { customer_portal_url: 'https://sandbox.polar.sh/portal/x' });
    if (init.method === 'GET' && p === '/products/prod_pro') {
      if (fail.products) await new Promise((r) => setTimeout(r, fail.products));
      return reply(200, { id: 'prod_pro', recurring_interval: 'month', prices: [{ amount_type: 'fixed', price_amount: 800, price_currency: 'usd' }] });
    }
    if (init.method === 'GET' && p === '/subscriptions/') {
      if (fail.list) return reply(fail.list, { error: 'nope' });
      const items = [...subs.values()].filter((s) => s.customer?.external_id === u.searchParams.get('external_customer_id'));
      if (fail.page2) return u.searchParams.get('page') === '1' ? reply(200, { items, pagination: { total_count: items.length + 1, max_page: 2 } }) : reply(404, { error: 'ResourceNotFound' });
      return reply(200, { items, pagination: { total_count: items.length, max_page: 1 } });
    }
    const m = p.match(/^\/subscriptions\/(.+)$/);
    if (m && init.method === 'GET') return subs.has(m[1]) ? reply(200, subs.get(m[1])) : reply(404, { error: 'ResourceNotFound' });
    if (m && init.method === 'DELETE') {
      if (fail.revoke) return reply(500, { error: 'boom' });
      const s = subs.get(m[1]);
      if (!s || s.status === 'canceled') return reply(403, { error: 'AlreadyCanceledSubscription' });
      if (fail.pausedForbidden && s.status === 'paused') return reply(403, { error: 'InactiveSubscription' });
      subs.set(m[1], { ...s, status: 'canceled', ended_at: new Date().toISOString() });
      return reply(200, subs.get(m[1]));
    }
    const c = p.match(/^\/customers\/external\/(.+)$/);
    if (c && init.method === 'DELETE') {
      if (fail.customer) return reply(503, { error: 'down' });
      const mine = [...subs.values()].filter((s) => s.customer?.external_id === c[1]);
      if (!mine.length) return reply(404, { error: 'ResourceNotFound' });
      for (const s of mine) subs.set(s.id, { ...s, customer: { ...s.customer, external_id: null } });
      return reply(204);
    }
    return reply(404, { error: 'not faked' });
  };
  return { fetch, calls, subs, fail };
}

async function withServer(fn, { env = ENV, db = createMemoryDb() } = {}) {
  const polar = fakePolar();
  const sync = createSyncService({ db });
  const server = createWonderServer({
    mode: 'demo', client: fakeClient({ text: 'x' }), demoDelayMs: 0, logger: quiet, memory: createMemoryStore({ file: null }), push: null, sync,
    getUserId: (req) => req.headers['x-test-user'] || null, deleteAuthUser: async () => true, billingFetch: polar.fetch, env,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...headers }, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // a webhook for a subscription as it is in the fake now (or `data` as given)
  const hook = (type, idOrData, key = standardKey(ENV.POLAR_WEBHOOK_SECRET)) => {
    const data = typeof idOrData === 'string' ? polar.subs.get(idOrData) || { id: idOrData } : idOrData;
    const raw = JSON.stringify({ type, data });
    return call(null, 'POST', '/api/billing/webhook', raw, signed(raw, key));
  };
  try {
    await fn({ call, hook, polar, sync, base });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const sub = (over = {}) => ({ id: 'sub_1', status: 'active', product_id: 'prod_pro', customer_id: 'cus_1', customer: { id: 'cus_1', external_id: 'alice' }, current_period_end: new Date(Date.now() + 30 * DAY).toISOString(), cancel_at_period_end: false, metadata: { wonderUserId: 'alice' }, ...over });

test('over HTTP: checkout, webhook makes the account Pro, portal, and cancellation back to Free', async () => {
  await withServer(async ({ call, hook, polar, base }) => {
    const before = (await call('alice', 'GET', '/api/account')).body;
    assert.equal(before.plan.id, 'free');
    assert.deepEqual(before.billing, { provider: 'polar', sandbox: true, price: '$8 / month', canUpgrade: true, canManage: false });

    assert.equal((await call(null, 'POST', '/api/billing/checkout')).status, 401, 'signed in only');
    const co = await call('alice', 'POST', '/api/billing/checkout');
    assert.deepEqual(co.body, { ok: true, url: 'https://sandbox.polar.sh/checkout/chk_1' });
    const req = polar.calls.find((c) => c.path === '/checkouts/');
    assert.equal(req.origin, 'https://sandbox-api.polar.sh');
    assert.equal(req.headers.Authorization, 'Bearer polar_oat_test');
    assert.equal(req.headers['Polar-Version'], POLAR_VERSION);
    assert.deepEqual(req.body.products, ['prod_pro']);
    assert.equal(req.body.external_customer_id, 'alice');
    assert.equal(req.body.success_url, `${base}/?checkout_id={CHECKOUT_ID}#/you`);

    // the webhook: a bad signature is refused; a good one lists the user's subscriptions and stores the best
    polar.subs.set('sub_1', sub());
    assert.equal((await hook('subscription.active', 'sub_1', Buffer.from('wrong'))).status, 401);
    assert.equal((await hook('subscription.active', { ...sub(), status: 'incomplete' })).status, 200, 'the payload is only a pointer');
    assert.equal(polar.calls.at(-1).query.external_customer_id, 'alice');
    const pro = (await call('alice', 'GET', '/api/account')).body;
    assert.equal(pro.plan.id, 'pro');
    assert.equal(pro.plan.source, 'subscription');
    assert.ok(pro.plan.renewsAt);
    assert.equal(pro.billing.canUpgrade, false);
    assert.equal(pro.billing.canManage, true);
    assert.equal((await call('alice', 'POST', '/api/billing/checkout')).status, 409, 'already Pro');

    assert.deepEqual((await call('alice', 'POST', '/api/billing/portal')).body, { ok: true, url: 'https://sandbox.polar.sh/portal/x' });
    assert.deepEqual(polar.calls.find((c) => c.path === '/customer-sessions/').body, { customer_id: 'cus_1', return_url: `${base}/#/you` });

    // cancel at period end: still Pro, ending; then revoked: Free
    polar.subs.set('sub_1', sub({ cancel_at_period_end: true }));
    await hook('subscription.canceled', 'sub_1');
    const ending = (await call('alice', 'GET', '/api/account')).body.plan;
    assert.equal(ending.id, 'pro');
    assert.ok(ending.endsAt);
    polar.subs.set('sub_1', sub({ status: 'canceled', ended_at: new Date().toISOString() }));
    await hook('subscription.revoked', 'sub_1');
    const after = (await call('alice', 'GET', '/api/account')).body;
    assert.equal(after.plan.id, 'free');
    assert.equal(after.billing.canUpgrade, true);
    assert.equal(after.billing.canManage, true, 'invoices stay reachable');
  });
});

test('checkout: a subscription the plan missed is synced instead of sold twice; POST /api/billing/sync reads Polar now', async () => {
  await withServer(async ({ call, polar, sync }) => {
    polar.subs.set('sub_1', sub());
    const r = await call('alice', 'POST', '/api/billing/checkout');
    assert.equal(r.status, 409);
    assert.equal(r.body.resynced, true);
    assert.match(r.body.error, /already have a Pro subscription/);
    assert.equal((await call('alice', 'GET', '/api/account')).body.plan.id, 'pro', 'synced from Polar, no webhook needed');
    assert.equal(polar.calls.filter((c) => c.path === '/checkouts/').length, 0);

    polar.subs.set('sub_1', sub({ status: 'canceled' }));
    assert.equal((await call(null, 'POST', '/api/billing/sync')).status, 401, 'signed in only');
    assert.equal((await call('alice', 'POST', '/api/billing/sync')).body.plan.id, 'free');
    const lists = polar.calls.filter((c) => c.path === '/subscriptions/').length;
    assert.equal((await call('alice', 'POST', '/api/billing/sync')).body.plan.id, 'free');
    assert.equal(polar.calls.filter((c) => c.path === '/subscriptions/').length, lists, 'a second sync right away is not sent to Polar');
    assert.equal((await call('alice', 'POST', '/api/billing/checkout')).status, 200, 'an ended one does not block');

    // bob opens checkout: a pending record marks him, without making him Pro or manageable
    assert.equal((await call('bob', 'POST', '/api/billing/checkout')).status, 200);
    assert.equal((await sync.db.getPlan('bob')).status, 'incomplete');
    const bob = (await call('bob', 'GET', '/api/account')).body;
    assert.equal(bob.plan.id, 'free');
    assert.equal(bob.billing.canManage, false);
  });
});

test('webhooks and sync find a subscription that names the user only in its metadata', async () => {
  await withServer(async ({ call, hook, polar }) => {
    // checkout linked an existing Polar customer that has no external id
    polar.subs.set('sub_m', sub({ id: 'sub_m', customer: { id: 'cus_old', external_id: null } }));
    assert.equal((await hook('subscription.active', 'sub_m')).status, 200);
    assert.equal((await call('alice', 'GET', '/api/account')).body.plan.id, 'pro');
    // later changes are found through the stored subscription id
    polar.subs.set('sub_m', sub({ id: 'sub_m', customer: { id: 'cus_old', external_id: null }, status: 'canceled' }));
    await new Promise((r) => setTimeout(r, 1600)); // past the sync throttle
    assert.equal((await call('alice', 'POST', '/api/billing/sync')).body.plan.id, 'free');
    // someone else's subscription is never taken for this user
    polar.subs.set('sub_x', sub({ id: 'sub_x', customer: { id: 'cus_x', external_id: 'mallory' }, metadata: {} }));
    assert.equal((await hook('subscription.active', { ...polar.subs.get('sub_x'), customer: { external_id: 'alice' } })).status, 200);
    assert.equal((await call('alice', 'GET', '/api/account')).body.plan.id, 'free');
  });
});

test('a sync is versioned by Polar change times, and a missing later page does not drop earlier ones', async () => {
  await withServer(async ({ hook, polar, sync }) => {
    polar.subs.set('sub_1', sub({ modified_at: '2026-10-29T10:00:00Z' }));
    await hook('subscription.active', 'sub_1');
    assert.equal((await sync.db.getPlan('alice')).syncedAt, Date.parse('2026-10-29T10:00:00Z'));
    polar.fail.page2 = true;
    polar.subs.set('sub_1', sub({ modified_at: '2026-10-29T11:00:00Z' }));
    assert.equal((await hook('subscription.updated', 'sub_1')).status, 202, 'page 2 404s: dropped, not read as "no subscriptions"');
    assert.equal((await sync.db.getPlan('alice')).status, 'active');
  });
});

test('webhooks: two subscriptions, product switches, ignored events, and which errors Polar retries', async () => {
  await withServer(async ({ call, hook, polar, sync }) => {
    assert.equal((await hook('order.paid', { id: 'ord_1' })).status, 202);
    assert.equal((await hook('subscription.active', { id: 'sub_n', customer: { external_id: null }, metadata: {} })).status, 202, 'no user named');

    // two live subscriptions: ending one keeps Pro while the other lives
    polar.subs.set('sub_1', sub());
    polar.subs.set('sub_2', sub({ id: 'sub_2', current_period_end: new Date(Date.now() + 10 * DAY).toISOString() }));
    await hook('subscription.active', 'sub_2');
    assert.equal((await sync.db.getPlan('alice')).subscriptionId, 'sub_1', 'the one running longest');
    polar.subs.set('sub_1', sub({ status: 'canceled' }));
    await hook('subscription.revoked', 'sub_1');
    assert.equal((await sync.db.getPlan('alice')).subscriptionId, 'sub_2');
    assert.equal((await call('alice', 'GET', '/api/account')).body.plan.id, 'pro');

    // switching to another listed Pro product stays Pro; moving off Pro ends it
    await withServer(async ({ hook: hook2, polar: p2, sync: s2 }) => {
      p2.subs.set('sub_y', sub({ id: 'sub_y', product_id: 'prod_year' }));
      await hook2('subscription.updated', 'sub_y');
      assert.equal((await s2.db.getPlan('alice')).status, 'active');
      p2.subs.set('sub_y', sub({ id: 'sub_y', product_id: 'prod_other' }));
      await hook2('subscription.updated', 'sub_y');
      assert.equal((await s2.db.getPlan('alice')).status, 'canceled', 'moved off Pro');
    }, { env: { ...ENV, POLAR_PRODUCT_ID: 'prod_pro,prod_year' } });

    // an ended subscription for someone with no record is not stored
    polar.subs.set('sub_b', sub({ id: 'sub_b', status: 'canceled', customer: { id: 'cus_b', external_id: 'bob' } }));
    assert.equal((await hook('subscription.revoked', 'sub_b')).status, 200);
    assert.equal(await sync.db.getPlan('bob'), null);

    // a Polar error retrying cannot fix is dropped (202) so the endpoint is not disabled; others retry
    polar.fail.list = 422;
    assert.equal((await hook('subscription.updated', 'sub_2')).status, 202);
    polar.fail.list = 503;
    assert.equal((await hook('subscription.updated', 'sub_2')).status, 500);
    polar.fail.list = 429;
    assert.equal((await hook('subscription.updated', 'sub_2')).status, 500);
    for (const code of [401, 403]) {
      polar.fail.list = code;
      assert.equal((await hook('subscription.updated', 'sub_2')).status, 500, `${code}: a token problem is retried, not dropped`);
    }
    polar.fail.list = null;
    assert.equal((await call(null, 'POST', '/api/billing/webhook', 'not json')).status, 400, 'like every JSON route');
  });
});

test('deleting an account ends every Polar subscription and the customer first; if that fails nothing is deleted', async () => {
  await withServer(async ({ call, hook, polar, sync }) => {
    // one recorded, one not yet (its webhook is still on the way), one paused
    polar.subs.set('sub_1', sub());
    await hook('subscription.active', 'sub_1');
    polar.subs.set('sub_2', sub({ id: 'sub_2' }));
    polar.subs.set('sub_3', sub({ id: 'sub_3', status: 'paused' }));
    await call('alice', 'POST', '/api/sync', { since: 0, changes: [{ kind: 'lesson', id: 'L1', data: { title: 'x' } }] });
    polar.fail.revoke = true;
    const failed = await call('alice', 'DELETE', '/api/account');
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /nothing was deleted/);
    assert.equal(await sync.count('alice'), 1);
    polar.fail.revoke = false;
    assert.equal((await call('alice', 'DELETE', '/api/account')).status, 200);
    for (const id of ['sub_1', 'sub_2', 'sub_3']) assert.equal(polar.subs.get(id).status, 'canceled', id);
    const del = polar.calls.find((c) => c.method === 'DELETE' && c.path === '/customers/external/alice');
    assert.equal(del.query.anonymize, 'true');
    assert.equal(await sync.db.getPlan('alice'), null, 'the plan goes with the account');
    // the revokes' own webhooks arrive after the delete and bring nothing back
    assert.equal((await hook('subscription.revoked', { ...polar.subs.get('sub_2'), customer: { external_id: 'alice' } })).status, 200);
    assert.equal(await sync.db.getPlan('alice'), null);
    // a Free account that never opened checkout deletes without asking Polar, even when it is down
    polar.fail.list = 503;
    const before = polar.calls.length;
    assert.equal((await call('bob', 'DELETE', '/api/account')).status, 200);
    assert.equal(polar.calls.length, before);
    // one that did open checkout is checked, and kept while Polar is down
    polar.fail.list = null;
    assert.equal((await call('carol', 'POST', '/api/billing/checkout')).status, 200);
    polar.fail.list = 503;
    const down = await call('carol', 'DELETE', '/api/account');
    assert.equal(down.status, 502);
    assert.match(down.body.error, /Could not reach billing/);
    polar.fail.list = null;
  });
});

test('deleting an account: a revoke Polar refuses on a subscription still running keeps the account', async () => {
  await withServer(async ({ call, hook, polar, sync }) => {
    polar.subs.set('sub_p', sub({ id: 'sub_p', status: 'paused' }));
    await call('alice', 'POST', '/api/billing/checkout'); // 409, synced: the paused one is recorded
    assert.equal((await sync.db.getPlan('alice')).status, 'paused');
    polar.fail.pausedForbidden = true;
    const r = await call('alice', 'DELETE', '/api/account');
    assert.equal(r.status, 502, 'a 403 is not taken as "already canceled"');
    assert.equal(polar.subs.get('sub_p').status, 'paused');
    assert.ok(await sync.db.getPlan('alice'), 'nothing deleted');
    polar.fail.pausedForbidden = false;
    assert.equal((await call('alice', 'DELETE', '/api/account')).status, 200);
    assert.equal(polar.subs.get('sub_p').status, 'canceled');
    void hook;
  });
});

test('deleting an account: a database error says so, and a delete that fails after cancelling says the subscription ended', async () => {
  const db = createMemoryDb();
  const getPlan = db.getPlan;
  const deleteUser = db.deleteUser;
  await withServer(async ({ call, hook, polar }) => {
    db.getPlan = async () => { throw new Error('db down'); };
    const r = await call('alice', 'DELETE', '/api/account');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /Could not delete your account right now/);
    db.getPlan = getPlan;
    polar.subs.set('sub_1', sub());
    await hook('subscription.active', 'sub_1');
    db.deleteUser = async () => { throw new Error('db down'); };
    const r2 = await call('alice', 'DELETE', '/api/account');
    assert.equal(r2.status, 500);
    assert.match(r2.body.error, /subscription was canceled, but deleting your data failed/);
    assert.equal(polar.calls.filter((c) => c.path.startsWith('/customers/')).length, 0, 'the Polar customer stays while the data does');
    db.deleteUser = deleteUser;
    // the data goes, then the customer; a customer delete that fails does not undo the account delete
    polar.fail.customer = true;
    assert.equal((await call('alice', 'DELETE', '/api/account')).status, 200);
    assert.equal(polar.calls.filter((c) => c.path.startsWith('/customers/')).length, 1);
  }, { db });
});

test('the account card does not wait long for a slow Polar price', async () => {
  await withServer(async ({ call, polar }) => {
    polar.fail.products = 4000;
    const t0 = Date.now();
    const a = (await call('alice', 'GET', '/api/account')).body;
    assert.ok(Date.now() - t0 < 3000, 'answered without the price');
    assert.equal(a.billing.price, null);
  });
  await withServer(async ({ call, hook, polar }) => {
    polar.subs.set('sub_1', sub());
    await hook('subscription.active', 'sub_1');
    const before = polar.calls.filter((c) => c.path.startsWith('/products/')).length;
    assert.equal((await call('alice', 'GET', '/api/account')).body.billing.price, null, 'Pro: no Upgrade, no price');
    assert.equal(polar.calls.filter((c) => c.path.startsWith('/products/')).length, before);
  });
});

test('over the Next.js adapter: the webhook is verified over the raw body, and checkout uses the request origin', async () => {
  const polar = fakePolar();
  const sync = createSyncService({ db: createMemoryDb() });
  const core = createWonderCore({ mode: 'demo', logger: quiet, memory: createMemoryStore({ file: null }), push: null, sync, billingFetch: polar.fetch, env: ENV });
  polar.subs.set('sub_1', sub());
  const raw = JSON.stringify({ type: 'subscription.active', data: polar.subs.get('sub_1') });
  const res = await handleWebRequest(core, new Request('https://mull.example/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signed(raw, standardKey(ENV.POLAR_WEBHOOK_SECRET)) }, body: raw }), { logger: quiet });
  assert.equal(res.status, 200);
  assert.equal((await sync.db.getPlan('alice')).status, 'active');
  const bad = await handleWebRequest(core, new Request('https://mull.example/api/billing/webhook', { method: 'POST', headers: signed(raw, Buffer.from('wrong')), body: raw }), { logger: quiet });
  assert.equal(bad.status, 401);
  polar.subs.set('sub_1', sub({ status: 'canceled' }));
  await sync.db.setPlan('bob', cleanPlanRecord({ plan: 'pro', status: 'canceled', provider: 'polar' }));
  const co = await handleWebRequest(core, new Request('https://mull.example/api/billing/checkout', { method: 'POST' }), { logger: quiet, userId: 'bob' });
  assert.equal(co.status, 200);
  assert.equal(polar.calls.find((c) => c.path === '/checkouts/').body.success_url, 'https://mull.example/?checkout_id={CHECKOUT_ID}#/you');
});

test('billing off: no offer on /api/account, and the billing routes say so', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('alice', 'GET', '/api/account')).body.billing, null);
    assert.equal((await call('alice', 'POST', '/api/billing/checkout')).status, 404);
    assert.equal((await call('alice', 'POST', '/api/billing/portal')).status, 404);
    assert.equal((await call(null, 'POST', '/api/billing/webhook', '{}')).status, 404);
  }, { env: {} });
});

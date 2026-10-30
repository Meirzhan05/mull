// Buying Pro through Polar (server/billing.js): webhook signatures, subscription -> plan record,
// and over HTTP the checkout, the customer portal, webhooks and account deletion, against a fake
// Polar API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWonderServer } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { polarConfig, verifyWebhook, planFromSubscription, priceLabel, POLAR_API, POLAR_VERSION, WEBHOOK_TOLERANCE_MS } from '../server/billing.js';
import { cleanPlanRecord } from '../server/plans.js';
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
    { plan: 'pro', status: 'active', provider: 'polar', customerId: 'cus_1', subscriptionId: 'sub_1', periodEnd: Date.parse(end), cancelAtPeriodEnd: true });
  assert.equal(planFromSubscription({ id: 's', status: 'incomplete_expired' }).status, 'expired');
  assert.equal(cleanPlanRecord(planFromSubscription({ id: 's', status: 'paused' })).status, 'paused');
  assert.equal(planFromSubscription({ id: 's', status: 'canceled', current_period_end: end, ended_at: '2026-11-01T00:00:00Z' }).periodEnd, '2026-11-01T00:00:00Z');
  assert.equal(priceLabel({ recurring_interval: 'month', prices: [{ amount_type: 'fixed', price_amount: 800, price_currency: 'usd' }] }), '$8 / month');
  assert.equal(priceLabel({ recurring_interval: 'year', recurring_interval_count: 1, prices: [{ amount_type: 'fixed', price_amount: 7999, price_currency: 'usd' }] }), '$79.99 / year');
  assert.equal(priceLabel({ recurring_interval: 'month', recurring_interval_count: 3, prices: [{ amount_type: 'fixed', price_amount: 2000, price_currency: 'eur' }] }), '€20 / 3 months');
  assert.equal(priceLabel({ prices: [{ amount_type: 'custom' }] }), null);
});

/** A fake Polar API: records calls, serves subscriptions from `subs`. */
function fakePolar() {
  const calls = [];
  const subs = new Map();
  let failRevoke = false;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: p, body, headers: init.headers, origin: u.origin });
    if (init.method === 'POST' && p === '/checkouts/') return reply(201, { id: 'chk_1', url: 'https://sandbox.polar.sh/checkout/chk_1' });
    if (init.method === 'POST' && p === '/customer-sessions/') return reply(201, { customer_portal_url: 'https://sandbox.polar.sh/portal/x' });
    if (init.method === 'GET' && p === '/products/prod_pro') return reply(200, { id: 'prod_pro', recurring_interval: 'month', prices: [{ amount_type: 'fixed', price_amount: 800, price_currency: 'usd' }] });
    const m = p.match(/^\/subscriptions\/(.+)$/);
    if (m && init.method === 'GET') return subs.has(m[1]) ? reply(200, subs.get(m[1])) : reply(404, { error: 'ResourceNotFound' });
    if (m && init.method === 'DELETE') {
      if (failRevoke) return reply(500, { error: 'boom' });
      const s = subs.get(m[1]);
      if (!s || s.status === 'canceled') return reply(403, { error: 'AlreadyCanceledSubscription' });
      subs.set(m[1], { ...s, status: 'canceled', ended_at: new Date().toISOString() });
      return reply(200, subs.get(m[1]));
    }
    return reply(404, { error: 'not faked' });
  };
  return { fetch, calls, subs, set failRevoke(v) { failRevoke = v; } };
}

async function withServer(fn, { env = ENV } = {}) {
  const polar = fakePolar();
  const sync = createSyncService({ db: createMemoryDb() });
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
  const hook = (event, key = standardKey(ENV.POLAR_WEBHOOK_SECRET)) => { const raw = JSON.stringify(event); return call(null, 'POST', '/api/billing/webhook', raw, signed(raw, key)); };
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

    // the webhook: a bad signature is refused; a good one fetches the subscription and stores it
    assert.equal((await hook({ type: 'subscription.active', data: { id: 'sub_1' } }, Buffer.from('wrong'))).status, 401);
    polar.subs.set('sub_1', sub());
    assert.equal((await hook({ type: 'subscription.active', data: { id: 'sub_1', status: 'incomplete' } })).status, 200);
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
    await hook({ type: 'subscription.canceled', data: { id: 'sub_1' } });
    const ending = (await call('alice', 'GET', '/api/account')).body.plan;
    assert.equal(ending.id, 'pro');
    assert.ok(ending.endsAt);
    polar.subs.set('sub_1', sub({ status: 'canceled', ended_at: new Date().toISOString() }));
    await hook({ type: 'subscription.revoked', data: { id: 'sub_1' } });
    const after = (await call('alice', 'GET', '/api/account')).body;
    assert.equal(after.plan.id, 'free');
    assert.equal(after.billing.canUpgrade, true);
    assert.equal(after.billing.canManage, true, 'invoices stay reachable');
  });
});

test('webhooks: other events and products are ignored, an old subscription never replaces a live one, Polar errors are retried', async () => {
  await withServer(async ({ call, hook, polar, sync }) => {
    assert.equal((await hook({ type: 'order.paid', data: { id: 'ord_1' } })).status, 202);
    polar.subs.set('sub_x', sub({ id: 'sub_x', product_id: 'prod_other' }));
    assert.equal((await hook({ type: 'subscription.active', data: { id: 'sub_x' } })).status, 202);
    polar.subs.set('sub_n', sub({ id: 'sub_n', customer: { id: 'cus_1', external_id: null }, metadata: {} }));
    assert.equal((await hook({ type: 'subscription.active', data: { id: 'sub_n' } })).status, 202, 'no user named');
    assert.equal(await sync.db.getPlan('alice'), null);

    polar.subs.set('sub_2', sub({ id: 'sub_2' }));
    await hook({ type: 'subscription.active', data: { id: 'sub_2' } });
    polar.subs.set('sub_1', sub({ status: 'canceled' }));
    assert.equal((await hook({ type: 'subscription.revoked', data: { id: 'sub_1' } })).status, 202);
    assert.equal((await sync.db.getPlan('alice')).subscriptionId, 'sub_2', 'the live subscription stays');

    polar.subs.set('sub_b', sub({ id: 'sub_b', status: 'canceled', customer: { id: 'cus_b', external_id: 'bob' } }));
    assert.equal((await hook({ type: 'subscription.revoked', data: { id: 'sub_b' } })).status, 202);
    assert.equal(await sync.db.getPlan('bob'), null, 'an ended subscription with no record is not stored');

    assert.equal((await hook({ type: 'subscription.updated', data: { id: 'sub_missing' } })).status, 500, 'a Polar error: Polar retries');
    assert.equal((await call(null, 'POST', '/api/billing/webhook', 'not json')).status, 401);
  });
});

test('deleting an account ends its Pro subscription first; if that fails nothing is deleted', async () => {
  await withServer(async ({ call, hook, polar, sync }) => {
    polar.subs.set('sub_1', sub());
    await hook({ type: 'subscription.active', data: { id: 'sub_1' } });
    await call('alice', 'POST', '/api/sync', { since: 0, changes: [{ kind: 'lesson', id: 'L1', data: { title: 'x' } }] });
    polar.failRevoke = true;
    const failed = await call('alice', 'DELETE', '/api/account');
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /nothing was deleted/);
    assert.equal(await sync.count('alice'), 1);
    polar.failRevoke = false;
    assert.equal((await call('alice', 'DELETE', '/api/account')).status, 200);
    assert.equal(polar.calls.filter((c) => c.method === 'DELETE' && c.path === '/subscriptions/sub_1').length, 2);
    assert.equal(await sync.db.getPlan('alice'), null, 'the plan goes with the account');
    // the revoke's own webhook arrives after the delete and does not bring a record back
    assert.equal((await hook({ type: 'subscription.revoked', data: { id: 'sub_1' } })).status, 202);
    assert.equal(await sync.db.getPlan('alice'), null);
    // a Free account deletes without calling Polar
    const before = polar.calls.length;
    assert.equal((await call('bob', 'DELETE', '/api/account')).status, 200);
    assert.equal(polar.calls.filter((c, i) => i >= before && c.method === 'DELETE').length, 0);
  });
});

test('billing off: no offer on /api/account, and the billing routes say so', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('alice', 'GET', '/api/account')).body.billing, null);
    assert.equal((await call('alice', 'POST', '/api/billing/checkout')).status, 404);
    assert.equal((await call('alice', 'POST', '/api/billing/portal')).status, 404);
    assert.equal((await call(null, 'POST', '/api/billing/webhook', '{}')).status, 404);
  }, { env: {} });
});

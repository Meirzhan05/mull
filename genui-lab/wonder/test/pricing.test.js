// The pricing page (public/pricing): what it shows for each /api/plans answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingView, proPitch, freePitch, splitPrice } from '../public/pricing/pricing-core.js';
import { DEFAULT_LIMITS, DEFAULT_PRO_LIMITS } from '../server/usage.js';
import { resolveStatic } from '../server/app.js';

const base = { ok: true, accounts: true, free: { ...DEFAULT_LIMITS }, pro: { ...DEFAULT_PRO_LIMITS }, price: '$8 / month', buyable: true, sandbox: false, signedIn: false };
const signedIn = (plan, billing = null) => ({ ...base, signedIn: true, plan: { name: plan.id === 'pro' ? 'Pro' : 'Free', source: null, ...plan }, billing });

test('pricing: no answer keeps the defaults; no accounts has nothing to choose', () => {
  assert.equal(pricingView(null), null);
  assert.equal(pricingView({ ok: false }), null);
  assert.deepEqual(pricingView({ ...base, accounts: false }), { noAccounts: true });
});

test('pricing: signed out, sign-in comes first, and Pro waits when it is not on sale', () => {
  const v = pricingView(base);
  assert.deepEqual(v.bar, { kind: 'link', label: 'Sign in', href: '/#/signin', primary: false });
  assert.equal(v.current, null);
  assert.equal(v.free.cta.href, '/#/start');
  assert.equal(v.pro.cta.href, '/#/start');
  assert.deepEqual(v.price, { amount: '$8', per: 'month' });
  const off = pricingView({ ...base, price: null, buyable: false });
  assert.equal(off.pro.cta.kind, 'disabled');
  assert.equal(off.price.amount, 'Soon');
});

test('pricing: on Free, Upgrade with the price; without billing, not on sale', () => {
  const v = pricingView(signedIn({ id: 'free' }, { canUpgrade: true, price: '$8 / month' }));
  assert.equal(v.current, 'free');
  assert.equal(v.bar.label, 'Open Mull');
  assert.deepEqual(v.pro.cta, { kind: 'upgrade', label: 'Upgrade · $8 / month' });
  // a slow price lookup: the card says it is paid, the button has no price
  const slow = pricingView({ ...signedIn({ id: 'free' }, { canUpgrade: true, price: null }), price: null });
  assert.deepEqual([slow.price.amount, slow.pro.cta.label], ['Paid', 'Upgrade to Pro']);
  assert.equal(pricingView({ ...signedIn({ id: 'free' }), buyable: false, price: null }).pro.cta.kind, 'disabled');
});

test('pricing: on Pro, the way to manage it depends on where Pro came from', () => {
  assert.equal(pricingView(signedIn({ id: 'pro', source: 'subscription' })).pro.cta.href, '/#/you');
  const admin = pricingView({ ...signedIn({ id: 'pro', source: 'admin' }), buyable: false, price: null });
  assert.equal(admin.current, 'pro');
  assert.equal(admin.pro.cta.href, '/#/');
  assert.match(admin.pro.note, /no daily limits/);
  assert.equal(admin.price.amount, 'Free for you');
  assert.match(pricingView(signedIn({ id: 'pro', source: 'comped' })).pro.note, /Given to you/);
});

test('pricing: the pitch follows the caps this server uses', () => {
  assert.equal(proPitch(DEFAULT_LIMITS, DEFAULT_PRO_LIMITS), 'Five times the daily limits, for learning a lot.');
  const half = Object.fromEntries(Object.entries(DEFAULT_PRO_LIMITS).map(([k, v]) => [k, v / 2.5]));
  assert.equal(proPitch(DEFAULT_LIMITS, half), 'Twice the daily limits, for learning a lot.');
  assert.equal(proPitch(DEFAULT_LIMITS, { ...DEFAULT_PRO_LIMITS, lesson: 40 }), 'Higher daily limits, for learning a lot.');
  assert.equal(proPitch(DEFAULT_LIMITS, { ...DEFAULT_PRO_LIMITS, grade: null }), 'Higher daily limits, for learning a lot.');
  assert.equal(freePitch({ lesson: 20 }), 'Up to 20 lessons a day, with the tutor and the Teacher.');
  assert.equal(freePitch({ lesson: 1 }), 'Up to 1 lesson a day, with the tutor and the Teacher.');
  assert.match(freePitch({ lesson: null }), /no daily limit/);
  assert.deepEqual(splitPrice('$80'), { amount: '$80', per: null });
});

test('pricing: the node server serves /pricing and /welcome like the Next rewrites', () => {
  assert.match(resolveStatic('/pricing').file, /public[/\\]pricing[/\\]index\.html$/);
  assert.match(resolveStatic('/welcome').file, /public[/\\]welcome[/\\]index\.html$/);
});

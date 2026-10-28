// Web Push reminders: which subscribed learners get the daily reminder from the cron, in their own
// time zone, once a day, only when nothing was studied yet that day, with the brief's top action; dead
// subscriptions are dropped. A fake sender stands in for web-push (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncService } from '../server/sync/service.js';
import { createMemoryDb } from '../server/sync/memory-db.js';
import { sendDueReminders, zonedNow, pushConfig } from '../server/push.js';
import { addItems, emptyDeck } from '../public/deck.js';

const quiet = { warn() {}, error() {}, info() {}, log() {} };

async function learner(svc, userId, { tz, reminder = { enabled: true, time: '18:00' }, days = {}, dueCards = 0, endpoint = `https://push.example.test/${userId}` }) {
  const { items } = addItems(emptyDeck(), Array.from({ length: dueCards }, (_, i) => ({ id: `q${i}`, type: 'flashcard', front: `Front ${i}`, back: 'Back' })), { lessonId: 'l1', lessonTitle: 'Photosynthesis', now: new Date('2026-10-01T00:00:00Z') }).deck;
  await svc.sync(userId, { changes: [
    { kind: 'state', id: 'settings', data: { dailyGoal: 30, reminder }, baseRev: 0, updatedAt: 1 },
    { kind: 'state', id: 'stats', data: { xp: 0, streak: { count: 0, lastDate: null, best: 0 }, days }, baseRev: 0, updatedAt: 1 },
    ...items.map((e) => ({ kind: 'card', id: e.id, data: e, baseRev: 0, updatedAt: 1 })),
  ] });
  await svc.db.addSubscription(userId, { endpoint, keys: { p256dh: 'p', auth: 'a' }, timeZone: tz });
}

function sender({ fail = {} } = {}) {
  const sent = [];
  const send = async (sub, payload) => {
    if (fail[sub.endpoint]) throw Object.assign(new Error('gone'), { statusCode: fail[sub.endpoint] });
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  };
  return { send, sent };
}

test('zonedNow reads the wall clock in the learner\'s time zone', () => {
  const d = zonedNow(new Date('2026-10-22T22:30:00Z'), 'America/New_York');
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 30);
  assert.equal(zonedNow(new Date('2026-10-22T22:30:00Z'), 'Asia/Tokyo').getDate(), 23);
  assert.equal(zonedNow(new Date('2026-10-22T22:30:00Z'), 'Not/AZone').getTime(), new Date('2026-10-22T22:30:00Z').getTime());
});

test('push reminders: due after the learner\'s local time, once a day, with the brief\'s top action', async () => {
  const svc = createSyncService({ db: createMemoryDb() });
  await learner(svc, 'ny', { tz: 'America/New_York', dueCards: 3 });
  await learner(svc, 'tokyo', { tz: 'Asia/Tokyo' });
  const { send, sent } = sender();
  // 17:30 in New York (and 06:30 tomorrow in Tokyo): nobody yet
  let r = await sendDueReminders({ sync: svc, send, now: new Date('2026-10-22T21:30:00Z'), logger: quiet });
  assert.deepEqual([r.checked, r.sent], [2, 0]);
  // 18:30 in New York
  r = await sendDueReminders({ sync: svc, send, now: new Date('2026-10-22T22:30:00Z'), logger: quiet });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].endpoint, 'https://push.example.test/ny');
  assert.equal(sent[0].title, 'Mull');
  assert.match(sent[0].body, /Next: Review 3 cards\./);
  assert.equal(sent[0].tag, 'wonder-daily', 'replaces an in-tab reminder instead of stacking');
  // the cron runs again later that evening: already sent today
  r = await sendDueReminders({ sync: svc, send, now: new Date('2026-10-23T01:00:00Z'), logger: quiet });
  assert.equal(r.sent, 0);
  // Tokyo at 18:10 local
  r = await sendDueReminders({ sync: svc, send, now: new Date('2026-10-23T09:10:00Z'), logger: quiet });
  assert.equal(r.sent, 1);
  assert.equal(sent[1].endpoint, 'https://push.example.test/tokyo');
});

test('push reminders: none when they studied today or reminders are off; dead subscriptions are removed', async () => {
  const svc = createSyncService({ db: createMemoryDb() });
  await learner(svc, 'studied', { tz: 'Europe/Berlin', days: { '2026-10-22': 1 } });
  await learner(svc, 'off', { tz: 'Europe/Berlin', reminder: { enabled: false, time: '18:00' } });
  await learner(svc, 'gone', { tz: 'Europe/Berlin' });
  const { send, sent } = sender({ fail: { 'https://push.example.test/gone': 410 } });
  const r = await sendDueReminders({ sync: svc, send, now: new Date('2026-10-22T17:00:00Z'), logger: quiet }); // 19:00 in Berlin
  assert.equal(sent.length, 0);
  assert.equal(r.removed, 1);
  assert.deepEqual(await svc.db.listSubscriptions('gone'), []);
  assert.equal((await svc.db.listSubscriptions('studied')).length, 1);
});

test('push config: needs both VAPID keys and a subject; the private key stays server-side', () => {
  assert.equal(pushConfig({}), null);
  assert.equal(pushConfig({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k' }), null);
  assert.deepEqual(pushConfig({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:a@b.c' }), { publicKey: 'p', privateKey: 'k', subject: 'mailto:a@b.c' });
});

// Lease fallback (no Web Locks): two tabs racing for the same free lease must never both win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLessonLocks, leaseKey } from '../public/lesson-lock.js';

function sharedStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}
/** In-process BroadcastChannel stand-in: async delivery to every other subscriber. */
function bus() {
  const subs = new Set();
  return () => {
    const ls = new Set();
    const ch = {
      postMessage: (data) => { for (const other of subs) if (other !== ch) setTimeout(() => { for (const l of other.ls) l({ data }); }, 0); },
      addEventListener: (_t, l) => ls.add(l),
      removeEventListener: (_t, l) => ls.delete(l),
      ls,
    };
    subs.add(ch);
    return ch;
  };
}
const timers = { setInterval: () => 0, clearInterval: () => {} };
const tab = (storage, channel, owner, extra = {}) => createLessonLocks({ locks: null, storage, channel, target: null, timers, owner, settleMs: 5, releaseOnHide: false, ...extra });

test('two tabs acquiring a free lease at the same moment: exactly one wins (100 trials)', async () => {
  for (let i = 0; i < 100; i++) {
    const storage = sharedStorage();
    const open = bus();
    const a = tab(storage, open(), 'tab-a');
    const b = tab(storage, open(), 'tab-b');
    const [ha, hb] = await Promise.all([a.acquire('L'), b.acquire('L')]);
    assert.equal([ha, hb].filter(Boolean).length, 1, `trial ${i}: exactly one holder`);
    const winner = ha ? 'tab-a' : 'tab-b';
    assert.equal(JSON.parse(storage.map.get(leaseKey('L'))).owner, winner, 'the lease names the winner');
    await (ha || hb).release();
  }
});

test('without a channel, the settle window alone keeps it exclusive', async () => {
  for (let i = 0; i < 50; i++) {
    const storage = sharedStorage();
    const [ha, hb] = await Promise.all([tab(storage, null, 'tab-a').acquire('L'), tab(storage, null, 'tab-b').acquire('L')]);
    assert.equal([ha, hb].filter(Boolean).length, 1, `trial ${i}`);
  }
});

test('channel tie-break wins even when storage has not converged (each tab sees its own write)', async () => {
  // per-tab views of storage that never converge within the settle window
  const view = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const open = bus();
  const a = tab(view(), open(), 'tab-a', { ticket: () => 0.2 });
  const b = tab(view(), open(), 'tab-b', { ticket: () => 0.7 });
  const [ha, hb] = await Promise.all([a.acquire('L'), b.acquire('L')]);
  assert.ok(ha, 'the lower ticket wins');
  assert.equal(hb, null, 'the other tab backs off');
});

test('a lease held by another tab is still refused immediately', async () => {
  const storage = sharedStorage();
  const open = bus();
  const a = tab(storage, open(), 'tab-a');
  const h = await a.acquire('L');
  assert.ok(h);
  assert.equal(await tab(storage, open(), 'tab-b').acquire('L'), null);
});

// Web Push reminders (with account sync on): the daily reminder of Phase 10, sent when no Wonder
// tab is open. A Vercel Cron job calls GET /api/cron/reminders (vercel.json); for every user with
// a push subscription it rebuilds their synced state, and when their reminder time has passed in
// their time zone and today's goal is not met, it sends the brief's top action once that day.
//
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (`npx web-push generate-vapid-keys`) and
// VAPID_SUBJECT (a mailto: or https: contact). Only the public key ever reaches a browser.

import { recordsToState } from '../public/sync-core.js';
import { dailyBrief, briefNotification, reminderDue } from '../public/brief-core.js';
import { dateKey } from '../public/deck.js';

export function pushConfig(env = process.env) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/**
 * A Date whose local fields (getHours, toLocaleDateString…) read as the wall clock in `timeZone`,
 * so the browser-side helpers (reminderDue, dailyBrief) can run unchanged on the server.
 */
export function zonedNow(now, timeZone) {
  if (!timeZone || !validZone(timeZone)) return new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** A sender over the web-push package (loaded on first use). */
export function webPushSender(cfg) {
  let lib = null;
  return async (subscription, payload) => {
    lib ??= (await import('web-push')).default;
    return lib.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
      vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
      TTL: 6 * 3600,
      urgency: 'normal',
    });
  };
}

/**
 * Send every reminder that is due now. `send(subscription, payload)` rejects with {statusCode}
 * on failure; 404 / 410 mean the browser dropped the subscription, so it is removed.
 * @returns {Promise<{checked:number, sent:number, skipped:number, removed:number}>}
 */
export async function sendDueReminders({ sync, send, now = new Date(), logger = console }) {
  const db = sync.db;
  const out = { checked: 0, sent: 0, skipped: 0, removed: 0 };
  for (const { userId, subscriptions } of await db.listPushUsers()) {
    out.checked++;
    try {
      const tz = subscriptions.find((s) => s.timeZone && validZone(s.timeZone))?.timeZone || 'UTC';
      const local = zonedNow(now, tz);
      // settings and stats decide whether it is due; the whole state only when it is
      const singles = recordsToState(await sync.list(userId, ['state']));
      if (!reminderDue(singles.settings, singles.stats, local, null)) { out.skipped++; continue; }
      if (!(await db.claimReminder(userId, dateKey(local)))) { out.skipped++; continue; }
      const state = recordsToState(await sync.list(userId));
      const { title, body } = briefNotification(dailyBrief(state, local));
      const payload = JSON.stringify({ title, body, tag: 'wonder-daily', url: '/#/' });
      for (const s of subscriptions) {
        try {
          await send(s, payload);
          out.sent++;
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) { await db.removeSubscription(userId, s.endpoint); out.removed++; }
          else logger.warn?.(`[wonder] push failed (${e?.statusCode || e?.message})`);
        }
      }
    } catch (e) {
      logger.warn?.(`[wonder] reminder check failed: ${e.message}`);
    }
  }
  return out;
}

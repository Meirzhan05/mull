// What the pricing page (public/pricing) shows, from GET /api/plans: pure, so it is tested in
// node (test/pricing.test.js). pricing.js draws it.

export const CAP_ROWS = [['lesson', 'Lessons'], ['tutor', 'Tutor messages'], ['teacher', 'Teacher messages'], ['course', 'Course plans'], ['grade', 'Graded answers']];

const TIMES = { 2: 'Twice', 3: 'Three times', 4: 'Four times', 5: 'Five times', 6: 'Six times', 8: 'Eight times', 10: 'Ten times' };

/** How Pro's caps compare to Free's: "Five times the daily limits" when every cap is that multiple. */
export function proPitch(free, pro) {
  const ratios = CAP_ROWS.map(([k]) => (free[k] > 0 && pro[k] != null ? pro[k] / free[k] : NaN));
  const r = ratios[0];
  const same = ratios.every((x) => x === r);
  return same && TIMES[r] ? `${TIMES[r]} the daily limits, for learning a lot.` : 'Higher daily limits, for learning a lot.';
}

export function freePitch(free) {
  const n = free.lesson;
  if (n == null) return 'All of Mull, with no daily limit on lessons.';
  return `Up to ${n} lesson${n === 1 ? '' : 's'} a day, with the tutor and the Teacher.`;
}

/** "$8 / month" as {amount: '$8', per: 'month'}; a one-time price has no per. */
export function splitPrice(label) {
  const [amount, per] = String(label).split(' / ');
  return { amount, per: per || null };
}

const link = (label, href, primary = false) => ({ kind: 'link', label, href, primary });
const NOT_ON_SALE = { cta: { kind: 'disabled', label: 'Not on sale yet' }, note: 'Pro opens here soon. Free has everything until then.' };

/**
 * The page for one /api/plans answer, or null when there is none (the request failed: the page
 * keeps its defaults). {noAccounts} alone for a server without accounts. Otherwise:
 * {bar, current, test, caps: {free, pro}, price: {amount, per} | null, priceLater, pitch: {free, pro}, free: {cta, note}, pro: {cta, note}}
 * where a null price keeps the page's default ($15 / month) and priceLater says to ask again for it,
 * and a cta is {kind: 'link', label, href, primary} | {kind: 'upgrade', label} | {kind: 'disabled', label}.
 */
export function pricingView(p) {
  if (!p?.ok) return null;
  if (!p.accounts) return { noAccounts: true };
  const signedIn = !!(p.signedIn && p.plan);
  const price = p.price || p.billing?.price || null;
  const view = {
    bar: signedIn ? link('Open Mull', '/#/') : link('Sign in', '/#/signin'),
    current: signedIn ? p.plan.id : null,
    test: !!p.sandbox,
    caps: { free: p.free, pro: p.pro },
    // no price yet: on sale (Polar's lookup is slow on a cold server: the default until it lands)
    // or not, or given to this user (admin, comped)
    price: price ? splitPrice(price) : p.buyable ? null : { amount: signedIn && p.plan.id === 'pro' ? 'Free for you' : 'Soon', per: null },
    priceLater: !price && !!p.buyable,
    pitch: { free: freePitch(p.free), pro: proPitch(p.free, p.pro) },
    free: { cta: signedIn ? link('Open Mull', '/#/') : link('Continue with Google', '/#/start'), note: null },
    pro: null,
  };
  if (!signedIn) {
    view.pro = p.buyable ? { cta: link('Continue with Google', '/#/start', true), note: 'Then upgrade from the You page.' } : NOT_ON_SALE;
  } else if (p.plan.id === 'pro') {
    const source = p.plan.source;
    view.pro = {
      cta: source === 'subscription' ? link('Manage on the You page', '/#/you', true) : link('Open Mull', '/#/', true),
      note: source === 'admin' ? 'Admin on this server: no daily limits.' : source === 'comped' ? 'Given to you by this Mull server.' : null,
    };
  } else if (p.billing?.canUpgrade) {
    view.pro = { cta: { kind: 'upgrade', label: price ? `Upgrade · ${price}` : 'Upgrade to Pro' }, note: null };
  } else {
    view.pro = NOT_ON_SALE;
  }
  return view;
}

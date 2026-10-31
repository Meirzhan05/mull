// The pricing page (public/pricing, served at /pricing). The daily caps and the Pro price are this
// server's own (GET /api/plans); the buttons follow the visitor (GET /api/account): signed out,
// Continue with Google; on Free, Upgrade opens a Polar checkout here, which returns to the You page
// (public/you.js finishes the upgrade); on Pro, a way to manage it.

const ROWS = [['lesson', 'Lessons'], ['tutor', 'Tutor messages'], ['teacher', 'Teacher messages'], ['course', 'Course plans'], ['grade', 'Graded answers']];

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}
async function getJson(path) {
  try {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function showCaps(id, caps) {
  $(`[data-caps="${id}"]`).replaceChildren(...ROWS.map(([k, label]) => el('li', null, el('span', null, label), el('b', null, caps[k] == null ? 'No limit' : caps[k].toLocaleString('en-US')))));
}

/** "$8 / month" as a big amount and a small period. */
function showPrice(label) {
  const [amount, per] = label.split(' / ');
  $('[data-price]').replaceChildren(el('b', null, amount), per ? ` / ${per}` : '');
}

function setCta(id, ...kids) {
  $(`[data-cta="${id}"]`).replaceChildren(...kids);
}

function markCurrent(id) {
  $(`#${id}-h`).append(el('span', { class: 'plan__current' }, 'Your plan'));
}

function upgradeButton(price) {
  const note = el('p', { class: 'plan__note', role: 'status' });
  const btn = el('button', { class: 'btn btn--primary', type: 'button' }, price ? `Upgrade · ${price}` : 'Upgrade to Pro');
  const label = btn.textContent;
  const free = () => { btn.disabled = false; btn.textContent = label; };
  // Back from Polar restores this page from the bfcache: the button is usable again
  window.addEventListener('pageshow', (e) => { if (e.persisted) free(); });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Opening checkout…';
    note.textContent = '';
    note.classList.remove('notes__error');
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => ({}));
      // already Pro (or Polar had a subscription the plan missed): the You page shows it
      if (r.status === 409) { location.href = '/#/you'; return; }
      if (r.status === 401) { location.href = '/#/signin'; return; }
      if (!r.ok || !d.url) throw new Error(d.error || 'Could not open checkout. Try again in a minute.');
      location.href = d.url;
    } catch (e) {
      free();
      note.textContent = e.message;
      note.classList.add('notes__error');
    }
  });
  return [btn, note];
}

const [plans, account] = await Promise.all([getJson('/api/plans'), getJson('/api/account')]);

if (plans?.accounts) {
  showCaps('free', plans.free);
  showCaps('pro', plans.pro);
  if (plans.price) showPrice(plans.price);
  $('[data-test]').hidden = !plans.sandbox;
}

const notOnSale = () => {
  $('[data-price]').replaceChildren(el('b', null, 'Soon'));
  setCta('pro', el('button', { class: 'btn', type: 'button', disabled: true }, 'Not on sale yet'), el('p', { class: 'plan__note' }, 'Pro opens here soon. Free has everything until then.'));
};

if (plans && !plans.accounts) {
  // a server without accounts: one learner and no caps, so there is nothing to choose
  for (const id of ['free', 'pro']) setCta(id, el('a', { class: 'btn', href: '/#/' }, 'Open Mull'));
  $('.notes').prepend(el('p', null, el('b', null, 'This Mull server has no accounts, so it has no daily limits.')));
} else if (account?.signedIn && account.plan) {
  const { plan, billing } = account;
  markCurrent(plan.id);
  setCta('free', el('a', { class: 'btn', href: '/#/' }, 'Open Mull'));
  if (plan.id === 'pro') {
    setCta('pro', plan.source === 'subscription'
      ? el('a', { class: 'btn btn--primary', href: '/#/you' }, 'Manage on the You page')
      : el('a', { class: 'btn btn--primary', href: '/#/' }, 'Open Mull'),
    plan.source === 'admin' ? el('p', { class: 'plan__note' }, 'Admin on this server: no daily limits.')
      : plan.source === 'comped' ? el('p', { class: 'plan__note' }, 'Given to you by this Mull server.') : null);
  } else if (billing?.canUpgrade) {
    setCta('pro', ...upgradeButton(billing.price || plans?.price));
  } else {
    notOnSale();
  }
} else if (plans && !plans.buyable) {
  notOnSale();
}

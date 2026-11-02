// The pricing page (public/pricing, served at /pricing). One request, GET /api/plans, says this
// server's daily caps, the Pro price and, for a signed-in visitor, their plan; pricing-core.js
// turns it into what to show. On Free, Upgrade opens a Polar checkout from here (Back from it
// returns here; paying lands on the You page, which finishes the upgrade: public/you.js).

import { el } from '/ui.js';
import { openBilling } from '/billing-client.js';
import { CAP_ROWS, pricingView } from '/pricing/pricing-core.js';

const $ = (sel) => document.querySelector(sel);

async function getJson(path) {
  try {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const capText = (n) => (n == null ? 'No limit' : n.toLocaleString('en-US'));

function upgrade(label) {
  const note = el('p', { class: 'plan__note', role: 'status' });
  const btn = el('button', { class: 'btn btn--primary', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Opening checkout…';
    note.textContent = '';
    note.classList.remove('is-error');
    try {
      const { resynced } = await openBilling('/api/billing/checkout', { from: 'pricing' });
      // Polar already had a subscription the plan missed: the server synced it
      if (resynced) {
        note.textContent = resynced;
        btn.replaceWith(el('a', { class: 'btn btn--primary', href: '/#/you' }, 'See it on the You page'));
        return;
      }
    } catch (e) {
      if (e.status === 401) { location.href = '/#/signin'; return; }
      note.textContent = e.message;
      note.classList.add('is-error');
    }
    btn.disabled = false;
    btn.textContent = label;
  });
  return [btn, note];
}

function cta({ cta: c, note }) {
  const button = c.kind === 'upgrade' ? upgrade(c.label)
    : c.kind === 'disabled' ? [el('button', { class: 'btn', type: 'button', disabled: true }, c.label)]
      : [el('a', { class: c.primary ? 'btn btn--primary' : 'btn', href: c.href }, c.label)];
  return note ? [...button, el('p', { class: 'plan__note' }, note)] : button;
}

function drawPrice(price) {
  if (price) $('[data-price]').replaceChildren(el('b', null, price.amount), price.per ? ` / ${price.per}` : '');
}

function draw(view) {
  if (view.noAccounts) {
    // a server without accounts: one learner and no caps, so there is nothing to choose
    $('.plans').hidden = true;
    $('.notes').replaceChildren(el('p', null, 'This Mull server has no accounts, so it has no daily limits and nothing to buy.'),
      el('p', null, el('a', { class: 'btn', href: '/#/' }, 'Open Mull')));
    return;
  }
  const bar = $('[data-bar]');
  bar.textContent = view.bar.label;
  bar.href = view.bar.href;
  for (const id of ['free', 'pro']) {
    $(`[data-caps="${id}"]`).replaceChildren(...CAP_ROWS.map(([k, label]) => el('li', null, el('span', null, label), el('b', null, capText(view.caps[id][k])))));
    $(`[data-for="${id}"]`).textContent = view.pitch[id];
    $(`[data-cta="${id}"]`).replaceChildren(...cta(view[id]));
  }
  drawPrice(view.price);
  if (view.current) $(`#${view.current}-h`).append(el('span', { class: 'plan__current' }, 'Your plan'));
  $('[data-test]').hidden = !view.test;
}

let view = null;
try {
  view = pricingView(await getJson('/api/plans'));
  if (view) draw(view);
} finally {
  // the buttons and price were hidden until known (index.html): without an answer, the defaults show
  document.documentElement.classList.remove('is-loading');
}
// the server kept looking the price up after answering without it: ask once more for the card
if (view?.priceLater) {
  await new Promise((r) => setTimeout(r, 2500));
  drawPrice(pricingView(await getJson('/api/plans'))?.price);
}

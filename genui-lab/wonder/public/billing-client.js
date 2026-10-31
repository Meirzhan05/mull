// Opening Polar from the browser (public/you.js and the pricing page, public/pricing): POST a
// billing route that answers {url} (server/app.js), then go there.

/**
 * POST `path` (with `body`, if any) and leave for the URL it answers. Resolves {resynced: message}
 * when the server found a subscription the plan had missed (409 resynced): the caller redraws.
 * Throws the server's message (with its `status`) on any other failure. Otherwise it resolves only
 * once the page is back (Back restores it from the bfcache: pageshow) or the navigation clearly
 * never happened (still here and visible after 15 s), so a busy button stays busy meanwhile.
 */
export async function openBilling(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 409 && d.resynced) return { resynced: d.error };
  if (!r.ok || !d.url) throw Object.assign(new Error(d.error || 'That did not work'), { status: r.status });
  location.href = d.url;
  await new Promise((resolve) => {
    window.addEventListener('pageshow', resolve, { once: true });
    const check = () => (document.visibilityState === 'visible' ? resolve() : setTimeout(check, 15000));
    setTimeout(check, 15000);
  });
  return {};
}

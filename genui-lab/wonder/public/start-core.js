// Where the landing page's "Continue with Google" leads (#/start[/<topic>]): with accounts on,
// sign-in comes first; a new account then goes through onboarding, whose last step offers the
// topic the visitor brought; someone already onboarded starts that lesson straight away.
// Pure, so the route in public/app.js stays thin and this stays testable.

/**
 * @param {{accounts: boolean, signedIn: boolean, needsOnboarding: boolean, topic?: string}} s
 * @returns {{action: 'signin' | 'onboard' | 'lesson' | 'home', topic: string}}
 */
export function startAction({ accounts, signedIn, needsOnboarding, topic = '' }) {
  const t = String(topic || '').trim().slice(0, 200);
  if (accounts && !signedIn) return { action: 'signin', topic: t };
  if (needsOnboarding) return { action: 'onboard', topic: t };
  return { action: t ? 'lesson' : 'home', topic: t };
}

/** The topic in a #/start/<topic> hash ('' for #/start or an undecodable one). */
export function startTopic(hash) {
  const m = /^#\/start(?:\/(.*))?$/.exec(hash || '');
  if (!m || !m[1]) return '';
  try { return decodeURIComponent(m[1]).trim().slice(0, 200); } catch { return ''; }
}

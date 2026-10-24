// The inline "Connection lost — Retry" control shared by the lesson tail, tutor replies and
// Teacher replies (classification and backoff live in stream-client.js).
//
//   const rc = retryControl({ onRetry });
//   rc.show('Connection lost.', 'Retry from here')   a failure the learner retries by hand
//   await rc.countdown(ms, 'Connection lost.', signal)  the one automatic retry: counts down,
//                                                    "Retry now" ends the wait early; false
//                                                    when `signal` aborted (screen left)
//   rc.hide()

import { el, icon } from './ui.js';

export function retryControl({ onRetry, className = '' } = {}) {
  const text = el('span', { class: 'stream-retry-text' });
  const label = el('span', null, 'Retry');
  const btn = el('button', { class: 'btn btn-sm stream-retry-btn', type: 'button' }, icon('refresh'), label);
  const node = el('div', { class: `stream-retry ${className}`.trim(), role: 'status', 'aria-live': 'polite', hidden: true }, text, btn);
  let skip = null; // ends a running countdown early
  let tick = null;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    if (skip) { skip(); return; }
    btn.disabled = true;
    onRetry?.();
  });
  const stop = () => { clearInterval(tick); tick = null; skip = null; };
  return {
    el: node,
    show(message, action = 'Retry') {
      stop();
      text.textContent = message;
      label.textContent = action;
      btn.disabled = false;
      node.hidden = false;
      node.dataset.state = 'failed';
    },
    countdown(ms, message, signal) {
      stop();
      node.hidden = false;
      node.dataset.state = 'waiting';
      label.textContent = 'Retry now';
      btn.disabled = false;
      const end = Date.now() + ms;
      const render = () => { text.textContent = `${message} Retrying in ${Math.max(1, Math.ceil((end - Date.now()) / 1000))}s…`; };
      render();
      tick = setInterval(render, 250);
      return new Promise((resolve) => {
        if (signal?.aborted) { stop(); resolve(false); return; }
        const done = (ok) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); stop(); node.hidden = true; resolve(ok); };
        const onAbort = () => done(false);
        const t = setTimeout(() => done(true), ms);
        skip = () => done(true);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    hide() { stop(); node.hidden = true; },
    get visible() { return !node.hidden; },
  };
}

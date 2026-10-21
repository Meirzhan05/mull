// One DIL surface = one sandbox worker + one DOM host (the real client keeps one renderer per
// message). The worker runs chatgpt-dil's runtime plus the learning catalog; the host is
// chatgpt-dil's DOM renderer (binary op buffers, rAF coalescing, streaming word fade).

import { createHost } from '../../chatgpt-dil/src/host.js';

export class DilSurface {
  constructor(mount, { onAction, onError } = {}) {
    this.mount = mount;
    this.onAction = onAction || (() => {});
    this.onError = onError || ((e) => console.warn('[dil]', e.phase, e.message));
    this.generation = 0;
    this.last = null;
    this.worker = new Worker(new URL('./wonder-worker.js', import.meta.url), { type: 'module' });
    this.host = createHost(mount, {
      invoke: (fnId, args) => this.worker.postMessage({ type: 'invokeFunction', fnId, args }),
      onAction: (a) => this.onAction(a),
    });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ops') this.host.apply(m);
      else if (m.type === 'hostAction') this.onAction(m.action);
      else if (m.type === 'error') this.onError(m.error);
    };
    this.worker.onerror = (e) => this.onError({ phase: 'worker', message: e.message || 'DIL worker failed to load' });
    this.worker.postMessage({ type: 'init', viewportWidth: mount.clientWidth || 720, binary: true });
    this.ro = new ResizeObserver(() => {
      const w = Math.round(this.mount.clientWidth);
      if (w && w !== this.lastWidth) { this.lastWidth = w; this.worker.postMessage({ type: 'viewport', width: w }); }
    });
    this.ro.observe(mount);
  }

  /** Render a DIL program ({code, constants}) with appData. */
  render({ code, constants, appData }, { animated = false } = {}) {
    this.last = { code, constants, appData };
    this.worker.postMessage({ type: 'render', source: code, constants, appData: appData || {}, animated, sourceGeneration: ++this.generation });
  }

  /** Re-render the current program with new appData (e.g. server componentResults). */
  setAppData(appData) {
    if (!this.last) return;
    this.render({ ...this.last, appData });
  }

  destroy() {
    try { this.ro.disconnect(); } catch {}
    try { this.worker.terminate(); } catch {}
    this.host.clear();
  }
}

export function mergeComponentResults(appData, componentResults) {
  const base = appData && typeof appData === 'object' ? appData : {};
  const op = base.opGenui || {};
  return { ...base, opGenui: { ...op, componentResults: { ...(op.componentResults || {}), ...(componentResults || {}) } } };
}

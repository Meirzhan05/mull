// One DIL surface = one sandbox worker + one DOM host (the real client keeps one renderer per
// message). The worker runs chatgpt-dil's runtime plus the learning catalog; the host is
// chatgpt-dil's DOM renderer (binary op buffers, rAF coalescing, streaming word fade).
//
// Widget state: `viewState` (a saved snapshot, see view-state.js) is posted to the worker
// before the first render so widgets mount in their saved state; `onViewState(snapshot)`
// receives debounced changes for the caller to persist with its lesson / message.

import { createHost } from '../../chatgpt-dil/src/host.js';
import { figureImageSrcs } from './figure-hosts.js';

// A remote image loads only when the server resolved that exact URL for a <Figure/> (a credited
// Wikimedia Commons image in this surface's componentResults). Any other remote src, including
// one the model wrote into a raw <image> primitive, keeps the host's placeholder: no tracking
// pixels, and no Commons image shown without its license credit.
export function createFigureImagePolicy() {
  const allowed = new Set();
  const policy = (src) => allowed.has(src);
  policy.update = (appData) => { for (const s of figureImageSrcs(appData)) allowed.add(s); };
  return policy;
}

export class DilSurface {
  constructor(mount, { onAction, onError, viewState, onViewState } = {}) {
    this.mount = mount;
    this.onAction = onAction || (() => {});
    this.onError = onError || ((e) => console.warn('[dil]', e.phase, e.message));
    this.onViewState = onViewState || null;
    this.generation = 0;
    this.last = null;
    this.worker = new Worker(new URL('./wonder-worker.js', import.meta.url), { type: 'module' });
    this.imagePolicy = createFigureImagePolicy();
    this.host = createHost(mount, {
      invoke: (fnId, args) => this.worker.postMessage({ type: 'invokeFunction', fnId, args }),
      onAction: (a) => this.onAction(a),
      allowRemoteImages: this.imagePolicy,
    });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ops') { if (!this.destroyed) this.host.apply(m); }
      else if (m.type === 'hostAction') this.onAction(m.action);
      else if (m.type === 'error') this.onError(m.error);
      else if (m.type === 'viewState') { try { this.onViewState?.(m.snapshot); } catch (err) { console.warn('[dil] viewState', err); } }
      else if (m.type === 'viewStateFlushed') this.finishDestroy?.();
    };
    this.worker.onerror = (e) => this.onError({ phase: 'worker', message: e.message || 'DIL worker failed to load' });
    if (viewState) this.worker.postMessage({ type: 'setStateSnapshot', snapshot: viewState });
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
    this.imagePolicy.update(appData); // before the worker's ops arrive
    this.worker.postMessage({ type: 'render', source: code, constants, appData: appData || {}, animated, sourceGeneration: ++this.generation });
  }

  /** Re-render the current program with new appData (e.g. server componentResults). */
  setAppData(appData) {
    if (!this.last) return;
    this.render({ ...this.last, appData });
  }

  /** Replace the worker's saved widget state (mounted widgets keep their live state). */
  setViewState(snapshot) { this.worker.postMessage({ type: 'setStateSnapshot', snapshot: snapshot || null }); }

  /** Drop saved state for widgets that are not in `ids` (or whose props changed). */
  pruneViewState(ids) { this.worker.postMessage({ type: 'pruneViewState', keep: [...(ids || [])] }); }

  /** Clear all saved widget state and remount the program fresh. */
  resetViewState() { this.worker.postMessage({ type: 'resetViewState' }); }

  destroy() {
    try { this.ro.disconnect(); } catch {}
    this.destroyed = true;
    this.host.clear();
    // let a pending (debounced) widget-state change reach onViewState before terminating
    let done = false;
    this.finishDestroy = () => { if (done) return; done = true; try { this.worker.terminate(); } catch {} };
    if (!this.onViewState) { this.finishDestroy(); return; }
    try { this.worker.postMessage({ type: 'flushViewState' }); } catch { this.finishDestroy(); return; }
    setTimeout(this.finishDestroy, 500);
  }
}

export function mergeComponentResults(appData, componentResults) {
  const base = appData && typeof appData === 'object' ? appData : {};
  const op = base.opGenui || {};
  return { ...base, opGenui: { ...op, componentResults: { ...(op.componentResults || {}), ...(componentResults || {}) } } };
}

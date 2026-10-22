// chatgpt-dil's DOM-free DIL runtime + the Wonder learning catalog.
//
// The stock runtime binds its own catalog (AsyncImage, Entity, Cite, StockChart, LearningQuiz)
// as free identifiers of the program Function. Rather than fork it, Wonder prepends a prelude
// to each program source that evaluates the self-contained learning catalog *inside the same
// sandboxed Function scope* (same DIL/__dil/GenUI facades, same shadowed globals). Component
// identity across streamed revisions is preserved because the reconciler matches components
// by function name.
//
// Widget state persistence (view-state.js) also lives here, since the stock runtime's useState
// ignores {key, widgetId} and has no snapshot API: a per-runtime store is handed to the catalog
// as a non-enumerable `appData.__wonderViewState`; `setStateSnapshot` loads it before the first
// render and `onViewState(snapshot)` reports debounced changes.
//
// Paths are relative so the same module works under node:test and in the browser (the server
// serves genui-lab/chatgpt-dil/src at /chatgpt-dil/src/).

import { createRuntime, encodeOps, createMirror } from '../../chatgpt-dil/src/runtime.js';
import { LEARNING_PRELUDE, LEARNING_COMPONENT_NAMES } from './learning-catalog.js';
import { EXTRAS_PRELUDE } from './catalog-extras.js'; // Phase 3+5: Cite/Sources/FunctionGraph
import { MEDIA_PRELUDE } from './catalog-media.js'; // Diagram
import { createViewStateStore, VIEW_STATE_DEBOUNCE_MS } from './view-state.js';

export { encodeOps, createMirror, LEARNING_COMPONENT_NAMES };

export function withLearningCatalog(source) {
  return source ? LEARNING_PRELUDE + EXTRAS_PRELUDE + MEDIA_PRELUDE + source : source;
}

/**
 * @param {object} opts createRuntime options, plus
 * @param {object} [opts.viewState]                    initial snapshot (same as setStateSnapshot)
 * @param {(snapshot:object)=>void} [opts.onViewState] debounced widget-state changes
 * @param {number} [opts.viewStateDebounceMs]          default 300
 */
export function createLearningRuntime(opts = {}) {
  const rt = createRuntime(opts);
  const vs = createViewStateStore({ initial: opts.viewState, onChange: opts.onViewState, debounceMs: opts.viewStateDebounceMs ?? VIEW_STATE_DEBOUNCE_MS });
  const baseRender = rt.render;
  let lastMsg = null;
  const withStore = (ad) => {
    const a = ad && typeof ad === 'object' ? { ...ad } : {};
    Object.defineProperty(a, '__wonderViewState', { value: vs.api, enumerable: false });
    return a;
  };
  const render = (msg = {}) => {
    lastMsg = msg;
    return baseRender({ ...msg, source: withLearningCatalog(msg.source), appData: withStore(msg.appData) });
  };
  return {
    ...rt,
    render,
    /** Replace the saved snapshot. Mounted widgets keep their live state; new mounts read it. */
    setStateSnapshot(snapshot) { vs.load(snapshot); },
    /** Drop saved state of widgets not in `keepIds` or whose props changed since it was saved. */
    pruneViewState(keepIds) { vs.prune(keepIds); },
    /** Forget every saved widget state and remount the program so widgets start fresh. */
    resetViewState() {
      vs.clear();
      rt.reset();
      if (lastMsg) render(lastMsg);
    },
    viewStateSnapshot: () => vs.snapshot(),
    flushViewState: () => vs.flush(),
    destroy() { vs.cancel(); rt.destroy(); },
  };
}

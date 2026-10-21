// Wonder DIL sandbox worker: chatgpt-dil's worker protocol (init/render/invokeFunction/
// viewport/reset -> ops/hostAction/error/completion) around the learning-catalog runtime.

import { createLearningRuntime, encodeOps } from './learning-runtime.js';

const post = self.postMessage.bind(self);
let useBinary = true;
let runtime = null;

// Best-effort network lockdown; program code additionally sees these names shadowed.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Worker']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch {}
}

function ensure(viewportWidth) {
  if (runtime) return runtime;
  runtime = createLearningRuntime({
    viewportWidth,
    onOps(ops, meta) {
      if (useBinary) {
        const { buffer, strings } = encodeOps(ops);
        post({ type: 'ops', buffer, strings, meta, count: ops.length }, [buffer]);
      } else {
        post({ type: 'ops', ops, meta, count: ops.length });
      }
    },
    onHostAction(action) { post({ type: 'hostAction', action }); },
    onError(error) { post({ type: 'error', error }); },
  });
  return runtime;
}

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    switch (m.type) {
      case 'init': useBinary = m.binary !== false; ensure(m.viewportWidth ?? 1024); break;
      case 'render': ensure(1024).render(m); break;
      case 'invokeFunction': {
        const result = ensure(1024).invokeFunction(m.fnId, m.args || []);
        if (m.completionId != null) post({ type: 'completion', completionId: m.completionId, result });
        break;
      }
      case 'viewport': ensure(m.width).setViewport(m.width); break;
      case 'reset': if (runtime) runtime.reset(); break;
      default: post({ type: 'error', error: { message: `unknown message ${m.type}`, phase: 'protocol' } });
    }
  } catch (err) {
    post({ type: 'error', error: { message: err && err.message ? err.message : String(err), phase: m.type } });
  }
};

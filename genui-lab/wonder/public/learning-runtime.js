// chatgpt-dil's DOM-free DIL runtime + the Wonder learning catalog.
//
// The stock runtime binds its own catalog (AsyncImage, Entity, Cite, StockChart, LearningQuiz)
// as free identifiers of the program Function. Rather than fork it, Wonder prepends a prelude
// to each program source that evaluates the self-contained learning catalog *inside the same
// sandboxed Function scope* (same DIL/__dil/GenUI facades, same shadowed globals). Component
// identity across streamed revisions is preserved because the reconciler matches components
// by function name.
//
// Paths are relative so the same module works under node:test and in the browser (the server
// serves genui-lab/chatgpt-dil/src at /chatgpt-dil/src/).

import { createRuntime, encodeOps, createMirror } from '../../chatgpt-dil/src/runtime.js';
import { LEARNING_PRELUDE, LEARNING_COMPONENT_NAMES } from './learning-catalog.js';

export { encodeOps, createMirror, LEARNING_COMPONENT_NAMES };

export function withLearningCatalog(source) {
  return source ? LEARNING_PRELUDE + source : source;
}

export function createLearningRuntime(opts) {
  const rt = createRuntime(opts);
  const baseRender = rt.render;
  return {
    ...rt,
    render(msg = {}) {
      return baseRender({ ...msg, source: withLearningCatalog(msg.source) });
    },
  };
}

# chatgpt-dil — a working reconstruction of ChatGPT's DIL generative-UI runtime

This is a dependency-free rebuild of the "DIL" pipeline described in `re/chatgpt-findings.md`. It uses plain ES modules and one module Web Worker, with no npm packages and no build step. Everything runs from local files. Nothing contacts chatgpt.com or any OpenAI endpoint.

```
model output (markdown + <box>/<Entity/>/… markup)
   │  src/compiler.js         recompiled on every streamed revision
   ▼
DIL program {code, constants, requiredComponents}      ◄── or the server's own dil.code from the stream
   │  src/worker.js → src/runtime.js   Function("DIL","__dil","GenUI","Date", code), hooks reconciler,
   │                                   catalog components (src/catalog.js)
   ▼
render ops (binary Uint32/Float64 buffer + string table, transferred)
   │  src/host.js              rAF-coalesced DOM application, data-d-* primitives, token mapping,
   ▼                           per-word streaming fade
DOM                            function props round-trip as invokeFunction(fnId)
```

`src/stream.js` parses and validates the `application/vnd.openai.conversation-source+ndjson` stream. It folds the records into message state (revision, append/replace, dil) and replays them.

## Running

```sh
node --test genui-lab/chatgpt-dil/test/          # 32 tests (Node ≥ 22; `test/index.js` loads every *.test.js)
python3 -m http.server 8731 --directory genui-lab
open http://localhost:8731/chatgpt-dil/index.html
```

The demo page has three tabs:

- **Stream replay.** Feeds the 87 captured records through the parser and turn reducer with a configurable delay. You can switch between two sources:
  - **Server `dil.code`**: runs the program the server sent in each record.
  - **Local compiler**: recompiles the accumulated markdown with `compiler.js` on each revision, while component data still comes from the record's `appData`.

  Both sources render the Tokyo weather card and the AAPL stock card. The side panel shows the record log, revision, op and frame counts, and the host actions you trigger by clicking the entity, a citation, an image or a chart range.
- **Playground.** Edit DIL markup and it recompiles on each keystroke. "Simulate streaming" compiles growing prefixes in partial mode, the way the server does. The compiled code and constants are shown below the preview.
- **LearningQuiz.** `<LearningQuiz/>` is compiled and bound to a demo `componentResults` entry. It covers hint, answer feedback, navigation, a results view with a celebration, restart, and "Next quiz" (an `issue_new_turn` host action).

Remote images (`images.openai.com` thumbnails in the capture) are **off by default** and render as placeholders. The "Load remote images" checkbox opts in.

## How each part maps to the evidence

| Part | Evidence (findings §) | What is reproduced |
|---|---|---|
| `compiler.js` | §3.1 (code is JSX-compiled `__dil.jsx`), fixture `final-dil.json`, all 44 `dil` payloads in the stream | **Byte-for-byte output.** `compile(final-markdown.md)` equals the server `dil.code` and `constants`. Every streamed revision also recompiles to exactly the server program; this is asserted in the tests. Observed rules: <br>• `#` becomes `title` size xl, `##` becomes lg. Paragraphs and bare text become `text`. `**`/`*` become `bold`/`italic`.<br>• All text is hoisted into `__dilConstants` in document order.<br>• Capitalized tags become free globals inside `__dilSafe(()=>(…),null)`, so a component that isn't loaded is a ReferenceError that renders `null`.<br>• `__resolutionId` is hoisted last. `Entity.value` and `Cite.refs` are hoisted; other props are inline JSON.<br>• One block renders with no Fragment; zero blocks render `null`. The `__dilSafe` prelude only appears when a component is used.<br>• Root is `{"key":"body:0"}`.<br>• **Streaming:** a half-written tag at the tail is dropped, but a placeholder keeps the preceding whitespace. Unclosed elements are auto-closed, and auto-closed elements with no content are pruned. An empty heading is still emitted. |
| `stream.js` | §1.2 | Version 1 or 2, the 10 known record types, a 6 MiB per-record limit, nothing after `end`, and a terminal `end` is required. The `content` validator checks messageId, revision, `append` needs `baseRevision`, status, and the dil key allow-list (kind/renderer/status/code, 256 KiB cap). The reducer applies `markdown = append ? prev+md : md`, requires strictly increasing revisions, raises `revision mismatch`, and keeps the previous `dil` when a record has none. The replayer accepts a configurable delay. |
| `runtime.js` (worker core, DOM-free) | §3.1 program shape and `createDILRuntimeApiFacade`; §3.2 op codes and value tags; §3.4 wrapper and data resolution | Evaluates with `Function("DIL","__dil","GenUI","Date", …, '"use strict";\n'+code)`. Implements `__dil.jsx/Fragment` and `DIL.render/useState/useEffect/useMemo/useRef/useCallback/useConstants/useAppData/useBreakpoint/useIsMobile/useId`, with inert stubs for messenger, dictation and speech. The keyed/indexed hooks reconciler emits `createElement/createText/destroy/move/propChanged/textChanged`. Function props travel as `{__fn:id}` and come back through `invokeFunction`. `encodeOps/decodeOps` implement the little-endian u32/f64 op buffer: opcodes 1–6 and value tags 0–8 (undef, null, false, true, f64, string idx, array, object, function), with de-duplicated strings. The `GenUI` facade provides `dispatchAction`, `dispatchWidgetAction`, `issueNewTurn`, `openUrl`, `openEntityDetail`, `openImageLightbox`, `logEvent` and `refreshWidget`, each producing a `{handler, type, payload}` host action. There is an optional frozen-clock `Date`. |
| `worker.js` | §3.2 `DILSandboxWorker`, `DILSandboxGlobals` | Message protocol `init/render/invokeFunction/viewport/reset`. Ops are sent as a transferred `ArrayBuffer`. Network globals are best-effort locked on `self`. Inside the program scope, `fetch`, `XMLHttpRequest`, `importScripts`, `WebSocket`, `self`, `globalThis`, `Function` and others are shadowed as `undefined`. |
| `catalog.js` | §3.4 wrapper pattern and `componentResults`; §3.5 quiz | `OpGenuiResolvedComponentBoundary` handles pending (skeleton), failed (`props.fallback` or nothing) and resolved states. Widget-scoped GenUI routes server actions to `dispatchWidgetAction` with `nativeWidgetResolutionId` and `componentName`. The components:<br>• **AsyncImage** uses `state.images[0]` (thumbnail_url, crop info, frame/aspect/radius).<br>• **Entity** renders an inline pill and dispatches the server `click_action` (`open_entity_detail`).<br>• **Cite** renders a citation pill from `state.items`, for example "StockAnalysis.com +1", and opens the URL on click.<br>• **StockChart** builds an `svg` with area, line, baseline and last point from `state.timeframe_configs[range].chart.data`. The range is local `useState`, alongside after-hours info, `metrics_display` and `_mobile` via `useIsMobile`, and a no-data fallback.<br>• **LearningQuiz** has a state machine over `current_index/answers/selected_values/hint_open/attempt`. It supports single_select, multi_select and true_false, plus feedback, hint, navigation, results with `celebration`, restart, and `issue_new_turn` for the next quiz. `learning_quiz_answer`/`restart` server actions are sent only when `nativeServerActions.ready`. |
| `host.js` + `dil.css` | §3.3 element types, renderer aliases and `data-d-*`; [DOM] capture; §5 streaming | Covers about 40 primitives: box, row, col, grid, grid-item, flow, card, text, title (h1–h4 by size; span when inline), caption, label, bold, italic, underline, strikethrough, code, badge, icon, image, search-image, divider, spacer, pressable, button, list (ul/ol + `data-d-marker`), list-item, link, svg with path/line/circle/rect/polyline/g, carousel, carousel-item, celebration (confetti), loading-block (shimmer), loading-indicator, math (plain text), text-only-markdown, markdown, blockquote, table, table-row and table-cell. It writes `data-d-component` (the DIL name verbatim), `data-d-direction`, `data-d-inline`, `data-d-auto-spacing`, `data-d-frame`, `data-d-marker(-layout)` and `data-d-streaming-word`. `RENDERER_ALIASES` is the §3.3 table. Tokens:<br>• Spacing is `calc(var(--d-spacing) * n)` with 0.25rem.<br>• Radius xl is 0.75rem; full is 9999px.<br>• Colors such as secondary, danger, subtle, surface-tertiary and the `alpha-*` tokens map to variables, and hex values pass through.<br>• There is a text and title size scale from xs to 3xl.<br>Op batches are applied once per animation frame (§1.2 rAF coalescing). A 200 ms timeout fallback covers hidden tabs. Appended text is split into word spans with staggered `--stream-word-delay`. |
| `app.js` | §1.2 coalescing, §3.6 actions | Content updates go through rAF coalescing, and `complete` content renders immediately. Host actions are logged and toasted; they are never executed against real services. |

## Faithful vs. simplified

**Faithful (verified against captured data)**
- Compiler output matches the server's `dil.code` and `constants` exactly for the final message and for all 44 intermediate revisions.
- The real server programs (`final-dil.json` and every streamed `dil`) execute unchanged in the runtime and render all text plus the StockChart, AsyncImage, Entity and Cite widgets from the captured `componentResults`.
- The stream format, validation rules and append/revision semantics follow `conversation-source-client`.

**Simplified or assumed**
- **Unseen compiler output.** The fixture has no lists, code fences, tables, links, blockquotes or math, so their compiled form is my choice: `list/list-item`, `markdown` (raw fence/table), `link{href}`, `blockquote`, and `math{display}`. Only the `Entity.value` and `Cite.refs` hoisting is observed. Non-literal `{expr}` attribute values degrade to their source string instead of being emitted as code.
- **Resolution ids.** The server mints v5-style UUIDs and resolves components itself. Locally, `defaultResolutionId` produces deterministic UUID-shaped hashes, and `resolutionIdsFromProgram` reuses the server ids, by order of each component name, so local compilation can bind to server `appData`.
- **Reconciler.** Every state change re-renders from the root with keyed/indexed matching. Fresh function identities across revisions are matched by component name or by the keyed anonymous body, in the role `DILSemanticKey` plays. Components render inside a per-component error boundary. There is no concurrent rendering, `commit(renderSequence)` handshake, or state persistence (`viewState`/`DILStatePersistence`).
- **Sandbox.** Lockdown is best-effort (shadowed names plus a few `self` properties), not the real allow-list-and-freeze of every global. `(()=>{}).constructor` can still reach `Function`. Opcode 7 (opaque children) and value tags 10–12 (element, opaque, HtmlViewMessenger) are not implemented. Element-valued props on primitives become `null`.
- **Catalog.** The components are written from the observed state shapes, not ported from the real `<Name>.generated` sources. The real LearningQuiz merges server snapshots by attempt, sequence and revision; here progress is local only. StockChart has no hover or scrubbing.
- **Host.** It uses its own design tokens, not ChatGPT's StyleX output. Math is a plain-text fallback with no KaTeX. Icons are a small hand-drawn set. `svg` children are a reconstruction extension, because the real `Svg` primitive's input format is unknown.
- **Not implemented.** Skybridge iframes, `/widget_server_action` round-trips, media/DPU `<template for>` patches and steering. Server actions are only surfaced as host-action log entries.

## Files

```
index.html                 demo page
src/compiler.js            markup → DIL program (+ resolutionIdsFromProgram, toDilPayload)
src/runtime.js             DOM-free sandbox core: jsx, hooks reconciler, DIL/GenUI facades, op buffer, mirror
src/catalog.js             AsyncImage, Entity, Cite, StockChart, LearningQuiz, OpGenuiResolvedComponentBoundary
src/worker.js              module Web Worker transport around runtime.js
src/host.js                main-thread DOM renderer, token mapping, streaming word fade
src/icons.js, src/dil.css  primitive icon set and styles
src/stream.js              NDJSON conversation-source parser/validator, turn reducer, replayer
src/app.js, src/app.css    demo wiring
src/demo-data.js           playground sample + quiz state
test/*.test.js             node:test suites (test/index.js aggregates them)
fixtures/                  captured stream, final dil, final markdown
```

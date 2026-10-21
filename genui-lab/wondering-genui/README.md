# wondering-genui: a reconstruction of wondering.app's generative lesson UI

This is a dependency-free rebuild of the system wondering.app uses to let an LLM "render UI" in lessons, chat and the voice tutor. It is plain ES modules and vanilla DOM components. There are no npm packages and no build step. It was rebuilt from static reading of the shipped JS only (`re/wondering-findings.md`, plus the main bundle `index-7fdxy4xw.js` and lazy chunks in `re/wondering-lazy/`). Nothing in this folder contacts wondering.app, Supabase or any other backend. Every stream is mocked locally.

```
node --test genui-lab/wondering-genui/test/      # 80 tests (also: cd wondering-genui && npm test)
python3 -m http.server 8732 --directory genui-lab
open http://localhost:8732/wondering-genui/
```

## Architecture

```
model output (markdown + {{interactive:name k=v data='{…}'}})
   │            ▲ server side: {embed:{type,…}, insertAfterParagraph:n} -> embeds.js
   ▼
markdown.js  normalizeLatexDelimiters ─▶ markers.processInteractiveComponents ─▶ block/inline parser
             (\( \) \[ \] $…$ -> $$…$$)  (marker -> %%%INTERACTIVE_n%%% + placeholderMap) │
                                                                                         ▼
             DOM render: paragraphs/lists/quotes/code/math, keyword buttons, citation chips,
             placeholder swap -> renderInteractiveEntry (error boundary) -> components/registry.js
                                                                                         │
components/  lesson.js (lesson-*, wondering-lens)  visual.js (visual-*)  dataviz.js (SVG charts)
             registry.js: all 100 INTERACTIVE_COMPONENTS keys, unbuilt ones -> placeholder

sse.js        course-chat line SSE + reducer   │ teacher-chat event-framed SSE + card reducer
voice-visuals strict validators -> toVisualComponentProps -> board reducer + tool handlers
fsrs.js       ts-fsrs v5 port (shipped defaults) + rating mapping;  practice.js answer validators
app.js        demo: lesson page · simulated lesson chat · voice board · practice session
```

Everything except `app.js` and the `render*` / component functions can run without a DOM. Components only touch `document` when they are called, so every module, the registry included, imports cleanly in Node.

## Module → evidence map

Offsets are byte offsets into `index-7fdxy4xw.js` unless a chunk is named. § refers to `re/wondering-findings.md`.

| Module / export | Evidence | Fidelity |
|---|---|---|
| `markers.js` `createMarkerRegex` | §1.1, `processInteractiveComponents` @4091499. Regex copied verbatim. | Exact |
| `parseComponentParams`, `parseValue` | @4093110. Covers the `(\w+)=("…"\|'…'\|\S+)` pairs, junk between pairs (which makes the marker invalid), JSON for `[ { true false null` with a retry after un-escaping `\"`, the numeric regex, and the rule that `data=` must be a non-array object. | Exact, with one deviation: a value like `5.` passes the numeric regex, and the shipped `JSON.parse("5.")` throws out of the whole pass. Here the trailing dot is stripped instead. |
| `processInteractiveComponents` | @4091499. Empty-name warning, unknown-name `console.warn` and telemetry, `rejectInvalidMarkers` (all markers dropped while `isStreaming`; invalid markers dropped), reserved `instanceId` (first use only) and `altText`, placeholders `%%%INTERACTIVE_n%%%`. | Exact. The telemetry callback also receives `requestedName`, because the shipped event sends `componentName:"unknown"`. |
| `reserveUnknownComponentReport` | @4090800. LRU of 100 sessions × 100 names. | Exact |
| `removeUnrenderableInteractiveMarkers` | Same block. Removes complete markers and an unterminated tail, and while streaming trims any trailing prefix of `{{interactive:`. | Exact. A quirk carries over: mid-stream, a `}}` inside the JSON of an unfinished marker ends the lazy match early, so for a tick or two a stray `'` or `'}` can show. `{{interactive` text itself never leaks (tested at every prefix). |
| `embeds.js` | ModelBenchmarkReportPage chunk @1057: map `G` (29 types), `T()` marker builder (`'` → `'`), `Q()` splice on `/\n\s*\n/` with clamping. | Exact. `applyEmbedEntries` is a convenience helper. |
| `markdown.js` `normalizeLatexDelimiters` | @4100300–4103340, including tilde/backtick fence skipping, blockquote-aware fence detection, `isLikelySingleDollarMath`, and the "$5+$3" price guard. | Exact |
| `replaceSourceMarkers`, `sourceMarkerHoldIndex`, `sourceCitationContent` | @2880293–2881100. | Exact. The shipped second regex also swallows the whitespace before a citation group (`word[1]`). |
| `parseKeywordsInText` | @4133885. Whole-word, case-insensitive, longest term first, no overlaps. | Exact. It returns segments; the DOM layer turns them into keyword buttons. |
| `withoutPageMarkers` | @4111915 | Behaviour only |
| Markdown renderer (`parseBlocks`, `parseInline`, `renderMarkdown`) | Stands in for react-markdown + remark-math + rehype-katex (@3393695, @4105554). It keeps the shipped behaviours that matter: a paragraph that is only a placeholder renders the component without `<p>`, paragraphs use `white-space: pre-wrap`, and `img src="PLACEHOLDER"` is dropped. | Simplified. No GFM tables, no nested lists (flattened), no KaTeX (a small "TeX-lite" display for `$$…$$`), no real-world image figures, no SafeSVGRenderer. |
| `renderInteractiveEntry` | `InteractiveComponentErrorBoundary` @4090500. Shows "Interactive component failed to load: <name>" and tracks `interactive_component_render_failed`; `altText` goes in an sr-only span. | Faithful (a try/catch around a synchronous render) |
| `components/registry.js` | `INTERACTIVE_COMPONENTS` @4084974. All 100 keys in shipped order. The `*-d3` variants share an implementation, as in the bundle. | Keys exact. 26 keys are implemented; the other 74 render a placeholder card. |
| `components/lesson.js` | Normalizers: stepper @3399056, worked example @3401276, lens @3407608, reveal @3408476 (the "wondering lens" title special case and single-item auto-open), compare @3411796, slider @3415922 (start index `floor((n-1)/2)`, `value` falls back to index+1), table @3422601 (≤4 columns, ≤6 rows, `N/A` padding, `Column n`). | Normalizers faithful. Markup and CSS are re-imagined. |
| `components/visual.js` | list @3439885 (variant inference, `CHECKED_STATUSES`, horizontal-stepper rule), stepper @3445712, cards @3450015, quadrant @3466223 (`POSITIONS`), venn @3469798, stat bars @3471370 (`scaleMax`, currency-prefix units), transform @3474988. Accent palette from `INTERACTIVE_COLORS` @3436064. | Normalizers faithful |
| `components/dataviz.js` | Flowchart @3763043 (node sizes 172×62 / 160×50 / 116, `typeColor`, ≤8 nodes and ≤12 edges, dedupe), bar chart @3778896 (`niceScale` @3776213 ported), timeline @3838112, concept map @3765098, cycle @3831670, comparison @3816625 (`attributeKeys` @3816106). | Data contracts faithful. Layout is simplified: the bundle uses dagre + React Flow and d3; this build uses its own layered layout (DFS back-edge removal, longest-path ranks, barycenter ordering), an elliptical concept map and an SVG ring for cycles. |
| `voice-visuals.js` validators | `VOICE_VISUAL_TYPES` @4786647, `VOICE_VISUAL_COMPONENTS` @5054543, `validate*` @5055708–5061432 (§3.5). Over-long arrays are **truncated by `boundedArray`, not rejected**. Short arrays, a wrong type or empty text give `null`. | Exact |
| `keepSingleHighlight`, `toVisualComponentProps` | Same block, @5061900 | Exact |
| `boardReducer`, `boardItemPositions`, `createBoard` | LessonVoiceTutor chunk @17591 (`bt`, `ri`, width 720, gap 56, default height 320) and @18748 (hook `va`, which checks the component is registered). | Reducer exact. The board API is a non-React port. |
| `createBoardToolHandler` | LessonVoiceTutor chunk @20400 (`Na`, `ss` word truncation, default titles `wa`, `ka` title stripping). Error codes: `unknown_tool`, `board_unavailable`, `invalid_arguments`, `unknown_lesson_visual`, `unknown_item`, `tool_unavailable`, `no_image_found`, `execution_failed`. | Exact. `search_image` takes an injected function (none in the demo). |
| `sse.js` `LineSSEParser`, `readCourseChatStream` | `chatApi.sendMessage` @2818700: split on `\n`, `data: ` prefix, `[DONE]`. | Exact |
| `courseChatReducer`, `completeCourseChat` | onChunk/onComplete @2851064–2853900: `content`, `status` (`searching`/`search_complete`/`generating_visuals`), `embed_progress` (replaces the content and sets `isContentSanitized`), `final`, `citations`, `feedback_id`/`feedback_saved`, `quick_replies`, `error`. The bubble streams when `isStreaming && !isContentSanitized` (@4392794). | Faithful. It is pure and immutable, where the original mutates React state. |
| `TeacherSSEParser`, `readTeacherStream` | teacher chunk @628: whitelist, blank-line framing, joined multi-line `data:`, per-line fallback, "Stream ended early". | Exact |
| `teacherReducer`, `teacherCardKey`, `mergeTeacherCards` | teacherActionCard chunk: `Cn` @23105, `Ge` @19213, `Fs`/`_n` @20350. | Simplified. The resolved-action, undo and library-refresh paths of `es`/`In` are left out; quiz-answer override is kept. |
| `sse.js` mocks | `mockLessonChatEvents`: searching, prose deltas (including a raw marker the model writes itself), `generating_visuals`, `embed_progress` with a bar-chart embed spliced in by `insertEmbedAfterParagraph`, `final`, `citations`, `quick_replies`. The producer side is **[U]** (§9.4); the order mirrors §2.1. | Invented content, real protocol |
| `fsrs.js` | ts-fsrs inside the bundle @4316800–4332400: `generatorParameters` (with 17→19 migration and weight clamps), `FSRSAlgorithm`, `BasicScheduler` (short-term learning steps of 1/5/10 minutes), `LongTermScheduler`, `forgetting_curve` with DECAY −0.5 and FACTOR 19/81. Defaults from §5. Rating mapping @4338581–4340378. | Formulas exact. No fuzz (the shipped config disables it), no reschedule or rollback. |
| `practice.js` | `validateMCQ`/`validateCloze`/`validateBinaryChoice`/`validatePracticeAnswer` @4337205–4339400, cloze syntax `{{c1::answer}}` from `MarkdownClozeRenderer` @4134500. | Exact for the three types used |

## The demo (`index.html` + `src/app.js`)

- **Lesson.** A 7-page lesson, "How transformers predict the next word", in the stored shape `{name, hook, meaning, concepts, keywords, pages:[{heading, content}]}`. It uses all 19 required widgets, written both as hand-authored markers and as `embedToMarker` + `insertEmbedAfterParagraph` output. Keywords are highlighted and open a definition. Page 7 covers renderer edge cases: a placeholder widget with a bare boolean param, an unknown name (left as raw text on lesson pages, warned and tracked once per session), a widget that throws (caught by the error boundary), and invalid `data=`.
- **Lesson chat.** Plays the mock SSE body through `LineSSEParser`, in irregular network chunks, into `courseChatReducer`. A side panel shows the raw buffer with the hidden marker text highlighted, the message flags and the event log. During streaming the bubble never shows `{{interactive…` (also checked in tests at every prefix). Then "Generating visuals…" appears and `embed_progress` swaps in the bar chart and stepper. Citations become numbered chips plus a source list. Quick-reply chips with no `action` send a follow-up; chips with an `action` trigger an app action instead.
- **Voice board.** Buttons issue the tool calls a realtime model could make (`show_text` with word truncation, flowchart, bar chart with a double highlight, a 9-event timeline truncated to 7, concept map, loop, `show_lesson_visual`, `replaces_item_id` updates, `get_board_state`) and four invalid calls that return `invalid_arguments`, `unknown_item` and `unknown_tool`. A ResizeObserver feeds `report-height`, and each item shows its stacked `y` position.
- **Practice.** MCQ, cloze (with acceptable answers) and binary choice, checked by the shipped validators, rated Good or Again, and scheduled by FSRS. Each card shows all four outcome intervals, its stability, difficulty and retrievability at the simulated clock, and "time travel" controls.

The look is a cream background, dark-brown ink, sky-blue 3D block buttons with a 4px+5px bottom shadow (the `block-primary-shadow` tokens) and monospace uppercase labels. It uses Inter / Public Sans when installed, otherwise system fonts; no web fonts are fetched. Checked at 1280px and 390px with no horizontal page scroll; wide SVGs scroll inside their own card.

## What is simplified or missing

- Hand-authored course widgets (`movie-script-simulator` and the rest), `lesson-figure`, the line, pie, scatter, area, heatmap, pyramid, rings, hierarchy and infographic charts, `visual-table` and the `deprecated-*` variants are registered but render a placeholder.
- No KaTeX, DOMPurify-sanitized SVG figures, real-world image figures, `[[n]]` lesson-link renumbering, or `instanceId` line-splitting for keeping React identity.
- Interactive widget state (selected bar, reveal open state) resets when a parent re-renders; this matters only while a chat answer is streaming.
- Teacher chat has a reducer, parser and mock but no UI panel; its cards are exercised in tests only.
- `fixtures/` is unused, and was empty when this folder was set up.

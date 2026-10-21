# Wonder: AI lessons with model-written interactive UI

Wonder is a working learning app that combines the two systems reverse-engineered in this lab:

- **wondering.app's product loop.** You pick a topic or plan a course. You get a short paged lesson with interactive widgets and a tutor you can ask about it. When you finish, knowledge cards are revealed in a "pack opening", and spaced-repetition review is scheduled with FSRS. XP and streaks are tracked throughout. A **Teacher** agent plans your study, proposes lessons, quizzes you and remembers what matters, and a **learner memory** personalizes every lesson, tutor reply and Teacher turn.
- **ChatGPT's "intelligent UI" (DIL).** The model writes JSX-like UI tags inline in its markdown. The server recompiles the growing message into a DIL program on every revision and streams it as `conversation-source` NDJSON. The browser runs the program in a sandboxed Web Worker and applies the resulting render ops to the DOM.

The model is Claude (`claude-opus-5-5`). Without credentials the app runs in **demo mode**, streaming pre-written lessons through exactly the same pipeline.

```
Claude (or demo/*.md)  ──text deltas──▶  server/compile.js  (chatgpt-dil compiler + learning-catalog pass:
                                          lenient-JSON props → validated → hoisted constants; invalid → fallback md)
                                              │ full `dil` every ~150 ms or when a tag closes
                                              ▼
                       server/ndjson.js  application/vnd.openai.conversation-source+ndjson v2
                                          control started → reasoning → content (append + baseRevision, dil) … → state → terminal-received → end
                                              │ fetch + chatgpt-dil ConversationSourceParser / ConversationTurn
                                              ▼
 browser  public/wonder-worker.js  chatgpt-dil runtime + public/learning-catalog.js (Quiz, Flowchart, … in DIL primitives)
                                              │ binary op buffers
                                              ▼
          chatgpt-dil host.js → DOM (rAF coalescing, per-word fade)   ◀── widget actions ──▶ POST /api/widget_action
```

## Run it

```sh
cd genui-lab/wonder
npm install
cp .env.example .env        # then put your key after ANTHROPIC_API_KEY=
npm start                   # node --env-file-if-exists=.env server/index.js → http://localhost:8750
```

`ANTHROPIC_API_KEY=... npm start` also works, as does an `ant auth login` profile. The server never reads, prints or logs the key. `GET /api/status` returns only `{mode: "claude"|"demo", model}`. `PORT` changes the port. `WONDER_MODE=demo` forces demo mode even when credentials exist. `WONDER_MEMORY_FILE` moves the learner memory file. `WONDER_RECORD_DIR=<dir>` writes each lesson, tutor and Teacher stream's NDJSON to a file there; that is how the fixtures were captured, and the records contain no credentials.

### Demo mode

If there is no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and no profile credential file, the server starts in demo mode. It also switches to demo mode when the first Claude call fails with `AuthenticationError` or a missing-credentials error before any text was produced. The UI then shows a "Demo mode — set ANTHROPIC_API_KEY to use Claude" banner.

Demo mode streams these through the real compile + NDJSON pipeline in 20–60 character chunks:

- **Lessons** in `server/demo/`: *How transformers predict the next word*, *Why the sky is blue* and *Compound interest*. The topic is matched by keyword, and any other topic falls back to one of the three.
- **Tutor replies.** `tutor-explain.md` and `tutor-quiz.md` are templates. The quiz reply is a `<Quiz>` built from the lesson's own `<KeyTerm>`s. "Explain this" on a missed quiz question gets a reply built from that question's explanation and hint.

- **Teacher turns.** `server/teacher-demo.js` is a scripted stand-in for Claude that speaks the Messages streaming event protocol (text deltas, `tool_use` blocks with `input_json_delta`, stop reasons). The real tool loop drives it, so demo turns go through the same validation, tool execution, card splicing and NDJSON path. It answers goals/plans (remember → get_progress → plan_study + create_lesson), "quiz me" (a Quiz from your last lesson), "how am I doing", "forget that", facts about yourself, and anything else with a lesson suggestion.

Practice extraction in demo mode is deterministic, built from the lesson's `<KeyTerm>` and `<Quiz>` components. Memory extraction in demo mode notes a struggle when you miss at least a third of a lesson's quiz.

## How the two systems map into Wonder

| Concern | ChatGPT (DIL) | Wondering | Wonder |
|---|---|---|---|
| How the model asks for UI | Inline JSX-like tags in markdown, e.g. `<box padding={4}>`, `<StockChart …/>` (chatgpt-findings §8.2) | `{{interactive:name data='…'}}` markers, or `embed` JSON spliced after paragraph *n* (wondering-findings §1.1, §1.3) | The ChatGPT way: inline tags. Wondering's widgets become **Capitalized catalog components** with JSON props: `<Quiz questions={[…]}/>`, `<Flowchart nodes={…}/>` |
| Compilation | Server recompiles the whole message into `dil.code` + `constants` each revision | Client-side marker parsing to React components | `server/compile.js` wraps `chatgpt-dil/src/compiler.js` (byte-exact for the captured stream) with a pre-pass that parses `{…}` props as lenient JSON, validates them, and hoists them into `__dilConstants` |
| Prop validation | Unknown | `validateVoiceVisualPayload` bounds, alias-tolerant normalizers (§1.4, §3.5) | `server/catalog-schema.js`. Visual bounds come from wondering-genui's `voice-visuals.js` (Flowchart 3–8 nodes, Timeline 3–7, BarChart 2–6 with a required unit, and so on). Invalid → component dropped, fallback markdown in its place |
| Streaming robustness | Half-written tags dropped; unclosed elements auto-closed | `removeUnrenderableInteractiveMarkers` trims partial markers | Same as ChatGPT. A half-written catalog tag at the tail is cut. Tested on **every prefix** of every demo lesson |
| Transport | `conversation-source+ndjson` v2: content append/replace, `dil`, `followupPrompts`, controls, reasoning (§1.2) | SSE `content` / `status` / `quick_replies` / `final` (§2.1) | NDJSON v2. Every record is validated with chatgpt-dil's `validateRecord` before writing. Reasoning records narrate "Planning the lesson…" and "Writing page N…" |
| Rendering | Sandboxed worker, hooks runtime, binary op buffer, `data-d-*` host primitives (§3.1–3.3) | React components | chatgpt-dil `runtime.js` + `host.js`, unchanged. The learning catalog is injected **into the sandbox** as a program prelude (`public/learning-runtime.js`) and built only from DIL primitives + `DIL.useState` |
| Widget actions | `GenUI.dispatchWidgetAction` → `/backend-api/widget_server_action`; client actions such as `issue_new_turn` (§3.6) | Teacher `answer_quiz`, chat quick-reply actions | `POST /api/widget_action`: `quiz_answer` / `quiz_restart` return `componentResults` merged into `appData.opGenui`; `explain_more` returns a tutor turn; `practice_grade`. Client actions: `issue_new_turn` → tutor message, `quiz_complete` → XP, `save_flashcards` → deck |
| Lesson shape | n/a | `#` title, hook, pages (`##` sections), embeds per page, KeyTerm highlights, wondering-lens asides, 3-question check (§1.5) | Same pedagogy, taught to Claude in `server/prompts.js`. Each `##` renders as a numbered "page" |
| Tutor | Follow-ups via `followupPrompts` | `course-chat`, `quick_replies` | `/api/tutor/stream` with the lesson as context. Replies are DIL (they can include a Quiz or a visual). `<Followups items={[…]}/>` is lifted out of the program into `followupPrompts` chips |
| Practice | n/a | `generate-knowledge-cards`, practice types mcq/cloze/binary_choice/flashcard, FSRS v5 via ts-fsrs, pack opening (§1.6, §5) | `/api/practice/extract` uses Claude structured output (`json_schema`, effort low) with a deterministic fallback. FSRS scheduling uses wondering-genui's `fsrs.js` port with shipped defaults. Deck and review logs live in localStorage |
| Gamification | n/a | XP events, streaks with local-date keys (§7) | `public/deck.js`: XP for lessons, quiz answers, reviews and collected cards, plus a streak that counts consecutive local days |
| Agent with tool cards | Server-resolved catalog components: `componentResults[__resolutionId]` (§3.4, §8.2); widget server actions (§3.6) | `teacher-chat`: SSE `tool_start`/`tool_result`, cards `plan`/`approval`/`quiz`/`memory`, `resolve_action`/`undo_action` (wondering §2.3) | `/api/teacher/stream`: Claude's tool calls run on the server; each result is a resolved `<TeacherCard>` spliced into the streamed DIL, with `reasoning` records as the tool status line. Card buttons → `/api/widget_action` (`teacher_accept`/`teacher_dismiss`/`teacher_undo`/`teacher_open_item`) |
| Memory | Memory cites | `learner_memory_items`, `extract-learner-memory`, `forget_me`, `noMemory` (wondering §5) | `server/memory.js` (JSON file), Teacher `remember`/`forget`, post-lesson extraction, "About this learner" system block after the cache breakpoint, `#/memory` screen and a "Use memory" switch (`memoryEnabled`) |

## Claude usage

All of this lives in `server/claude.js`. The client is dependency-injected, so tests pass a fake.

- **Lesson and tutor turns** use `client.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 64000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", thinking: {type: "adaptive"}, output_config: {effort: "medium"}, system: [{…, cache_control: {type: "ephemeral"}}], messages })`.
  - The system prompt is static so the cache prefix stays stable. The per-lesson tutor context goes in a second system block after the breakpoint.
  - There is no temperature, top_p or prefill.
  - Text comes from `content_block_delta`/`text_delta` events, followed by `await stream.finalMessage()`.
  - `stop_reason === "refusal"` produces a graceful message. `"max_tokens"` marks the turn as truncated (`debug.truncated`).
- **Course plans and practice extraction** use `client.messages.create` with `output_config: {effort: "low", format: {type: "json_schema", schema}}`. The JSON is parsed and every item is validated.
- **Teacher turns** (`server/teacher.js`) run a manual streaming tool loop, at most 6 requests per turn:
  - Six client tools, all `strict: true` with `additionalProperties: false` and `required` on every object, and `eager_input_streaming: true` (the request is streamed): `create_lesson`, `plan_study`, `quiz_me`, `remember`, `forget`, `get_progress`. They are static and render before the system prompt, so the one `cache_control` breakpoint on the system prompt caches tools + system. Learner memory goes in a second system block after it. There is no `tool_choice` (forcing a tool is a 400 on this model).
  - Because eager streaming skips server-side validation, every parsed input is checked against its schema plus semantic bounds (3–7 plan days, Quiz props through the catalog validator, fact ≤ 200 chars) before anything runs. A failure becomes an `is_error` tool_result echoing the JSON-encoded input. An SDK `AnthropicError` that is not an `APIError` (unparseable tool JSON) re-issues the turn, at most twice.
  - `refusal` and `max_tokens` stop the loop without running that turn's tools. `pause_turn` appends the paused content and re-sends with no extra user message. Every `tool_result` of one assistant turn goes back in one user message, and the full `message.content` (thinking, text and tool_use) is appended to the history.
  - Card markup is server-only: a streaming filter strips any `<TeacherCard>` the model writes, even when it is split across deltas. In later turns the client sends cards back as `[Card: <summary of its current state>]` notes.
- **Errors** are caught most specific first: `AuthenticationError` → `RateLimitError` → `BadRequestError` → `APIError`. Each becomes a `control failed` record with a friendly message. Raw API text is never forwarded.

## Endpoints

| Endpoint | Response |
|---|---|
| `GET /api/status` | `{mode, model}` |
| `POST /api/lesson/stream {topic, level?, lessonTitle?, lessonSummary?, course?, continueFrom?}` | NDJSON lesson. `continueFrom: {markdown, instruction?, fromPage?, messageId?, sources?}` resumes or revises a persisted lesson (Phase 4) |
| `POST /api/lesson/steer {operationId, instruction}` | JSON `{ok, status: accepted\|rejected}`; the result streams on the lesson's own NDJSON (Phase 4) |
| `POST /api/tutor/stream {lessonContext:{title, markdown}, history, message}` | NDJSON reply; the final content record carries `followupPrompts` |
| `POST /api/course/plan {topic, level}` | JSON `{plan:{title, description, sections:[{title, lessons:[{title, summary}]}]}}`; the client renders it as a course path |
| `POST /api/widget_action {componentName, action_type, payload, resolutionId}` | JSON `{componentResults?, issueTurn?, result?}` |
| `POST /api/practice/extract {lessonMarkdown}` | JSON `{cards:[{term, definition, example}], items:[…]}` |
| `POST /api/teacher/stream {threadId, history, message, progress, memoryEnabled}` | NDJSON Teacher turn. Cards live in the final `dil.appData.opGenui.componentResults`; `followupPrompts` on the final record |
| `GET /api/memory` | `{items:[{id, fact, kind, source, createdAt}]}` (newest first) |
| `POST /api/memory {fact, kind}` | Adds a user fact (de-duplicated) |
| `DELETE /api/memory?id=…` or `DELETE /api/memory {all:true}` | Removes one item, or forgets everything |
| `POST /api/memory/extract {lessonTitle, quizResults, tutorThread, memoryEnabled}` | `{added:[…], source}`: 0–3 new facts from a finished lesson |

`memoryEnabled: false` on lesson, tutor, Teacher and extraction requests leaves memory out of the prompt (and the Teacher's `remember`/`forget` return an error result instead of writing).

The server also serves `public/` and, read-only, `genui-lab/chatgpt-dil/src/*` and `genui-lab/wondering-genui/src/*`. Client modules import those through relative paths such as `../../chatgpt-dil/src/host.js`, which resolve the same way under Node and in the browser.

## The learning catalog (what Claude can write)

| Component | Notes |
|---|---|
| `KeyTerm` | Inline; tap to show the definition and an "Explain more" action |
| `Callout` | The "Wonder lens" aside; tones insight/tip/info/warning/example; takes markdown children |
| `LessonStepper` | Step-by-step walkthrough |
| `Reveal` | Predict, then check |
| `CompareToggle` | Segmented left/right view, plus side-by-side on desktop |
| `InputOutputSlider` | Pressable stops |
| `Flowchart` | Start/process/decision/end nodes, branch jumps |
| `Timeline` | Events in order |
| `BarChart` | Bars with values; one may be highlighted |
| `ConceptMap` | Concepts linked to a center concept |
| `Cycle` | SVG ring |
| `Quiz` | Hints, feedback, explanations, "Explain this" → tutor, results with confetti, retry, server-graded state restore |
| `Flashcards` | Flip cards; "Save to review deck" |
| `Celebration` | Confetti moment |
| `TeacherCard` | **Server-only**: spliced in by `/api/teacher/stream`, never written by the model. Props are just `kind` and the server-assigned `__resolutionId`; the data is `componentResults[__resolutionId].state`. `approval` (Start lesson / Not now / Undo), `plan` (per-item open buttons, Save plan / Unsave), `memory` (Remembered/Forgot chip with Undo/Redo). Shows a skeleton until resolved |

Claude can also use the DIL layout primitives (`box/row/col/grid/text/title/icon/badge/divider/math/…`), with icon names taken from `chatgpt-dil/src/icons.js`.

## Math

Formulas are typeset with [KaTeX](https://katex.org) (npm `katex`, served read-only from `node_modules/katex/dist` at `/vendor/katex/`).

- **Syntax Claude may use:** `<math>…</math>` (display when alone on its line or with `display`), `$$…$$` and `\[…\]` (display), `\(…\)` and `$…$` (inline). The prompts ask for `$…$` / `$$…$$`, plain unescaped prices, and doubled backslashes inside JSON props.
- **Compiler (`server/math-spans.js`).** Before the stock compiler runs, a fence- and code-span-aware pass replaces every math span with `<math>` + a placeholder and hoists the raw LaTeX into the constants byte for byte, so `\text{mean} = \frac{x_1 + … + x_n}{n}` keeps every brace, backslash and underscore. Tags, attributes and `<code>`/`<markdown>` bodies are never touched. An unclosed span at the tail of a stream is held back like a half-written tag, so `\frac` never flashes raw.
- **Dollars.** `$…$` follows pandoc's rules, tightened for prices: the opener is not followed by whitespace, the closer is the next unescaped `$` on the same line and must not be preceded by whitespace or followed by a digit, and the content must look like math. `$40,000 … $3, $4`, `$6.` and `costs $5 and $10` stay text.
- **JSON props (`server/lenient-json.js`).** A backslash followed by a known LaTeX command (261 names: `frac`, `text`, `theta`, `times`, `beta`, `nu`, `neq`, `nabla`, `rho`, `right`, …) stays literal instead of decoding as `\f`/`\t`/`\b`/`\n`/`\r`; other letter escapes that JSON does not define keep their backslash too. Genuine escapes (`\n` before a non-command word, `\"`, `\\`, `\uXXXX`) still decode, in double- and single-quoted strings. Any expression with a backslash skips the strict `JSON.parse` fast path.
- **Catalog text.** The in-sandbox `inline()` markdown of the learning catalog splits out `\(…\)`, `\[…\]`, `$$…$$` and safe `$…$` (same rules) into `math` primitives, so LessonStepper steps, Quiz prompts and options, Reveal answers and the rest typeset too.
- **Client (`public/math.js`, `public/math.css`).** A MutationObserver typesets every host `math` node (and the host's own inline markdown math) with `katex.render(latex, out, {displayMode, throwOnError:false, trust:false, output:"htmlAndMathml", strict:"ignore"})`. It runs synchronously in the observer callback, after the host's frame flush and before paint. The host's text spans stay in place, hidden, so streaming updates keep working; the output lives in a sibling `.wonder-math-out` and is re-rendered only when the LaTeX changes. If KaTeX fails to load, the same span gets the old Unicode rewrite.

## Teacher

`#/teacher` (Home → Teacher) is Wondering's Teacher tab rebuilt on ChatGPT's resolved components. The left column holds the thread list (a drawer on phones); the right is the chat. Replies stream as DIL in a sandbox worker, like the tutor's, and end with follow-up chips.

What happens in one turn:

1. The client sends the message, a text history (cards as `[Card: …]` notes), a **progress snapshot** assembled from localStorage (`public/teacher-core.js`: deck size, due cards, mastered, streak, XP, recent lessons with quiz scores, courses, saved plans) and `memoryEnabled`.
2. Claude streams text and calls tools. When a `tool_use` block starts, a `reasoning` record shows the tool status ("Checking your progress…", "Drafting a study plan…"). This is Wondering's `tool_start`.
3. The server validates and runs the tool. Results that need UI get a resolution id (`tc-<uuid>`) and are stored as `{status:"resolved", state}` in the turn's `appData.opGenui.componentResults` and in a server-side card store. Then `<TeacherCard kind="…" __resolutionId="…"/>` is spliced into the markdown at that point. The compiler hands that id to the stock chatgpt-dil compiler instead of the default salted id. `quiz_me` splices a normal `<Quiz>`, graded by the existing `quiz_answer` action; `get_progress` returns JSON only.
4. Card buttons dispatch widget actions to `/api/widget_action`. The response has the card's new `componentResults` entry plus `clientActions` for the host:

| Card | Action | New state | Client action |
|---|---|---|---|
| approval | `teacher_accept` (Start lesson / Open lesson) | `accepted` | `start_lesson` → creates the lesson and opens `#/lesson/<id>` (or reopens the same one) |
| approval | `teacher_dismiss` (Not now) → `teacher_undo` | `dismissed` → `pending` | none |
| plan | `teacher_open_item {itemId}` | item `opened` | `start_lesson`, `open_review` or `issue_new_turn` ("Quiz me on …") |
| plan | `teacher_accept` (Save plan) / `teacher_undo` (Unsave) | `saved` | `save_plan` / `unsave_plan` → the plan appears on Home under "Your study plan" |
| memory | `teacher_undo` (Undo / Redo) | `undone` ↔ `saved`/`forgotten` | none; the memory store itself is updated |

Every action also carries the card's state, so a card still works after a server restart; the server rebuilds it from that copy after normalizing it. Threads, compiled programs and the latest `componentResults` persist in localStorage, so a reload restores every card in its last state.

The Teacher persona (`TEACHER_SYSTEM_PROMPT`) uses Wondering's dial values fixed to tone warm, challenge balanced and hints first.

## Learner memory

- **Store.** `server/memory.js` keeps `genui-lab/wonder/data/memory.json` (git-ignored; `WONDER_MEMORY_FILE` overrides it). Items are `{id, fact, kind: goal|preference|struggle|background, source: teacher|lesson|user, createdAt}`. Writes are atomic (temp file + rename). The store holds at most 100 items (oldest dropped) and each fact at most 200 characters. Near-duplicates are not stored twice.
- **Writes** come from three places:
  - The Teacher's `remember`/`forget`, with an Undo chip.
  - Post-lesson extraction. "Finish lesson" sends the quiz results and the learner's tutor questions to `/api/memory/extract`: a structured-output call at effort low, giving 0–3 facts that are de-duplicated against memory. A toast says what Wonder will remember.
  - The Memory screen.
- **Reads.** A compact "About this learner" block with the newest 15 items goes into the lesson, tutor and Teacher system prompts as a system block after the cache breakpoint. The Teacher's copy includes item ids so it can `forget` them.
- **UI.** `#/memory` lists items by kind, with add, delete and "Forget everything", plus the persisted **Use memory** switch that sets `memoryEnabled` on every request.

## Tests

```sh
node --test genui-lab/wonder/test/index.js      # 200 tests, about 15 s, no network
```

- **`compile.test.js`**
  - Lenient JSON, and proof that it never evaluates code.
  - JSON props hoisted into constants.
  - Invalid props → fallback.
  - Voice-visual bounds.
  - Followups lifted out of the program.
  - Code fences ignored.
  - **Every prefix of every demo lesson** compiles to valid JavaScript, and sampled prefixes run without runtime errors.
- **`catalog.test.js`** runs each demo in the chatgpt-dil runtime with the learning catalog. It drives Stepper, Quiz (answer, hint, server action, "Explain this", results, retry, restore from `componentResults`), KeyTerm/explain_more, Reveal, CompareToggle, Slider and Flashcards. It also checks mobile layouts and that component state survives a streamed recompile.
- **`server.test.js`** runs the demo-mode HTTP server end to end.
  - Records are parsed with chatgpt-dil's parser, the stream ends with `end`, and the final markdown equals the demo source.
  - The final dil renders Quiz, Stepper and Flowchart nodes.
  - Also covered: the tutor and its followups, widget_action grading, practice extract, course plan, static serving and path traversal.
- **`claude.test.js`** uses a fake client to check:
  - Request params: model, adaptive thinking, effort, `fallbacks:"default"` + beta, `cache_control`, no sampling params or prefill.
  - Streaming, tutor context and history, followups.
  - Refusal and max_tokens handling.
  - Rate-limit, bad-request and API errors, plus the switch to demo on auth failure.
  - Structured extraction and the course plan.
- **`teacher.test.js`** drives the Teacher loop with a scripted streaming fake (`fakeToolClient` in `helpers.js`):
  - Request params: model, adaptive thinking, effort, `fallbacks` + beta, `cache_control` with memory after it, every tool strict + `eager_input_streaming` with `additionalProperties:false` everywhere, no `tool_choice`, static tools.
  - Tool loop: tools run, all results come back in one user message, the full content (with thinking) is appended, and cards are spliced at the right point with matching `componentResults`.
  - Validation failures become `is_error`; `quiz_me` splices a Quiz.
  - `pause_turn` continuation; `refusal` and `max_tokens` never run tools.
  - Model-written TeacherCards are stripped, even split across deltas.
  - Unparseable-JSON retry, API errors, and the 6-request cap.
  - History cleaning; memory off.
  - All card widget actions, including after a restart.
  - The demo Teacher end to end over HTTP.
  - Client history and progress helpers.
- **`memory.test.js`** covers the store (CRUD, atomic file, caps, de-duplication, corrupt file), `/api/memory` endpoints, Claude and demo extraction (effort low, json_schema, cap 3, de-dup), and memory injection into lesson and tutor prompts after the breakpoint (left out when `memoryEnabled:false`).
- **`catalog.test.js`** also renders TeacherCard (approval/plan/memory/skeleton, desktop and 390 px) from `componentResults`, presses every button and checks the dispatched widget actions and the re-render with new state.
- **`real-claude-teacher.test.js`** replays a recorded real Teacher turn (`test/fixtures/claude-teacher-statistics.ndjson`) through the browser client's `streamTurn` in uneven chunks, and renders every streamed revision and the final program.
- **`math.test.js`**:
  - The real Claude `<math>` example keeps every brace; `$$`, `\[ \]`, `\( \)` and `$…$` become math nodes; prices (`$40,000 … $3, $4`, `$6.`, `costs $5 and $10`) stay text; math in code fences and spans is untouched.
  - Every prefix of a math-heavy sample compiles and runs, text outside math never holds raw LaTeX, and every math node is a complete formula.
  - LaTeX-aware JSON escapes, with ordinary `\n`/`\t`/`\"` still decoding.
  - Inline math in a LessonStepper step and Quiz options; every demo formula typesets with KaTeX (`throwOnError: true`); the Unicode fallback.
  - `/vendor/katex/` serves css, js and fonts (200) and refuses traversal and other files (404).
- **`view-state.test.js`** covers widget state persistence: a snapshot restores every persisted widget on the first render (also via `setStateSnapshot`), one debounced message per burst of clicks (mock timers), live state and the snapshot survive streamed recompiles, unknown ids/keys and invalid values are ignored, a revision that rewrites or removes a widget drops its state while unchanged widgets keep theirs, reset, server-graded Quiz state wins over local progress, Cite/KeyTerm stay ephemeral, the compound-interest FunctionGraph slider, Stepper and Flashcards round-trip (desktop and 390 px), size caps and eviction, and store persistence with corrupted snapshots.
- **`deck.test.js`** covers practice grading, FSRS deck scheduling (learning steps, graduation, growing intervals, lapses), XP/streak rules, and localStorage persistence when storage is blocked or corrupted.

## Files

```
server/index.js           entry (npm start)          server/app.js          routes, static files, demo fallback
server/claude.js          Claude params/stream/errors server/prompts.js     system prompts + JSON schemas
server/compile.js         compiler extension         server/lenient-json.js JSON5-ish prop parser
server/catalog-schema.js  prop validators/fallbacks  server/ndjson.js       conversation-source writer
server/demo.js, demo/*.md demo mode                  server/practice.js     practice extraction
server/widget-actions.js  /api/widget_action
server/teacher.js         Teacher tools, validation, loop, card store + actions
server/teacher-demo.js    scripted demo "model"      server/memory.js       learner memory store
server/memory-extract.js  post-lesson memory extraction
public/index.html, styles.css, app.js (screens), ui.js, review.js, store.js, deck.js, practice-core.js, math.js + math.css (KaTeX)
server/math-spans.js      math spans hoisted before the stock compiler
public/teacher-screen.js, teacher-core.js (progress snapshot, history), memory-screen.js
public/learning-catalog.js (in-sandbox components), learning-runtime.js, wonder-worker.js, dil-surface.js, stream-client.js
public/view-state.js      widget state snapshots (store, useSaved, caps)   public/lesson-menu.js + .css  lesson overflow menu
test/*.test.js, test/index.js, test/helpers.js
```

## Widget state persistence

Interactive widgets keep their state across reloads and when a lesson is reopened, like ChatGPT's `DIL.useState(initial, {key, widgetId})` + `DILStatePersistence` (chatgpt-findings §3.1–3.2). chatgpt-dil's runtime ignores those options and has no snapshot API, so the store lives in Wonder's runtime wrapper (`public/learning-runtime.js`, `public/view-state.js`) and chatgpt-dil is unchanged.

| Widget | Saved | Not saved |
|---|---|---|
| `FunctionGraph` | parameter values | |
| `LessonStepper` | current step | |
| `Reveal` | which items are open | |
| `CompareToggle` | left / right / side by side (side by side shows the left view on phones) | |
| `InputOutputSlider` | selected stop | |
| `Flashcards` | card index, flipped, "saved to deck" | |
| `Quiz` | local progress (answers, current question, attempt) | server-graded `componentResults` win when present |
| `Cite`, `KeyTerm`, `Flowchart`/`Timeline`/`BarChart`/`ConceptMap`/`Cycle` selection | | ephemeral |

- **Keys.** Surface (the lesson, a tutor message or a Teacher message, which owns the snapshot) + the component's compiler-assigned `__resolutionId` (name + ordinal + messageId salt, stable across streamed revisions, reloads and continuations) + a local key (`i`, `params`, `card`, …).
- **Snapshot.** `{v: 1, c: {[resolutionId]: {h, t, s: {[key]: value}}}}`. `h` fingerprints the component's props, so a component that a revision rewrote in place does not inherit the old widget's state. Values must be plain JSON (no functions, NaN, class instances, at most 6 levels); one key may hold at most 8 KB and a surface at most 50 KB, with the least recently written widgets evicted first.
- **In the sandbox.** Persisted components call `useSaved(props, key, initial, restore)` (built on `DIL.useState`) instead of `DIL.useState`. The store reaches them as a non-enumerable `appData.__wonderViewState`; `restore` validates a saved value against the current props (an out-of-range step or unknown param falls back to the initial value).
- **Worker protocol.** main → worker `setStateSnapshot` is posted before `init`/the first `render`, so widgets mount in their saved state with no flicker. Changes come back as `{type: "viewState", snapshot}`, debounced 300 ms. `pruneViewState {keep}`, `resetViewState` and `flushViewState` (sent when a surface is destroyed, so leaving a lesson right after a change still saves it) complete the set.
- **Storage.** `store.js` keeps `viewState` on the lesson, each tutor message and each Teacher message, and re-validates it on load. A corrupted snapshot is dropped and the lesson opens with fresh widgets. Quota pruning drops the snapshots of older lessons along with their tutor transcripts.
- **Streaming and steering.** Live state already survives recompiles (fibers are matched by component name). When a resumed or revised lesson finishes, the snapshot is pruned to the resolution ids of the final program and to widgets whose props are unchanged, so removed or rewritten widgets lose their state and kept ones keep theirs.
- **Reset.** The lesson bar's "⋯" menu has **Reset interactive widgets**. It clears the lesson's snapshot and remounts the program. A Quiz graded by the server still shows its server-side answers.

## Limitations

- **The Claude path is tested only against a fake client.** No real API calls were made while building this. The prompts are untested against the live model, so the first real lessons may need prompt tuning.
- **Math falls back to Unicode only when KaTeX cannot load.** Then `public/math.js` rewrites LaTeX into Unicode (`\frac{1}{\lambda^4}` becomes `1⁄λ⁴`), which reads fine but is not typeset. Citation pills are never inserted inside an unfinished math span: the grounding safe-point check reuses `math-spans.js`, including its price rules.
- **Server-side widget state is in memory** (quiz answers per resolution id). The client persists `componentResults` with each lesson, so reloads still restore it, but a server restart forgets its copy.
- **One sandbox worker per surface**: the lesson plus each tutor reply. Very long tutor threads therefore start many workers. They are terminated when you leave the lesson.
- **Tutor replies are not lesson-specific in demo mode.** They are templates that use the lesson's KeyTerms and Quiz. Any other topic streams one of the three sample lessons.
- **No accounts or sync.** Courses, lessons, the deck and XP live in this browser's localStorage, and the app falls back to in-memory storage when localStorage is blocked.
- **Multi-tab is safe.**
  - The cross-tab lock keeps two tabs from streaming the same lesson.
  - `store.js` writes with a three-way merge per lesson, thread, course and plan, and idle tabs pick up other tabs' saves. So one tab no longer wipes another tab's changes.
  - Without Web Locks, the lease fallback is still exclusive. Acquiring broadcasts a claim, writes the lease, waits a 120 ms settle window and re-checks, and the lowest claim ticket wins ties. `test/lock-race.test.js` races two tabs 100 times; exactly one wins every time.
- **Teacher history is text.** Earlier turns go back to Claude as markdown with `[Card: …]` notes, not as the original tool_use/tool_result blocks. Card state on the server is in memory, but cards carry their state, so they survive restarts.
- **Memory is one file for one local learner.** There are no accounts. It is not encrypted; "Forget everything" deletes it.
- **Inherited from chatgpt-dil:** a best-effort sandbox lockdown and no SVG `<text>`. Flowchart and ConceptMap are therefore laid out with boxes rather than drawn edges.

## Credentials

`npm start` reads `ANTHROPIC_API_KEY` from `genui-lab/wonder/.env`. If that isn't set, it falls back to `~/.config/wonder/.env`, which lives outside the repo. Set `ANTHROPIC_WORKSPACE_ID` as well when your key is not scoped to a workspace (for example `sk-ant-usr-…` keys). Wonder then sends it as the `anthropic-workspace-id` header.

Verified against the live API (`claude-opus-5-5`), using an `sk-ant-usr-…` key with a workspace ID:
- **Lesson:** a full lesson streamed in about 36 s across 543 content revisions. Every component validated: Quiz, LessonStepper, ConceptMap, BarChart, Reveal, Callout and KeyTerm.
- **Tutor:** the tutor answered with a LessonStepper and suggested follow-up questions.
- **Practice:** the structured-output call extracted 5 knowledge cards and 7 practice items into the FSRS deck.
- **Regression test:** the lesson is kept in `test/fixtures/claude-lesson-vaccines.md` and covered by `test/real-claude.test.js`.
- **Teacher (phases 1–2):** "I want to get good at statistics in a week, I already know basic algebra" took 3 requests.
  1. `remember` ×2 (goal; "Knows basic algebra.") + `get_progress`.
  2. `plan_study` (7 days, 15 items) + `create_lesson` ("Mean, median and mode").
  3. The reply, with a tip Callout and 3 follow-ups.

  Save plan put it on Home. Start opened the lesson, which was generated with the 2 memory items ("You already know the algebra here…"). After a 1/3 quiz, Finish extracted 2 struggle facts ("Struggles to find the median, especially with unsorted or even-sized data sets."), which then showed on the Memory screen. This was checked at desktop and 390 px with no console errors. The turn is kept in `test/fixtures/claude-teacher-statistics.ndjson`.


<!-- ===================== Phases 3-5 (grounding, steering, function graphs) ===================== -->

## Phase 3: grounded lessons with sources

Lessons can search the web, and Claude's citations show up as ChatGPT-style numbered pills plus a source list at the end.

- **Request.** `POST /api/lesson/stream` takes `useWebSearch` (default `true`). `POST /api/tutor/stream` takes it too (default `false`). The client turns it on for the tutor only when the message asks for sources, recent facts or a search.
- **Tool.** When search is on, the request adds `{type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_callers: ["direct"]}`. There is no `code_execution` tool.
  - `allowed_callers: ["direct"]` is required. With the default (dynamic filtering through code execution), the results reach Claude as encrypted code-execution stdout, and the answer carries **no** text-block citations. This was verified live.
- **Streaming** (`server/grounding.js`, `streamGrounded`):
  - **Text.** `text_delta` text goes through a `CiteAssembler`. Text blocks start with `citations: []`, and `citations_delta` events arrive before the text of a cited block, as seen live. When the block stops, the assembler adds `<Cite refs={["turn0search3"]}/>` right after the cited span. It holds back trailing whitespace, so the result reads "…1916<Cite/>." and the pill stays inside the paragraph.
  - **Where cites can go.** A cite never lands inside a tag, a JSON prop, a code fence or span, or math. In those cases it waits for the next safe tag end or word boundary.
  - **Searches.** `server_tool_use` queries become reasoning records ("Searching the web: “…”").
  - **Search errors.** A `web_search_tool_result` error arrives as a result block. It is logged and narrated, and the lesson continues.
  - **`pause_turn`.** The paused assistant content is appended, merged into one assistant turn, and the request is re-sent with no extra user message. At most 4 continuations.
- **Source data.** Each distinct URL gets a stable ref `turn<T>search<N>`. `citeComponentResults` reads the compiled program, finds every `Cite`/`Sources` and its `__resolutionId`, and fills `appData.opGenui.componentResults[rid]` with ChatGPT's shape:
  - Cite: `{status:"resolved", state:{items:[{ref, ref_id, index, url, title, domain, source_label, snippet, page_age?}], active_index, sources_title}}`
  - Sources: the same items under `sources_title: "Sources (n)"`.

  The turn writer runs this on every compiled revision (`createTurnWriter({appDataFor})`), so a pill is resolved as soon as it appears. `<Sources/>` is appended when anything was cited.
- **Catalog** (`public/catalog-extras.js`, injected into the sandbox after the learning prelude):
  - **`Cite`** is an inline numbered pill. Pressing it opens a popover card with the number, domain, title and snippet, plus "Open source" (an `open_url` client action). It overrides chatgpt-dil's stock `Cite` pill for Wonder programs only: the stock one is a parameter of the program Function, so the prelude reassigns it, and chatgpt-dil is unchanged.
  - **`Sources`** is a numbered, pressable list with domains.
  - A Cite whose refs don't resolve renders nothing.
- **Prompt** (`server/prompts-extra.js`). Claude is told to search for real-world topics (1-3 focused searches), to cite in its own prose, and never to write Cite tags, `[1]` or URLs itself.
  - Server-inserted tags are removed (`stripGroundingTags`) whenever a lesson is quoted back to Claude: tutor context, practice extraction and steering.
- **Demo mode.** "Why the sky is blue" streams four deterministic citations (`server/demo-grounding.js`). With `useWebSearch:false` it streams the plain sample.

## Phase 4: mid-turn steering

- **UI.** One composer (`public/steer-bar.js`) with the same chips (Simpler, More examples, Go deeper, Shorter) and free-text input in four modes. `public/steering-core.js` holds the chips, the page helpers, the reducer and the continuation/persistence helpers shared by server, client and tests.
  - **Live** (under the reasoning line while a lesson streams): `POST /api/lesson/steer`, below.
  - **Revise** (a finished lesson): a sticky "Revise from page N" pill that follows the `##` page in view and opens the composer. It rewrites that page and every page after it.
  - **Resume** (an interrupted lesson): a "Lesson interrupted" banner with **Resume lesson**, or resume with a chip or typed change. It continues from the last complete paragraph, mid-page included.
  - **Elsewhere** (another tab holds the lesson's lock): a "Writing in another tab" notice instead of the chips, input and Resume (see the cross-tab lock below).
- **`POST /api/lesson/steer {operationId, instruction}`.** The operationId comes from the stream's control records. The endpoint aborts that operation's current upstream attempt (`server/steering.js`: one AbortController per attempt, linked to the response).
  - Accepted: returns `{ok:true, status:"accepted"}`. It answers "accepted" only while the operation is open, and an accepted steer is always applied. That includes a steer that lands after Claude's last token but before the turn closes: the server then keeps every page except the last and continues with the instruction, so it is never dropped silently.
  - Finished or unknown operation: 409 `{status:"rejected", reason:"not_streaming"}`. The client then falls back to `continueFrom` automatically, after the current stream ends: it sends the finished lesson with `fromPage` = its last page, so the steer stays page-level and rewrites that page.
  - A second steer while one is still being applied: 409 `{status:"rejected", reason:"busy"}`, plus a `steering-status rejected` record on the stream.
- **The same NDJSON response continues** with:
  1. `control steering-status {status:"accepted", instruction}` and `control steering-message` (ChatGPT §1.5).
  2. A reasoning record, "Steering: …".
  3. A `content` record with `mode:"replace"`, the same messageId and a strictly higher revision. It carries the kept markdown, trimmed to the last complete `## ` page, and a recompiled dil.
  4. Normal appends.

  chatgpt-dil's `ConversationTurn` accepts this unchanged. The kept pages compile to the same program prefix with the same resolution ids, so their components keep their state. The client renders the replace without the word fade.
- **Continuation request.** It reuses the cached system prompt and makes a single user turn with two text blocks:
  1. The original lesson request.
  2. `<lesson_so_far>` (cites stripped), the instruction, and "continue from the next `## ` page; don't repeat".

  There is no assistant prefill. Web search stays on.
- **Demo mode.** Steering rewrites the remaining sample pages deterministically (`steerDemoRemainder`). Each page keeps its heading, its first prose paragraph (two sentences at most) and every visual, and the quiz page is kept whole. A "Steered: Simpler" tip callout is added.

### Continuing without the live stream: resume, steer after a reload, revise (`continueFrom`)

Before this, steering needed the original NDJSON connection: after a reload there was nothing to steer, and an interrupted lesson stayed partial. Now `POST /api/lesson/stream` takes an optional `continueFrom` (ChatGPT has `/conversation/resume` and resume tokens, §1.4; Wonder rebuilds the turn from the client's persisted lesson instead, so the server keeps no state):

| Field | Meaning |
|---|---|
| `markdown` | The client's persisted lesson (≤ 200,000 chars, else 413) |
| `instruction?` | A steer (≤ 300 chars). Without one it means "resume where it stopped" |
| `fromPage?` | Revise a finished lesson: keep the pages before page N (1-based, must exist, else 400) and rewrite from there |
| `messageId?` | The original message id. It salts the resolution ids, so the kept pages compile to the same ids and their components keep their state |
| `sources?` | Up to 60 source items behind the kept Cite pills (from the old `componentResults`). Only refs cited in the kept pages are accepted |

- **Kept part.** `fromPage` (revise) → everything before that page (`trimBeforePage`). Otherwise (resume, with or without an instruction) → everything up to the last complete paragraph/block (`trimToLastBlock` in `server/steering.js`), so an interrupted page keeps its heading and finished paragraphs. A cut point is the start of a line after a blank line, accepted only when the kept prefix:
  - is outside a code fence;
  - has no half-written component tag and no component or primitive element left open (`scanComponentTags` from `server/compile.js`: an `incomplete` tag means JSON props still streaming; `<Callout>…`/`<grid>…` must be closed);
  - has no open math span (`$…$`, `$$…$$`, `\[…\]`, `\(…\)`, `<math>…</math>`: `protectMath` from `server/math-spans.js` holds nothing back in partial mode);
  - does not end in a list, table or blockquote that may still continue (a different block must already have started after it).

  The page-level cut is the floor: it never keeps less than `trimToLastPage`. A live steer and "Revise from this page" stay page-level on purpose (they rewrite the rest from the next page).
- **Records.** The same as a live steer: `control steering-status accepted` (with `resume: true` when there is no instruction), `steering-message` (only with an instruction), a reasoning line, then a `replace` record with the kept markdown (revision 2, after the empty start) and normal appends. Every record passes chatgpt-dil's `validateRecord`, and revisions only increase.
- **Request.** The normal lesson loop, with web search, memory and citations exactly as for a new lesson. The single user turn is `steeringUserContent(request, kept, instruction, {mode})`: the original request plus `<lesson_so_far>` (cites stripped) plus the instruction. There is no prefill. There are three wordings: steer ("start directly with the next `##` page"), resume ("it stopped right after the last line above, possibly partway through the page "## X". Continue from the very next sentence; do not repeat or rewrite anything above; keep the same page structure", and finish that page without writing its heading again; with an instruction, the change applies from there on) and revise ("write page N and every page after it again"). A continuation stream is steerable live like any other.
- **Duplicate guard.** Resuming mid-page invites the model to restate the page heading or the last paragraph. `createContinuationGuard(kept)` sits between the continuation's first upstream attempt and the writer. It buffers the start of the stream and drops every leading block that matches a kept block, exactly or after whitespace/case normalisation with Cite tags removed. The first text that cannot be a repeat is released immediately, so streaming isn't delayed.
- **Citation ids.** `createContinuationSources` (in `server/steering.js`; it wraps `grounding.js`'s registry) seeds the kept sources so their pills resolve on the server, and the final `<Sources/>` lists old and new sources. New refs start after the highest `turn0search<N>` in the kept markdown, numbered N+2, so they never collide with kept Cite tags. A URL that was already cited reuses its ref and number.
- **Client merge.** At the first program of the continuation, `carryOver` keeps the old citation and widget `componentResults` only for resolution ids still present in the kept program. Old Cite pills therefore keep working even without `sources`, and rewritten widgets (such as the quiz) start fresh. `mergeContinuedAppData` overlays the new stream's results on top, with new winning, and the merged appData is persisted with the lesson.
- **Persistence states** (`lesson.status`): `new` | `streaming` (with `streamOwner` = this page load's id) | `interrupted` | `complete` | `failed`. During a stream the client persists the markdown, the latest dil, `messageId` and appData about once a second, and again on `pagehide`/`beforeunload`. `lessonPhase()` treats a `streaming` lesson owned by another page load (reload, closed tab) as interrupted. A stream that ends with `control failed` code `stalled` or `network` (the idle watchdog in `server/claude.js`), or with a client-side network drop, is persisted as `interrupted` and gets the Resume banner. Other failure codes keep the normal error card with "Try again". A failed continuation that never started leaves the persisted lesson untouched.
- **Demo mode.** It is deterministic. When the kept text (Cite tags removed) is a prefix of the sample, `demoContinuation` streams the sample from exactly that paragraph boundary, mid-page included. Otherwise it continues after the kept text's last block if the sample contains it, or else from the next page. It grounds citations with the continuation registry and applies `steerDemoRemainder` when there is an instruction. Resuming an interrupted sample reproduces it byte for byte from every paragraph boundary.

### Cross-tab lock: one writer per lesson

Every stream writes the lesson to localStorage, so two tabs resuming the same lesson would both write it. `public/lesson-lock.js` (`createLessonLocks`; locks, storage, clock, timers, channel and event target are all injectable) gives each lesson a lock that is held for the whole of any stream of it: a new lesson, a resume, a steer after a reload, or a revise.

- **Web Locks** (preferred): `navigator.locks.request('wonder-lesson-<id>', {ifAvailable:true}, …)`. A tab that can't take it gets `null` immediately instead of queueing. The browser frees it when the tab closes or crashes. `isHeld()` uses `locks.query()`, or an `ifAvailable` probe when `query` is missing.
- **Lease fallback** (no `navigator.locks`): `localStorage['wonder.lock.<id>'] = {owner, expires}`. The lease lasts 10 s, is renewed every 3 s, and is removed on release and on `pagehide`. An expired lease (a frozen or crashed tab) is free to take.
- **Lesson screen** (`public/app.js`). Before deciding what to show, the screen asks `isHeld()`. `lessonPhase(lesson, {lockedElsewhere})` returns `elsewhere` whenever another tab holds the lock, so the "streaming → interrupted after a reload" rule never fires for a lesson another tab is still writing, and no second stream starts.
  - The waiting tab shows "This lesson is being written in another tab" and re-reads the lesson from storage on every `storage` event, so it follows the other tab's saves live. These copies are in memory only, never written back.
  - When the lock is freed (a BroadcastChannel `wonder` "released" message, the storage event on the lease key, or a 3 s poll as a backstop), it re-opens the lesson from storage. That lands in Revise when the other tab finished and in Resume when it was interrupted.
  - A tab sitting in Resume or Revise also switches to the notice when another tab takes the lock (an "acquired" broadcast). If two tabs click Resume at once, the one that loses `acquire()` shows the notice.
  - The writer releases the lock in its own `pagehide` handler, after its last save, so a waiting tab never re-opens the lesson from an older save.

## Phase 5: interactive function graphs

```
<FunctionGraph title="…" fn="a*sin(b*x)" params={[{"name":"a","min":0,"max":3,"step":0.1,"value":1,"label":"amplitude"}]}
  xRange={[-6.28,6.28]} yRange={[-3,3]} caption="…" points={[{"x":0,"y":0,"label":"origin"}]}/>
```

- **Validation** (`server/function-graph.js`, registered in `catalog-schema.js`):
  - **Curves.** `fn`, or `fns` with up to 3 curves (`{fn, label}`). Each must compile with `public/expr.js` using only `x` and the declared params. A leading `y =` is dropped.
  - **Params.** At most 4. Names are short identifiers, not `x`, a function name or a constant. Each needs min < max and at most 400 steps; the value is clamped to the range.
  - **Ranges.** Ranges must be sane. `yRange` is chosen automatically when it is missing.
  - **Points.** At most 6.
  - **Drawable.** The curve must be drawable somewhere in the window.
  - **Fallback.** Invalid props become fallback markdown: the formula as code, the parameter ranges and the caption.
- **Sandbox component** (`public/catalog-extras.js`). The expression compiler's source is injected into the prelude, so nothing the model writes is ever evaluated as JavaScript.
  - **Plot.** Grid and axes are `path` elements. Curves are sampled with `sample()`, broken at asymptotes and clipped to the y window. Points are `circle` elements.
  - **Labels.** There is no SVG `<text>`, so axis ranges and labels are DIL text rows around the plot.
  - **Formula.** A readout shows live values, for example `y = 1.2·sin(1.1·x)`.
  - **Controls.** Each param gets −/+ stepper buttons, an 11-stop segmented track and a Reset button. Everything re-renders through `DIL.useState`.
  - **Size.** A 600×300 view on desktop, 320×220 on mobile (`useIsMobile`).
- **Prompt.** For math, physics and economics lessons built on y = f(x), Claude includes exactly one graph. The tutor knows the component too.
- **Demo.** The compound-interest sample graphs `1000*(1+r)^x` against simple interest `1000*(1+r*x)`, with an `r` slider.

## Phase 3-5 tests and live verification

`node --test genui-lab/wonder/test/index.js` now runs 155 tests (with phases 1–2 merged), with no network:

- **`grounding.test.js`:**
  - The tool is added only when enabled.
  - Cite placement after cited spans.
  - `pause_turn` continuation shape and cap.
  - Search narration and server-tool errors.
  - The componentResults shape.
  - Safe insertion points.
  - The Cite popover and `open_url` action.
  - Sources rendering.
  - Demo citations.
- **`steering.test.js`:**
  - Abort and continuation request shape (kept pages, instruction, no prefill, same system prompt).
  - Control records, and the replace record with increasing revisions.
  - `ConversationTurn` tail replacement.
  - Demo steering over HTTP.
  - Rejections.
- **`continue.test.js`** (resume / revise / race):
  - The `continueFrom` request shape with the fake client: the trim, `fromPage`, the instruction, no prefill, and web search and memory still applied.
  - Resume without an instruction.
  - Validation: 400/413, the `fromPage` range, `messageId` reuse.
  - The race: a steer accepted after Claude's last token is applied as a continuation.
  - Continuation source ids: seeded, never colliding, URLs de-duplicated.
  - The prompt wordings.
  - Demo resume and revise over HTTP: kept prefix, stable resolution ids, all cites resolved, Sources old + new, the program runs.
  - NDJSON validity and monotonic revisions.
  - Client `carryOver`/`mergeContinuedAppData` tail replacement.
  - Persistence states and the `stalled`/`network` → interrupted mapping.
- **`resume.test.js`** (mid-page resume + cross-tab lock):
  - Paragraph-boundary trimming on crafted cases: never inside a tag, a component's JSON props, a code fence, a math span, or a list/table/blockquote in progress; never below the page floor.
  - An every-prefix property on the three demo lessons plus the grounded one: the kept text compiles with zero invalid components, has no half-written tag or open math span, and a demo resume from it reproduces the lesson.
  - The continuation prompt shape: resume vs steer vs revise, and `normalizeContinueFrom` keeping blocks for a resume.
  - The duplicate guard: heading, heading + paragraph, whitespace-normalised and cited repeats, several chunk sizes, early release.
  - The Claude path de-duplicating a repeated heading and paragraph, and demo resume over HTTP from a mid-page boundary, with and without a change.
  - The lock: lease acquisition, exclusivity, renewal, expiry, takeover and release; `watch` via poll, storage event and `pagehide`; Web Locks across two instances sharing Node's `navigator.locks` (including the probe path and the "acquired" broadcast); interrupted detection respecting a live lock.
- **`function-graph.test.js`:**
  - Good and bad props: syntax, unknown variables and functions, too many params, points or curves, reserved names, ranges.
  - Fallback.
  - Sandbox render: path, peak height, slider and stepper presses, clamping, reset, asymptotes, mobile, multiple curves.
  - The compound demo slider.
  - Every prefix around the tag.
- **`real-claude-cited.test.js`** replays `test/fixtures/claude-lesson-cited.ndjson`. It is a real web-searched lesson steered with "Simpler"; the intermediate dils were dropped to keep it at 177 KB, and it holds no secrets or encrypted payloads. The test checks:
  - Every record validates.
  - All 18 cites resolve.
  - The Sources list renders.
  - Recompiling gives byte-identical code.
  - Every prefix runs.
  - A Claude-written FunctionGraph works.

Live check against `claude-opus-5-5`, using 5 requests:

1. **"How the James Webb Space Telescope works".** Claude did not search, because the topic is stable knowledge. The grounding prompt was tightened after this.
2. **"What the James Webb Space Telescope has discovered so far", with the default dynamic-filtering tool.** Claude ran 5 searches through code execution, but there were 0 citations. This led to `allowed_callers: ["direct"]`.
3. **The same topic with direct search, in the browser, steered with "Simpler" after page 2 (two requests).**
   - The first request made 4 searches. The steer was accepted, and the continuation searched twice more and wrote the remaining 4 pages in simpler language.
   - The result has 18 Cite pills and 13 sources.
   - The popover was checked at desktop and 390 px, with no console errors.
4. **"Understanding sine waves".** Claude wrote a valid `FunctionGraph` (`a*sin(b*x)` with amplitude and frequency sliders). Pressing +/− re-rendered the curve at desktop and 390 px.

5. **Resume and revise (`continueFrom`), 3 requests.** "What the James Webb Space Telescope has discovered so far":
   - **Reload mid-stream.** The lesson was reloaded on page 4, after 6 cites. It came back as "Lesson interrupted" with the 3 complete pages, a partial page 4 and working pills.
   - **Resume.** It sent the 6,217-char lesson, its messageId and 9 sources. The continuation searched again and rewrote page 4 plus the quiz. The kept pages were byte-identical, the new refs were `turn0search9`–`12` (kept max: 8), and the Sources list showed 13 items.
   - **"Revise from page 3" with More examples.** Pages 1–2 were unchanged and pages 3–5 were rewritten (5.9k → 7.2k chars), with new refs starting after the kept `turn0search4`. Old pills on page 1 still opened their popover.
   - Checked at desktop and 390 px with no horizontal scroll and no console errors.

6. **Mid-page resume + cross-tab lock, 2 requests.** "How ocean tides work":
   - **Reload mid-page.** The lesson was reloaded on page 3, "Coastlines turn up the volume", at 6,469 chars, in the middle of its second paragraph.
   - **Resume.** The `replace` record kept the page heading and its first complete paragraph (it ends after `…measured at Burntcoat Head.` + the Cite pill). The continuation began "Why so huge there? The main reason is resonance…", with no repeated heading or paragraph. The heading appears once, and the lesson finished with 4 pages + Quiz (10,011 chars).
   - **Second tab during the resume.** It showed "Writing in another tab", with no Resume or Steer and the stored status still `streaming`, not marked interrupted. When the first tab finished, it re-opened the lesson in Revise mode with Finish enabled.
   - Also checked against a slowed demo server (no requests): a tab already in Resume mode switches to the notice when the other tab resumes, and it follows the other tab into Resume when that tab is reloaded mid-stream.
   - Checked at desktop and 390 px with no horizontal scroll and no console errors.

Known gaps:
- Revise still rewrites from a page boundary. It can't edit one paragraph inside a page. Resume continues mid-page, but only from a paragraph boundary: a half-written paragraph is dropped and written again.
- A continuation drops widget state (such as quiz answers) for the rewritten pages, and a steer that lands after the last page has been written only rewrites the last page.
- Widget state (graph sliders, stepper step, flashcards, …) is saved per lesson and message; see "Widget state persistence". The sandbox worker reports every change immediately and the store flushes synchronously on `pagehide`, so a change made just before a hard reload is kept. "Reset interactive widgets" also clears server-graded quiz answers (`quiz_restart` for each graded quiz) and the widgets in tutor replies.
- **Search latency is tuned.** Claude writes the title and hook before searching and makes 1–2 focused searches (`max_uses: 3`). On the same JWST topic, live: first text went from 34.2 s to 1.6 s and the whole lesson from 59.5 s to 44.1 s, with 9 sources still cited. Every stream has an idle watchdog (`WONDER_STREAM_IDLE_MS`, default 120 s), so a stalled connection fails fast as a resumable `stalled`/`network` error instead of hanging. After a search, an exact repeat of an already-written paragraph (e.g. the hook) is dropped.

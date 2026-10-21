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
| `POST /api/lesson/stream {topic, level?, lessonTitle?, lessonSummary?, course?}` | NDJSON lesson |
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
node --test genui-lab/wonder/test/index.js      # 155 tests, about 7 s, no network
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
public/index.html, styles.css, app.js (screens), ui.js, review.js, store.js, deck.js, practice-core.js, math.js
public/teacher-screen.js, teacher-core.js (progress snapshot, history), memory-screen.js
public/learning-catalog.js (in-sandbox components), learning-runtime.js, wonder-worker.js, dil-surface.js, stream-client.js
test/*.test.js, test/index.js, test/helpers.js
```

## Limitations

- **The Claude path is tested only against a fake client.** No real API calls were made while building this. The prompts are untested against the live model, so the first real lessons may need prompt tuning.
- **Math is not typeset.** There is no KaTeX: `public/math.js` rewrites rendered LaTeX into Unicode (`\frac{1}{\lambda^4}` becomes `1⁄λ⁴`). Complex formulas stay readable but are not typeset.
- **Server-side widget state is in memory** (quiz answers per resolution id). The client persists `componentResults` with each lesson, so reloads still restore it, but a server restart forgets its copy.
- **One sandbox worker per surface**: the lesson plus each tutor reply. Very long tutor threads therefore start many workers. They are terminated when you leave the lesson.
- **Tutor replies are not lesson-specific in demo mode.** They are templates that use the lesson's KeyTerms and Quiz. Any other topic streams one of the three sample lessons.
- **No accounts or sync.** Courses, lessons, the deck and XP live in this browser's localStorage, and the app falls back to in-memory storage when localStorage is blocked.
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

- **UI.** While a lesson streams, a "Steer" bar sits under the reasoning line. It has chips (Simpler, More examples, Go deeper, Shorter) and a free-text input. The code is in `public/steer-bar.js`; `public/steering-core.js` holds the chips, `trimToLastPage` and the reducer.
- **`POST /api/lesson/steer {operationId, instruction}`.** The operationId comes from the stream's control records. The endpoint aborts that operation's current upstream attempt (`server/steering.js`: one AbortController per attempt, linked to the response).
  - Accepted: returns `{ok:true, status:"accepted"}`.
  - Finished or unknown operation: 409 `{status:"rejected", reason:"not_streaming"}`.
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

Known gaps:
- Steering works only while the original NDJSON connection is open. After a reload there is no operation to steer.
- Graph slider values are not persisted.
- Search slows lessons down. In the live runs a lesson took about 42 s without searches and about 68 s with them.

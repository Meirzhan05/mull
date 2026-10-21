# Wonder: AI lessons with model-written interactive UI

Wonder is a working learning app that combines the two systems reverse-engineered in this lab:

- **wondering.app's product loop.** You pick a topic or plan a course. You get a short paged lesson with interactive widgets and a tutor you can ask about it. When you finish, knowledge cards are revealed in a "pack opening", and spaced-repetition review is scheduled with FSRS. XP and streaks are tracked throughout.
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

`ANTHROPIC_API_KEY=... npm start` also works, as does an `ant auth login` profile. The server never reads, prints or logs the key. `GET /api/status` returns only `{mode: "claude"|"demo", model}`. `PORT` changes the port. `WONDER_MODE=demo` forces demo mode even when credentials exist.

### Demo mode

If there is no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and no profile credential file, the server starts in demo mode. It also switches to demo mode when the first Claude call fails with `AuthenticationError` or a missing-credentials error before any text was produced. The UI then shows a "Demo mode — set ANTHROPIC_API_KEY to use Claude" banner.

Demo mode streams these through the real compile + NDJSON pipeline in 20–60 character chunks:

- **Lessons** in `server/demo/`: *How transformers predict the next word*, *Why the sky is blue* and *Compound interest*. The topic is matched by keyword, and any other topic falls back to one of the three.
- **Tutor replies.** `tutor-explain.md` and `tutor-quiz.md` are templates. The quiz reply is a `<Quiz>` built from the lesson's own `<KeyTerm>`s. "Explain this" on a missed quiz question gets a reply built from that question's explanation and hint.

Practice extraction in demo mode is deterministic, built from the lesson's `<KeyTerm>` and `<Quiz>` components.

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

## Claude usage

All of this lives in `server/claude.js`. The client is dependency-injected, so tests pass a fake.

- **Lesson and tutor turns** use `client.beta.messages.stream({ model: "claude-opus-5-5", max_tokens: 64000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", thinking: {type: "adaptive"}, output_config: {effort: "medium"}, system: [{…, cache_control: {type: "ephemeral"}}], messages })`.
  - The system prompt is static so the cache prefix stays stable. The per-lesson tutor context goes in a second system block after the breakpoint.
  - There is no temperature, top_p or prefill.
  - Text comes from `content_block_delta`/`text_delta` events, followed by `await stream.finalMessage()`.
  - `stop_reason === "refusal"` produces a graceful message. `"max_tokens"` marks the turn as truncated (`debug.truncated`).
- **Course plans and practice extraction** use `client.messages.create` with `output_config: {effort: "low", format: {type: "json_schema", schema}}`. The JSON is parsed and every item is validated.
- **Errors** are caught most specific first: `AuthenticationError` → `RateLimitError` → `BadRequestError` → `APIError`. Each becomes a `control failed` record with a friendly message. Raw API text is never forwarded.

## Endpoints

| Endpoint | Response |
|---|---|
| `GET /api/status` | `{mode, model}` |
| `POST /api/lesson/stream {topic, level?, lessonTitle?, lessonSummary?, course?}` | NDJSON lesson |
| `POST /api/tutor/stream {lessonContext:{title, markdown}, history, message}` | NDJSON reply; the final content record carries `followupPrompts` |
| `POST /api/course/plan {topic, level}` | JSON `{plan:{title, description, sections:[{title, lessons:[{title, summary}]}]}}`; the client renders it as a course path |
| `POST /api/widget_action {componentName, action_type, payload, resolutionId}` | JSON `{componentResults?, issueTurn?, result?}` |
| `POST /api/practice/extract {lessonMarkdown}` | JSON `{cards:[{term, definition, example}], items:[…]}` |

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

Claude can also use the DIL layout primitives (`box/row/col/grid/text/title/icon/badge/divider/math/…`), with icon names taken from `chatgpt-dil/src/icons.js`.

## Tests

```sh
node --test genui-lab/wonder/test/index.js      # 56 tests, about 5 s, no network
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
- **`deck.test.js`** covers practice grading, FSRS deck scheduling (learning steps, graduation, growing intervals, lapses), XP/streak rules, and localStorage persistence when storage is blocked or corrupted.

## Files

```
server/index.js           entry (npm start)          server/app.js          routes, static files, demo fallback
server/claude.js          Claude params/stream/errors server/prompts.js     system prompts + JSON schemas
server/compile.js         compiler extension         server/lenient-json.js JSON5-ish prop parser
server/catalog-schema.js  prop validators/fallbacks  server/ndjson.js       conversation-source writer
server/demo.js, demo/*.md demo mode                  server/practice.js     practice extraction
server/widget-actions.js  /api/widget_action
public/index.html, styles.css, app.js (screens), ui.js, review.js, store.js, deck.js, practice-core.js, math.js
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
- **Inherited from chatgpt-dil:** a best-effort sandbox lockdown and no SVG `<text>`. Flowchart and ConceptMap are therefore laid out with boxes rather than drawn edges.

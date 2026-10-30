# Mull: AI lessons with model-written interactive UI

Mull is a working learning app that combines the two systems reverse-engineered in this lab:

- **wondering.app's product loop.** You pick a topic or plan a course. You get a short paged lesson with interactive widgets and a tutor you can ask about it. When you finish, knowledge cards are revealed in a "pack opening", and spaced-repetition review is scheduled with FSRS. A daily streak is tracked throughout. A **Teacher** agent plans your study, proposes lessons, quizzes you and remembers what matters, and a **learner memory** personalizes every lesson, tutor reply and Teacher turn.
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

Mull is a Next.js 16 app (App Router, Turbopack).

```sh
cd genui-lab/wonder
npm install
cp .env.example .env        # then put your key after ANTHROPIC_API_KEY=
npm run dev                 # next dev → http://localhost:8750
```

For production, `npm run build && npm start` (`next start -p 8750`). `ANTHROPIC_API_KEY=... npm run dev` also works, as does an `ant auth login` profile. The server never reads, prints or logs the key. `GET /api/status` returns only `{mode: "claude"|"demo", model, videos: "youtube"|"demo"|"off"}`. Pass `-p <port>` to `next` to change the port. `WONDER_MODE=demo` forces demo mode even when credentials exist. `WONDER_MEMORY_FILE` moves the learner memory file. `WONDER_FIGURES=off` stops `<Figure/>` from looking images up on Wikimedia Commons, and `WONDER_FIGURE_CHECK=off` skips the Figure vision check. `YOUTUBE_API_KEY` lets `<Video/>` search YouTube, and `WONDER_VIDEOS=off` turns videos off (see [Credentials](#credentials)). `WONDER_RECORD_DIR=<dir>` writes each lesson, tutor and Teacher stream's NDJSON to a file there; that is how the fixtures were captured, and the records contain no credentials.

### Demo mode

If there is no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and no profile credential file, the server starts in demo mode. It also switches to demo mode when the first Claude call fails with `AuthenticationError` or a missing-credentials error before any text was produced. The UI then shows a "Demo mode — set ANTHROPIC_API_KEY to use Claude" banner.

Demo mode streams these through the real compile + NDJSON pipeline in 20–60 character chunks:

- **Lessons** in `server/demo/`: *How transformers predict the next word*, *Why the sky is blue* and *Compound interest*. The topic is matched by keyword, and any other topic falls back to one of the three.
- **Tutor replies.** `tutor-explain.md` and `tutor-quiz.md` are templates. The quiz reply is a `<Quiz>` built from the lesson's own `<KeyTerm>`s. "Explain this" on a missed quiz question gets a reply built from that question's explanation and hint.

- **Teacher turns.** `server/teacher-demo.js` is a scripted stand-in for Claude that speaks the Messages streaming event protocol (text deltas, `tool_use` blocks with `input_json_delta`, stop reasons). The real tool loop drives it, so demo turns go through the same validation, tool execution, card splicing and NDJSON path. It answers goals/plans (remember → get_progress → plan_study + create_lesson), "quiz me" (a Quiz from your last lesson), "how am I doing", "forget that", facts about yourself, and anything else with a lesson suggestion.

Practice extraction in demo mode is deterministic, built from the lesson's `<KeyTerm>` and `<Quiz>` components. Memory extraction in demo mode notes a struggle when you miss at least a third of a lesson's quiz.

## The app

Five sections, in a sidebar on desktop (with the streak and a link to your profile at the foot) and a bottom tab bar on phones, plus a ⌘K / Ctrl K (or `/`) command palette that searches lessons, courses and Teacher chats and starts a lesson, course or Teacher chat on whatever you type.

- **Today (`#/`).** A greeting, a command bar with three modes (Lesson, Course, Teacher), and the dashboard described above. Topic suggestions come from the interests picked at onboarding. **Up next** picks the single best next action (`public/progress-core.js` `upNext`): continue an unfinished lesson, review due cards, the next item of the saved study plan, or the next lesson of a course. The saved study plan and recent lessons follow.
- **Lesson (`#/lesson/<id>`).** A focused reader: the sidebar collapses to an icon rail and the phone tabs hide. The bar shows a segmented progress bar (one segment per page; click to jump), "Page x of n", a contents menu, the tutor toggle and a menu with text size and widget reset. While Claude writes, a status line and a compact **Steer** pill sit above the lesson. Highlight any passage to **Explain** it or **Ask about this** in the tutor. The end of the lesson is a colophon that turns into "Collect the cards", then the index cards, then a **what next** step: the next course lesson, a review, or Today. Reopening a lesson offers to jump back to the page you were on.
- **Tutor.** A sticky side panel on wide screens, a side drawer on tablets and a bottom sheet on phones, with starter prompts (summarize, real-world example, quiz me, explain like I'm 12).
- **Library (`#/library`).** Every lesson and course in this browser, with search, filters (in progress, finished, courses) and delete. Courses open as a path (`#/course/<id>`) with a progress ring and a Continue button.
- **Review (`#/review`).** FSRS review with keyboard shortcuts: 1–5 or A–E to choose, T/F, Space to show an answer, 1–4 to grade, Enter to continue.
- **Teacher (`#/teacher`).** The agent chat with tool cards (below).
- **You (`#/you`).** Name, account and sync, totals, "What you know", a 22-week activity heatmap, and settings (level, interests, theme, lesson text size, reminder). Memory, material and "What works for you" are still kept and synced but have no place on this screen.
- **Onboarding.** A full-screen welcome in two steps: interests (with the name filled from the Google account), and a first lesson. With accounts on it runs only after sign-in. A topic brought from the landing page leads the last step as **Your first lesson**, one press from starting. All of it is skippable.
- **Landing page (`/welcome`).** A scroll page that replays a recorded lesson. Its composers and topic cards say **Continue with Google** and open `#/start/<topic>` in the app. The home page `/` opens on it instead of Today (a pre-paint script, `app/landing-script.js`, run by `app/layout.js`):
  - **Account sync on:** for any browser without an account, every time and on any hash, because everything in Mull needs a signed-in user. A deep link (`#/lesson/<id>`, `#/library`) is saved as `wonder.signInReturn`, so the visitor lands back on it after signing in. A browser that has signed in before (`wonder.account` is set) stays in the app, where **Sign in again** is if its session ended. A page coming back from Google sign-in (`?neon_auth_session_verifier=`) stays too, so the app can finish the sign-in, and so do the hashes that lead into sign-in (`#/start…`, `#/signin`, `#/learn/…`). Neon Auth's cookies are HttpOnly, so the script goes by the account marker, not cookies.
  - **Accounts off:** for a first-time visitor, once (`wonder.welcomed`), when this browser has no Mull data (`wonder.v1`, `wonder.account`).
  - With accounts off, deep links such as `#/lesson/<id>` never redirect. The page is static files in `public/welcome/`; `next.config.mjs` rewrites `/welcome` to its `index.html`. It began as the ScrollCraft build in `scrollcraft/builds/wonder`, but `public/welcome/` is now the copy to edit: it has the app-only parts the standalone build lacks.
  - **Real recordings.** The replayed lesson ("Why the Roman Empire Fell", `test/fixtures/claude-lesson-rome.ndjson`, steered once with Simpler) and the Teacher's week (`claude-teacher-statistics.ndjson`) are real claude-opus-5-5 turns. `npm run welcome:data` rebuilds `public/welcome/js/data.js` from them.
  - **Ways in.** `#/start[/<topic>]` (`public/start-core.js`): the composers (hero, the end of the replay, the close), the topic chips and cards link there. With accounts on and signed out it signs in with Google first, and the topic waits in `wonder.afterSignIn`. A new account then gets onboarding with the topic leading its last step; someone already onboarded starts the lesson. Without accounts it opens onboarding or the lesson directly. `#/learn/<topic>` (old links) signs in first the same way, and `#/signin` opens sign-in over Today. The page asks `/api/account`: with accounts on and nobody signed in, the bar's link reads **Sign in** and the notes name the steps that follow (the close lists onboarding's own step names). Accounts off, or already signed in, the composers read **Start a lesson** and the link reads **Open Mull**. `app/layout.js` marks `<html data-accounts>` so the client knows at boot whether sign-in comes first.

**Design.** A neutral design system in light and dark (Vercel-style grays: white and near-black), with one blue accent for focus, links and the current state. Geist for text and Geist Mono for numbers and keys (both self-hosted by `next/font`); soft corners, filled controls with focus rings, pill segmented controls and cards with a hairline border and a light shadow. Each section has its own layout: **Today** is a dashboard (a command bar, the "Up next" queue, suggestion tiles and recent reading, and a rail with the streak, the deck and the study plan); **Library** is a pair of sortable tables; **Review** puts the card beside a live session panel (position, accuracy, the queue, the deck, the keys); **Teacher** adds a column showing what it sees (your progress, memory and plan); **You** is a settings page with a section nav. Lessons are a clean article with numbered pages; finishing one turns its ideas into cards. Reading time is estimated from the prose plus about half a minute per interactive widget.

## On Next.js

- **Pages.** `app/layout.js` (fonts, global CSS, metadata, the pre-paint theme script) and `app/page.js` → `app/wonder-app.js`. That client component renders the shell frame and, after hydration, starts the Mull client (`public/app.js`). The client screens stay unbundled ES modules in `public/`: the lesson renderer runs model-written UI in a sandboxed Web Worker that imports the DIL runtime by URL. Screens route with the URL hash.
- **API.** `app/api/[...route]/route.js` sends every `/api/*` request to the Mull core (`createWonderCore` in `server/app.js`) through a Fetch-API adapter (`server/web.js`). JSON endpoints return JSON `Response`s. NDJSON endpoints return a `ReadableStream` that the turn keeps writing into, and a client disconnect aborts the turn. There is one core per server process (`getWonderCore`), so a steer request reaches the lesson stream that is still running.
- **Read-only module mounts.** `app/chatgpt-dil/src/[...path]`, `app/wondering-genui/src/[...path]` and `app/vendor/katex/[...path]` serve the sibling lab folders and KaTeX with traversal refused. `next.config.mjs` roots Turbopack and output tracing at `genui-lab/` so the server can import `../chatgpt-dil` and `../wondering-genui`.
- **Tests.** The same core also runs behind a small `node:http` server (`createWonderServer`), which the test suite drives. `test/web.test.js` drives the Fetch-API adapter that Next uses.

## How the two systems map into Mull

| Concern | ChatGPT (DIL) | Wondering | Mull |
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
| Gamification | n/a | XP events, streaks with local-date keys (§7) | `public/deck.js`: no XP. Finished lessons, quizzes, explanations and reviews count as the day's activity (the heatmap), plus a streak that counts consecutive local days |
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
- **The Figure vision check** (`server/figures.js`) is the same structured call on `claude-haiku-5-5` with the image as `{type: "image", source: {type: "url", url}}`. See [Diagrams and real images](#diagrams-and-real-images).
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
| `POST /api/lesson/stream {topic, level?, lessonTitle?, lessonSummary?, course?, continueFrom?, mastery?, verify?, variant?, learnerInsights?, materialId?}` | NDJSON lesson. `continueFrom: {markdown, instruction?, fromPage?, messageId?, sources?}` resumes or revises a persisted lesson (Phase 4). Ends with a `quality-report` control unless `verify: false` (Phase 7). `variant` is the teaching style and `learnerInsights` holds the measured findings (Phase 9). `materialId` teaches from the learner's material (Phase 10) |
| `POST /api/lesson/steer {operationId, instruction}` | JSON `{ok, status: accepted\|rejected}`; the result streams on the lesson's own NDJSON (Phase 4) |
| `POST /api/tutor/stream {lessonContext:{title, markdown}, history, message, mastery?, mode?}` | NDJSON reply; the final content record carries `followupPrompts`. `mode: "socratic"` is Guide me (Phase 8) |
| `POST /api/course/plan {topic, level, materialId?}` | JSON `{plan:{title, description, sections:[{title, lessons:[{title, summary}]}]}}`; the client renders it as a course path |
| `POST /api/widget_action {componentName, action_type, payload, resolutionId}` | JSON `{componentResults?, issueTurn?, result?}`. `explain_grade` and `practice_grade` on an `explain` item call the grader (Phase 8) |
| `POST /api/practice/extract {lessonMarkdown}` | JSON `{cards:[{term, definition, example}], items:[…]}` |
| `POST /api/teacher/stream {threadId, history, message \| opener:true, progress, memoryEnabled, mastery?}` | NDJSON Teacher turn. `opener: true` is a check-in: the server sends its own fixed turn (Phase 10). Cards live in the final `dil.appData.opGenui.componentResults`; `followupPrompts` on the final record |
| `GET /api/memory` | `{items:[{id, fact, kind, source, createdAt}]}` (newest first) |
| `POST /api/memory {fact, kind}` | Adds a user fact (de-duplicated) |
| `DELETE /api/memory?id=…` or `DELETE /api/memory {all:true}` | Removes one item, or forgets everything |
| `POST /api/memory/extract {lessonTitle, quizResults, tutorThread, memoryEnabled}` | `{added:[…], source}`: 0–3 new facts from a finished lesson |
| `GET /api/materials` · `POST /api/materials {kind: text\|pdf, text \| base64, title?, filename?}` · `DELETE /api/materials?id=` | The learner's materials (Phase 10). Stored in `data/materials/` |
| `GET /api/materials/file?id=` | The original material (text or PDF) that Cite pills open |

`memoryEnabled: false` on lesson, tutor, Teacher and extraction requests leaves memory out of the prompt (and the Teacher's `remember`/`forget` return an error result instead of writing).

Next serves `public/` and, through read-only route handlers, `genui-lab/chatgpt-dil/src/*` and `genui-lab/wondering-genui/src/*`. Client modules import those through relative paths such as `../../chatgpt-dil/src/host.js`, which resolve the same way under Node and in the browser.

## The learning catalog (what Claude can write)

| Component | Notes |
|---|---|
| `KeyTerm` | Inline; tap to show the definition and an "Explain more" action |
| `Callout` | The "Mull it over" aside; tones insight/tip/info/warning/example; takes markdown children |
| `LessonStepper` | Step-by-step walkthrough |
| `Reveal` | Predict, then check |
| `CompareToggle` | Segmented left/right view, plus side-by-side on desktop |
| `InputOutputSlider` | Pressable stops |
| `Flowchart` | Start/process/decision/end nodes, branch jumps |
| `Timeline` | Events in order |
| `BarChart` | Bars with values; one may be highlighted |
| `ConceptMap` | Concepts linked to a center concept |
| `Cycle` | SVG ring |
| `Quiz` | Hints, feedback, explanations, "Explain this" → tutor, results (the runtime's confetti is hidden by the Folio stylesheet), retry, server-graded state restore |
| `Flashcards` | Flip cards; "Save to review deck" |
| `Celebration` | Confetti moment |
| `ExplainBack` | Free-response answer graded against a rubric on the server (Phase 8) |
| `Diagram` | A drawing Claude composes from simple SVG shapes and labels. Tap a part (on the drawing or its chip) to read about it; step through with Back/Next while shapes fade in and the rest dims. See [Diagrams and real images](#diagrams-and-real-images) |
| `Figure` | A real, freely licensed image from Wikimedia Commons. Claude writes a search phrase; the server finds the image, its license and author. Tap to enlarge, optional "Look closer" question, credit line with a Source link |
| `Video` | A short real YouTube clip in a sandboxed `youtube-nocookie.com` player. Claude writes a search phrase and what the clip should show; the server picks the video and the segment. Optional "predict first" question before it plays, and up to two questions that open when the clip ends (the player pauses there) |
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

1. The client sends the message, a text history (cards as `[Card: …]` notes), a **progress snapshot** assembled from localStorage (`public/teacher-core.js`: deck size, due cards, mastered, streak, recent lessons with quiz scores, courses, saved plans) and `memoryEnabled`.
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
  - Post-lesson extraction. "Finish lesson" sends the quiz results and the learner's tutor questions to `/api/memory/extract`: a structured-output call at effort low, giving 0–3 facts that are de-duplicated against memory. A toast says what Mull will remember.
  - The Memory screen.
- **Reads.** A compact "About this learner" block with the newest 15 items goes into the lesson, tutor and Teacher system prompts as a system block after the cache breakpoint. The Teacher's copy includes item ids so it can `forget` them.
- **UI.** None on the You screen any more. `public/memory-screen.js` (items by kind, add, delete, "Forget everything", the **Use memory** switch) is kept but not shown; the Teacher's context panel still lists what it remembers.

## Learner model (Phase 6)

Memory holds free-text facts. The learner model tracks what the learner actually knows, per concept, from graded answers.

- **Concept tags.** Lesson Quiz questions, Teacher `quiz_me` questions (a required `concept` field), extracted practice items and ExplainBack widgets each name the one concept they test.
- **Estimate (`public/mastery-core.js`).**
  - Every graded answer is an evidence event with a score between 0 and 1 and a weight: quiz, Teacher quiz and review count 1, an explanation counts 1.5.
  - Mastery is the mean of a Beta(1, 1) posterior over those events, each decayed with a 21-day half-life. Old evidence fades, so a concept that is not practiced drifts to "fading".
  - Statuses: `mastered` (≥ 0.8 with enough evidence), `shaky` (< 0.55 with at least 1.5 units of evidence), `fading` (practiced before, little recent evidence), `learning`.
- **Evidence:**
  - the first attempt at each lesson or Teacher quiz;
  - every FSRS review of a tagged card (Again 0, Hard 0.6, Good and Easy 1);
  - the first attempt at each explanation (score / 3).
- **Storage.** The model lives in localStorage as `mastery` (merged per concept across tabs). The server never stores it.
- **Prompts.**
  - Lesson, tutor and Teacher requests carry a compact summary (up to 8 concepts per status). `server/learner-model.js` re-validates it and adds a "What this learner knows" block after the cache breakpoint, with an instruction for each surface: lessons recap shaky prerequisites and skip what is mastered.
  - The Teacher also sees the summary in `get_progress`.
  - The summary follows the **Use memory** switch.
- **UI.**
  - "What you know" on the You screen (`#/mastery`): concepts grouped by status with mastery bars, a per-concept reset, and **Practice weak spots**, which asks the Teacher for a quiz.
  - A **Strengthen** item in Up next.

## Lesson quality and evals (Phase 7)

- **Lint (`server/critic.js`).** Deterministic checks of the finished lesson against the prompt's own rules:
  - title and hook;
  - 3–4 pages;
  - a visual on every page;
  - page length;
  - a check page with one 3-question Quiz, every question tagged;
  - 2–5 KeyTerms;
  - one ExplainBack;
  - a worked example;
  - no invalid components. The detail names each one with its validator error (`Diagram (Shape 3 is outside the 400x250 canvas)`). A tag that never closes, because its JSON props have unbalanced braces, counts as invalid too (see "Broken tags" below). `stats.media` counts valid and invalid Diagrams and Figures.
- **Broken tags** (`server/compile.js`). A learning tag that never closes is a half-written tail while the lesson streams, so it is cut. In a finished message (`compileWonder` without `partial`, as for the final record), the scanner reports it as `broken` instead. It spans to the end of its paragraph, its paragraph is dropped, and it is reported invalid (`Unclosed tag: its props have unbalanced braces or quotes`). Scanning then goes on, so the rest of the lesson still renders. Before this, one malformed Diagram silently cut every page after it. The lint, the critic's media text and practice extraction read lessons this way too.
- **Critic.** After a Claude lesson streams (not refused, not truncated), a second Claude call (structured output, effort medium, 120 s timeout) reviews the lesson:
  - It checks answer keys, facts, arithmetic and cited claims (shown the cited text), plus level fit and widget sense.
  - It also checks the words inside Diagrams and Figures. The props are long JSON, so after the lesson the message lists, by page, each valid Diagram's title, labels, part texts, step labels and texts, and caption, and each Figure's query, caption, alt, question and answer (`mediaDigest`). A false claim there is a `factual` issue. A mislabeled part, steps out of order, or a Figure question its answer does not answer is a `widget` issue. The critic cannot see Figure images; that is the vision check's job.
  - It returns issues and `quizFixes`. A fix is applied to the Quiz props only if the rewritten Quiz still validates, and the lesson is then updated with one `replace` record.
  - A `quality-report` control record carries the lint result, the critic verdict, the issues and the fixes. The client does not show or keep it; when the critic corrected quiz answers it says so in a toast ("1 quiz answer corrected.").
  - Demo mode runs the lint only. `verify: false` on the request skips both checks.
- **Eval harness (`npm run eval`).**
  - Generates a lesson per topic in `evals/topics.json` through an in-process server, so it runs the real prompts, compile, lint and critic. It uses an empty in-memory learner memory, and web search is off unless `--web` is passed.
  - Scores each lesson with an LLM judge (`server/judge.js`), 1–5 with a rationale on accuracy, clarity, level fit, interactivity and quiz quality.
  - Writes `evals/reports/<timestamp>.json` and `.md`: per-lesson rows, means, the most-failed format checks, and notes.
  - Reports media per lesson (`media` in the JSON, a "Diagrams and figures" table in the markdown):
    - every Diagram and Figure, and whether it validated (`compileWonder(...).components` status and error; `unclosed` for a tag that never closed);
    - a valid Diagram's part and step counts;
    - for a Figure, whether the final record has an image (`found`, with the Commons title), the vision check dropped it (`rejected`, with why), or nothing was found.
  - The summary aggregates these: lessons with a Diagram, with a Figure and with a shown image, plus valid, found, dropped and missing counts.
  - Five topics tagged `media` are physical or spatial (heart, camera lens, plate tectonics, water cycle, Moon phases). `--tag media` runs only those.
  - Options: `--limit n`, `--concurrency n`, `--topics file`, `--tag name`, `--no-judge`, `--no-verify`, `--web`, `--out dir`. `--demo` runs with no API calls.
  - A Claude run costs about 3 calls per lesson: lesson, critic and judge. Each found Figure adds a vision check on Haiku.

```sh
npm run eval -- --limit 3
npm run eval -- --tag media
```

## Free response and "Guide me" (Phase 8)

- **`text-input` primitive.** A Mull extension to the chatgpt-dil host, rendered as a `textarea`. Typing reaches the program through `onChange`. The host never overwrites the value while the field has focus.
- **`<ExplainBack prompt concept rubric={[…]} sampleAnswer/>`.** The learner explains the idea in their own words and taps "Check my answer", which sends `explain_grade` to `/api/widget_action`. `server/grader.js` grades the answer:
  - **Claude mode:** one structured call at effort low, with the answer fenced as data. It returns a 0–3 score, each rubric criterion met or missed with quoted evidence, feedback, the misconception and a follow-up question.
  - **Demo mode,** or when the call fails: a keyword grader.

  The widget then shows the score, criteria, feedback, "Show a model answer", "Ask the tutor" and "Try again". The first attempt counts toward the day's activity and becomes mastery evidence. Lessons include one ExplainBack on their last content page.
- **Review.** Extraction adds one `explain` practice item per lesson. The review screen grades it through the same grader (`practice_grade`), and the score maps to an FSRS rating (0 Again … 3 Easy).
- **"Guide me."** A switch in the tutor header (saved as `settings.tutorMode`) sends `mode: "socratic"`. The tutor then asks one guiding question at a time and gives the answer only after two real tries or when asked outright. The rules (`SOCRATIC_TUTOR_MODE`) go after the cache breakpoint, so the cached tutor prompt is the same in both modes. Demo replies follow the same pattern.

## Tests

```sh
node --test genui-lab/wonder/test/index.js      # no network (Figure and Video lookups are stubbed)
```

- **`mastery.test.js`, `critic.test.js`, `freeresponse.test.js`** cover phases 6–8: the estimator and decay, evidence, prompt injection, the lint, quiz fixes and the `replace` record, the eval harness end to end (demo and fake Claude), the grader, the ExplainBack widget in the sandbox, explain practice items and Guide me.

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
- **`web.test.js`** drives the Fetch-API adapter used by the Next route handlers: status and 404s, a demo lesson as NDJSON, memory and course plans, a live steer reaching the in-flight stream, client-disconnect aborts, and the read-only static mounts.
- **`progress.test.js`** covers the Today and You helpers: studied today, the week strip, the activity grid, topic suggestions from interests, the Up next order and the palette matcher.
- **`deck.test.js`** covers practice grading, FSRS deck scheduling (learning steps, graduation, growing intervals, lapses), activity/streak rules, and localStorage persistence when storage is blocked or corrupted.

## Files

```
app/layout.js, page.js, wonder-app.js, styles/*.css   Next.js page, fonts, CSS, client shell frame
app/api/[...route]/route.js   every /api/* endpoint   app/{chatgpt-dil,wondering-genui,vendor/katex}/…  read-only module mounts
server/app.js             core (createWonderCore), node:http test server    server/web.js   Fetch-API adapter, static mounts, env
server/paths.js           app root on disk (also inside a Next bundle)
server/claude.js          Claude params/stream/errors server/prompts.js     system prompts + JSON schemas
server/compile.js         compiler extension         server/lenient-json.js JSON5-ish prop parser
server/catalog-schema.js  prop validators/fallbacks  server/ndjson.js       conversation-source writer
server/demo.js, demo/*.md demo mode                  server/practice.js     practice extraction
server/widget-actions.js  /api/widget_action
server/teacher.js         Teacher tools, validation, loop, card store + actions
server/teacher-demo.js    scripted demo "model"      server/memory.js       learner memory store
server/memory-extract.js  post-lesson memory extraction
public/app.js (routing, course, lesson, tutor, finish), shell.js (sidebar, tabs, ⌘K palette), today.js, library.js, you.js, onboarding.js
public/progress-core.js (goal, streak week, heatmap, Up next), ui.js, review.js, store.js, deck.js, practice-core.js, math.js (KaTeX)
server/math-spans.js      math spans hoisted before the stock compiler
public/teacher-screen.js, teacher-core.js (progress snapshot, history), memory-screen.js
public/learning-catalog.js (in-sandbox components), learning-runtime.js, wonder-worker.js, dil-surface.js, stream-client.js
public/view-state.js      widget state snapshots (store, useSaved, caps)   public/lesson-menu.js  lesson overflow menu
server/diagram.js         Diagram validation/fallback    server/figures.js   Figure validation, Commons lookup, resolver
server/videos.js          Video validation, YouTube lookup, segment picking, demo clips
server/media-resolver.js  per-stream Video lookups (componentResults); combines them with Figure's
public/catalog-media.js   Diagram + Figure + Video (in-sandbox components)
public/figure-hosts.js, video-hosts.js   what the renderer may load / embed
public/welcome/           landing page (static; served at /welcome)   app/landing-script.js   who lands there
test/*.test.js, test/index.js, test/helpers.js
```

## Widget state persistence

Interactive widgets keep their state across reloads and when a lesson is reopened, like ChatGPT's `DIL.useState(initial, {key, widgetId})` + `DILStatePersistence` (chatgpt-findings §3.1–3.2). chatgpt-dil's runtime ignores those options and has no snapshot API, so the store lives in Mull's runtime wrapper (`public/learning-runtime.js`, `public/view-state.js`) and chatgpt-dil is unchanged.

| Widget | Saved | Not saved |
|---|---|---|
| `FunctionGraph` | parameter values | |
| `Diagram` | current step, selected part | |
| `Figure` | "Look closer" answer shown | enlarged view |
| `Video` | prediction, answers, clip watched | playback position |
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
- **Accounts are optional.** Without Neon Auth and a database, courses, lessons, the deck and activity live in this browser's localStorage, and the app falls back to in-memory storage when localStorage is blocked. With them, see [Accounts, sync, daily limits and plans](#accounts-sync-daily-limits-and-plans).
- **Multi-tab is safe.**
  - The cross-tab lock keeps two tabs from streaming the same lesson.
  - `store.js` writes with a three-way merge per lesson, thread, course and plan, and idle tabs pick up other tabs' saves. So one tab no longer wipes another tab's changes.
  - Without Web Locks, the lease fallback is still exclusive. Acquiring broadcasts a claim, writes the lease, waits a 120 ms settle window and re-checks, and the lowest claim ticket wins ties. `test/lock-race.test.js` races two tabs 100 times; exactly one wins every time.
- **Teacher history is text.** Earlier turns go back to Claude as markdown with `[Card: …]` notes, not as the original tool_use/tool_result blocks. Card state on the server is in memory, but cards carry their state, so they survive restarts.
- **Without accounts, memory is one file for one local learner.** It is not encrypted; "Forget everything" deletes it. With accounts, each user's memory and material live in their own rows of the database.
- **Inherited from chatgpt-dil:** a best-effort sandbox lockdown and no SVG `<text>` in the captured client. Flowchart and ConceptMap are therefore laid out with boxes rather than drawn edges. Mull's host adds an `svg-text` primitive for `Diagram` labels.
- **Figure needs the network and Wikimedia.** The server queries Wikimedia Commons, and the learner's browser loads the image from `upload.wikimedia.org` / `thumb.wikimedia.org` (no referrer). Offline, or with `WONDER_FIGURES=off`, Figures are left out and the lesson reads without them. Claude never sees the picture when it writes, so captions are written to be true of any good image of the subject; the vision check then drops an image that does not fit.
- **Video needs a YouTube key, the network and YouTube.** Without `YOUTUBE_API_KEY`, Claude-mode lessons leave Videos out; demo mode plays only the demo lesson's fixture clip. Each new lookup costs 101 of the key's 10,000 free daily quota units (about 100 new clips a day; repeats are cached). Segments come from a video's chapters, not its captions (the Data API lets only a video's owner download captions), so a video without matching chapters plays from its start, capped at 3 minutes. Pausing at the clip's end uses the player's `postMessage` events (the protocol YouTube's IFrame API uses, not separately documented); if they never arrive, "I watched it" opens the questions. Saved lessons keep the clip's title and channel; YouTube's API policies limit how long such data may be stored, which a production deployment would need to handle.

## Credentials

Next.js reads `ANTHROPIC_API_KEY` from `genui-lab/wonder/.env` (or `.env.local`). If that isn't set, it falls back to `~/.config/wonder/.env`, which lives outside the repo. `YOUTUBE_API_KEY` (a YouTube Data API v3 key, for `<Video/>`) is read from the same places; values already in the environment win. The key goes to `www.googleapis.com` in the `X-Goog-Api-Key` header, never in a URL or a log line. Set `ANTHROPIC_WORKSPACE_ID` as well when your key is not scoped to a workspace (for example `sk-ant-usr-…` keys). Mull then sends it as the `anthropic-workspace-id` header.

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
  - **`Cite`** is an inline numbered pill. Pressing it opens a popover card with the number, domain, title and snippet, plus "Open source" (an `open_url` client action). It overrides chatgpt-dil's stock `Cite` pill for Mull programs only: the stock one is a parameter of the program Function, so the prelude reassigns it, and chatgpt-dil is unchanged.
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

Before this, steering needed the original NDJSON connection: after a reload there was nothing to steer, and an interrupted lesson stayed partial. Now `POST /api/lesson/stream` takes an optional `continueFrom` (ChatGPT has `/conversation/resume` and resume tokens, §1.4; Mull rebuilds the turn from the client's persisted lesson instead, so the server keeps no state):

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

## Phase 9: did each lesson work?

A lesson's quiz says what the learner knew a minute after reading it. Mull also measures what they still know days later, from the review deck it already keeps. Everything is in `public/outcomes-core.js`, which is pure and shared with the server.

- **Delayed recall.** Each review of a lesson's card that comes at least a day after the previous one is a recall test. Hard counts as recalled. Results are grouped into 1–3, 4–13 and 14+ day gaps.
  - A result is shown only at *n* ≥ 3.
  - Until then, the FSRS estimate of memory today stands in.
  - Cards missed on two delayed reviews are *leeches*.
- **Teaching-style experiment.** New lessons rotate between `standard`, `example-first` and `predict-first`.
  - The style is one line in the lesson **user** turn, so the cached system prompt never changes.
  - Assignment is balanced: the style with the least data goes next.
  - Once every style has ≥ 3 measured lessons and ≥ 5 delayed reviews, the best one is used 2/3 of the time.
  - It can be turned off on You.
- **"What works for you."** Recall by style and by visual, with sample sizes.
  - A finding needs ≥ 2 lessons and ≥ 8 delayed reviews on each side, and a 10-point gap.
  - Findings go into the lesson request as `learnerInsights`. The server bounds them and places them after the cache breakpoint, and leaves them out when memory is off.
- **Where outcomes show up.**
  - "How well it stuck" at the end of a finished lesson.
  - A "Refresh" row in Today's Up next for the worst-fading lesson, after Phase 6's "Strengthen".
  - "92% recall" in reading rows (Today's Recent, the Library).
  - "What works for you" (`public/insights-panel.js`, no longer shown on You), with the same layout as Phase 6's "What you know". Its "Fading lessons" group has **Refresh** (`#/review/lesson/<id>`: that lesson's cards, weakest first) and **Relearn** (the same topic in the best-measured other style).
  - The Teacher's `get_progress`, which includes per-lesson recall, fading lessons with their slipping cards, and findings.

## Phase 10: a proactive Teacher, and lessons from your own material

- **Dated plans.**
  - `plan_study` takes a `deadline` (`YYYY-MM-DD` or `""`) and dates every day from the learner's today.
  - A plan that runs past the deadline goes back to Claude as an error that says how many days fit.
  - `public/plan-core.js` works out today's item, overdue items, pace (ahead, on track, behind) and the countdown. Today and "Up next" follow the calendar.
- **Daily brief.**
  - `public/brief-core.js` ranks overdue plan work, due cards, today's plan item and the worst-fading lesson. It reads local state only, with no model call.
  - Its headline shows under Today's greeting when a deadline or the streak is at stake, and it is the text of the daily reminder. The same ranking feeds Up next.
  - Today's study-plan panel marks today's items and late ones, and shows pace, the countdown and "Add to calendar".
- **The Teacher speaks first.** A check-in turn (`opener: true`) has the Teacher read progress and propose the best next step as a card. The server substitutes its own fixed `TEACHER_OPENER` text. It runs from "Ask your Teacher" on Up next, and once a day on opening the Teacher (a setting on You).
- **Reminders.**
  - A daily notification at a chosen time while a Mull tab is open, if the goal isn't met.
  - "Add to calendar" exports the plan as `.ics` (`public/ics.js`, RFC 5545 escaping and folding) with an alarm per study day and the deadline, so reminders work with Mull closed.
- **Your own material.**
  - In Today's command bar, choose "Material": paste notes or attach .txt/.md/.pdf, then Begin (a lesson) or Make a course. `server/materials.js` stores it (You no longer lists it).
  - Both servers accept it: `bodyLimit()` raises the request limit for `/api/materials` in the node:http harness and the Next.js Fetch adapter, and a `t.send()` transport method serves the original file.
  - Claude gets it as a cached `document` block with citations on.
  - `char_location` and `page_location` citations are mapped onto the same source registry as web results. They become Cite pills and Sources ("Your material", "…, p. 4") that open the original.
  - Material lessons don't search the web unless asked to.
  - In demo mode, text material becomes an outline lesson and a course by its headings.

## Phase 9-10 tests and live verification

- **Tests.** `test/outcomes.test.js`, `test/proactive.test.js` and `test/materials.test.js` cover:
  - recall buckets, thresholds, leeches and forecast memory, built from real FSRS review sequences;
  - balanced assignment and exploitation of teaching styles;
  - the variant line and insights placement in the request;
  - plan date math, pace and backward-planning bounds, plus the tool's error feedback;
  - brief ranking and reminder timing;
  - ICS output;
  - Teacher check-ins, with a fake client and in demo;
  - the materials store (limits, path-safe ids, persistence);
  - document blocks, and citation mapping through a fake client that streams `citations_delta`;
  - course plans from material, and the demo outline.
- **Live.**
  - **Teacher check-in.** On seeded review history it proposed relearning the worst-recalled lesson "starting from concrete examples", the best-measured style.
  - **Lesson from lecture notes.** It used the class's own coffee-shop example and carried 11 Cite pills. "Sources" opened the original notes.

## Diagrams, real images and video clips

Three catalog components put pictures or video next to the explanation.

### `Diagram`: drawings Claude composes

```
<Diagram title="…" width={400} height={240}
  shapes={[{"id":"sun","type":"circle","x":60,"y":60,"r":26,"fill":"yellow","part":"sun"},
           {"type":"text","x":60,"y":104,"text":"Sun"},
           {"id":"ray","type":"arrow","from":[92,70],"to":[230,150],"stroke":"orange","curve":-10,"part":"light"}]}
  parts={[{"id":"sun","label":"The Sun","text":"…"},{"id":"light","label":"Sunlight","text":"…"}]}
  steps={[{"label":"…","text":"…","show":["sun"],"highlight":["sun"]},{"label":"…","show":["ray"],"highlight":["ray"]}]}
  caption="…"/>
```

- **Validation** (`server/diagram.js`, registered in `catalog-schema.js`):
  - **Canvas.** 100-1000 × 60-1000 units, between 1:2 and 4:1 (default 400×250).
  - **Shapes.** 1-40 of `rect`, `circle`, `ellipse`, `line`, `arrow` (optional `curve`, `both`), `polyline`, `polygon`, `path` (SVG path commands only) and `text` (≤ 60 chars). Aliases such as `box`, `dot` and `label` are accepted. Every shape must lie inside the canvas.
  - **Colors.** Named colors map to theme tokens or mid-tone hexes that read in light and dark (`brand`, `blue`, `sky`, … `ink`, `muted`, `surface`). `white` and `black` stay literal, so white things are not drawn dark in dark mode. `#hex` passes through, and anything else falls back to the default.
  - **Parts.** At most 8 parts. Each needs an id, a label and text, and must match at least one shape (by `part` or `id`). A free `text` label whose anchor sits inside a rect, circle or ellipse with an id or part joins the smallest one. It takes that shape's `part` and `follows` its id, so the label appears, dims and taps with its shape, even when a step stages the shape by id.
  - **Steps.** Between 2 and 8 steps. Every name in `show` and `highlight` must match a shape id or a part.
  - **Fallback.** Invalid props become markdown: the parts as a list and the steps in order.
- **Sandbox component** (`public/catalog-media.js`):
  - **Drawing.** Shapes are drawn with DIL svg primitives. Arrowheads are polygons computed in the sandbox.
  - **Labels.** Labels use the `svg-text` host extension, with a halo so they stay readable over lines. On phones, labels grow so 12-15 unit text stays legible.
  - **Parts.** Tapping a shape selects its part; thin shapes get a wide invisible hit area. Shapes are pointer-only (aria-hidden, out of the tab order): the canvas is `role=img`, and the part chips are the keyboard and screen-reader controls. The host still supports keyboard-button shapes for other uses.
  - **Steps.** A shape listed in some step's `show` stays hidden until that step. The step's `highlight` dims everything else to 22%, and the CSS fades opacity changes.
- **Demo.** The sky-blue sample's sunset page compares the noon and sunset light paths through the atmosphere in three steps, with four tappable parts.

### `Figure`: real images from Wikimedia Commons

```
<Figure query="cumulus clouds blue sky" file="File:…" caption="…" alt="…" question="…" answer="…"/>
```

- **No URLs from the model.** Claude writes a 2-6 word `query`, and an exact Commons `file` title only when it is sure of one. URLs in `query` are rejected.
- **Server lookup** (`server/figures.js`):
  - **Query.** The file title is tried first, then a Commons search (`filetype:bitmap|drawing`, 8 results).
  - **Filtering.** Results must be a raster or SVG image, freely licensed (not `NonFree`), at least 320 px wide and not an extreme panorama. They must be served from `upload.wikimedia.org` or `thumb.wikimedia.org`. Language-neutral files win over localized SVG copies such as `…-ru.svg`.
  - **Output.** A 960 px thumbnail with the `utm_*` parameters stripped, the size, the license and the author as plain text.
- **Delivery.** Results are server-resolved `componentResults[__resolutionId]`, like Cite. Every DIL stream has a resolver (`startNdjson`): lessons, tutor replies and the Teacher.
  - **Pending.** Each compiled revision reports `pending` and starts the lookup once.
  - **Mid-stream.** When the lookup lands mid-stream, the writer re-sends the program (`writer.refresh()`: an empty append with a fresh `dil`).
  - **End of stream.** Before the final record the stream waits up to 6 s ("Finding images…"). Anything still pending, failed or not found becomes `{found:false}`, and the component renders nothing.
  - **Caching.** Results are cached per server (300 entries). Failures are not cached, so the next stream retries, and a "nothing found" expires after 10 minutes. Lookups use the stream's abort signal, so leaving a lesson cancels them.
  - **Persistence.** The final `dil` carries the image state, so the saved lesson shows it after a reload without another lookup.
- **Renderer.** `dil-surface.js` gives the host an image policy: a remote image loads only when the server resolved that exact URL for a Figure on this surface (`public/figure-hosts.js`, shared with the server). Any other remote `src` keeps the host's placeholder. That includes a Wikimedia URL the model wrote into a raw `<image>`, which would otherwise show without its credit. So model output cannot embed tracking pixels. The host treats protocol-relative (`//host`) and look-alike origins as remote (`isRemoteSrc`).
- **Sandbox component.**
  - **Loading.** A "Finding an image…" frame shows while the lookup runs.
  - **Image.** A tall image is letterboxed to 1.25:1 until tapped.
  - **Text.** Caption, an optional "Look closer" question whose answer is revealed and saved, and `Image: author · license · Wikimedia Commons` with a Source button that opens the file page.
- **Vision check.** Claude wrote the caption without seeing the image, so after a lookup finds one, a small structured call (`createFigureCheck`) asks Claude whether it fits.
  - **Request.** The thumbnail goes as an image block by URL, followed by the search phrase, the Commons title, the caption, the alt text, and the question and answer. The schema is `{depicts, fits, problem}`, effort `low`, no tools.
  - **Verdict.** A rejected image makes way for the next-best Commons result: the lookup runs again with `exclude` (the rejected srcs), and the check runs on the new image. Up to 3 images are tried (`FIGURE_CHECK_TRIES`). A kept image gets `checked: true`, plus `choice: n` when it was not the first result. When none fits, the Figure becomes `{found: false, rejected: {title, depicts, problem}, tried}`, which renders nothing, as when no image is found. The server logs each rejection.
  - **Caching.** The verdict is cached with the lookup: with the check on, the cache key also includes the caption, alt, question and answer. A rejection expires like a miss, after 10 minutes.
  - **Failures fail open.** An API error, refusal or timeout (15 s) shows the image unchecked, for that stream only. It is not cached, so the next stream checks again.
  - **Download fallback.** The API fetches the URL itself, and Wikimedia sometimes refuses its fetcher with HTTP 400 "Unable to download the file". In a first live run 16 of 26 checks failed that way, even for images that downloaded fine from here. On that error only, the server fetches the same thumbnail once and sends it as a base64 block: allow-listed Wikimedia hosts only, our User-Agent, JPEG, PNG, GIF or WebP, at most 4 MB.
  - **Settle budget.** The check (and any retries) runs inside the figure's pending lookup, so `settle(figureSettleMs)` bounds it like the lookup itself. A check still running when the stream ends leaves that Figure out of this stream, and its verdict is cached for the next one. Lookups start as soon as a Figure tag compiles, and the critic runs before the settle, so checks usually finish mid-lesson.
  - **Model.** `claude-haiku-5-5`, measured against `claude-opus-5-5`. Six real Commons images were each paired with their own caption, a caption from another topic, and subtle near-misses: a cumulus photo captioned as an anvil thunderstorm, a plate map captioned with "red earthquake dots", a seafloor map captioned as black smokers. That made 19 cases, run twice each.
    - Haiku: 36/38 right, median 1.6 s, max 2.8 s. Both misses were the same strict call: it rejected a convex-lens ray diagram captioned "meeting at the focal point" because the drawing labels that point a circle of confusion.
    - Opus: 38/38, median 2.7 s, max 5.1 s, at about 40× Haiku's per-token price.
    - Haiku's failure mode is dropping an image, not showing a wrong one, so it is the default. `WONDER_FIGURE_CHECK_MODEL` (or `figureCheckModel`) overrides it.
  - **Switches.** On by default in claude mode. Off in demo mode (no client) and in the tests (`test/index.js` sets `WONDER_FIGURE_CHECK=off`). `WONDER_FIGURE_CHECK=off` or `figureCheck: false` turns it off; `figureCheck: fn` replaces it (tests).
- **Settings.** `WONDER_FIGURES=off`, or `figureLookup: null` in `createWonderCore`, skips the network. The tests stub the lookup. `figureSettleMs` changes the end-of-stream wait.
- **Demo.** The sky-blue sample shows a photo of white clouds in a blue sky on its Mie-scattering page.

### `Video`: short YouTube clips with pause-and-answer questions

```
<Video query="sunset in a glass milk water flashlight experiment" shows="a flashlight beam through milky water turning orange"
  caption="…" questions={[{"when":"before",…Quiz question…},{"when":"after",…}]}/>
```

- **No ids or URLs from the model.** Claude writes a `query` (3-8 words that would find a good video) and `shows` (what the clip must show). A `videoId`, `url`, `src` or a URL in `query` is rejected, so the component falls back to its caption.
- **Questions** use the Quiz question format (single choice or true/false, with an explanation). At most one `"when":"before"` question asks the learner to predict the outcome before the player appears. Up to two `"after"` questions open when the clip ends. They are about what any good clip on the point shows, since Claude never sees the video.
- **Server lookup** (`server/videos.js`, YouTube Data API v3):
  - **Search.** `search.list` with `type=video`, `videoEmbeddable`, `videoSyndicated` (playable outside youtube.com), `safeSearch=strict` and `relevanceLanguage=en`, 10 results. Then `videos.list` for their duration, embeddability, privacy, age and region restrictions, captions and descriptions.
  - **Filtering.** Public, embeddable, processed, not live, not age- or region-restricted, not a `#shorts`, 30 s to 20 min long.
  - **Segment.** If the description has chapters by YouTube's rules (an ascending run of timestamped lines from 0:00, at least three, each at least 10 s), the chapter whose title best matches `shows` plays, capped at 4 minutes. Intro, outro and sponsor chapters never match. Otherwise a video up to 4 minutes plays whole and a longer one plays its first 3 minutes.
  - **Ranking.** Search rank, plus a matching chapter, a whole short video, captions, English audio and title words matching `shows`. A long video that would only play its start ranks lower.
  - **Output.** `{found, videoId, start, end, duration, title, channel, chapter?, pageUrl}`, with the title and channel as plain text.
- **Delivery.** A per-stream resolver like Figure's (`server/media-resolver.js`), combined with it in `startNdjson` so every stream has both: pending, re-sent mid-stream, settled before the final record ("Finding a video…", or "Finding images and videos…"), cached per server with misses expiring, cancelled with the stream, and saved with the lesson.
- **Renderer.** The host's `youtube` primitive: `youtube` with a `videoId` prop is in ChatGPT's DIL element list (findings §3.3). The chatgpt-dil host renders it as an iframe whose URL the host builds itself from a validated 11-character id, always on `https://www.youtube-nocookie.com/embed/…`. The frame has `sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"`, no top navigation or forms, and a `strict-origin-when-cross-origin` referrer (the player will not start without one). A frame exists only when the embedder's `allowEmbeds` policy allows that id. In Mull, `dil-surface.js` allows only ids the server resolved for a Video on this surface (`public/video-hosts.js`). Anything else, including a raw `<youtube videoId>` the model wrote, keeps a placeholder. The host also no longer re-inserts an element that is already in place, which would reload a playing frame.
- **Pause and answer.** The host asks the player to report its state (`enablejsapi=1`, the IFrame API's `listening` handshake). It accepts messages only from `https://www.youtube-nocookie.com` and only from that frame's window. When playback reaches a cue (the clip's end, 0.35 s early, before YouTube's end screen), the host pauses the player and calls the component's `onCue` in the sandbox. The worker gets no per-tick time updates.
- **Sandbox component** (`public/catalog-media.js`): a "Finding a video…" frame while pending; the "Predict first" card (or Skip) before the player; the caption; `Video: title · channel · YouTube · chapter, 1:05–3:10` with a YouTube button; then "Your prediction: … Watch to find out" with an "I watched it" button, which also covers the player's events never arriving. When the clip ends: the prediction's verdict and the after questions one by one, each with its explanation, then a score. The prediction, answers and "watched" persist with `useSaved`, so a reloaded lesson does not pause again. Not found renders nothing.
- **Settings.** `YOUTUBE_API_KEY` enables live search. Without it, demo mode uses `createDemoVideoLookup()` (the demo lesson's clip, picked by hand from a YouTube search for the demo query and kept in `DEMO_VIDEOS`), and Claude mode leaves Videos out. `WONDER_VIDEOS=off`, or `videoLookup: null` in `createWonderCore`, turns videos off; the tests stub the lookup. `/api/status` reports `videos`.
- **Demo.** The sky-blue sample's sunset page has a "sunset in a glass" demonstration (a flashlight through milky water), with a "predict the beam's color" question before it and "where did the blue go?" after it.

### Tests and live verification

- **`test/diagram.test.js`:**
  - normalization and rejections;
  - fallback markdown;
  - reveal and highlight opacities across the steps;
  - selecting parts by shape, hit area and chip;
  - larger labels on phones;
  - the demo diagram;
  - every streamed prefix of the demo.
- **`chatgpt-dil/test/host.test.js`:** SVG attributes for the host extensions (sized children, `svg-text`, keyboard vs pointer-only shapes), `isRemoteSrc`, and the youtube player's pure pieces (the embed URL only on youtube-nocookie.com, rejected ids, the sandbox flags, player messages, cues firing once, pausing and re-arming on rewind).
- **`test/figure.test.js`:**
  - validation, and picking Commons results (license, size, host, localized SVGs, HTML authors);
  - the lookup's requests, through a fake `fetch`;
  - the resolver (pending, resolved, cached, failures retried, finalize);
  - the sandbox component (loading, image, enlarge, Look closer, Source, not found);
  - the image policy (only server-resolved Figure URLs load);
  - misses expiring, lookups cancelled with the stream, and a Figure resolving in a Teacher reply;
  - a Figure never counting as a page's only visual, and counting in outcomes only when shown;
  - two lesson streams through the real server: a late lookup arrives mid-stream and is in the final record, and with no network the Figure is left out.
- **`test/video.test.js`:**
  - validation (ids and URLs refused, question limits and formats) and fallback markdown;
  - chapters by YouTube's rules, segment picking, candidate filtering and ranking;
  - the lookup's requests through a fake `fetch` (the key only in a header, never in a URL or an error);
  - the resolver, and Figure + Video combined in one stream;
  - the sandbox component: predict, player, the end cue, answers, Skip and "I watched it", and state restored after a reload;
  - the embed policy (only server-resolved ids get a player);
  - lesson streams through the real server: a late clip in the final record, the demo fixture without a key, and `WONDER_VIDEOS=off`;
  - the demo lesson linting clean, a Video never counting as a page's only visual, and counting in outcomes only when shown.
- **Live (demo mode, browser).**
  - **Diagram.** The sky-blue diagram stepped Noon → Sunset → Compare. Tapping the orange arrow opened "Sunset light", and the step and selection survived a reload. Checked in light and dark, at desktop and 375 px widths.
  - **Claude.** A live lesson on "How the human heart pumps blood" came back with a valid `Diagram` on the first try: four chambers, the septum and the valves as 6 tappable parts, and "Tap each chamber below" in the prose. It surfaced two fixes. Rects need `width`/`height` passed through by the host. Free labels inside a shape now join that shape's part, so tapping a chamber's name selects the chamber and its label doesn't dim. Claude chose no `Figure` for that topic.
  - **Figure.** The live Commons lookup found "Clouds in the sky in August 2014" (Jakec, CC BY-SA 4.0) in about 0.5 s. It rendered with its caption, Look closer and credit, and reloaded from the saved lesson.
  - **Video.** The sky-blue lesson showed "Predict first" with no player. Picking "Orange-red" mounted the sandboxed `youtube-nocookie.com` frame (the sandbox, `allow` and referrer attributes as above) with "Your prediction: Orange-red. Watch to find out, then answer." below it. The player answered the host's `listening` handshake and streamed `infoDelivery` messages with `currentTime` and `playerState`. Actual playback could not be checked: in the automated browser YouTube shows its "Sign in to confirm you're not a bot" wall. The end cue was checked by replaying the player's own `infoDelivery` message from the frame's window: a message from another origin was ignored, 120 s did nothing, and 195.8 s opened "Pause and answer" without reloading the frame. The answers and "watched" came back after a reload (no predict card, no pausing again). No console errors; checked at 375 px in light mode.
- **`test/media-checks.test.js`** (fake client, no network):
  - the vision check's request (an image block by URL, the figure's text, the schema);
  - a matching figure is kept, a mismatched one dropped as not found, and both verdicts are cached;
  - a failed check fails open for that stream only;
  - the inline fallback when the API cannot download the URL;
  - the settle budget, and the check's own timeout;
  - a rejected image making way for the next-best result, up to three, and the Commons lookup's `exclude`;
  - the core switches (claude, demo, env, `figureCheck`);
  - a claude-mode lesson stream whose Figure the check drops;
  - a finished lesson keeping everything after a broken tag (compile, render and the final stream record), while a partial one still cuts there;
  - invalid and unclosed Diagram/Figure tags in the lint;
  - the critic prompt and its diagram/figure text;
  - the eval's per-lesson media, the summary and the report.
- **Live eval, before the follow-ups** (`npm run eval -- --tag media --limit 3`, claude mode, critic and judge on, vision check on Haiku, 2026-10-23):

  | Topic | Diagram | Figure | Image | Lint | Judge |
  | --- | --- | --- | --- | --- | --- |
  | How the heart pumps blood | 1 valid (6 parts, 0 steps) | – | – | 1 | 4.4 |
  | How a camera lens forms an image (intermediate) | 2 valid (3 parts / 3 steps; 4 parts / 4 steps) | – | – | 0.92 | 4.2 |
  | Plate tectonics and earthquakes | 2 valid (4 parts / 0 steps; 2 parts / 4 steps) | 1 valid | dropped by the vision check | 0.92 | 4.2 |

  - **Diagrams.** A Diagram in 3/3 lessons, 5/5 valid on the first try.
  - **Figures.** A Figure in only 1/3 lessons, and no image was shown. The Commons lookup found "San Andreas Fault, Carrizo Plain National Monument" (Ken Lund, CC BY-SA 2.0). The check rejected it: the photo is mostly an airliner wing over mountain ranges, with the fault a faint line near the bottom edge, while the caption promised "a long, straight scar" across the plain. Looking at the thumbnail, that call is defensible.
  - **Critic.** 0 issues on all three lessons. The judge's weakest dimension was quiz quality (3.33). The only failed format check was `key_terms` (6 and 7 distinct KeyTerms), ×2.
  - **Takeaway.** Claude reaches for `Diagram` readily on spatial topics and rarely for `Figure`. The cause was the lesson prompt's Figure rule: it said "prefer a Diagram when the point is how something works", and every spatial topic is exactly that.
- **After the follow-ups** (`npm run eval -- --tag media`, all 5 topics, the same day). Three changes:
  - The Figure rule now says a Diagram and a Figure do different jobs, the mechanism versus the real thing, so a lesson about a physical thing usually has both.
  - It also says a Figure is always in addition to the page's own visual.
  - A rejected image makes way for the next-best result.

  | Run | Diagram in | Figure in | Images shown | Rescued by a retry | Lint | Judge |
  | --- | --- | --- | --- | --- | --- | --- |
  | Before (3 topics) | 3/3 | 1/3 | 0/1 | – | 0.95 | 4.27 |
  | New rule + retries | 5/5 | 4/5 | 3/4 | 2 | 0.94 | 4.4 |
  | + "never the page's only visual" | 5/5 | 5/5 | 5/5 | 2 | 0.92 | 4.32 |

  - **Retries.** "San Andreas Fault Carrizo Plain aerial" first found the airliner-wing photo again; the check rejected it, and the second result, "Aerial-SanAndreas-CarrizoPlain", was kept. "Camera lens cutaway" also kept its second result, a Nikon SLR cutaway.
  - **A justified drop.** In the second run, the heart Figure ("human heart anatomy specimen") was dropped after 3 tries. The candidates were a 19th-century photo of a newborn's heart and lungs, under a caption about an adult heart "the size of a closed fist", and two scans of a cat-anatomy book. The check was right; the query was the weak point.
  - **The page-visual rule.** The second run had one page whose only visual was a Figure (the lint's `visual_per_page` failed). The added rule fixed it in the third run.
  - **Critic.** In these runs it flagged Diagram problems the lint cannot see: "to lungs/to body" arrows leaving the bottom of the ventricles, an earthquake epicenter drawn off to the side of its focus, and a Diagram step's arithmetic (a 44 mm image does not fit a 36 mm sensor "sideways").
  - **Remaining format misses.** Mostly `key_terms`: lessons use 6-7 distinct KeyTerms where the lint wants 2-5.

## Accounts, sync, daily limits and plans

Accounts are off unless **both** Neon Auth and a database are set. Without them Mull runs exactly as before: browser-only, one local learner.

**Settings.** These go in `.env`, `.env.local` or `~/.config/wonder/.env`:
- `NEON_AUTH_BASE_URL`, the Neon Auth URL of the database branch. Adding Neon from the Vercel Marketplace provisions Neon Auth with the database; `vercel env pull` fetches it.
- `NEON_AUTH_COOKIE_SECRET`, 32 or more random characters that sign this app's session cookies (`openssl rand -base64 32`).
- `DATABASE_URL`, the Postgres connection string. Or set `WONDER_SYNC_DB=memory` to try accounts with data that lasts until the server stops.

`next.config.mjs` loads `~/.config/wonder/.env` at startup. Restart the dev server after changing these.

**Sign-in** uses Neon Auth (managed Better Auth): users and sessions live in the Neon database's own auth schema.
- **The flow.** The You page's Sign in starts Google sign-in (`signIn.social`) through Neon's browser client, which `app/wonder-app.js` creates as `globalThis.__wonderAuth`. Google returns the browser with a one-time session verifier. The client's `getSession()` sends it to `/api/auth/get-session`, which exchanges it for the session cookie on this origin.
- **Routes and server checks.** `app/api/auth/[...path]` is Neon's proxy (`auth.handler()`). The server reads the user with `auth.getSession()` (`server/auth.js`). No middleware is needed: signed-out visitors can browse, and only the API enforces sign-in.
- **Google credentials.** Development uses Neon's shared Google credentials. For production, register your own Google OAuth client in Neon Auth (its callback is `{NEON_AUTH_BASE_URL}/callback/google`, on Neon's host, so no custom domain is needed).
- **Trusted domains.** Add each site origin, such as the `….vercel.app` address, to Neon Auth's trusted domains. Localhost is allowed by default.

**Sync.**
- Each signed-in browser keeps a cache in IndexedDB and syncs it through `POST /api/sync`. The server keeps a revision counter per user and merges conflicting edits.
- Memory and material belong to the signed-in user.
- The database tables are created on first use.

**Who may use Claude** (`server/usage.js`). With accounts on:
- **Sign-in required.** Every route that calls Claude needs a signed-in user: lessons, tutor, Teacher, course plans, card and memory extraction, and free-response grading. A signed-out request gets `401 {signedOut: true}`, and the lesson page shows **Sign in to start this lesson** with a Sign in button. A new lesson refused this way is not kept, so it never shows as Failed in Recent. Signing in from that button starts the same topic again on the account; the topic waits in the tab's `sessionStorage` (`wonder.afterSignIn`, up to 30 minutes) across the sign-in reload.
- **Daily caps.** In Claude mode, each user has these caps per UTC day, by plan (see **Plans** below):

| Kind | Free | Pro | Override (Free / Pro) |
|---|---|---|---|
| Lessons (new, steer, resume, revise) | 20 | 100 | `WONDER_LIMIT_LESSON` / `WONDER_PRO_LIMIT_LESSON` |
| Tutor messages | 100 | 500 | `WONDER_LIMIT_TUTOR` / `WONDER_PRO_LIMIT_TUTOR` |
| Teacher messages | 60 | 300 | `WONDER_LIMIT_TEACHER` / `WONDER_PRO_LIMIT_TEACHER` |
| Course plans | 10 | 50 | `WONDER_LIMIT_COURSE` / `WONDER_PRO_LIMIT_COURSE` |
| Card and memory extractions | 60 | 300 | `WONDER_LIMIT_EXTRACT` / `WONDER_PRO_LIMIT_EXTRACT` |
| Graded free-response answers | 150 | 750 | `WONDER_LIMIT_GRADE` / `WONDER_PRO_LIMIT_GRADE` |

  `off` or a negative number removes a cap, and `0` turns that kind off.
- **Counting.** Counts live in the database (`wonder_usage`, one atomic upsert per request), so they hold across serverless instances.
- **Over the cap.** A request over its cap gets `429` with `{limited: {kind, max, plan, resetsAt}}`. The browser does not retry it (a plain 429, Claude being busy, still is) and says when the cap resets.
- **Retries.** A dropped stream's automatic retries (same `streamKey`/`turnId`) are free twice within 10 minutes; reusing a key beyond that is charged.
- **Database errors** fail open and are logged, so a hiccup never locks everyone out.
- **Where caps don't apply.** Demo mode has no caps, since it costs nothing. Without accounts there is neither sign-in nor caps.
- **You page.** The signed-in account card shows the plan, with Upgrade or Manage billing when billing is on; today's use comes back from `GET /api/account` (`usage`) but the app does not show it.

**Plans** (`server/plans.js`). Every signed-in user is on **Free** unless they are on **Pro**. The plan only decides which daily caps apply.
- **Who is Pro.** A user whose plan record (`wonder_plans`, one row per user) says `pro` with status `active`, `trialing` or `past_due`, until 3 days after its period end (so a late renewal never drops a payer to Free). Or a user id listed in `WONDER_PRO_USERS`, which comps Pro without a record.
- **Plan records** are provider-neutral: `{plan, status, provider, customerId, subscriptionId, periodEnd, cancelAtPeriodEnd}`. `createPlans().setPlan()` validates and stores one.
- **Failing safe.** A plan lookup that fails is logged and counts as Free.

**Buying Pro** (`server/billing.js`). Pro is sold through [Polar](https://polar.sh), a merchant of record: Polar runs the checkout, charges sales tax and VAT, and pays the seller out (it pays out to many countries Stripe does not, Kazakhstan among them). Off unless all three of `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` and `POLAR_PRODUCT_ID` are set; then `/api/account` sends `billing: {provider, sandbox, price, canUpgrade, canManage}` and the You page shows **Upgrade** or **Manage billing**.
- **Pro products.** `POLAR_PRODUCT_ID` is the Pro product checkout sells; list more (comma separated) and a subscription to any of them is Pro too, such as a yearly price or a product a user switched to.
- **Checkout.** `POST /api/billing/checkout` makes a Polar checkout for the first Pro product with the user id as Polar's external customer id, and the browser goes there. It refuses (409) when Polar already has a live or paused Pro subscription for the user that the webhook has not recorded yet. Back on `/?checkout_id=…#/you`, the You page waits up to 30 seconds for the webhook to make the account Pro, once per checkout.
- **Manage.** `POST /api/billing/portal` opens Polar's customer portal (card, invoices, cancel) for the stored customer.
- **Webhook.** `POST /api/billing/webhook` checks the Standard Webhooks signature over the raw body (secrets made since September 2026 and older ones both work). An event only says which user to look at: their Pro subscriptions are listed from Polar as they are now and the best one becomes the plan record (a live one, latest period end first). So late, repeated or out-of-order events cannot leave a stale state, and a user with two subscriptions stays Pro while either lives. Each record is stamped with when Polar was read, and an older read never overwrites a newer one. Events naming no user are ignored. A Polar error that retrying cannot fix (4xx other than 429) is logged and answered 202, because Polar disables an endpoint after 10 failed deliveries in a row; anything else answers 500 so Polar redelivers.
- **Cancelling.** Cancel at period end keeps Pro until then (`endsAt`); once no Pro subscription is live the account is Free.
- **Deleting an account** first revokes every Pro subscription Polar has for the user that is not over (paused, unpaid and not-yet-recorded ones too), then deletes and anonymizes the Polar customer. If Polar cannot be reached, nothing is deleted and the user is told to try again, so a deleted account is never charged again.
- **The price** on the Upgrade button comes from the Pro product, cached for an hour. A cold cache waits at most 1.5 seconds; after that the button reads "Upgrade to Pro" and the price shows next time.
- **Sandbox first.** `POLAR_SERVER` is `sandbox` unless set to `production`. Sandbox has its own dashboard (sandbox.polar.sh), tokens and test card (4242 4242 4242 4242).
- **Setup.**
  1. Create an organization on [sandbox.polar.sh](https://sandbox.polar.sh) (later the same on polar.sh, with payouts set up under Finance).
  2. Add a product **Pro** with a monthly price. Copy its id into `POLAR_PRODUCT_ID`.
  3. Settings → Developers: create an organization access token with `checkouts:write`, `customer_sessions:write`, `customers:write`, `products:read`, `subscriptions:read` and `subscriptions:write` scopes, into `POLAR_ACCESS_TOKEN`.
  4. Settings → Webhooks: add an endpoint `https://<your domain>/api/billing/webhook`, format **Raw**, with the `subscription.*` events. Copy its secret into `POLAR_WEBHOOK_SECRET`.
  5. Leave Settings → Subscriptions → **Allow multiple subscriptions** off (the default), so Polar itself stops a second purchase.
  6. Set the same variables on Vercel (`vercel env add`) and redeploy.

**Tests.**
- `test/usage.test.js`: caps per user, kind and day; free retries and their bounds; failing open; 401 and 429 over HTTP; demo mode and accounts off; non-retryable errors in the browser.
- `test/plans.test.js`: who is Pro (status, period and grace, comped users), record validation, Pro caps and their overrides, and Pro vs Free over HTTP with the plan on `/api/account`.
- `test/billing.test.js`: webhook signatures (both key kinds, replay window), subscription to plan record, picking the deciding subscription, older reads dropped, and against a fake Polar API: checkout and its second-subscription guard, webhook to Pro, portal, cancel, two subscriptions, product switches, ignored events, which errors are retried, account deletion ending every subscription and the customer (and its failure paths), and a slow price lookup.
- `test/sync-pg.test.js` (with `WONDER_TEST_DATABASE_URL`): plan records round-trip in Postgres, an older read is dropped, and the plan goes with the account.
- `test/landing.test.js`: who the home page sends to `/welcome`, with account sync on and off, and the signed-out deep link kept for after sign-in.
- `test/start.test.js`: where `#/start[/<topic>]` goes (sign-in, onboarding, the lesson, home).
- `test/sync*.test.js`: sync, authorization and statement scoping.
- **Live checks.** Sign-in with Google, sync of a generated lesson to Neon, and the Postgres cap under 4 concurrent requests (exactly the cap got through).


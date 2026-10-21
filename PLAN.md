# Plan: combining wondering.app and ChatGPT's intelligent UI

## Goal

One product with two halves:

- **Wondering's learning loop**: courses, paged lessons, a tutor, a Teacher agent, memory, practice, FSRS, streaks.
- **ChatGPT's generative-UI engine**: the model writes UI inline as DIL markup, the server compiles and resolves data, and the client renders it in a sandboxed worker.

The two halves split the work like this:

- **Wondering decides *what* to teach.** That covers pedagogy, course structure, learner state and review scheduling.
- **ChatGPT decides *how* it is shown.** That covers the UI language, streaming protocol, server-resolved widgets, actions and steering.

Every surface in the app follows the same path: Claude (`claude-opus-5-5`) → DIL → sandboxed render. Those surfaces are the lesson, the tutor, the Teacher and the review.

## Where we are (phase 0, done)

Built and verified on the live API ([genui-lab/wonder/README.md](genui-lab/wonder/README.md)):

| Layer | From ChatGPT | From Wondering | Status |
|---|---|---|---|
| UI language | Inline DIL tags, server recompiles each revision | 14 learning widgets as DIL catalog components | ✅ |
| Transport | conversation-source NDJSON v2, reasoning records, follow-ups | — | ✅ |
| Rendering | Worker sandbox, binary op buffer, host primitives | Wondering look and feel | ✅ |
| Widget actions | `widget_server_action`, `issue_new_turn` | Quiz grading, "Explain this" | ✅ |
| Lesson loop | — | Topic → lesson → tutor → knowledge cards → FSRS review, XP, streak | ✅ |
| Courses | — | Course plan → lesson path | ✅ |

## Gap analysis

What each product does that Wonder doesn't yet, ranked by how much each item would strengthen the combination:

| # | Capability | Source | Why it matters for the combination |
|---|---|---|---|
| 1 | **Agentic Teacher with tool cards.** Plans, lesson creation, quizzes, approvals, undo (wondering §2.3). | Wondering | It's Wondering's newest surface. Its tool results are UI cards, which map 1:1 onto ChatGPT's server-resolved DIL components (`componentResults`, §3.4) and widget actions. |
| 2 | **Learner memory.** Extracting facts and goals, injecting them into prompts, letting the user view and forget them (wondering §5; ChatGPT memory cites). | Both | Personalizes every lesson, tutor reply and Teacher plan. |
| 3 | **Grounded sources and citations.** Wondering has web search and `[[SOURCE]]` citations; ChatGPT has `<Cite>` pills and source sheets (§2, §8). | Both | Lessons become verifiable. Search results arrive as server-resolved `Cite`/`Sources` data. |
| 4 | **Mid-turn steering.** "Simpler please" while a lesson is still streaming (ChatGPT `steer_turn`, §1.5). | ChatGPT | Learners redirect a lesson in progress instead of waiting for it to finish. |
| 5 | **Interactive function graphs.** ChatGPT's Skybridge math blocks: draggable points, sliders, graphable functions (§3.7). | ChatGPT | Math and science lessons become explorable. |
| 6 | **Voice tutor with a whiteboard.** 12 board tools such as `show_visual` and `save_note` (wondering §3). | Wondering | The same DIL board renders on a voice surface. Needs a realtime audio provider, so deferred. |
| 7 | **Visual practice types.** number_line, chart_select, and others (wondering §1.6). | Wondering | Richer review; can be built from DIL primitives. |
| 8 | **Persistence and accounts.** Supabase in Wondering. | Wondering | Out of scope for a local lab. localStorage plus server JSON is enough. |

## Phases

### Phase 1: Teacher agent with DIL tool cards ✅

- **Server: `POST /api/teacher/stream`.** Claude runs a manual tool-use loop with these client tools, all `strict: true` with `additionalProperties: false`:
  - `create_lesson {topic, level, reason}`: proposes a lesson. Rendered as an **approval card**; on accept the client starts the lesson.
  - `plan_study {goal, days[]}`: a 3–7 day plan. Rendered as a **plan card** with per-day items and open buttons.
  - `quiz_me {topic, questions[]}`: a `Quiz` built from the learner's deck and memory.
  - `remember {fact, kind}` and `forget {id}`: learner memory writes, shown as a small memory chip with **undo**.
  - `get_progress {}`: reads deck stats, due cards, streak, recent lessons and courses. The client sends a snapshot with each request.
- **Execution.** Tools run server-side, and each result becomes a **resolved catalog component**, as ChatGPT does it: the model's tool call → `componentResults[resolutionId]` → a `<TeacherCard kind=… __resolutionId=…/>` spliced into the streamed DIL. The model's own text between tool calls streams as markdown + DIL.
- **Human in the loop.** Approval and plan cards dispatch widget actions (`teacher_accept`, `teacher_dismiss`, `teacher_undo`) to `/api/widget_action`. The new state comes back through `componentResults`.
- **Client: a Teacher screen (`#/teacher`).** A thread list plus a chat with streamed DIL replies, cards and follow-up chips. Threads persist in localStorage.
- **Tool status.** While a tool runs, it shows as a `reasoning` record ("Checking your progress…"), like Wondering's `tool_start` and ChatGPT's activity rows.

### Phase 2: Learner memory across every surface ✅

- **Store.** `server/memory.js` keeps a JSON file (`data/memory.json`, git-ignored) of `{id, fact, kind: goal|preference|struggle|background, source, createdAt}`.
- **Writes** come from three places: the Teacher's `remember`; post-lesson extraction (a structured call on the lesson, the quiz results and the tutor thread); and the user.
- **Reads.** A compact "About this learner" block goes into the lesson, tutor and Teacher prompts, placed after the cache breakpoint.
- **UI.** A Memory screen to view and delete items, a "Forget everything" button, and a per-request "Don't use memory" toggle (Wondering's `noMemory`).

### Phase 3: Grounded lessons with sources ✅

- **Search.** Lesson and tutor requests can enable Claude's `web_search_20260209` server tool (toggle, default on for lessons).
- **Citation mapping.** Text-block `citations` (`web_search_result_location`) are turned into `<Cite refs={[...]}/>` after the cited sentence. The source data (url, title, cited_text) goes into `componentResults` as ChatGPT does it (`turnNsearchM` ids).
- **Rendering.** `Cite` and `Sources` catalog components: an inline pill and an end-of-lesson source list. `pause_turn` is handled by continuing the request.

### Phase 4: Mid-turn steering ✅

- **Composer.** While a lesson streams, a "Steer" input appears ("simpler", "more examples", "focus on X").
- **Server.** A `POST /api/lesson/steer {operationId, instruction}` aborts the in-flight stream, then continues. The continuation is a new request: the original prompt, plus the partial lesson as context in a user turn (no prefill), plus the instruction.
- **Stream.** A `control steering-status accepted` record is emitted (ChatGPT §1.5), and the lesson resumes from the last complete page. The client keeps the earlier pages and replaces the partial tail.

### Phase 5: Interactive function graphs ✅

- **Component.** A `<FunctionGraph fn="a*sin(b*x)" params={[{name:"a",min:0,max:3,value:1}]} xRange={[-6,6]}/>` catalog component.
  - A safe expression parser handles numbers, x, params, + − × ÷ ^ and sin/cos/tan/exp/log/sqrt/abs, and never calls `eval`.
  - It renders through the DIL `svg`/`path` primitives, with pressable sliders.
- **Teaching.** The prompt teaches it for math and physics lessons.
- **Validation.** Server-side, using the same parser.

## Beyond an AI wrapper (phases 6–7)

Phases 1–5 make generation better, but a frontier chat app can also write an interactive lesson on request. What it can't do is check, days later, whether the learner remembered it. It also doesn't act between conversations, and it doesn't know the learner's own course material. Phases 6 and 7 build on what only Wonder has: the review logs, the deck, the plans and the deadlines.

### Phase 6: Did each lesson work? (lesson outcomes) 

Every lesson gets measured. Recall a few days later counts as the result, not the quiz score at the end. Those measurements then feed back into how the next lesson is written.

- **Outcome model: `public/outcomes-core.js`.** Pure functions with no DOM, tested under `node:test`. They read only the store: `deck.items` with `lessonId`, `deck.logs`, and `lessons[*]`.
  - **Right after the lesson:** the in-lesson quiz score (`quizScore`), as now.
  - **Delayed recall:** for each lesson's cards, the reviews that came at least 1 day after the previous review of that card (`elapsed_days ≥ 1`, so same-session learning steps don't count). A review counts as recalled at rating ≥ Hard. Results go into delay buckets of 1–3, 4–13 and 14+ days. Each result carries its sample size *n*. It is only shown at *n* ≥ 3 and is labelled `low`, `ok` or `good` by *n*.
  - **Estimated memory today:** the mean FSRS retrievability `R = forgettingCurve(daysSinceLastReview, stability)` over the lesson's reviewed cards. It's available after a single review, so a lesson has a number before it has delayed reviews.
  - **Leeches:** cards with ≥ 2 lapses (*Again* after leaving New). They point at the exact idea that didn't stick.
  - **Lesson outcome:** `{quiz, recall, buckets, memoryToday, cards, reviewed, leeches, verdict}`. `verdict` is `stuck`, `fading`, `weak` or `unknown`. It is based on recall when *n* is large enough, otherwise on memoryToday.
- **Lesson recipe.** When a lesson finishes, the client records what was in it: `recipe = {variant, components[], pages, level, grounded, steers, tutorQuestions}`. `components` are the catalog tags found in the markdown.
- **Teaching-style experiment.** Each new lesson is assigned a *style variant*. The variant is a one-line instruction appended to the lesson **user** message, which keeps the system prompt cache unchanged:
  - `standard`: no extra instruction.
  - `example-first`: each page opens with a concrete example before the general idea.
  - `predict-first`: each page opens with a question for the learner to predict, answered with a Reveal.
  - **Assignment is balanced, not random.** Whichever arm has the least data goes next, which matters at single-learner sample sizes. Once every arm has ≥ 3 lessons with ≥ 5 delayed reviews, the best-recall arm is used 2/3 of the time and the rest is spent exploring.
  - A setting (`settings.styleExperiment`, on by default) turns it off, in which case every lesson is `standard`.
  - The variant is stored on the lesson. Steered and resumed lessons keep it.
- **Closing the loop.** `whatWorks(data)` summarizes recall by variant and by component. It reports a component only when lessons with it and lessons without it each have ≥ 8 delayed reviews and the gap is ≥ 10 points.
  - The client sends the result as `learnerInsights` with the lesson request. The server bounds it as untrusted input and adds it to the per-request context block after the cache breakpoint. An example: "Lessons with a worked example (LessonStepper) were remembered better: 86% vs 64% over 31 reviews."
  - The Teacher's `get_progress` now includes each lesson's outcome, the weakest lessons, leech prompts and `whatWorks`. With these it can propose a refresher grounded in what actually faded.
- **UI.**
  - **Lesson end panel:** a "How well it stuck" row showing the quiz now, recall after N days with *n*, and memory today. Leeches link to a review.
  - **You → "What works for you":** recall by teaching style and by visual, each with *n* and an honest "not enough data yet" state. Below that, "Fading lessons" with **Refresh** (review those cards now) and **Relearn** (a new lesson on the same topic in a different style).
  - **Library tiles:** a small retention tag such as "92% recall".
- **Tests.** Outcome math with synthetic logs (buckets, thresholds, leeches, retrievability), balanced variant assignment and exploitation, the `whatWorks` thresholds, server bounding of `learnerInsights`, and the variant line in the lesson message.

### Phase 7: A proactive Teacher plus your own material 

The Teacher should act on the learner's behalf, and lessons should come from the learner's own course and not just a typed topic.

- **Dated plans and backward planning.**
  - `plan_study` gains `deadline` (`YYYY-MM-DD` or `""`), and the strict schema keeps every field required. Today's date is already in the progress snapshot.
  - With a deadline, the plan ends on it. The day count is `min(7, days until the deadline)`, and the last day is a review or quiz.
  - Saving a plan stamps `startDate`, which gives every day a calendar date.
  - `public/plan-core.js` works out today's plan day, items overdue from earlier days, and whether the learner is ahead, on track or behind. Today then shows *today's* item and not just the first unopened one.
  - Plan cards and the Today plan show real dates and a "N days to <goal>" countdown.
- **Daily brief: `public/brief-core.js`.** It's computed from local state, so it costs no model call and works in demo mode. It ranks up to 3 actions:
  - cards due now;
  - cards that will drop below 80% retrievability within 2 days, which means review now and not tomorrow;
  - today's plan item and any overdue ones;
  - the weakest lesson from Phase 6;
  - a streak at risk (late in the day and no XP yet);
  - the deadline countdown.

  Today shows it as "Your Teacher's brief" with one button per action.
- **The Teacher speaks first.** Opening an empty Teacher thread sends `POST /api/teacher/stream {opener: true, progress}`.
  - The server sends Claude a fixed, clearly marked user turn: "[Wonder: the learner just opened the Teacher. Check their progress and greet them with the single best next step.]" This is not a prefill. The client doesn't show it as a learner bubble.
  - The Teacher calls `get_progress` and proposes a concrete next step through a card.
  - The demo teacher has an opener script.
- **Reminders.**
  - **In-app:** `settings.reminder = {enabled, time: "HH:MM"}`. While any Wonder tab is open, a minute timer fires a `Notification` once per day at that time if today's goal isn't met. The body is the brief's top action. Permission is only requested from the settings toggle.
  - **Calendar export:** "Add to calendar" downloads an `.ics` file with one event per plan day at the reminder time. Each event lists that day's items and a link back to Wonder, so the reminders work even with the app closed and with no push server. `public/ics.js` is pure and tested.
- **Your own material.**
  - **Store: `server/materials.js`.** Files live in `data/materials/` (git-ignored). There's an index of `{id, title, kind: text|pdf, chars|bytes, createdAt}`.
  - **Endpoints:** `POST /api/materials {title, kind, text | base64}` (max 10 MB PDF, 200k chars of text), `GET /api/materials`, and `DELETE /api/materials?id=`. The client doesn't store the material, only its id.
  - **Lessons from material:** `/api/lesson/stream` and `/api/course/plan` take `materialId`. The material is sent as a `document` content block with `citations: {enabled: true}`. Text uses `source.type: "text"`, a PDF uses `source.type: "base64"`. The block is followed by the request text, with "Teach from this material; stay faithful to it".
  - **Citations to your notes:** document citations (`char_location` / `page_location`) go into the same source registry as web results. They render as `<Cite>` pills titled "<material title>, p. N" and appear in `Sources`, so a lesson cites the learner's own notes.
  - **Courses from material:** given a syllabus or chapter, the course plan follows its structure.
  - **UI:** a "From my material" tab in the Today omnibox (paste text, or pick a .txt/.md/.pdf file), a Materials list on the You screen with delete, and a material chip on lessons built from one.
  - **Demo mode:** the material is stored, and the lesson is a deterministic outline of the material's headings and paragraphs, so the flow works without credentials.
- **Tests.** Plan date math (deadline, behind and ahead, overdue), brief ranking, ICS output (escaping, line folding, `DTSTART`), the materials store (limits, delete, path safety), the document block and citation mapping using a fake client that emits `char_location` and `page_location` citations, and the Teacher opener with a fake client.

### Later (not in this pass)

- Voice tutor with a DIL whiteboard (needs realtime audio).
- Visual practice types.
- Accounts and sync. With them, Phase 6 outcomes could be pooled across learners, which is the real data moat: which explanation of *X* gets the best 7-day recall.
- Web Push reminders when no tab is open (needs a push service).

## Status

Phases 1–5 are implemented, merged into `main` and verified:
- **Tests:** 155 pass with `node --test genui-lab/wonder/test/index.js`.
- **Live check:** one real `claude-opus-5-5` lesson used learner memory (4 items), web search (15 `Cite` pills plus `Sources`) and a mid-stream "Simpler" steer together.
- **Teacher:** verified live on its own, with remember, a study plan and lesson cards.

## Verification for each phase

- **Unit tests.** `node:test` covering compile, catalog, server endpoints, and tool loops with a fake client.
- **Regression.** A recorded real-Claude transcript kept as a fixture.
- **Live check.** One real-Claude run per phase in the browser, at desktop and 390 px, with no console errors.
- **Shipping.** Commit and push after each phase.

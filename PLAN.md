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

### Later (not in this pass)

- Voice tutor with a DIL whiteboard (needs realtime audio).
- Visual practice types.
- Accounts and sync.

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

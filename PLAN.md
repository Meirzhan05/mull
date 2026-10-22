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

### Phase 6: Adaptive learner model

Memory holds free-text facts, but nothing tracks what the learner actually knows. Phase 6 adds a per-concept mastery estimate built from graded evidence.

- **Concept tags.** Quiz questions, Teacher `quiz_me` questions and extracted practice items carry an optional `concept` (a short name such as "Standard deviation"). The prompts ask Claude to tag every question with the idea it tests.
- **Model: `public/mastery-core.js`.** A pure module, stored in localStorage next to the deck.
  - Each graded answer is an evidence event `{concept, at, score 0–1, weight, source: quiz|review|explain}`.
  - A concept's mastery is the mean of a Beta posterior over its events, each decayed with a 21-day half-life. That means old evidence fades and the estimate tracks forgetting.
  - Status is `mastered` (≥ 0.8 with enough evidence), `shaky` (< 0.55 with at least 2 events) or `learning`.
- **Evidence sources:**
  - lesson and Teacher quizzes (`quiz_complete` now carries each question's concept);
  - FSRS reviews;
  - free-response grades (phase 8).
- **Prompts.** The client sends a compact mastery summary with lesson, tutor and Teacher requests. The server re-validates it and places a "What this learner knows" block after the cache breakpoint, next to memory:
  - Lessons recap shaky prerequisites and skip what is mastered.
  - The tutor connects answers to the learner's weak spots.
  - The Teacher sees mastery in `get_progress` and targets shaky concepts with `quiz_me`.
- **UI:**
  - A "What you know" section on the You screen: concepts with mastery bars, grouped by status.
  - A "Strengthen" item in Up next that asks the Teacher to quiz the shakiest concepts.

### Phase 7: Lesson critic and eval harness

Nothing checks generated content today. Phase 7 adds a verification pass and a way to measure prompt changes.

- **Lint (`server/critic.js`, deterministic).** Checks the lesson shape against the prompt's own rules:
  - title and hook;
  - 3–4 pages plus the check page;
  - a visual on every page;
  - one Quiz with 3 tagged questions;
  - 2–5 KeyTerms;
  - page length.
- **Critic (Claude, structured output).** After a Claude lesson finishes streaming, a second call reviews it. It is told to verify:
  - quiz answer keys;
  - factual claims, including against the cited text;
  - level fit and widget sense.

  It returns issues plus machine-applicable quiz fixes (`correct_values`, `explanation`). The server applies the fixes to the Quiz props and sends a `replace` record. A `qualityReport` goes into the turn's metadata, and the lesson menu shows "Checked: N fixes". Demo mode runs lint only. A `verify: false` request flag turns it off.
- **Eval harness (`npm run eval`).** Generates lessons for a topic set through the real HTTP pipeline, then scores each one:
  - lint score;
  - critic issue counts;
  - an LLM judge (structured rubric, 1–5 with a rationale): accuracy, clarity, level fit, interactivity, quiz quality.

  It writes `evals/reports/<timestamp>.{json,md}` with per-topic and mean scores. `--demo` runs without a key (lint and pipeline only) and is covered by tests.

### Phase 8: Free-response answers and a Socratic tutor

All practice today is multiple choice or flashcards graded by code.

- **Host primitive `text-input`.** A Wonder extension to the chatgpt-dil host: a `textarea` with `value`, `placeholder`, `rows`, `maxLength` and `onChange`. The host never overwrites the value while the field has focus.
- **Catalog component `<ExplainBack prompt concept rubric={[…]} sampleAnswer/>`.** The learner explains an idea in their own words and submits, sending `explain_grade` to `/api/widget_action`. The server grades the answer:
  - **Claude mode:** a structured call (effort low) returns a 0–3 score, each rubric criterion with met/missed and evidence, feedback, the misconception, and a follow-up question.
  - **Demo mode:** a keyword grader.

  The result comes back as `componentResults` and renders criteria checks, feedback, "Try again" and "Show a model answer". The grade becomes mastery evidence.
- **Review deck.** A new `explain` practice item type, extracted from lessons and graded through the same grader. The score maps to an FSRS rating.
- **Socratic tutor.** A "Guide me" switch in the tutor sends `mode: "socratic"`. The tutor then:
  - asks one guiding question at a time;
  - gives hints before answers;
  - reveals the answer only after the learner has tried twice or asks outright.

  The rules go in a context block after the cache breakpoint, so the cached system prompt is unchanged.

### Later (not in this pass)

- Voice tutor with a DIL whiteboard (needs realtime audio).
- Visual practice types.
- Accounts and sync.

## Status

Phases 1–5 are implemented, merged into `main` and verified:
- **Tests:** 155 pass with `node --test genui-lab/wonder/test/index.js`.
- **Live check:** one real `claude-opus-5-5` lesson used learner memory (4 items), web search (15 `Cite` pills plus `Sources`) and a mid-stream "Simpler" steer together.
- **Teacher:** verified live on its own, with remember, a study plan and lesson cards.

Phases 6–8 are implemented on the `feature/ai-features` branch, one commit per phase:
- **Tests:** 280 pass on top of the Next.js redesign (26 new for phases 6–8), with no network; `next build` is clean.
- **Browser, demo mode:**
  - quiz answers → "What you know" → Strengthen → a Teacher quiz;
  - the quality note at the end of a lesson;
  - ExplainBack typing, grading, XP and mastery;
  - an `explain` review card;
  - Guide me in the tutor.
- **Live, `claude-opus-5-5`, 2026-10-22:**
  - A 2-lesson eval (vaccines and Bayes) passed lint 12/12 on both, with a judge mean of 4.3/5 and accuracy 5/5. The critic found one real minor timing error (sore arm on days 7–14) and confirmed the Bayes arithmetic. No quiz fixes were needed.
  - The grader scored a partly wrong explanation 2/3 and named the misconception ("clouds absorb violet").
  - The new extraction schema returned tagged items, including an `explain` item.

## Verification for each phase

- **Unit tests.** `node:test` covering compile, catalog, server endpoints, and tool loops with a fake client.
- **Regression.** A recorded real-Claude transcript kept as a fixture.
- **Live check.** One real-Claude run per phase in the browser, at desktop and 390 px, with no console errors.
- **Shipping.** Commit and push after each phase.

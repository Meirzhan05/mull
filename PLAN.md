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

## Beyond an AI wrapper (phases 9–10)

Phases 1–8 make generation and grading better, but a frontier chat app can also write an interactive lesson on request. What it can't do is check, days later, whether the learner remembered it. It also doesn't act between conversations, and it doesn't know the learner's own course material. Phases 9 and 10 build on what only Wonder has: the review logs, the deck, the plans and the deadlines. Phase 6's learner model estimates mastery per *concept*. Phase 9 measures each *lesson* and each *teaching style*, so the two feed different decisions: what to quiz, and how to teach.

### Phase 9: Did each lesson work? (lesson outcomes) ✅

Every lesson gets measured. Recall a few days later counts as the result, not the quiz score at the end. Those measurements then feed back into how the next lesson is written.

- **Outcome model: `public/outcomes-core.js`.** Pure functions with no DOM, tested under `node:test`. They read only the store: `deck.items` with `lessonId`, `deck.logs`, and `lessons[*]`.
  - **Right after the lesson:** the in-lesson quiz score (`quizScore`), as now.
  - **Delayed recall:** for each lesson's cards, the reviews that came at least 1 day after the previous review of that card (`elapsed_days ≥ 1`, so same-session learning steps don't count). A review counts as recalled at rating ≥ Hard. Results go into delay buckets of 1–3, 4–13 and 14+ days. Each result carries its sample size *n*. It is only shown at *n* ≥ 3 and is labelled `low`, `ok` or `good` by *n*.
  - **Estimated memory today:** the mean FSRS retrievability `R = forgettingCurve(daysSinceLastReview, stability)` over the lesson's reviewed cards. It's available after a single review, so a lesson has a number before it has delayed reviews.
  - **Leeches:** cards missed (*Again*) on ≥ 2 delayed reviews, or lapsed twice by FSRS. The log is needed because FSRS only counts a lapse from Review state, so repeated misses during relearning never reach `lapses ≥ 2`. Leeches point at the exact idea that didn't stick.
  - **Lesson outcome:** `{quiz, recall, buckets, memoryToday, cards, reviewed, leeches, verdict}`. `verdict` is `stuck`, `fading`, `weak` or `unknown`. It is based on recall when *n* is large enough, otherwise on memoryToday.
- **Lesson recipe.** `lessonRecipe(lesson)` reads what went into a lesson from its stored markdown: `{variant, components[], pages, level, grounded, material, tutorQuestions}`. `components` are the catalog tags found in the markdown. It's computed, not recorded, so lessons written before Phase 6 count too.
- **Teaching-style experiment.** Each new lesson is assigned a *style variant*. The variant is a one-line instruction appended to the lesson **user** message, which keeps the system prompt cache unchanged:
  - `standard`: no extra instruction.
  - `example-first`: each page opens with a concrete example before the general idea.
  - `predict-first`: each page opens with a question for the learner to predict, answered with a Reveal.
  - **Assignment is balanced, not random.** Whichever arm has the least data goes next, which matters at single-learner sample sizes. Once every arm has ≥ 3 lessons with ≥ 5 delayed reviews, the best-recall arm is used 2/3 of the time and the rest is spent exploring.
  - A setting (`settings.styleExperiment`, on by default) turns it off, in which case every lesson is `standard`.
  - The variant is stored on the lesson. Steered and resumed lessons keep it.
- **Closing the loop.** `whatWorks(data)` summarizes recall by variant and by component. It reports a finding only when each side has ≥ 2 lessons and ≥ 8 delayed reviews and the gap is ≥ 10 points. One lesson is an anecdote, not a pattern. These are correlations within one learner's lessons.
  - The client sends the result as `learnerInsights` with the lesson request. The server bounds it as untrusted input and adds it to the per-request context block after the cache breakpoint. An example: "Lessons with a worked example (LessonStepper) were remembered better: 86% vs 64% over 31 reviews."
  - The Teacher's `get_progress` now includes each lesson's outcome, the weakest lessons, leech prompts and `whatWorks`. With these it can propose a refresher grounded in what actually faded.
- **UI.**
  - **Up next on Today:** a "Refresh" row for the worst-fading lesson, after Phase 6's "Strengthen".
  - **Lesson end panel:** a "How well it stuck" row showing the quiz now, recall after N days with *n*, memory today and the teaching style. A fading lesson gets "Refresh this lesson's cards", which goes to `#/review/lesson/<id>`: that lesson's cards, due or not, weakest memory first.
  - **You → "What works for you":** recall by teaching style and by visual, each with *n* and an honest "not enough data yet" state. Below that, "Fading lessons" with **Refresh** (review those cards now) and **Relearn** (a new lesson on the same topic in a different style).
  - **Reading rows** (Today's Recent, the Library): "92% recall" in the row metadata.
- **Tests.** Outcome math with synthetic logs (buckets, thresholds, leeches, retrievability), balanced variant assignment and exploitation, the `whatWorks` thresholds, server bounding of `learnerInsights`, and the variant line in the lesson message.

### Phase 10: A proactive Teacher plus your own material ✅

The Teacher should act on the learner's behalf, and lessons should come from the learner's own course and not just a typed topic.

- **Dated plans and backward planning.**
  - `plan_study` gains `deadline` (`YYYY-MM-DD` or `""`), and the strict schema keeps every field required. Today's date is already in the progress snapshot.
  - The plan starts on the learner's today, taken from the snapshot. With a deadline it may not run past it: at most `min(7, days through the deadline)` days, and fewer than 3 only when the deadline is that close. A plan that doesn't fit goes back to Claude as an `is_error` result saying how many days to use. The prompt asks for new material early and a review or quiz last.
  - Each day carries its `date` and `label` ("Thu, Oct 22"). The plan keeps `startDate` and `deadline` when saved, and plans saved before Phase 7 start on their `savedAt` date.
  - `public/plan-core.js` works out today's plan day, items overdue from earlier days, and whether the learner is ahead, on track or behind. Today then shows *today's* item and not just the first unopened one.
  - Plan cards in the Teacher show real dates. Today's study-plan panel marks today's items and late ones, and shows pace, the countdown and "Add to calendar".
- **Daily brief: `public/brief-core.js`.** It's computed from local state, so it costs no model call and works in demo mode. It ranks up to 3 actions:
  - overdue plan items;
  - cards due now (FSRS makes a card due when its recall drops to about 90%), with the lessons they come from;
  - today's plan item;
  - the worst-fading lesson from Phase 9, with **Refresh**.

  The headline is the deadline countdown and pace, a streak at risk (after 6 pm with no XP yet), or the goal status.

  Today shows its headline under the greeting when a deadline or the streak is at stake, and the same ranking feeds Up next. "Ask your Teacher" on Up next starts a check-in.
- **The Teacher speaks first.** It sends `POST /api/teacher/stream {opener: true, progress}`. This happens through "Ask your Teacher" on Up next, and on the first Teacher visit of the day with no thread selected. That automatic check-in has a setting, `settings.teacherCheckIn`.
  - The server sends Claude its own fixed, clearly marked user turn (`TEACHER_OPENER`) and never uses client text for it. This is not a prefill. The client keeps the turn in the thread history but doesn't show it as a learner bubble.
  - The Teacher calls `get_progress` and proposes a concrete next step through a card.
  - The demo teacher has an opener script.
- **Reminders.**
  - **In-app:** `settings.reminder = {enabled, time: "HH:MM"}`. While any Wonder tab is open, a 30-second timer fires a `Notification` once per day at that time if today's goal isn't met. The "shown today" mark lives outside the synced state, so two open tabs don't both fire. The body is the brief's top action. Permission is only requested from the settings toggle.
  - **Calendar export:** "Add to calendar" downloads an `.ics` file with one event per plan day at the reminder time. Each event lists that day's items and a link back to Wonder, so the reminders work even with the app closed and with no push server. `public/ics.js` is pure and tested.
- **Your own material.**
  - **Store: `server/materials.js`.** Files live in `data/materials/` (git-ignored). There's an index of `{id, title, kind: text|pdf, chars|bytes, createdAt}`.
  - **Endpoints:** `POST /api/materials {title, kind, text | base64}` (max 10 MB PDF, 40–200k characters of text, at most 50 materials), `GET /api/materials`, `DELETE /api/materials?id=`, and `GET /api/materials/file?id=` (the original, for "Open source"). Ids are server-generated and checked against `mat-<12 hex>` before any path is built. The client doesn't store the material, only its id.
  - **Lessons from material:** `/api/lesson/stream` takes `materialId`. The material is sent as a cached `document` content block with `citations: {enabled: true}`. Text uses `source.type: "text"`, a PDF uses `source.type: "base64"`. The block is followed by the request text with a "teach from it, stay faithful" line, and steers and resumes resend it.
  - Web search is off by default for material lessons.
  - **Citations to your notes:** document citations (`char_location` / `page_location`) go into the same source registry as web results. They render as `<Cite>` pills titled "<material title>, p. N" and appear in `Sources`, so a lesson cites the learner's own notes.
  - **Courses from material:** given a syllabus or chapter, the course plan follows its structure. The document goes in without citations, because citations don't combine with structured output. Every lesson of that course is taught from the material.
  - **UI:**
    - A "Material" mode in Today's command bar: paste text or attach a .txt/.md/.pdf, then Begin (a lesson) or Make a course.
    - A "Your material" section on You with Open, New lesson and delete.
    - "from <material>" in reading rows.
    - Material Cite pills open the original, PDF pages included.
  - **Demo mode:** the material is stored. For text, the lesson is a deterministic outline of its headings and paragraphs, and the course follows its headings, so the flow works without credentials. Demo mode can't read PDFs and shows a sample lesson for them.
- **Tests.** Plan date math (deadline, behind and ahead, overdue), brief ranking, ICS output (escaping, line folding, `DTSTART`), the materials store (limits, delete, path safety), the document block and citation mapping using a fake client that emits `char_location` and `page_location` citations, and the Teacher opener with a fake client.

### Later (not in this pass)

- Voice tutor with a DIL whiteboard (needs realtime audio).
- Visual practice types.
- Accounts and sync. With them, Phase 9 outcomes could be pooled across learners, which is the real data moat: which explanation of *X* gets the best 7-day recall.
- Web Push reminders when no tab is open (needs a push service).

## Status

Phases 1–5 are implemented, merged into `main` and verified:
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

Phases 9–10 are merged into `main` on top of the Next.js redesign:
- **Tests:** 308 pass with `node --test genui-lab/wonder/test/index.js`: phases 1–8 plus 28 new in `outcomes.test.js`, `proactive.test.js` and `materials.test.js`. They include a Fetch-adapter upload larger than the 2 MB JSON limit. The date tests pass in two time zones, and `next build` is clean.
- **Browser check (production build, demo mode):** run on seeded review history, in the redesigned UI. It covered the brief headline under the greeting, and Up next with Strengthen, Refresh and an overdue dated plan item. It also covered the plan panel (pace, countdown, Add to calendar), the Material mode end to end, "How well it stuck" beside the quality note, "What works for you" beside "What you know", materials, and the reminder and check-in settings. The new parts fit at 390 px.
- **Live check:**
  - The Teacher check-in read the outcomes and proposed relearning the worst-recalled lesson with the best-measured style ("starting from concrete examples has helped you remember things much better").
  - A lesson from pasted lecture notes used the class's own example and carried 11 `Cite` pills that open the original notes.

## Verification for each phase

- **Unit tests.** `node:test` covering compile, catalog, server endpoints, and tool loops with a fake client.
- **Regression.** A recorded real-Claude transcript kept as a fixture.
- **Live check.** One real-Claude run per phase in the browser, at desktop and 390 px, with no console errors.
- **Shipping.** Commit and push after each phase.

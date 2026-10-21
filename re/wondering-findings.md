# wondering.app: static reverse-engineering findings

Scope: static reading of the publicly served JS only. Nothing was executed, there was no login, and no backend calls were made.
Main bundle: `wondering-scripts/.../assets/index-7fdxy4xw.js` (6,572,677 B; Sentry release `aa412b0f…`).
115 lazy chunks were downloaded to `re/wondering-lazy/` (static `/assets/*.js` only). Offsets are byte offsets from `grep -bo` and point into the main bundle unless a chunk is named.

Tags: **[O]** Observed (snippet + offset). **[I]** Inferred from observed code. **[U]** Unknown or not determinable from the client.

Key meta-finding **[O]**: the main bundle keeps the original identifiers (`invokeEdgeFunction`, `validateVoiceVisualPayload`, `TEACHER_MODEL_IDS`…), so it reads almost like source. Lazy chunks are fully mangled. Every edge-function prompt, system instruction and model routing rule lives server-side and cannot be seen **[U]**.

---

## 0. Platform map (verified)

| Area | Evidence |
|---|---|
| Supabase project `mvhwfzawowaxyivkmjdv` | [O] @1274407 `getEdgeFunctionsBaseUrl=()=>"https://mvhwfzawowaxyivkmjdv.supabase.co/functions/v1"` |
| Edge call wrapper | [O] @1278274 `async function invokeEdgeFunction(Ao,No,jo){…No=withClientCapabilities(Ao,No)…responseType==="response"` → raw `fetch` with `Authorization: Bearer <access_token>` + app-info headers; otherwise `supabase.functions.invoke`. Retries on 503 `SERVICE_DEGRADED_CODE` with exponential backoff, plus an optional keepalive (≤60 KB). |
| Client capability negotiation | [O] @1273762 `withClientCapabilities` adds `{visualPracticeSupport:true, visualPracticeKinds:[…]}` to `generate-lesson`, `generate-current-lesson`, `trigger-lesson-generation` and `trigger-next-lesson-generation`. The server only generates practice widgets that this client build can render. |
| "Current" (news-feed) courses reuse endpoints with a prefix | [O] @2816886 `CURRENT_ENDPOINTS={"generate-lesson":"generate-current-lesson",…,"course-chat":"current-course-chat",…}` |
| Router | [O] React Router; 210 route candidates (in `wondering-bundle.json`). Product routes: `/lesson/:sessionId/{theory,challenge,video,versions/:versionId}`, `/practice/session/:id`, `/practice/global-review`, `/teacher/:threadId?`, `/teacher/memory`, `/teacher/library`, `/canvas/:canvasId?`, `/studio`, `/memory`, `/pack-opening`, `/referral`, `/upgrade`, `/settings/usage`, `/docs/mcp`, `/mcp-connect`, `/dive-deeper/:sessionId`. Internal: `/dev/*` (≈60 design/QA pages) and `/admin/*` (metrics). |
| Other stack | [O] PostHog, Sentry, RevenueCat (`Purchases.es` chunk), Capacitor (iOS/Android, Capgo live updates via the `__capgo_keep_url_path_after_reload` flag), AppsFlyer, Lingui i18n (`useLingui`, `zh-TW` chunk), TanStack Query (`queryClient.invalidateQueries`), DOMPurify, KaTeX, react-markdown + remark-math + remark-cjk-friendly, React Flow (`ReactFlow` ×69), Rive (`@rive-app/webgl2` 2.35.0 @4476120), Lottie, lucide-react 0.544.0, sonner toasts, Radix primitives, chess.js-like SAN/FEN handling (`validateFen` @4210279), three.js-like code (×108 "THREE." hits, unverified), MCP server for external agents (`DocsMcpPage` tools: `create_course`, `get_course`, `get_lesson`, `insert_lesson`, `get_learning_summary`; `https://wondering.app/mcp-setup.txt`). |

### Edge functions referenced by the client (≈75; superset of the "~45" already known)
[O] Extracted from `invokeEdgeFunction("…")`, the mangled wrappers in lazy chunks, `getCourseEdgeFunctionName("…")` and `CURRENT_ENDPOINTS`:

- Lesson/course content: `generate-lesson` (`GENERATE_LESSON_ENDPOINT` @1273762), `generate-current-lesson`, `trigger-lesson-generation`, `trigger-next-lesson-generation`, `generate-lesson-pages`, `generate-lesson-plan-from-content` (stages `outline` and `detailed`), `generate-course-outline` (legacy: practices → outline/dictionary/study_notes), `generate-course-mind-map` (modes `ai-plan-preview` and `update`), `generate-lesson-name`, `generate-lesson-cheatsheet`, `generate-quick-intro-lesson`, `generate-practices-from-concept`, `generate-knowledge-cards`, `generate-course-cover`, `generate-avatar`, `create-lesson-shell-from-chat`, `create-dive-deeper-lesson`, `lesson-podcast`, `current-course-podcast`, `lesson-video` (actions `generate`, `get`, `plan_preview`, `illustrated_clip`, `record_view`), `store-svg-illustration`, `process-lesson-insights`, `lesson-progress` (`admit`, `resolve`), `start-deep-research-course`, `parse-pdf` (job + poll), `parse-course-images`, `import-shared-project`, `import-current-course`, `sync-current-course`, `backfill-project-path-order`.
- Chat/tutors: `course-chat`, `current-course-chat`, `check-understanding`, `course-creation-chat`, `teacher-chat`, `canvas-chat`, `canvases` (`list`, `get`, `delete`, `replies`), `feedback-chat`, `realtime-chat` (the **voice** broker: `create_session`, `confirm_session`, `release_session`, `report_usage`, `summarize_tutor_session`, `search_tutor_image`, `search_web`, `think_deeper`, podcast actions), `grade-open-ended`.
- Memory/personalisation: `extract-learner-memory`, `manage-learner-memory` (`delete_item`, `update_item_summary`, `forget_me`), `gmail-connection`, `gmail-context`, `learning-sources`, `search-learning-sources`, `recommend-for-creation`, `recommend-next-courses`.
- Social/growth/billing: `friend-streaks` (`list`, `invite`, `accept`, `decline`, `cancel`, `leave`, `nudge`, `friends`), `social-actions`, `social-profile`, `social-search`, `social-follow-requests`, `social-followers-list`, `check-referral`, `creator-links`, `waitlist-signup`, `sync-subscription`, `resolve-upgrade-checkout`, `feedback-submit`, `linear-notify`, `delete-account`, `benchmark-models` (admin).

### Supabase tables and RPCs seen
[O] Tables via `.from()`: `lesson_sessions`(94 refs), `projects`, `profiles`, `practices`, `user_daily_activities`, `course_nodes`, `knowledge_cards`, `lesson_notes`, `chat_conversations`, `user_practice_progress`, `shared_projects`, `xp_events`, `saved_lesson_pages`, `saved_chat_items`, `user_feedback`, `lesson_practice_logs`, `follows`, `public_sources`, `lesson_plans`, `push_notification_tokens`, `lesson_versions`, `lesson_podcast_episodes`, `lesson_cheatsheets`, `learner_memory_state|items|snapshots`, `app_config`, `user_facts`, `user_avatars`, `teacher_memory`, `subscriptions`, `subscription_interest_events`, `sources`, `referrals`, `live_activity_tokens`, `lesson_videos`, `lesson_practice_generations`, `lesson_learning_formats`, `lesson_assessment_attempts`, `friend_streaks`, `deep_research_course_runs`.
[O] RPCs: `get_usage_limit_status`, `get_usage_limit_summary`, `get_effective_tier`, `is_founding_member`, `sync_session_xp_awards`, `claim_unclaimed_xp`, `get_own_personal_streak_days`, `record_daily_lesson_activity`, `record_daily_lesson_video_activity`, `get_global_review_candidates`, `get_global_review_preview`, `create_or_resume_global_review_with_practices`, `prefetch_next_global_review_session`, `activate_prefetched_global_review_session`, `checkpoint_review_session_answers`, `finalize_checkpointed_review_session`, `complete_global_review_session`, `complete_lesson_session_transaction`, `set_project(s)_global_review_included`, `update_course_node_pages_if_language_current`, `update_lesson_session_name_if_language_current`, `archive_and_reset_lesson_versions`, `ensure_referral_code`, `claim_username`, `is_username_available`, `list_public_shared_courses*`, `report_shared_course`, `block_shared_course_author`, `merge_user_preferences`, `save_learning_reminder_preference`, `register_live_activity_token`, `submit_{lesson,content,podcast}_rating`, `increment_memory_sessions`, `get_independent_lesson_practice_ids`, `get/set_course_learning_format`, `mark_current_course_lessons_seen`, and others.

---

## 1. Generative UI ("the AI renders UI")

### 1.1 Core mechanism: inline markers in Markdown
[O] The model never emits JSX or HTML. It writes Markdown containing **mustache-style markers** that the client swaps for registered React components.

- Marker grammar @4091499 `processInteractiveComponents`:
  `/\{\{interactive:([^\s}]+)(?:\s+((?:[^}'"]|'[^']*'|"[^"]*")*))\}\}|\{\{interactive:([^\s}]+)\}\}/g`
  Example from a shipped course chunk: `{{interactive:movie-script-simulator hasButton=true}}`. Example from a dev page: `{{interactive:lesson-stepper data='{"title":"Ship it","steps":[{"label":"Read","text":"…"}]}'}}` (`DevLessonCitationsPage`).
- Param parsing @4093110 `parseComponentParams`: `key=value` pairs (`"…"`, `'…'` or bare). Values starting with `[`/`{` or equal to `true/false/null` are `JSON.parse`d, with a retry after un-escaping `\"`. Numeric strings become numbers. If `data=` is present it must be a JSON object, otherwise `isValid=false`. Reserved params are `instanceId` (stable React key) and `altText`.
- Unknown component → `console.warn("…not found in registry, skipping")` plus a PostHog event `INTERACTIVE_COMPONENT_UNKNOWN`, deduped per lesson session with LRU caps of 100 sessions × 100 names (@4090800).
- `rejectInvalidMarkers` mode (chat surfaces) removes invalid markers and **suppresses half-streamed markers**. While streaming, a trailing partial `{{interactive:` prefix is trimmed char-by-char (`removeUnrenderableInteractiveMarkers`), so raw marker text never flashes on screen.
- Each marker is replaced with a placeholder `%%%INTERACTIVE_n%%%`. react-markdown renders the text, and the placeholders are swapped back for `<InteractiveComponentErrorBoundary componentName=…><Component {...params}/></…>` (@4094332). The error boundary renders "Interactive component failed to load: <name>" and tracks `INTERACTIVE_COMPONENT_RENDER_FAILED`.
- Markers that carry an `instanceId` are split out of the markdown as whole lines, so the component keeps its React identity across re-renders (@4105554 end).

### 1.2 Component registry (`INTERACTIVE_COMPONENTS` @4084974, 100 entries)
[O] Full key list:

- **Generic, model-choosable lesson widgets:** `lesson-stepper`, `lesson-stepper-worked-example`, `lesson-reveal`, `lesson-compare-toggle`, `lesson-input-output-slider`, `lesson-table`, `wondering-lens`, `lesson-figure`, `visual-list`, `visual-stepper`, `visual-cards`, `visual-table`, `visual-loop`, `visual-hierarchy`, `visual-quadrant`, `visual-venn`, `visual-stat-bars`, `visual-transform`, `animated-graph`, `simple-simulation`.
- **Data-viz:** `diagram-visualization`, `flowchart-visualization`, `concept-map-visualization`, `comparison-visualization`, `hierarchy-visualization`, `cycle-visualization`, `infographic-visualization`, `timeline-visualization`, `quadrant-visualization`, `quadrant-matrix-visualization`, `pyramid-visualization`, `rings-visualization`, `bar-chart-visualization`, `line-chart-visualization`, `pie-chart-visualization`, `scatter-plot-visualization`, `area-chart-visualization`, `heatmap-visualization`, plus `*-d3` variants (diagram, flowchart, concept-map, comparison, timeline, hierarchy, cycle, infographic) and 14 `deprecated-*` variants kept so old content still renders.
- **Hand-authored "AI Foundations" course widgets** (`AUTHORED_INTERACTIVE_COMPONENTS` @5165391): `movie-script-simulator`, `word-prediction-visualizer`, `probability-distribution`, `output-variety-table`, `randomness-simulator`, `timeline-scale`, `data-scale-comparison`, `parameter-scale-visualizer`, `parameter-weight-demo`, `before-after-training`, `training-loop-animation`, `accuracy-progress-chart`, `computation-time-calculator`, `rlhf-simulator`, `feedback-loop-visualization`, `post-training-comparison-table`, `two-stage-training`, `parallel-processing-visualizer`, `gpu-speed-comparison`, `transformer-architecture-diagram`, `word-encoding-animation`, `word-embedding-visualizer`, `vector-space-explorer`, `attention-mechanism-visualizer`, `context-disambiguation`, `feed-forward-architecture`, `layer-stack-visualizer`, `layer-data-flow-animation`, `prediction-probability-chart`, `prompt-comparison-tool`, `prompt-builder`. The registry also has `parameter-dial-board`, `historical-time-comparison`, `gpu-architecture-diagram`, `sequential-vs-parallel-comparison`, `transformer-timeline`, `emergence-demonstrator`, `black-box-visualizer`, `llm-capabilities-showcase` and `model-evolution-comparison`.

### 1.3 The model-facing schema: `embed.type` → componentName
[O] `ModelBenchmarkReportPage` chunk @1057 (admin benchmark that reproduces the production pipeline):
```
G={stepper:"lesson-stepper",flowchart:"flowchart-visualization",stepper_worked_example:"lesson-stepper-worked-example",
 reveal:"lesson-reveal",compare:"lesson-compare-toggle",slider:"lesson-input-output-slider",table:"lesson-table",
 list:"visual-list",cards:"visual-cards",loop:"cycle-visualization",infographic:…,hierarchy:…,comparison:…,quadrant:…,
 quadrant_matrix:…,timeline:…,pyramid:…,rings:…,bar_chart:…,line_chart:…,pie_chart:…,scatter_plot:…,area_chart:…,
 heatmap:…,concept_map:…,wondering_lens:"wondering-lens",venn:"visual-venn",stat_bars:"visual-stat-bars",transform:"visual-transform"}
function T(e){…return`{{interactive:${s} data='${JSON.stringify(rest).replace(/'/g,"\\u0027")}'}}`}
function Q(page,a){ …content.split(/\n\s*\n/)… splice(a.insertAfterParagraph,0,marker) }
```
[I] The LLM returns structured `{embed:{type:<snake_case>, …fields}, insertAfterParagraph:n}` per page. Server code (mirrored by this admin page) turns it into a marker and splices it after paragraph *n*. The model therefore picks from a closed set of **29 embed types**, and the frontend registry maps those to components. The same page names the pipeline steps: *"generate pages, insert embed placeholders, then resolve inline SVGs — with a model chosen for each step"* (`ModelBenchmarkPage` @1479).

### 1.4 Param schemas (from component normalizers; all lenient and alias-tolerant)
[O] Every generic component takes either spread props or `data={…}` and normalizes defensively:
- `lesson-stepper` @3399056: `{title?, steps:[{label?, text|description}]}`
- `lesson-stepper-worked-example` @3401276: `{title, context, steps:[{label,text|description,example,hints[],image:{src,alt}}], revealVariant="prose", revealLabel}`
- `lesson-reveal` @3408476: `{title, items:[{label, content|text|description}], startCollapsed}`
- `lesson-compare-toggle` @3411796: `{title, left:{label, points[]}, right:{label, points[]}}`
- `lesson-input-output-slider` @3415922: `{title, inputLabel, outputLabel, unit, stops:[{value,label,output|description,description}]}`
- `lesson-table` @3422601: `{title, columns[≤4], rows[≤6][≤4]}`
- `wondering-lens` @3407608: `{title, body|content}` (styled aside)
- `visual-list` @3439885: `{title, description, variant (bullet|stepper|…), items|steps, layout}`; `visual-stepper` @3445712: `{steps|items:[string|{label,text|description,example}]}`; `visual-cards` @3450015: `{cards:[{title|label, description|text, items|points, category}]}`; `visual-venn` @3469798: `{leftLabel,rightLabel,onlyLeftHeading,sharedHeading,…}`; `visual-stat-bars` @3471370: `{items:[{label,value,note,max}]}`; `visual-transform` @3474988: `{before, after, changes[], transformLabel}`; `visual-quadrant` @3466223: `{xAxis,yAxis,quadrants:[{position: top-left|…}]}`
- **Voice/board visuals have strict validators** (§3.5) with bounded arrays and a single highlight.
- **Authored widgets are validated by example** [O] @5168219 `isValidAuthoredInteractiveData` → `matchesDefaultShape(data, interactiveDefaults[name])`. The shipped default object (@3911464) acts as a structural type, so arrays must be non-empty and every element must match `defaults[0]`. They also support `localizedData` per language and `LEGACY_COPY_KEY_MIGRATIONS`. Authored placements are `{component, placement∈[0,1], sourceLanguage, data, localizedData?}` (`normalizeAuthoredInteractives` @5168813).

### 1.5 Lesson page structure
[O] Lessons are stored in `course_nodes.content->pages` (@4725536 `select("course_nodes!left(pages:content->pages)")`) and written through RPC `update_course_node_pages_if_language_current`, guarded by a language revision (@4741000).
[O] Page = `{heading, content}` with Markdown `content`, for example (`ai-foundation` chunk): `"pages":[{"heading":"The Lyrics Sheet Mystery","content":"Imagine … **lyric sheet** …\n\n{{interactive:movie-script-simulator}}"}]`. A lesson carries `name`, `hook`, `meaning`, `concepts[{name,description}]`, `keywords[{name,description}]` and `pages[]`. Course outline = `sections[{name, lessons[…], sourceContent?}]` (`atomic-habits-*` chunks; 255 pre-built book/course chunks ship as static JSON or Markdown).
[O] There are no typed theory, quiz or flashcard *page blocks*. A page is Markdown plus embedded widgets, and **practices are a separate entity** (`practices` table) that is interleaved with pages (`parseCoursePracticeSettings` @4752052: `targetPracticeCount`, `shortenedPracticeMode`, `practiceAfterTheory`, `interleavePracticePages`, `practiceModality: "spoken"|…`).

Markdown features handled by `MemoizedReactMarkdown` (@4105554):
- **LaTeX** [O]: `remarkMath` with `singleDollarTextMath:false` plus `rehypeKatex` (@3393695). `normalizeLatexDelimiters` (@4103340) rewrites `\( \)` and `\[ \]` to `$$…$$` and skips code fences.
- **SVG** [O]: an `img` whose URL ends in `.svg` goes to `SafeSVGRenderer`. That fetches the file, checks the content type, sanitizes with DOMPurify (hook strips `script`, `iframe`, `object`, `embed`, `foreignobject` @3047342) and fixes dimensions (`fixSVGDimensions`, default 800×600 viewBox). Inline SVG generated by the LLM is stored with `store-svg-illustration` → `svgUrl` (PracticeSessionPage chunk).
- **Real-world image figures with license** [O] @4094900: `REAL_WORLD_IMAGE_PATTERN` = `![alt](https://…)\n\n*caption*`, accepted only if the caption matches `/\bCC BY\b|\bCC0\b|Public Domain Mark/`. Caption parts are split on `" · "` into citation links and rendered as `RealWorldImageFigure`.
- **Hand-made interactive figures** [O] @3425211: `LESSON_FIGURES` is a catalog of `{id, concept, useWhen, placements[{sharedProjectId, sectionIndex, lessonIndex, anchorTerms[]}]}` (`consistent-hashing`, `dynamodb-gsi`, `kafka-partitions`, `redis-pubsub`, `geohash`, `distributed-lock`, `dot-product-attention`). They are lazy-loaded `Figure-*.js` chunks (@3433852) gated by the `lesson_figures_rollout` flag. `placeLessonFigure` inserts `{{interactive:lesson-figure data='{"id":…}'}}` after the first plain paragraph containing an anchor term. [I] The `concept`/`useWhen` prose reads like an LLM tool catalog, so these descriptions may also be fed to a model server-side.
- **Citations** [O]: (a) `[[SOURCE:<passageId>]]` markers in chat answers become `[S1]`… keyed by passage (`replaceSourceMarkers` @2880293). A partial marker is held back during streaming (`sourceMarkerHoldIndex`). (b) In lesson pages, Markdown links are renumbered as `[[n]](<url> "title")` against the course `sourceLinks` (`lessonPageSources` chunk). Links inside interactive markers or image figures are skipped.
- **Keywords/glossary** [O]: `parseKeywordsInText` (@4133885) wraps whole-word, longest-first matches in `KeywordHighlight`, which has an "explain" action.
- **Page markers** [O]: `<!-- page N -->` is stripped by `withoutPageMarkers` (@4111915).
- **Cloze** [O]: `%%%CLOZE_n%%%` placeholders inside `MarkdownClozeRenderer`.

### 1.6 Practice item types (separate from pages)
[O] @2828366 `PRACTICE_TYPES={FLASHCARD:"flashcard",MCQ:"mcq",BINARY_CHOICE:"binary_choice",CLOZE:"cloze",POOL_CLOZE:"pool_cloze",DRAG_ORDER_STEPS:"drag_order_steps",OPEN_ENDED_EXPLANATION:"open_ended_explanation",COMPARE_CONTRAST:"compare_contrast",MATCHING_PAIRS:"matching_pairs",VISUAL:"visual"}`. Default course mix: `["mcq","pool_cloze","binary_choice","drag_order_steps"]`, 4–8 per lesson, difficulty "beginner" (@4641579). `matching_pairs` is experimental (`EXPERIMENTAL_PRACTICE_TYPES`).
[O] Option shapes from validators (@4337205): MCQ `choices[{id,…,isCorrect}]` (multi-select uses a Set); cloze `clozes[{id,answer,acceptableAnswers[]}]` (case-insensitive); pool_cloze exact match; drag_order `steps[{id,correctPosition}]`; matching `pairs[{id}]`; flashcard self-grade `"recall"`; open-ended `rubric[]`; compare_contrast `conceptA/conceptB`. Open-ended answers are graded asynchronously through `grade-open-ended`.
[O] **Visual practice** (`type:"visual"`, `options.visual.kind`) @1249502: `chess_move, tap_select, number_line, system_diagram, graph_trace, chart_select, coordinate_plane, figure_label, text_select, piano_keys, diagram_recall, map_select`, plus variants `chess_puzzle, number_line_dot_plot, diagram_recall_decoys`. Hard limits are enforced client-side (`VISUAL_PRACTICE_LIMITS`: prompt ≤200, explanation ≤400, hint ≤160, 2–9 targets…). `system_diagram` uses a fixed vocabulary of 20 components (client, cdn, load_balancer, queue, …) and the tasks `find_spof|trace_path|missing_component` (@1226900).

---

## 2. Text chat tutors

There are **three text-chat backends** plus course-creation chat:

### 2.1 Lesson/course chat (`course-chat`), `chatApi.sendMessage` @2817589
[O] Request body:
`{message, history, courseId, courseName, lessonTitle, lessonSessionId, pageIndex, videoScene, sessionContext, chatScope, useWebSearch (default true), lessonCreationMode, includeVisuals, includeFigures, includeSourceCitations:true, noMemory}`. 429 with `chat_limit_exceeded` raises `ChatLimitExceededError(current, limit)`.
[O] Streaming protocol: **SSE over fetch** (`body.getReader()`, split on `\n`, lines `data: {json}`, terminator `data: [DONE]`). This is not Supabase Realtime.
[O] Event types handled @2851064–2852928:
- `content` → append delta (`Tu+=zc.content`)
- `status` → `searching` | `search_complete` | `generating_visuals`
- `embed_progress` → **replaces the whole message** with a server-sanitized version that has the visual markers resolved (`isContentSanitized:true`)
- `final` → authoritative final content
- `citations` → `[{url_citation:{url,title,sourceId,passageId,paragraph,quote,page,startSeconds}}]`
- `quick_replies` → `message.quickReplies` (suggested-reply chips)
- `feedback_id`, `feedback_saved`, `error`

[I] The server streams prose first, then post-processes visuals: placeholders are resolved into `{{interactive:…}}` and SVGs, and the cleaned text is re-sent through `embed_progress`/`final`. In chat the renderer uses `rejectInvalidEmbeddedContent`.
[O] Chips: `QuickReplyButtons` @4115464 takes `buttons:[{text, action?}]`, supports `multiSelect` with checkboxes, and lets `action` buttons trigger app actions instead of sending text.
[O] Follow-up suggestions: `getLessonFollowUpQuestions(storedQuestions)` returns up to `MAX_FOLLOW_UP_QUESTIONS` stored strings, gated by the experiment `lesson_chat_follow_up_questions` (@2878967).
[O] Conversations persist in `chat_conversations` with `messages[{role,content,citations,metadata,lessonCreationTurn}]`.

### 2.2 Check-understanding (`check-understanding`) @2821617
[O] `{lessonContent, currentPageIndex, message, history, projectId, courseName}`, same SSE framing. Events used: `content`, `quick_replies`, `error`.

### 2.3 "Teacher" agent (`teacher-chat`), the newest surface (flag `teacher_tab_rollout`)
[O] Constants @1693796:
```
TEACHER_FUNCTION_NAME="teacher-chat", TEACHER_MODEL_IDS=["claude-sonnet","claude-opus","gpt-sol","gpt-luna"],
DEFAULT_TEACHER_MODEL="claude-sonnet", TEACHER_EFFORTS=["low","medium","high"], DEFAULT_TEACHER_EFFORT="high",
TEACHER_PERSONA_DIAL_VALUES={tone:["warm","brisk","playful"],challenge:["gentle","balanced","push"],
  hints:["hint_first","tell_me"],proactivity:["nudge","on_request"],replyLength:["short","detailed"]},
TEACHER_PERSONA_MAX_DONTS=12, TEACHER_ATTACHMENTS_BUCKET="teacher-attachments", TEACHER_MAX_ATTACHMENTS=4,
TEACHER_MESSAGE_MAX_LENGTH=4e3, TEACHER_PLAN_DAYS=7
```
[O] User-facing **model picker** (TeacherPage chunk @3540): "Thinking" level labels Quick/Balanced/…, model saved to `localStorage.teacherModelSelection`, and effort defaults to `low` for `gpt-*` models.
[O] API (teacher chunk): a single function with `action`: `send`, `list_threads`, `get_thread`, `create_thread`, `archive_thread`, `sidebar`, `plan_days`, `resolve_action`, `undo_action`, `answer_quiz`, `update_plan_item`, `get_persona`, `update_persona_settings`, `update_memory_line`, `delete_memory_line`.
[O] Send body: `{action:"send", threadId, message, attachments?, timezone, model?, effort?, includeFigures?}` (teacherActionCard @138723).
[O] Stream: SSE using **proper event framing** (split on blank line `\n\n`, join multi-line `data:`). Whitelisted event types @628: `thread`, `text_delta`, `tool_start`, `tool_result`, `status`, `done`, `error`. Error codes are `limit_exceeded` (429), `bad_request` (400/413), `unavailable`, `busy`. Stream end without `done` produces "Stream ended early".
[O] Reducer (`Cn` @23105): `tool_start{toolCallId,name,label}` shows an "active tool" status line. `tool_result{toolCallId,cards[]}` and `done{messageId,cards[]}` **merge cards into the assistant message**, deduped by `Ge(card)` keys.
[O] **Tool results become UI cards** (`Si` @68022): `plan`, `plan_diff`, `approval`, `course_suggestions`, `course`, `lesson`, `lesson_list`, `quiz`, `review`, `memory`, `job`, `goal`, `reminder`, `calendar`, `sources`, `library`, `friends`, `navigate`, `visual`. A `visual` card is `{markdown}` rendered through the same interactive-marker renderer. A `quiz` card is `{quizId, kind:"mcq"|free text, question, options[], learnerAnswer, correct}` answered via `answer_quiz`. `approval`/`plan_diff`/`job` carry `actionId` plus `status` and use `resolve_action`/`undo_action` (human-in-the-loop). A job card shows "You can keep chatting. It will show up here when ready."
[I] Teacher is an agentic, tool-calling assistant with server-side tools (planning, creating lessons/courses, memory writes, quizzes, background jobs). Exact tool names are server-side **[U]**; only the card types are visible.

### 2.4 Canvas chat (`canvas-chat`, CanvasEntryPage chunk @6858)
[O] React-Flow canvas of thread cards. Models `[{id:"gemini-flash",label:"Fast"},{id:"gpt-luna",label:"Think harder"}]`, default `gemini-flash`. Body: `{message, history, contextExcerpt, sources, responseMode("answer"…), useWebSearch, includeFigures, cardTitle, cardSummary, model, persistence}`. SSE events: `content`, `status`, `citations`, `embed_progress`, `final{truncated}`, `summary{title,summary}` (auto-titles the card), `suggestions{…, newThreads[]}` (suggested questions and branch threads), `error`.

---

## 3. Voice tutor ("Live Tutor")

### 3.1 Session brokering: one edge function, multiple providers
[O] `realtimeChatApi.createSession` @4788620 → `invokeEdgeFunction("realtime-chat",{action:"create_session", quotaContractVersion:2, tutorToolContractVersion:2, supportedTutorToolContractVersions:[5,4,3,2], coveredTopicIds, experience, tutorMode, visualsEnabled, history (only for gpt-live-1, last 30, ≤8000 chars), courseId, courseName, lessonSessionId, scopeLessonSessionIds (≤5), lessonTitle, sessionContext, chatScope, noMemory, useWebSearch, podcast fields…, model, sdpOffer, supportedProviders:["openai","google"]})`.
[O] Response is validated: `clientSecret` or `sdpAnswer`, plus `model`, `provider` ("openai"|"google", else inferred from `model.includes("gemini")`), `requestGroupId`, `usageReportToken`, `expiresAt`, `maxSessionDurationMs`, `sessionId`, `lessonVisuals[≤12]`, `knowledgeCardTargets[≤6]`, `tutorToolContractVersion`. 429 `live_chat_limit_exceeded` raises `LiveChatLimitExceededError`.
[O] Lifecycle actions: `confirm_session`, `release_session`, `report_usage` (token usage per response/delegation), `summarize_tutor_session` → `{summary, didWell[≤3], couldImprove[≤3], actionItems[≤3], visual?}` (recap screen).
[O] Client model request (LessonVoiceTutor chunk @28291): `flag(gpt_live_voice_api_rollout) ? "gpt-live-1" : "gpt-realtime-2.1"`. [I] The server picks the actual provider and can return `gemini-3.8-live` with an ephemeral `clientSecret`. The client supports all three transports.
[O] **Ephemeral token**: the Gemini WebSocket URL is `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<clientSecret>` (@4794700 onward). The `setup` message sends **only** `{setup:{model:"models/<model>"}}`. [I] System prompt, tool declarations, voice and VAD config are locked into the ephemeral token server-side ("Constrained" endpoint), so none of that reaches the client **[U]**.

### 3.2 Audio pipeline (Gemini path) @4794700–4806500
[O] Constants: `INPUT_SAMPLE_RATE=16e3`, `INPUT_ACTIVITY_THRESHOLD=.02` (RMS), `INPUT_ACTIVITY_END_DELAY_MS=600`, `INPUT_FRAME_SAMPLES=640` (40 ms), `GEMINI_3_8_OUTPUT_LOW_PASS_HZ=6500`, `PLAYBACK_JITTER_BUFFER_SECONDS=.1`, `SETUP_TIMEOUT_MS=1e4`.
- Capture: `new AudioContext({sampleRate:16000})` → `createScriptProcessor(256,1,1)` (no AudioWorklet) → muted gain sink. Each buffer is nearest-sample resampled to 16 kHz, converted to **PCM16 LE** (`encodePcm16`, ±32767/32768), framed into 640-sample chunks and base64-encoded, then sent as `{realtimeInput:{audio:{data, mimeType:"audio/pcm;rate=16000"}}}`.
- Local VAD is **UI-only**: RMS ≥ 0.02 starts "user speaking", 600 ms of silence ends it. Mute sends `{realtimeInput:{audioStreamEnd:true}}`. [I] Turn-taking VAD is server-side Gemini automatic activity detection; no VAD params appear client-side **[U]**.
- Playback: `serverContent.modelTurn.parts[].inlineData` PCM16 at the rate parsed from `mimeType` (default 24 kHz) → `AudioBuffer` → `BufferSource`, gaplessly scheduled at `max(nextPlaybackTime, now+0.1s)`. For gemini-3.8-live audio passes through a biquad low-pass `min(6500, 0.45·sr)`.
- Barge-in: `serverContent.interrupted` stops all sources and drops model audio until `turnComplete`.
- History bootstrap: `{clientContent:{turns:last30.map(role user|model, text≤8000), turnComplete:true}}`. Proactive start: `{realtimeInput:{text:"Begin the lesson now."}}`.
- Transcripts: `serverContent.inputTranscription.text` and `outputTranscription.text` are accumulated per turn id (with prefix dedupe). Usage comes from `usageMetadata`.

### 3.3 OpenAI paths
[O] `GptLiveTransport` @4807062 (model `gpt-live-1`): **WebRTC**. `RTCPeerConnection` plus data channel `"oai-events"`, the SDP offer is sent through `realtime-chat` (`sdpOffer`) and the `sdpAnswer` is applied. Events: `session.started`, `session.input_transcript.delta`, `session.output_transcript.delta`, `session.usage.updated`, `session.closed`, `response.event{response.output_item.done function_call | response.completed}`. Outgoing: `response.create`, `session.thinking.append`, `session.instructions.append` (≤2000 chars), `response.item.create{function_call_output}`, `session.close`. Includes a startup-playback watchdog using `getSynchronizationSources().audioLevel`.
[O] A generic OpenAI Realtime path (`conversation.item.create` with system `input_text`, `response.create{output_modalities:["audio"], tool_choice:"none"}`) is used for `gpt-realtime-2.1` (@4838300 onward).

### 3.4 Tool loop
[O] `VOICE_TOOL_NAMES` @4786553 (12 tools, as already known). Scheduling: `NON_BLOCKING_TOOL_SCHEDULING={save_note:"WHEN_IDLE",save_knowledge_card:"WHEN_IDLE",show_text:"SILENT",show_lesson_visual:"SILENT",show_visual:"SILENT"}`, applied only when `model==="gemini-3.8-live"` and attached to `functionResponses[{id,name,response,scheduling}]`.
[O] Gemini loop (@4838300 onward): `toolCall.functionCalls` run sequentially on a promise chain. Calls listed in `toolCallCancellation.ids` are skipped. If any call is blocking, the state goes to "thinking". **Board-mutating tools** (`show_text`, `show_lesson_visual`, `show_visual`, `search_image`) and `end_session` first `await assistantAudioGate.waitForIdle()`, so the visual appears only after the current utterance finishes. Results are JSON-roundtripped and sent as `{toolResponse:{functionResponses}}`. Results with `sources` are merged (≤5). After `end_session` ok, the session closes and a recap follows.
[O] OpenAI loop: outputs are buffered (`getRealtimeToolFlushDecision`). The client then injects a system note `TOOL_CONTINUATION_NOTE` and `response.create`. Stall recovery uses `TOOL_CONTINUATION_STALL_NUDGE` ("Your last reply was silent. Speak now…"). Goodbye uses `END_SESSION_GOODBYE_NOTE` ("…Speak exactly one super-short warm closing sentence…"). A time-limit warning uses `SESSION_ENDING_INSTRUCTION` with a 120 s final countdown.
[O] Client-side handlers (LessonVoiceTutor chunk @21172/@21789):
- `get_board_state` → `{ok, board:{items:[{id,title,kind}]}}`
- `show_lesson_visual{visual_id}` → looks up the session's prepared `lessonVisuals` (image or component)
- `show_text{title(≤8 words), markdown(≤80 words)}`
- `search_image{query, subject, title}` → `realtime-chat/search_tutor_image`
- `show_visual{visual, replaces_item_id?}` → validated visual (§3.5), adds or updates a board item
- `save_note{title≤120, note≤900, visual?}`, `save_knowledge_card{name≤120, description≤600, example≤400, node_id}`, `think_deeper{question≤1000, context≤1500}` → server `think_deeper` (a stronger model, inferred), `search_web{query≤500}`
- Error codes: `invalid_arguments`, `unknown_tool`, `board_unavailable`, `unknown_lesson_visual`, `unknown_item`, `no_image_found`, `lesson_not_complete`, `challenge_incomplete`, `manual_end_required`, …
[O] **Board** (@17591): a reducer with `add-item`, `update-item`, `report-height` and `clear`. Items are stacked vertically (width 720, gap 56, default height 320) on a lazy `TutorCanvas` chunk with a pan/zoom camera (`camera-init-empty`, `focused-card-pinch-*` event names). Payload kinds are `text`, `image` and `visual{componentName, params}`.

### 3.5 Voice visual schema (strict)
[O] `VOICE_VISUAL_TYPES=["flowchart","timeline","comparison","bar_chart","concept_map","loop","reveal","slider"]` mapped by `VOICE_VISUAL_COMPONENTS` @5054543 to `flowchart-visualization`, `timeline-visualization`, `comparison-visualization`, `bar-chart-visualization`, `concept-map-visualization`, `cycle-visualization`, `lesson-reveal` and `lesson-input-output-slider`. Validators (@5055708–5061432):
- flowchart: `nodes[3..8]{id,label,type∈start|process|decision|end,highlighted?}`, `connections[2..12]{from,to,label?}`
- timeline: `events[3..7]{date,label,description?,highlighted?}`
- comparison: `items[2..4]{label, attributes[1..6]{name,value}, details[0..6]?}`, `commonFeatures≤5`
- bar_chart: `unit` (required), `xLabel?`, `yLabel?`, `bars[2..6]{label,value:number,description?}`
- concept_map: `centerConcept`, `nodes[3..8]{id,label,level∈1|2}`, `connections[2..10]{from,to,relationship}`
- loop: `centerLabel?`, `stages[3..6]`; reveal: `items[1..4]{label,content}`; slider: `inputLabel`, `outputLabel`, `unit?`, `stops[3..7]{value,label?,output,description?}`
- `keepSingleHighlight` keeps one highlight at most. `toVisualComponentProps` converts `{name,value}[]` to records and adds ids.
[I] The `[{name,value}]` list form instead of maps is a typical workaround for tool-schema limits (no free-form object keys in function-calling JSON schema).

### 3.6 Other voice details
[O] Lesson voice experiences: `experience:"lesson_tutor"`, `tutorMode` `teach` | `challenge` | `review` (challenge maps to `challenge_adaptive`). Interactive podcast companion mode (`lesson_podcast_companion_rollout`, `interactive_podcast_rollout`). Monthly live-chat quota per tier (§7).

---

## 4. Course creation pipeline

[O] State machine `createInitialState` @5982062: `flowState` initial → collecting-input → clarifying → confirming-goal → loading-plan → …, with `source{type: text|url|file|upload|library}`, `courseName`, `courseGoal`, `courseBackground`, `learningSituation`, `courseResearchMode:"standard"|deep`, `lessonPlan`, `contentLanguage`, and more.

1. **`course-creation-chat`** (@5364696). Body `{message, messages, userRoles, isFirstCourse, source, flowState, courseName, courseGoal, courseBackground, multiSelect:true, skip?, mode?:"personalization", …routing fields}`. The response is either JSON or SSE (`data:` events `status{searching}` | `result` | `error`). Result `type`: `clarification{message, quickReplies, multiSelect}`, `goal_suggestion{suggestedName, suggestedGoal, suggestedGoalSummary, suggestedBackground}`, `library_suggestions{suggestedSourceIds}`, `answer`, `error`, plus `routedAction` (A/B `course_creation_chat_router`). The UI also has `source_added`, `library_selected` and `course_creation_request_changes`/`plan_revised` message types (@5980300).
2. **Sources**: PDFs are uploaded to bucket `course-creation-files` (≤50 MB) → `parse-pdf{filePath}` → `{jobId, pollToken}`, then GET polling `?jobId&filePath&pollToken` with exponential backoff and a 5 min timeout (@2875077). Images are uploaded temporarily → `parse-course-images{files}` → `{content}` (OCR/vision text), then deleted (@6343002). URLs and library sources (`learning-sources`, `search-learning-sources`). Payload cap: "source payload exceeds 500,000 characters".
3. **Plan**: `generate-lesson-plan-from-content` called twice, `stage:"outline"` then `stage:"detailed"` (optionally `detailScope:"first"`), with `{content, language, languageCourse?, concreteTeaching?}` (@4731762). An optional mind-map preview comes from `generate-course-mind-map{mode:"ai-plan-preview", projectName, branches}`. In parallel the client streams a course intro ("opening") and "achievements" text through `course-chat` with generated prompts.
4. **Shell creation is client-side** (`createCourseWithLessons` @4732924). It inserts `course_nodes` (sections and lessons) and `lesson_sessions` (`status:"pending_generation"`, `session_type:"new"`, `path_order`, `session_config{name,hook,…}`), plus "applied lesson" sessions per section. Options: `{practicesPerLesson:{min:4,max:8}, difficulty:"beginner", practiceTypes}` and `{skipFirstLessonGeneration, generateMindMap, lessonGrounding:"teaching_brief", learnerGoal, learnerBackground, firstLessonAdaptation}`. On failure it rolls back nodes and sessions.
5. **Per-lesson generation is lazy and async**: `triggerLessonGeneration` → `generate-lesson{sessionId, userId, runInBackground:true, notifyWhenReady?}` plus the capability fields. The client polls `lesson_sessions.status/generation_phase` (`writing_pages` | `finishing` | `saving`). A generation is treated as stalled after 120 s, or after 300 s with a reset (@4725536). Progress bars use modeled p50 durations (`COURSE_GENERATION_STAGES` @4650318: setup 4 s, planning 9 s, writing 20 s, finishing 12 s, saving 3 s; percent = `start+(end-start)*0.9*(1-e^(-t/p50))`). Practices are polled in `lesson_practice_generations`. `generate-lesson-pages` exists as a direct call (`generateLessonPages` @4742472). Names come from `generate-lesson-name` and covers from `generate-course-cover`.
6. **Deep research course** (flag `deep-research-course`): `start-deep-research-course{idempotencyKey, courseName, courseGoal, courseBackground, contentLanguage, lessonDepthPreference:"standard", difficulty, source, messages, userRoles, initialPlan, practiceTypes, generationModelProfile:"quality", lessonPlanId, conversationId}` → `{projectId, runId}`. This is a durable background run tracked in `deep_research_course_runs` (`status`, `stage`, `review_rounds`, `retry_count`) (@5363700).
7. Legacy: `generate-course-outline` with `{projectName, practices, options, mode: dictionary|study_notes}` (@4620900).

---

## 5. Practice, spaced repetition, knowledge cards, memory

- **Algorithm = FSRS v5 via a bundled `ts-fsrs`** [O]. @4319400: 19-weight default `w=[.40255,1.18385,3.173,15.69105,7.1949,.5345,1.4604,.0046,1.54575,.1192,1.01925,1.9395,.11,.29605,2.2698,.2315,2.9898,.51655,.6621]`, `request_retention=.9`, `maximum_interval=36500`, `enable_fuzz=false`, `enable_short_term=true`, with auto-migration from 17-weight sets ("[FSRS V5]auto fill w to 19 length"). `fsrsInstance=nt()` @4651848 uses defaults (no per-user optimisation seen) **[O]**.
- Card fields [O] in `user_practice_progress`: `due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state(New/Learning/Review/Relearning), last_review`. Every review is logged to `lesson_practice_logs{rating,state,stability,difficulty,elapsed_days,last_elapsed_days,scheduled_days…}` (@4673000). Lesson-completion batches are scheduled client-side by `scheduleLessonCompletionPractices` (@4659038) and sent to `complete_lesson_session_transaction` [I].
- Ratings [O] @4340378: binary correct/incorrect maps to Good/Again. Rubric-graded answers use `passedRatio>0.7`→Good, `>0.3`→Hard, else Again. A criterion passes if `score ≥ 0.6·maxPoints`. Visual practice uses a grader-provided `rating∈good|hard|again`.
- **Global review** [O] @4711887: `get_global_review_candidates{p_due_before, p_excluded_types:[open_ended_explanation, compare_contrast], p_max_candidates}`, then a per-course shuffle with a **round-robin interleave across courses** (`shuffleAndInterleaveDuePractices`). Sessions are `session_type:"review"`, `project_id:null`, `session_config.review.kind:"global"`. Prefetch/activate/checkpoint/finalize RPCs make review resumable. Per-course opt-out lives in `/settings/global-review`. There is also a per-course "Quick review" (`PRACTICES_PER_QUICK_REVIEW`).
- **Knowledge cards** [O] @5044109: table `knowledge_cards{user_id,node_id,name,description,example}`, created by `generate-knowledge-cards{sessionId}` at lesson end, by voice `save_knowledge_card`, or manually. A weekly "pack opening" ritual (`/pack-opening`: "TAP AND HOLD TO OPEN", "{count} concepts unlocked") reveals the week's cards.
- **Learner memory** [O] @2834275: `learner_memory_items` (status `active`, ordered by `confidence`), `learner_memory_snapshots`, `learner_memory_state{memory_enabled, memory_consent_shown_at}`, `user_facts`, and Teacher-specific `teacher_memory` "lines" (editable/deletable via `teacher-chat` actions). Extraction runs through `extract-learner-memory`; management through `manage-learner-memory{delete_item|update_item_summary|forget_me}`. A `noMemory` flag on chat/voice requests gives incognito sessions. Memory features are gated to pro/max/developer tiers (@2834000 `Ao==="pro"||Ao==="max"||Ao==="developer"`). Optional Gmail context (`gmail-connection`/`gmail-context` with `search`/`summarize`).

---

## 6. Model names in the client

| Where | Models | Tag |
|---|---|---|
| Teacher picker (user-facing) | `claude-sonnet` (default), `claude-opus`, `gpt-sol`, `gpt-luna`; effort low/medium/high | [O] @1693796 |
| Canvas chat picker | `gemini-flash` ("Fast", default), `gpt-luna` ("Think harder") | [O] CanvasEntryPage @6858 |
| Voice | `gemini-3.8-live`, `gpt-live-1` (WebRTC), `gpt-realtime-2.1` | [O] @4794700, LessonVoiceTutor @28291 |
| Admin model benchmark (`/dev/model-benchmark`, tasks lesson-pages / practices / knowledge-cards / svg / lesson-pages-e2e) | `google/gemini-3-flash-preview`, `google/gemini-3.5-flash-lite`, `google/gemini-3.6-flash`, `google/gemini-3.7-flash`, `google/gemini-3.1-pro-preview` (Vertex), `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5` (OpenRouter), `anthropic:claude-fable-5` (direct), `openai:gpt-5.6`, `openai:gpt-5.6-sol`, `openai:gpt-5.6-terra`, `openai:gpt-5.6-luna` | [O] ModelBenchmarkPage @1832 |
| Static benchmark output chunks | `claude-fable-5-*`, `claude-opus-5-*`, `gemini-3-1-pro-*`, `gemini-3-6-flash-*` (≈95 chunks) | [O] chunk names |
| Generation profile | `LESSON_GENERATION_PROFILE="quality"` (deep research `generationModelProfile`) | [O] @4613889 |
| Avatar images | `DEFAULT_AVATAR_IMAGE_MODEL` (value not resolved) | [U] |

[I] `gpt-sol`/`gpt-luna`/`claude-sonnet` are server-side **aliases** resolved to provider model IDs. Providers are Vertex (Gemini), OpenRouter or direct Anthropic, and direct OpenAI. Which model powers lesson generation in production is **[U]**; it is only benchmarked client-side.

---

## 7. Gamification and growth

- **XP** [O] @4654519: `xp_events{xp_delta, project_id}`, RPC `sync_session_xp_awards{p_session_id,p_user_timezone}` → `{sessionXp, newlyAwardedXp, dailyXp, lifetimeXp, awards[{eventType,xp,awardKey}]}`, plus `claim_unclaimed_xp`. The XP rules are server-side **[U]**.
- **Streaks** [O] @2670691: `STREAK_MILESTONE_INTERVAL=5`, `STREAK_FREEZE_BONUS=2`, `STREAK_FREEZE_CAP=10` (freezes are earned at milestones, inferred). Activity is counted per lesson, read, assessment, video and podcast (`STREAK_COUNTED_*_IDS_METADATA_KEY`) in `user_daily_activities` with local-date strings (`toLocaleDateString("en-CA",{timeZone})`). iOS Live Activity streak widget (`streak_live_activity`, `register_live_activity_token`). Daily goal options 5/10/15/20 min.
- **Friend streaks** [O] @1701095: `friend-streaks` function (invite/accept/decline/cancel/leave/nudge/list/friends) and the `friend_streaks` table. Celebration states include `first-to-finish`, `some-completed`, `all-completed` (DevStreakCelebrationPage). Social layer: follows, usernames, public profiles `/u/:username`, follow requests.
- **Referral** [O]: `ensure_referral_code` RPC, `referrals` table, `/g/:code`, `check-referral`. Copy: "Share your code to let your friends get instant access" (beta access gate, `beta_access_gate_disabled` in `app_config`).
- **Tiers and limits** [O] @1557514 `DEFAULT_TIER_USAGE_LIMITS` (server can override via `app_config.tier_limits`):
  - free: chat 10, live_chat 1, lesson 5, lesson_generation 5, course 3, course_creation_chat 30, image_generation 5, podcast_generation 3, lesson_video_generation 2, pdf_parse 5
  - pro: 150 / 15 / 150 / 100 / 15 / 100 / 100 / 30 / 10 / 50
  - max: 750 / 45 / 750 / 500 / 45 / 500 / 500 / 90 / 30 / 250 (`max_tier_rollout` flag)
  - `get_usage_limit_status` → `{allowed, current_count, limit, period_start}` (`parseUsageLimitStatus` @1558468). Live chat is a **monthly** quota (`MONTHLY_LIVE_CHAT_QUOTA_CONTRACT_VERSION=2`), and course creation is monthly too ("Monthly course creation limit reached"). Others are daily [I]. Paywall via RevenueCat plus `resolve-upgrade-checkout`, `is_founding_member`, and `OnboardingPaywallScreen`.
- **PostHog flag keys** [O] (constants): `teacher_tab_rollout`, `realtime_voice_chat_rollout`, `gpt_live_voice_api_rollout`, `max_tier_rollout`, `lesson_video_rollout`, `learning_calendar_rollout`, `library_course_shared_import`, `shared_import_format_choice_rollout`, `daily_digest_cta`, `daily_digest_layout`, `course_creation_pinned_topic_rollout`, `intro_lesson_difficulty_feedback_rollout`, `lesson_figures_rollout`, `deep-research-course`, `course_creation_chat_router`, `curated_first_course_onboarding`, `generation_notification_prompt`, `generation_progress_screen`, `interactive_podcast_rollout`, `lesson_podcast_companion_rollout`, `language_courses_preview`, `later_course_format_choice`, `learn_ai_concrete_generation`, `learning_situation_flow`, `lesson_chat_follow_up_questions`, `lesson_pre_question`, `lesson_pre_question_optional_ux`, `library-browse-rollout`, `onboarding_early_thanks`, `onboarding_fast_first_lesson`, `reminder_lesson_direct_start`, `streak_live_activity`, `ai_plan_app_handoff_screen`, `ai_plan_post_auth_outcome_preview`, `ai-foundations-landing-design-and-hero`. A React-visualization A/B test logs `$feature_flag_called` exposures on first view of a generated lesson (reactVisualizationExperiment chunk). Hard-coded toggles (@1694650): `ENABLED_MAGIC_NOTES`, `ENABLED_DIVE_DEEPER`, `ENABLED_APPLIED_LESSONS`, `ENABLED_CHECK_UNDERSTANDING`, `ENABLED_NEW_PRACTICE_TYPES=false`. `app_config` keys: `tier_limits`, `new_practice_types_enabled`, `course_sharing_enabled`, `social_features_enabled`, `app_announcement`, `beta_access_waitlist_text`, `home_path_free_jump_enabled`.
- **Other growth surfaces** [O]: lesson videos (`LESSON_VIDEO_STYLES` = editorial, wondering, collage (default), chalk, papercraft, aurora, clay, tornpaper, essay, plain, brutalist; slideshow scenes title/concept/bullets/example/recap/checkpoint), podcasts, weekly report, daily AI digest, public course library/SEO pages, creator links with attribution `/go/:source/:creatorId/:creativeId`, AppsFlyer milestones, admin growth dashboards (north-star, D1 funnel, MRR plan, LLM latency).

---

## 8. Design system

- **Tailwind CSS** [O]: utility classes everywhere, and `tailwind-merge` is bundled (`cn$1`, class-group table at @1607163). `cva` (class-variance-authority) and `@tailwindcss/typography` `prose-*` classes are used in the markdown renderer (@4105554). [I] Tailwind v4: CSS custom properties `--color-*` with **semantic tokens** such as `bg-surface`, `bg-surface-secondary|card|hover`, `text-text-primary|secondary|tertiary|inverse`, `border-border`, `bg-brand`, `bg-brand-bg`, `text-brand-text`, `bg-success-bg`, `text-error-text`, `bg-info-bg`, `bg-visual-artboard`, `bg-interactive-canvas`, plus 3D "block" button tokens (`--color-block-primary-shadow-deep`, `--color-button-tertiary-shadow-active`, seen in the page capture). Bidi/RTL uses logical classes (`ps-`, `border-s`) and a `content-rtl:` variant polyfill (`useLegacyBidiVariants`).
- **Fonts** [O] (network capture in `wondering-inspect.json`): Inter (`inter-latin-standard-normal`), Public Sans (variable weight), Share Tech Mono. The CSS bundle `index-BmaKRmlX.css` was **not** downloaded (outside the JS-only scope), so the font-to-role mapping is **[U]**.
- **Theming** [O] @6528891: light, dark and system preferences, persisted per user with pending/ack sync keys.
- **Motion** [O]: Framer Motion / `motion` (spring transitions, `AnimatePresence`, drag carousels in the Live Tutor onboarding), Lottie (`ColoredLottieAnimation`; character animations Clapping, Handstand, Like, Salute), Rive (`@rive-app/webgl2` 2.35.0), CSS keyframes (`pack-charging`, `pack-tear-left/right`), `motion-reduce:` variants, and haptics through Capacitor (`triggerLightHaptic`, `ImpactStyle`).
- **Components** [O]: Radix-style primitives (Select Root/Trigger/Value/Portal/Viewport/Item exports at the bundle tail), sonner toasts, lucide icons, React Flow for canvas/mind-map/tutor board, d3 for the `*-d3` visualizations, KaTeX.

---

## 9. What I could not determine (explicit unknowns)

1. All **system prompts, tool JSON schemas** given to LLMs (Teacher tools, voice tools, lesson-generation prompts). These are server-side, and the Gemini config is baked into the ephemeral token. The client only shows tool *names*, argument names it validates, and result shapes.
2. Which production model runs lesson/practice generation, and how the aliases `gpt-sol`, `gpt-luna`, `claude-sonnet`, `gemini-flash` resolve.
3. Server-side VAD/turn-detection parameters, voice selection and the Gemini `liveConnectConstraints`.
4. The exact SSE payload *producer* logic (how `embed_progress` is computed, the visual-selection heuristics) and the `quick_replies` element shape beyond `{text, action?}`.
5. XP award amounts and rules, streak-freeze consumption rules, and the referral reward.
6. The CSS file (fonts→roles, token values) and most of the 448 lazy chunks. Only 115 relevant ones were fetched. The admin pages, `TutorCanvas` and `PracticeSessionPage` internals were only skimmed.
7. RLS policies and whether `createCourseWithLessons` (client-side inserts) is mirrored or validated server-side.

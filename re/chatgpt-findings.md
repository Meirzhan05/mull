# ChatGPT web client (logged-out "unauth-mweb" build): intelligent / generative UI, reverse engineered

Static analysis of publicly served JS only. Nothing was executed, no login, no backend calls.
Two coordinator-approved logged-out turns were captured live by the coordinator; I did not send any requests to chatgpt.com APIs.

**Evidence roots** (all paths relative to `re/`):

| Tag | Location | What it is |
|---|---|---|
| **[H]** | `chatgpt-scripts/files/origins/516c22c5…/unauth-mweb/assets/` | 239 home-page scripts (REA ev_25e303e1…) |
| **[T]** | `chatgpt-turn-scripts/files/origins/516c22c5…/unauth-mweb/assets/` | 327 scripts loaded during the turns (REA ev_6aa689db…) |
| **[TS]** | `chatgpt-turn-scripts/files/origins/516c22c5…/unauth-mweb/scripts/` | classic scripts (`declarative-partial-updates-cc0dc41806f1.js`, …) |
| **[SKY]** | `chatgpt-turn-scripts/files/origins/3c5810e1…/assets/` | 28 scripts from `https://skybridge.oaistatic.com/assets/` |
| **[DOM]** | `chatgpt-learn-assistant-turn.html` | rendered assistant turn for the "Pythagorean theorem + quiz" prompt |
| **[REQ]** | `chatgpt-live1/request-{219,286,393}-*.txt` | redacted request and response bodies |

**Tags used on claims:**
- **O** (Observed): a snippet at file@byte-offset. Offsets are byte offsets into the file and come from a Python scan, equivalent to `grep -bo`.
- **I** (Inferred).
- **U** (Unknown).

**Download attempt.** Downloading extra lazy chunks failed. `curl https://chatgpt.com/unauth-mweb/assets/*.js` returns **HTTP 403 with a bot-challenge HTML page**, even for files that were already captured. `cdn.oaistatic.com/assets/<name>` returns 404. I did not try to get around the challenge, so `re/chatgpt-lazy/` was not created. Everything below comes from the captured [H], [T] and [SKY] files only.

---

## 0. TL;DR

1. **This is not the React ChatGPT app.** The logged-out web client is a new stack called "lightweight-web" / "web-mobile":
   - The UI framework is **Octane**, a custom signals-based compiled framework. Its RPC path is literally `/_$_ripple_rpc_$_/` and its Symbol namespace is `octane.*`.
   - Routing uses **TanStack Router** (`__TSR_key`).
   - Styling uses **StyleX** atomic classes (`$$css:!0`).
   - Bundling uses **Rolldown / Vite**.
   - The front end is a **Cloudflare-Workers** BFF under `/unauth-mweb/*`.
2. **Sending a message** is a form-encoded `POST /unauth-mweb/conversation/updates?…&operationId=<uuid>` with `Accept: application/vnd.openai.conversation-source+ndjson`. The response is **NDJSON "conversation-source" records**, not the backend's SSE: `content | control | reasoning | state | diagnostic | shared | media | end | paragen | primary-complete`.
   - `content` carries **raw markdown with append/replace revisions**, plus `references` (content_references) and an optional **`dil`** program.
   - The legacy backend SSE "v1" delta protocol (`c/p/o/v` with ops add/replace/remove/append/patch/truncate) still exists in the client. It is used for `POST /backend-anon/sidebar/conversation` (entity resolution).
3. **DIL is the generative-UI system.** The acronym is never expanded in the code (**U**); the abbreviation alone is used throughout. The model or server sends a DIL program (`dil.kind:"dil"`, `renderer:"dil-v2"`, `code`, `constants`, `appData`, `requiredComponents`, …). The program is plain JS that calls `__dil.jsx(...)`.
   - It runs inside a **locked-down Web Worker sandbox** via `Function("DIL","__dil","GenUI","Date", code)`.
   - It uses a React-like hooks API (`DIL.useState/useEffect/useMemo/useAppData/useBreakpoint…`).
   - Render output is streamed to the main thread as a **binary op buffer**: create, text, destroy, move, prop, opaque children.
   - The main thread maps it onto ~55 host primitives (`box/row/col/text/title/pressable/button/image/math/list/carousel/chart/…`). These are rendered as Octane components with `data-d-component=…` attributes.
   - On top sit **~287 lazy "catalog" widgets** (WeatherWidget, StockChart, LearningQuiz, NbaScores, 60 medical calculators, Ledger finance widgets, …) and 30 always-available components (Citation, Entity, ProductCard, FollowUp, WritingBlock, …).
   - The internal module paths show the DIL renderer is built on **Valdi** (`valdi_core/…`, `web_renderer/src/ValdiWebWorker`, `Symbol("openai.valdi.dil.runtimeElement")`).
4. **Widget actions** go through a `GenUI` facade:
   - Client actions (`open_url`, `issue_new_turn`, `open_entity_detail`, `copy`, `share`, `prefill_composer`, `start_voice_mode`, …) are handled locally.
   - Server actions go to **`POST /backend-api/widget_server_action`** with `{action_type, conversation_id, message_id, native_widget_resolution_id, payload}`.
   - Mid-turn **steering** is `POST /backend-api/f/steer_turn` for thinking/pro async tasks.
5. **The sandboxed "Interactive content" iframe** loads **Skybridge**, OpenAI's widget host on `skybridge.oaistatic.com`. In this capture it loaded `/math-block.html`, the interactive math visualization for learning blocks.
   - The bridge is a base64-JSON-RPC protocol over postMessage (`ready`, `setIntrinsicHeight`, `loadingFinished`, …).
   - Skybridge itself exposes the Apps-SDK-style host methods (`callTool`, `setWidgetState`, `sendFollowupMessage`, `requestModal`, `updateModelContext`, `requestCheckout`, …) on web, iOS and Android.
   - The skybridge app uses **React 19.3.0-canary**.
6. **Server-rendered HTML** still matters. History, saved conversations and "canonical DIL" islands (for example the weather card) arrive as HTML using **Declarative Partial Updates**: `<?start name=…>…<?end>` processing-instruction markers patched by `<template for=…>`. The client feature-detects native support and otherwise uses a polyfill.

---

## 1. Conversation streaming protocol

### 1.1 Endpoints (O)

All BFF routes are built by `Te=e=>\`/unauth-mweb${e}\`` (octane-shell-shared-8u7kWW5N.js@13394, [H]). The route table is in `a-E6dMPOCT.js` [H], 2,281 bytes:

```
conversation:e(`/conversation`), conversationManagement:e(`/conversation/manage`), conversationRecovery:e(`/conversation/recover`),
conversationResume:e(`/conversation/resume`), conversationRuntime:e(`/conversation/runtime`), conversationUpgrade:e(`/conversation/upgrade`),
conversationUpdates:e(`/conversation/updates`), entityDetail:e(`/entity-detail`), productDetail:e(`/product-detail`),
sentinelChatRequirementsPrepare:e(`/sentinel/chat-requirements/prepare`), sentinelChatRequirementsFinalize:e(`/sentinel/chat-requirements/finalize`),
dismissAskUserLocation:e(`/widget/ask-user-location/dismiss`), imageSuggestions:e(`/image-suggestions`), learningBlockFeedback:e(`/conversation/message/learning-blocks/feedback`),
stopConversation:e(`/stop_conversation`), shareMessage:e(`/share/message`), …
```

**Turn sequence** (O from [REQ] plus code; I for the ordering):

1. `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0`
   - Body (form-encoded): `conversationRetryOwner`, `conversationState`, `clientContextualInfo`, `timezone`, `timezoneOffsetMinutes`.
   - Returns `{"conduit_token":"…","prepare_cadence_enabled":true}` ([REQ] 219/393).
   - Client check: `conversation-prepare-client-BbHRmW8g.js@3988` [H] throws `"Conversation prepare response omitted its conduit token"`.
   - Prepare request headers: `X-Web-Mobile-Conversation-Renderer: octane`, `X-Web-Mobile-Conversation-Source: 2`, `x-oai-turn-trace-id`, `x-web-mobile-prepare-state`, `x-web-mobile-prepare-reason`, `x-conduit-token` (@3360).
2. Sentinel: `/unauth-mweb/sentinel/chat-requirements/{prepare,finalize}` and `/backend-api/sentinel/req`. See §1.6.
3. **`POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>`** with an `application/x-www-form-urlencoded` body. [REQ] 286 fields:
   - `conversationState` is JSON: `{"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}`. Later turns carry `backendConversationId`.
   - `prompt`
   - `messageMetadata`, `oai-session-id`, `imageAttachments`, `pendingImageUploads`, `clientContextualInfo` (JSON: page/screen size, dark mode, push permission, time_since_loaded), `imageSaveData`, `imageEffectiveType`, `timezone`, `timezoneOffsetMinutes`, `conversationRetryOwner`
   - `workOrigin`, `workModel`, `workEffort`, `workTier`
   - `assistantMessageId: "pending-<uuid>"`, `userMessageId`
   - `chatRequirementsToken`, `proofToken`, `turnstileToken`, `telemetryToken`, `timingToken`
   - The fields mirror hidden inputs in the composer `<form method=post action=/unauth-mweb/conversation>` template (application-presentation-runtime-DLp5p8I8.js@356345 [H]: `<input name="messageMetadata" type="hidden"/><input name="oai-session-id" …/><input name="imageAttachments" …/><input name="pendingImageUploads" …/>`). This is progressive enhancement: the composer is a real HTML form, and JS intercepts the submit (I, strong).
   - Request headers (`conversation-followup-client-BAm3j6mp.js@19500` [T]):
     ```
     headers:{Accept:`application/vnd.openai.conversation-source+ndjson`,"X-Web-Mobile-Conversation-Source":`2`, …"X-Web-Mobile-Requirements-Recovery":`1` (auth only),
       …"x-conduit-token":x.token, "x-oai-turn-trace-id":x.turnTraceId, "x-web-mobile-prepare-state":x.state, …}
     ```
   - Response validation (@21642): content-type must equal `application/vnd.openai.conversation-source+ndjson`, otherwise `client_response_content_type_invalid`.
4. **Stop:** `POST /unauth-mweb/stop_conversation` with `{conversationId}` and `x-conduit-token` (`conversation-followup-client…@13821` [T]).
5. **Resume and recovery:** `/conversation/resume`, `/conversation/recover`, and `resumeToken` on terminal controls. The resume record is stored under `` `oai/conversation-resume.v1:${e}:${s}` `` (a-BqfBMjqW.js@134 [H]) (O). The exact resume request shape is U.
6. The **legacy `action:"next"` body** survives only in steering (§1.5) (O). The backend `/backend-anon/conversation` call is made by the Worker, not the browser (I). No client code builds `messages[]` for a normal send.

### 1.2 NDJSON "conversation-source" record schema (O, `conversation-source-client-BEhTNMUS.js` [T], 4,191 bytes, offset 0)

Parser rules:
- Split on `\n`.
- Records may be at most 6,291,456 bytes (6 MiB): `"Conversation source record exceeds its limit"`.
- `version` must be 1 or 2: `"Unsupported application/vnd.openai.conversation-source+ndjson version"`.
- `type` must be one of `["content","control","reasoning","state","diagnostic","shared","media","end","paragen","primary-complete"]`.
- Nothing may follow `end`, and the stream must end with `end`: `"Conversation source ended before its terminal record"`.

Record types:

| type | Fields (validated in client, or applied in `conversation-source-turn-CTq9BuGc.js` [T]) |
|---|---|
| `content` | `messageId`, `revision` (strictly increasing), `mode:"append"` with `baseRevision`, otherwise a full replace. Also `markdown`, `references[]`, `codeBlocks`, **`dil`**, `imageGenDelayed`, `debug`, `dynamicFeedback`, `conversationFollowupSuggestionsEligible`, `followupPrompts[]`, `approvedUrls`, `canonicalApprovedUrls[]` (≤64), `deniedUrls`, `publicShareId`, `streamingParent`, `status: streaming \| complete \| retracted`. Append rule: `markdown:m.mode===\`append\`?n.markdown+m.markdown:m.markdown` (turn @~9800). A mismatch throws `"Conversation source revision mismatch"`. |
| `control` | `detail:{kind, operationId, …}`, re-dispatched as `CustomEvent("web-mobile-conversation-control")`. Kinds: `response-started, assistant-content-started, conversation-id, steering-capability, steering-message, steering-status, message-stream-complete, terminal-received, complete, failed, stopped, background-*, background-safety-update (safetyPatch), requirements-refresh-required, stop-settled`. |
| `reasoning` | `status` (ReasoningStatus InProgress=0 / Complete=1), `activity` (records `{sourceId, kind: activity\|recap, text, items, toolIcons, recapType: collapse\|hide_all\|keep_inline}`), `variantId` (v2, comparisons). Enums are in module `oai_reasoning_api/src/ReasoningTypes` (a-BKk_AOY6.js [H]). |
| `state` | `conversationState`, committed as the continuation state for the next turn. |
| `diagnostic` | `{kind, payload}`, telemetry only. |
| `media` | `operationId`, `messageId`, `replacesMessageId?`, `revision`, `status: streaming\|complete\|retracted`, `html`. The HTML is a set of `<template for="<range>">` patches plus optional `<template for="conversation-partial-control">` (turn @1000–2600). |
| `paragen` / `primary-complete` | user-signal facts for paired generations (v2 needs `comparison` / `completion`). |
| `shared` | U. Validated as a known type only. |
| `end` | terminal record. |

The full **content source validator** is `a-BKk_AOY6.js@~5000` [H]. Allowed keys: `messageId, revision, markdown, references, codeBlocks, dil, approvedUrls, canonicalApprovedUrls, deniedUrls, status, savedActivity, origin, publicShareId, debug, dynamicFeedback, conversationFollowupSuggestionsEligible, followupPrompts`.

```
e.dil!=null&&(…e.dil.kind!==`dil`||e.dil.renderer!==`dil-v2`||e.dil.status!==`pending`||typeof e.dil.code!=`string`||…
 !Object.keys(e.dil).every(e=>[`kind`,`renderer`,`status`,`code`,`constants`,`appData`,`requiredComponents`,`clientDefinedWidgets`,`fallbackMarkdown`,`viewState`,`viewStateSync`].includes(e))
```

A DIL payload is capped at 262,144 bytes. Each `references[]` item allows these keys:

```
alt.appearance.approvedUrls.chatgptSdk.data.deniedUrls.dil.dilUrl.dilVersion.endIndex.fallbackMarkdown.fallbackText.isHidden.locale.messageId.
modelDil.modelDilV2.name.ownsMessageBody.photoUploadPresentation.preview.sourceIndex.startIndex.type.viewState.viewStateSync.viewportWidth.widgetRefId.widgetState.writingCitations
```

`startIndex`/`endIndex` index into `markdown`, with -1 meaning unanchored. `type` matches `/^[a-z][a-z0-9_]{0,95}$/i`. Writing citations use refIds matching `^turn\d+search\d+$`.

**Client-side coalescing** (O, a-CXjz5MFZ.js [T]): `update(e){… "streaming"!==e.status… ? f() : r??=requestAnimationFrame(f)}`. Streaming content is applied at most once per animation frame. If `dil.status==="failed"`, the client renders `dil.fallbackMarkdown`.

### 1.3 Legacy backend SSE "v1" delta encoding (still in client) (O, `a-wDQxv8En.js` [T], 4,401 bytes)

- **SSE parser:** splits events on blank lines, reads the `event:`, `id:` and `data:` fields, and caps an event at 5 MiB.
- **Delta decoder:** `i=[["channel","c"],["path","p"],["op","o"],["value","v"]]`. Missing keys inherit from the previous delta, so a bare `{"v":"…"}` appends to the same path.
- **Ops:** `add | replace | remove | append | patch (array of nested deltas) | truncate`.
- **Paths** are JSON-Pointer with `~1` and `~0` escapes.
- **Used by** `canonical-dil-entity-actions-D7YVP3Ar.js` [T]:
  ```
  fetch("/backend-anon/sidebar/conversation",{Accept:"text/event-stream",…})   // or /backend-api/sidebar/conversation when authenticated
  if("delta_encoding"===e.event){if("v1"!==a)throw …; r=new u} … if("delta"===e.event) n=r.applyDelta(a) … "[DONE]"
  … o.metadata.content_references … e.type===("product"===t?"product_entity":"entity")
  ```
- **Body:** `{category:"reference_entity",cache_only:!0,conversation_id,message_id,locale,supported_encodings:["v1"],reference_entity_params:{category,ref_id,…}}`.
- **I:** the Worker consumes the same v1 SSE from the backend for the main conversation and re-encodes it as conversation-source NDJSON.

### 1.4 Older HTML control channel (O, `conversation-control-fHYwlwBe.js` [H], 25,728 bytes)

When a turn is delivered as streamed HTML (saved, history and "octane presentation" paths), controls are DOM elements `[data-conversation-control="<kind>"]`. The client consumes and removes them. Kinds seen in `z=async(e,i,o)=>…` @~2600–12000:

`assistant-styles, cookie, show-auth, streaming-parent, steering-capability, steering-message, steering-status, user-message-update, assistant-message-boundary, interactive-request, async-status, paused, message-intervention, background-message-update, assistant-ads, assistant-content-started, background-safety, assistant-end-turn-rendered, message-stream-complete, conversation-id, terminal-received, complete, failed`

Data travels in `data-*` attributes such as `data-message-patch`, `data-conversation-state`, `data-resume-token`, `data-failure-status`, `data-requirements-recovery`, `data-canonical-path`.

A 403 with no first content and `data-requirements-recovery="automatic"` produces `requirements-refresh-required`. The client then re-runs the Sentinel requirements step and retries (O @~9900).

### 1.5 `steer_turn`: mid-turn steering (O, `conversation-followup-dom-controller-Car3lreL.js@4781–5600` [H])

```
let p={action:`next`,conversation_id:a.conversationId,parent_message_id:a.messageId,model:a.steering.model,async_task_id:a.steering.asyncTaskId,
  history_and_training_disabled:e.temporaryChat(),messages:[{id:u,author:{role:`user`},content:{content_type:`text`,parts:[r]},create_time:Date.now()/1e3,metadata:{}}]};
… let t=new Headers({"x-oai-turn-trace-id":l()}); for(let[n,r]of Object.entries(A)) … t.set(r,i)  // sentinel headers
… await tt.post(`/f/steer_turn`,{body:p,headers:t,…})
```

- `tt` is `backendApi` from `backend-api-om3op_pf.js` [H]. It prefixes **`/backend-api`** and uses the *authenticated* fetch, so the endpoint is `/backend-api/f/steer_turn` (O). Logged-out users therefore never steer (I).
- **Capability** comes from a `steering-capability` control: `{asyncTaskId:"thinking"|"pro", model, turnId?}` (`conversation-control…@~3000`).
- **Acceptance** arrives as `steering-message` (user message patch) and `steering-status: accepted|rejected`.
- **UI strings:** `lightweight-web.conversation.steering-pending|rejected|uncertain`.

### 1.6 Sentinel, proof-of-work and Turnstile (described only; not exercised)

- **Header map** (O, `a-Dgt8AZqD.js` [H], whole file):
  ```
  {chatRequirementsToken:`OpenAI-Sentinel-Chat-Requirements-Token`, chatRequirementsPrepareToken:`OpenAI-Sentinel-Chat-Requirements-Prepare-Token`,
   proofToken:`OpenAI-Sentinel-Proof-Token`, turnstileToken:`OpenAI-Sentinel-Turnstile-Token`, sessionObserverToken:`OpenAI-Sentinel-SO-Token`,
   telemetryToken:`OAI-Echo-Logs`, timingToken:`OAI-Telemetry`}
  ```
- **Where the tokens go:** for `/conversation/updates` they are sent as form fields. For `/backend-api/*` calls (steer, sidebar) they are sent as headers.
- **Requirements flow** (O, `sentinel-Y_KwwhM3.js@2789` [H]): requirements are fetched, then the Turnstile token comes from a lazy `turnstile-CxMnrxPE.js` when `requirements.turnstile.required || .dx`, and a proof token comes from the Sentinel SDK `B.getEnforcementToken(...)`.
- **SDK delivery:** the [T] capture contains `backend-api/sentinel/sdk.js`, and the DOM loads a hidden `https://chatgpt.com/backend-api/sentinel/frame.html?sv=…` iframe.
- **Force-login:** failures can raise `web-mobile-sentinel-force-login`.
- **Session proof:** `X-OAI-Lightweight-Session-Proof(-Expires)` and `X-OAI-IS*` exist for authenticated sessions (authenticated-browser-client-Br8MoFAj.js@15328 [H]).

---

## 2. Message content model

- **Legacy backend content_types** referenced client-side (O): `text`, `multimodal_text` with `image_asset_pointer` parts (`file-service://`) (replay-CrsIeXBc.js@5369 [H]), `code`, `execution_output` (a-DRYyzj_W.js@22000 [T], a code-execution renderer that reads `metadata.aggregate_result`), and `thoughts`.
- **The browser mostly never sees backend `content_type`.** The Worker flattens messages into `markdown + references + dil` (I, strong).
- **Roles** seen: `user`, `assistant`. Tool, system and critic roles are not surfaced (O, by absence).
- **content_reference `type` values** handled by the reference mapper `a-DRYyzj_W.js` [T], 46 KB (O, from type comparisons and literals):
  - `client_defined_widget` with `data.category ∈ {learning_block, language_learning_block, writing_block, ledger_monetary_value, …}`
  - entity and product: `entity, entity_metadata, product, product_entity`
  - maps and places: `map, businesses_map, location_search`
  - `checkout_confirmation, code_execution, writing, alt_text, attribution, mcp_source, followup_memory_a, strix`
  - grouped results: `grouped_webpages_v2, grouped_webpages_model_predicted_fallback, image_v2, image_group, nav_list, file_navlist, product_group, product_reviews`
  - `sources_footnote, sports_schedule, sports_standings, translation_block, pronunciation_block, inline_pronunciation, upload_action, photo_upload_action, local_business, entity_explorer, optimistic_image_citation/inline, conversation_context_citation, title_citation, agent_citation, dil`
- **Presentation kinds** the mapper produces (O, `kind:"…"` literals):
  `agent-citation, app, calculator, card, chart, checkout-confirmation, code, code-execution, dil, entities, entity-explorer, file, files, followup, forecast, image-picker, images, inline, inline-image, learning, links, map, monetary-value, output, private-file, products, pronunciation, questions, raw, result, schedule, standings, stock, text, time, translation, upload-action, url, user-input, video, webpages, writing`.
  Example: the `case"forecast"` branch builds `{kind:"forecast",layout:"block",location,current,days,hourly,alerts}`.
- **Unsupported references.** Any reference that isn't rendered is reported as a `content_references` diagnostic with reason `unsupported_widget` for `client_defined_widget` or `dil`, and `unsupported_content` otherwise (a-CXjz5MFZ.js [T]).
- **Follow-ups:** `followupPrompts[]` and `conversationFollowupSuggestionsEligible` on `content`, plus DIL components `FollowUp*` and `ConversationFollowUpActionList`. Follow-up clicks carry `message_metadata.followups_v2_followup_clicked/source` (a-DoEDC6Ag.js [T]).

---

## 3. Intelligent / generative UI

### 3.1 DIL architecture (O unless noted)

**What DIL means: U.** No expansion appears anywhere. The identifiers used are `DIL`, `__dil`, `dil-v2`, `DILRenderer`, `OpGenuiResolvedComponentBoundary`, `appData.opGenui`. "GenUI" is the action facade.

**Module map** (from embedded `t.path=` strings in `conversation-source-dil-DB4YSeou.js` [T], 1.50 MB, and `conversation-source-dil.worker-zN5D1Azr.js` [T], 487 KB):

| Package | Modules / role |
|---|---|
| `dil_renderer/src/*` | `DILRenderer, DILRenderFunctionRuntime, DILHookRuntime, DILSourceEvaluator, DILDynamicSourceEvaluator, DILStatePersistence, DILStateSnapshotCodec, DILSemanticKey, DILHtmlViewMessenger(+TransportRegistry), DILSpeechSynthesis, DILDictation, DILDeferredTurnRuntime, DILUserInteraction, DILApiFacade, DILElement` |
| `dil_sandbox/src/*` | `DILSandbox, DILSandboxWorker(+Core), DILSandboxGlobals, DILSandboxRegExp, DILSandboxIntl, DILSandboxProtocol, DILRenderOperations, DILComponentSources, DILComponentSourceLoader, DILComponentNames, DILSandboxHostActionRequests, DILSandboxWorkerTransport, DILSandboxTimeout` |
| `dil_octane_browser/src/components/*` | Browser host components written in Octane: layout `Box/Card/Grid/FlowItem`; text `Text/Badge/Markdown*/Math`; `Image`, `SearchImage`, `Favicon`, `Svg` (with streaming reveal), `Lottie`, `YouTubeEmbed`; `Carousel`, `Table`, `List`; forms `Input/Textarea/Select/Slider/SegmentedControl/RadioGroup/Checkbox/DatePicker/Form`; overlays `Popover/Tooltip/useNativePopup`; animation `Animate/Celebration/StreamingAnimation/FlashcardFlip` |
| `dil_octane_ui/*`, `dil_octane_utils/*` | tokens (`palette.stylex`, `radii.stylex`), `ElementTypes`, `DilEventStore`, `ElementRegistry`, models |
| `dil_generated_components/src/(DILPublicComponentSources.generated \| restricted/components/<Name>.generated)` | catalog widget sources |
| `valdi_core/*`, `web_renderer/src/*` | `WebRendererRoot, ValdiWebWorker, WebStyleStore, RenderedElementTree` |
| `web_octane/src/Gestures/*` | `useClick/usePan/useLongPress/…` |
| `markdown/src/*` | custom markdown parser (a-DhChyb2Q.js) |

**Valdi.** `Symbol("openai.valdi.dil.runtimeElement")` appears at conversation-source-dil@~117000. Together with the `valdi_core` and `web_renderer` paths, this shows the DIL runtime is built on Valdi, the cross-platform UI framework open-sourced by Snap, adapted by OpenAI (I, from names).

**Sandbox allowed globals** include `HermesInternal` and `HermesES6Internal` (worker@449261). The same DIL programs are evidently meant to run on mobile Hermes as well (I).

**DIL program shape** (O):
- The model or server sends `dil.code`, a JS string, and the client evaluates it:
  ```
  function r(e){return Function(`DIL`,`__dil`,`GenUI`,`Date`,`"use strict";\n${e}`)}      // worker@140 (DILDynamicSourceEvaluator)
  ```
- `requiredComponents` is resolved by scanning the code for `__dil.jsx(<Name>,`: `n.DIL_LAZY_COMPONENT_NAMES.filter(e=>s.has(e)||t.includes(\`__dil.jsx(${e},\`))` (conversation-source-dil@1429647). So the code is **already JSX-compiled** (`__dil.jsx(type, props, ...children)`; `__dil.Fragment`).
- I: the model writes JSX/TSX and the server compiles it, which matches `references[].modelDil` / `modelDilV2`.

**DIL runtime API** given to programs (`createDILRuntimeApiFacade`, worker@~409000):

```
render, useAppData, useConstants, useCallback, useEffect, useId, useDILMessenger, useHtmlViewMessenger, useMemo, useNow, useRef,
useDictation, useSpeechSynthesizer, useState(initial,{key,widgetId}), useTheme, useBreakpoint, useIsMobile
```

`Date` is replaced with a frozen-clock constructor when `fixedTimeMs` is set (`createDILDateConstructor`). Widget state is persisted through `DILStatePersistence`, a snapshot per widget id (`viewState` / `viewStateSync` in the content record).

**GenUI facade** (`createDILGenUIFacade`, worker@~1400):
- Methods: `dispatchAction(action)`, `dispatchWidgetAction({…, nativeWidgetResolutionId, componentName})`, `logEvent`, `issueNewTurn(query, opts)`, `openEntityDetail(category, query, extra)`, `openImageLightbox(images, idx)`, `openUrl(url)`, `runPluginTool(...)` (`DIL_PLUGIN_TOOL_UNCONFIRMED`), `refreshWidget`.
- Every action is `{handler:"client"|"server", type, payload, context?}`.
- **Client action types** seen (O, conversation-source-content / dil): `open_url, open_link, open_entity_detail, open_image_lightbox, open_video_lightbox, open_sources, open_file_citation, open_coding_citation, open_file_navlist_item, open_automation_goal, issue_new_turn, send_followup_message, prefill_composer, start_voice_mode, request_user_input, request_file_upload, request_media_upload, request_camera_capture, request_location_permission, launch_ecosystem_widget, share, copy, log_event, ledger_set_sensitive_values_hidden`.
- The host advertises a subset via `appData.opGenui.supportedClientActions` (conversation-source-dil@1464272).

### 3.2 Worker sandbox and render protocol (O)

- **Workers.** `configureDilWorker(()=>new Worker(new URL(… "/unauth-mweb/assets/conversation-source-dil.worker-zN5D1Azr.js"), {type:"module"}))` (dil@1459510). A second `eval.worker-DA7i4dNx.js` serves as a default worker (dil@1429647).
- **Global lockdown** (`DILSandboxGlobals`, worker@449261): the client deletes every global not on an allow-list of ES built-ins, `TextEncoder`, `onmessage` and DIL component names, then freezes the rest. `RegExp` and `Intl` are wrapped.
- **Main → worker:** `render({source, sourceGeneration, appData, animated})`, `setStateSnapshot`, `invokeFunction(fnId, args, interactionId, completionId)` (callbacks such as `onClick` are proxied by id), and `commit(renderSequence)`.
- **Worker → main:** batches of render operations encoded into a little-endian `Uint32`/`Float64` buffer by `DILRenderBufferDelegate` (worker@451567):
  ```
  1 createElement(nodeId,typeIdx) | 2 createText(nodeId,strIdx) | 3 destroy(nodeId) | 4 move(nodeId,parentId,index)
  5 propChanged(nodeId,nameIdx,value) | 6 textChanged(nodeId,strIdx) | 7 opaqueChildrenChanged(nodeId,value)
  value tags: 0 undef,1 null,2 false,3 true,4 f64,5 string(idx),6 array(len),7 object(n keys),8 function(id),10 element/fragment,11 attached opaque,12 HtmlViewMessenger channel
  ```
  Strings are de-duplicated into `attachedValues`.
- **Other message kinds:** 4 host action, 8 init, 11 speech command, 12 dictation, 14 function completion.
- **Server-bound actions** are recognised by `isDILSandboxBoundServerAction`: `handler==="server"` and both `nativeWidgetResolutionId` and `componentName` are present.

### 3.3 Host element catalog: the `data-d-component` primitives (O)

`dil_octane_utils/src/core/ElementTypes` (conversation-source-dil@~114845):

```
elementTypes=[flashcard-flip, animate, animate-item, lottie, celebration, tooltip, chart, pie-chart, carousel, carousel-item, button, badge, checkbox,
 radio-group, radio, form, list, list-item, loading, pulse-indicator, icon, svg, image, popover, popover-trigger, popover-content, search-image, favicon,
 pressable, link, date-picker, select, input, slider, segmented-control, table, table-section, table-row, table-cell, textarea, blockquote, math,
 markdown, text-only-markdown, title, row, card, flow-item, loading-block, grid, divider, youtube, …aliases, __dil-rendered-prop]
rendererAliases: animate-group/transition→animate, carousel-media-item→carousel-item, loading-indicator→icon,
 text|caption|label|bold|italic|underline|strikethrough|code|shimmer-text→title, col|box|grid-item→row, flow→grid, spacer→divider
```

This explains the [DOM] attributes. The DIL element name is emitted verbatim as `data-d-component="box|col|text|…"`, but the renderer for `box`/`col` is `row` and for `text` is `title`. Counts in the learn turn: text 48, box 26, title 13, math 13, list-item 11, row 10, pressable 10, col 9, text-only-markdown 5, icon 5, list 4, divider 2, spacer, loading-block, image, celebration, button.

Other `data-d-*` attributes the renderer writes (O, literal list): `data-d-direction, -inline, -marker(bullet|number), -marker-layout, -frame, -block, -flush, -compact, -snap, -layout, -auto-spacing, -custom-spacing, -column-sizing, -image-(loading|fallback|crop|secondary), -progressive(-settled|-full), -hoverable, -click-through, -tooltip, -highlight, -connector, -aspect-mode, -input-container, -animation, -streaming-word`.

**Approximate props per primitive**, scraped from `__dil.jsx("type",{…})` calls in the generated component sources (O; this includes some nested keys):

| Primitive | Props |
|---|---|
| box / row / col | `direction, wrap, align, justify, gap, rowGap, columnGap, padding{x,y,top,left,…}, width/height/min*/max*, flex, flexInRow, aspectRatio, background, border{size,color}, radius, clip, scrollable, role, ariaLabel/ariaHidden/ariaLive/ariaAtomic, onVisible…` |
| text | `size, weight, color, strong, underline, lineThrough, textAlign, maxLines, truncate, tabularNums, preserveWhitespace, inline, lineHeight, fontSize` |
| title | `size, weight, color, maxLines, textAlign` |
| pressable | `variant(ghost…), hoverBackground, radius, size, padding, disabled, dimWhenDisabled, ariaPressed, tooltip, onClick, onHover, insetBorder, focusStyle, loadingBehavior` |
| button | `label, variant, size, pill, block, uniform, disabled, onClick` (or a declarative `handler/type/payload/query` action) |
| icon | `name, size, color, weight, light/dark` |
| image | `src, alt, fit, frame, radius, width/height, fallback, hideOnFailure` |
| search-image | progressive, `hoverZoom, upgradeToFullRes, secondaryAction` |
| carousel | `snap, gap, showArrows, flush` |
| popover | `showOnHover/hoverOpenDelay`; content `side/align/sideOffset/showCloseButton` |
| animate / transition | `enter/exit/initial/opacity/translateY/rotate/duration/delay/timingFunction/layoutEnter|Exit|Move` |
| lottie | `src, loop, advanceRate` |
| youtube | `videoId` |
| celebration | `trigger` |
| grid | `columns, gap` |
| divider | `flush, spacing` |
| loading-block | `label`, size |

### 3.4 Component registry: always-available and lazy catalog (O, `dil-catalog-names-Bt-CcEda.js` [T])

**`DIL_COMPONENT_NAMES`**, always available, with sources embedded in the worker as `DIL_COMPONENT_SOURCES`:

`OpGenuiResolvedComponentBoundary, AsyncImage, AsyncImageGroup, AsyncVideo, AutomationPlanSummary, Citation, Cite, CoTToolGroup, CodeBlock, CodeCite, Entity, FileCite, FileNavList, FlightCard, FlightCarousel, FlightTracker, FollowUp, FollowUpActionBar, GenImage, LearningVizDil, Link, LinkCard, MediaFallback, MemoryCite, MessageReaction, NewsCarousel, PersonalityQuizWidget, ProductCard, SpeechSynthesizer, WritingBlock`

**`DIL_LAZY_COMPONENT_NAMES`** has **287** entries, loaded on demand through `DIL_COMPONENT_LOADERS` as `<Name>.generated-*.js` chunks. Families:

| Family | Members |
|---|---|
| Weather | `WeatherWidget(V1/V3)(WithSource), WeatherCurrentWithSource, WeatherSidebarTitleWidget` |
| Finance | `StockChart, StockComparisonChart, StockHeatmap(Widget), StockQuoteWidget, StockQuoteComparisonWidget, CurrencyConverter(V2)Widget(WithSource)` |
| Sports | `NbaScores/NbaStandings/NbaSchedule/NbaGameBoxscore/NbaPlayerSummary, NFL, NHL, MLB, WNBA, NCAAMB/NCAAWB, EPL, IPL, F1, Cfb, Soccer, Cricket, Tennis, MarchMadness, BasketballTournamentWidget, SuperbowlRiddleWidget` |
| Medical | **~60 calculators**: `CalculatorApgarScoreWidget, CalculatorCha2ds2VascScore…, CalculatorWellsScoreForPulmonaryEmbolismWidget, …` |
| Learning | `LearningQuiz, LearningFlashcards, LearningFillBlankCard, LearningSentenceBuilderCard, LearningSpeakCard, LearningVocabCard, LearningImageChoiceCard, LearningImageLabelCard, LearningAudioLabelCard, LearningVoiceModeLauncherCard, FollowUpQuiz, MultipleChoiceBlockV2, HomeworkHelperV2, Open/UpdateLearningFlashcards` |
| Ledger (personal finance) | `LedgerAccountsWidget, LedgerNetWorthWidget, LedgerSpendByCategory…, LedgerCreditScore…, LedgerRecurringTransactions…, …` |
| Places, entities, commerce | `LocalBusinessWidget, BusinessGallery…, RestaurantMenu…, RestaurantReviews, ReservationTimePills…, CareProvider…, EntityCard, EntityExplorer, EntityOverview(Carousel)Widget, EntityReviews…, PersonBento, PersonWidget, ProductCarousel, Rating, RecommendationCard` |
| Travel | `FlightResults, FlightSearchForm, FlightTrackerWidget, PackageTracker(Widget)` |
| Productivity | `CalendarEventsWidget, CalendarList, ChecklistWidget, ClockWidget, DigitalTimer/Stopwatch, HolidayWidget, Unit/CurrencyConverter, DraftEmail, EmailPreview, PulseDraftEmail, DisplayAutomation, ListAutomations, SuggestAutomation, OfferScheduledPrompt, TaskExpansionCard` |
| Onboarding and follow-ups | `ConversationalOnboarding*, Onboarding*, FollowUpCardGroup/ChoiceCard/LinkList/PillGroup, ConversationFollowUpActionList, InstantSuggestionsWidget, WhatsNewCapabilityWelcome, Gpt4oSystemCard, Gpt5SystemCard` |
| Media and web | `ImageGenWidget, ImageGrid, AsyncVideoCarousel, VisualCardCarouselWidget, WebLinksCarousel, NewsArticleWidget(Carousel), Reddit(FromSearch/FromProductSearch), LyricsWidget, JobsWidget, ElectionResults…` |
| Ask-user | `AskUserDetails, AskUserFiles, AskUserLocation(V2)(Bidi)` |
| Apps / partner / misc | `InternalPartnerAppWidget, OpenaiWidget, PluginFollowup, ExampleServerActionButton, TabGroup, TabbedSectionWidget, SidebarFactTable, SidebarPeopleAlsoAsk, SharedActivityPlanner, PersistedWidgetDogfood*` |

**Wrapper pattern** (O, every generated component, e.g. `LearningQuiz.generated-rGTXPm18.js@0` [T]):

```
function ResolvedComponentLearningQuiz(props){ const resolutionId=props.__resolutionId; … widgetGenUI.dispatchAction(action){ if(action.handler!=="server"&&!isBoundShare) return hostGenUI.dispatchAction(action);
   return hostGenUI.dispatchWidgetAction({type,…,payload,nativeWidgetResolutionId:resolutionId,componentName:"LearningQuiz"}) } …
 return __dil.jsx(OpGenuiResolvedComponentBoundary,{componentName:"LearningQuiz",componentProps:props,Component}) }
```

**Data resolution** (`shared.dil.ts`, same file @~4300):
- Props carry `__resolutionId`.
- Server-resolved data arrives in `appData.opGenui.componentResults[resolutionId]` as `{status:"pending"|"resolved"|"failed", state, code: component_unavailable|tool_failed|invalid_tool_result, retryable}`.
- Older payloads use `componentData[JSON.stringify([name, normalizedProps])]`.
- The widget shows a skeleton until resolved and renders `props.fallback` on failure.

### 3.5 LearningQuiz.generated structure (O, [T], 44,825 bytes; readable source in a template string)

- **Regions:**
  - `../internal/quiz.dil.tsx` (QuizFrame, QuizHeader, QuizIconButton, QuizChoiceRow)
  - `../shared.dil.ts`
  - `../internal/quiz-media.dil.tsx`
  - `../internal/text-only-markdown.dil.tsx`
  - `internal/learning-quiz.dil.tsx` (state machine)
  - `LearningQuiz.dil.tsx` (entry)
- **State fields** (all localized labels come from the server): `title, questions[], phase, attempt, current_index, answers[], selected_values, feedback_status, hint_open, generation_complete, correct_count(_labels), question_progress_labels ("1 of 3"), option_accessibility_labels, next_quiz_query, retry_query, share_button_variant, copy_quiz_text`, plus label strings such as `submit_answer_label`, `hint_label`, `next_question_label`.
- **Question:** `{id, prompt, question_type: single_select | multi_select | true_false, options, correct_values, hint, image, image_is_loading}`. Any other type sets `phase:"error"`.
- **Interactions:**
  - Answer, next and restart send `GenUI.dispatchAction({handler:"server", type, payload})` (@30551). Types are prefixed `learning_quiz…`, e.g. `learning_quiz_restart`.
  - Server snapshots are merged by `attempt`, `navigation.sequence` and `revision` (`isServerSnapshotAtLeastAsNew`).
  - Shared, read-only views allow local answers (`allowLocalAnswers`).
  - Server actions require `appData.opGenui.nativeServerActions.ready`.
  - Copy and share are client actions. "Next quiz" uses `issue_new_turn` with `next_quiz_query`.
- **Rendering** uses only DIL primitives (`box`, `row`, `col`, `pressable`, `icon` with name chevron-left/copy/share, `text-only-markdown`, `celebration`), matching the [DOM] "1 of 3", A–D options, Next and hint reveal.

### 3.6 Action round-trips (O)

- **Server widget action** (`conversation-source-dil@1452301` [T]):
  ```
  b={action_type:d.actionType,conversation_id:u,message_id:p,native_widget_resolution_id:d.resolutionId,payload:e} …
  let t=await et.post(`/widget_server_action`,{body:b,signal:_,maxResponseBytes:262144});   // et = backendApi → /backend-api/widget_server_action
  … t.status!==`success`&&t.status!==`error` …
  ```
  - Only allowed when the source message `status==="complete"` and a backend conversation id exists.
  - The response `{status, status_message?, response?}` updates `componentResults[resolutionId].state`.
  - The call goes through the authenticated browser client. I: logged-out users get `nativeServerActions.ready=false`, so the quiz runs locally or degrades. **U** whether `/backend-anon` has an equivalent.
- **Follow-up turn from a widget.** `issue_new_turn` and `send_followup_message` become a normal composer submission `{kind:"standard", prompt, messageMetadata, dilFollowup:{conversationId, sourceMessageId, appendToCurrentLeaf:true}}` (a-DoEDC6Ag.js [T]; dil@1459510).
- **Entity / product pills.** `turn0product3` and `turn0business1` refIds resolve through `/backend-anon/sidebar/conversation` (SSE v1, §1.3) and open a native bottom sheet (`native-content-reference-sheet-loader`) (O, canonical-dil-entity-actions).
- **Weather / stock widget option clicks** become follow-up prompts with `event_name:"chatgpt_widget_action"` and `widget_affordance:"OPTION"` (a-DoEDC6Ag.js).

### 3.7 "Interactive content" iframe = Skybridge (O)

- **[DOM] element:** `<iframe sandbox="allow-scripts allow-same-origin" allow="" referrerpolicy="no-referrer" aria-hidden="true" inert="" title="Interactive content" tabindex="-1">`. It sits inside a learning-block thumbnail button ("Show visualization").
- **Title string:** `lightweight-web.conversation.learning-block-interactive-content` (en-US-Dw4JLOVx.js@84446 [H]).
- **Component** `Pl` in conversation-source-content-HyQmmVR_.js@~104600 [T] calls `Vc({iframe, payload:learning.launchPayload, conversationId, messageId, sessionId, locale, theme, displayMode:"thumbnail", maxSheetHeight:80, …})`.
- **Host** `a-DN5VSt_Q.js` [T], 8,643 bytes:
  ```
  …"https://staging-skybridge.oaistatic.com":"https://skybridge.oaistatic.com"),r=new URL("/math-block.html",i); r.searchParams.set("math_block_type",…),
  …("encoded_content",…),("content_type",…),("display_mode",…??"sheet"),("locale"),("max_sheet_height"),("encoded_initial_values"),("widget_type"); r.hash=…{skybridge_host_origin: parentOrigin}
  … e.iframe.contentWindow?.location.replace(o)
  ```
- **Bridge:** `postMessage({msg: base64(JSON)}, skybridgeOrigin)` with JSON-RPC-like `{id, method, params}` / `{id, result|error}`.
  - Iframe → host methods: `ready` (host replies with `{display_mode, is_inline:false, locale, max_sheet_height, methods, session_id, theme, conversation_id, original_message_id, delegate_analytics_to_host:true}`), `setIntrinsicHeight`, `loadingFinished`, `loadingFailed`, `learningBlockEdited` (`CHATGPT_MATH_BLOCK_EDIT_TYPE_{DRAG_POINT,SLIDER_CHANGE,GRAPH_VIEWPORT_PAN,…}`), `learningBlockAnalytics`.
  - Host → iframe: `setMaxSheetHeight`, `setTheme`.
  - Error codes: -32602, -32601, -32002 "Host is not ready".
- **Payload:** `learning_block` content reference → `{matchedType (e.g. GRAPHABLE_FUNCTION_V2, DESMOSOME_CELL_ANCHORING), encodedContent (base64 ≤16 KB), contentType: placeholder|canonical_formula|provided, encodedInitialValues, widgetType, serverLearningBlockVersion}`.
- **Skybridge app** ([SKY] `math-block-CuZTeePR.js`, 1.45 MB):
  - React `version:"19.3.0-canary-7dc903cd-20251203"` (@293882), Vite `__vite__mapDeps`, KaTeX, React Compiler (`"use forget"`).
  - **Host bridge abstraction** `cO()` (@1435939): platform `web` uses `window.parent.postMessage` to `skybridge_host_origin`; `ios` uses `webkit.messageHandlers.skybridgeNative`; `android` uses `window.SkybridgeNative`.
  - **Allowed host methods:**
    ```
    pO=new Set([`callTool`,`ensureAppleHealthOnboarding`,`openAppleHealthSettings`,`openPlaidLink`,`requestAppleHealthPermissions`,`requestCheckout`,
     `requestConnectSheet`,`requestConnectorAuthorization`,`requestLinkToConnector`,`requestModal`,`requestPrompt`,`requestTargetedReply`,`scanCard`,
     `sendFollowupMessage`,`sendFollowupMessageIfVoiceActive`,`sendMcpMessage`,`setWidgetState`,`shouldRequestAppleHealthPermissions`,`updateMcpModelContext`,`updateModelContext`])
    ```
  - I: this is the same Skybridge runtime behind Apps-SDK / connector widgets (`callTool`, `setWidgetState`, `updateModelContext`, `requestModal`). The math block is one first-party Skybridge app.
  - The string `window.openai` is not present in the captured skybridge chunks (O, by absence). The Apps-SDK `window.openai` shim, if any, is in uncaptured chunks (U).
- **DIL HtmlView.** DIL also has its own HTML-view channel (`useHtmlViewMessenger`, `DILHtmlViewMessenger*`, value tag 12). I: this is how DIL programs embed sandboxed HTML; its iframe origin is U.

### 3.8 application-presentation-runtime (O, [H], 636 KB)

- **It is not** the Apps-SDK iframe runtime.
- **It is** the Octane app shell, containing:
  - the TanStack Router core (`__TSR_index`, `_nonReactive.beforeLoadPromise`, @19027/@29184);
  - compiled composer and auth templates (@356345, @573134);
  - the module-preload list for lazy chunks (`conversation-*`);
  - conversation writing-block saves:
    ```
    i.post(`/conversation/message/writing-blocks`,{body:t,…}); if(!o||o.message_id!==t.message_id)throw Error(`Writing save not accepted`)   // @107318, backendApi → /backend-api/…, authenticated
    ```

### 3.9 Server-rendered islands and Declarative Partial Updates (O)

- **DPU probe** (`declarative-partial-updates-BbyCh7bq.js@7480` [T]):
  ```
  e.setHTMLUnsafe(`<?start name="lightweight-web-dpu-probe">before<?end><template for="lightweight-web-dpu-probe">after</template>`),e.textContent===`after`
  … dataset.webMobileDpuParser = native|polyfill ; dataset.webMobileDpuTransport = polyfilled-stream|polyfill
  ```
- **Patch semantics:** `data-web-mobile-dpu-apply="append|replace"` and `data-web-mobile-dpu-terminal`. Targets are a marker (append) or a `<?start>`…`<?end>` range (replace).
- **Errors:** `frame_invalid`, `frame_malformed`, `frame_truncated`. The classic-script twin is `[TS] declarative-partial-updates-cc0dc41806f1.js`, 114 KB.
- **Media records** reuse this format; assistant ranges have `reasoningRange`, `committedRange` and `pendingRange` (conversation-source-turn@~800).
- **Partial islands** (`registry-CMrLO-uz.js` [H]/[T]):
  - Markup: `section[data-assistant-content-reference][data-partial-island="assistant-canonical-dil"][data-dil-widget-name^="weather_widget"]`, containing `<script data-canonical-dil-payload type="application/json">` and `[data-canonical-dil-root]`.
  - Hydration is lazy: `data-canonical-dil-hydrating` → `-hydrated`, plus a post-stream activation.
  - Island modules: `assistant-canonical-dil, assistant-canonical-dil-weather, assistant-dil, assistant-carousel, assistant-map, assistant-learning, assistant-user-input, assistant-image-lightbox, assistant-ads`.
  - I: the weather card is server-rendered canonical DIL HTML, then upgraded client-side.

---

## 4. Composer intelligence (O unless noted)

- **Default model.** `X-OAI-Lightweight-Default-Model` is read from the `/conversation/prepare` response, validated against `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`, cached for 58 min (`expiresAt:Date.now()+348e4`), and echoed on later authenticated requests (authenticated-browser-client-Br8MoFAj.js@14938/@15607 [H]).
  - Logged-out turns send empty `workModel` / `workEffort` / `workTier`.
  - A "Work model" picker exists (`lightweight-web.composer.choose-work-model`, `work-model-control-*.js`, `/work-eligibility?lightweight_authenticated=1`; a-Cn613MSv.js@1947 [H], authenticated only).
  - Thinking and pro are async tasks (`asyncTaskId: thinking|pro`).
- **Tools / hints.** URL `hints` or `system_hints` map through `Ui=new Map([["image","picture_v2"],["picture_v2","picture_v2"],["search","search"]])` (octane-shell-shared@80049). Composer chips: "Search" / "Remove web search"; image hint `picture_v2` with an auth gate (`native-image-hint-auth-gate`).
- **Temporary chat.** URL `temporary-chat=true`, only honoured when authenticated (`n(u)&&a(u)&&p.set(e,"true")`, a-KpA7xT-c.js [H]). It sets `history_and_training_disabled`.
- **Voice and dictation.** `lazy.composer-dictation-*`, `native-dictation-loader-controller`, `start_voice_mode` client action, DIL `useDictation` / `useSpeechSynthesizer`, read-aloud action.
- **Attachments.** Image upload pipeline (`native-image-upload-loader-controller`, `imageAttachments` / `pendingImageUploads` fields). The authenticated file upload allow-list is `/backend-api/files`, `/files/process_upload_stream`, `/estuary/upload_content_bytes` (authenticated-browser-client@13966).
- **Suggestions.** `trending-searches-surface`, `native-static-landing-followups`, follow-up prompts and suggestion widgets, `suggestion-menu-view-*.js` (not captured), `/image-suggestions`, `/connector-suggestions`. SEO "writing tools" landing pages (AI humanizer, CV generator, …) prefill prompt templates (en-US strings).
- **Model-first landings.** URL params such as `homepage_model_first_assistant_message_id` and `paid_creative_model_first_*` start a page with a pre-generated assistant answer (a-KpA7xT-c.js).
- **Autocomplete: U.** No typeahead endpoint was found.

## 5. Markdown and streaming rendering pipeline (O)

- **Custom markdown parser** (`markdown/src/Markdown`, a-DhChyb2Q.js [T], 76 KB).
  - Modes: `Default`, `TextOnly`, `Rich`, `RichLinkLabel`.
  - Block kinds: code (fenced, with language), math, html, heading, rule, quote, list, table, paragraph.
  - An **incremental `MarkdownParser`** keeps a cache from the previous parse (`this.previous=n.cache`) so re-parsing streamed text is cheap.
  - Not used: remark, rehype, micromark, marked, markdown-it (O, by absence).
- **Math.** KaTeX is bundled (a-BH2Fj0Tb.js). `conversation-source-math` calls `renderToString(latex,{displayMode, output:"mathml", throwOnError:!1, trust:!1})` and sets `data-assistant-math-rendered="inline|display"`. DIL's MathContent uses `output:"htmlAndMathml"`. [DOM] shows `<span class="katex"><math …><annotation encoding="application/x-tex">a^2 + b^2 = c^2`.
- **Code.** In-house tokenizer `dil_octane_browser/runtime/markdown/src/MarkdownCodeToken` and `…/code_highlight/runtime/src/CodeTokenClassification`. No shiki or prism (O, by absence). UI strings: "Code", "Wrap lines".
- **Streaming animation:**
  - Each word becomes a `<span data-d-streaming-word>` with a CSS fade, 350 ms for `Snappy` and 700 ms otherwise, with staggered delays (conversation-source-dil@184403). [DOM] has 380 such spans.
  - The DPU layer adds `data-streaming-block`, `data-streaming-list-marker` and `--stream-word-accent-percent` / `--stream-word-delay` CSS variables.
  - The `assistant-content-started` control fires after two rAFs once visible text exists (conversation-source-turn).
  - Updates are rAF-coalesced (§1.2). SVG has a streaming reveal (`SvgStreamingReveal`).

## 6. Front-end stack (O unless noted)

| Concern | Finding |
|---|---|
| UI framework | **Octane**, OpenAI's compiled, signals-based framework with a React-like API (`useState`, `useLayoutEffect`, `memo`, `Suspense`, `Activity`, `lazy`, `portal`, `context`). It emits `<!--if--><!--try--><!--comp-->` comment anchors and `data-octane-hydrate-id`. Symbols: `octane.element`, `octane.signal-handle`, `octane.suspense`, `octane.Activity` (a-CCiiRc_z.js@33280). Error format: `"Minified Octane error #${e}"` (octane-signals-engine). **React is not used in the main app**; only skybridge uses React 19.3 canary. |
| Reactive state | `octane-signals-engine-DwYWa4RK.js` (84 KB). Signal kinds `signal | derived | async | stream`, with owners, batch and `urgentWrite`. Also: `"Invalid Octane streamed renderer frame"` (streamed SSR hydration). App state uses `Vt("conversation-writing.patch",…)` named signal actions and `Rt("g:…")` global signals (application-presentation-runtime@107318). |
| Server functions | Ripple-style RPC: `fetch("/_$_ripple_rpc_$_/"+hash,{headers:{Accept:"application/x-octane-rpc+ndjson"}})` and batch `application/x-octane-rpc-batch+ndjson` (a-CCiiRc_z.js@522379/@524390). I: Octane is derived from or related to the Ripple framework. |
| Router | TanStack Router (`__TSR_key`, `__TSR_index`, scroll restoration `data-scroll-restoration-id`). |
| Bundler | Rolldown (`rolldown-runtime-*.js`) via Vite. A worker-version cache-buster `__wvi(url)` appends `?worker_version`. |
| Hosting | Cloudflare Workers BFF (`Cloudflare-Workers-Version-Overrides` header, octane-shell-shared@13394; `X-Web-Mobile-Document-Worker-Version`). |
| Styling | **StyleX** atomic classes (`x5yr21d…`, `{…,$$css:!0}` objects, `palette.stylex`, `radii.stylex`). Design-system components are tagged `data-w-component`, `data-variant`, `data-size`, `data-radius`. Not Tailwind. |
| Feature flags | **Statsig, evaluated server-side** (server-timing metrics `statsig_init/auth/renderer/route`, performance-metrics@6984). The client only forwards `statsigContext` / `statsigMetadataV2` in analytics (a-U5mt0QwB.js@7071). Skybridge bundles a Statsig client ([SKY] Cm5ZtKtT.js). |
| Analytics | Protobuf-typed events `"@type":"openai.buf.dev/openai/protobuf-analytics-events/<Name>"` (a-U5mt0QwB.js@8346), `/events/statsc/flush`, `/events/performance`, `/events/app-entry`, web-vitals with attribution, long-INP and LoAF metrics, `ces-*` business-context and page diagnostics, `/backend-anon/beacons/{home,event}`. |
| i18n | Message ids `lightweight-web.<area>.<key>` with English defaults (`e("lightweight-web.composer.prompt-placeholder","Ask ChatGPT")`) in `en-US-*.js`. ~60 locale chunks. `client-i18n-scopes`. |
| Workers | DIL sandbox worker and eval worker. |

## 7. Not visible in this capture (explicit gaps)

- **Real NDJSON bodies.** The response stream for `/conversation/updates` was not captured. §1.2 is reconstructed from validators, so rare record subtypes (`shared`, `paragen`) are only partly known (**U**).
- **The model's DIL source language.** The client only sees compiled `__dil.jsx` JS. Whether the model emits TSX, JSON or DIL-specific markup, and where it is compiled (Worker or backend), is **U**.
- **Lazy chunks never fetched.** The download attempt was blocked (bot challenge → 403). Missing chunks include almost all **287 `<Name>.generated` catalog widgets** (only `LearningQuiz` was captured), `conversation-transcript`, `conversation-message-frame-*`, `conversation-rich-content-controls`, `conversation-steering-control`, `conversation-interactive-*`, `content-reference-sheets`, `assistant-*` island modules, `suggestion-menu-view`, `work-model-control`, `request-user-input`, `toast` and others. 216 referenced chunks were missing from [H] alone.
- **Authenticated-only paths.** Bodies and responses are U for `/backend-api/f/steer_turn`, `/backend-api/widget_server_action`, `/backend-api/conversation/message/writing-blocks`, file uploads, the authenticated sidebar, account switching, the work model picker, canvas (no canvas or textdoc code found in the captured set), memory, projects and GPTs.
- **The Apps SDK `window.openai` shim and the third-party widget sandbox origin** (for example `*.web-sandbox.oaiusercontent.com`). Neither appears in the captured chunks. Only first-party Skybridge (`skybridge.oaistatic.com/math-block.html`) was observed.
- **Weather card DOM.** `chatgpt-weather-final-dom.html` contains `null`. The island structure in §3.9 is inferred from registry and DPU code, not from captured weather markup.
- **The DIL acronym.** Never expanded in shipped code (**U**).
- **Sentinel internals.** The proof-of-work algorithm, Turnstile `dx` handling and SDK internals were deliberately not analysed beyond the header and flow level.

---

## 8. Live stream capture: gaps closed

Third test prompt (user-approved): "What's the weather in Tokyo this week? Also show me Apple's stock price."
The body was read with CDP `Network.streamResourceContent`. Artifacts:
- `chatgpt-live3/stream.redacted.ndjson`: 87 records, 1.86 MB; resume and stop tokens are redacted.
- `chatgpt-live3/final-markdown.md`
- `chatgpt-live3/final-dil.json`
- `chatgpt-live3/final-references.json`

**8.1 Record sequence (O).**
1. `control started`
2. `shared` (a DPU `<template for="conversation-image-gen-upgrade">`)
3. `control conversation-id` (+ `canonicalPath:/uc/<id>`, `stopConduitToken`)
4. `control resume-token`
5. `reasoning`, two records: `{status:{active,text:"Searching the web",transient,toolIcons:["globe"],reasoning:{activeItem,items,status:0}}, activity:{records:[{sourceId,kind:"activity",text,toolIcons}]}}`
6. `content` revision 1, `mode:"replace"`, empty
7. `content` revisions 2…70, `mode:"append"` + `baseRevision`, interleaved with `control assistant-content-started` and more `reasoning` records. The final revision has `status:"complete"` and `conversationFollowupSuggestionsEligible:true`.
8. `state` ×2 (conversationState for the next turn, safety patch)
9. `shared` (DPU `<template for="conversation-partial-control">` containing `[data-conversation-control="message-stream-complete"]` with `data-conversation-state`, `data-message-patch`)
10. `control terminal-received`
11. `shared` (26 KB HTML)
12. `end`

The `streamingParent` field carries an `acceptedPlacement` chain of hidden intermediate tool and search messages (`is_merged_message:true`, `logical_answer_prefix_activity.visibility:"hidden"`), i.e. the visible answer is one logical message stitched over several backend messages.

**8.2 Resolves the "DIL source language" unknown (O).**
- **The model writes DIL markup inline in its markdown answer**: JSX-like tags with `{}` expressions. Examples:
  - `<box border radius="xl" padding={4} gap={3}>`
  - `<row align="center" gap={3}>`
  - `<grid columns={3} gap={2}><grid-item>`
  - `<text color="secondary" size="xs">`
  - `<title size="2xl">`
  - `<icon name="cloud-rain" color="#4285C5" size="xl"/>`
  - `<divider color="subtle"/>`
  - `<badge color="danger">`
  - `<AsyncImage query="partly cloudy sky over Tokyo skyline autumn" aspectRatio="1:1" maxWidth="100px"/>`
  - `<Entity value="Apple Inc." category="stock" disambig="NASDAQ ticker AAPL"/>` (even inside a `##` heading)
  - `<Cite refs={["turn555745search23","turn555745search24"]}/>`
  - `<StockChart ticker="AAPL" asset_type="equity" market="USA"/>`
- Hand-drawn bar charts appear as nested boxes, e.g. `<box background="#E9A23B" height="5px" radius="full" width="62%"/>`.
- **The server recompiles the whole accumulated markdown into `dil.code` on (almost) every content revision** and re-sends the full `dil` object, growing from 546 B to about 160 KB including appData.
- Compiled form (`final-dil.json`):
  ```
  function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}
  DIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});
    return __dil.jsx(__dil.Fragment,null,__dil.jsx("title",{"size":"xl"},__dilConstants["0"]),__dil.jsx("text",null,__dilConstants["1"]), …
      __dilSafe(()=>(__dil.jsx(AsyncImage,{"query":"…","aspectRatio":"1:1","maxWidth":"100px","__resolutionId":__dilConstants["6"]})),null) …
  ```
  - Markdown headings and paragraphs become `title` / `text` primitives.
  - Every string literal is hoisted into `constants`.
  - Catalog components are free identifiers wrapped in `__dilSafe`, and each gets a server-assigned `__resolutionId`.
  - `requiredComponents:["AsyncImage","Cite","Entity","StockChart"]`.
  - `fallbackMarkdown` is a plain-markdown rendition used when DIL fails.
- **Server-resolved widget data** is in `appData.opGenui.componentResults[resolutionId] = {status:"resolved", state}`:
  - AsyncImage → `{images, frame_*, image_fit, presentation, default_on_click_action}`
  - Entity → `{value, entity_data, image_url, open_status, directions_url, …}`
  - Cite → `{items, active_index, sources_title}`
  - StockChart → `{asset_display_name:"Apple Inc (AAPL)", current_price_text:"$339.50", market_status:"Closed", default_range:"1D", timeframe_order:[1D,5D,1M,6M,YTD,1Y,5Y,MAX], timeframe_configs{…}, hover_*, metrics_display, follow_up_actions, …}`
  - Other `opGenui` keys: `modelDataBindings`, `interactionSurface`, `componentRefresh`.
- I: this is how ChatGPT gets rich UI without a fixed widget per query. The model composes layout primitives freely (the weather card and stock card here were model-authored layouts, not the canned `WeatherWidget`), and drops in data-bound catalog components where live data is needed.

**8.3 Still unknown.**
- The server-side compiler implementation.
- The system prompt that teaches the model the DIL vocabulary.
- `shared` record semantics beyond DPU template patches.

# Wonder for iOS

A native SwiftUI version of Wonder. Claude writes each lesson as DIL (the JSX-like UI language
reverse-engineered from ChatGPT), and the same engine that runs it in the web app runs it here,
inside JavaScriptCore. What you see on screen is drawn with SwiftUI, not a web view.

```
Wonder server (genui-lab/wonder: Claude, compile, NDJSON)        no API key ever reaches the phone
        │  POST /api/lesson/stream · /api/tutor/stream · /api/teacher/stream · /api/widget_action …
        ▼
 URLSession bytes ──lines──▶ core JSContext  (wonder-core.js: chatgpt-dil ConversationSourceParser,
                                              store, deck/FSRS, practice, progress, steering, Teacher)
                                    │ content records {dil: {code, constants, appData}}
                                    ▼
                     surface JSContext, one per lesson / reply  (wonder-engine.js: the web's Web Worker,
                                              chatgpt-dil runtime + the learning catalog, sandboxed)
                                    │ render ops: createElement / createText / move / propChanged / …
                                    ▼
                     DilTree (@Observable nodes) ──▶ SwiftUI host: FlexLayout, attributed text runs,
                                              SVG Canvas, KaTeX display math, native buttons and fields
                                    ▲
                     taps → invokeFunction(fnId) · GenUI host actions → /api/widget_action or the app
```

## What is shared with the web app, unchanged

- **The DIL sandbox**: `chatgpt-dil/src/runtime.js` and `wonder/public/learning-runtime.js`, plus the learning catalog
  (Quiz, LessonStepper, Flowchart, BarChart, KeyTerm, Callout, FunctionGraph, Cite, TeacherCard, …) and widget-state
  persistence. These run through `wonder/public/wonder-worker.js`, the same worker protocol the browser uses.
- **The app logic**: `store.js` (the same `wonder.v1` document, kept in a file instead of localStorage), `deck.js` with
  FSRS, `practice-core.js` grading, `progress-core.js`, `steering-core.js`, `teacher-core.js`, `mastery-core.js`,
  `outcomes-core.js`, and chatgpt-dil's NDJSON parser and validator.
- **The server**: every endpoint, prompt, tool and fixture.

`ios/engine/bundle.mjs` turns those ES modules into two classic scripts (`ios/Wonder/Engine/JS/`), copying the
source byte for byte. It has to: the catalog builds its sandbox prelude from `fn.toString()`.

## What is native

| Piece | File |
|---|---|
| JSContext lanes, timers, the bridge | `Engine/JSHost.swift` |
| One DIL surface per lesson or reply, using the worker protocol | `Engine/DilSurface.swift` |
| Render ops → observable node tree | `Engine/DilTree.swift` |
| The core context and the file-backed store | `Engine/WonderCore.swift` |
| CSS flexbox subset (direction, gap, align, justify, wrap, grow and shrink, % widths) | `Render/FlexLayout.swift` |
| Primitive → SwiftUI (containers, pressables and their variants, buttons, lists, grids, inputs…) | `Render/DilView.swift` |
| Paragraphs as one AttributedString; inline KeyTerm and Cite pills are `dil-fn://` links | `Render/InlineText.swift` |
| SVG paths and shapes in a Canvas; the shared icon set | `Render/SVG.swift` |
| Display math with the bundled KaTeX; inline math as Unicode text | `Render/MathView.swift` |
| Wonder's design tokens, light and dark | `Render/DilTheme.swift` |
| Today, lesson reader, tutor, course, Library, Review, Teacher, You | `Screens/` |

### Sandboxing

Each surface gets its own JSContext, like the web's one Web Worker per message. The bridge is captured and deleted from
the global object before any model-written program runs, and programs see `fetch`, `self`, `postMessage` and the
other host globals as `undefined`. A program can only change its own surface's tree and raise GenUI actions. The app
decides what those actions do: links open only for `https`, and server actions go only to the Wonder server.

## Run it

1. **Start the server on your Mac.** Either option serves the same API:

   ```bash
   npm --prefix genui-lab/wonder run dev
   ```

   or, without a Next.js build:

   ```bash
   node ios/dev-server.mjs 8750
   ```

   Claude credentials come from the environment or `~/.config/wonder/.env`, exactly as for the web app. With no
   credentials the server runs in demo mode, and the app shows a banner saying so.

2. **Run the app.** Open `ios/Wonder.xcodeproj` in Xcode 26, choose an iPhone simulator and press Run, or build from
   the command line:

   ```bash
   xcodebuild -project ios/Wonder.xcodeproj -scheme Wonder -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
   ```

The Simulator reaches the Mac at `http://localhost:8750`, which is the default. On an iPhone, set
**You → Server** to your Mac's address on the same network (for example `http://192.168.1.20:8750`). Plain `http`
is allowed for local networks only (`NSAllowsLocalNetworking`). You can also launch the app with
`-wonder.server http://localhost:8761` to point it at another port.

### Deep links

`wonder://lesson?topic=Bayes%27%20theorem&level=beginner`, `wonder://lesson/<id>`, `wonder://course?topic=…`,
`wonder://teacher?message=…` and `wonder://review`. From a terminal:

```bash
xcrun simctl openurl booted "wonder://lesson?topic=Black%20holes"
```

## After changing the web client

Rebuild the bundles whenever a shared module changes (`genui-lab/wonder/public/*.js`, `genui-lab/chatgpt-dil/src/*`):

```bash
node ios/engine/bundle.mjs
```

The tests check that the bundles and fixtures are up to date.

## Tests

- **Node:** `node --test ios/engine/test/` runs both bundles the way JavaScriptCore does: a bare context with only the
  language built-ins plus the Swift bridge. It covers a demo lesson's render, KeyTerm taps, widget-state snapshots,
  the sandbox, parsing a recorded Claude stream, and the lesson → cards → review → persistence loop.
- **XCTest on the Simulator:**

  ```bash
  xcodebuild -project ios/Wonder.xcodeproj -scheme Wonder -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
  ```

  It covers a real recorded Claude lesson rendered in JavaScriptCore, a KeyTerm round trip, widget state, the sandbox,
  a recorded Teacher turn with tool cards, grading, the op tree, TeX→Unicode, SVG paths and theme tokens. The fixtures
  come from the web app's own recordings (`node ios/engine/fixtures.mjs`).

For debugging layout, launch with `-wonder.debugLayout YES` to outline every DIL box.

## Not in this version

These web features are not here yet: uploading your own material, calendar (.ics) export, daily reminder
notifications, the mastery and insights panels, the ⌘K palette, and the cross-tab lesson lock (not needed with one
app). Remote images stay placeholders, as on the web by default.

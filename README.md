# GenUI reverse engineering

Reverse engineering of two AI "intelligent UI" systems from their shipped web clients, plus working reconstructions.

## Findings
- [re/chatgpt-findings.md](re/chatgpt-findings.md): ChatGPT web client. Covers the DIL generative-UI runtime, the conversation-source NDJSON stream, the Skybridge widget host, and the Octane/StyleX stack.
- [re/wondering-findings.md](re/wondering-findings.md): wondering.app. Covers `{{interactive:…}}` lesson widgets, the chat/Teacher SSE streams, the Gemini Live / OpenAI realtime voice tutor, FSRS practice, and the Supabase backend.

## Wonder: the combined app (`genui-lab/wonder/`)
Wonder is a Wondering-style learning app (courses, lessons, a tutor, FSRS review, XP and streaks). Its lessons and tutor replies are written by Claude (`claude-opus-5-5`) as ChatGPT-style DIL markup. The server compiles that markup and streams it as conversation-source NDJSON, and the client renders it in the sandboxed DIL runtime. Wondering's learning widgets (Quiz, LessonStepper, Flashcards, Flowchart, Timeline, InputOutputSlider and more) are available to the model as DIL catalog components.

To run it:

```bash
cd genui-lab/wonder && npm install && npm start
```

Then open http://localhost:8750/. Put `ANTHROPIC_API_KEY=...` in `genui-lab/wonder/.env` (git ignores it) to use Claude; without it, the app runs in demo mode.

## Reconstructions (`genui-lab/`)
- `genui-lab/chatgpt-dil/`: DIL markup compiler, sandboxed worker runtime, op-based DOM host, and NDJSON stream replay.
- `genui-lab/wondering-genui/`: interactive-marker parser, component registry, SSE reducers, voice-board validators, and FSRS.

To run them:

```bash
python3 -m http.server 8740 --directory genui-lab
```

Then open http://localhost:8740/. To run the tests:

```bash
node --test genui-lab/chatgpt-dil/test/index.js
```

```bash
node --test genui-lab/wondering-genui/test/*.test.js
```

```bash
node --test genui-lab/wonder/test/index.js
```

## Evidence handling
The analysis was static, using public JS bundles. Live capture was limited to three logged-out ChatGPT test prompts. Session tokens (conduit, resume, stop, sentinel, proof, turnstile) are redacted in every committed file. Raw captures and copied third-party bundles are excluded by `.gitignore`.

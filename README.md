# GenUI reverse engineering

Reverse engineering of two AI "intelligent UI" systems from their shipped web clients, plus working reconstructions.

## Findings
- [re/chatgpt-findings.md](re/chatgpt-findings.md): ChatGPT web client. Covers the DIL generative-UI runtime, the conversation-source NDJSON stream, the Skybridge widget host, and the Octane/StyleX stack.
- [re/wondering-findings.md](re/wondering-findings.md): wondering.app. Covers `{{interactive:…}}` lesson widgets, the chat/Teacher SSE streams, the Gemini Live / OpenAI realtime voice tutor, FSRS practice, and the Supabase backend.

## Reconstructions (`genui-lab/`)
- `genui-lab/chatgpt-dil/`: DIL markup compiler, sandboxed worker runtime, op-based DOM host, and NDJSON stream replay.
- `genui-lab/wondering-genui/`: interactive-marker parser, component registry, SSE reducers, voice-board validators, and FSRS.

To run them:

```bash
python3 -m http.server 8740 --directory genui-lab
```

Then open http://localhost:8740/. To run the tests:

```bash
node --test genui-lab/*/test/
```

## Evidence handling
The analysis was static, using public JS bundles. Live capture was limited to three logged-out ChatGPT test prompts. Session tokens (conduit, resume, stop, sentinel, proof, turnstile) are redacted in every committed file. Raw captures and copied third-party bundles are excluded by `.gitignore`.

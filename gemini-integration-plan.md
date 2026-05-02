# Gemini Flash 2 Integration Plan

## Overview

Replace the hard-coded Ollama path in `lib/qwen.mjs` with a provider-agnostic LLM layer.
A single config key (`llm.provider`) toggles between the local Ollama/Qwen model and the
Gemini 2.0 Flash API. Every call site (`report-builder`, `cv-tailor`, `batch-eval`, etc.)
stays unchanged.

---

## 1. Config changes — `config/profile.yml`

Restructure the flat `llm:` block into a provider + named sub-blocks:

```yaml
llm:
  provider: local          # "local" | "gemini"

  local:
    endpoint: http://127.0.0.1:11434/v1
    model: qwen3:8b
    thinking: true
    timeout_ms: 90000
    max_retries: 1
    temperature: 0.3

  gemini:
    model: gemini-2.0-flash
    api_key_env: GEMINI_API_KEY   # name of the env var that holds the key
    timeout_ms: 30000
    max_retries: 2
    temperature: 0.3
```

The `api_key_env` indirection keeps the actual key out of the YAML file.
At runtime: `process.env[cfg.llm.gemini.api_key_env]`.

---

## 2. Architecture

### 2a. Rename `lib/qwen.mjs` → `lib/llm.mjs`

This is the only file that owns HTTP calls to the model. Every other module imports
`chat` / `chatWithTools` / `loadConfig` from it — those export names stay the same, so
all other files only need their import path updated.

**Files that import from `lib/qwen.mjs`** (update path, nothing else):
- `lib/cv-tailor.mjs`
- `lib/report-builder.mjs`
- `bin/batch-eval.mjs`

### 2b. Internal structure of `lib/llm.mjs`

```
loadConfig()          — unchanged, reads profile.yml

callOllama()          — unchanged, existing code
callGemini()          — new

chat()                — routes to callOllama or callGemini based on cfg.llm.provider
chatWithTools()       — same routing
```

The public API (`chat`, `chatWithTools`, `loadConfig`) is identical to today.

---

## 3. `callGemini()` — implementation detail

### Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### Request body mapping

| Current (Ollama) | Gemini equivalent |
|---|---|
| `messages[{role:"system", content}]` | `systemInstruction: { parts: [{text}] }` |
| `messages[{role:"user", content}]` | `contents: [{role:"user", parts:[{text}]}]` |
| `options.temperature` | `generationConfig.temperature` |
| `format: "json"` (json mode) | `generationConfig.responseMimeType: "application/json"` |
| AJV schema (post-hoc validation) | `generationConfig.responseSchema: <schema>` (native) |

### Response extraction

```
data.candidates[0].content.parts[0].text   →  raw JSON string
```

Then `JSON.parse()` + AJV validation runs as usual (safety net even with native schema).

### Schema conversion

Gemini's `responseSchema` accepts an OpenAPI 3.0 subset which is very close to JSON Schema.
A thin `toGeminiSchema(jsonSchema)` helper strips unsupported keywords:

- Drop: `$schema`, `$id`, `$ref`, `definitions`, `patternProperties`, `if/then/else`
- Keep: `type`, `properties`, `required`, `items`, `enum`, `description`, `minimum`, `maximum`

The existing AJV schemas (`schemas/*.json`) work without modification — conversion happens
at call time, not on disk.

### Logging

Gemini responses include `usageMetadata.promptTokenCount` and `candidatesTokenCount`.
Log these alongside latency in the same `log.info('llm-call', {...})` format as today.

---

## 4. `chatWithTools()` — Gemini mapping

Tool calling format is different from OpenAI's.

### Sending tools

```js
// OpenAI/Ollama format (current)
{
  tools: [{ type: "function", function: { name, description, parameters } }],
  tool_choice: "auto"
}

// Gemini format
{
  tools: [{ functionDeclarations: [{ name, description, parameters }] }],
  toolConfig: { functionCallingConfig: { mode: "AUTO" } }
}
```

### Receiving a tool call

```js
// Ollama: message.tool_calls[].function.{ name, arguments }
// Gemini: candidates[0].content.parts[].functionCall.{ name, args }
```

### Sending tool results back

```js
// Ollama: { role: "tool", tool_call_id, content: <string> }

// Gemini: {
//   role: "user",
//   parts: [{ functionResponse: { name, response: { result: <value> } } }]
// }
```

The loop in `chatWithTools()` needs a branch: build messages in Gemini format when
`provider === "gemini"`, otherwise use the existing OpenAI format.

> **Note:** `chatWithTools` is currently only used by `comp-scrape.mjs` for Glassdoor/Levels.fyi
> scraping, not for core evaluation. If tool use is not needed for Gemini yet, this can be
> stubbed to throw `"tool calls not implemented for Gemini provider"` and tackled later.

---

## 5. File-by-file change list

| File | Change |
|---|---|
| `config/profile.yml` | Restructure `llm:` block (section 1) |
| `lib/qwen.mjs` | Rename to `lib/llm.mjs`; add `callGemini()`; add routing in `chat()` and `chatWithTools()` |
| `lib/cv-tailor.mjs` | Update import path `./qwen.mjs` → `./llm.mjs` |
| `lib/report-builder.mjs` | Update import path |
| `bin/batch-eval.mjs` | Update import path |
| `.env` (new file, git-ignored) | `GEMINI_API_KEY=your_key_here` |
| `.gitignore` | Add `.env` if not already present |

No changes needed in: `bin/discover.mjs`, `bin/review.mjs`, `bin/evaluate.mjs`,
`lib/cv-parse.mjs`, `lib/pdf.mjs`, `lib/store.mjs`, or any scraper files.

---

## 6. Environment setup

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Create `.env` in the project root:
   ```
   GEMINI_API_KEY=AIza...
   ```
3. Load it at startup. Two options:
   - **Option A (zero deps):** Add 3 lines to `lib/llm.mjs` top:
     ```js
     import { readFileSync } from 'fs';
     try {
       for (const line of readFileSync('.env','utf-8').split('\n')) {
         const [k,...v] = line.split('='); if (k?.trim()) process.env[k.trim()] ??= v.join('=').trim();
       }
     } catch {}
     ```
   - **Option B:** Use the `dotenv` package (`npm i dotenv`) and `import 'dotenv/config'`.

4. No new runtime dependency is required for the Gemini API itself — the existing `fetch`
   (Node 18+) handles the REST calls.

---

## 7. Retry & error handling

Gemini returns HTTP 429 for quota exceeded. The existing retry loop in `chat()` handles
generic failures; add one special case:

```js
if (res.status === 429) {
  // back off 5 s before retry
  await new Promise(r => setTimeout(r, 5000));
}
```

Gemini also returns 400 with `SAFETY` finish reason when content is blocked. Treat this
as a hard error (don't retry) and surface a clear message.

---

## 8. Testing the integration

### Quick smoke test (no job needed)

```bash
GEMINI_API_KEY=... node -e "
  import('./lib/llm.mjs').then(async m => {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const r = await m.chat({ system: 'Reply with JSON', user: 'Return {\"ok\":true}' });
    console.log(r);
  });
"
```

Or add a temporary `provider: gemini` in `profile.yml` and run:

```bash
npm run batch-eval -- --limit=1 --no-pdf
```

### What to verify

- [ ] `chat()` returns a valid parsed object (not a string)
- [ ] AJV schema validation passes for `pre-screen`, `keywords`, `block-a` … `score`
- [ ] Latency logged correctly
- [ ] Switching back to `provider: local` still works

---

## 9. Gotchas & edge cases

| Issue | Mitigation |
|---|---|
| Gemini `responseSchema` doesn't support `$ref` / `definitions` | The existing schemas don't use them — no action needed |
| Gemini `thinking` mode (like Qwen's `/think` tag) | Gemini 2.0 Flash has a thinking variant (`gemini-2.0-flash-thinking-exp`); use it by swapping the model name, not a flag |
| `chatWithTools` format mismatch | Stub it with a clear error for now; implement when comp-scrape Gemini support is needed |
| API key accidentally committed | `.env` in `.gitignore`; `api_key_env` in YAML only stores the env var name, never the key |
| Cold-start latency on first Gemini call | Not an issue — no model loading time unlike Ollama |
| Rate limits on free tier | 15 RPM on Flash free tier; the sequential loop in `batch-eval` is already slow enough that this won't be hit |
| Different token counting vs Ollama char counting | Gemini returns real token counts; update `log.info` to log `prompt_tokens` / `output_tokens` instead of char counts when provider is gemini |

---

## 10. Implementation order

1. Config restructure (`profile.yml`) — touch nothing else yet; update `loadConfig()` consumers to read `cfg.llm.local.*` or `cfg.llm.gemini.*` based on `cfg.llm.provider`.
2. Rename `qwen.mjs` → `llm.mjs`, update the three import paths.
3. Implement `callGemini()` + `toGeminiSchema()` helper.
4. Wire routing in `chat()`.
5. Smoke test with `--limit=1 --no-pdf`.
6. Implement Gemini path in `chatWithTools()` (or stub).
7. Add retry / 429 handling.
8. Final test: full `batch-eval` run on 3–5 jobs with each provider.

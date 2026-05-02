import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { log } from './log.mjs';

// Load .env file at startup (silently skip if absent — .env is optional)
try {
  for (const line of readFileSync(resolve('.env'), 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip surrounding quotes from the value, if present
    const val = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env is optional */ }

const ajv = new Ajv({ allErrors: true, strict: false });

let _config = null;
export function loadConfig() {
  if (_config) return _config;
  _config = yaml.load(readFileSync(resolve('config/profile.yml'), 'utf-8'));
  return _config;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Convert a JSON Schema to the OpenAPI 3.0 subset accepted by Gemini's responseSchema.
 * Strips keywords that Gemini does not support (refs, combiners, conditionals).
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const UNSUPPORTED = new Set([
    '$schema', '$id', '$ref', 'definitions', '$defs',
    'patternProperties', 'if', 'then', 'else', 'not',
    'allOf', 'anyOf', 'oneOf', 'contains',
    'additionalItems', 'unevaluatedProperties',
  ]);

  function clean(node) {
    if (Array.isArray(node)) return node.map(clean);
    if (typeof node !== 'object' || node === null) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (!UNSUPPORTED.has(k)) out[k] = clean(v);
    }
    return out;
  }
  return clean(schema);
}

// ─── Low-level Gemini HTTP helper ─────────────────────────────────────────────

async function _geminiRequest(apiKey, model, body, timeout = 30000) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`Gemini unreachable: ${err.message}`);
  }

  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') || 5) * 1000;
    await new Promise(r => setTimeout(r, wait));
    throw new Error('Gemini rate limited (429) — will retry');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

async function callOllama(endpoint, model, messages, opts = {}) {
  const body = {
    model,
    messages,
    stream: false,
    options: { temperature: opts.temperature ?? 0.3 },
  };
  if (opts.jsonMode) body.format = 'json';
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = 'auto'; }

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? 90000),
    });
  } catch (err) {
    throw new Error(`Ollama unreachable at ${endpoint}: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
  }

  const data    = await res.json();
  const latency = Date.now() - start;
  const msg     = data.choices?.[0]?.message;

  log.info('llm-call', {
    provider: 'local',
    model,
    latency,
    in_chars:  messages.reduce((s, m) => s + (m.content?.length || 0), 0),
    out_chars: msg?.content?.length || 0,
    finish:    data.choices?.[0]?.finish_reason,
  });

  return { message: msg, latency };
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(apiKey, model, messages, opts = {}) {
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs  = messages.filter(m => m.role !== 'system');

  const body = {
    contents: userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
    },
  };

  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  if (opts.jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
    if (opts.responseSchema) {
      body.generationConfig.responseSchema = toGeminiSchema(opts.responseSchema);
    }
  }

  const start = Date.now();
  const data  = await _geminiRequest(apiKey, model, body, opts.timeout);
  const latency = Date.now() - start;

  const candidate    = data.candidates?.[0];
  const finishReason = candidate?.finishReason;

  if (finishReason === 'SAFETY') {
    const err = new Error('Gemini blocked response (SAFETY filter)');
    err.noRetry = true;
    throw err;
  }

  const content = candidate?.content?.parts?.[0]?.text ?? '';
  const usage   = data.usageMetadata ?? {};

  log.info('llm-call', {
    provider:      'gemini',
    model,
    latency,
    prompt_tokens: usage.promptTokenCount      ?? 0,
    output_tokens: usage.candidatesTokenCount  ?? 0,
    finish:        finishReason,
  });

  return { message: { role: 'assistant', content }, latency };
}

// ─── Tool-calling: Ollama ─────────────────────────────────────────────────────

async function _chatWithToolsOllama({ system, user, tools, maxIterations, promptName, providerCfg }) {
  const toolDefs = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const { message } = await callOllama(
      providerCfg.endpoint, providerCfg.model, messages,
      { tools: toolDefs, timeout: providerCfg.timeout_ms },
    );
    messages.push(message);

    if (!message.tool_calls?.length) return message.content || '';

    for (const call of message.tool_calls) {
      const tool = tools.find(t => t.name === call.function.name);
      if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
      const result = await tool.handler(args);
      messages.push({
        role:         'tool',
        tool_call_id: call.id,
        content:      typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  throw new Error(`[${promptName}] tool loop hit maxIterations (${maxIterations})`);
}

// ─── Tool-calling: Gemini ─────────────────────────────────────────────────────

async function _chatWithToolsGemini({ system, user, tools, maxIterations, promptName, providerCfg }) {
  const apiKey = process.env[providerCfg.api_key_env ?? 'GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      `Gemini API key not set — add ${providerCfg.api_key_env ?? 'GEMINI_API_KEY'}=<key> to .env`,
    );
  }

  const geminiTools = [{
    functionDeclarations: tools.map(t => ({
      name:        t.name,
      description: t.description,
      parameters:  toGeminiSchema(t.parameters),
    })),
  }];
  const toolConfig = { functionCallingConfig: { mode: 'AUTO' } };

  const contents = [{ role: 'user', parts: [{ text: user }] }];
  const systemInstruction = system ? { parts: [{ text: system }] } : undefined;

  for (let i = 0; i < maxIterations; i++) {
    const body = {
      contents,
      tools:      geminiTools,
      toolConfig,
      generationConfig: { temperature: providerCfg.temperature ?? 0.3 },
      ...(systemInstruction ? { systemInstruction } : {}),
    };

    const start = Date.now();
    const data  = await _geminiRequest(apiKey, providerCfg.model, body, providerCfg.timeout_ms);
    const latency = Date.now() - start;

    const candidate = data.candidates?.[0];
    const parts     = candidate?.content?.parts ?? [];
    contents.push({ role: 'model', parts });

    log.info('llm-call', {
      provider:      'gemini',
      model:         providerCfg.model,
      latency,
      prompt_tokens: data.usageMetadata?.promptTokenCount     ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      finish:        candidate?.finishReason,
    });

    const fnCalls = parts.filter(p => p.functionCall);
    if (!fnCalls.length) return parts.find(p => p.text)?.text || '';

    const resultParts = [];
    for (const { functionCall: { name, args } } of fnCalls) {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = await tool.handler(args ?? {});
      resultParts.push({
        functionResponse: {
          name,
          response: { result: typeof result === 'string' ? result : JSON.stringify(result) },
        },
      });
    }
    contents.push({ role: 'user', parts: resultParts });
  }

  throw new Error(`[${promptName}] tool loop hit maxIterations (${maxIterations})`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function chat({ system, user, schema, promptName = 'unknown', retries, temperature } = {}) {
  const cfg         = loadConfig().llm;
  const provider    = cfg.provider ?? 'local';
  const providerCfg = cfg[provider] ?? cfg; // cfg fallback supports legacy flat config

  const maxRetries = retries ?? providerCfg.max_retries ?? 1;
  const temp       = temperature ?? providerCfg.temperature ?? 0.3;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const systemMsg = attempt > 0
      ? system + '\n\nCRITICAL: Previous response failed validation. Return VALID JSON ONLY — no prose, no fences.'
      : system;

    try {
      let message;

      if (provider === 'gemini') {
        const apiKey = process.env[providerCfg.api_key_env ?? 'GEMINI_API_KEY'];
        if (!apiKey) {
          throw new Error(
            `Gemini API key not set — add ${providerCfg.api_key_env ?? 'GEMINI_API_KEY'}=<key> to .env`,
          );
        }
        ({ message } = await callGemini(
          apiKey,
          providerCfg.model,
          [{ role: 'system', content: systemMsg }, { role: 'user', content: user }],
          { jsonMode: true, responseSchema: schema, timeout: providerCfg.timeout_ms, temperature: temp },
        ));
      } else {
        ({ message } = await callOllama(
          providerCfg.endpoint,
          providerCfg.model,
          [{ role: 'system', content: systemMsg }, { role: 'user', content: user }],
          { jsonMode: true, timeout: providerCfg.timeout_ms, temperature: temp },
        ));
      }

      const raw    = stripFences(message?.content || '');
      const parsed = JSON.parse(raw);

      if (schema) {
        const validate = ajv.compile(schema);
        if (!validate(parsed)) {
          const errs = validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ');
          throw new Error(`Schema invalid: ${errs}`);
        }
      }

      return parsed;
    } catch (err) {
      if (err.noRetry) throw err; // e.g. Gemini SAFETY block — don't burn retries
      lastErr = err;
      log.warn('llm-retry', { provider, promptName, attempt, error: err.message });
    }
  }

  throw new Error(`[${promptName}] failed after ${maxRetries + 1} attempts: ${lastErr?.message}`);
}

export async function chatWithTools({
  system, user, tools = [], maxIterations = 6, promptName = 'unknown',
} = {}) {
  const cfg         = loadConfig().llm;
  const provider    = cfg.provider ?? 'local';
  const providerCfg = cfg[provider] ?? cfg;

  if (provider === 'gemini') {
    return _chatWithToolsGemini({ system, user, tools, maxIterations, promptName, providerCfg });
  }
  return _chatWithToolsOllama({ system, user, tools, maxIterations, promptName, providerCfg });
}

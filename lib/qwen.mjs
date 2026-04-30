import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { log } from './log.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });

let _config = null;
export function loadConfig() {
  if (_config) return _config;
  _config = yaml.load(readFileSync(resolve('config/profile.yml'), 'utf-8'));
  return _config;
}

async function callOllama(endpoint, model, messages, opts = {}) {
  const body = {
    model,
    messages,
    stream: false,
    options: { temperature: opts.temperature ?? 0.3 },
  };

  if (opts.jsonMode) body.format = 'json';
  if (opts.tools)   { body.tools = opts.tools; body.tool_choice = 'auto'; }

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

  const data = await res.json();
  const latency = Date.now() - start;
  const msg = data.choices?.[0]?.message;

  log.info('qwen-call', {
    model,
    latency,
    in_chars: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
    out_chars: msg?.content?.length || 0,
    finish: data.choices?.[0]?.finish_reason,
  });

  return { message: msg, latency };
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

export async function chat({ system, user, schema, promptName = 'unknown', retries, temperature } = {}) {
  const cfg = loadConfig().llm;
  const maxRetries = retries ?? cfg.max_retries ?? 1;
  const temp = temperature ?? cfg.temperature ?? 0.3;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const systemMsg = attempt > 0
      ? system + '\n\nCRITICAL: Previous response failed validation. Return VALID JSON ONLY — no prose, no fences.'
      : system;

    try {
      const { message } = await callOllama(
        cfg.endpoint, cfg.model,
        [{ role: 'system', content: systemMsg }, { role: 'user', content: user }],
        { jsonMode: true, timeout: cfg.timeout_ms, temperature: temp }
      );

      const raw = stripFences(message?.content || '');
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
      lastErr = err;
      log.warn('qwen-retry', { promptName, attempt, error: err.message });
    }
  }

  throw new Error(`[${promptName}] failed after ${maxRetries + 1} attempts: ${lastErr?.message}`);
}

export async function chatWithTools({ system, user, tools = [], maxIterations = 6, promptName = 'unknown' } = {}) {
  const cfg = loadConfig().llm;

  const toolDefs = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const { message } = await callOllama(
      cfg.endpoint, cfg.model, messages,
      { tools: toolDefs, timeout: cfg.timeout_ms }
    );
    messages.push(message);

    if (!message.tool_calls?.length) {
      return message.content || '';
    }

    for (const call of message.tool_calls) {
      const tool = tools.find(t => t.name === call.function.name);
      if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
      const result = await tool.handler(args);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  throw new Error(`[${promptName}] tool loop hit maxIterations (${maxIterations})`);
}

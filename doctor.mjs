#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const CHECKS = [];
let passed = 0, failed = 0, warned = 0;

function ok(msg)   { console.log(`  ✓ ${msg}`); passed++; }
function fail(msg) { console.log(`  ✗ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠ ${msg}`); warned++; }

async function run() {
  console.log('\nqwen-career doctor\n==================\n');

  // Node version
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) ok(`Node.js >= 18 (${process.version})`);
  else fail(`Node.js >= 18 required (found ${process.version})`);

  // Dependencies
  try {
    readFileSync(resolve('node_modules/playwright/package.json'));
    ok('playwright installed');
  } catch { fail('playwright not installed — run: npm install'); }

  try {
    readFileSync(resolve('node_modules/js-yaml/package.json'));
    ok('js-yaml installed');
  } catch { fail('js-yaml not installed — run: npm install'); }

  try {
    readFileSync(resolve('node_modules/ajv/package.json'));
    ok('ajv installed');
  } catch { fail('ajv not installed — run: npm install'); }

  // Playwright browser
  try {
    execSync('node -e "const {chromium}=require(\'playwright\');chromium.executablePath()"', { stdio: 'pipe' });
    ok('Playwright Chromium available');
  } catch { warn('Playwright Chromium may not be installed — run: npx playwright install chromium'); }

  // User files
  for (const f of ['cv.md', 'config/profile.yml']) {
    if (existsSync(resolve(f))) ok(`${f} found`);
    else fail(`${f} missing${f === 'config/profile.yml' ? ' — copy from config/profile.example.yml' : ''}`);
  }

  // System files
  for (const f of ['templates/cv-template.html', 'generate-pdf.mjs']) {
    if (existsSync(resolve(f))) ok(`${f} present`);
    else fail(`${f} missing`);
  }

  // Fonts
  const fonts = ['fonts/space-grotesk-latin.woff2', 'fonts/dm-sans-latin.woff2'];
  for (const f of fonts) {
    if (existsSync(resolve(f))) ok(`font: ${f}`);
    else warn(`font missing: ${f} — PDF may fall back to system fonts`);
  }

  // Ollama connectivity
  let ollamaOk = false;
  try {
    let endpoint = 'http://127.0.0.1:11434/v1';
    let model = 'qwen3:8b';
    try {
      const cfg = JSON.parse(execSync('node -e "const y=require(\'js-yaml\');const f=require(\'fs\');console.log(JSON.stringify(y.load(f.readFileSync(\'config/profile.yml\',\'utf-8\'))))"', { stdio: 'pipe' }).toString());
      endpoint = cfg.llm?.endpoint || endpoint;
      model    = cfg.llm?.model    || model;
    } catch { /* use defaults */ }

    const res = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || data.models || []).map(m => m.id || m.name);
      ollamaOk = true;
      if (models.some(m => m.includes(model.split(':')[0]))) {
        ok(`Ollama reachable — model '${model}' found`);
      } else {
        warn(`Ollama reachable but '${model}' not in model list: [${models.join(', ')}]`);
        warn(`Run: ollama pull ${model}`);
      }
    } else {
      fail(`Ollama returned ${res.status} at ${endpoint}`);
    }
  } catch (err) {
    fail(`Ollama unreachable: ${err.message}`);
    warn('Start Ollama with: ollama serve');
  }

  // Quick Qwen probe (only if Ollama is up)
  if (ollamaOk) {
    try {
      let endpoint = 'http://127.0.0.1:11434/v1';
      let model = 'qwen3:8b';
      try {
        const cfg = JSON.parse(execSync('node -e "const y=require(\'js-yaml\');const f=require(\'fs\');console.log(JSON.stringify(y.load(f.readFileSync(\'config/profile.yml\',\'utf-8\'))))"', { stdio: 'pipe' }).toString());
        endpoint = cfg.llm?.endpoint || endpoint;
        model    = cfg.llm?.model    || model;
      } catch { /* use defaults */ }

      const t0 = Date.now();
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with {"ok":true}' }], format: 'json', stream: false }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      const latency = Date.now() - t0;
      const content = data.choices?.[0]?.message?.content || '';
      JSON.parse(content.replace(/```json|```/g, '').trim()); // validate JSON
      ok(`Qwen probe OK (${latency}ms)`);
    } catch (err) {
      warn(`Qwen probe failed: ${err.message} — model may not be loaded yet`);
    }
  }

  console.log(`\n${'─'.repeat(44)}`);
  const icon = failed > 0 ? '🔴' : warned > 0 ? '🟡' : '🟢';
  console.log(`${icon}  ${passed} passed, ${failed} failed, ${warned} warnings\n`);

  if (failed > 0) {
    console.log('Fix the errors above before running evaluations.\n');
    process.exit(1);
  }
  if (failed === 0 && warned === 0) {
    console.log('All checks passed. Run: node bin/evaluate.mjs <url>\n');
  }
}

run().catch(err => { console.error(err.message); process.exit(1); });

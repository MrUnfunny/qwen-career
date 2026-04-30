#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';

import { fetchJD }       from '../lib/jd-fetch.mjs';
import { clean }         from '../lib/jd-clean.mjs';
import { chat, loadConfig } from '../lib/qwen.mjs';
import { run as buildReport } from '../lib/report-builder.mjs';
import { tailor as tailorCV }  from '../lib/cv-tailor.mjs';
import { renderPDF }     from '../lib/pdf.mjs';
import { upsert }        from '../lib/tracker.mjs';
import { slug }          from '../lib/slug.mjs';
import { nextReportNum } from '../lib/numbering.mjs';

const USAGE = `
qwen-career evaluate — local Qwen3:8B job evaluation pipeline

Usage:
  node bin/evaluate.mjs <url>
  node bin/evaluate.mjs --jd-file <path> --company <name> --role <title>
  node bin/evaluate.mjs --jd-text "<text>" --company <name> --role <title>

Flags:
  --company <name>     Override company name (auto-detected if URL provided)
  --role <title>       Override role title
  --report-num <NNN>   Override report number (default: auto)
  --tool-calls         Enable Qwen tool-calling mode (experimental)
  --no-pdf             Skip PDF generation
  --no-comp            Skip Block D comp scraping
  --no-tracker         Skip writing to applications.md
  --dry-run            Print plan without calling LLM
  -v, --verbose        Debug logging
  --help               Show this help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'jd-file':    { type: 'string' },
      'jd-text':    { type: 'string' },
      'company':    { type: 'string' },
      'role':       { type: 'string' },
      'report-num': { type: 'string' },
      'tool-calls': { type: 'boolean', default: false },
      'no-pdf':     { type: 'boolean', default: false },
      'no-comp':    { type: 'boolean', default: false },
      'no-tracker': { type: 'boolean', default: false },
      'dry-run':    { type: 'boolean', default: false },
      'verbose':    { type: 'boolean', short: 'v', default: false },
      'help':       { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) { console.log(USAGE); process.exit(0); }
  if (values.verbose) process.env.VERBOSE = '1';

  const url = positionals[0] || null;
  if (!url && !values['jd-file'] && !values['jd-text']) {
    console.error('Error: provide a URL, --jd-file, or --jd-text\n');
    console.error(USAGE);
    process.exit(1);
  }

  // Load config
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Error loading config/profile.yml: ${err.message}`);
    console.error('Copy config/profile.example.yml to config/profile.yml and fill it in.');
    process.exit(1);
  }

  // Respect tool-calls flag
  if (values['tool-calls']) cfg.llm.tool_calls = true;

  // Load CV
  let cv;
  try {
    cv = readFileSync(resolve(cfg.cv?.source || 'cv.md'), 'utf-8');
  } catch {
    console.error('Error: cv.md not found. Add your CV as cv.md in the project root.');
    process.exit(1);
  }

  // Acquire JD
  let jd;
  process.stdout.write('\n📋 Acquiring JD...');
  if (values['jd-text']) {
    jd = clean(values['jd-text']);
  } else if (values['jd-file']) {
    jd = clean(readFileSync(resolve(values['jd-file']), 'utf-8'));
  } else {
    try {
      jd = await fetchJD(url);
    } catch (err) {
      console.error(`\nError fetching JD: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(` ${jd.length} chars`);

  if (values['dry-run']) {
    console.log('\n[dry-run] JD acquired. Would call Qwen for blocks A–F + score + PDF tailoring.');
    console.log(`JD preview:\n${jd.slice(0, 400)}...\n`);
    process.exit(0);
  }

  // Extract meta (unless overridden)
  process.stdout.write('🔍 Extracting role metadata...');
  let meta;
  const schema = JSON.parse(readFileSync(resolve('schemas/jd-meta.json'), 'utf-8'));
  const prompt = readFileSync(resolve('prompts/jd-meta.md'), 'utf-8');
  try {
    meta = await chat({ system: prompt, user: `JD:\n${jd}`, schema, promptName: 'jd-meta' });
  } catch {
    meta = { company: 'Unknown', role: 'Unknown', seniority: 'unknown', location: 'unknown', remote_policy: 'unknown', team_size_hint: 'unknown', domain: 'unknown' };
  }
  if (values.company) meta.company = values.company;
  if (values.role)    meta.role    = values.role;
  console.log(` ${meta.company} — ${meta.role}`);

  const date      = new Date().toISOString().slice(0, 10);
  const compSlug  = slug(meta.company);
  const reportNum = values['report-num'] || nextReportNum('reports');

  console.log(`\n📊 Evaluating (report #${reportNum})...\n`);

  // Run report builder (blocks A–F + score)
  let reportResult;
  try {
    reportResult = await buildReport({
      jd, cv, meta, url: url || '(provided directly)',
      reportNum, date,
      opts: {
        comp: !values['no-comp'] && cfg.comp?.enabled !== false,
      },
    });
  } catch (err) {
    console.error(`\nEvaluation failed: ${err.message}`);
    process.exit(1);
  }

  // Write report
  mkdirSync('reports', { recursive: true });
  const reportPath = resolve(`reports/${reportNum}-${compSlug}-${date}.md`);
  writeFileSync(reportPath, reportResult.markdown, 'utf-8');
  console.log(`\n✅ Report: ${reportPath}`);

  // Generate PDF
  let pdfOk = false;
  let pdfPath = '';
  if (!values['no-pdf']) {
    console.log('\n📄 Generating tailored CV...');
    try {
      const { html } = await tailorCV({ jd, cv, meta });
      mkdirSync('output', { recursive: true });
      const htmlPath = resolve(`output/cv-${compSlug}-${date}.html`);
      pdfPath = resolve(`output/cv-${compSlug}-${date}.pdf`);
      writeFileSync(htmlPath, html, 'utf-8');
      renderPDF(htmlPath, pdfPath, cfg.pdf?.paper || 'a4');
      pdfOk = true;
      console.log(`✅ PDF: ${pdfPath}`);
    } catch (err) {
      console.error(`⚠️  PDF failed: ${err.message}`);
    }
  }

  // Update tracker
  if (!values['no-tracker']) {
    try {
      upsert({
        num: reportNum,
        date,
        company: meta.company,
        role: meta.role,
        score: reportResult.score.overall.toFixed(1),
        status: 'Evaluated',
        pdfOk,
        reportPath: `reports/${reportNum}-${compSlug}-${date}.md`,
        note: reportResult.score.one_liner?.slice(0, 80) || '',
        trackerFile: cfg.tracker?.file,
      });
      console.log(`✅ Tracker updated: ${cfg.tracker?.file || 'data/applications.md'}`);
    } catch (err) {
      console.error(`⚠️  Tracker update failed: ${err.message}`);
    }
  }

  // Summary
  const score = reportResult.score;
  const recLabel = { 'strong-apply': '🟢 STRONG APPLY', 'apply': '🟡 APPLY', 'borderline': '🟠 BORDERLINE', 'skip': '🔴 SKIP' }[score.recommendation] || score.recommendation;
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${meta.company} — ${meta.role}
Score: ${score.overall.toFixed(1)}/5   ${recLabel}
${score.one_liner}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Report: ${reportPath}${pdfOk ? `\nPDF:    ${pdfPath}` : ''}
`);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  if (process.env.VERBOSE) console.error(err.stack);
  process.exit(1);
});

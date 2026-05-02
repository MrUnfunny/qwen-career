#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { clean } from '../lib/jd-clean.mjs';
import { fetchJD } from '../lib/jd-fetch.mjs';
import { chat, loadConfig } from '../lib/qwen.mjs';
import { run as buildReport } from '../lib/report-builder.mjs';
import { tailor as tailorCV } from '../lib/cv-tailor.mjs';
import { renderPDF } from '../lib/pdf.mjs';
import { upsert } from '../lib/tracker.mjs';
import { slug } from '../lib/slug.mjs';
import { nextReportNum } from '../lib/numbering.mjs';
import { initDB, queryJobs, updateJob } from '../lib/store.mjs';

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf-8'));
}

async function preScreen({ job, jd, cv, cfg }) {
  return chat({
    system: readFileSync(resolve('prompts/pre-screen.md'), 'utf-8'),
    user: JSON.stringify({
      role: job.title,
      company: job.company,
      location: job.location,
      experience_years: cfg.search?.experience_years,
      jd: jd.slice(0, 1200),
      cv_summary: cv.slice(0, 1800),
    }, null, 2),
    schema: loadJson('schemas/pre-screen.json'),
    promptName: 'pre-screen',
  });
}

async function evaluateJob(job, { cfg, cv, database, noPdf }) {
  let jd = clean(job.description || '');
  if (jd.length < 300 && job.url) jd = await fetchJD(job.url).catch(() => jd);
  if (jd.length < 150) throw new Error('No usable job description available.');

  const pre = await preScreen({ job, jd, cv, cfg });
  const minEval = cfg.search?.min_eval_score ?? 3.0;
  if (pre.score < minEval) {
    updateJob(job.id, { status: 'skipped', pre_score: pre.score, notes: pre.reason }, database);
    return { skipped: true, pre };
  }

  updateJob(job.id, { status: 'pre_screened', pre_score: pre.score, notes: pre.reason }, database);

  const date = new Date().toISOString().slice(0, 10);
  const reportNum = nextReportNum('reports');
  const meta = {
    company: job.company || 'Unknown',
    role: job.title || 'Unknown',
    seniority: 'unknown',
    location: job.location || 'unknown',
    remote_policy: job.remote ? 'remote' : 'unknown',
    team_size_hint: 'unknown',
    domain: 'unknown',
  };

  const reportResult = await buildReport({
    jd,
    cv,
    meta,
    url: job.url,
    reportNum,
    date,
    opts: { comp: cfg.comp?.enabled !== false },
  });

  mkdirSync('reports', { recursive: true });
  const compSlug = slug(meta.company);
  const reportPath = resolve(`reports/${reportNum}-${compSlug}-${date}.md`);
  writeFileSync(reportPath, reportResult.markdown, 'utf-8');

  let pdfPath = '';
  let pdfOk = false;
  if (!noPdf) {
    const { html } = await tailorCV({ jd, cv, meta });
    mkdirSync('output', { recursive: true });
    const htmlPath = resolve(`output/cv-${compSlug}-${date}.html`);
    pdfPath = resolve(`output/cv-${compSlug}-${date}.pdf`);
    writeFileSync(htmlPath, html, 'utf-8');
    renderPDF(htmlPath, pdfPath, cfg.pdf?.paper || 'a4');
    pdfOk = true;
  }

  upsert({
    num: reportNum,
    date,
    company: meta.company,
    role: meta.role,
    score: reportResult.score.overall.toFixed(1),
    status: 'Evaluated',
    pdfOk,
    reportPath: `reports/${reportNum}-${compSlug}-${date}.md`,
    note: reportResult.score.one_liner?.slice(0, 80) || pre.reason,
    trackerFile: cfg.tracker?.file,
  });

  updateJob(job.id, {
    status: 'evaluated',
    eval_score: reportResult.score.overall,
    eval_report: reportPath,
    eval_pdf: pdfPath || null,
    notes: reportResult.score.one_liner || pre.reason,
  }, database);

  return { skipped: false, pre, score: reportResult.score, reportPath, pdfPath };
}

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', default: '10' },
      'no-pdf': { type: 'boolean', default: false },
    },
  });

  const cfg = loadConfig();
  const database = initDB();
  const cv = readFileSync(resolve(cfg.cv?.source || 'cv.md'), 'utf-8');
  const jobs = queryJobs({ status: 'pending', limit: Number(values.limit) || 10 }, database);

  if (!jobs.length) {
    console.log('No pending jobs to evaluate.');
    return;
  }

  let done = 0;
  for (const job of jobs) {
    done++;
    process.stdout.write(`[${done}/${jobs.length}] ${job.company} - ${job.title} ... `);
    try {
      const result = await evaluateJob(job, { cfg, cv, database, noPdf: values['no-pdf'] });
      if (result.skipped) console.log(`${result.pre.score}/5 skipped - ${result.pre.reason}`);
      else console.log(`${result.score.overall.toFixed(1)}/5 evaluated`);
    } catch (err) {
      updateJob(job.id, { status: 'skipped', notes: `Evaluation failed: ${err.message}` }, database);
      console.log(`failed - ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  if (process.env.VERBOSE) console.error(err.stack);
  process.exit(1);
});

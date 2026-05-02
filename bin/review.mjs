#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync } from 'node:fs';
import { initDB, queryJobs, updateJob } from '../lib/store.mjs';
import { loadConfig } from '../lib/qwen.mjs';

function label(score) {
  if (score >= 4.2) return 'STRONG APPLY';
  if (score >= 3.8) return 'APPLY';
  return 'REVIEW';
}

async function main() {
  const cfg = loadConfig();
  const database = initDB();
  const minScore = cfg.search?.min_apply_score ?? 3.8;
  const jobs = queryJobs({ status: 'evaluated', minScore, orderBy: 'eval_score DESC', limit: 100 }, database);

  if (!jobs.length) {
    console.log(`No evaluated jobs at or above ${minScore}/5.`);
    return;
  }

  const rl = createInterface({ input, output });
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      console.log('\n----------------------------------------');
      console.log(`[${i + 1}/${jobs.length}] Score: ${Number(job.eval_score).toFixed(1)}/5 ${label(job.eval_score)}`);
      console.log(`Company: ${job.company}`);
      console.log(`Role:    ${job.title}`);
      console.log(`Source:  ${job.source}`);
      console.log(`URL:     ${job.url}`);
      if (job.notes) console.log(`Notes:   ${job.notes}`);
      console.log('----------------------------------------');
      const answer = (await rl.question('[a]pply  [s]kip  [m]anual  [r]eport  [q]uit: ')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 'r') {
        if (job.eval_report) console.log(readFileSync(job.eval_report, 'utf-8'));
        i--;
        continue;
      }
      if (answer === 'a') updateJob(job.id, { status: 'approved' }, database);
      else if (answer === 's') updateJob(job.id, { status: 'skipped' }, database);
      else if (answer === 'm') updateJob(job.id, { status: 'manual', apply_result: 'manual' }, database);
      else i--;
    }
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

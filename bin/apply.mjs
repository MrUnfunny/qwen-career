#!/usr/bin/env node
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { loadConfig } from '../lib/qwen.mjs';
import { initDB, queryJobs, updateJob, logApplyAttempt, countApplyAttemptsToday } from '../lib/store.mjs';
import { applyJob, delayMs } from '../lib/applier/index.mjs';

async function browserFor(job, cfg) {
  if (job.apply_type === 'easy_apply' || job.source === 'linkedin') {
    const { chromium: patchrightChromium } = await import('patchright');
    return patchrightChromium.launch({ headless: false });
  }
  return chromium.launch({ headless: false });
}

async function contextFor(browser, job, cfg) {
  const stateFile = cfg.apply?.linkedin_session_file || 'data/linkedin-session.json';
  if ((job.apply_type === 'easy_apply' || job.source === 'linkedin') && existsSync(stateFile)) {
    return browser.newContext({ storageState: stateFile });
  }
  return browser.newContext();
}

async function main() {
  const cfg = loadConfig();
  if (cfg.apply?.enabled !== true) {
    console.log('Auto-apply is disabled. Set apply.enabled: true in config/profile.yml after reviewing jobs.');
    return;
  }

  const database = initDB();
  const dailyCap = cfg.apply?.daily_cap ?? 30;
  const alreadyApplied = countApplyAttemptsToday(database);
  const remaining = Math.max(0, dailyCap - alreadyApplied);
  if (remaining <= 0) {
    console.log(`Daily cap reached (${dailyCap}).`);
    return;
  }

  const jobs = queryJobs({ status: 'approved', limit: remaining }, database)
    .filter(job => cfg.apply?.platforms?.[job.source] !== false && cfg.apply?.platforms?.[job.apply_type] !== false);

  if (!jobs.length) {
    console.log('No approved jobs to apply.');
    return;
  }

  let submitted = 0;
  let failed = 0;
  for (const job of jobs) {
    console.log(`Applying: ${job.company} - ${job.title}`);
    let browser;
    try {
      browser = await browserFor(job, cfg);
      const context = await contextFor(browser, job, cfg);
      const page = await context.newPage();
      const result = await applyJob({ job, profile: cfg, page });
      const status = result.success ? 'applied' : 'approved';
      const applyResult = result.success ? 'submitted' : (result.skipped ? 'skipped' : 'failed');
      updateJob(job.id, { status, apply_result: applyResult, notes: result.error || job.notes }, database);
      logApplyAttempt({ job_id: job.id, result: applyResult, error: result.error || '' }, database);
      if (result.success) {
        submitted++;
        mkdirSync('data', { recursive: true });
        appendFileSync(cfg.tracker?.file || 'data/applications.md', `\n- ${new Date().toISOString().slice(0, 10)} Applied: ${job.company} - ${job.title} (${job.url})\n`, 'utf-8');
      } else {
        failed++;
        console.warn(`  failed: ${result.error}`);
      }
      await context.close().catch(() => {});
    } catch (err) {
      failed++;
      updateJob(job.id, { apply_result: 'failed', notes: err.message }, database);
      logApplyAttempt({ job_id: job.id, result: 'failed', error: err.message }, database);
      console.warn(`  failed: ${err.message}`);
    } finally {
      await browser?.close().catch(() => {});
    }
    const wait = delayMs(cfg.apply?.delay_between_ms ?? 12000);
    if (jobs.indexOf(job) < jobs.length - 1) await new Promise(resolve => setTimeout(resolve, wait));
  }

  console.log(`Applied: ${submitted} | Failed/skipped: ${failed} | Remaining cap: ${Math.max(0, remaining - submitted)}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  if (process.env.VERBOSE) console.error(err.stack);
  process.exit(1);
});

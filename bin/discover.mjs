#!/usr/bin/env node
import { discover } from '../lib/scrapers/index.mjs';
import { initDB } from '../lib/store.mjs';
import { loadConfig } from '../lib/qwen.mjs';

async function main() {
  const cfg = loadConfig();
  const database = initDB();
  const summary = await discover({ cfg, database });
  const bySource = Object.entries(summary.bySource)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${source}: ${count}`)
    .join(', ');

  console.log(`${summary.newJobs} new jobs found${bySource ? ` (${bySource})` : ''}.`);
  console.log(`${summary.discovered} raw jobs discovered; ${summary.skipped} filtered.`);
  if (summary.errors.length) {
    console.warn(`Warnings: ${summary.errors.length}`);
    for (const err of summary.errors.slice(0, 5)) console.warn(`- ${err}`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  if (process.env.VERBOSE) console.error(err.stack);
  process.exit(1);
});

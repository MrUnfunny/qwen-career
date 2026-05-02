import { loadConfig } from '../qwen.mjs';
import { initDB, upsertJob } from '../store.mjs';
import { getSearchConfig, matchesSearch } from './common.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';
import * as workable from './workable.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as jobspy from './jobspy-bridge.mjs';
import * as wellfound from './wellfound.mjs';
import * as instahyre from './instahyre.mjs';

const ATS = { greenhouse, lever, ashby, workable, smartrecruiters };

export async function discover({ cfg = loadConfig(), database = initDB() } = {}) {
  const search = getSearchConfig(cfg);
  const bySource = new Map();
  const errors = [];
  const jobs = [];

  if (cfg.sources?.ats_apis?.enabled !== false) {
    const companies = cfg.sources?.ats_apis?.companies || [];
    const settled = await Promise.allSettled(companies.map(async company => {
      const scraper = ATS[company.ats];
      if (!scraper) throw new Error(`Unknown ATS: ${company.ats}`);
      return scraper.search({ company, search });
    }));
    for (const result of settled) {
      if (result.status === 'fulfilled') jobs.push(...result.value);
      else errors.push(result.reason?.message || String(result.reason));
    }
  }

  if (cfg.sources?.jobspy?.enabled) {
    const hoursOld = Math.max(1, Number(search.datePostedDays || 7) * 24);
    jobs.push(...await jobspy.search({
      boards: cfg.sources.jobspy.boards || ['linkedin', 'indeed', 'naukri'],
      keywords: search.keywords,
      locations: search.locations,
      resultsPerBoard: cfg.sources.jobspy.results_per_board || 50,
      hoursOld,
    }));
  }

  if (cfg.sources?.playwright_scrapers?.enabled) {
    const boards = cfg.sources.playwright_scrapers.boards || [];
    if (boards.includes('wellfound')) jobs.push(...await wellfound.search({ search }));
    if (boards.includes('instahyre')) jobs.push(...await instahyre.search({ search }));
  }

  const seen = new Set();
  let inserted = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (!job.url || seen.has(job.url)) continue;
    seen.add(job.url);
    if (!matchesSearch(job, search)) {
      skipped++;
      continue;
    }
    const result = upsertJob(job, database);
    if (result.inserted) inserted++;
    bySource.set(job.source || 'unknown', (bySource.get(job.source || 'unknown') || 0) + (result.inserted ? 1 : 0));
  }

  return {
    discovered: jobs.length,
    newJobs: inserted,
    skipped,
    bySource: Object.fromEntries(bySource),
    errors,
  };
}

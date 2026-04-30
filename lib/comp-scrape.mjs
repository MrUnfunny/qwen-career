import { chromium } from 'playwright';
import { log } from './log.mjs';

const TIMEOUT = 15000;

async function scrapeGlassdoor(page, company, role) {
  try {
    const query = encodeURIComponent(`${role} ${company} salary`);
    await page.goto(`https://www.glassdoor.com/Search/results.htm?keyword=${query}`, {
      waitUntil: 'domcontentloaded', timeout: TIMEOUT,
    });
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => document.body.innerText);
    const salaryMatch = text.match(/\$[\d,]+K?\s*[-–]\s*\$[\d,]+K?/i);
    if (salaryMatch) {
      return {
        source: 'glassdoor',
        raw: salaryMatch[0],
        url: page.url(),
      };
    }
    return null;
  } catch (err) {
    log.warn('comp-scrape-glassdoor', { error: err.message });
    return null;
  }
}

async function scrapeLevelsfyi(page, company, role) {
  try {
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    await page.goto(`https://www.levels.fyi/companies/${companySlug}/salaries/`, {
      waitUntil: 'domcontentloaded', timeout: TIMEOUT,
    });
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => document.body.innerText);

    // Look for median TC pattern
    const tcMatch = text.match(/(?:median|average|total comp)[^\n]*?\$[\d,]+K?/i)
      || text.match(/\$[\d,]+K?\s*(?:median|average|total comp)/i);

    // Look for salary range
    const rangeMatch = text.match(/\$[\d,]+K?\s*[-–]\s*\$[\d,]+K?/i);

    if (tcMatch || rangeMatch) {
      return {
        source: 'levels.fyi',
        raw: (tcMatch?.[0] || '') + (rangeMatch ? ` Range: ${rangeMatch[0]}` : ''),
        url: page.url(),
      };
    }
    return null;
  } catch (err) {
    log.warn('comp-scrape-levelsfyi', { error: err.message });
    return null;
  }
}

export async function scrapeComp({ company, role } = {}) {
  const results = { data: [], sources: [], errors: [] };
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    const gd = await scrapeGlassdoor(page, company, role);
    if (gd) { results.data.push(gd); results.sources.push(gd.url); }
    else results.errors.push('glassdoor: no salary data found');

    const lf = await scrapeLevelsfyi(page, company, role);
    if (lf) { results.data.push(lf); results.sources.push(lf.url); }
    else results.errors.push('levels.fyi: no data found');

  } catch (err) {
    results.errors.push(`browser: ${err.message}`);
    log.error('comp-scrape', { error: err.message });
  } finally {
    await browser?.close();
  }

  return results;
}

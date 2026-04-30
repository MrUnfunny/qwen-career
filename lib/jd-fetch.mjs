import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { clean } from './jd-clean.mjs';
import { slug } from './slug.mjs';

export async function fetchJD(url, { cache = true } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => document.body.innerText);
    const cleaned = clean(text);

    if (cleaned.length < 150) {
      throw new Error(
        `Fetched content too short (${cleaned.length} chars) — site may require login or blocked the request.\n` +
        `Tip: save the JD to a file and use --jd-file <path> instead.`
      );
    }

    if (cache) {
      mkdirSync('jds', { recursive: true });
      const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; } })();
      const date = new Date().toISOString().slice(0, 10);
      writeFileSync(resolve(`jds/${slug(host)}-${date}.txt`), cleaned, 'utf-8');
    }

    return cleaned;
  } finally {
    await browser?.close();
  }
}

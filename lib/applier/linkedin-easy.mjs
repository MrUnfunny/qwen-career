import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { answerFields } from './form-fill.mjs';

async function fillVisibleInputs(page, job, profile) {
  const fields = [];
  const controls = page.locator('.jobs-easy-apply-modal input:not([type=hidden]), .jobs-easy-apply-modal textarea, .jobs-easy-apply-modal select');
  const count = await controls.count();
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = await control.evaluate(el => {
      const id = el.id;
      return (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText : '') ||
        el.closest('label')?.innerText ||
        el.getAttribute('aria-label') ||
        el.closest('div')?.innerText ||
        el.name ||
        id ||
        '';
    });
    const id = await control.evaluate((el, index) => el.id || el.name || `field_${index}`, i);
    const type = await control.evaluate(el => el.getAttribute('type') || el.tagName.toLowerCase());
    fields.push({ id, label, type, index: i, required: true });
  }
  const answers = await answerFields({ fields, job, profile });
  for (const field of fields) {
    const value = answers[field.id];
    if (value === undefined || value === null || value === 'MANUAL_REVIEW_REQUIRED') continue;
    const control = controls.nth(field.index);
    const type = await control.evaluate(el => (el.getAttribute('type') || '').toLowerCase());
    if (type !== 'file' && type !== 'checkbox' && type !== 'radio') await control.fill(String(value)).catch(() => {});
  }
}

export async function apply({ job, profile, page }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /easy apply/i }).first().click({ timeout: 10000 });

  for (let step = 0; step < 8; step++) {
    const modalText = await page.locator('.jobs-easy-apply-modal').innerText().catch(() => '');
    if (/captcha|security verification/i.test(modalText)) {
      throw new Error('LinkedIn CAPTCHA/security check appeared; solve manually and rerun.');
    }

    await fillVisibleInputs(page, job, profile);

    const next = page.getByRole('button', { name: /next|review/i }).last();
    const submit = page.getByRole('button', { name: /^submit application$/i }).last();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
      await page.waitForTimeout(2500);
      break;
    }
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(1200);
      continue;
    }
    break;
  }

  mkdirSync('data/apply-screenshots', { recursive: true });
  const screenshotPath = resolve(`data/apply-screenshots/${job.id}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const text = await page.locator('body').innerText().catch(() => '');
  const success = /application submitted|your application was sent/i.test(text);
  return { success, screenshotPath, error: success ? '' : 'Could not detect LinkedIn confirmation.' };
}

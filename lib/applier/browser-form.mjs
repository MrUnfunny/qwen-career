import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { answerFields } from './form-fill.mjs';

async function fieldLabel(locator) {
  return locator.evaluate(el => {
    const id = el.id;
    const aria = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText : '';
    const wrapped = el.closest('label')?.innerText;
    const parent = el.closest('div,fieldset,section')?.innerText;
    return (byFor || wrapped || aria || placeholder || parent || el.name || id || '').trim().slice(0, 300);
  });
}

async function extractFields(page) {
  const fields = [];
  const controls = page.locator('input:not([type=hidden]), textarea, select');
  const count = await controls.count();
  for (let i = 0; i < count; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const tag = await el.evaluate(node => node.tagName.toLowerCase());
    const type = await el.evaluate(node => node.getAttribute('type') || node.tagName.toLowerCase());
    const id = await el.evaluate((node, index) => node.id || node.name || `field_${index}`, i);
    const label = await fieldLabel(el);
    const required = await el.evaluate(node => node.required || node.getAttribute('aria-required') === 'true');
    const options = tag === 'select'
      ? await el.evaluate(node => Array.from(node.options).map(o => o.textContent.trim()).filter(Boolean))
      : [];
    fields.push({ id, label, type, options, required, index: i });
  }
  return fields;
}

async function fillField(page, field, value) {
  if (value === undefined || value === null || String(value) === 'MANUAL_REVIEW_REQUIRED') return;
  const el = page.locator('input:not([type=hidden]), textarea, select').nth(field.index);
  const tag = await el.evaluate(node => node.tagName.toLowerCase());
  const type = await el.evaluate(node => (node.getAttribute('type') || '').toLowerCase());
  if (tag === 'select') {
    await el.selectOption({ label: String(value) }).catch(() => el.selectOption(String(value)).catch(() => {}));
  } else if (type === 'checkbox') {
    const checked = value === true || /^(yes|true|1|on)$/i.test(String(value));
    await el.setChecked(checked).catch(() => {});
  } else if (type === 'radio') {
    if (/^(yes|true|1|on)$/i.test(String(value))) await el.check().catch(() => {});
  } else if (type !== 'file') {
    await el.fill(String(value)).catch(() => {});
  }
}

export async function applyGenericForm({ page, job, profile, submitText = /submit|apply/i } = {}) {
  const url = job.apply_url || job.url;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);

  const fields = await extractFields(page);
  const answers = await answerFields({ fields, job, profile, answers: profile.apply?.answers || {} });
  for (const field of fields) await fillField(page, field, answers[field.id]);

  if (job.eval_pdf && existsSync(resolve(job.eval_pdf))) {
    const fileInputs = page.locator('input[type=file]');
    const count = await fileInputs.count();
    for (let i = 0; i < count; i++) {
      await fileInputs.nth(i).setInputFiles(resolve(job.eval_pdf)).catch(() => {});
    }
  }

  const button = page.getByRole('button', { name: submitText }).first();
  if (await button.isVisible().catch(() => false)) await button.click();
  else await page.locator('input[type=submit], button[type=submit]').first().click();

  await page.waitForTimeout(2500);
  mkdirSync('data/apply-screenshots', { recursive: true });
  const screenshotPath = resolve(`data/apply-screenshots/${job.id}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const body = await page.locator('body').innerText().catch(() => '');
  const success = /thank you|application submitted|received|success/i.test(body);
  return { success, screenshotPath, error: success ? '' : 'Could not detect confirmation text after submit.' };
}

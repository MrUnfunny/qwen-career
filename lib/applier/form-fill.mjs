import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chat, loadConfig } from '../qwen.mjs';

const FACTS = [
  ['years', 'years_experience'],
  ['experience', 'years_experience'],
  ['notice', 'notice_period_days'],
  ['salary', 'expected_salary_inr'],
  ['ctc', 'expected_salary_inr'],
  ['relocate', 'willing_to_relocate'],
  ['visa', 'visa_sponsorship_needed'],
  ['sponsorship', 'visa_sponsorship_needed'],
  ['authorization', 'work_authorization'],
  ['authorisation', 'work_authorization'],
];

function factualAnswer(label, answers = {}) {
  const lower = label.toLowerCase();
  for (const [needle, key] of FACTS) {
    if (lower.includes(needle) && answers[key] !== undefined) return answers[key];
  }
  return undefined;
}

function chooseOption(options = [], value) {
  if (!options?.length) return value;
  const text = String(value).toLowerCase();
  return options.find(o => String(o).toLowerCase() === text)
    || options.find(o => String(o).toLowerCase().includes(text))
    || options.find(o => text.includes(String(o).toLowerCase()))
    || options[0];
}

export async function answerFields({ fields = [], job = {}, profile = loadConfig(), answers = profile.apply?.answers || {} } = {}) {
  const output = {};
  const unknown = [];

  for (const field of fields) {
    const label = field.label || field.name || field.id || '';
    const factual = factualAnswer(label, answers);
    if (factual !== undefined) {
      output[field.id] = chooseOption(field.options, factual);
      continue;
    }
    if (/cover letter/i.test(label) && answers.cover_letter === 'skip') {
      output[field.id] = '';
      continue;
    }
    unknown.push(field);
  }

  if (!unknown.length) return output;

  const cv = readFileSync(resolve(profile.cv?.source || 'cv.md'), 'utf-8');
  const result = await chat({
    system: `Answer job application form fields using only the provided profile, facts, CV, and job description.
Return valid JSON shaped as {"answers":{"field id":"value"}}.
Never invent factual numbers. If a required factual answer is not available, return "MANUAL_REVIEW_REQUIRED".`,
    user: JSON.stringify({
      job: {
        title: job.title,
        company: job.company,
        description: String(job.description || '').slice(0, 6000),
      },
      profile: profile.user,
      facts: answers,
      cv: cv.slice(0, 9000),
      fields: unknown.map(f => ({
        id: f.id,
        label: f.label,
        type: f.type,
        options: f.options || [],
        required: !!f.required,
      })),
    }, null, 2),
    promptName: 'form-fill',
  });

  for (const field of unknown) {
    const value = result.answers?.[field.id] ?? '';
    output[field.id] = chooseOption(field.options, value);
  }
  return output;
}

export async function test() {
  const cfg = loadConfig();
  const answers = await answerFields({
    profile: cfg,
    job: { title: 'Backend Engineer', company: 'Example', description: 'Node.js, distributed systems.' },
    fields: [
      { id: 'yoe', label: 'Years of experience', type: 'number', required: true },
      { id: 'notice', label: 'Notice period', type: 'text', required: true },
      { id: 'why', label: 'Why do you want this role?', type: 'textarea', required: true },
    ],
  });
  console.log(JSON.stringify(answers, null, 2));
}

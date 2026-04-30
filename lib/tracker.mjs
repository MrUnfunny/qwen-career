import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const HEADER  = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const DIVIDER = '|---|------|---------|------|-------|--------|-----|--------|-------|';

function parseRows(content) {
  const rows = [];
  let pastHeader = 0; // 0=pre, 1=header, 2=divider, 3=data
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (pastHeader === 0) { pastHeader = 1; continue; }
    if (pastHeader === 1) { pastHeader = 2; continue; }
    const cols = line.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 9) continue;
    rows.push({
      num: cols[0], date: cols[1], company: cols[2], role: cols[3],
      score: cols[4], status: cols[5], pdf: cols[6], report: cols[7], notes: cols[8],
    });
  }
  return rows;
}

function rowToLine(r) {
  return `| ${r.num} | ${r.date} | ${r.company} | ${r.role} | ${r.score} | ${r.status} | ${r.pdf} | ${r.report} | ${r.notes} |`;
}

export function upsert({ num, date, company, role, score, status = 'Evaluated', pdfOk, reportPath, note = '', trackerFile } = {}) {
  const file = resolve(trackerFile || 'data/applications.md');
  mkdirSync('data', { recursive: true });

  let existing = [];
  let preamble = '# Applications Tracker';
  try {
    const content = readFileSync(file, 'utf-8');
    preamble = content.split('\n').filter(l => !l.startsWith('|')).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    existing = parseRows(content);
  } catch { /* new file */ }

  const pdf    = pdfOk ? '✅' : '❌';
  const report = reportPath ? `[${num}](${reportPath})` : '-';
  const newRow = { num: String(num), date, company, role, score: `${score}/5`, status, pdf, report, notes: note };

  const idx = existing.findIndex(
    r => r.company.toLowerCase() === company.toLowerCase() &&
         r.role.toLowerCase()    === role.toLowerCase()
  );

  if (idx >= 0) {
    existing[idx] = newRow;
  } else {
    existing.push(newRow);
  }

  const table = [HEADER, DIVIDER, ...existing.map(rowToLine)].join('\n');
  writeFileSync(file, `${preamble}\n\n${table}\n`, 'utf-8');
}

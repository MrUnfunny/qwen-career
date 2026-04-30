import { readdirSync } from 'fs';

export function nextReportNum(reportsDir = 'reports') {
  let max = 0;
  try {
    for (const f of readdirSync(reportsDir)) {
      const m = f.match(/^(\d+)-/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch { /* dir empty or missing */ }
  return String(max + 1).padStart(3, '0');
}

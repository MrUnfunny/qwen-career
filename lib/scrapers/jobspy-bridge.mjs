import { spawnSync } from 'node:child_process';
import { inferRemote } from './common.mjs';

function pythonCmd() {
  for (const cmd of ['python3', 'python']) {
    const res = spawnSync(cmd, ['-c', 'import sys; print(sys.version)'], { encoding: 'utf-8' });
    if (res.status === 0) return cmd;
  }
  return null;
}

function normalize(row) {
  const url = row.job_url || row.job_url_direct || row.url;
  const location = row.location || '';
  const description = row.description || '';
  const source = String(row.site || row.source || 'jobspy').toLowerCase();
  return {
    url,
    apply_url: row.job_url_direct || url,
    title: row.title || '',
    company: row.company || '',
    location,
    remote: inferRemote(location, description),
    source,
    apply_type: source === 'linkedin' && /easy apply/i.test(row.job_type || '') ? 'easy_apply' : source === 'naukri' ? 'naukri' : 'external',
    description,
    date_posted: row.date_posted || '',
  };
}

export async function search({ boards = [], keywords = [], locations = [], resultsPerBoard = 50, hoursOld = 168 } = {}) {
  const cmd = pythonCmd();
  if (!cmd) {
    console.warn('[jobspy] Python not found; skipping JobSpy discovery.');
    return [];
  }

  const code = `
import json, sys
try:
    from jobspy import scrape_jobs
except Exception as exc:
    print(json.dumps({"error": "jobspy unavailable: " + str(exc)}))
    sys.exit(3)

boards = json.loads(sys.argv[1])
term = sys.argv[2]
location = sys.argv[3]
results = int(sys.argv[4])
hours_old = int(sys.argv[5])
jobs = scrape_jobs(site_name=boards, search_term=term, location=location, results_wanted=results, hours_old=hours_old)
print(jobs.to_json(orient="records"))
`.trim();

  const all = [];
  for (const keyword of keywords) {
    for (const location of locations) {
      const res = spawnSync(cmd, ['-c', code, JSON.stringify(boards), keyword, location, String(resultsPerBoard), String(hoursOld)], {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (res.status !== 0) {
        const msg = res.stderr || res.stdout || `exit ${res.status}`;
        console.warn(`[jobspy] ${keyword} / ${location}: ${msg.trim().slice(0, 300)}`);
        continue;
      }
      try {
        const parsed = JSON.parse(res.stdout.trim());
        if (parsed?.error) {
          console.warn(`[jobspy] ${parsed.error}`);
          return [];
        }
        all.push(...parsed.map(normalize).filter(j => j.url));
      } catch (err) {
        console.warn(`[jobspy] Could not parse JSON: ${err.message}`);
      }
    }
  }
  return all;
}

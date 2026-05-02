# Plan: Job Discovery + Auto-Apply Pipeline

## Research summary

| Insight | Impact on design |
|---|---|
| ATS platforms (Greenhouse, Lever, Ashby, Workable) expose **public JSON APIs** | Scrape with plain `fetch` — no browser, no anti-bot risk |
| **JobSpy** (Python, 3.3K★) is the best multi-board HTTP scraper (LinkedIn, Indeed, Glassdoor, Naukri, Bayt) | Bridge via Python subprocess; avoids rebuilding what's already battle-tested |
| **Patchright** (patched Playwright) is current state-of-the-art for undetected LinkedIn automation | Replace stock Playwright with Patchright for the apply stage only |
| Every auto-apply project that skipped human review got accounts banned or sent bad applications | Hard rule: **nothing submits without human approval** |
| Generating full CV tailoring for every discovered job is token-expensive | Score-gate: only run full eval on jobs scoring ≥ threshold in a fast pre-screen |
| `undetected-chromedriver` / Selenium are increasingly fingerprinted by LinkedIn | Playwright + Patchright only — never Selenium |
| GitHub Actions as free scheduler is sufficient for personal use | Daily discovery cron via `node bin/discover.mjs` |

### Notable open-source projects surveyed

| Project | Type | Boards | Stars | Key Takeaway |
|---|---|---|---|---|
| JobSpy (speedyapply) | Scraper lib | LinkedIn, Indeed, Glassdoor, Naukri, Bayt | 3.3K | Best multi-board HTTP scraper; use as Python bridge |
| AIHawk | Auto-apply | LinkedIn | 29.7K | Archived; Selenium-based; proves LLM Q&A works |
| LinkedIn-AI-Applier-Ultimate | Auto-apply | LinkedIn | 86 | Active AIHawk fork; uses Patchright — copy this approach |
| ApplyPilot | Full pipeline | LinkedIn, Indeed, Glassdoor, Workday, 48 employers | 899 | Best end-to-end reference; score-gates tailoring |
| adgramigna/job-board-scraper | ETL | Greenhouse, Lever, Ashby, Rippling | 41 | Proves ATS public API approach works at scale |
| OpenJobs | ATS harvester | 13 ATS platforms, 12K companies | 10 | Company→ATS mapping dataset we can reuse |
| Find-Me-Job | Scrape+score | LinkedIn, RemoteOK | 15 | Score-gated cover letter pattern — token efficient |
| Resume-Matcher | CV tailoring | N/A | 26.9K | Resume scoring/tailoring component reference |

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PHASE 1 — DISCOVERY                      │
│  bin/discover.mjs                                           │
│                                                             │
│  Tier A: ATS APIs (no browser)                              │
│    Greenhouse · Lever · Ashby · Workable · SmartRecruiters  │
│                                                             │
│  Tier B: JobSpy bridge (Python subprocess)                  │
│    LinkedIn · Indeed · Glassdoor · Naukri · Bayt            │
│                                                             │
│  Tier C: Playwright fallback (optional)                     │
│    Wellfound · Instahyre · direct career pages              │
│                              │                              │
│                    dedup → SQLite jobs.db                   │
└─────────────────────────────────────────────────────────────┘
                               │ new jobs
┌─────────────────────────────────────────────────────────────┐
│                    PHASE 2 — EVALUATION                     │
│  bin/batch-eval.mjs                                         │
│                                                             │
│  Fast pre-screen (Qwen, 1 call) → score 1–5                 │
│    if score < min_eval_score: mark "skip", stop             │
│    if score ≥ min_eval_score: run full 7-block pipeline     │
│    (reuses existing evaluate.mjs pipeline unchanged)        │
└─────────────────────────────────────────────────────────────┘
                               │ scored jobs
┌─────────────────────────────────────────────────────────────┐
│              PHASE 3 — HUMAN REVIEW (mandatory gate)        │
│  bin/review.mjs                                             │
│                                                             │
│  Interactive TUI: score · title · company · one-liner       │
│  User marks each: [a]pply / [s]kip / [m]anual              │
│  "manual" = you apply yourself; bot skips it                │
└─────────────────────────────────────────────────────────────┘
                               │ approved queue
┌─────────────────────────────────────────────────────────────┐
│                    PHASE 4 — AUTO-APPLY                     │
│  bin/apply.mjs                                              │
│                                                             │
│  Per-platform adapters (Playwright + Patchright):           │
│    LinkedIn Easy Apply                                      │
│    Greenhouse · Lever · Ashby (Qwen-powered form fill)      │
│    Naukri Quick Apply                                       │
│                                                             │
│  Qwen answers screening questions from profile.yml context  │
│  Daily cap: 30 applications max (configurable)              │
└─────────────────────────────────────────────────────────────┘
```

---

## New files to create

```
lib/
  store.mjs                    # SQLite job store (better-sqlite3)
  scrapers/
    index.mjs                  # fan-out + dedup orchestrator
    greenhouse.mjs             # public API: boards.greenhouse.io/v1/boards/{slug}/jobs
    lever.mjs                  # public API: api.lever.co/v0/postings/{slug}
    ashby.mjs                  # public API: api.ashbyhq.com/jobBoard.listJobPostings
    workable.mjs               # public API: apply.workable.com/api/v3/accounts/{slug}/jobs
    smartrecruiters.mjs        # public API: api.smartrecruiters.com/v1/companies/{slug}/postings
    jobspy-bridge.mjs          # spawn Python jobspy → parse stdout JSON
    wellfound.mjs              # Playwright scrape (optional, Tier C)
    instahyre.mjs              # Playwright scrape (optional, Tier C)
  applier/
    index.mjs                  # router: pick adapter by apply_type
    form-fill.mjs              # Qwen-powered: answer unknown form fields
    linkedin-easy.mjs          # Patchright: LinkedIn Easy Apply modal flow
    greenhouse-apply.mjs       # Playwright: Greenhouse application form
    lever-apply.mjs            # Playwright: Lever application form
    ashby-apply.mjs            # Playwright: Ashby application form
    naukri-apply.mjs           # Playwright: Naukri Quick Apply
bin/
  discover.mjs                 # run all scrapers, write new jobs to DB
  batch-eval.mjs               # pre-screen + full eval on pending jobs
  review.mjs                   # interactive review TUI
  apply.mjs                    # process approved queue
prompts/
  pre-screen.md                # new: fast 1-call job fitness score
data/
  jobs.db                      # SQLite (gitignored)
  linkedin-session.json        # saved LinkedIn cookies (gitignored)
```

### Existing files — no changes needed

The entire `lib/report-builder.mjs`, `lib/cv-tailor.mjs`, `lib/qwen.mjs`, `bin/evaluate.mjs` stack is reused as-is. `batch-eval.mjs` calls the same `buildReport()` function that `evaluate.mjs` already calls.

---

## Database schema (`data/jobs.db`)

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,        -- SHA256(url) first 16 chars
  url           TEXT UNIQUE NOT NULL,
  apply_url     TEXT,
  title         TEXT,
  company       TEXT,
  location      TEXT,
  remote        INTEGER,                 -- 0 | 1
  source        TEXT,                    -- 'greenhouse' | 'lever' | 'linkedin' | ...
  apply_type    TEXT,                    -- 'easy_apply' | 'greenhouse' | 'lever' | 'naukri' | 'external'
  description   TEXT,
  date_posted   TEXT,
  date_found    TEXT NOT NULL,
  status        TEXT DEFAULT 'pending',  -- pending | pre_screened | evaluated | approved | applied | skipped
  pre_score     REAL,                    -- fast pre-screen score (1–5)
  eval_score    REAL,                    -- full eval overall score
  eval_report   TEXT,                    -- path to .md report
  eval_pdf      TEXT,                    -- path to tailored CV .pdf
  apply_result  TEXT,                    -- 'submitted' | 'failed' | 'manual'
  notes         TEXT
);

CREATE TABLE apply_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT REFERENCES jobs(id),
  attempted_at  TEXT NOT NULL,
  result        TEXT,                    -- 'submitted' | 'failed' | 'skipped'
  error         TEXT
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_source ON jobs(source);
CREATE INDEX idx_jobs_date_found ON jobs(date_found);
```

---

## Config additions to `profile.yml`

```yaml
search:
  keywords:
    - "Software Engineer"
    - "Backend Engineer"
    - "SDE"
  locations:
    - "Bangalore, India"
    - "Remote"
  experience_years: 3             # used in pre-screen prompt and form-fill answers
  min_eval_score: 3.0             # pre-screen threshold — full eval only above this
  min_apply_score: 3.8            # offer for apply only above this full score
  date_posted_days: 7             # ignore jobs older than N days
  blocked_companies:
    - "Wipro"
    - "Infosys"
  blocked_keywords:               # skip if job title contains these (case-insensitive)
    - "intern"
    - "contract"
    - "freelance"

sources:
  ats_apis:
    enabled: true
    companies:                    # explicit target companies list
      - { name: "Stripe",    ats: "greenhouse",     slug: "stripe" }
      - { name: "Notion",    ats: "ashby",          slug: "notion" }
      - { name: "Razorpay",  ats: "lever",          slug: "razorpay" }
      - { name: "Zepto",     ats: "greenhouse",     slug: "zepto" }
      - { name: "CRED",      ats: "lever",          slug: "cred" }
  jobspy:
    enabled: true                 # requires: pip install jobspy
    boards: [linkedin, indeed, naukri, glassdoor]
    results_per_board: 50
    proxies: []                   # list of proxy URLs for rate-limit avoidance
  playwright_scrapers:
    enabled: false                # slower; enable only if jobspy misses boards you need
    boards: [wellfound, instahyre]

apply:
  enabled: false                  # MASTER KILL SWITCH — must explicitly set true
  daily_cap: 30                   # hard limit: never submit more than this per day
  delay_between_ms: 12000         # min delay between submissions (12s default)
  platforms:
    linkedin: true
    greenhouse: true
    lever: true
    ashby: true
    naukri: true
  linkedin_session_file: data/linkedin-session.json
  answers:                        # factual answers — Qwen never guesses these
    years_experience: 4
    notice_period_days: 30
    expected_salary_inr: 2500000
    willing_to_relocate: true
    visa_sponsorship_needed: false
    work_authorization: "Indian citizen, authorized to work in India"
    cover_letter: auto            # 'auto' = Qwen generates per job | 'skip' = omit
```

---

## Implementation phases

### Phase 1 — Store + ATS scrapers (0 risk, immediate value)

**Goal:** Daily discovery of new jobs at target companies without touching LinkedIn.

1. Add `better-sqlite3` to `package.json`
2. Build `lib/store.mjs`
   - `initDB()` — creates tables if not exist
   - `upsertJob(job)` — insert or ignore on conflict(url)
   - `queryJobs({ status, limit })` — fetch jobs by pipeline stage
   - `updateJob(id, fields)` — update status, scores, paths
3. Build ATS scrapers — each exports `search({ keywords, location })` returning `Job[]`
   - `scrapers/greenhouse.mjs` — `GET boards.greenhouse.io/v1/boards/{slug}/jobs?content=true`
   - `scrapers/lever.mjs` — `GET api.lever.co/v0/postings/{slug}?mode=json`
   - `scrapers/ashby.mjs` — `POST api.ashbyhq.com/jobBoard.listJobPostings` with `{jobBoardIdentifier}`
   - `scrapers/workable.mjs` — `GET apply.workable.com/api/v3/accounts/{slug}/jobs`
   - `scrapers/smartrecruiters.mjs` — `GET api.smartrecruiters.com/v1/companies/{slug}/postings`
4. Build `lib/scrapers/index.mjs`
   - Load target companies from config
   - Fan out to all enabled scrapers in parallel
   - Deduplicate by URL hash before writing
   - Apply `blocked_companies` and `blocked_keywords` filters
   - Write new jobs to DB with `status=pending`
5. Build `bin/discover.mjs`
   - Run scraper index
   - Print summary: `N new jobs found (Greenhouse: 12, Lever: 8, ...)`
   - Exit 0

**Deliverable:** `node bin/discover.mjs` discovers new jobs at Stripe, Notion, Razorpay, etc. and stores them.

---

### Phase 2 — JobSpy bridge

**Goal:** Add LinkedIn, Indeed, Glassdoor, Naukri coverage.

6. Build `lib/scrapers/jobspy-bridge.mjs`
   - Check if `python3` + `jobspy` are available; if not, log warning and return `[]`
   - Spawn: `python3 -c "from jobspy import scrape_jobs; import json, sys; jobs=scrape_jobs(site_name=[...], search_term=sys.argv[1], location=sys.argv[2], results_wanted=50, hours_old=168); print(jobs.to_json())"`
   - Parse stdout JSON → normalize to unified `Job` shape
   - Merge into main discovery flow

**Setup note for README:** `pip install jobspy` required for Tier B scrapers. The rest of the pipeline works without it.

---

### Phase 3 — Batch evaluation

**Goal:** Run the existing Qwen eval pipeline on discovered jobs automatically.

7. Write `prompts/pre-screen.md` — a cheap single-call prompt:
   - Input: job title + company + first 500 chars of JD + CV summary
   - Output: `{ score: 1–5, reason: "one sentence" }`
   - Purpose: filter obvious mismatches before spending 7 Qwen calls on a full eval
8. Build `bin/batch-eval.mjs`
   - Query DB for `status=pending` jobs
   - For each job: fetch full JD text (reuse `lib/jd-fetch.mjs`)
   - Run pre-screen; if score < `min_eval_score` → update `status=skipped`, continue
   - If score ≥ threshold: run full `buildReport()` (from `lib/report-builder.mjs`)
   - Save report to `reports/`, PDF to `output/`
   - Update DB: `status=evaluated`, `eval_score`, `eval_report`, `eval_pdf`
   - Print progress: `[12/47] Stripe — SWE III — 4.2/5 ✅`
   - Configurable concurrency (default: 1 at a time to avoid Ollama overload)

---

### Phase 4 — Human review TUI

**Goal:** Give user full control over what gets applied to.

9. Build `bin/review.mjs`
   - Query DB for `status=evaluated` jobs where `eval_score >= min_apply_score`
   - For each job, print:
     ```
     ─────────────────────────────────────────
     [4/12]  Score: 4.2/5  🟢 STRONG APPLY
     Company: Stripe
     Role:    Software Engineer III
     Source:  greenhouse
     URL:     https://boards.greenhouse.io/stripe/jobs/12345
     "Strong Golang match; comp likely above band"
     ─────────────────────────────────────────
     [a]pply  [s]kip  [m]anual  [r]eport  [q]uit
     ```
   - `r` opens the eval report in `$EDITOR` / prints to stdout
   - `a` → update `status=approved`
   - `s` → update `status=skipped`
   - `m` → update `status=manual` (you handle it yourself, not counted in auto-apply)
   - Save decisions and resume where you left off (idempotent)

---

### Phase 5 — Form-fill engine

**Goal:** Qwen answers application form questions using profile context.

10. Build `lib/applier/form-fill.mjs`
    - Input: `{ fields: [{label, type, options, required}], job, profile, answers }`
    - For factual fields (years_experience, salary, notice_period): look up from `profile.answers` config — Qwen never guesses these
    - For open-text fields (cover letter, "why this company", "biggest challenge"): call Qwen with JD + CV context
    - For checkboxes/dropdowns: match options to profile facts
    - Returns: `{ fieldId: value, ... }`
    - Test in isolation: `node -e "import('./lib/applier/form-fill.mjs').then(m => m.test())"` against a sample form snapshot

---

### Phase 6 — Platform appliers

**Goal:** Playwright-based submission adapters per platform.

Each adapter exports `apply({ job, profile, page })` and returns `{ success, screenshotPath, error? }`.

11. `applier/greenhouse-apply.mjs`
    - Navigate to `job.apply_url`
    - Detect input fields by label text (not fragile CSS selectors)
    - Call `form-fill.mjs` for answers
    - Attach tailored CV PDF from `job.eval_pdf`
    - Submit; detect confirmation page; screenshot
12. `applier/lever-apply.mjs` — same pattern; Lever forms are more standardized
13. `applier/ashby-apply.mjs` — same pattern
14. `applier/naukri-apply.mjs`
    - Login with saved session cookie
    - Navigate to job; click "Quick Apply"
    - Handle Naukri's multi-step modal
15. `applier/linkedin-easy.mjs`
    - Install `patchright` npm package (patched Chromium, bypasses CDP fingerprinting)
    - Load saved session from `data/linkedin-session.json`
    - Navigate to job URL; click "Easy Apply"
    - Handle multi-step modal: detect field types, call form-fill, upload CV, submit
    - On CAPTCHA: pause, notify user via stdout, wait for manual intervention

---

### Phase 7 — Apply orchestrator

**Goal:** Process the approved queue with daily cap and logging.

16. Build `lib/applier/index.mjs`
    - Route to correct adapter based on `job.apply_type`
    - Wraps each apply call in try/catch; failure never stops the queue
    - Random delay between submissions (`delay_between_ms` ± 30%)
17. Build `bin/apply.mjs`
    - Check `apply.enabled` in config; exit with clear message if false
    - Query today's `apply_log` count; enforce `daily_cap`
    - Query DB for `status=approved` jobs
    - Launch Playwright/Patchright browser (one instance, reused across all submissions)
    - For each job: call `applier/index.mjs`, log result to `apply_log`, update `jobs.status`
    - Print summary: `Applied: 8 | Failed: 1 | Skipped (cap): 21`
    - Update `data/applications.md` tracker for each successful submission

---

## Anti-detection strategy

| Layer | Measure |
|---|---|
| **Browser** | Patchright for LinkedIn (patches CDP `Runtime.enable`/`Console.enable` leaks that Selenium/Playwright expose) |
| **Session** | Load real browser cookies from `data/linkedin-session.json` — log in manually once, bot rides that session |
| **Rate** | Max 30 submissions/day; 12s+ random delay between each; never batch more than 10 in a single session |
| **Timing** | Randomize delay ±30% (`delay_between_ms * (0.7 + Math.random() * 0.6)`) |
| **Factual answers** | All numbers (salary, YOE, notice) come from config — Qwen never hallucinates these |
| **Fallback** | On CAPTCHA: pause and print instructions for manual solve; don't retry automatically |
| **Account** | Use a secondary LinkedIn account for automation if volume is high; keep primary account clean |

---

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| LinkedIn bans account | Patchright + session cookies + 30/day cap + 12s delays; use secondary account for high-volume runs |
| Qwen hallucinates screening answers | Factual fields (salary, YOE, notice period, visa) always come from `profile.yml answers:` — never from Qwen |
| ATS site structure changes break selectors | Isolated per-adapter; one breakage doesn't stop others; detect by label text not fragile CSS |
| JobSpy rate-limited on LinkedIn | Run discovery at most once per 6 hours; proxies configurable; LinkedIn capped at 50 results per run |
| Applying to wrong jobs at scale | `apply.enabled: false` default + mandatory `review.mjs` gate + `min_apply_score` threshold |
| JD fetch fails for some discovered jobs | Pre-screen uses stored description snippet; full fetch retried at eval time; failures logged and skipped |

---

## Dependencies to add

```json
{
  "better-sqlite3": "^9.x",
  "patchright": "^1.x"
}
```

Python (optional, for Tier B scrapers):
```
pip install jobspy
```

---

## Suggested build order

| Step | What | Risk | Value |
|---|---|---|---|
| 1 | Store + ATS scrapers + discover.mjs | Zero | High — daily discovery at target companies |
| 2 | JobSpy bridge | Low (Python subprocess) | High — LinkedIn/Naukri coverage |
| 3 | Pre-screen prompt + batch-eval.mjs | Low (reuses existing pipeline) | High — automates the boring part |
| 4 | review.mjs TUI | Zero | Medium — QoL, replaces manual tracker work |
| 5 | form-fill.mjs | Zero (test in isolation) | Medium — core of the apply engine |
| 6 | Greenhouse/Lever/Ashby appliers | Low (public ATS, less anti-bot) | Medium — safe platforms first |
| 7 | Naukri applier | Medium | Medium — important for India market |
| 8 | LinkedIn Easy Apply | High (anti-bot arms race) | High — but build last |

---

## Open questions before implementation

1. **Target companies list** — do you want to seed a `config/target-companies.yml` with a specific set (e.g. top Indian startups, FAANG India offices, specific domains), or keep it manual in `profile.yml`?
2. **JobSpy vs Node.js-native scraping** — comfortable having a Python dependency, or should we reverse-engineer the same HTTP endpoints JobSpy uses and do it in pure Node?
3. **LinkedIn session** — will you log in manually once and export cookies, or should we build a `bin/linkedin-login.mjs` that opens a real browser for you to log in and saves the session?
4. **Naukri** — relevant for your search, or skip and focus on international ATS platforms?
5. **Notification** — want a Telegram/email alert when discovery finds new high-score jobs, or is polling `review.mjs` manually fine?

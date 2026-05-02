# qwen-career

A fully local job evaluation pipeline. Paste a job URL (or text), get a structured 6-block analysis, a tailored CV PDF, and a tracker entry — all powered by a local Qwen3:8B model via Ollama. No cloud APIs, no usage costs, no data leaving your machine.

---

## What it does

For every job you evaluate, the pipeline runs:

| Block | What Qwen does |
|-------|---------------|
| **A — Role Summary** | Extracts company, seniority, domain, key responsibilities, must-have and nice-to-have skills |
| **B — CV Match** | Scores each JD requirement against your CV, flags critical gaps and strengths |
| **C — Level & Strategy** | Compares your seniority to the JD level, generates positioning phrases and sell-senior tactics |
| **D — Comp & Demand** | Playwright-scrapes Glassdoor and Levels.fyi, Qwen interprets the data |
| **E — Personalization Plan** | Suggests specific CV and LinkedIn edits, lists keywords to inject |
| **F — Interview Prep** | Builds STAR stories from your experience, likely questions, red-flag Q&A |
| **Score** | Aggregates all blocks into an overall score (1–5) with a recommendation: strong-apply / apply / borderline / skip |

After the report, the CV tailor runs three more Qwen calls: keyword extraction → summary rewrite → bullet reordering per job. The result is rendered to HTML and printed to PDF via Playwright Chromium.

Everything is saved:
- `reports/{###}-{company}-{date}.md` — full evaluation report
- `output/cv-{company}-{date}.pdf` — tailored CV
- `data/applications.md` — tracker row upserted automatically

---

## Requirements

- **Node.js 18+**
- **Ollama** running locally with `qwen3:8b` pulled
- **Playwright Chromium** (installed separately after `npm install`)
- **Python + JobSpy** only if you enable multi-board discovery (`pip install jobspy`)

---

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Edit `config/profile.yml` — at minimum fill in `user.name`, `user.email`, `user.location`.

### 3. Add your CV

Create `cv.md` in the project root. Standard sections work best:

```
# Summary
# Experience
# Projects
# Education
# Skills
# Certifications
```

### 4. Start Ollama

```bash
ollama serve          # if not already running
ollama pull qwen3:8b  # first time only
```

### 5. Verify everything

```bash
node doctor.mjs
```

Expect all 13 checks green, including a live Qwen probe. Fix any failures before running evaluations.

---

## Usage

### Evaluate from a URL

```bash
node bin/evaluate.mjs https://company.com/jobs/senior-engineer-123
```

### Evaluate from a local file

```bash
node bin/evaluate.mjs --jd-file job.txt --company "Acme" --role "Senior Backend Engineer"
```

### Evaluate from pasted text

```bash
node bin/evaluate.mjs --jd-text "We are hiring a..." --company "Acme" --role "Senior Backend Engineer"
```

### Common flags

| Flag | Effect |
|------|--------|
| `--no-pdf` | Skip CV tailoring and PDF generation |
| `--no-comp` | Skip Glassdoor/Levels.fyi scraping (faster, more reliable) |
| `--no-tracker` | Don't update `data/applications.md` |
| `--company "Name"` | Override auto-detected company name |
| `--role "Title"` | Override auto-detected role title |
| `--report-num 042` | Force a specific report number |
| `--dry-run` | Fetch and clean the JD, then stop — no Qwen calls |
| `--tool-calls` | Experimental: let Qwen drive a tool loop instead of Node orchestrating |
| `-v, --verbose` | Print debug logs and Qwen call details |

### Batch pipeline

```bash
npm run discover
npm run batch-eval -- --limit 5
npm run review
npm run apply
```

This is the intended order. Discovery finds jobs, batch evaluation scores them, review asks you to approve or reject them, and apply only processes jobs you explicitly approved.

Nothing auto-submits from discovery or evaluation. The human review step is mandatory, and `npm run apply` also refuses to run unless `apply.enabled: true` is set in `config/profile.yml`.

### Command reference

#### `npm run discover`

Finds new jobs and stores them in SQLite.

Reads:
- `config/profile.yml -> search`
- `config/profile.yml -> sources`

Uses:
- ATS public APIs for configured companies, such as Greenhouse, Lever, Ashby, Workable, and SmartRecruiters
- Optional JobSpy bridge if `sources.jobspy.enabled: true`
- Optional Playwright scrapers if `sources.playwright_scrapers.enabled: true`

Writes:
- `data/jobs.db`

Status changes:
- inserts new matching jobs as `pending`
- leaves existing jobs alone, while refreshing basic metadata where available

Filtering:
- job text must contain one of `search.keywords`
- company must not match `search.blocked_companies`
- title must not contain `search.blocked_keywords`
- title must not contain `search.excluded_title_keywords`, which is where seniority filters like `new grad`, `entry level`, `campus`, and `junior` belong

Example:

```bash
npm run discover
```

Typical output:

```text
16 new jobs found (ashby: 16).
641 raw jobs discovered; 548 filtered.
Warnings: 2
```

Warnings usually mean a configured company slug is wrong or that an ATS endpoint is unavailable. One failed source does not stop the rest of discovery.

#### `npm run batch-eval -- --limit 5`

Scores pending jobs and runs the existing full evaluation pipeline for promising matches.

Reads:
- `data/jobs.db` jobs with `status = pending`
- `cv.md`
- `prompts/pre-screen.md`
- the existing report/CV prompts and schemas
- `config/profile.yml -> search.min_eval_score`

Does:
- uses the stored job description when discovery already captured one
- falls back to `lib/jd-fetch.mjs` if the stored description is too short
- runs a cheap one-call Qwen pre-screen first
- skips jobs below `search.min_eval_score`
- runs the full report builder for jobs above the threshold
- generates tailored CV HTML/PDF unless `--no-pdf` is passed

Writes:
- `reports/{###}-{company}-{date}.md`
- `output/cv-{company}-{date}.html`
- `output/cv-{company}-{date}.pdf`
- `data/applications.md`
- updates `data/jobs.db`

Status changes:
- `pending -> skipped` when pre-screen score is below threshold or evaluation fails
- `pending -> pre_screened -> evaluated` when full evaluation succeeds

Examples:

```bash
npm run batch-eval -- --limit 5
npm run batch-eval -- --limit 10 --no-pdf
```

Use a small limit first. A full evaluation is intentionally expensive because it runs multiple Qwen calls plus optional PDF tailoring.

#### `npm run review`

Shows evaluated jobs and lets you decide what can be applied to.

Reads:
- `data/jobs.db` jobs with `status = evaluated`
- `config/profile.yml -> search.min_apply_score`
- report files when you press `r`

Interactive choices:
- `a` marks the job `approved`
- `s` marks the job `skipped`
- `m` marks the job `manual`, meaning you will apply yourself
- `r` prints the evaluation report
- `q` exits without changing the current job

Writes:
- updates `data/jobs.db`

Status changes:
- `evaluated -> approved`
- `evaluated -> skipped`
- `evaluated -> manual`

Example:

```bash
npm run review
```

Only `approved` jobs are eligible for the apply command.

#### `npm run apply`

Processes the approved queue. This is the only command that can submit applications.

Safety gates:
- exits unless `config/profile.yml -> apply.enabled` is `true`
- only reads jobs with `status = approved`
- respects `apply.daily_cap`
- waits between jobs using `apply.delay_between_ms` with random jitter
- logs every attempt in `apply_log`
- failure on one job does not stop the queue

Reads:
- `data/jobs.db` jobs with `status = approved`
- `config/profile.yml -> apply`
- `config/profile.yml -> apply.answers`
- tailored CV PDFs from evaluated jobs
- `data/linkedin-session.json` for LinkedIn, if using LinkedIn Easy Apply

Uses:
- Playwright for ATS application forms
- Patchright for LinkedIn Easy Apply
- Qwen for open-text form answers
- configured factual answers for salary, notice period, work authorization, relocation, and years of experience

Writes:
- `data/jobs.db`
- `apply_log` table in `data/jobs.db`
- `data/apply-screenshots/`
- `data/applications.md` for successful submissions

Status changes:
- `approved -> applied` when submission is detected
- remains `approved` when submission fails, with `apply_result = failed`

Example:

```bash
npm run apply
```

To enable it, edit `config/profile.yml`:

```yaml
apply:
  enabled: true
```

For ATS forms such as Greenhouse, Lever, and Ashby, no token is required. For LinkedIn Easy Apply, there is no API token either; it needs a logged-in browser session saved at `data/linkedin-session.json`.

#### `npm run eval -- <url>`

Runs the original one-off evaluator for a single job URL.

Reads:
- the job URL or provided JD text/file
- `cv.md`
- `config/profile.yml`

Writes:
- `reports/`
- `output/`
- `data/applications.md`

This command does not write to `data/jobs.db`; it is separate from the discovery queue.

Example:

```bash
npm run eval -- https://company.com/jobs/senior-engineer-123
```

#### `npm run doctor`

Checks whether the local setup is healthy.

Reads:
- Node/npm environment
- config files
- CV file
- Ollama/Qwen availability
- Playwright browser availability

Example:

```bash
npm run doctor
```

Run this first when Qwen calls, PDF rendering, or Playwright fetching fails.

### Job statuses

The SQLite queue uses these statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Discovered but not evaluated yet |
| `pre_screened` | Passed the cheap pre-screen and is currently entering full evaluation |
| `evaluated` | Full report and score are available |
| `approved` | You approved it in `review`; eligible for `apply` |
| `applied` | The apply command detected a successful submission |
| `skipped` | Rejected by pre-screen, review, or evaluation failure |
| `manual` | You chose to apply manually; bot will not touch it |

---

## Configuration reference

`config/profile.yml` — all fields:

```yaml
user:
  name: "Your Full Name"
  email: "you@example.com"
  location: "City, Country"
  linkedin_url: "https://linkedin.com/in/yourhandle"
  linkedin_display: "linkedin.com/in/yourhandle"
  portfolio_url: "https://yoursite.com"
  portfolio_display: "yoursite.com"

cv:
  source: cv.md                  # path to your CV markdown

llm:
  endpoint: http://127.0.0.1:11434/v1
  model: qwen3:8b
  thinking: true                 # Qwen3 thinking mode (recommended)
  tool_calls: false              # Node orchestrates by default
  timeout_ms: 90000              # 90s per Qwen call
  max_retries: 1                 # one retry with stricter prompt on JSON failure
  temperature: 0.3

pdf:
  paper: a4                      # a4 or letter
  page_margin: "0.6in"

comp:
  enabled: true
  sources:
    - glassdoor
    - levelsfyi

tracker:
  file: data/applications.md

search:
  keywords: ["Software Engineer", "Backend Engineer", "SDE"]
  locations: ["Bangalore, India", "Remote"]
  experience_years: 3
  min_eval_score: 3.0
  min_apply_score: 3.8
  date_posted_days: 7
  blocked_companies: ["Wipro", "Infosys"]
  blocked_keywords: ["intern", "contract", "freelance"]
  excluded_title_keywords: ["new grad", "new graduate", "graduate engineer", "university grad", "campus", "entry level", "junior"]

sources:
  ats_apis:
    enabled: true
    companies:
      - { name: "Stripe", ats: "greenhouse", slug: "stripe" }
      - { name: "Notion", ats: "ashby", slug: "notion" }
  jobspy:
    enabled: false
    boards: [linkedin, indeed, naukri, glassdoor]
    results_per_board: 50
    proxies: []
  playwright_scrapers:
    enabled: false
    boards: [wellfound, instahyre]

apply:
  enabled: false
  daily_cap: 30
  delay_between_ms: 12000
  platforms:
    linkedin: true
    greenhouse: true
    lever: true
    ashby: true
    naukri: true
  linkedin_session_file: data/linkedin-session.json
  answers:
    years_experience: 4
    notice_period_days: 30
    expected_salary_inr: 2500000
    willing_to_relocate: true
    visa_sponsorship_needed: false
    work_authorization: "Indian citizen, authorized to work in India"
    cover_letter: auto
```

---

## Project layout

```
qwen-career/
├── bin/
│   ├── evaluate.mjs         # Single-job evaluation CLI
│   ├── discover.mjs         # ATS/JobSpy discovery into SQLite
│   ├── batch-eval.mjs       # Pre-screen + full eval for pending jobs
│   ├── review.mjs           # Human approval gate
│   └── apply.mjs            # Guarded approved-queue applier
├── lib/
│   ├── store.mjs            # SQLite job store
│   ├── scrapers/            # ATS APIs + optional JobSpy bridge
│   ├── applier/             # Platform appliers and form fill engine
│   ├── qwen.mjs             # Ollama client, schema validation, retry logic
│   ├── report-builder.mjs   # Chains all 7 Qwen calls, stitches report markdown
│   ├── cv-tailor.mjs        # Keywords → summary rewrite → bullet reorder → HTML
│   ├── jd-fetch.mjs         # Playwright: fetch and cache JD from URL
│   ├── jd-clean.mjs         # Strip cookie noise, dedup lines, cap at 12k chars
│   ├── comp-scrape.mjs      # Playwright: scrape Glassdoor and Levels.fyi
│   ├── tracker.mjs          # Parse/upsert markdown table in applications.md
│   ├── pdf.mjs              # Playwright: render HTML → PDF
│   ├── log.mjs              # Structured log to output/qwen.log
│   ├── numbering.mjs        # Sequential 3-digit report numbering
│   └── slug.mjs             # URL-safe company slug
├── prompts/
│   ├── jd-meta.md           # Extract company/role/seniority from JD
│   ├── block-a-role.md      # Block A: role summary
│   ├── block-b-match.md     # Block B: CV match analysis
│   ├── block-c-level.md     # Block C: level & strategy
│   ├── block-d-comp.md      # Block D: interpret comp data
│   ├── block-e-personalization.md
│   ├── block-f-interview.md
│   ├── score-aggregate.md   # Final score + recommendation
│   ├── keywords-extract.md  # CV tailor: keyword extraction
│   ├── cv-summary-rewrite.md
│   └── cv-bullets-reorder.md
├── schemas/
│   ├── jd-meta.json         # Ajv schemas — every schema'd Qwen call is validated
│   ├── block-a.json
│   ├── block-b.json
│   ├── block-c.json
│   ├── block-d.json
│   ├── score.json
│   └── keywords.json
├── templates/
│   └── cv-template.html     # HTML/CSS template for the tailored CV PDF
├── fonts/                   # Space Grotesk + DM Sans (woff2, embedded in PDF)
├── config/
│   ├── profile.example.yml  # Copy this to profile.yml
│   └── profile.yml          # Your config — gitignored
├── generate-pdf.mjs         # Puppeteer/Playwright PDF renderer
├── doctor.mjs               # Setup checker: 13 health checks
├── cv.md                    # Your CV — gitignored
├── data/                    # Tracker and pipeline files — gitignored
├── reports/                 # Generated evaluation reports — gitignored
└── output/                  # Generated PDFs and HTML — gitignored
```

---

## How the Qwen integration works

Node.js orchestrates the entire pipeline. Qwen only handles bounded reasoning tasks — it never drives I/O.

Each Qwen call:
1. Sends a `system` prompt (from `prompts/`) and a `user` message with the relevant data
2. Uses Ollama's `format: "json"` mode to constrain output format
3. Strips any markdown fences from the response
4. Validates against a JSON schema (Ajv) where a schema is defined
5. On failure: retries once with a stricter prompt suffix; on second failure: throws and the block gets a safe fallback value so the rest of the pipeline continues

Each block's fallback is defined inline in `report-builder.mjs`. A single Qwen failure produces a placeholder section — it never kills the whole report.

Logs for every call (model, latency, input chars, output chars, finish reason) are written to `output/qwen.log`.

---

## Tuning for your situation

**Prompts are in plain markdown** (`prompts/`). If you find Block B is too harsh, Block F STAR stories are too generic, or the scoring doesn't match your priorities, edit those files directly.

**The CV template** is standard HTML/CSS in `templates/cv-template.html`. Change fonts, colors, layout, section order — Playwright renders it faithfully to PDF.

**Comp scraping** (`--no-comp`) is brittle by design. Glassdoor and Levels.fyi change their layouts. If scraping fails consistently for a role, skip it and add comp research to your manual notes.

**Qwen3:8B thinking mode** (`llm.thinking: true`) improves reasoning quality at the cost of latency (~20s per call on a typical machine). Set `thinking: false` if you need faster results and can accept slightly weaker analysis.

---

## Expected performance

On a machine running Qwen3:8B via Ollama:

- Doctor probe: ~20s (cold model load)
- Full evaluation (all 7 Qwen calls + comp scrape + PDF): 5–12 minutes
- `--no-comp --no-pdf`: 3–8 minutes

The first run after Ollama starts is slower while the model loads into memory.

---

## Tracker format

`data/applications.md` is a plain markdown table:

```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 001 | 2025-01-15 | Acme | Senior Backend Engineer | 4.2/5 | Evaluated | ✅ | [001](reports/001-acme-2025-01-15.md) | Strong match on infra experience |
```

The tracker is upserted by `(company, role)` key — re-evaluating the same role updates the existing row instead of adding a duplicate.

---

## Troubleshooting

**Ollama unreachable**
```bash
ollama serve
```

**Model not found**
```bash
ollama pull qwen3:8b
```

**Playwright browser missing**
```bash
npx playwright install chromium
```

**JSON parse errors / schema failures**
Set `VERBOSE=1` or use `-v` to see the raw Qwen output. Usually caused by the model emitting prose before the JSON object. The retry mechanism handles most cases; if failures are consistent, simplify the prompt for that block.

**PDF looks wrong / blank**
Check `output/cv-{company}-{date}.html` in a browser first. The HTML is written before PDF rendering — if the HTML looks correct, the issue is in `generate-pdf.mjs` (usually a Playwright launch flag).

**Comp block always fails**
Use `--no-comp`. Glassdoor and Levels.fyi actively block scrapers. This is expected — treat Block D as best-effort.

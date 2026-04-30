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
```

---

## Project layout

```
qwen-career/
├── bin/
│   └── evaluate.mjs         # CLI entry point
├── lib/
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

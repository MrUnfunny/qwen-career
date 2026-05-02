import { readFileSync } from 'fs';
import { resolve } from 'path';
import { chat } from './qwen.mjs';
import { scrapeComp } from './comp-scrape.mjs';
import { log } from './log.mjs';

function loadPrompt(name) {
  return readFileSync(resolve('prompts', name), 'utf-8');
}

function loadSchema(name) {
  return JSON.parse(readFileSync(resolve('schemas', name), 'utf-8'));
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function formatRequirementsTable(requirements) {
  const rows = requirements.map(r => {
    const strength = '★'.repeat(Math.round(r.match_strength)) + '☆'.repeat(5 - Math.round(r.match_strength));
    const gap = r.gap_severity === 'none' ? '✅' : r.gap_severity === 'minor' ? '⚠️' : r.gap_severity === 'major' ? '🔶' : '🔴';
    const evidence = r.cv_evidence ? `\`${r.cv_evidence.slice(0, 80)}\`` : '_no match_';
    return `| ${r.jd_requirement.slice(0, 50)} | ${strength} | ${gap} | ${evidence} | ${r.mitigation || '-'} |`;
  });
  return [
    '| Requirement | Match | Gap | CV Evidence | Mitigation |',
    '|-------------|-------|-----|-------------|------------|',
    ...rows,
  ].join('\n');
}

function formatStories(stories) {
  return stories.map((s, i) =>
    `**Story ${i + 1} — ${s.requirement}** _(${s.cv_role_anchor})_\n\n` +
    `- **S:** ${s.situation}\n- **T:** ${s.task}\n- **A:** ${s.action}\n- **R:** ${s.result}`
  ).join('\n\n');
}

function scoreEmoji(score) {
  if (score === null || score === undefined) return 'N/A';
  if (score >= 4.2) return `**${score.toFixed(1)}/5** 🟢`;
  if (score >= 3.5) return `**${score.toFixed(1)}/5** 🟡`;
  if (score >= 2.8) return `**${score.toFixed(1)}/5** 🟠`;
  return `**${score.toFixed(1)}/5** 🔴`;
}

function stitchReport({ meta, blockA, blockB, blockC, blockD, blockE, blockF, score, url, reportNum, date }) {
  const recLabel = {
    'strong-apply': '🟢 STRONG APPLY',
    'apply':        '🟡 APPLY',
    'borderline':   '🟠 BORDERLINE',
    'skip':         '🔴 SKIP',
  }[score.recommendation] || score.recommendation;

  return `# Evaluation: ${meta.company} — ${meta.role}

**Date:** ${date}
**Score:** ${scoreEmoji(score.overall)}
**Recommendation:** ${recLabel}
**URL:** ${url}
**PDF:** output/cv-${meta.company.toLowerCase().replace(/\s+/g, '-')}-${date}.pdf
**Report:** reports/${reportNum}-${meta.company.toLowerCase().replace(/\s+/g, '-')}-${date}.md

> ${score.one_liner}

---

## A) Role Summary

| Field | Value |
|-------|-------|
| Company | ${blockA.company} |
| Role | ${blockA.role} |
| Seniority | ${blockA.seniority} |
| Location | ${blockA.location} |
| Remote | ${blockA.remote_policy} |
| Domain | ${blockA.domain} |
| Function | ${blockA.function} |

**TL;DR:** ${blockA.tl_dr}

**Key Responsibilities:**
${(blockA.key_responsibilities || []).map(r => `- ${r}`).join('\n')}

**Must-Have Skills:** ${(blockA.must_have_skills || []).join(', ')}

**Nice-to-Have:** ${(blockA.nice_to_have_skills || []).join(', ')}

---

## B) Match with CV

**Overall Match: ${blockB.overall_match_score.toFixed(1)}/5**

${formatRequirementsTable(blockB.requirements || [])}

**Strengths:** ${(blockB.strengths || []).map(s => `\n- ${s}`).join('')}

**Critical Gaps:** ${(blockB.critical_gaps || []).length ? (blockB.critical_gaps || []).map(g => `\n- 🔴 ${g}`).join('') : '\n- None'}

**Nice-to-Have Gaps:** ${(blockB.nice_to_have_gaps || []).length ? (blockB.nice_to_have_gaps || []).map(g => `\n- ⚠️ ${g}`).join('') : '\n- None'}

---

## C) Level & Strategy

| Field | Value |
|-------|-------|
| JD Level | ${blockC.jd_level} |
| Candidate Level | ${blockC.candidate_level} |
| Alignment | ${blockC.level_alignment} |

**How to sell senior:**
${blockC.sell_senior_plan}

**If downleveled:**
${blockC.downlevel_plan}

**Positioning phrases:**
${(blockC.positioning_phrases || []).map(p => `- "${p}"`).join('\n')}

**Red flags to address:**
${(blockC.red_flags_to_address || []).length ? (blockC.red_flags_to_address || []).map(r => `- ⚠️ ${r}`).join('\n') : '- None'}

---

## D) Comp & Demand

**Status:** ${blockD.status} | **Score:** ${blockD.score !== null ? `${blockD.score}/5` : 'N/A'} | **Data quality:** ${blockD.data_quality}

${blockD.market_range_low ? `**Market range:** ${blockD.market_range_low} – ${blockD.market_range_high} (${blockD.currency})` : ''}

${blockD.interpretation || '_Comp data unavailable. Research manually._'}

**Sources to check:** ${(blockD.recommended_sources || []).join(', ')}

---

## E) Personalization Plan

### CV Changes
${(blockE.cv_changes || []).map((c, i) => `**${i + 1}. ${c.section}**\n- Current: _${c.current_text}_\n- Proposed: _${c.proposed_text}_\n- Why: ${c.why}`).join('\n\n')}

### LinkedIn Changes
${(blockE.linkedin_changes || []).map((c, i) => `**${i + 1}. ${c.section}**\n- Proposed: _${c.proposed_text}_\n- Why: ${c.why}`).join('\n\n')}

**Keywords to inject:** ${(blockE.keywords_to_add || []).join(', ')}

---

## F) Interview Prep

${formatStories(blockF.stories || [])}

---

**Recommended case study:** ${blockF.case_study?.recommended_project || 'N/A'}
_${blockF.case_study?.why || ''}_
How to present: ${blockF.case_study?.how_to_present || ''}

**Likely questions:**
${(blockF.likely_interview_questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}

**Red-flag questions:**
${(blockF.red_flag_questions || []).map(q => `- **Q:** ${q.question}\n  **A:** ${q.recommended_answer}`).join('\n')}

---

## Score Breakdown

| Dimension | Score |
|-----------|-------|
| CV Match | ${score.dimensions.cv_match.toFixed(1)}/5 |
| Level Fit | ${score.dimensions.level_fit.toFixed(1)}/5 |
| Comp | ${score.dimensions.comp !== null ? `${score.dimensions.comp.toFixed(1)}/5` : 'N/A'} |
| Growth Potential | ${score.dimensions.growth_potential.toFixed(1)}/5 |
| Red Flags | ${score.dimensions.red_flags.toFixed(1)}/5 |
| **Overall** | **${score.overall.toFixed(1)}/5** |

**Apply if:** ${score.apply_if}
**Skip if:** ${score.skip_if}
`;
}

export async function run({ jd, cv, meta, url, reportNum, date, opts = {} }) {
  console.log('  [A] Role summary...');
  const blockA = await chat({
    system: loadPrompt('block-a-role.md'),
    user: `JD:\n${jd}\n\nMeta:\n${JSON.stringify(meta, null, 2)}`,
    schema: loadSchema('block-a.json'),
    promptName: 'block-a',
  }).catch(err => { log.error('block-a', { error: err.message }); return { ...meta, key_responsibilities: [], must_have_skills: [], nice_to_have_skills: [], tl_dr: '[evaluation error]', function: 'unknown' }; });

  console.log('  [B] CV match analysis...');
  const blockB = await chat({
    system: loadPrompt('block-b-match.md'),
    user: `JD:\n${jd}\n\nCV:\n${cv}`,
    schema: loadSchema('block-b.json'),
    promptName: 'block-b',
  }).catch(err => { log.error('block-b', { error: err.message }); return { requirements: [], overall_match_score: 0, strengths: [], critical_gaps: ['[evaluation error]'], nice_to_have_gaps: [] }; });

  console.log('  [C] Level & strategy...');
  const blockC = await chat({
    system: loadPrompt('block-c-level.md'),
    user: `JD:\n${jd}\n\nCV:\n${cv}\n\nMeta:\n${JSON.stringify(meta, null, 2)}`,
    schema: loadSchema('block-c.json'),
    promptName: 'block-c',
  }).catch(err => { log.error('block-c', { error: err.message }); return { jd_level: 'unknown', candidate_level: 'unknown', level_alignment: 'unknown', sell_senior_plan: '[error]', downlevel_plan: '[error]', positioning_phrases: [], red_flags_to_address: [] }; });

  let blockD;
  if (opts.comp !== false) {
    console.log('  [D] Comp & demand (scraping)...');
    const compRaw = await scrapeComp({ company: meta.company, role: meta.role }).catch(err => {
      log.warn('comp-scrape', { error: err.message });
      return { data: [], sources: [], errors: [err.message] };
    });

    blockD = await chat({
      system: loadPrompt('block-d-comp.md'),
      user: `Role: ${meta.role}\nCompany: ${meta.company}\n\nComp data:\n${JSON.stringify(compRaw, null, 2)}`,
      schema: loadSchema('block-d.json'),
      promptName: 'block-d',
    }).catch(() => ({ status: 'unavailable', score: null, market_range_low: '', market_range_high: '', currency: 'unknown', interpretation: '', data_quality: 'low', sources_used: [], recommended_sources: ['levels.fyi', 'glassdoor.com', 'blind.co'] }));
  } else {
    blockD = { status: 'unavailable', score: null, market_range_low: '', market_range_high: '', currency: 'unknown', interpretation: 'Comp evaluation skipped (--no-comp).', data_quality: 'low', sources_used: [], recommended_sources: ['levels.fyi', 'glassdoor.com'] };
  }

  console.log('  [E] Personalization plan...');
  const blockE = await chat({
    system: loadPrompt('block-e-personalization.md'),
    user: `JD:\n${jd}\n\nCV:\n${cv}\n\nKey JD requirements:\n${blockB.requirements.map(r => r.jd_requirement).join('\n')}`,
    promptName: 'block-e',
  }).catch(err => { log.error('block-e', { error: err.message }); return { cv_changes: [], linkedin_changes: [], keywords_to_add: [], keywords_already_present: [] }; });

  console.log('  [F] Interview prep...');
  const blockF = await chat({
    system: loadPrompt('block-f-interview.md'),
    user: `JD:\n${jd}\n\nCV:\n${cv}\n\nKey requirements:\n${blockB.requirements.map(r => r.jd_requirement).join('\n')}`,
    schema: undefined,
    promptName: 'block-f',
  }).catch(err => { log.error('block-f', { error: err.message }); return { stories: [], case_study: { recommended_project: '[error]', why: '', how_to_present: '' }, likely_interview_questions: [], red_flag_questions: [] }; });

  console.log('  [Score] Aggregating...');
  const score = await chat({
    system: loadPrompt('score-aggregate.md'),
    user: JSON.stringify({ blockA, blockB, blockC, blockD }, null, 2),
    schema: loadSchema('score.json'),
    promptName: 'score',
  }).catch(() => ({ dimensions: { cv_match: blockB.overall_match_score, level_fit: 3, comp: blockD.score, growth_potential: 3, red_flags: 3 }, overall: blockB.overall_match_score, recommendation: 'borderline', one_liner: 'Score aggregation failed — review blocks manually.', apply_if: '', skip_if: '' }));

  const markdown = stitchReport({ meta, blockA, blockB, blockC, blockD, blockE, blockF, score, url, reportNum, date });

  return { markdown, score, blocks: { blockA, blockB, blockC, blockD, blockE, blockF } };
}

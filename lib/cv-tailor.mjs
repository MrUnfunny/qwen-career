import { readFileSync } from 'fs';
import { resolve } from 'path';
import { chat } from './qwen.mjs';
import { loadConfig } from './qwen.mjs';
import { log } from './log.mjs';

function loadPrompt(name) {
  return readFileSync(resolve('prompts', name), 'utf-8');
}

function loadSchema(name) {
  return JSON.parse(readFileSync(resolve('schemas', name), 'utf-8'));
}

function loadTemplate() {
  return readFileSync(resolve('templates/cv-template.html'), 'utf-8');
}

// Parse cv.md into rough sections
function parseCVSections(cvText) {
  const sections = {};
  let current = '__top__';
  let buf = [];

  for (const line of cvText.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      sections[current] = buf.join('\n').trim();
      current = h[1].trim().toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  sections[current] = buf.join('\n').trim();
  return sections;
}

// Extract job blocks: each block starts with a line matching "### Company" or "**Company**"
function parseJobBlocks(experienceSection) {
  const blocks = [];
  let current = null;

  for (const line of experienceSection.split('\n')) {
    const isJobHeader = line.match(/^###\s+/) || (line.match(/^\*\*/) && line.match(/\*\*\s*$/) === null);
    if (isJobHeader) {
      if (current) blocks.push(current);
      current = { header: line, sublines: [] };
    } else if (current) {
      current.sublines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function extractBullets(sublines) {
  return sublines.filter(l => l.trim().match(/^[-*]\s+/)).map(l => l.trim().replace(/^[-*]\s+/, ''));
}

function buildJobHTML(header, sublines, reorderedBullets) {
  const nonBullet = sublines.filter(l => !l.trim().match(/^[-*]\s+/));
  // Try to parse company/role/dates from header and non-bullet lines
  const headerText = header.replace(/^#+\s+|\*\*/g, '').trim();
  const metaLine = nonBullet.find(l => l.trim()) || '';

  const allBullets = (reorderedBullets && reorderedBullets.length > 0 ? reorderedBullets : extractBullets(sublines));
  const bullets = allBullets.slice(0, 5);

  return `<div class="job avoid-break">
  <div class="job-header">
    <span class="job-company">${headerText}</span>
    <span class="job-period">${metaLine.slice(0, 60)}</span>
  </div>
  <ul>
    ${bullets.map(b => `<li>${b}</li>`).join('\n    ')}
  </ul>
</div>`;
}

function buildCompetencyTags(keywords) {
  return keywords
    .filter(k => k.inject_in === 'competencies' || k.inject_in === 'multiple')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map(k => k.phrase)
    .join(' · ');
}

function fillTemplate(template, vars) {
  let html = template;
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val ?? '');
  }
  return html;
}

export async function tailor({ jd, cv, meta, opts = {} } = {}) {
  const cfg = loadConfig();
  const profile = cfg.user;
  const paper = cfg.pdf?.paper || 'a4';

  const sections = parseCVSections(cv);
  const experienceSection = sections['experience'] || sections['work experience'] || '';

  // Step 1: Extract keywords
  console.log('  [PDF] Extracting keywords...');
  let keywords = [];
  try {
    const kwResult = await chat({
      system: loadPrompt('keywords-extract.md'),
      user: `JD:\n${jd}`,
      schema: loadSchema('keywords.json'),
      promptName: 'keywords-extract',
    });
    keywords = kwResult.keywords || [];
  } catch (err) {
    log.warn('cv-tailor-keywords', { error: err.message });
  }

  // Step 2: Rewrite summary
  console.log('  [PDF] Rewriting summary...');
  let summaryText = sections['summary'] || sections['professional summary'] || '';
  try {
    const summaryResult = await chat({
      system: loadPrompt('cv-summary-rewrite.md'),
      user: `CV:\n${cv}\n\nTop keywords:\n${keywords.filter(k => k.weight >= 2).map(k => k.phrase).join(', ')}\n\nRole: ${meta.role} at ${meta.company}`,
      promptName: 'cv-summary-rewrite',
    });
    summaryText = summaryResult.summary || summaryText;
  } catch (err) {
    log.warn('cv-tailor-summary', { error: err.message });
  }

  // Step 3: Reorder bullets per job block
  console.log('  [PDF] Reordering experience bullets...');
  const jobBlocks = parseJobBlocks(experienceSection);
  const reorderedJobs = [];

  for (const job of jobBlocks.slice(0, 4)) { // top 4 roles only
    const bullets = extractBullets(job.sublines);
    if (bullets.length === 0) {
      reorderedJobs.push({ ...job, reorderedBullets: bullets });
      continue;
    }
    try {
      const result = await chat({
        system: loadPrompt('cv-bullets-reorder.md'),
        user: `JD keywords: ${keywords.map(k => k.phrase).join(', ')}\n\nRole: ${job.header}\nBullets:\n${bullets.map(b => `- ${b}`).join('\n')}`,
        promptName: 'bullets-reorder',
        temperature: 0.1,
      });
      reorderedJobs.push({ ...job, reorderedBullets: result.bullets || bullets });
    } catch {
      reorderedJobs.push({ ...job, reorderedBullets: bullets });
    }
  }

  // Build experience HTML
  const experienceHTML = reorderedJobs.map(j =>
    buildJobHTML(j.header, j.sublines, j.reorderedBullets)
  ).join('\n\n');

  // Build competencies
  const competenciesHTML = buildCompetencyTags(keywords);

  // Fill remaining sections as plain text blocks (no Qwen needed)
  const projectsSection   = sections['projects'] || '';
  const educationSection  = sections['education'] || '';
  const certsSection      = sections['certifications'] || '';
  const skillsSection     = sections['skills'] || '';

  const pageWidth = paper === 'letter' ? '8.5in' : '210mm';

  const html = fillTemplate(loadTemplate(), {
    LANG: 'en',
    PAGE_WIDTH: pageWidth,
    NAME: profile.name || '',
    EMAIL: profile.email || '',
    LINKEDIN_URL: profile.linkedin_url || '#',
    LINKEDIN_DISPLAY: profile.linkedin_display || '',
    PORTFOLIO_URL: profile.portfolio_url || '#',
    PORTFOLIO_DISPLAY: profile.portfolio_display || '',
    LOCATION: profile.location || '',
    SECTION_SUMMARY: 'Professional Summary',
    SUMMARY_TEXT: summaryText,
    SECTION_COMPETENCIES: 'Core Competencies',
    COMPETENCIES: competenciesHTML,
    SECTION_EXPERIENCE: 'Work Experience',
    EXPERIENCE: experienceHTML || `<p>${experienceSection}</p>`,
    SECTION_PROJECTS: 'Projects',
    PROJECTS: projectsSection ? `<div class="project"><div class="project-desc">${projectsSection.replace(/\n/g, '<br>')}</div></div>` : '',
    SECTION_EDUCATION: 'Education',
    EDUCATION: educationSection ? `<div class="edu-item"><div class="edu-title">${educationSection.replace(/\n/g, '<br>')}</div></div>` : '',
    SECTION_CERTIFICATIONS: 'Certifications',
    CERTIFICATIONS: certsSection ? `<div class="cert-item"><div class="cert-title">${certsSection.replace(/\n/g, '<br>')}</div></div>` : '',
    SECTION_SKILLS: 'Skills',
    SKILLS: skillsSection ? `<div class="skills-text">${skillsSection.replace(/\n/g, '<br>')}</div>` : '',
  });

  return { html, keywords };
}

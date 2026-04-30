// Minimal markdown CV parser — returns structured sections from cv.md

export function parseCV(markdown) {
  const lines = markdown.split('\n');
  const sections = {};
  let currentSection = null;
  let buffer = [];

  function flush() {
    if (currentSection) sections[currentSection] = buffer.join('\n').trim();
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);

    if (h1) {
      flush();
      currentSection = '__header__';
      buffer = [line];
    } else if (h2) {
      flush();
      currentSection = h2[1].trim().toLowerCase();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

// Extract all bullet points from an experience section, grouped by job block
export function parseExperienceBullets(experienceText) {
  const jobs = [];
  let currentJob = null;

  for (const line of experienceText.split('\n')) {
    // Job header: bold company or ### heading
    const jobHeader = line.match(/^###\s+(.+)/) || line.match(/^\*\*(.+?)\*\*/);
    if (jobHeader) {
      if (currentJob) jobs.push(currentJob);
      currentJob = { header: line.trim(), bullets: [] };
      continue;
    }
    if (currentJob && line.trim().match(/^[-*]\s+/)) {
      currentJob.bullets.push(line.trim().replace(/^[-*]\s+/, ''));
    }
  }
  if (currentJob) jobs.push(currentJob);

  return jobs;
}

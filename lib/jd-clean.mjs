const MAX_CHARS = 12000;

const NOISE_PATTERNS = [
  /^.{0,120}(accept|allow|consent to|cookie policy|we use cookies|privacy policy).{0,120}$/gim,
  /^.{0,80}(sign in|log in|create an account|register now).{0,80}$/gim,
];

export function clean(text) {
  if (!text) return '';

  let t = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  for (const pat of NOISE_PATTERNS) {
    t = t.replace(pat, '');
  }

  // Deduplicate long repeated lines (boilerplate "About us" blocks)
  const seen = new Set();
  t = t.split('\n').filter(line => {
    const norm = line.trim().toLowerCase().replace(/\s+/g, ' ');
    if (norm.length > 80) {
      if (seen.has(norm)) return false;
      seen.add(norm);
    }
    return true;
  }).join('\n');

  t = t
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (t.length > MAX_CHARS) {
    t = t.slice(0, MAX_CHARS) + '\n\n[JD truncated at 12,000 characters]';
  }

  return t;
}

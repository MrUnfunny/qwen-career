import { loadConfig } from '../qwen.mjs';

export function getSearchConfig(cfg = loadConfig()) {
  return {
    keywords: cfg.search?.keywords?.length ? cfg.search.keywords : ['Software Engineer'],
    locations: cfg.search?.locations?.length ? cfg.search.locations : ['Remote'],
    datePostedDays: cfg.search?.date_posted_days ?? 7,
    blockedCompanies: (cfg.search?.blocked_companies || []).map(s => s.toLowerCase()),
    blockedKeywords: (cfg.search?.blocked_keywords || []).map(s => s.toLowerCase()),
    excludedTitleKeywords: (cfg.search?.excluded_title_keywords || []).map(s => s.toLowerCase()),
  };
}

export function matchesSearch(job, search = getSearchConfig()) {
  const title = String(job.title || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const haystack = `${title} ${job.description || ''}`.toLowerCase();

  if (search.blockedCompanies.some(c => company.includes(c))) return false;
  if (search.blockedKeywords.some(k => title.includes(k))) return false;
  if (search.excludedTitleKeywords.some(k => title.includes(k))) return false;
  if (!search.keywords.some(k => haystack.includes(String(k).toLowerCase()))) return false;

  return true;
}

export function htmlToText(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function inferRemote(location = '', text = '') {
  return /\bremote\b/i.test(`${location} ${text}`);
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'qwen-career/0.1',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

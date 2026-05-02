import { fetchJson, htmlToText, inferRemote } from './common.mjs';

export async function search({ company }) {
  const slug = company.slug;
  const data = await fetchJson(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`);
  const jobs = data.results || data.jobs || [];
  return jobs.map(job => {
    const location = [job.city, job.state, job.country].filter(Boolean).join(', ') || job.location || '';
    const url = job.url || job.shortlink || `https://apply.workable.com/${slug}/j/${job.shortcode || job.id}/`;
    const description = htmlToText(job.description || '');
    return {
      url,
      apply_url: url,
      title: job.title,
      company: company.name || slug,
      location,
      remote: inferRemote(location, description),
      source: 'workable',
      apply_type: 'external',
      description,
      date_posted: job.published || job.created_at || '',
    };
  }).filter(j => j.url);
}

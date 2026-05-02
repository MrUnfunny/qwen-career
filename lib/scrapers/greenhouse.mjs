import { fetchJson, htmlToText, inferRemote } from './common.mjs';

export async function search({ company }) {
  const slug = company.slug;
  const data = await fetchJson(`https://boards.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  return (data.jobs || []).map(job => {
    const location = job.location?.name || '';
    const description = htmlToText(job.content || '');
    return {
      url: job.absolute_url,
      apply_url: job.absolute_url,
      title: job.title,
      company: company.name || slug,
      location,
      remote: inferRemote(location, description),
      source: 'greenhouse',
      apply_type: 'greenhouse',
      description,
      date_posted: job.updated_at || '',
    };
  }).filter(j => j.url);
}

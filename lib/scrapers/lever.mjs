import { fetchJson, htmlToText, inferRemote } from './common.mjs';

export async function search({ company }) {
  const slug = company.slug;
  const jobs = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  return (jobs || []).map(job => {
    const location = job.categories?.location || '';
    const description = htmlToText(`${job.description || ''} ${job.descriptionPlain || ''} ${(job.lists || []).map(l => `${l.text} ${(l.content || '').replace(/\n/g, ' ')}`).join(' ')}`);
    return {
      url: job.hostedUrl || job.applyUrl,
      apply_url: job.applyUrl || job.hostedUrl,
      title: job.text,
      company: company.name || slug,
      location,
      remote: inferRemote(location, description),
      source: 'lever',
      apply_type: 'lever',
      description,
      date_posted: job.createdAt ? new Date(job.createdAt).toISOString() : '',
    };
  }).filter(j => j.url);
}

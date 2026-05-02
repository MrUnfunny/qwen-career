import { fetchJson, htmlToText, inferRemote } from './common.mjs';

export async function search({ company }) {
  const slug = company.slug;
  const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`);
  const jobs = data.content || [];
  return jobs.map(job => {
    const location = job.location?.city || job.location?.country || '';
    const url = job.ref || `https://jobs.smartrecruiters.com/${slug}/${job.id}`;
    const description = htmlToText(job.jobAd?.sections?.jobDescription?.text || '');
    return {
      url,
      apply_url: url,
      title: job.name,
      company: company.name || slug,
      location,
      remote: inferRemote(location, description),
      source: 'smartrecruiters',
      apply_type: 'external',
      description,
      date_posted: job.releasedDate || '',
    };
  }).filter(j => j.url);
}

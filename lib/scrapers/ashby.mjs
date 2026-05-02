import { fetchJson, htmlToText, inferRemote } from './common.mjs';

export async function search({ company }) {
  const slug = company.slug;
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
  const jobs = data.jobs || data.jobPostings || [];
  return jobs.map(job => {
    const location = job.location || job.locationName || '';
    const description = htmlToText(job.descriptionHtml || job.description || '');
    const url = job.jobUrl || job.jobPostingUrl || `https://jobs.ashbyhq.com/${slug}/${job.id}`;
    return {
      url,
      apply_url: job.applyUrl || url,
      title: job.title,
      company: company.name || slug,
      location,
      remote: inferRemote(location, description),
      source: 'ashby',
      apply_type: 'ashby',
      description,
      date_posted: job.publishedAt || '',
    };
  }).filter(j => j.url);
}

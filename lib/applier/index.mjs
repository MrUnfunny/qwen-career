import * as greenhouse from './greenhouse-apply.mjs';
import * as lever from './lever-apply.mjs';
import * as ashby from './ashby-apply.mjs';
import * as naukri from './naukri-apply.mjs';
import * as linkedin from './linkedin-easy.mjs';

const ROUTES = {
  greenhouse,
  lever,
  ashby,
  naukri,
  easy_apply: linkedin,
  linkedin: linkedin,
};

export async function applyJob({ job, profile, page } = {}) {
  const route = ROUTES[job.apply_type] || ROUTES[job.source];
  if (!route) {
    return { success: false, skipped: true, error: `No applier for ${job.apply_type || job.source || 'unknown source'}` };
  }
  try {
    return await route.apply({ job, profile, page });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function delayMs(base = 12000) {
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_DB = 'data/jobs.db';
let db;

export function jobId(url = '') {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
}

export function initDB(dbPath = DEFAULT_DB) {
  if (db) return db;

  const file = resolve(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT PRIMARY KEY,
      url           TEXT UNIQUE NOT NULL,
      apply_url     TEXT,
      title         TEXT,
      company       TEXT,
      location      TEXT,
      remote        INTEGER,
      source        TEXT,
      apply_type    TEXT,
      description   TEXT,
      date_posted   TEXT,
      date_found    TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      pre_score     REAL,
      eval_score    REAL,
      eval_report   TEXT,
      eval_pdf      TEXT,
      apply_result  TEXT,
      notes         TEXT
    );

    CREATE TABLE IF NOT EXISTS apply_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id        TEXT REFERENCES jobs(id),
      attempted_at  TEXT NOT NULL,
      result        TEXT,
      error         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
    CREATE INDEX IF NOT EXISTS idx_jobs_date_found ON jobs(date_found);
  `);

  return db;
}

function normalizeJob(job) {
  if (!job?.url) throw new Error('Job url is required');
  const now = new Date().toISOString();
  return {
    id: job.id || jobId(job.url),
    url: job.url,
    apply_url: job.apply_url || job.applyUrl || job.url,
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    remote: job.remote === true ? 1 : job.remote === false ? 0 : null,
    source: job.source || '',
    apply_type: job.apply_type || job.applyType || 'external',
    description: job.description || '',
    date_posted: job.date_posted || job.datePosted || '',
    date_found: job.date_found || now,
    status: job.status || 'pending',
    pre_score: job.pre_score ?? null,
    eval_score: job.eval_score ?? null,
    eval_report: job.eval_report || null,
    eval_pdf: job.eval_pdf || null,
    apply_result: job.apply_result || null,
    notes: job.notes || null,
  };
}

export function upsertJob(job, database = initDB()) {
  const j = normalizeJob(job);
  const before = database.prepare('SELECT id FROM jobs WHERE url = ?').get(j.url);

  database.prepare(`
    INSERT INTO jobs (
      id, url, apply_url, title, company, location, remote, source, apply_type,
      description, date_posted, date_found, status, pre_score, eval_score,
      eval_report, eval_pdf, apply_result, notes
    )
    VALUES (
      @id, @url, @apply_url, @title, @company, @location, @remote, @source, @apply_type,
      @description, @date_posted, @date_found, @status, @pre_score, @eval_score,
      @eval_report, @eval_pdf, @apply_result, @notes
    )
    ON CONFLICT(url) DO UPDATE SET
      apply_url = COALESCE(excluded.apply_url, jobs.apply_url),
      title = COALESCE(NULLIF(excluded.title, ''), jobs.title),
      company = COALESCE(NULLIF(excluded.company, ''), jobs.company),
      location = COALESCE(NULLIF(excluded.location, ''), jobs.location),
      remote = COALESCE(excluded.remote, jobs.remote),
      source = COALESCE(NULLIF(excluded.source, ''), jobs.source),
      apply_type = COALESCE(NULLIF(excluded.apply_type, ''), jobs.apply_type),
      description = COALESCE(NULLIF(excluded.description, ''), jobs.description),
      date_posted = COALESCE(NULLIF(excluded.date_posted, ''), jobs.date_posted)
  `).run(j);

  return { id: before?.id || j.id, inserted: !before };
}

export function queryJobs({ status, statuses, limit = 100, minScore, orderBy = 'date_found DESC' } = {}, database = initDB()) {
  const clauses = [];
  const params = {};
  const allowedOrder = new Set(['date_found DESC', 'eval_score DESC', 'pre_score DESC', 'attempted_at DESC']);

  const wanted = statuses || (status ? [status] : []);
  if (wanted.length) {
    clauses.push(`status IN (${wanted.map((_, i) => `@status${i}`).join(', ')})`);
    wanted.forEach((s, i) => { params[`status${i}`] = s; });
  }
  if (minScore !== undefined) {
    clauses.push('eval_score >= @minScore');
    params.minScore = minScore;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.limit = limit;
  return database.prepare(`
    SELECT * FROM jobs
    ${where}
    ORDER BY ${allowedOrder.has(orderBy) ? orderBy : 'date_found DESC'}
    LIMIT @limit
  `).all(params);
}

export function getJob(id, database = initDB()) {
  return database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function updateJob(id, fields, database = initDB()) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = @${key}`).join(', ');
  database.prepare(`UPDATE jobs SET ${sets} WHERE id = @id`).run({ id, ...Object.fromEntries(entries) });
}

export function logApplyAttempt({ job_id, result, error = '' }, database = initDB()) {
  database.prepare(`
    INSERT INTO apply_log (job_id, attempted_at, result, error)
    VALUES (@job_id, @attempted_at, @result, @error)
  `).run({
    job_id,
    attempted_at: new Date().toISOString(),
    result,
    error,
  });
}

export function countApplyAttemptsToday(database = initDB()) {
  const today = new Date().toISOString().slice(0, 10);
  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM apply_log
    WHERE attempted_at >= @today AND result = 'submitted'
  `).get({ today })?.count || 0;
}

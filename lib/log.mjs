import { appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const LOG_FILE = resolve('output/qwen.log');

function ensureOutput() {
  mkdirSync('output', { recursive: true });
}

function entry(level, msg, data = {}) {
  ensureOutput();
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n';
  try { appendFileSync(LOG_FILE, line); } catch { /* ignore log failures */ }
  if (process.env.VERBOSE || process.env.DEBUG) {
    console.error(`[${level.toUpperCase()}] ${msg}`, Object.keys(data).length ? data : '');
  }
}

export const log = {
  debug: (msg, data) => entry('debug', msg, data),
  info:  (msg, data) => entry('info',  msg, data),
  warn:  (msg, data) => entry('warn',  msg, data),
  error: (msg, data) => entry('error', msg, data),
};

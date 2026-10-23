/**
 * The Maker's AI spend for one run, as stored on the sales client (client.makerRun.aiSpend).
 * Pure module: data/sales.js normalizes stored values with it, and the run.ai.spend callback
 * (lib/llm/spend-callback.js) validates incoming ones with it.
 *
 * makerRun.aiSpend = { runId, totalUsd, byTask: { <task>: usd }, calls, profile, at, receivedAt }
 */

const TASK_KEY = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const PROFILE = /^[a-z]{1,20}$/;
const MAX_TASKS = 200;
const MAX_USD = 100_000;

function clean(value) {
  return String(value ?? '').trim();
}

function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_USD) return null;
  return Math.round(n * 1e6) / 1e6;
}

function isoOrEmpty(value) {
  const text = clean(value);
  if (!text) return '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

/**
 * A clean aiSpend record, or null when `raw` has no usable spend (no total and no per-task numbers).
 * Unknown fields are dropped; task keys and amounts are bounded.
 */
export function normalizeRunAiSpend(raw, { runId = '', receivedAt = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const byTask = {};
  const source = raw.byTask && typeof raw.byTask === 'object' && !Array.isArray(raw.byTask) ? raw.byTask : {};
  for (const [task, value] of Object.entries(source)) {
    if (Object.keys(byTask).length >= MAX_TASKS) break;
    const amount = usd(value);
    if (!TASK_KEY.test(task) || amount === null) continue;
    byTask[task] = amount;
  }
  let total = usd(raw.totalUsd);
  if (total === null && raw.totalUsd !== undefined && raw.totalUsd !== null && raw.totalUsd !== '') return null;
  if (total === null) {
    if (!Object.keys(byTask).length) return null;
    total = usd(Object.values(byTask).reduce((sum, value) => sum + value, 0));
    if (total === null) return null;
  }
  const out = {
    runId: clean(raw.runId || runId).slice(0, 200),
    totalUsd: total,
    byTask,
    at: isoOrEmpty(raw.at) || isoOrEmpty(receivedAt) || '',
    receivedAt: isoOrEmpty(raw.receivedAt) || isoOrEmpty(receivedAt) || '',
  };
  const calls = Number(raw.calls);
  if (Number.isInteger(calls) && calls >= 0 && calls < 1e7) out.calls = calls;
  const profile = clean(raw.profile).toLowerCase();
  if (PROFILE.test(profile)) out.profile = profile;
  return out;
}

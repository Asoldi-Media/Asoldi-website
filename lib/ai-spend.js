/**
 * The Maker's AI spend for one run, as stored on the sales client (client.makerRun.aiSpend).
 * Pure module: data/sales.js normalizes stored values with it, and the run.ai.spend callback
 * (lib/llm/spend-callback.js) validates incoming ones with it.
 *
 * Accepted on the wire (run.ai.spend body). The canonical shape is the Maker's ledger v2 groups:
 *   { runId, totalUsd, byTask: { <task>: { usd, calls } }, byProvider?: { <provider>: { usd, calls } },
 *     calls?, unverifiedUsd?, profile?, at, target?, status?, ledgerVersion? }
 * A group may also be a plain USD number ({ <task>: usd }). target, status and ledgerVersion are not stored.
 *
 * Stored (makerRun.aiSpend and <dataDir>/ai/maker-spend.json):
 *   { runId, totalUsd, byTask: { <task>: usd }, callsByTask?: { <task>: calls },
 *     byProvider?: { <provider>: usd }, calls?, unverifiedUsd?, profile?, at, receivedAt }
 * The stored shape normalizes to itself, so a stored value read back is unchanged.
 */

const GROUP_KEY = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const PROFILE = /^[a-z]{1,20}$/;
const MAX_GROUPS = 200;
const MAX_USD = 100_000;
const MAX_CALLS = 1e7;

function clean(value) {
  return String(value ?? '').trim();
}

function usd(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_USD) return null;
  return Math.round(n * 1e6) / 1e6;
}

function callCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < MAX_CALLS ? n : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoOrEmpty(value) {
  const text = clean(value);
  if (!text) return '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

/** The USD amount of one spend group: a number, or the `usd` of a { usd, calls } group (null when unusable). */
export function groupUsd(value) {
  return usd(isPlainObject(value) ? value.usd : value);
}

/**
 * Spend groups (byTask, byProvider) as { amounts: { <key>: usd }, calls: { <key>: n } }. Entries with a
 * bad key or no usable amount are skipped. Calls come from a { usd, calls } group or from `callsSource`.
 */
function normalizeGroups(source, callsSource = null) {
  const amounts = {};
  const calls = {};
  if (!isPlainObject(source)) return { amounts, calls };
  const extraCalls = isPlainObject(callsSource) ? callsSource : {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(amounts).length >= MAX_GROUPS) break;
    const amount = groupUsd(value);
    if (!GROUP_KEY.test(key) || amount === null) continue;
    amounts[key] = amount;
    const count = callCount(isPlainObject(value) && value.calls !== undefined ? value.calls : extraCalls[key]);
    if (count !== null) calls[key] = count;
  }
  return { amounts, calls };
}

/**
 * A clean aiSpend record, or null when `raw` has no usable spend (no total and no per-task amounts).
 * Unknown fields are dropped; keys, amounts and counts are bounded.
 */
export function normalizeRunAiSpend(raw, { runId = '', receivedAt = '' } = {}) {
  if (!isPlainObject(raw)) return null;
  const tasks = normalizeGroups(raw.byTask, raw.callsByTask);
  const providers = normalizeGroups(raw.byProvider);
  let total = usd(raw.totalUsd);
  if (total === null && raw.totalUsd !== undefined && raw.totalUsd !== null && raw.totalUsd !== '') return null;
  if (total === null) {
    if (!Object.keys(tasks.amounts).length) return null;
    total = usd(Object.values(tasks.amounts).reduce((sum, value) => sum + value, 0));
    if (total === null) return null;
  }
  const out = {
    runId: clean(raw.runId || runId).slice(0, 200),
    totalUsd: total,
    byTask: tasks.amounts,
    at: isoOrEmpty(raw.at) || isoOrEmpty(receivedAt) || '',
    receivedAt: isoOrEmpty(raw.receivedAt) || isoOrEmpty(receivedAt) || '',
  };
  if (Object.keys(tasks.calls).length) out.callsByTask = tasks.calls;
  if (Object.keys(providers.amounts).length) out.byProvider = providers.amounts;
  const calls = callCount(raw.calls);
  if (calls !== null) out.calls = calls;
  const unverified = usd(raw.unverifiedUsd);
  if (unverified !== null) out.unverifiedUsd = unverified;
  const profile = clean(raw.profile).toLowerCase();
  if (PROFILE.test(profile)) out.profile = profile;
  return out;
}

// Daily retention purge. Every registered personal-data store with a purge handler (lib/personal-data.js)
// is asked for its expired items, with the retention.* settings:
//   privacy.purge.enabled false (default)  nothing runs, nothing is written;
//   privacy.purge.mode 'shadow' (default)  only a would-purge report is written, nothing is deleted;
//   privacy.purge.mode 'auto'              the items are deleted, and the report says what went.
// Reports go to <dataDir>/privacy/purge-reports/ and hold ids and paths only. The delivery loop runs
// tickSteps; runRetentionPurge can also be called directly (tests, a manual run).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import { acquireLease } from '../data/email-store.js';
import { purgeStores } from './personal-data.js';
import { purgeSettings } from './privacy-settings.js';

// The legal texts read the retention rules from here or from lib/personal-data.js.
export { retentionText } from './personal-data.js';

export const RETENTION_PURGE_EVERY_MS = 86_400_000;
export const PURGE_REPORTS_DIR = join('privacy', 'purge-reports');
export const PURGE_STATE_FILE = join('privacy', 'retention-state.json');
export const PURGE_REPORTS_KEEP = 30;
export const PURGE_REPORT_KIND = 'asoldi.retention-purge-report';
export const PURGE_LEASE_MS = 10 * 60 * 1000;

function nowDate(now) {
  if (now instanceof Date) return now;
  const parsed = new Date(now ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function base(dataDir) {
  return dataDir || getPersistentDataDir();
}

function readState(dataDir) {
  try {
    return JSON.parse(readFileSync(join(base(dataDir), PURGE_STATE_FILE), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function pruneReports(dataDir, keep = PURGE_REPORTS_KEEP) {
  const dir = join(base(dataDir), PURGE_REPORTS_DIR);
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, name), { force: true });
}

export function listPurgeReports({ dataDir } = {}) {
  const dir = join(base(dataDir), PURGE_REPORTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse();
}

/**
 * One purge run. Returns { ran: false, reason } when the switch is off or the last run was less than
 * everyMs ago (unless `force`), else { ran: true, mode, dryRun, report, counts }.
 */
export async function runRetentionPurge({ settings, now = new Date(), dataDir, force = false, everyMs = RETENTION_PURGE_EVERY_MS } = {}) {
  const purge = purgeSettings(settings);
  if (!purge.enabled) return { ran: false, reason: 'disabled' };
  const at = nowDate(now);
  const state = readState(dataDir);
  const last = Date.parse(String(state.lastRunAt || ''));
  if (!force && Number.isFinite(last) && at.getTime() - last < everyMs && at.getTime() >= last) {
    return { ran: false, reason: 'not-due', lastRunAt: state.lastRunAt };
  }
  // One run at a time across hub processes (the loop tick and a manual run).
  const lease = await acquireLease('retention-purge', PURGE_LEASE_MS);
  if (!lease) return { ran: false, reason: 'busy' };
  try {
    return await purgeOnce({ purge, at, dataDir, settings });
  } finally {
    await lease.release();
  }
}

async function purgeOnce({ purge, at, dataDir, settings }) {
  const dryRun = purge.mode !== 'auto';
  const stores = await purgeStores({ dryRun, dataDir, now: at, settings });
  const counts = Object.fromEntries(stores.map((row) => [row.id, row.items.length]));
  const report = {
    kind: PURGE_REPORT_KIND,
    at: at.toISOString(),
    mode: purge.mode,
    dryRun,
    stores: stores.map((row) => ({
      id: row.id,
      [dryRun ? 'wouldPurge' : 'purged']: row.items,
      ...(row.error ? { error: row.error } : {}),
    })),
  };
  const name = `${at.toISOString().replace(/[:.]/g, '-')}-${dryRun ? 'shadow' : 'auto'}.json`;
  writeJsonAtomic(join(base(dataDir), PURGE_REPORTS_DIR, name), report);
  pruneReports(dataDir);
  writeJsonAtomic(join(base(dataDir), PURGE_STATE_FILE), { lastRunAt: at.toISOString(), mode: purge.mode, report: name });
  return { ran: true, mode: purge.mode, dryRun, report: name, counts };
}

/** The delivery loop's step: once a day, global. Nothing runs while the loop is off or the switch is off. */
export const tickSteps = Object.freeze([
  {
    name: 'retention-purge',
    order: 90,
    scope: 'global',
    everyMs: RETENTION_PURGE_EVERY_MS,
    async run(ctx = {}) {
      if (ctx.mode === 'off') return { wrote: false };
      const result = await runRetentionPurge({ settings: ctx.settings, now: ctx.now, dataDir: ctx.dataDir });
      return { wrote: result.ran === true, ...result };
    },
  },
]);

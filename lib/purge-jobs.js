// Erasing one client's developer-agent data on the hub (stored reports and thumbnails), and the purge job
// that asks the Maker host to erase its side.
//
// Two steps, never one:
//   1. report   lists every file that would go and writes <dataDir>/purge-reports/<id>.json plus a backup
//               listing <dataDir>/purge-reports/<id>.listing.json (path, bytes, sha256). Nothing else is written
//               and nothing is deleted.
//   2. delete   needs that report id and the path of its backup listing. Files whose hash no longer matches
//               the listing stay. A report applies once and goes stale after 7 days.
// A refused call writes nothing. The route (lib/routes/dev-report-routes.js) is admin only and answers
// 404 {code:'disabled'} while the purgeJobs switch is off.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import { DEV_REPORT_DIR, clientReportDir } from './dev-reports.js';

export const PURGE_REPORT_DIR = 'purge-reports';
export const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_ID_RE = /^rpt_[0-9a-f]{16}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{1,80}$/;

export class PurgeRefused extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export function purgeJobsEnabled(settings) {
  const node = settings?.purgeJobs;
  if (!node || node.enabled !== true) return false;
  if (node.paused && typeof node.paused === 'object') return false;
  return true;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function dataRoot(dataDir) {
  return dataDir || getPersistentDataDir();
}

function reportsDir(dataDir) {
  return join(dataRoot(dataDir), PURGE_REPORT_DIR);
}

function walk(base, rel = '') {
  const out = [];
  let names = [];
  try {
    names = readdirSync(join(base, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(base, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Plans the erase of one client's stored developer reports and thumbnails. Writes nothing. */
export function planClientPurge({ salesClientId, dataDir, now = new Date() } = {}) {
  const id = String(salesClientId || '');
  if (!CLIENT_RE.test(id)) throw new PurgeRefused('bad-client', 400, 'Not a sales client id.');
  const base = dataRoot(dataDir);
  const clientDir = clientReportDir(id, { dataDir });
  const entries = walk(clientDir).map((rel) => {
    const path = `${DEV_REPORT_DIR}/${id}/${rel}`;
    const buffer = readFileSync(join(base, ...path.split('/')));
    return { rel: path, bytes: buffer.length, sha256: sha256(buffer) };
  });
  const shots = entries.filter((entry) => entry.rel.includes('/shots/')).length;
  const createdAt = now.toISOString();
  const reportId = `rpt_${sha256(`${id}|${createdAt}|${randomBytes(4).toString('hex')}`).slice(0, 16)}`;
  const report = {
    contract: 'purge-report/1',
    reportId,
    createdAt,
    status: 'open',
    target: { salesClientId: id },
    items: entries,
    counts: { files: entries.length, reports: entries.length - shots, shots, bytes: entries.reduce((n, e) => n + e.bytes, 0) },
    listingHash: sha256(JSON.stringify(entries)),
  };
  const listing = { contract: 'purge-backup-listing/1', reportId, createdAt, entries };
  return { report, listing };
}

/** Report mode: plan and write the report and its listing. Deletes nothing. */
export function reportClientPurge({ salesClientId, dataDir, now } = {}) {
  const { report, listing } = planClientPurge({ salesClientId, dataDir, now });
  const dir = reportsDir(dataDir);
  const listingFile = join(dir, `${report.reportId}.listing.json`);
  writeJson(listingFile, listing);
  writeJson(join(dir, `${report.reportId}.json`), report);
  return { reportId: report.reportId, listingFile, counts: report.counts, target: report.target };
}

function dropEmptyParents(base, rel) {
  let dir = join(base, ...rel.split('/').slice(0, -1));
  const stop = resolve(base, DEV_REPORT_DIR);
  while (resolve(dir) !== stop && resolve(dir).startsWith(stop)) {
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = join(dir, '..');
  }
}

/**
 * Delete mode. `backupListing` is the listing file path from the report step. Refused (and nothing
 * touched) without a stored open report and a listing that belongs to it.
 */
export function applyClientPurge({ reportId, backupListing, dataDir, now = new Date() } = {}) {
  if (!REPORT_ID_RE.test(String(reportId || ''))) throw new PurgeRefused('no-report', 400, 'Delete needs the id of a prior report.');
  const reportFile = join(reportsDir(dataDir), `${reportId}.json`);
  const report = readJson(reportFile);
  if (!report || report.reportId !== reportId) throw new PurgeRefused('no-report', 400, 'No stored report has that id.');
  if (report.status !== 'open') throw new PurgeRefused('report-used', 409, 'That report was already applied.');
  if (now.getTime() - Date.parse(report.createdAt) > REPORT_MAX_AGE_MS) throw new PurgeRefused('report-stale', 409, 'The report is older than 7 days.');
  const listingPath = String(backupListing || '');
  const listing = listingPath ? readJson(resolveListing(listingPath, dataDir)) : null;
  if (!listing || listing.reportId !== reportId || !Array.isArray(listing.entries) || sha256(JSON.stringify(listing.entries)) !== report.listingHash) {
    throw new PurgeRefused('no-backup-listing', 400, 'The backup listing is missing or does not belong to that report.');
  }
  const base = dataRoot(dataDir);
  const known = new Map(listing.entries.map((entry) => [entry.rel, entry]));
  const result = { reportId, removed: 0, changed: 0 };
  for (const item of report.items) {
    const listed = known.get(item.rel);
    const full = join(base, ...item.rel.split('/'));
    if (!listed || !item.rel.startsWith(`${DEV_REPORT_DIR}/`) || item.rel.includes('..')) {
      result.changed += 1;
      continue;
    }
    if (!existsSync(full)) continue;
    if (sha256(readFileSync(full)) !== listed.sha256) {
      result.changed += 1;
      continue;
    }
    rmSync(full, { force: true });
    dropEmptyParents(base, item.rel);
    result.removed += 1;
  }
  report.status = 'applied';
  report.appliedAt = now.toISOString();
  report.result = result;
  writeJson(reportFile, report);
  return result;
}

/** The listing is read from the purge-reports folder only: a name or a path whose last segment is the listing file. */
function resolveListing(path, dataDir) {
  const name = String(path).split(/[\\/]/).pop();
  if (!/^rpt_[0-9a-f]{16}\.listing\.json$/.test(name)) return join(reportsDir(dataDir), 'missing.listing.json');
  return join(reportsDir(dataDir), name);
}

/** Size of the purge folder, for the route's status answer. */
export function purgeReportCount({ dataDir } = {}) {
  try {
    return readdirSync(reportsDir(dataDir)).filter((name) => /^rpt_[0-9a-f]{16}\.json$/.test(name) && statSync(join(reportsDir(dataDir), name)).isFile()).length;
  } catch {
    return 0;
  }
}

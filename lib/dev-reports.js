// Developer-agent reports a Maker sends (contract dev-report/1): validation, storage and the summary
// kept on the client's makerRun.
//
// Layout under <dataDir>/dev-reports/<salesClientId>/:
//   <sessionId>.json                 { receivedAt, reportRev, runId, report }   the latest revision per session
//   shots/<sessionId>/<thumb_NN>.jpg thumbnails the report names (served to staff only)
// At most REPORTS_PER_CLIENT sessions are kept per client; older ones go with their thumbnails.
//
// A refused request writes nothing: validateDevReport runs before any store function.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeMakerHostToken } from '../data/maker-hosts.js';
import { getPersistentDataDir } from '../data/storage-path.js';

export const DEV_REPORT_CONTRACT = 'dev-report/1';
export const MAX_REPORT_BYTES = 65_536;
export const MAX_SHOT_BYTES = 153_600;
export const MAX_SHOTS_PER_SESSION = 12;
export const REPORTS_PER_CLIENT = 20;
export const DEV_REPORT_DIR = 'dev-reports';

const SESSION_RE = /^ds_[a-z0-9_]{6,60}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const JOB_RE = /^job_[a-z0-9]{8,40}$/;
const CR_RE = /^cr_[a-z0-9]{8,40}$/;
const DIRECTIVE_RE = /^dir-[a-z0-9]{6,40}$/;
export const SHOT_RE = /^thumb_[0-9]{2}$/;
const ENDPOINT_RE = /^((\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+):\d{2,5}$|^(local|loopback)?$/;
const KINDS = new Set(['initial', 'iteration', 'change_request', 'manual', 'media-refresh']);
const STATUSES = new Set(['review', 'accepted', 'reverted', 'failed', 'cancelled', 'interrupted', 'render-unavailable']);
const DIRECTIVE_STATUSES = new Set(['applied', 'failed', 'reverted', 'pending', 'lock', 'question', 'skipped', 'needs-human']);
const RENDER_STATUSES = new Set(['ok', 'render-unavailable', 'not-required']);
const TOP_KEYS = new Set(['contract', 'runId', 'salesClientId', 'reportRev', 'dev']);
const DEV_KEYS = new Set([
  'sessionId', 'kind', 'status', 'profile', 'jobId', 'briefHash', 'costUsd', 'startedAt', 'endedAt', 'counts', 'auditBefore',
  'auditAfter', 'directives', 'questions', 'qaProposal', 'thumbs', 'steps', 'changesSinceClientPreview', 'quotaUnits',
  'changeRequestId', 'render',
]);

// What may never be in a report body (an edge filter in front of the hub drops loopback addresses anyway).
const LOOPBACK_RE = /(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/i;
const URL_RE = /\b(?:https?|wss?):\/\/([^\s"'<>/:?#]+)|\bfile:/gi;
const PRIVATE_HOST_RE = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|[a-z0-9.-]+\.(local|internal))$/i;
const PATH_RE = /(^|[\s"'(=:])(\/app\/|\/tmp\/|\/Users\/|[A-Za-z]:[\\/]|\\\\)|\.generated-runs/;
const TOKEN_RE = /\bBearer\s+\S|\bsk-[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{20,}/;

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function devReportEnabled(settings) {
  const node = settings?.devReport;
  if (!node || node.enabled !== true) return false;
  if (node.paused && typeof node.paused === 'object') return false;
  return true;
}

const bad = (field, code = 'bad-report') => ({ ok: false, status: code === 'forbidden-content' ? 422 : 400, code, field });

function str(value, max = 500) {
  return typeof value === 'string' && value.length <= max;
}

function intIn(value, min, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pair(value, a, b) {
  return isPlain(value) && intIn(value[a], 0) && intIn(value[b], 0);
}

/** First forbidden string in `value` (path of the field), or ''. render.endpoint is checked by its own pattern. */
function forbiddenIn(value, path = '') {
  if (typeof value === 'string') {
    if (path === 'dev.render.endpoint') return '';
    if (LOOPBACK_RE.test(value) || PATH_RE.test(value) || TOKEN_RE.test(value)) return path;
    for (const match of value.matchAll(URL_RE)) {
      if (/^file:/i.test(match[0]) || PRIVATE_HOST_RE.test(String(match[1] || ''))) return path;
    }
    for (const word of value.match(/[A-Za-z0-9_.-]{24,}/g) || []) if (looksLikeMakerHostToken(word)) return path;
    return '';
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = forbiddenIn(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return '';
  }
  if (isPlain(value)) {
    for (const [key, item] of Object.entries(value)) {
      const hit = forbiddenIn(item, path ? `${path}.${key}` : key) || (typeof key === 'string' && LOOPBACK_RE.test(key) ? `${path}.${key}` : '');
      if (hit) return hit;
    }
  }
  return '';
}

/**
 * Shape check, then content rules. Returns { ok: true, report } or { ok: false, status, code, field }.
 * `routeRunId` is :runId of the route; the body's runId must equal it.
 */
export function validateDevReport(body, { routeRunId = '' } = {}) {
  if (!isPlain(body)) return bad('body');
  for (const key of Object.keys(body)) if (!TOP_KEYS.has(key)) return bad(key);
  if (body.contract !== DEV_REPORT_CONTRACT) return bad('contract');
  if (typeof body.runId !== 'string' || !RUN_RE.test(body.runId) || body.runId !== routeRunId) return bad('runId');
  if (body.salesClientId !== undefined && !(str(body.salesClientId, 120) && body.salesClientId)) return bad('salesClientId');
  if (!intIn(body.reportRev, 1)) return bad('reportRev');
  const dev = body.dev;
  if (!isPlain(dev)) return bad('dev');
  for (const key of Object.keys(dev)) if (!DEV_KEYS.has(key)) return bad(`dev.${key}`);
  if (typeof dev.sessionId !== 'string' || !SESSION_RE.test(dev.sessionId)) return bad('dev.sessionId');
  if (!KINDS.has(dev.kind)) return bad('dev.kind');
  if (!STATUSES.has(dev.status)) return bad('dev.status');
  if (dev.profile !== 'prod' && dev.profile !== 'test') return bad('dev.profile');
  if (dev.jobId !== null && !(typeof dev.jobId === 'string' && JOB_RE.test(dev.jobId))) return bad('dev.jobId');
  if (!str(dev.briefHash, 80)) return bad('dev.briefHash');
  if (typeof dev.costUsd !== 'number' || !(dev.costUsd >= 0)) return bad('dev.costUsd');
  if (!(str(dev.startedAt, 40) && Number.isFinite(Date.parse(dev.startedAt)))) return bad('dev.startedAt');
  if (dev.endedAt !== null && !(str(dev.endedAt, 40) && Number.isFinite(Date.parse(dev.endedAt)))) return bad('dev.endedAt');
  const c = dev.counts;
  if (!isPlain(c) || !['tasks', 'done', 'needsHuman', 'failed', 'reverted'].every((k) => intIn(c[k], 0))) return bad('dev.counts');
  if (!pair(dev.auditBefore, 'hard', 'soft')) return bad('dev.auditBefore');
  if (!pair(dev.auditAfter, 'hard', 'soft')) return bad('dev.auditAfter');

  if (!Array.isArray(dev.directives) || dev.directives.length > 200) return bad('dev.directives');
  const seen = new Set();
  for (const [i, d] of dev.directives.entries()) {
    const at = `dev.directives[${i}]`;
    if (!isPlain(d) || !DIRECTIVE_RE.test(String(d.id || ''))) return bad(`${at}.id`);
    if (seen.has(d.id)) return bad('dev.directives');
    seen.add(d.id);
    if (!DIRECTIVE_STATUSES.has(d.status)) return bad(`${at}.status`);
    if (d.taskId !== undefined && !str(d.taskId, 40)) return bad(`${at}.taskId`);
    if (d.reason !== undefined && !str(d.reason, 200)) return bad(`${at}.reason`);
    if ((d.status === 'skipped' || d.status === 'needs-human') && !(typeof d.reason === 'string' && d.reason.trim())) return bad(`${at}.reason`);
    for (const key of Object.keys(d)) if (!['id', 'status', 'taskId', 'reason'].includes(key)) return bad(`${at}.${key}`);
  }
  if (!Array.isArray(dev.questions) || dev.questions.length > 50) return bad('dev.questions');
  for (const [i, q] of dev.questions.entries()) {
    if (!isPlain(q) || !str(q.id, 40) || !q.id || !str(q.text, 300) || typeof q.askClient !== 'boolean') return bad(`dev.questions[${i}]`);
  }
  const qa = dev.qaProposal;
  if (!isPlain(qa) || ['textOk', 'mediaOk', 'responsiveOk'].some((k) => typeof qa[k] !== 'boolean')) return bad('dev.qaProposal');
  if (!str(qa.evidence, 300)) return bad('dev.qaProposal.evidence');
  if (!Array.isArray(dev.thumbs) || dev.thumbs.length > MAX_SHOTS_PER_SESSION) return bad('dev.thumbs');
  for (const [i, t] of dev.thumbs.entries()) {
    if (!isPlain(t) || !str(t.taskId, 40) || !SHOT_RE.test(String(t.before)) || !SHOT_RE.test(String(t.after))) return bad(`dev.thumbs[${i}]`);
  }
  const steps = dev.steps;
  if (!isPlain(steps) || Object.keys(steps).some((k) => !['cms', 'dev', 'dev-verify'].includes(k) || !str(steps[k], 20))) return bad('dev.steps');
  if (dev.changesSinceClientPreview !== undefined) {
    if (dev.kind !== 'iteration' || !Array.isArray(dev.changesSinceClientPreview) || dev.changesSinceClientPreview.length > 50 || dev.changesSinceClientPreview.some((s) => !str(s, 200))) {
      return bad('dev.changesSinceClientPreview');
    }
  }
  if (dev.quotaUnits !== undefined && (dev.kind !== 'change_request' || !intIn(dev.quotaUnits, 0, 10))) return bad('dev.quotaUnits');
  if (dev.changeRequestId !== undefined && (dev.kind !== 'change_request' || !(typeof dev.changeRequestId === 'string' && CR_RE.test(dev.changeRequestId)))) return bad('dev.changeRequestId');

  const r = dev.render;
  if (!isPlain(r) || !RENDER_STATUSES.has(r.status) || typeof r.required !== 'boolean') return bad('dev.render');
  if (typeof r.endpoint !== 'string') return bad('dev.render.endpoint');
  if (!ENDPOINT_RE.test(r.endpoint)) return bad('dev.render.endpoint', 'forbidden-content');
  if (!Array.isArray(r.widths) || r.widths.length > 3 || r.widths.some((w) => !intIn(w, 1, 10000))) return bad('dev.render.widths');
  if (!Array.isArray(r.routes) || r.routes.length > 60) return bad('dev.render.routes');
  for (const [i, route] of r.routes.entries()) {
    if (!isPlain(route) || !str(route.route, 500) || !isPlain(route.captures) || Object.values(route.captures).some((n) => !intIn(n, 0))) return bad(`dev.render.routes[${i}]`);
  }
  // Every other string is at most 500 characters.
  const over = longString(body);
  if (over) return bad(over);
  const hit = forbiddenIn(body);
  if (hit) return bad(hit, 'forbidden-content');
  return { ok: true, report: body };
}

function longString(value, path = '') {
  if (typeof value === 'string') return value.length > 500 ? path : '';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = longString(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (isPlain(value)) {
    for (const [key, item] of Object.entries(value)) {
      const hit = longString(item, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return '';
}

/** The small summary kept on client.makerRun.dev (at most 2 KB). */
export function devSummaryOf(report, { receivedAt, reportRev }) {
  const dev = report.dev;
  let minCaptures = 0;
  const counts = [];
  for (const route of dev.render.routes) for (const n of Object.values(route.captures)) counts.push(n);
  if (counts.length) minCaptures = Math.min(...counts);
  return {
    sessionId: dev.sessionId,
    kind: dev.kind,
    status: dev.status,
    profile: dev.profile,
    counts: dev.counts,
    auditBefore: dev.auditBefore,
    auditAfter: dev.auditAfter,
    steps: dev.steps,
    render: { status: dev.render.status, endpoint: dev.render.endpoint, routes: dev.render.routes.length, minCaptures },
    receivedAt,
    reportRev,
  };
}

// ---------------------------------------------------------------- store

function root(dataDir) {
  return join(dataDir || getPersistentDataDir(), DEV_REPORT_DIR);
}

export function clientReportDir(clientId, { dataDir } = {}) {
  if (!CLIENT_RE.test(String(clientId || ''))) throw new Error('Not a client id.');
  return join(root(dataDir), String(clientId));
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sessionFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json') && SESSION_RE.test(name.slice(0, -5)));
  } catch {
    return [];
  }
}

/** Stored reports of a client, newest first: [{ sessionId, receivedAt, reportRev, runId, report }]. */
export function listReports(clientId, { dataDir } = {}) {
  const dir = clientReportDir(clientId, { dataDir });
  const out = [];
  for (const name of sessionFiles(dir)) {
    const row = readJson(join(dir, name));
    if (row?.report) out.push({ sessionId: name.slice(0, -5), ...row });
  }
  return out.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}

export function listShots(clientId, { dataDir } = {}) {
  const base = join(clientReportDir(clientId, { dataDir }), 'shots');
  const out = [];
  let sessions = [];
  try {
    sessions = readdirSync(base);
  } catch {
    return out;
  }
  for (const sessionId of sessions.sort()) {
    if (!SESSION_RE.test(sessionId)) continue;
    for (const file of readdirSync(join(base, sessionId)).sort()) {
      const shot = file.replace(/\.jpg$/, '');
      if (!SHOT_RE.test(shot)) continue;
      out.push({ sessionId, shot, bytes: statSync(join(base, sessionId, file)).size });
    }
  }
  return out;
}

/**
 * Stores a validated report. Returns { stored: true, ... } or { stored: false, duplicate: true } for a
 * session revision that is already stored (or older than the stored one).
 */
export function storeReport(clientId, report, { dataDir, now = new Date() } = {}) {
  const dir = clientReportDir(clientId, { dataDir });
  const sessionId = report.dev.sessionId;
  const file = join(dir, `${sessionId}.json`);
  const previous = readJson(file);
  if (previous && Number(previous.reportRev) >= report.reportRev) return { stored: false, duplicate: true };
  const receivedAt = now.toISOString();
  writeJson(file, { receivedAt, reportRev: report.reportRev, runId: report.runId, report });
  prune(clientId, { dataDir });
  return { stored: true, sessionId, reportRev: report.reportRev, receivedAt, bytes: Buffer.byteLength(JSON.stringify(report)) };
}

function prune(clientId, { dataDir }) {
  const rows = listReports(clientId, { dataDir });
  const dir = clientReportDir(clientId, { dataDir });
  for (const row of rows.slice(REPORTS_PER_CLIENT)) {
    rmSync(join(dir, `${row.sessionId}.json`), { force: true });
    rmSync(join(dir, 'shots', row.sessionId), { recursive: true, force: true });
  }
}

export function hasSession(clientId, sessionId, { dataDir } = {}) {
  return SESSION_RE.test(String(sessionId)) && existsSync(join(clientReportDir(clientId, { dataDir }), `${sessionId}.json`));
}

/** Stores one thumbnail. Returns { ok, ... } or { ok: false, status, code }. */
export function storeShot(clientId, sessionId, shot, buffer, { dataDir } = {}) {
  if (!SHOT_RE.test(String(shot))) return { ok: false, status: 400, code: 'bad-shot-id' };
  if (!hasSession(clientId, sessionId, { dataDir })) return { ok: false, status: 404, code: 'unknown-session' };
  const dir = join(clientReportDir(clientId, { dataDir }), 'shots', sessionId);
  const file = join(dir, `${shot}.jpg`);
  let existing = [];
  try {
    existing = readdirSync(dir);
  } catch {
    existing = [];
  }
  if (!existsSync(file) && existing.length >= MAX_SHOTS_PER_SESSION) return { ok: false, status: 409, code: 'too-many-shots' };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, buffer, { mode: 0o600 });
  renameSync(tmp, file);
  return { ok: true, shot, bytes: buffer.length };
}

export function readShot(clientId, sessionId, shot, { dataDir } = {}) {
  if (!SESSION_RE.test(String(sessionId)) || !SHOT_RE.test(String(shot))) return null;
  try {
    return readFileSync(join(clientReportDir(clientId, { dataDir }), 'shots', sessionId, `${shot}.jpg`));
  } catch {
    return null;
  }
}

/** True for a JPEG (FF D8 FF). */
export function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

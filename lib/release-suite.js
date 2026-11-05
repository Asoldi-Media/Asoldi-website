// Release suite reports: what scripts/release-suite.mjs writes and what the promotion route accepts
// before it records a release pass (recordReleasePass).
//
// A report is { schema, createdAt, suite, code, profile, clients, switches, metrics, digest,
// signature }. `switches` maps a release id (RELEASE_GATED_SWITCHES) to { status: 'pass' | 'fail' |
// 'not-covered', checks: [ids], findings: [text] }. `digest` is the sha256 of the canonical JSON of
// the report without digest and signature; `signature` is an HMAC-SHA256 of the digest with the
// release key.
//
// The release key is 32 random bytes in <dataDir>/secrets/release-suite.key (owner-only file). The
// suite creates it on the operator PC; a hub verifies with its own copy (a local hub gets it when
// the suite seeds its data folder, another hub through a superadmin paste). A hub without a key
// records no pass.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RELEASE_GATED_SWITCHES } from '../packages/suite/core/delivery/vocab.js';

export const RELEASE_REPORT_SCHEMA = 'asoldi.release-suite/1';
export const RELEASE_KEY_FILE = join('secrets', 'release-suite.key');
export const RELEASE_REPORT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const RELEASE_STATUSES = Object.freeze(['pass', 'fail', 'not-covered']);
const KEY_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with sorted object keys (the digest input). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function reportDigest(report) {
  const body = { ...(isPlainObject(report) ? report : {}) };
  delete body.digest;
  delete body.signature;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function releaseKeyPath({ dataDir } = {}) {
  return join(dataDir, RELEASE_KEY_FILE);
}

export function keyId(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/** The release key in `file` ('' when missing or malformed). */
export function readReleaseKeyFile(file) {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return KEY_RE.test(value) ? value : '';
  } catch {
    return '';
  }
}

/** Writes a key to `file` (owner-only). Refuses a malformed key. */
export function writeReleaseKeyFile(file, key) {
  const value = String(key || '').trim().toLowerCase();
  if (!KEY_RE.test(value)) throw Object.assign(new Error('A release key is 64 hex characters.'), { code: 'bad-key' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps its own ACLs
  }
  return { keyId: keyId(value) };
}

/** The key in `file`, created when missing. */
export function ensureReleaseKeyFile(file) {
  const existing = readReleaseKeyFile(file);
  if (existing) return existing;
  const key = randomBytes(32).toString('hex');
  writeReleaseKeyFile(file, key);
  return key;
}

/** The report with its digest and signature. */
export function signReleaseReport(report, key) {
  if (!KEY_RE.test(String(key || ''))) throw new Error('signReleaseReport needs the release key');
  const body = { ...report };
  delete body.digest;
  delete body.signature;
  const digest = reportDigest(body);
  const value = createHmac('sha256', Buffer.from(key, 'hex')).update(digest).digest('hex');
  return { ...body, digest, signature: { alg: 'hmac-sha256', keyId: keyId(key), value } };
}

function sameHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * Checks a report: schema, digest, signature (when a key is given) and age.
 * Returns { ok, problems: [text], signature: 'valid' | 'invalid' | 'no-key' | 'missing' }.
 */
export function verifyReleaseReport(report, { key = '', now = Date.now(), maxAgeMs = RELEASE_REPORT_MAX_AGE_MS } = {}) {
  const problems = [];
  if (!isPlainObject(report)) return { ok: false, problems: ['The report is not a JSON object.'], signature: 'missing' };
  if (report.schema !== RELEASE_REPORT_SCHEMA) problems.push(`The report schema is not ${RELEASE_REPORT_SCHEMA}.`);
  if (!isPlainObject(report.switches)) problems.push('The report lists no switches.');
  const digest = reportDigest(report);
  if (report.digest !== digest) problems.push('The report digest does not match its content.');
  const created = Date.parse(String(report.createdAt || ''));
  if (!Number.isFinite(created)) problems.push('The report has no creation time.');
  else if (now - created > maxAgeMs) problems.push('The report is older than 14 days.');
  else if (created - now > 5 * 60_000) problems.push('The report is dated in the future.');
  let signature = 'missing';
  const sig = isPlainObject(report.signature) ? report.signature : null;
  if (!key) signature = 'no-key';
  else if (!sig || sig.alg !== 'hmac-sha256') signature = 'missing';
  else {
    const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(digest).digest('hex');
    signature = sameHex(expected, sig.value) ? 'valid' : 'invalid';
  }
  if (signature !== 'valid') problems.push(signature === 'no-key' ? 'This hub holds no release key.' : `The report signature is ${signature}.`);
  return { ok: problems.length === 0, problems, signature };
}

/** Release ids the report marks as passed (only ids RELEASE_GATED_SWITCHES knows). */
export function passedSwitches(report) {
  const switches = isPlainObject(report?.switches) ? report.switches : {};
  return Object.entries(switches)
    .filter(([id, row]) => RELEASE_GATED_SWITCHES.includes(id) && row?.status === 'pass')
    .map(([id]) => id)
    .sort();
}

/** The evidence line recordReleasePass stores for a pass from this report. */
export function reportEvidence(report) {
  const code = isPlainObject(report?.code) ? report.code : {};
  return [
    `report ${String(report?.digest || '').slice(0, 16)}`,
    report?.signature?.keyId ? `key ${report.signature.keyId}` : '',
    code.commit ? `code ${String(code.commit).slice(0, 12)}` : '',
    report?.profile ? `profile ${report.profile}` : '',
    Number.isFinite(Number(report?.clients)) ? `${Number(report.clients)} clients` : '',
  ].filter(Boolean).join('; ');
}

/** True when the hub at `dataDir` holds a release key. */
export function releaseKeyInstalled({ dataDir } = {}) {
  const file = releaseKeyPath({ dataDir });
  return existsSync(file) && Boolean(readReleaseKeyFile(file));
}

/**
 * Maker hosts: one row per Website Maker install that may call the hub (WS0.4), plus the
 * routing fields a host reports in its heartbeat (WS8.25).
 *
 * <dataDir>/maker-hosts.json
 *   { version: 1, hosts: [ {
 *       hostId: 'mh_<8 hex>', label, ownerAccountKey,
 *       tokenHash: 'sha256:<64 hex>', tokenPrefix: 'mkr_<8 hex>',
 *       scopes: ['callback', 'preview-push', 'client-bundle', 'jobs'],
 *       createdAt, createdBy, lastSeenAt, revokedAt, revokedBy,
 *       runIds: [...], capabilities: { handlers: [...], vision, cdp }, version, makerPort   // WS8.25
 *   } ] }
 *
 * - A host token is `mkr_<hex of hostId>_<43 base64url chars>` (32 random bytes). It is shown once
 *   when the host is created; the file keeps only its sha256. A lookup goes by the hostId part, and
 *   the hash compare runs in constant time.
 * - lastSeenAt is written at most every LAST_SEEN_WRITE_MS (5 min) per host; the WS8.25 fields
 *   only when their value changes. A heartbeat with nothing new writes nothing.
 * - Every change is a locked read-modify-write on a fresh read (data/atomic-json.js), so hub
 *   processes that share the data dir never lose each other's writes. Reads on the request path
 *   go through the mtime cache: a revocation in another process applies within a second.
 * - The file holds no secret value, but it is written with mode 0600 like the other auth files.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { readJsonCached, readJsonFresh, updateJsonLocked } from './atomic-json.js';
import { getPersistentDataDir } from './storage-path.js';
import { JOB_KINDS } from '../packages/suite/core/delivery/vocab.js';

export const MAKER_HOSTS_FILE = 'maker-hosts.json';
export const MAKER_HOST_SCOPES = Object.freeze(['callback', 'preview-push', 'client-bundle', 'jobs']);
export const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;
export const MAX_MAKER_HOSTS = 100;
export const MAX_HOST_RUN_IDS = 500;
export const MAKER_HOST_ID_RE = /^mh_[0-9a-f]{6,16}$/;
const TOKEN_RE = /^mkr_([0-9a-f]{6,16})_([A-Za-z0-9_-]{43})$/;
const HOST_HEX_BYTES = 4;
const TOKEN_RANDOM_BYTES = 32;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ACCOUNT_KEY_RE = /^[a-z0-9._:-]{1,64}$/i;
const FRESH_READ_MS = 100;

let defaultDataDir = '';
function dirOf(dataDir) {
  if (dataDir) return dataDir;
  if (!defaultDataDir) defaultDataDir = getPersistentDataDir();
  return defaultDataDir;
}

export function makerHostsPath(dataDir) {
  return join(dirOf(dataDir), MAKER_HOSTS_FILE);
}

function isoAt(now) {
  return new Date(now ?? Date.now()).toISOString();
}

function cleanIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cleanText(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function hashMakerToken(token) {
  return `sha256:${createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex')}`;
}

/** { hostId, tokenPrefix } for a well-formed host token, or null. */
export function parseMakerToken(token) {
  const match = TOKEN_RE.exec(String(token ?? '').trim());
  if (!match) return null;
  return { hostId: `mh_${match[1]}`, tokenPrefix: `mkr_${match[1]}` };
}

export function looksLikeMakerHostToken(token) {
  return Boolean(parseMakerToken(token));
}

/** Known scopes only, in canonical order; [] when none is valid. */
export function normalizeScopes(value) {
  const list = Array.isArray(value) ? value.map((scope) => String(scope ?? '').trim()) : [];
  return MAKER_HOST_SCOPES.filter((scope) => list.includes(scope));
}

export function normalizeRunIds(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw ?? '').trim();
    if (!RUN_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_HOST_RUN_IDS) break;
  }
  return out.sort();
}

export function normalizeCapabilities(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const handlers = Array.isArray(source.handlers) ? source.handlers.map((kind) => String(kind ?? '').trim()) : [];
  return {
    handlers: JOB_KINDS.filter((kind) => handlers.includes(kind)),
    vision: source.vision === true,
    cdp: source.cdp === true,
  };
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hostId = String(raw.hostId || '');
  const tokenHash = String(raw.tokenHash || '');
  if (!MAKER_HOST_ID_RE.test(hostId) || !/^sha256:[0-9a-f]{64}$/.test(tokenHash)) return null;
  return {
    hostId,
    label: cleanText(raw.label) || hostId,
    ownerAccountKey: ACCOUNT_KEY_RE.test(String(raw.ownerAccountKey || '')) ? String(raw.ownerAccountKey) : 'admin',
    tokenHash,
    tokenPrefix: `mkr_${hostId.slice(3)}`,
    scopes: normalizeScopes(raw.scopes),
    createdAt: cleanIso(raw.createdAt),
    createdBy: cleanText(raw.createdBy) || null,
    lastSeenAt: cleanIso(raw.lastSeenAt),
    revokedAt: cleanIso(raw.revokedAt),
    revokedBy: cleanText(raw.revokedBy) || null,
    runIds: normalizeRunIds(raw.runIds),
    capabilities: normalizeCapabilities(raw.capabilities),
    version: cleanText(raw.version, 80),
    makerPort: normalizePort(raw.makerPort),
  };
}

function normalizeFile(raw) {
  const hosts = [];
  const seen = new Set();
  for (const row of Array.isArray(raw?.hosts) ? raw.hosts : []) {
    const host = normalizeHost(row);
    if (!host || seen.has(host.hostId)) continue;
    seen.add(host.hostId);
    hosts.push(host);
  }
  return { version: 1, hosts };
}

/** The row without its hash: what the admin API and UI see. */
export function publicMakerHost(host) {
  if (!host) return null;
  const { tokenHash: _hash, ...rest } = host;
  return { ...rest, revoked: Boolean(host.revokedAt), runIdCount: host.runIds.length };
}

export function readMakerHosts({ dataDir, fresh = false } = {}) {
  const path = makerHostsPath(dataDir);
  return normalizeFile(fresh ? readJsonFresh(path) : readJsonCached(path));
}

export function listMakerHosts({ dataDir } = {}) {
  return readMakerHosts({ dataDir }).hosts.map(publicMakerHost);
}

export function getMakerHost(hostId, { dataDir, fresh = false } = {}) {
  const id = String(hostId || '');
  return readMakerHosts({ dataDir, fresh }).hosts.find((host) => host.hostId === id) || null;
}

/**
 * Locked read-modify-write. mutate(current) returns null (nothing to do), or
 * { hosts, result, write } where write: false hands back `result` without touching the file.
 */
function change(mutate, { dataDir }) {
  let result;
  updateJsonLocked(
    makerHostsPath(dataDir),
    (raw) => {
      const current = normalizeFile(raw);
      const next = mutate(current);
      if (!next) return undefined;
      result = next.result;
      if (next.write === false) return undefined;
      return { version: 1, hosts: next.hosts };
    },
    { mode: 0o600 }
  );
  return result;
}

/**
 * Creates a host and returns { host (public row), token }. The token exists only in this return
 * value: the file keeps its sha256.
 */
export function createMakerHost({ label, scopes, ownerAccountKey, createdBy } = {}, { dataDir, now } = {}) {
  const cleanLabel = cleanText(label);
  if (!cleanLabel) throw Object.assign(new Error('label is required'), { code: 'label-required' });
  const chosen = scopes === undefined || scopes === null ? [...MAKER_HOST_SCOPES] : normalizeScopes(scopes);
  if (!chosen.length) throw Object.assign(new Error(`scopes must include one of ${MAKER_HOST_SCOPES.join(', ')}`), { code: 'scopes-required' });
  const owner = String(ownerAccountKey || '').trim();
  if (owner && !ACCOUNT_KEY_RE.test(owner)) throw Object.assign(new Error('ownerAccountKey must be an account key'), { code: 'bad-owner' });
  const at = isoAt(now);
  let token = '';
  const created = change(
    (current) => {
      if (current.hosts.length >= MAX_MAKER_HOSTS) {
        throw Object.assign(new Error(`at most ${MAX_MAKER_HOSTS} Maker hosts`), { code: 'too-many-hosts' });
      }
      const taken = new Set(current.hosts.map((host) => host.hostId));
      let hex = '';
      do hex = randomBytes(HOST_HEX_BYTES).toString('hex');
      while (taken.has(`mh_${hex}`));
      token = `mkr_${hex}_${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
      const host = normalizeHost({
        hostId: `mh_${hex}`,
        label: cleanLabel,
        ownerAccountKey: owner || 'admin',
        tokenHash: hashMakerToken(token),
        scopes: chosen,
        createdAt: at,
        createdBy,
      });
      return { hosts: [...current.hosts, host], result: host };
    },
    { dataDir }
  );
  return { host: publicMakerHost(created), token };
}

/** Revokes a host for good (its token gets 401 from now on). Returns the public row, or null. */
export function revokeMakerHost(hostId, { dataDir, now, by } = {}) {
  const id = String(hostId || '');
  const revoked = change(
    (current) => {
      const index = current.hosts.findIndex((host) => host.hostId === id);
      if (index < 0) return null;
      const host = current.hosts[index];
      if (host.revokedAt) return { result: host, write: false };
      const next = { ...host, revokedAt: isoAt(now), revokedBy: cleanText(by) || null };
      const hosts = [...current.hosts];
      hosts[index] = next;
      return { hosts, result: next };
    },
    { dataDir }
  );
  return revoked ? publicMakerHost(revoked) : null;
}

const ZERO_HASH = Buffer.alloc(32);
function hashBytes(tokenHash) {
  const hex = String(tokenHash || '').slice('sha256:'.length);
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : ZERO_HASH;
}

let lastFreshReadAt = -Infinity;

/**
 * Checks a presented host token. Returns { ok: true, host } or { ok: false, reason, hostId? }:
 *   malformed     – not a host token at all
 *   unknown-host  – no host with that id
 *   mismatch      – the id exists but the secret part is wrong
 *   revoked       – the host was revoked
 *   scope         – the host may not use `scope`
 * The hash compare runs in constant time whether or not the host exists.
 */
export function verifyMakerHostToken(token, { scope = '', dataDir, now = Date.now() } = {}) {
  const parsed = parseMakerToken(token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  let host = getMakerHost(parsed.hostId, { dataDir });
  if (!host && now - lastFreshReadAt >= FRESH_READ_MS) {
    // A host created a moment ago by another hub process: one fresh read, at most every 100 ms.
    lastFreshReadAt = now;
    host = getMakerHost(parsed.hostId, { dataDir, fresh: true });
  }
  const presented = createHash('sha256').update(String(token).trim(), 'utf8').digest();
  const matches = timingSafeEqual(presented, host ? hashBytes(host.tokenHash) : ZERO_HASH) && Boolean(host);
  if (!host) return { ok: false, reason: 'unknown-host', hostId: parsed.hostId };
  if (!matches) return { ok: false, reason: 'mismatch', hostId: host.hostId };
  if (host.revokedAt) return { ok: false, reason: 'revoked', hostId: host.hostId };
  if (scope && !host.scopes.includes(scope)) return { ok: false, reason: 'scope', hostId: host.hostId, host };
  return { ok: true, host };
}

const lastSeenWritten = new Map();

/**
 * Stamps lastSeenAt when the stored value is older than LAST_SEEN_WRITE_MS (5 min). Returns true
 * when it wrote. A failed write is retried on a later request, never thrown into the caller.
 */
export function touchMakerHostLastSeen(hostId, { dataDir, now = Date.now(), host: known = null } = {}) {
  const id = String(hostId || '');
  if (!MAKER_HOST_ID_RE.test(id)) return false;
  const memoKey = `${makerHostsPath(dataDir)}|${id}`;
  const memo = lastSeenWritten.get(memoKey) || 0;
  if (now - memo < LAST_SEEN_WRITE_MS) return false;
  const stored = Date.parse((known || getMakerHost(id, { dataDir }))?.lastSeenAt || '');
  if (Number.isFinite(stored) && now - stored < LAST_SEEN_WRITE_MS) {
    lastSeenWritten.set(memoKey, stored);
    return false;
  }
  try {
    const wrote = change(
      (current) => {
        const index = current.hosts.findIndex((host) => host.hostId === id);
        if (index < 0) return null;
        const host = current.hosts[index];
        const previous = Date.parse(host.lastSeenAt || '');
        if (Number.isFinite(previous) && now - previous < LAST_SEEN_WRITE_MS) return null;
        const hosts = [...current.hosts];
        hosts[index] = { ...host, lastSeenAt: isoAt(now) };
        return { hosts, result: true };
      },
      { dataDir }
    );
    lastSeenWritten.set(memoKey, now);
    return Boolean(wrote);
  } catch (error) {
    console.error(`[maker-hosts] could not stamp lastSeenAt for ${id}: ${error?.code || error?.message || 'error'}`);
    return false;
  }
}

/** The WS8.25 fields a heartbeat may set, cleaned. Unknown keys are dropped. */
export function normalizeHostMetaPatch(patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(source, 'runIds')) out.runIds = normalizeRunIds(source.runIds);
  if (Object.prototype.hasOwnProperty.call(source, 'capabilities')) out.capabilities = normalizeCapabilities(source.capabilities);
  if (Object.prototype.hasOwnProperty.call(source, 'version')) out.version = cleanText(source.version, 80);
  if (Object.prototype.hasOwnProperty.call(source, 'makerPort')) out.makerPort = normalizePort(source.makerPort);
  return out;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies WS8.25 fields to a host and writes only when a value changed (WS0 updateHostMeta).
 * Returns { changed, host (public) } or null for an unknown host.
 */
export function updateHostMeta(hostId, patch, { dataDir } = {}) {
  const id = String(hostId || '');
  const clean = normalizeHostMetaPatch(patch);
  const known = getMakerHost(id, { dataDir });
  if (!known) return null;
  const differs = (host) => Object.keys(clean).some((key) => !sameValue(host[key], clean[key]));
  if (!differs(known)) return { changed: false, host: publicMakerHost(known) };
  let changed = false;
  const result = change(
    (current) => {
      const index = current.hosts.findIndex((host) => host.hostId === id);
      if (index < 0) return null;
      const host = current.hosts[index];
      if (!differs(host)) return { result: host, write: false };
      changed = true;
      const hosts = [...current.hosts];
      hosts[index] = normalizeHost({ ...host, ...clean });
      return { hosts, result: hosts[index] };
    },
    { dataDir }
  );
  if (!result) return null;
  return { changed, host: publicMakerHost(result) };
}

export function resetMakerHostsMemoForTests() {
  lastSeenWritten.clear();
  lastFreshReadAt = -Infinity;
}

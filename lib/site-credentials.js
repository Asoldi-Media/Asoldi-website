/**
 * Per-site server credential for client CMS → hub calls.
 *
 * The site key is a public identifier: the Maker writes it into each site's form HTML. A client
 * CMS proves that a call comes from its own server with a second value, its site credential:
 * 32 random bytes the CMS makes once in its private data folder and sends only to its configured
 * hub, in the x-site-credential header. The hub keeps sha256 of it, per site id, in
 * <dataDir>/site-credentials/credentials.json.
 *
 * Enrollment, POST /api/hub/site-credential/enroll {siteKey, credential, nonce}:
 *  - the site needs a stored domain (409 otherwise);
 *  - the hub asks https://<stored domain>/api/cms/hub-enroll-proof?nonce=<nonce> (5 s, at most
 *    two redirects and only to the same host or its www twin, 4 KB answer cap) and expects
 *    HMAC-SHA256(credential, nonce). The CMS answers only for an enrollment it started itself in
 *    the last two minutes, so the answer shows that the credential belongs to the CMS that serves
 *    the stored domain;
 *  - a match stores the hash (locked, atomic) and is audited. A later proof replaces the credential
 *    (re-enrollment), which is audited and counted on the Security card. A nonce is accepted once.
 *  - proof calls for one site run one at a time; a caller waits its turn instead of being turned
 *    away, and only callers whose proof already failed share a per-site allowance, so callers
 *    that cannot prove anything cannot use up the site's own enrollment.
 * Enrollment is off until a superadmin turns it on (settings.json), because the proof is an
 * outgoing call. In safe mode that call goes through the egress guard like any other.
 *
 * Callers use siteCredentialState(): 'valid', 'missing' (enrolled, no header), 'invalid' (enrolled,
 * wrong or malformed value), 'revoked' (the site had a credential that an admin revoked; it stays
 * closed until the site enrolls again), 'not-enrolled' (never had one, or an admin reset it) or
 * 'unavailable' (the store could not be read: fail closed). The answer carries it in
 * x-site-credential-status, where 'revoked' reads 'not-enrolled', so a CMS knows to make a new
 * credential and enroll it.
 *
 * A site that has never enrolled may use its site key alone only on the few routes that allow it
 * (shop status and documents, the analytics dashboard), and only while its trusted CMS version is
 * 2.0.0 up to 2.2.1 (legacyKeyOnlySite). The trusted version comes only from a heartbeat with a
 * valid credential, or from before credentials existed.
 */
import { createHash, createHmac } from 'crypto';
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import { readJsonCached, readJsonFresh, updateJsonLocked, withFileLock } from '../data/atomic-json.js';
import { ensurePrivateDir } from '../data/private-dir.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { clientIpFromRequest, safeEqual } from './auth-hardening.js';
import { parseCmsVersion } from './cms-sso.js';
import { isSafeModeError } from './safe-mode.js';
import { noteSecurityEvent } from './security-counters.js';
import { addressGroup, createWindowLimiter } from './site-public-guards.js';

export const SITE_CREDENTIAL_HEADER = 'x-site-credential';
export const SITE_CREDENTIAL_STATUS_HEADER = 'x-site-credential-status';
export const ENROLL_PROOF_PATH = '/api/cms/hub-enroll-proof';
export const PROOF_TIMEOUT_MS = 5_000;
export const PROOF_MAX_BYTES = 4096;
export const MAX_PROOF_REDIRECTS = 2;
/** How long an enroll call waits for its turn while another proof for the site runs (the CMS waits 20 s). */
export const PROOF_TURN_WAIT_MS = 10_000;
/** A used nonce is remembered this long; the CMS answers for its own nonces for two minutes only. */
export const NONCE_KEEP_MS = 30 * 60_000;
/** The first client CMS version that sends a site credential. */
export const FIRST_CREDENTIAL_CMS_VERSION = '2.2.2';
const MAX_NONCE_ROWS = 5000;
const MAX_AUDIT_ROWS = 500;
const MAX_PROOF_WAITING = 16;
/** 32 random bytes as base64url: the credential and the nonce. */
export const SITE_CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
const ENROLLMENT_MODES = new Set(['off', 'on']);

function clean(value) {
  return String(value ?? '').trim();
}

export function hashSiteCredential(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** What the CMS answers for a nonce: HMAC-SHA256 keyed with the credential, hex. */
export function enrollProofFor(credential, nonce) {
  return createHmac('sha256', String(credential)).update(String(nonce)).digest('hex');
}

function bareHost(hostname) {
  const host = clean(hostname).toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Semver order of two parseCmsVersion results (a prerelease sorts before its release). */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

/** True for a CMS 2.x version older than the first one with a site credential (2.0.0 up to 2.2.1). */
export function isLegacyKeyOnlyVersion(version) {
  const parsed = parseCmsVersion(version);
  return Boolean(parsed && parsed[0] === 2 && compareVersions(parsed, parseCmsVersion(FIRST_CREDENTIAL_CMS_VERSION)) < 0);
}

/**
 * Whether a site without a credential may still use its site key alone on the routes that allow it:
 * its trusted CMS version (site.cms.packageVersion) is 2.0.0 up to 2.2.1, the versions that call
 * those routes and cannot send a credential, and for the shop routes (`shop`) its shop feature is
 * on. CMS 1.x never calls these routes, and a site without a reported version has no such CMS.
 */
export function legacyKeyOnlySite(site, { shop = false } = {}) {
  if (!isLegacyKeyOnlyVersion(site?.cms?.packageVersion)) return false;
  return !shop || site?.features?.ecommerce === true;
}

/** localhost, loopback, private, link-local and CGNAT addresses: never a client's public domain. */
export function isInternalHostname(hostname) {
  const host = clean(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0') return true;
  if (/^(127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return /\.(local|lan|internal)$/.test(host);
}

/**
 * The https origin the hub asks for a proof: the stored domain's host (and its port, if any),
 * always https. '' when the site has no usable public domain.
 */
export function enrollProofOrigin(domain) {
  const raw = clean(domain);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname) return '';
  if (isInternalHostname(url.hostname) || !url.hostname.includes('.')) return '';
  return `https://${url.hostname.replace(/\.$/, '')}${url.port ? `:${url.port}` : ''}`;
}

function liveNonces(current, t) {
  const rows = current && typeof current.used === 'object' && current.used && !Array.isArray(current.used) ? current.used : {};
  const used = {};
  for (const [hash, exp] of Object.entries(rows)) {
    if (/^[a-f0-9]{64}$/.test(hash) && Number(exp) > t) used[hash] = Number(exp);
  }
  return used;
}

/** Admin view of one stored row: never the hash. */
export function publicCredentialRow(siteId, row) {
  const r = row && typeof row === 'object' ? row : null;
  const enrolled = Boolean(r && /^[a-f0-9]{64}$/.test(clean(r.hash)));
  return {
    siteId: String(siteId),
    enrolled,
    revoked: Boolean(r) && !enrolled,
    enrolledAt: enrolled ? String(r.enrolledAt || '') : '',
    firstEnrolledAt: String(r?.firstEnrolledAt || ''),
    proofDomain: String(r?.proofDomain || ''),
    proofOrigin: String(r?.proofOrigin || ''),
    enrollCount: Number(r?.enrollCount) || 0,
    reenrollCount: Number(r?.reenrollCount) || 0,
    revokedAt: String(r?.revokedAt || ''),
    revokedBy: String(r?.revokedBy || ''),
  };
}

/** The credential file exists but cannot be read as a credential store: everything fails closed. */
export class SiteCredentialStoreUnreadable extends Error {
  constructor(path) {
    super('The site credential store could not be read.');
    this.code = 'ESITECREDUNREADABLE';
    this.path = path;
  }
}

const unreadableNoticed = new Set();

function noteUnreadable(path) {
  noteSecurityEvent('site-credential-store-unreadable');
  if (unreadableNoticed.has(path)) return;
  unreadableNoticed.add(path);
  console.error('[site-credentials] the credential store cannot be read; credential checks fail closed until an admin sets it aside in Security → Site credentials.');
}

/** { sites } of a parsed credentials file, or null when its shape is not a credential store. */
function storeRows(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const sites = parsed.sites;
  return sites && typeof sites === 'object' && !Array.isArray(sites) ? sites : null;
}

/**
 * Credential hashes, used nonces, settings and the audit, in <dataDir>/site-credentials (a folder
 * only the hub account can read). Every write holds the file lock and replaces the file atomically.
 * A credentials file that exists but cannot be read is never treated as empty: checks answer
 * 'unavailable' and writes refuse until an admin sets the file aside (setAsideUnreadable).
 */
export function createSiteCredentialStore({ dataDir, now = () => Date.now() } = {}) {
  let dir = '';
  function folder() {
    if (!dir) dir = ensurePrivateDir(join(dataDir || getPersistentDataDir(), 'site-credentials'));
    return dir;
  }
  const credentialsPath = () => join(folder(), 'credentials.json');
  const noncesPath = () => join(folder(), 'nonces.json');
  const auditPath = () => join(folder(), 'audit.json');
  const settingsPath = () => join(folder(), 'settings.json');

  /** Every site row; {} when there is no file yet. Throws SiteCredentialStoreUnreadable. */
  function readRows({ fresh = false } = {}) {
    const path = credentialsPath();
    let parsed = fresh ? readJsonFresh(path) : readJsonCached(path);
    if (parsed === null) {
      if (!existsSync(path)) return {};
      // The cache may still say "missing" for a file another process just wrote.
      parsed = readJsonFresh(path);
      if (parsed === null && !existsSync(path)) return {};
    }
    const rows = storeRows(parsed);
    if (!rows) {
      noteUnreadable(path);
      throw new SiteCredentialStoreUnreadable(path);
    }
    unreadableNoticed.delete(path);
    return rows;
  }

  /** Inside updateJsonLocked: the current rows, {} for no file, or a throw for an unreadable one. */
  function rowsForUpdate(current) {
    const path = credentialsPath();
    if (current === null && !existsSync(path)) return {};
    const rows = storeRows(current);
    if (!rows) {
      noteUnreadable(path);
      throw new SiteCredentialStoreUnreadable(path);
    }
    return { ...rows };
  }

  function row(siteId) {
    const id = clean(siteId);
    if (!id) return null;
    const rows = readRows();
    return Object.hasOwn(rows, id) && rows[id] && typeof rows[id] === 'object' ? rows[id] : null;
  }

  /**
   * 'valid' | 'missing' | 'invalid' | 'revoked' | 'not-enrolled' for a site and the presented
   * header value. A row without a usable hash (revoked) stays closed until the site enrolls again;
   * only an admin reset (forget) removes the row. Throws SiteCredentialStoreUnreadable.
   */
  function state(siteId, presented) {
    const current = row(siteId);
    if (!current) return 'not-enrolled';
    const hash = clean(current.hash);
    if (!/^[a-f0-9]{64}$/.test(hash)) return 'revoked';
    const value = clean(presented);
    if (!value) return 'missing';
    if (!SITE_CREDENTIAL_RE.test(value)) return 'invalid';
    return safeEqual(hashSiteCredential(value), hash) ? 'valid' : 'invalid';
  }

  /** { ok: true } or { ok: false, problem: 'unreadable' }. */
  function health() {
    try {
      readRows();
      return { ok: true };
    } catch (error) {
      if (error instanceof SiteCredentialStoreUnreadable) return { ok: false, problem: 'unreadable' };
      throw error;
    }
  }

  /** True the first time a nonce is seen; false for a nonce used before (kept NONCE_KEEP_MS). */
  function reserveNonce(nonce) {
    const hash = hashSiteCredential(`nonce:${nonce}`);
    let fresh = false;
    updateJsonLocked(noncesPath(), (current) => {
      const t = now();
      const used = liveNonces(current, t);
      if (Object.hasOwn(used, hash)) return undefined;
      fresh = true;
      const hashes = Object.keys(used);
      for (const old of hashes.slice(0, Math.max(0, hashes.length - MAX_NONCE_ROWS + 1))) delete used[old];
      used[hash] = t + NONCE_KEEP_MS;
      return { version: 1, used };
    });
    return fresh;
  }

  /**
   * Stores the credential hash for a site. Returns { kind: 'first' | 'replaced' | 'same', reenroll, row };
   * reenroll is true when an earlier credential is replaced or a revoked site enrolls again.
   */
  function enroll(siteId, credential, { proofDomain = '', proofOrigin = '' } = {}) {
    const id = clean(siteId);
    const hash = hashSiteCredential(credential);
    let result = { kind: 'first', reenroll: false, row: null };
    updateJsonLocked(credentialsPath(), (current) => {
      const sites = rowsForUpdate(current);
      const previous = sites[id] && typeof sites[id] === 'object' ? sites[id] : null;
      const at = new Date(now()).toISOString();
      const kind = !previous?.hash ? 'first' : previous.hash === hash ? 'same' : 'replaced';
      const reenroll = kind === 'replaced' || (kind === 'first' && Boolean(previous?.revokedAt));
      const next = {
        ...(previous || {}),
        hash,
        enrolledAt: kind === 'same' ? previous.enrolledAt || at : at,
        firstEnrolledAt: previous?.firstEnrolledAt || at,
        lastProofAt: at,
        proofDomain: clean(proofDomain).slice(0, 253),
        proofOrigin: clean(proofOrigin).slice(0, 300),
        enrollCount: (Number(previous?.enrollCount) || 0) + (kind === 'same' ? 0 : 1),
        reenrollCount: (Number(previous?.reenrollCount) || 0) + (reenroll ? 1 : 0),
        revokedAt: '',
        revokedBy: '',
      };
      sites[id] = next;
      result = { kind, reenroll, row: next };
      return { version: 1, sites };
    });
    return result;
  }

  /** Forgets the credential of a site but keeps its row, so the site stays closed until it enrolls again. */
  function revoke(siteId, { by = '' } = {}) {
    const id = clean(siteId);
    let out = { ok: false, row: null };
    updateJsonLocked(credentialsPath(), (current) => {
      const sites = rowsForUpdate(current);
      const previous = sites[id];
      if (!previous?.hash) return undefined;
      sites[id] = { ...previous, hash: '', revokedAt: new Date(now()).toISOString(), revokedBy: clean(by).slice(0, 80) };
      out = { ok: true, row: sites[id] };
      return { version: 1, sites };
    });
    return out;
  }

  /** Removes a site's row (enrolled or revoked): the site is treated as one that never enrolled. */
  function forget(siteId) {
    const id = clean(siteId);
    let out = { ok: false, previous: null };
    updateJsonLocked(credentialsPath(), (current) => {
      const sites = rowsForUpdate(current);
      if (!Object.hasOwn(sites, id)) return undefined;
      out = { ok: true, previous: sites[id] };
      delete sites[id];
      return { version: 1, sites };
    });
    return out;
  }

  /**
   * Moves an unreadable credentials file aside (credentials.json.unreadable-<time>) so the store
   * starts empty. { ok: true, file } or { ok: false } when the file is readable or missing.
   */
  function setAsideUnreadable() {
    const path = credentialsPath();
    return withFileLock(path, () => {
      if (!existsSync(path) || storeRows(readJsonFresh(path))) return { ok: false };
      const file = `credentials.json.unreadable-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      renameSync(path, join(folder(), file));
      readJsonFresh(path);
      unreadableNoticed.delete(path);
      return { ok: true, file };
    });
  }

  function list() {
    const rows = readRows({ fresh: true });
    return Object.entries(rows).map(([id, r]) => publicCredentialRow(id, r));
  }

  function settings() {
    const current = readJsonCached(settingsPath()) || {};
    return {
      enrollment: ENROLLMENT_MODES.has(current.enrollment) ? current.enrollment : 'off',
      updatedAt: String(current.updatedAt || ''),
      updatedBy: String(current.updatedBy || ''),
    };
  }

  function setSettings({ enrollment, by = '' } = {}) {
    if (!ENROLLMENT_MODES.has(enrollment)) throw new Error('enrollment must be on or off');
    updateJsonLocked(settingsPath(), () => ({ version: 1, enrollment, updatedAt: new Date(now()).toISOString(), updatedBy: clean(by).slice(0, 80) }));
    return settings();
  }

  /** Audit rows never hold a credential, a hash or a nonce. */
  function audit(entry) {
    updateJsonLocked(auditPath(), (current) => {
      const rows = Array.isArray(current?.rows) ? current.rows : [];
      rows.push({ at: new Date(now()).toISOString(), ...entry });
      return { version: 1, rows: rows.slice(-MAX_AUDIT_ROWS) };
    });
  }

  function auditLog() {
    const current = readJsonFresh(auditPath());
    return Array.isArray(current?.rows) ? current.rows : [];
  }

  return {
    state,
    row,
    health,
    reserveNonce,
    enroll,
    revoke,
    forget,
    setAsideUnreadable,
    list,
    settings,
    setSettings,
    audit,
    auditLog,
    credentialsPath,
    auditPath,
    settingsPath,
  };
}

let defaultStore = null;

/** The store every hub route shares (APP_DATA_DIR at first use). */
export function siteCredentialStore() {
  if (!defaultStore) defaultStore = createSiteCredentialStore();
  return defaultStore;
}

/** Tests only. */
export function setSiteCredentialStoreForTests(store) {
  defaultStore = store || null;
}

/** What x-site-credential-status says for a state: a revoked site reads 'not-enrolled' (enroll again). */
export function siteCredentialStatusHeader(state) {
  return state === 'revoked' ? 'not-enrolled' : state;
}

/** The credential state of `site` for this request; also sets x-site-credential-status on `res`. */
export function siteCredentialState(req, site, { store = siteCredentialStore(), res = null } = {}) {
  let state = 'not-enrolled';
  try {
    state = site?.id ? store.state(String(site.id), req.get?.(SITE_CREDENTIAL_HEADER)) : 'not-enrolled';
  } catch (error) {
    if (!(error instanceof SiteCredentialStoreUnreadable)) {
      console.warn('[site-credentials] could not read the credential store:', error?.code || error?.message || error);
    }
    state = 'unavailable';
  }
  if (res && !res.headersSent) res.set(SITE_CREDENTIAL_STATUS_HEADER, siteCredentialStatusHeader(state));
  return state;
}

const REFUSALS = {
  'not-enrolled': { code: 'site-credential-required', message: 'Asoldi has no server credential for this site yet. This needs client CMS 2.2.2 or later (1.7.2 on 1.7 sites) on an enrolled site.' },
  revoked: { code: 'site-credential-required', message: 'The server credential of this site was revoked. Client CMS 2.2.2 and 1.7.2 enroll a new one on their own.' },
  missing: { code: 'site-credential-required', message: 'This call needs the site credential.' },
  invalid: { code: 'site-credential-invalid', message: 'The site credential was not accepted.' },
  unavailable: { code: 'site-credential-unavailable', message: 'The site credential could not be checked. Try again.' },
};

/** { status, body } for a credential state that is not let through. */
export function siteCredentialRefusal(state) {
  return { status: state === 'unavailable' ? 503 : 401, body: REFUSALS[state] || REFUSALS.missing };
}

/**
 * Express middleware for hub calls a client CMS makes server to server. It finds the site by its
 * x-site-key header (401 'Unknown site.' otherwise) and then applies `policy`:
 *  - 'always': a valid credential is required (money and payee changes);
 *  - 'when-enrolled': a valid credential, or, for a site that has never enrolled and for which
 *    `legacyAllowed(site)` is true, the site key alone (older CMS versions). A revoked site stays
 *    closed. legacyAllowed defaults to never.
 * Sets req.siteAuth = { site, state } and the x-site-credential-status header.
 */
export function requireSiteCredential({ getSiteByKey, policy = 'always', legacyAllowed = () => false, store = null, siteProp = 'shopSite' } = {}) {
  return (req, res, next) => {
    const siteKey = clean(req.get('x-site-key'));
    const site = siteKey ? getSiteByKey(siteKey) : null;
    if (!site) return res.status(401).json({ message: 'Unknown site.' });
    const state = siteCredentialState(req, site, { store: store || siteCredentialStore(), res });
    const allowed = state === 'valid' || (policy === 'when-enrolled' && state === 'not-enrolled' && legacyAllowed(site) === true);
    if (!allowed) {
      noteSecurityEvent('site-credential-refused');
      const refusal = siteCredentialRefusal(state);
      return res.status(refusal.status).json(refusal.body);
    }
    req.siteAuth = { site, state };
    if (siteProp) req[siteProp] = site;
    return next();
  };
}

// ── Proof fetch ──────────────────────────────────────────────────────────────

class ProofError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readCapped(response, cap) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw new ProofError('proof-too-large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new ProofError('proof-too-large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Asks the CMS at `origin` for the proof of `nonce`. Redirects are followed by hand, at most
 * MAX_PROOF_REDIRECTS, and only to https on the same host (or its www twin), port and path.
 * `resolveUrl` maps the URL that is checked to the URL that is fetched (tests map a domain to a
 * loopback server; the hub itself never passes one). Resolves to the proof hex string.
 */
export async function fetchEnrollProof({ origin, nonce, fetchImpl, resolveUrl = (url) => url, timeoutMs = PROOF_TIMEOUT_MS, maxBytes = PROOF_MAX_BYTES }) {
  const first = new URL(`${origin}${ENROLL_PROOF_PATH}`);
  first.searchParams.set('nonce', nonce);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = first;
  for (let hop = 0; hop <= MAX_PROOF_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetchImpl(resolveUrl(current.href), {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json', 'User-Agent': 'asoldi-hub-site-credential/1' },
        signal,
      });
    } catch (error) {
      if (isSafeModeError(error)) throw new ProofError('proof-blocked', 423);
      throw new ProofError('proof-unreachable', 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_PROOF_REDIRECTS) throw new ProofError('proof-redirect');
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new ProofError('proof-redirect');
      }
      if (
        next.protocol !== 'https:' ||
        next.username || next.password ||
        bareHost(next.hostname) !== bareHost(first.hostname) ||
        next.port !== first.port ||
        next.pathname !== ENROLL_PROOF_PATH ||
        next.searchParams.get('nonce') !== nonce
      ) {
        throw new ProofError('proof-redirect');
      }
      current = next;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new ProofError('proof-refused');
    }
    let body;
    try {
      body = JSON.parse(await readCapped(response, maxBytes));
    } catch (error) {
      if (error instanceof ProofError) throw error;
      if (signal.aborted) throw new ProofError('proof-unreachable', 502);
      throw new ProofError('proof-unreadable');
    }
    const proof = clean(body?.proof).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(proof)) throw new ProofError('proof-unreadable');
    return proof;
  }
  throw new ProofError('proof-redirect');
}

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Enroll attempts (an IPv6 address counts by its /64):
 *  - a caller with an unknown site key: 30 per address in 15 minutes;
 *  - per (site, address): 6 in 15 minutes;
 *  - an address whose proof for the site failed in the last hour also needs the site's shared
 *    allowance for such addresses (20 an hour). An address without a failed proof never waits for
 *    that allowance, so callers that cannot prove anything cannot keep the site's own CMS from
 *    enrolling. proofFailed() records a failed proof.
 */
export function createEnrollLimiter({ now } = {}) {
  const clock = now ? { now } : {};
  const short = createWindowLimiter({ windowMs: 15 * 60_000, max: 6, ...clock });
  const failures = createWindowLimiter({ windowMs: 60 * 60_000, max: 1_000, ...clock });
  const retries = createWindowLimiter({ windowMs: 60 * 60_000, max: 20, ...clock });
  const pairOf = (siteId, address) => `${clean(siteId).slice(0, 80)}\n${addressGroup(address)}`;
  return {
    unknownSite(address) {
      return short.hit(`a:${addressGroup(address)}`, 30);
    },
    site(siteId, address) {
      const pair = `p:${pairOf(siteId, address)}`;
      const own = short.peek(pair, 6);
      if (!own.ok) return own;
      if (!failures.peek(`f:${pairOf(siteId, address)}`, 1).ok) {
        const shared = retries.peek(`s:${clean(siteId)}`, 20);
        if (!shared.ok) return shared;
        retries.hit(`s:${clean(siteId)}`, 20);
      }
      short.hit(pair, 6);
      return { ok: true, retryAfterSec: 0 };
    },
    proofFailed(siteId, address) {
      failures.hit(`f:${pairOf(siteId, address)}`, 1_000);
    },
  };
}

/**
 * Proof calls for one site run one at a time. A caller waits its turn (up to waitMs, at most
 * maxWaiting callers per site) instead of being turned away while another proof runs.
 * run() resolves { busy: true } when the turn did not come, else { busy: false, value }.
 */
export function createProofLane({ waitMs = PROOF_TURN_WAIT_MS, maxWaiting = MAX_PROOF_WAITING } = {}) {
  const lanes = new Map();
  return {
    async run(siteId, fn) {
      let lane = lanes.get(siteId);
      if (!lane) {
        lane = { tail: Promise.resolve(), size: 0 };
        lanes.set(siteId, lane);
      }
      if (lane.size >= maxWaiting) return { busy: true };
      lane.size += 1;
      const previous = lane.tail;
      let release;
      lane.tail = new Promise((resolve) => {
        release = resolve;
      });
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve('late'), waitMs);
        timer.unref?.();
      });
      let passOn = true;
      try {
        const turn = await Promise.race([previous.then(() => 'turn'), late]);
        if (turn === 'late') {
          // Whoever comes next still waits for the proof that is running now.
          passOn = false;
          previous.then(release);
          return { busy: true };
        }
        return { busy: false, value: await fn() };
      } finally {
        clearTimeout(timer);
        lane.size -= 1;
        if (passOn) release();
        if (lane.size === 0 && lanes.get(siteId) === lane) lanes.delete(siteId);
      }
    },
    size() {
      return lanes.size;
    },
  };
}

/**
 * Heartbeats without a valid credential: 30 a minute per (site, address group). A CMS sends one
 * with each config read, so a busy site may see a few refused; it ignores the answer.
 */
export function createHeartbeatLimits({ perSiteAddress = 30, windowMs = 60_000, now } = {}) {
  const limiter = createWindowLimiter({ windowMs, max: perSiteAddress, ...(now ? { now } : {}) });
  return {
    take({ siteId, address, credentialValid = false }) {
      if (credentialValid) return { ok: true, retryAfterSec: 0 };
      return limiter.hit(`${clean(siteId).slice(0, 80)}\n${addressGroup(address)}`, perSiteAddress);
    },
    reset() {
      limiter.reset();
    },
  };
}

/**
 * Whether a heartbeat in this credential state marks the site as seen. A site that has a credential
 * row (enrolled or revoked) is seen only through heartbeats with its valid credential, so a caller
 * with the site key alone cannot hide an outage of an enrolled site.
 */
export function heartbeatMarksSeen(state) {
  return state === 'valid' || state === 'not-enrolled' || state === 'unavailable';
}

// ── Routes ───────────────────────────────────────────────────────────────────

function adminName(req) {
  return clean(req.admin?.username || req.admin?.email || req.user?.username) || 'admin';
}

/**
 * POST /api/hub/site-credential/enroll (a client CMS, server to server) and the superadmin routes:
 * GET /api/hub/site-credentials, PUT /api/hub/site-credentials/settings,
 * POST /api/hub/site-credentials/set-aside-unreadable, POST /api/hub/sites/:id/site-credential/revoke
 * and POST /api/hub/sites/:id/site-credential/reset.
 *
 * setTrustedCmsVersion(siteId, version) is used by reset: when the site's last unverified heartbeat
 * reports a 2.0.0–2.2.1 version (a CMS rolled back), the admin's reset takes that version as the
 * trusted one, so the older CMS keeps its shop status, documents and dashboard.
 */
export function registerSiteCredentialRoutes(app, {
  adminAuth,
  getSiteByKey,
  getSiteById = () => null,
  getAllSites = () => [],
  setTrustedCmsVersion = null,
  store: storeOption = null,
  limiter: limiterOption = null,
  proofFetch = (...args) => globalThis.fetch(...args),
  resolveProofUrl = undefined,
  proofTurnWaitMs = PROOF_TURN_WAIT_MS,
  now,
} = {}) {
  if (!adminAuth || !getSiteByKey) throw new Error('registerSiteCredentialRoutes: missing deps');
  const store = () => storeOption || siteCredentialStore();
  const limiter = limiterOption || createEnrollLimiter(now ? { now } : {});
  const lane = createProofLane({ waitMs: proofTurnWaitMs });

  function auditQuietly(entry) {
    try {
      store().audit(entry);
    } catch (error) {
      console.warn('[site-credentials] audit write failed:', error?.code || error?.message || error);
    }
  }

  app.post('/api/hub/site-credential/enroll', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const refuse = (status, code, message, extra = {}) => res.status(status).json({ ok: false, code, message, ...extra });
    let settings;
    try {
      settings = store().settings();
    } catch {
      return refuse(503, 'enrollment-unavailable', 'Enrollment is not available right now.');
    }
    if (settings.enrollment !== 'on') return refuse(503, 'enrollment-off', 'Site credential enrollment is switched off on this hub.');
    const siteKey = clean(req.get('x-site-key') || req.body?.siteKey || req.body?.site_key);
    const credential = clean(req.body?.credential);
    const nonce = clean(req.body?.nonce);
    const address = clientIpFromRequest(req);
    const site = siteKey ? getSiteByKey(siteKey) : null;
    if (!site?.id) {
      const gate = limiter.unknownSite(address);
      if (!gate.ok) {
        res.set('Retry-After', String(gate.retryAfterSec));
        return refuse(429, 'too-many', 'Too many requests.');
      }
      return refuse(401, 'unknown-site', 'Unknown site.');
    }
    const siteId = String(site.id);
    if (!SITE_CREDENTIAL_RE.test(credential) || !SITE_CREDENTIAL_RE.test(nonce)) return refuse(400, 'malformed', 'credential and nonce must be 32 random bytes in base64url.');
    const gate = limiter.site(siteId, address);
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      noteSecurityEvent('site-credential-enroll-limited');
      return refuse(429, 'too-many', 'Too many enrollment attempts for this site. Try again later.');
    }
    const origin = enrollProofOrigin(site.domain);
    if (!origin) return refuse(409, 'no-domain', 'This site has no public https domain in the hub yet, so it cannot be enrolled.');
    if (!store().health().ok) return refuse(503, 'enrollment-unavailable', 'Enrollment is not available right now.');
    const failed = (status, code, extra = {}) => {
      limiter.proofFailed?.(siteId, address);
      noteSecurityEvent('site-credential-enroll-refused');
      auditQuietly({ action: 'enroll', ok: false, reason: code, siteId, ...extra, from: address.slice(0, 64) });
      return refuse(status, code, code === 'nonce-used' ? 'This nonce was used before. Start a new enrollment.' : 'The site did not confirm this enrollment.');
    };
    let fresh;
    try {
      fresh = store().reserveNonce(nonce);
    } catch (error) {
      console.error('[site-credentials] could not store the nonce:', error?.code || error?.message || error);
      return refuse(503, 'enrollment-unavailable', 'Enrollment is not available right now.');
    }
    if (!fresh) return failed(409, 'nonce-used');
    const turn = await lane.run(siteId, async () => {
      try {
        return { proof: await fetchEnrollProof({ origin, nonce, fetchImpl: proofFetch, ...(resolveProofUrl ? { resolveUrl: resolveProofUrl } : {}) }) };
      } catch (error) {
        return { error };
      }
    });
    if (turn.busy) {
      res.set('Retry-After', String(Math.ceil(proofTurnWaitMs / 1000)));
      return refuse(429, 'enroll-busy', 'Other enrollments for this site are being checked. Try again shortly.');
    }
    if (turn.value.error) {
      const error = turn.value.error;
      const code = error instanceof ProofError ? error.code : 'proof-unreachable';
      const status = error instanceof ProofError ? error.status : 502;
      return failed(status, code, { origin });
    }
    if (!safeEqual(turn.value.proof, enrollProofFor(credential, nonce))) return failed(403, 'proof-mismatch', { origin });
    let stored;
    try {
      stored = store().enroll(siteId, credential, { proofDomain: new URL(origin).hostname, proofOrigin: origin });
    } catch (error) {
      console.error('[site-credentials] could not store the credential:', error?.code || error?.message || error);
      return refuse(503, 'enrollment-unavailable', 'Enrollment is not available right now.');
    }
    if (stored.reenroll) noteSecurityEvent('site-credential-reenrolled');
    else if (stored.kind === 'first') noteSecurityEvent('site-credential-enrolled');
    auditQuietly({ action: stored.reenroll ? 'reenroll' : 'enroll', ok: true, kind: stored.kind, siteId, origin, from: address.slice(0, 64) });
    return res.json({ ok: true, kind: stored.kind, reenrolled: stored.reenroll, enrolledAt: stored.row.enrolledAt });
  });

  app.get('/api/hub/site-credentials', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let rows = new Map();
    const health = store().health();
    if (health.ok) rows = new Map(store().list().map((row) => [row.siteId, row]));
    const sites = getAllSites().map((site) => {
      const row = rows.get(String(site.id)) || publicCredentialRow(site.id, null);
      const domainOrigin = enrollProofOrigin(site.domain);
      return {
        ...row,
        domain: String(site.domain || ''),
        proofDomainMatches: !row.proofOrigin || row.proofOrigin === domainOrigin,
        // The site key alone still opens shop status and documents (shop) and the dashboard (analytics).
        legacyKeyOnly: health.ok && !row.enrolled && !row.revoked ? { analytics: legacyKeyOnlySite(site), shop: legacyKeyOnlySite(site, { shop: true }) } : { analytics: false, shop: false },
        reportedLegacyVersion: isLegacyKeyOnlyVersion(site.cms?.unverified?.packageVersion) ? String(site.cms.unverified.packageVersion) : '',
      };
    });
    const audit = store().auditLog();
    res.json({
      settings: store().settings(),
      store: health,
      sites,
      totals: {
        sites: sites.length,
        enrolled: sites.filter((row) => row.enrolled).length,
        reenrollments: sites.reduce((sum, row) => sum + row.reenrollCount, 0),
        revoked: sites.filter((row) => row.revoked).length,
      },
      recent: audit.slice(-20).reverse(),
    });
  });

  app.put('/api/hub/site-credentials/settings', adminAuth, (req, res) => {
    const enrollment = clean(req.body?.enrollment);
    if (!ENROLLMENT_MODES.has(enrollment)) return res.status(400).json({ message: 'enrollment must be "on" or "off".' });
    const by = adminName(req);
    const settings = store().setSettings({ enrollment, by });
    auditQuietly({ action: 'settings', enrollment, by });
    return res.json({ settings });
  });

  app.post('/api/hub/site-credentials/set-aside-unreadable', adminAuth, (req, res) => {
    const by = adminName(req);
    const result = store().setAsideUnreadable();
    if (!result.ok) return res.status(409).json({ message: 'The credential store is readable; nothing was changed.' });
    noteSecurityEvent('site-credential-store-set-aside');
    auditQuietly({ action: 'set-aside-store', ok: true, file: result.file, by });
    return res.json({ ok: true, file: result.file });
  });

  app.post('/api/hub/sites/:id/site-credential/revoke', adminAuth, (req, res) => {
    const site = getSiteById(clean(req.params.id));
    if (!site?.id) return res.status(404).json({ message: 'Site not found.' });
    const by = adminName(req);
    let result;
    try {
      result = store().revoke(String(site.id), { by });
    } catch (error) {
      if (error instanceof SiteCredentialStoreUnreadable) return res.status(503).json({ message: 'The credential store cannot be read. Set it aside on the Security card first.' });
      throw error;
    }
    if (!result.ok) return res.status(409).json({ message: 'This site has no enrolled credential.' });
    noteSecurityEvent('site-credential-revoked');
    auditQuietly({ action: 'revoke', ok: true, siteId: String(site.id), by });
    return res.json({ ok: true, credential: publicCredentialRow(site.id, result.row) });
  });

  // For a site that went back to a CMS without a credential: forget its row, so it is treated as a
  // site that never enrolled. Money routes still need a credential.
  app.post('/api/hub/sites/:id/site-credential/reset', adminAuth, (req, res) => {
    const site = getSiteById(clean(req.params.id));
    if (!site?.id) return res.status(404).json({ message: 'Site not found.' });
    const by = adminName(req);
    let result;
    try {
      result = store().forget(String(site.id));
    } catch (error) {
      if (error instanceof SiteCredentialStoreUnreadable) return res.status(503).json({ message: 'The credential store cannot be read. Set it aside on the Security card first.' });
      throw error;
    }
    if (!result.ok) return res.status(409).json({ message: 'This site has no credential to reset.' });
    let trustedVersion = '';
    const reported = clean(site.cms?.unverified?.packageVersion);
    if (setTrustedCmsVersion && isLegacyKeyOnlyVersion(reported)) {
      try {
        if (setTrustedCmsVersion(String(site.id), reported) !== false) trustedVersion = reported;
      } catch (error) {
        console.warn('[site-credentials] could not store the reported CMS version:', error?.message || error);
      }
    }
    noteSecurityEvent('site-credential-reset');
    auditQuietly({ action: 'reset', ok: true, siteId: String(site.id), by, ...(trustedVersion ? { trustedVersion } : {}) });
    return res.json({ ok: true, trustedVersion, credential: publicCredentialRow(site.id, null) });
  });

  return { store, limiter, lane };
}

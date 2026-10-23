/**
 * "Open CMS as Asoldi": a one-time admin login link into a client CMS.
 *
 * CMS 2.2.1 and later get a random one-time token (32 bytes). The hub keeps only
 * its sha256, with the site id, who asked and the expiry (60 s), in
 * <dataDir>/cms-sso/tokens.json. The client CMS checks the token server to server
 * with POST /api/cms/sso/redeem (its site key in the x-site-key header) before it
 * opens a session, and the hub burns the token on that first use.
 *
 * CMS 2.0.0 up to 2.2.0 check a token signed with the site key themselves; the hub
 * sends that format only to a site whose last heartbeat reports such a version.
 * CMS 1.x has no Asoldi sign-in. Every link records which format it used.
 *
 * The link always points at the site's stored domain over https (cmsSsoOrigin). The
 * address a CMS reports in its heartbeat only picks between the www and bare host of
 * that domain; a report for any other host is ignored and noted in the audit.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { readJsonFresh, updateJsonLocked } from '../data/atomic-json.js';
import { ensurePrivateDir } from '../data/private-dir.js';
import { getPersistentDataDir } from '../data/storage-path.js';
import { clientIpFromRequest, safeEqual } from './auth-hardening.js';

export const CMS_SSO_TTL_MS = 60_000;
/** First CMS version that checks one-time tokens with the hub. */
export const CMS_SSO_REDEEM_MIN_VERSION = '2.2.1';
/** Used and expired rows stay this long, so a late second use is still recognised as a reuse. */
const KEEP_SETTLED_MS = 10 * 60_000;
/** Links are minted by staff only; this caps the file if something loops. */
const MAX_TOKEN_ROWS = 2000;
const MAX_AUDIT_ROWS = 500;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Origin of the client CMS for server-to-server notices: the heartbeat admin URL wins over the
 * stored domain. Sign-in links use cmsSsoOrigin instead.
 */
export function cmsOrigin(site) {
  for (const raw of [site?.cms?.adminUrl, site?.domain]) {
    const value = clean(raw);
    if (!value) continue;
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

function parseSiteUrl(raw) {
  const value = clean(raw);
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || !url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** localhost, *.localhost, 127.0.0.0/8 or ::1: a CMS on this machine (local runs and probes). */
export function isLoopbackHost(hostname) {
  const host = clean(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '::1';
}

function bareHost(hostname) {
  const host = clean(hostname).toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Where a sign-in link goes: { origin, source, ignoredHost }.
 * - The stored domain decides the host (normalised by URL, so a Unicode domain and its
 *   punycode form match). The link is always https, on the domain's own port if it has one.
 * - The heartbeat admin URL is used only when its host is the domain's host with or without
 *   www.; then it picks that spelling (source 'heartbeat'). A report for any other host is
 *   ignored (ignoredHost says which): the stored domain alone decides where a link goes.
 * - A loopback domain keeps http and its port, and a loopback report on the same host keeps its
 *   own port (local runs and probes).
 * - No usable domain gives origin '' (the caller answers 409).
 */
export function cmsSsoOrigin(site) {
  const domain = parseSiteUrl(site?.domain);
  const reported = parseSiteUrl(site?.cms?.adminUrl);
  if (!domain) return { origin: '', source: '', ignoredHost: reported ? reported.hostname : '' };
  if (isLoopbackHost(domain.hostname)) {
    if (reported && reported.hostname === domain.hostname) return { origin: reported.origin, source: 'heartbeat', ignoredHost: '' };
    const origin = clean(site.domain).includes('://') ? domain.origin : `http://${domain.host}`;
    return { origin, source: 'domain', ignoredHost: reported ? reported.hostname : '' };
  }
  const port = domain.port ? `:${domain.port}` : '';
  if (reported && bareHost(reported.hostname) === bareHost(domain.hostname)) {
    return { origin: `https://${reported.hostname.replace(/\.$/, '')}${port}`, source: 'heartbeat', ignoredHost: '' };
  }
  return { origin: `https://${domain.hostname.replace(/\.$/, '')}${port}`, source: 'domain', ignoredHost: reported ? reported.hostname : '' };
}

/** [major, minor, patch, prerelease] or null. */
export function parseCmsVersion(value) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(clean(value));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''];
}

/** Semver order of two parsed versions (a prerelease sorts before its release). */
function compareParsed(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

/**
 * Which sign-in link a CMS version takes: 'redeem' (one-time token checked with the hub),
 * 'site-key' (signed token, CMS 2.0.0 up to 2.2.0) or 'none' (CMS 1.x). A site with no
 * readable version (no heartbeat yet) gets 'redeem', the current format.
 */
export function cmsSsoFormatForVersion(packageVersion) {
  const parsed = parseCmsVersion(packageVersion);
  if (!parsed) return 'redeem';
  if (parsed[0] < 2) return 'none';
  return compareParsed(parsed, parseCmsVersion(CMS_SSO_REDEEM_MIN_VERSION)) < 0 ? 'site-key' : 'redeem';
}

/** Token for CMS 2.0.0 up to 2.2.0 only (signed with the site key; the CMS burns its nonce). */
export function mintSiteKeyCmsSsoToken(site, { by = 'asoldi', now = Date.now() } = {}) {
  const data = JSON.stringify({ sid: String(site.id), n: randomBytes(16).toString('hex'), exp: now + CMS_SSO_TTL_MS, by: clean(by).slice(0, 80) || 'asoldi' });
  const sig = createHmac('sha256', String(site.site_key)).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

export function hashCmsSsoToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function liveRows(current, t) {
  const rows = current && typeof current.tokens === 'object' && current.tokens && !Array.isArray(current.tokens) ? current.tokens : {};
  const tokens = {};
  let dropped = 0;
  for (const [hash, row] of Object.entries(rows)) {
    if (/^[a-f0-9]{64}$/.test(hash) && Number(row?.exp) + KEEP_SETTLED_MS > t) tokens[hash] = row;
    else dropped += 1;
  }
  return { tokens, dropped };
}

/**
 * One-time tokens on the data disk. Every read-modify-write holds the file lock, so two
 * hub processes can never both accept the same token. Only token hashes are stored.
 */
export function createCmsSsoStore({ dataDir, now = () => Date.now(), ttlMs = CMS_SSO_TTL_MS } = {}) {
  let dir = '';
  function folder() {
    if (!dir) dir = ensurePrivateDir(join(dataDir || getPersistentDataDir(), 'cms-sso'));
    return dir;
  }
  const tokensPath = () => join(folder(), 'tokens.json');
  const auditPath = () => join(folder(), 'audit.json');

  /** Returns { token, exp }. The token itself is never stored. */
  function mint(site, { by = 'asoldi' } = {}) {
    const token = randomBytes(32).toString('base64url');
    const t = now();
    const row = { siteId: String(site.id), by: clean(by).slice(0, 80) || 'asoldi', exp: t + ttlMs, createdAt: t };
    updateJsonLocked(tokensPath(), (current) => {
      const { tokens } = liveRows(current, t);
      const hashes = Object.keys(tokens);
      for (const hash of hashes.slice(0, Math.max(0, hashes.length - MAX_TOKEN_ROWS + 1))) delete tokens[hash];
      tokens[hashCmsSsoToken(token)] = row;
      return { version: 1, tokens };
    });
    return { token, exp: row.exp };
  }

  /**
   * Accepts a token once, for the site whose key is given, before it expires.
   * Returns { ok: true, by, siteId } or { ok: false, reason, siteId? }; reasons are for the audit only.
   */
  function redeem({ token, siteKey, getSiteById }) {
    const value = clean(token);
    const key = clean(siteKey);
    if (!key || !TOKEN_RE.test(value)) return { ok: false, reason: 'malformed' };
    const hash = hashCmsSsoToken(value);
    // A token that was never issued is refused without taking the lock (tokens are written before
    // the link is handed out, and the file is replaced atomically), so junk costs one read.
    const peek = readJsonFresh(tokensPath());
    if (!peek?.tokens || typeof peek.tokens !== 'object' || !Object.hasOwn(peek.tokens, hash)) return { ok: false, reason: 'unknown' };
    let verdict = { ok: false, reason: 'unknown' };
    updateJsonLocked(tokensPath(), (current) => {
      const t = now();
      const { tokens, dropped } = liveRows(current, t);
      const unchanged = dropped ? { version: 1, tokens } : undefined;
      const row = tokens[hash];
      if (!row) {
        verdict = { ok: false, reason: 'unknown' };
        return unchanged;
      }
      const site = getSiteById(row.siteId);
      if (!site?.site_key || !safeEqual(site.site_key, key)) {
        verdict = { ok: false, reason: 'other-site', siteId: row.siteId };
        return unchanged;
      }
      if (row.usedAt) {
        verdict = { ok: false, reason: 'used', siteId: row.siteId };
        return unchanged;
      }
      if (!(Number(row.exp) > t)) {
        verdict = { ok: false, reason: 'expired', siteId: row.siteId };
        return unchanged;
      }
      tokens[hash] = { ...row, usedAt: t };
      verdict = { ok: true, by: String(row.by || 'asoldi'), siteId: row.siteId };
      return { version: 1, tokens };
    });
    return verdict;
  }

  /** Audit rows never hold a token or its hash. */
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

  return { mint, redeem, audit, auditLog, tokensPath, auditPath };
}

/**
 * Failed redeems in a sliding window, for two cases only:
 * - a call without a known site key counts against its address ('i:'), so keys cannot be guessed;
 * - a known site key with a live token of another site counts against that (site, address) pair ('p:').
 * A known site key with an unknown, malformed, used or expired token is not counted: tokens are
 * 32 random bytes, the client CMS limits its own visitors, and a CMS passes every visitor's link
 * on from its one server address, so counting those would let unrelated failed links hold up the next real one.
 * Memory is bounded: at capacity address keys go first, then pair keys, oldest first.
 */
export function createRedeemLimiter({
  windowMs = 15 * 60_000,
  maxPerPair = 10,
  maxPerIp = 30,
  maxKeys = 5000,
  now = () => Date.now(),
} = {}) {
  const failures = new Map();
  const limitOf = (key) => (key[0] === 'p' ? maxPerPair : maxPerIp);

  function recent(key) {
    const list = failures.get(key);
    if (!list) return [];
    const t = now();
    while (list.length && t - list[0] >= windowMs) list.shift();
    if (!list.length) failures.delete(key);
    return list;
  }

  function keyFor({ ip, siteId }) {
    const address = clean(ip).slice(0, 64);
    const site = clean(siteId).slice(0, 80);
    return site ? `p:${site}\n${address}` : `i:${address}`;
  }

  function capKeys() {
    if (failures.size <= maxKeys) return;
    for (const key of [...failures.keys()]) recent(key);
    for (const kind of ['i', 'p']) {
      for (const key of [...failures.keys()]) {
        if (failures.size <= maxKeys) return;
        if (key[0] === kind) failures.delete(key);
      }
    }
  }

  return {
    check(who) {
      const list = recent(keyFor(who));
      if (list.length >= limitOf(keyFor(who))) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
      }
      return { ok: true };
    },
    fail(who) {
      const key = keyFor(who);
      const list = recent(key);
      list.push(now());
      if (list.length > limitOf(key)) list.splice(0, list.length - limitOf(key));
      failures.delete(key);
      failures.set(key, list);
      capKeys();
    },
    size() {
      return failures.size;
    },
  };
}

/**
 * Refusals that are not written to the audit (no or unknown site key, malformed or never-issued
 * tokens): counted in memory, with at most one log line per interval.
 */
export function createQuietCounter({ now = () => Date.now(), intervalMs = 60_000, log = (...args) => console.warn(...args) } = {}) {
  const totals = {};
  let pending = {};
  let lastLog = -Infinity;
  return {
    note(reason) {
      const name = clean(reason) || 'other';
      totals[name] = (totals[name] || 0) + 1;
      pending[name] = (pending[name] || 0) + 1;
      const t = now();
      if (t - lastLog >= intervalMs) {
        lastLog = t;
        log('[cms-sso] refused sign-in checks (not audited):', JSON.stringify(pending));
        pending = {};
      }
    },
    totals() {
      return { ...totals };
    },
  };
}

/** Refusals that involve a real token of this hub; these are audited. Others are only counted. */
const AUDITED_REFUSALS = new Set(['other-site', 'used', 'expired']);

function siteKeyFrom(req) {
  return clean(req.get('x-site-key') || req.body?.site_key || req.body?.siteKey);
}

const keyDigest = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest();

/**
 * The site whose key equals `siteKey` (trimmed), or null. Every site's key is compared, as
 * fixed-length sha256 digests with timingSafeEqual, and the loop never stops early, so the time
 * taken does not depend on which site matches, where it is in the list, or how much of a key a
 * caller got right.
 */
export function findSiteByKeyConstantTime(sites, siteKey) {
  const given = clean(siteKey);
  const wanted = keyDigest(given);
  let found = null;
  for (const site of Array.isArray(sites) ? sites : []) {
    const key = String(site?.site_key ?? '');
    const same = timingSafeEqual(keyDigest(key), wanted);
    if (same && given && !found) found = site;
  }
  return found;
}

/**
 * deps: adminAuth; getSiteById(id); getAllSites() → every hub site (the redeem route looks the
 * caller's site key up across all of them with findSiteByKeyConstantTime).
 */
export function registerCmsSsoRoutes(app, { adminAuth, getSiteById, getAllSites = () => [], dataDir, now, limiter: limiterOption, store: storeOption, quiet: quietOption } = {}) {
  let store = storeOption || null;
  const sso = () => {
    if (!store) store = createCmsSsoStore({ dataDir, ...(now ? { now } : {}) });
    return store;
  };
  const limiter = limiterOption || createRedeemLimiter(now ? { now } : {});
  const quiet = quietOption || createQuietCounter(now ? { now } : {});

  function auditQuietly(entry) {
    try {
      sso().audit(entry);
    } catch (error) {
      console.warn('[cms-sso] audit write failed:', error?.code || error?.message || error);
    }
  }

  app.post('/api/hub/sites/:id/cms-sso', adminAuth, (req, res) => {
    const site = getSiteById(clean(req.params.id));
    if (!site?.site_key) return res.status(404).json({ message: 'Site not found.' });
    const target = cmsSsoOrigin(site);
    if (!target.origin) return res.status(409).json({ message: 'This site has no domain yet. Add its domain under Manage clients first.' });
    const packageVersion = clean(site.cms?.packageVersion);
    const format = cmsSsoFormatForVersion(packageVersion);
    if (format === 'none') {
      return res.status(409).json({ message: `This site runs CMS ${packageVersion}, which has no Asoldi sign-in. Update its CMS first.` });
    }
    const by = clean(req.admin?.username || req.admin?.email) || 'asoldi';
    let token;
    try {
      token = format === 'redeem' ? sso().mint(site, { by }).token : mintSiteKeyCmsSsoToken(site, { by });
    } catch (error) {
      console.error('[cms-sso] could not store a sign-in link:', error?.code || error?.message || error);
      return res.status(503).json({ message: 'Could not create the sign-in link. Try again.' });
    }
    auditQuietly({
      action: 'link',
      siteId: String(site.id),
      by,
      format,
      packageVersion,
      origin: target.origin,
      originFrom: target.source,
      ...(target.ignoredHost ? { ignoredAdminHost: target.ignoredHost.slice(0, 253) } : {}),
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ url: `${target.origin}/api/cms/admin/sso?token=${token}`, expiresInSeconds: CMS_SSO_TTL_MS / 1000, format });
  });

  // Server to server: a client CMS checks a one-time token before it opens a session.
  app.post('/api/cms/sso/redeem', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const refuse = () => res.status(401).json({ ok: false, message: 'Unauthorized.' });
    const siteKey = siteKeyFrom(req);
    const known = findSiteByKeyConstantTime(getAllSites(), siteKey);
    const ip = clientIpFromRequest(req);
    const who = { ip, siteId: known?.id ? String(known.id) : '' };
    const gate = limiter.check(who);
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ ok: false, message: 'Too many requests.' });
    }
    if (!known?.site_key) {
      // No or unknown site key: counted per address, never audited, the token store is not read.
      limiter.fail(who);
      quiet.note('no-site');
      return refuse();
    }
    let result;
    try {
      result = sso().redeem({ token: req.body?.token, siteKey, getSiteById });
    } catch (error) {
      console.error('[cms-sso] redeem failed:', error?.code || error?.message || error);
      return res.status(503).json({ ok: false, message: 'Unavailable.' });
    }
    if (!result.ok) {
      if (result.reason === 'other-site') limiter.fail(who);
      if (AUDITED_REFUSALS.has(result.reason)) auditQuietly({ action: 'redeem', ok: false, reason: result.reason, siteId: result.siteId || who.siteId, via: who.siteId });
      else quiet.note(result.reason);
      return refuse();
    }
    auditQuietly({ action: 'redeem', ok: true, siteId: result.siteId, by: result.by });
    return res.json({ ok: true, by: result.by });
  });

  return { store: sso, limiter, quiet };
}

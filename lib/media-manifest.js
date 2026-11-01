// Media manifest: the client's files the website build may use, each with an id, a sha256 and a
// signed download URL that lasts 24 hours.
//
// Sources: the Kundedata media buckets (MEDIA_BUCKET_KEYS), the brand logos, product images,
// attachments the inbox filed for the client, and hub library items tagged client:<clientId>.
// Only files on the data disk get an id; links to other hosts are listed under `external`.
//
// Signed URLs: /api/maker/media/<assetId>?c=<clientId>&exp=<ms>&sig=<hmac>, HMAC-SHA256 with the disk
// secret 'media-signing' (readOrCreateDiskSecret, created on first use). The route answers 404
// {code:'disabled'} while media.signedUrls is off, 403 for a signature that does not match and 410
// once the link has expired.
//
// The per-client index <dataDir>/media-manifest/<clientId>.json maps ids to files. It is written
// only when a manifest is built, which only happens with media.signedUrls on.
//
// Rights: the portal's per-upload checkbox stores { confirmed, at } under the sales client's
// ext.mediaRights['<portalUserId>/<fileName>'], or, for a portal business with no sales client yet,
// under <dataDir>/media-rights.json businesses.<businessId>.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { getPersistentDataDir, writeDataJson } from '../data/storage-path.js';
import * as sales from '../data/sales.js';
import * as clientPortal from '../data/client-portal.js';
import { readOrCreateDiskSecret } from './auth-hardening.js';
import { MEDIA_BUCKET_KEYS, clientMediaMime } from './client-media-store.js';
import { mediaMimeForName } from './hub-media-library.js';
import { profileForClient } from './delivery-backfill.js';
import { isValidClientId, listFilesUnder, perClientPath, registerStore } from './personal-data.js';

export const MEDIA_MANIFEST_DIR = 'media-manifest';
export const MEDIA_MANIFEST_KIND = 'asoldi.media-manifest/1';
export const MEDIA_SIGNING_SECRET = 'media-signing';
export const MEDIA_URL_TTL_MS = 24 * 60 * 60 * 1000;
export const MEDIA_ROUTE_PREFIX = '/api/maker/media/';
export const MEDIA_RIGHTS_FILE = 'media-rights.json';
const ASSET_ID_RE = /^ma_[a-f0-9]{32}$/;
const SIG_RE = /^[a-f0-9]{64}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CLIENT_MEDIA_RE = /\/client-media\/([A-Za-z0-9_-]{1,80})\/([^/?#]+)/;

function text(value) {
  return String(value ?? '').trim();
}

function dataDirOf(dataDir) {
  return dataDir || getPersistentDataDir();
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const value = Number(now ?? Date.now());
  return Number.isFinite(value) ? value : Date.now();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function inside(root, path) {
  const rootAbs = resolve(root);
  const abs = resolve(path);
  return abs === rootAbs || abs.startsWith(rootAbs + sep);
}

/** sha256 of a file, read in chunks so large videos never sit in memory. */
export function sha256OfFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    do {
      read = readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------- signing

export function mediaSigningKey(dataDir) {
  return readOrCreateDiskSecret(dataDirOf(dataDir), MEDIA_SIGNING_SECRET, 32);
}

export function mediaSignature(key, assetId, clientId, exp) {
  return createHmac('sha256', String(key)).update(`${assetId}\n${clientId}\n${exp}`).digest('hex');
}

/** The signed path for one asset (relative to the hub origin). */
export function signMediaUrl({ assetId, clientId, expiresAt, key, dataDir } = {}) {
  const exp = Math.floor(Number(expiresAt));
  const sig = mediaSignature(key || mediaSigningKey(dataDir), assetId, clientId, exp);
  return `${MEDIA_ROUTE_PREFIX}${encodeURIComponent(assetId)}?c=${encodeURIComponent(clientId)}&exp=${exp}&sig=${sig}`;
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a download request: { ok: true, clientId } or { ok: false, status: 403 | 410, code }.
 * The signature is checked first, so a changed expiry is a 403, never a 410.
 */
export function verifyMediaRequest({ assetId, query = {}, now = Date.now(), key, dataDir } = {}) {
  const id = text(assetId);
  const clientId = text(query.c);
  const expRaw = text(query.exp);
  const sig = text(query.sig).toLowerCase();
  if (!ASSET_ID_RE.test(id) || !isValidClientId(clientId) || !/^\d{1,15}$/.test(expRaw) || !SIG_RE.test(sig)) {
    return { ok: false, status: 403, code: 'bad-signature' };
  }
  const exp = Number(expRaw);
  const expected = mediaSignature(key || mediaSigningKey(dataDir), id, clientId, exp);
  if (!safeEqualHex(expected, sig)) return { ok: false, status: 403, code: 'bad-signature' };
  if (exp <= nowMs(now)) return { ok: false, status: 410, code: 'expired' };
  return { ok: true, clientId, assetId: id, exp };
}

// ---------------------------------------------------------------- sources

function urlOf(entry) {
  if (typeof entry === 'string') return text(entry);
  if (entry && typeof entry === 'object') return text(entry.url || entry.src || entry.imageUrl || entry.image || entry.path);
  return '';
}

/** A Kundedata URL that points at a portal upload: { userId, fileName } or null. */
export function clientUploadRef(url) {
  const match = CLIENT_MEDIA_RE.exec(text(url));
  if (!match) return null;
  let fileName = match[2];
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    return null;
  }
  fileName = basename(fileName);
  if (!fileName || fileName.startsWith('.') || !USER_ID_RE.test(match[1])) return null;
  return { userId: match[1], fileName };
}

function uploadPath(dataDir, ref) {
  const root = join(dataDirOf(dataDir), 'client-uploads', ref.userId);
  const full = normalize(join(root, ref.fileName));
  if (!inside(root, full) || !existsSync(full)) return '';
  try {
    return statSync(full).isFile() ? full : '';
  } catch {
    return '';
  }
}

function bankOf(client) {
  try {
    const profile = profileForClient(client, clientPortal.listClientProfiles());
    return { profile, bank: profile?.clientDataBank && typeof profile.clientDataBank === 'object' ? profile.clientDataBank : {} };
  } catch {
    return { profile: null, bank: {} };
  }
}

function productImageUrls(bank = {}) {
  const urls = [];
  for (const catalog of Array.isArray(bank.productCatalogs) ? bank.productCatalogs : []) {
    for (const category of Array.isArray(catalog?.categories) ? catalog.categories : []) {
      for (const product of Array.isArray(category?.products) ? category.products : []) urls.push(urlOf(product?.imageUrl || product?.image));
    }
  }
  for (const category of Array.isArray(bank.products) ? bank.products : []) {
    const items = Array.isArray(category?.items) ? category.items : (Array.isArray(category?.products) ? category.products : []);
    for (const item of items) urls.push(urlOf(item?.imageUrl || item?.image));
  }
  return urls.filter(Boolean);
}

/**
 * Every media file the client has: [{ source, bucket, name, path (absolute) | url (external) }].
 * Sources: bank, logo, product, inbox, library.
 */
export function collectClientMedia(client, { dataDir } = {}) {
  const base = dataDirOf(dataDir);
  const { bank } = bankOf(client);
  const candidates = [];
  const media = bank.media && typeof bank.media === 'object' ? bank.media : {};
  for (const bucket of MEDIA_BUCKET_KEYS) {
    for (const entry of Array.isArray(media[bucket]) ? media[bucket] : []) candidates.push({ source: 'bank', bucket, url: urlOf(entry) });
  }
  const logos = bank.brandIdentity?.logos && typeof bank.brandIdentity.logos === 'object' ? bank.brandIdentity.logos : {};
  for (const [kind, entry] of Object.entries(logos)) candidates.push({ source: 'logo', bucket: `logo:${kind}`, url: urlOf(entry) });
  for (const url of productImageUrls(bank)) candidates.push({ source: 'product', bucket: 'products', url });

  const files = [];
  const external = [];
  const seen = new Set();
  const add = (row) => {
    if (seen.has(row.path)) return;
    seen.add(row.path);
    files.push(row);
  };
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    const ref = clientUploadRef(candidate.url);
    const path = ref ? uploadPath(base, ref) : '';
    if (path) add({ source: candidate.source, bucket: candidate.bucket, name: ref.fileName, path, rightsKey: `${ref.userId}/${ref.fileName}` });
    else if (/^https?:\/\//i.test(candidate.url) && !ref) external.push({ source: candidate.source, bucket: candidate.bucket, url: candidate.url });
  }

  // Attachments the inbox filed for this client.
  const inboxDir = join(base, 'inbox-bot-staging', text(client?.id));
  if (isValidClientId(client?.id) && existsSync(inboxDir)) {
    for (const name of readdirSync(inboxDir).sort()) {
      const path = join(inboxDir, name);
      try {
        if (statSync(path).isFile()) add({ source: 'inbox', bucket: 'inbox', name, path, rightsKey: '' });
      } catch {
        // Removed meanwhile.
      }
    }
  }

  // Hub library items tagged client:<id>.
  const libraryRoot = join(base, 'media');
  const index = readJson(join(base, 'media-library.json'), {});
  const tag = `client:${text(client?.id)}`.toLowerCase();
  for (const [name, meta] of Object.entries(index?.items && typeof index.items === 'object' ? index.items : {})) {
    const tags = Array.isArray(meta?.tags) ? meta.tags.map((entry) => text(entry).toLowerCase()) : [];
    if (!tags.includes(tag)) continue;
    const path = normalize(join(libraryRoot, name));
    if (!inside(libraryRoot, path) || !existsSync(path)) continue;
    add({ source: 'library', bucket: 'library', name: basename(name), path, rightsKey: '' });
  }
  return { files, external };
}

function assetIdFor(clientId, relPath) {
  return `ma_${createHash('sha256').update(`${clientId}\n${relPath}`).digest('hex').slice(0, 32)}`;
}

function mimeFor(name) {
  const mime = clientMediaMime(name);
  return mime !== 'application/octet-stream' ? mime : mediaMimeForName(name);
}

// ---------------------------------------------------------------- rights

/** '<portalUserId>/<fileName>' for a portal upload URL, or ''. */
export function mediaRightsKey(url) {
  const ref = clientUploadRef(url);
  return ref ? `${ref.userId}/${ref.fileName}` : '';
}

function rightsFallback(dataDir) {
  return readJson(join(dataDirOf(dataDir), MEDIA_RIGHTS_FILE), { businesses: {} }) || { businesses: {} };
}

/** The rights map for a client: the client record's copy merged over the portal copy. */
export function readMediaRights(client, { dataDir, profile } = {}) {
  const businessId = text(client?.portalBusinessId || profile?.businessId);
  const portal = businessId ? rightsFallback(dataDir).businesses?.[businessId] || {} : {};
  const own = client?.ext?.mediaRights && typeof client.ext.mediaRights === 'object' ? client.ext.mediaRights : {};
  return { ...portal, ...own };
}

/** The sales client a portal user's business belongs to, or null. */
export function salesClientForPortal({ userId = '', businessId = '', profile = null } = {}) {
  const user = text(userId);
  const business = text(businessId || profile?.businessId);
  const linked = text(profile?.websiteBuilder?.salesClientId);
  const clients = sales.getSalesClients();
  return clients.find((client) => business && text(client.portalBusinessId) === business)
    || clients.find((client) => linked && text(client.id) === linked)
    || clients.find((client) => user && text(client.portalUserId) === user)
    || null;
}

/**
 * Stores the client's answer for one of their own uploads. Returns { ok, key, stored: 'client' | 'portal' }
 * or { ok: false, status, message }. Only the uploader's own files (/client-media/<userId>/...) can be confirmed.
 */
export function recordMediaRights({ userId, url, confirmed, now = new Date(), dataDir } = {}) {
  const ref = clientUploadRef(url);
  if (!ref) return { ok: false, status: 400, message: 'Ukjent fil.' };
  if (ref.userId !== text(userId)) return { ok: false, status: 403, message: 'Ikke din fil.' };
  const key = `${ref.userId}/${ref.fileName}`;
  const value = { confirmed: confirmed === true, at: new Date(nowMs(now)).toISOString() };
  let profile = null;
  try {
    profile = clientPortal.getClientProfileByUserId(userId);
  } catch {
    profile = null;
  }
  const client = salesClientForPortal({ userId, profile });
  if (client) {
    const ext = client.ext && typeof client.ext === 'object' ? client.ext : {};
    const rights = ext.mediaRights && typeof ext.mediaRights === 'object' ? ext.mediaRights : {};
    sales.updateSalesClient(client.id, { ext: { ...ext, mediaRights: { ...rights, [key]: value } } });
    return { ok: true, key, stored: 'client', value };
  }
  const businessId = text(profile?.businessId || userId);
  const path = join(dataDirOf(dataDir), MEDIA_RIGHTS_FILE);
  const doc = rightsFallback(dataDir);
  const businesses = { ...(doc.businesses || {}) };
  businesses[businessId] = { ...(businesses[businessId] || {}), [key]: value };
  writeDataJson(path, { ...doc, businesses });
  return { ok: true, key, stored: 'portal', value };
}

/** The rights answers a portal user's business has given so far. */
export function mediaRightsForPortalUser(userId, { dataDir } = {}) {
  let profile = null;
  try {
    profile = clientPortal.getClientProfileByUserId(userId);
  } catch {
    profile = null;
  }
  const client = salesClientForPortal({ userId, profile });
  if (client) return readMediaRights(client, { dataDir, profile });
  const businessId = text(profile?.businessId || userId);
  return rightsFallback(dataDir).businesses?.[businessId] || {};
}

// ---------------------------------------------------------------- manifest

function indexPath(clientId, dataDir) {
  return perClientPath(MEDIA_MANIFEST_DIR, clientId, { suffix: '.json', ctx: { dataDir } });
}

function writeIndex(path, value) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Builds the client's manifest: { kind, clientId, generatedAt, expiresAt, items, external }. Each item
 * has id, source, bucket, name, mime, bytes, sha256, rightsConfirmed (true | false | null) and url
 * (signed, valid ttlMs). The id index is stored under media-manifest/<clientId>.json when it changed.
 */
export function buildMediaManifest(clientId, { dataDir, now = Date.now(), ttlMs = MEDIA_URL_TTL_MS, key, client: given } = {}) {
  const id = text(clientId);
  if (!isValidClientId(id)) throw Object.assign(new Error('Invalid client id.'), { status: 400 });
  const client = given || sales.getSalesClientById(id);
  if (!client) return null;
  const base = dataDirOf(dataDir);
  const { files, external } = collectClientMedia(client, { dataDir: base });
  const rights = readMediaRights(client, { dataDir: base });
  const signingKey = key || mediaSigningKey(base);
  const at = nowMs(now);
  const expiresAt = at + Math.max(1, Number(ttlMs) || MEDIA_URL_TTL_MS);
  const indexItems = [];
  for (const file of files) {
    let bytes = 0;
    let sha256 = '';
    try {
      bytes = statSync(file.path).size;
      sha256 = sha256OfFile(file.path);
    } catch {
      continue;
    }
    const relPath = relative(base, file.path).split(sep).join('/');
    const answer = file.rightsKey && rights[file.rightsKey] ? rights[file.rightsKey].confirmed === true : null;
    indexItems.push({
      id: assetIdFor(id, relPath),
      source: file.source,
      bucket: file.bucket,
      name: file.name,
      mime: mimeFor(file.name),
      bytes,
      sha256,
      path: relPath,
      rightsConfirmed: answer,
    });
  }
  const path = indexPath(id, base);
  const previous = readJson(path, null);
  const same = previous && JSON.stringify(previous.items) === JSON.stringify(indexItems);
  if (!same) writeIndex(path, { kind: MEDIA_MANIFEST_KIND, clientId: id, builtAt: new Date(at).toISOString(), items: indexItems });
  return {
    kind: MEDIA_MANIFEST_KIND,
    clientId: id,
    generatedAt: new Date(at).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    items: indexItems.map(({ path: _path, ...item }) => ({
      ...item,
      url: signMediaUrl({ assetId: item.id, clientId: id, expiresAt, key: signingKey }),
    })),
    external,
  };
}

/** The file behind an asset id in the client's stored index: { path, name, mime, bytes, sha256 } or null. */
export function resolveMediaAsset(clientId, assetId, { dataDir } = {}) {
  if (!isValidClientId(clientId) || !ASSET_ID_RE.test(text(assetId))) return null;
  const base = dataDirOf(dataDir);
  const index = readJson(indexPath(clientId, base), null);
  const item = (Array.isArray(index?.items) ? index.items : []).find((row) => row?.id === assetId);
  if (!item) return null;
  const full = normalize(join(base, String(item.path || '')));
  if (!inside(base, full) || !existsSync(full)) return null;
  return { path: full, name: item.name, mime: item.mime || mimeFor(item.name), bytes: Number(item.bytes) || 0, sha256: item.sha256 };
}

registerStore({
  id: 'media-manifest',
  label: 'Medieliste',
  dir: `${MEDIA_MANIFEST_DIR}/<clientId>.json`,
  clientKey: 'path',
  retention: { rule: 'media' },
  personalData: 'File names, checksums and rights confirmations of client media',
  purpose: 'Handing client media to the website build',
  legalBasis: 'Contract',
  processors: ['Hostinger'],
  export(clientId, ctx = {}) {
    const path = indexPath(clientId, ctx.dataDir);
    return { files: path ? listFilesUnder(path, ctx) : [], records: path ? [readJson(path, null)].filter(Boolean) : [] };
  },
  erase(clientId, ctx = {}) {
    const path = indexPath(clientId, ctx.dataDir);
    if (!path || !existsSync(path)) return { action: 'none', records: 0, files: [] };
    const files = listFilesUnder(path, ctx).map((file) => file.path);
    // Removing the index revokes every signed link to the client's files at once.
    if (!ctx.dryRun) rmSync(path, { force: true });
    return { action: 'delete', records: 1, files };
  },
});

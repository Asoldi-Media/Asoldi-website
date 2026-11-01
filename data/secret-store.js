/**
 * The hub's disk secret store: one folder, <dataDir>/secrets, readable only by the hub account
 * (data/private-dir.js). The data dir survives git deploys, so a secret made here once is reused
 * across deploys and needs no Hostinger env change.
 *
 * Where every secret lives today (each is read from exactly this path):
 *   secrets/admin-secret              token signing secret (lib/auth-hardening.js, server.js)
 *   secrets/maker-callback-token      legacy Maker callback token (server.js, made on first use)
 *   secrets/initial-admin-password    first-boot admin password (server.js, only without an admin)
 *   secrets/email-unsub-key           unsubscribe link key (data/email-store.js)
 *   secrets/email-webhook-token       e-mail webhook token (data/email-store.js)
 *   secrets/webhooks.json             Fireflies webhook secret and URL token (data/webhook-secrets.js)
 *   secrets/email-secrets.json        pasted Brevo key and per-site keys (data/email-store.js writes it;
 *                                     this store never creates it)
 *   secrets/email-suppressions-created  marker file (data/email-store.js)
 * Private folders beside it, also user-only (data/private-dir.js), hold hashes and audits, not
 * secrets: cms-sso/ (lib/cms-sso.js) and site-credentials/ (lib/site-credentials.js).
 *
 * Rules:
 *  - read(name) returns the stored value, or '' when no file exists.
 *  - readOrCreate(name, { bytes, legacyPaths }) returns the stored value. The candidates are
 *    secrets/<name> and then each legacy path (relative to the data dir); the first one that exists
 *    decides. A new random value is made only when none of them exists.
 *  - A file that exists but cannot be read, or holds no usable value, is never replaced: the call
 *    throws SecretStoreError with code ESECRET_UNUSABLE. A read error therefore can never turn
 *    into a new secret.
 *  - Nothing is ever moved or rewritten. A new secret is written to a temp file (flag 'wx') and
 *    hard-linked into place, which fails when the name exists (exclusive create). Where hard links
 *    are not available the file is created with flag 'wx' directly. Two processes that create at
 *    the same time end with one value: the loser reads the winner's file.
 *  - Permissions are best effort and never throw: icacls on win32, chmod 600 elsewhere.
 *  - Creating a secret is logged (path only, never the value).
 */
import { randomBytes } from 'crypto';
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { ensurePrivateDir, restrictPath } from './private-dir.js';

export const SECRETS_FOLDER = 'secrets';
/** Folders the store keeps user-only. Secrets live only in the first one. */
export const PRIVATE_FOLDERS = Object.freeze([SECRETS_FOLDER, 'cms-sso', 'site-credentials']);
export const MIN_SECRET_LENGTH = 32;
export const SECRET_UNUSABLE = 'ESECRET_UNUSABLE';
export const SECRET_BAD_NAME = 'ESECRET_NAME';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
// A file another process is creating with flag 'wx' (no hard links) is briefly empty.
const SETTLE_ATTEMPTS = 20;
const SETTLE_PAUSE_MS = 25;
const READ_RETRIES = 3;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

export class SecretStoreError extends Error {
  constructor(message, code, rel = '') {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
    this.path = rel;
  }
}

/** A secret name is one plain file name: no folders, no traversal, no lock or temp names. */
export function assertSecretName(name) {
  const value = String(name ?? '');
  if (!NAME_RE.test(value) || value.includes('..') || /\.(lock|tmp)$/i.test(value)) {
    throw new SecretStoreError(`secret store: refused secret name ${JSON.stringify(value.slice(0, 80))}`, SECRET_BAD_NAME);
  }
  return value;
}

function insideDataDir(root, candidate) {
  const rel = relative(root, candidate);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function relLabel(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * Reads one candidate. { state: 'missing' } | { state: 'ok', value } | { state: 'unusable', reason }.
 * A read error is retried a few times (Windows reports a file another process is replacing as
 * busy for a moment); it never counts as "missing".
 */
function readCandidate(file, { parse, minLength }) {
  if (!existsSync(file)) return { state: 'missing' };
  let lastError = null;
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    try {
      const text = readFileSync(file, 'utf8');
      const value = parse(text, minLength);
      return value === null ? { state: 'unusable', reason: 'no usable value' } : { state: 'ok', value };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing' };
      lastError = error;
      pause(SETTLE_PAUSE_MS);
    }
  }
  return { state: 'unusable', reason: lastError?.code || 'unreadable' };
}

function parseText(text, minLength) {
  const value = String(text).trim();
  return value.length >= minLength ? value : null;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The store for one data dir. Options (tests): platform, exec and chmod (permission stubs), log,
 * and beforeCreate(name), called after the store found no file and before it creates one (a test
 * holds processes there so they all race for the same name).
 */
export function createSecretStore({
  dataDir,
  platform = process.platform,
  exec,
  chmod,
  log = console.warn,
  minLength = MIN_SECRET_LENGTH,
  beforeCreate = null,
} = {}) {
  if (!dataDir) throw new SecretStoreError('secret store: dataDir is required', SECRET_BAD_NAME);
  const root = resolve(dataDir);
  const dir = join(root, SECRETS_FOLDER);
  const permissions = { platform, exec, chmod, log };

  function folder() {
    return ensurePrivateDir(dir, permissions);
  }

  function pathOf(name) {
    return join(dir, assertSecretName(name));
  }

  function legacyFiles(legacyPaths = []) {
    return (Array.isArray(legacyPaths) ? legacyPaths : [legacyPaths]).filter(Boolean).map((raw) => {
      const text = String(raw);
      const file = isAbsolute(text) ? resolve(text) : resolve(root, text);
      if (!insideDataDir(root, file)) {
        throw new SecretStoreError(`secret store: legacy path ${JSON.stringify(text.slice(0, 120))} is outside the data dir`, SECRET_BAD_NAME);
      }
      return file;
    });
  }

  /** First existing candidate: { file, result } or null when none exists. */
  function locate(name, legacyPaths, reader) {
    for (const file of [pathOf(name), ...legacyFiles(legacyPaths)]) {
      const result = readCandidate(file, reader);
      if (result.state !== 'missing') return { file, result };
    }
    return null;
  }

  function unusable(file, reason) {
    const rel = relLabel(root, file);
    return new SecretStoreError(
      `secret store: ${rel} exists but holds no usable secret (${reason}); it is left as it is and no new secret is made`,
      SECRET_UNUSABLE,
      rel,
    );
  }

  /** Another process created `file` first: its value is the one every process uses. */
  function settle(file, reader) {
    log(`[secret-store] ${relLabel(root, file)}: another process made it at the same moment; its value is used`);
    let result = { state: 'missing' };
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      result = readCandidate(file, reader);
      if (result.state === 'ok') return result.value;
      pause(SETTLE_PAUSE_MS);
    }
    throw unusable(file, result.reason || 'still empty after another process created it');
  }

  /** Exclusive create of `text` at `file`; returns the value that ends up stored. */
  function createExclusive(file, text, reader, created) {
    if (typeof beforeCreate === 'function') beforeCreate(relLabel(root, file));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    try {
      try {
        linkSync(tmp, file);
        restrictPath(file, { ...permissions, directory: false });
        log(`[secret-store] created ${relLabel(root, file)}`);
        return created;
      } catch (error) {
        if (error?.code === 'EEXIST') return settle(file, reader);
        if (!NO_HARD_LINKS.has(error?.code)) throw error;
      }
      try {
        writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
        restrictPath(file, { ...permissions, directory: false });
        log(`[secret-store] created ${relLabel(root, file)}`);
        return created;
      } catch (error) {
        if (error?.code === 'EEXIST') return settle(file, reader);
        throw error;
      }
    } finally {
      try { unlinkSync(tmp); } catch { /* linked or already gone */ }
    }
  }

  const textReader = { parse: parseText, minLength };
  const jsonReader = { parse: parseJsonObject, minLength };

  return {
    dataDir: root,
    dir,
    pathOf,
    folder,

    /** The stored value, or '' when no candidate file exists. Throws ESECRET_UNUSABLE for a damaged one. */
    read(name, { legacyPaths = [] } = {}) {
      const found = locate(name, legacyPaths, textReader);
      if (!found) return '';
      if (found.result.state === 'ok') return found.result.value;
      throw unusable(found.file, found.result.reason);
    },

    /** The stored value; a new random hex value of `bytes` bytes only when no candidate exists. */
    readOrCreate(name, { bytes = 48, legacyPaths = [] } = {}) {
      folder();
      const found = locate(name, legacyPaths, textReader);
      if (found) {
        if (found.result.state === 'ok') return found.result.value;
        throw unusable(found.file, found.result.reason);
      }
      const value = randomBytes(Math.max(16, Number(bytes) || 48)).toString('hex');
      return createExclusive(pathOf(name), `${value}\n`, textReader, value);
    },

    /**
     * A JSON object secret file. Returns the parsed object that is stored, or the one `create()`
     * made when no candidate exists. The object's contents are the caller's to check.
     */
    readOrCreateJson(name, { create, legacyPaths = [] } = {}) {
      folder();
      const found = locate(name, legacyPaths, jsonReader);
      if (found) {
        if (found.result.state === 'ok') return found.result.value;
        throw unusable(found.file, found.result.reason);
      }
      const value = typeof create === 'function' ? create() : {};
      return createExclusive(pathOf(name), `${JSON.stringify(value, null, 2)}\n`, jsonReader, value);
    },

    /** One of PRIVATE_FOLDERS, created and restricted to this account. */
    privateFolder(name) {
      if (!PRIVATE_FOLDERS.includes(name)) {
        throw new SecretStoreError(`secret store: ${JSON.stringify(String(name).slice(0, 40))} is not a private folder`, SECRET_BAD_NAME);
      }
      return ensurePrivateDir(join(root, name), permissions);
    },
  };
}

const stores = new Map();

/** The shared store for a data dir (one per resolved path and process). */
export function secretStoreFor(dataDir) {
  if (!dataDir) throw new SecretStoreError('secret store: dataDir is required', SECRET_BAD_NAME);
  const key = resolve(dataDir);
  let store = stores.get(key);
  if (!store) {
    store = createSecretStore({ dataDir: key });
    stores.set(key, store);
  }
  return store;
}

export function isSecretUnusable(error) {
  return error?.code === SECRET_UNUSABLE;
}

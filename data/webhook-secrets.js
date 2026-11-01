/**
 * Webhook credentials generated on the hub data disk, so rotation needs no
 * Hostinger env change.
 *
 * File: <dataDir>/secrets/webhooks.json (folder 0700 or user-only ACL on Windows,
 * file 0600). The data dir survives git deploys.
 *
 * Fireflies: the env values FIREFLIES_WEBHOOK_SECRET(S) and FIREFLIES_WEBHOOK_TOKEN
 * were published, so they are never trusted again. lib/fireflies-webhook.js
 * reads them only to recognise a request that uses them and reject it. The
 * trusted signing secret and URL token live here. Until the new secret is pasted
 * into the Fireflies dashboard, the 60-second pull ingest (Fireflies API key)
 * delivers every transcript.
 *
 * Every change is a locked read-modify-write on a fresh read: a rotation made by
 * another hub process is never overwritten by this process's cached copy.
 *
 * The file is made through the disk secret store (data/secret-store.js), only when it
 * does not exist. A file that cannot be read, or whose Fireflies entry is damaged, is
 * never replaced on the read path (ensure returns null, the pull ingest keeps working);
 * a rotation by an admin writes a fresh entry.
 */
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readJsonCached, readJsonFresh, updateJsonLocked } from './atomic-json.js';
import { isSecretUnusable, secretStoreFor } from './secret-store.js';
import { getPersistentDataDir } from './storage-path.js';

const FILE_NAME = 'webhooks.json';

let defaultDataDir = '';

function dataDirOf(dataDir) {
  if (!dataDir && !defaultDataDir) defaultDataDir = getPersistentDataDir();
  return dataDir || defaultDataDir;
}

export function webhookSecretsPath(dataDir) {
  return secretStoreFor(dataDirOf(dataDir)).pathOf(FILE_NAME);
}

function nowIso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString();
}

function newFirefliesCredentials(now) {
  return {
    // Fireflies signs the raw body with HMAC-SHA256 of this value (x-hub-signature).
    secret: randomBytes(32).toString('hex'),
    // Fallback for a webhook URL with ?token=…; can be switched off.
    token: randomBytes(24).toString('base64url'),
    acceptQueryToken: true,
    rotatedAt: nowIso(now),
    lastVerified: null,
  };
}

function validFireflies(row) {
  return Boolean(row && /^[0-9a-f]{64}$/.test(String(row.secret || '')) && String(row.token || '').length >= 24);
}

function privatePath(dataDir) {
  const store = secretStoreFor(dataDirOf(dataDir));
  store.folder();
  return store.pathOf(FILE_NAME);
}

// One notice per file and kind of damage: the hot path (every webhook, every status read) never
// repeats it. A usable read clears it, so damage that comes back is reported again.
const unusableNoticed = new Set();

function noticeOnce(key, message) {
  if (unusableNoticed.has(key)) return;
  unusableNoticed.add(key);
  console.warn(message);
}

function clearNotices(path) {
  unusableNoticed.delete(`${path}|entry`);
  unusableNoticed.delete(`${path}|file`);
}

/**
 * Returns the trusted Fireflies credentials, generating them on first use (the file does not
 * exist yet), or adding them to an older file that has no Fireflies entry at all.
 * Returns null when the data dir cannot be written, or when the file or its Fireflies entry
 * exists but is damaged: that file is left as it is (a rotation replaces it).
 */
export function ensureFirefliesWebhookSecrets({ dataDir, now } = {}) {
  const path = webhookSecretsPath(dataDir);
  const cached = readJsonCached(path);
  if (cached && validFireflies(cached.fireflies)) {
    if (unusableNoticed.size) clearNotices(path);
    return cached.fireflies;
  }
  try {
    const stored = secretStoreFor(dataDirOf(dataDir)).readOrCreateJson(FILE_NAME, {
      create: () => ({ version: 1, fireflies: newFirefliesCredentials(now) }),
    });
    if (validFireflies(stored.fireflies)) {
      // The file may have just been made: keep the hot-path read cache in step with it.
      readJsonFresh(path);
      clearNotices(path);
      return stored.fireflies;
    }
    if (stored.fireflies === undefined) {
      // An older layout without a Fireflies entry: add one, under the lock, on a fresh read.
      // Nothing is written when the fresh read fails or another process added an entry.
      const state = updateJsonLocked(privatePath(dataDir), (fresh) => (
        fresh && fresh.fireflies === undefined
          ? { ...fresh, version: 1, fireflies: newFirefliesCredentials(now) }
          : undefined
      ));
      if (state && validFireflies(state.fireflies)) {
        clearNotices(path);
        return state.fireflies;
      }
    }
    noticeOnce(`${path}|entry`, `[security] secrets/${FILE_NAME} has a damaged Fireflies entry; it is left as it is until an admin rotates it`);
    return null;
  } catch (error) {
    if (isSecretUnusable(error)) {
      // The file exists but cannot be read or parsed: it is left as it is (a rotation replaces it).
      noticeOnce(`${path}|file`, `[security] secrets/${FILE_NAME} cannot be read as JSON; it is left as it is until an admin rotates it`);
      return null;
    }
    console.warn(`[security] could not read or create ${FILE_NAME}: ${error?.code || error?.message || error}`);
    return null;
  }
}

/** New secret and token. The previous data values stop working at once. */
export function rotateFirefliesWebhookSecrets({ dataDir, now, by = 'admin' } = {}) {
  const state = updateJsonLocked(privatePath(dataDir), (fresh) => {
    const previous = fresh?.fireflies || {};
    const fireflies = {
      ...newFirefliesCredentials(now),
      acceptQueryToken: previous.acceptQueryToken !== false,
      rotatedBy: String(by || 'admin').slice(0, 80),
    };
    return { ...(fresh || {}), version: 1, fireflies };
  });
  return state.fireflies;
}

export function setFirefliesQueryTokenAccepted(enabled, { dataDir } = {}) {
  if (!ensureFirefliesWebhookSecrets({ dataDir })) return null;
  const state = updateJsonLocked(privatePath(dataDir), (fresh) => {
    if (!fresh || !validFireflies(fresh.fireflies)) return undefined;
    return { ...fresh, fireflies: { ...fresh.fireflies, acceptQueryToken: Boolean(enabled) } };
  });
  return state && validFireflies(state.fireflies) ? state.fireflies : null;
}

/**
 * Stores which credential verified the last accepted webhook. Written only on success, at most
 * once a minute, and only while `credential` (the secret or token that verified the request)
 * is still the stored one: a request verified with a just-rotated value never writes it back.
 */
export function recordFirefliesWebhookVerified(via, { dataDir, now, credential } = {}) {
  const path = webhookSecretsPath(dataDir);
  const cached = readJsonCached(path);
  if (!cached || !validFireflies(cached.fireflies)) return;
  const at = nowIso(now);
  const recent = (row) => row?.lastVerified?.via === via && Date.parse(row.lastVerified.at) > Date.parse(at) - 60_000;
  if (recent(cached.fireflies)) return;
  try {
    updateJsonLocked(path, (fresh) => {
      const row = fresh?.fireflies;
      if (!validFireflies(row) || recent(row)) return undefined;
      if (credential !== undefined) {
        const stored = via === 'data-token' ? row.token : row.secret;
        if (stored !== credential) return undefined;
      }
      return { ...fresh, fireflies: { ...row, lastVerified: { via: String(via || ''), at } } };
    });
  } catch (error) {
    console.warn(`[security] could not record webhook verification: ${error?.code || error?.message || error}`);
  }
}

/**
 * True when the file is there. After ensureFirefliesWebhookSecrets returned null, that means the
 * file or its Fireflies entry is damaged and only a rotation replaces it (the folder is not the
 * problem).
 */
export function firefliesWebhookFileExists({ dataDir } = {}) {
  return existsSync(webhookSecretsPath(dataDir));
}

/** Status without any secret value. damaged: true only while the file exists but cannot be used. */
export function firefliesWebhookSecretStatus({ dataDir } = {}) {
  const row = ensureFirefliesWebhookSecrets({ dataDir });
  return {
    stored: Boolean(row),
    file: `secrets/${FILE_NAME}`,
    rotatedAt: row?.rotatedAt || null,
    acceptQueryToken: row ? row.acceptQueryToken !== false : false,
    lastVerified: row?.lastVerified || null,
    ...(!row && firefliesWebhookFileExists({ dataDir }) ? { damaged: true } : {}),
  };
}

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
 */
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { createJsonOnce, readJsonCached, updateJsonLocked } from './atomic-json.js';
import { ensurePrivateDir } from './private-dir.js';
import { getPersistentDataDir } from './storage-path.js';

const FILE_NAME = 'webhooks.json';

let defaultDataDir = '';

export function webhookSecretsPath(dataDir) {
  if (!dataDir && !defaultDataDir) defaultDataDir = getPersistentDataDir();
  return join(dataDir || defaultDataDir, 'secrets', FILE_NAME);
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
  const path = webhookSecretsPath(dataDir);
  ensurePrivateDir(dirname(path));
  return path;
}

/**
 * Returns the trusted Fireflies credentials, generating them on first use.
 * Returns null only when the data dir cannot be written.
 */
export function ensureFirefliesWebhookSecrets({ dataDir, now } = {}) {
  const path = webhookSecretsPath(dataDir);
  const cached = readJsonCached(path);
  if (cached && validFireflies(cached.fireflies)) return cached.fireflies;
  try {
    const target = privatePath(dataDir);
    if (!cached) {
      const created = createJsonOnce(target, { version: 1, fireflies: newFirefliesCredentials(now) });
      if (created && validFireflies(created.fireflies)) return created.fireflies;
    }
    // The file exists without a usable Fireflies entry (older layout, hand edit, truncated file).
    const state = updateJsonLocked(target, (fresh) => (
      fresh && validFireflies(fresh.fireflies)
        ? undefined
        : { ...(fresh || {}), version: 1, fireflies: newFirefliesCredentials(now) }
    ));
    return state.fireflies;
  } catch (error) {
    console.warn(`[security] could not create ${FILE_NAME}: ${error?.code || error?.message || error}`);
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

/** Status without any secret value. */
export function firefliesWebhookSecretStatus({ dataDir } = {}) {
  const row = ensureFirefliesWebhookSecrets({ dataDir });
  return {
    stored: Boolean(row),
    file: `secrets/${FILE_NAME}`,
    rotatedAt: row?.rotatedAt || null,
    acceptQueryToken: row ? row.acceptQueryToken !== false : false,
    lastVerified: row?.lastVerified || null,
  };
}

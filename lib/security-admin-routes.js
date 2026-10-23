/**
 * Security admin routes (Superadmin → Sikkerhet card) and client "log out everywhere".
 *
 * Status routes report sources and counters only. The one route that returns a
 * secret value (Fireflies reveal/rotate) is admin-only, POST, and no-store, so the
 * owner can paste the value into the Fireflies dashboard whenever convenient.
 */
import {
  ensureFirefliesWebhookSecrets,
  firefliesWebhookSecretStatus,
  rotateFirefliesWebhookSecrets,
  setFirefliesQueryTokenAccepted,
} from '../data/webhook-secrets.js';
import {
  REVOKE_SCOPES,
  countRevokedSubjects,
  revokeTokensBefore,
  updateSecuritySettings,
} from '../data/security-settings.js';
import { readFirefliesWebhookConfig } from './fireflies-webhook.js';
import { securityCounters } from './security-counters.js';
import { logoutSubjectEverywhere, tokenPolicyStatus } from './token-policy.js';

export const FIREFLIES_WEBHOOK_PATH = '/api/webhooks/fireflies';

const FIREFLIES_COUNTERS = ['fireflies-webhook-retired-credential', 'fireflies-webhook-rejected'];

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key]).map((key) => [key, object[key]]));
}

export function requestOrigin(req, env = process.env) {
  const fromEnv = String(env.APP_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/\s]+$/i.test(fromEnv)) return fromEnv;
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https').split(',')[0].trim() || 'https';
  const host = String(req?.get?.('host') || req?.headers?.host || '').trim();
  return host ? `${proto}://${host}` : 'https://asoldi.com';
}

export function firefliesWebhookStatus({ env = process.env, origin = 'https://asoldi.com' } = {}) {
  const config = readFirefliesWebhookConfig(env);
  const disk = firefliesWebhookSecretStatus();
  return {
    webhookUrl: `${origin}${FIREFLIES_WEBHOOK_PATH}`,
    trustedSource: disk.stored ? 'data' : 'none',
    stored: disk.stored,
    file: disk.file,
    rotatedAt: disk.rotatedAt,
    acceptQueryToken: disk.acceptQueryToken,
    lastVerified: disk.lastVerified,
    envRetired: true,
    retiredEnvPresent: {
      secret: config.retiredSecrets.length > 0,
      token: Boolean(config.retiredToken),
    },
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeySource: config.apiKeySource || null,
    pullIngest: Boolean(config.apiKey),
    counters: pick(securityCounters(), FIREFLIES_COUNTERS),
  };
}

function firefliesReveal(row, origin) {
  const webhookUrl = `${origin}${FIREFLIES_WEBHOOK_PATH}`;
  return {
    webhookUrl,
    secret: row.secret,
    tokenUrl: row.acceptQueryToken !== false ? `${webhookUrl}?token=${encodeURIComponent(row.token)}` : null,
    rotatedAt: row.rotatedAt,
  };
}

export function makerCallbackTokenSource(env = process.env) {
  return String(env.WEBSITE_MAKER_STATUS_CALLBACK_TOKEN || env.SALES_MAKER_STATUS_CALLBACK_TOKEN || '').trim() ? 'env' : 'disk';
}

/**
 * deps:
 *   adminAuth, clientAuth – the hub middlewares
 *   signToken(payload)    – the hub signer (stamps the token version)
 *   adminSecret           – { source, envRejected } from resolveHubSecret (never the value)
 */
export function registerSecurityAdminRoutes(app, { adminAuth, clientAuth, signToken, adminSecret = {}, env = process.env } = {}) {
  if (!adminAuth || !clientAuth || !signToken) throw new Error('registerSecurityAdminRoutes: missing deps');

  app.get('/api/admin/system/security', adminAuth, (req, res) => {
    noStore(res);
    res.json({
      adminSecretSource: adminSecret.source || 'unknown',
      adminSecretEnvRejected: adminSecret.envRejected || null,
      makerCallbackTokenSource: makerCallbackTokenSource(env),
      tokens: { ...tokenPolicyStatus({ env }), revokedSubjects: countRevokedSubjects() },
      firefliesWebhook: firefliesWebhookStatus({ env, origin: requestOrigin(req, env) }),
      counters: securityCounters(),
    });
  });

  app.get('/api/admin/security/fireflies-webhook', adminAuth, (req, res) => {
    noStore(res);
    res.json(firefliesWebhookStatus({ env, origin: requestOrigin(req, env) }));
  });

  // Shows the trusted values once more, for a paste into Fireflies → Settings → Developer settings → Webhooks.
  app.post('/api/admin/security/fireflies-webhook/reveal', adminAuth, (req, res) => {
    noStore(res);
    const row = ensureFirefliesWebhookSecrets();
    if (!row) return res.status(503).json({ message: 'The hub data folder is not writable, so no webhook secret could be stored.' });
    console.log(`[security] fireflies webhook secret shown to admin ${String(req.admin?.username || '').slice(0, 60)}`);
    return res.json(firefliesReveal(row, requestOrigin(req, env)));
  });

  app.post('/api/admin/security/fireflies-webhook/rotate', adminAuth, (req, res) => {
    noStore(res);
    try {
      const row = rotateFirefliesWebhookSecrets({ by: `admin:${String(req.admin?.username || '').slice(0, 60)}` });
      console.log(`[security] fireflies webhook secret rotated by admin ${String(req.admin?.username || '').slice(0, 60)}`);
      return res.json({ ok: true, ...firefliesReveal(row, requestOrigin(req, env)) });
    } catch (error) {
      return res.status(500).json({ message: `Could not rotate: ${error?.code || error?.message || 'error'}` });
    }
  });

  app.post('/api/admin/security/fireflies-webhook/query-token', adminAuth, (req, res) => {
    noStore(res);
    const row = setFirefliesQueryTokenAccepted(req.body?.enabled === true);
    if (!row) return res.status(503).json({ message: 'The hub data folder is not writable.' });
    return res.json(firefliesWebhookStatus({ env, origin: requestOrigin(req, env) }));
  });

  app.put('/api/admin/security/token-settings', adminAuth, (req, res) => {
    noStore(res);
    try {
      updateSecuritySettings(
        { maxTokenAgeDays: req.body?.maxTokenAgeDays ?? null },
        { by: `admin:${String(req.admin?.username || '').slice(0, 60)}` }
      );
      return res.json({ ok: true, tokens: tokenPolicyStatus({ env }) });
    } catch (error) {
      return res.status(400).json({ message: error?.message || 'Invalid settings' });
    }
  });

  // { scope: all|admin|staff|client } logs a whole class out; { userId } logs one user out everywhere.
  app.post('/api/admin/security/revoke-tokens', adminAuth, (req, res) => {
    noStore(res);
    const by = `admin:${String(req.admin?.username || '').slice(0, 60)}`;
    const userId = String(req.body?.userId ?? '').trim();
    if (userId) {
      const tokenVersion = logoutSubjectEverywhere(`u:${userId}`, { reason: `admin-revoke (${by})` });
      return res.json({ ok: true, userId, tokenVersion });
    }
    const scope = String(req.body?.scope || '').trim();
    if (!REVOKE_SCOPES.includes(scope)) {
      return res.status(400).json({ message: `scope must be one of ${REVOKE_SCOPES.join(', ')}, or send userId` });
    }
    revokeTokensBefore(scope, { by });
    console.log(`[security] ${scope} tokens revoked by ${by}`);
    const body = { ok: true, scope, tokens: tokenPolicyStatus({ env }) };
    // The admin who pressed the button keeps working with a fresh token.
    if (scope === 'all' || scope === 'admin') {
      body.token = signToken({ role: 'admin', username: req.admin?.username, at: Date.now() });
    }
    return res.json(body);
  });

  // Client portal: log this login out on every device (this one included).
  app.post('/api/client/account/logout-everywhere', clientAuth, (req, res) => {
    noStore(res);
    try {
      logoutSubjectEverywhere(req.client, { reason: 'client-logout-everywhere' });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ message: error?.message || 'Kunne ikke logge ut alle enheter.' });
    }
  });
}

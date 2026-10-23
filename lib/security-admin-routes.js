/**
 * Security admin routes (Superadmin → Sikkerhet card) and client "log out everywhere".
 *
 * Status routes report sources and counters only. The routes that return a secret value
 * (Fireflies reveal/rotate, Maker callback token rotate) are admin-only, POST, and no-store, so
 * the owner can paste the value where it belongs whenever convenient. The two disk-secret
 * rotations also need the admin's current password and a typed confirmation. Once a secret is
 * rotated the answer always carries the new token: a failed audit write is logged and reported
 * as auditSaved: false, never turned into a missing response.
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
  readSecuritySettings,
  recordSecretRotation,
  revokeTokensBefore,
  updateSecuritySettings,
} from '../data/security-settings.js';
import { readFirefliesWebhookConfig } from './fireflies-webhook.js';
import { noteSecurityEvent, securityCounters } from './security-counters.js';
import { logoutSubjectEverywhere, tokenPolicyStatus } from './token-policy.js';

/** Typed by the admin to confirm a rotation (with the current password). */
export const ROTATE_CONFIRM_WORD = 'ROTER';

/** Env keys the Maker reads the callback token from (website-maker lib/hub-target.js callers). */
export const MAKER_CALLBACK_TOKEN_ENV_KEYS = Object.freeze(['WEBSITE_MAKER_STATUS_CALLBACK_TOKEN', 'SALES_MAKER_STATUS_CALLBACK_TOKEN']);

export const SIGNING_SECRET_FROM_ENV_MESSAGE =
  'Innlogginger signeres med ADMIN_SECRET fra miljøvariablene på serveren, og den verdien vinner over nøkkelen på disken. ' +
  'En ny nøkkel her ville derfor ikke logget noen ut. Bytt eller fjern ADMIN_SECRET der den er satt, og start appen på nytt.';

export const MAKER_TOKEN_FROM_ENV_MESSAGE =
  'Maker-tokenet kommer fra WEBSITE_MAKER_STATUS_CALLBACK_TOKEN eller SALES_MAKER_STATUS_CALLBACK_TOKEN i miljøvariablene på serveren, ' +
  'og den verdien vinner over tokenet på disken. Bytt den der den er satt i stedet.';

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

function adminLabel(req) {
  return `admin:${String(req.admin?.username || '').slice(0, 60)}`;
}

function confirmWordOk(body) {
  return String(body?.confirm ?? '').trim().toUpperCase() === ROTATE_CONFIRM_WORD;
}

/**
 * The audit trail of a rotation that has already happened: the settings record, the counter and
 * a log line. Never throws (the new secret is live, so the admin must get the answer anyway).
 * Returns { at, saved }.
 */
function auditSecretRotation(recordRotation, name, by, { counter, logLine }) {
  let at = new Date().toISOString();
  let saved = false;
  try {
    const settings = recordRotation(name, { by });
    at = settings?.secretRotations?.[name]?.at || at;
    saved = true;
  } catch (error) {
    console.error(`[security] ${name} rotated by ${by}, but the rotation record could not be saved: ${error?.code || error?.message || 'error'}`);
  }
  try {
    noteSecurityEvent(counter);
    console.log(logLine);
  } catch {
    // Counters and logs are best effort.
  }
  return { at, saved };
}

/**
 * deps:
 *   adminAuth, clientAuth – the hub middlewares
 *   signToken(payload)    – the hub signer (stamps the token version)
 *   adminSecret           – { source, envRejected } of the signing secret (never the value)
 *   adminSecretHolder, makerCallbackTokenHolder – createHubSecretHolder() results; without them
 *                           the rotate routes answer 503
 *   confirmAdminPassword(req, res, password) → Promise<boolean>: checks the signed-in admin's
 *                           password (login limits apply); when false it has already answered
 *   recordRotation(name, { by }) – the audit record (data/security-settings.js recordSecretRotation)
 */
export function registerSecurityAdminRoutes(app, {
  adminAuth,
  clientAuth,
  signToken,
  adminSecret = {},
  adminSecretHolder = null,
  makerCallbackTokenHolder = null,
  confirmAdminPassword = null,
  recordRotation = recordSecretRotation,
  env = process.env,
} = {}) {
  if (!adminAuth || !clientAuth || !signToken) throw new Error('registerSecurityAdminRoutes: missing deps');

  app.get('/api/admin/system/security', adminAuth, (req, res) => {
    noStore(res);
    const settings = readSecuritySettings();
    res.json({
      adminSecretSource: adminSecret.source || 'unknown',
      adminSecretEnvRejected: adminSecret.envRejected || null,
      makerCallbackTokenSource: makerCallbackTokenHolder ? makerCallbackTokenHolder.source : makerCallbackTokenSource(env),
      secretRotations: settings.secretRotations,
      secretRotationHistory: settings.secretRotationHistory,
      rotateConfirmWord: ROTATE_CONFIRM_WORD,
      tokens: { ...tokenPolicyStatus({ env }), revokedSubjects: countRevokedSubjects() },
      firefliesWebhook: firefliesWebhookStatus({ env, origin: requestOrigin(req, env) }),
      counters: securityCounters(),
    });
  });

  /**
   * Shared checks for both rotations: the secret must come from the disk (409 with a Norwegian
   * explanation when env wins), the admin types ROTER and re-enters the current password.
   * Returns true when the rotation may go ahead; otherwise the response is already sent.
   */
  async function rotationAllowed(req, res, holder, envMessage) {
    if (!holder || typeof confirmAdminPassword !== 'function') {
      res.status(503).json({ message: 'Rotation is not available on this hub.' });
      return false;
    }
    if (holder.source === 'env') {
      res.status(409).json({ code: 'secret-from-env', message: envMessage });
      return false;
    }
    if (!confirmWordOk(req.body)) {
      res.status(400).json({ code: 'confirm-required', message: `Skriv ${ROTATE_CONFIRM_WORD} for å bekrefte.` });
      return false;
    }
    try {
      return await confirmAdminPassword(req, res, req.body?.currentPassword);
    } catch (error) {
      res.status(500).json({ message: `Kunne ikke sjekke passordet: ${error?.code || 'error'}` });
      return false;
    }
  }

  // New token signing secret: every admin, staff and client portal token (and any OAuth state in
  // flight) signed with the old one is refused at once, in every hub process within a second.
  // The admin who pressed the button gets a fresh token.
  app.post('/api/admin/security/signing-secret/rotate', adminAuth, async (req, res) => {
    noStore(res);
    if (!(await rotationAllowed(req, res, adminSecretHolder, SIGNING_SECRET_FROM_ENV_MESSAGE))) return undefined;
    const by = adminLabel(req);
    try {
      adminSecretHolder.rotate();
    } catch (error) {
      return res.status(500).json({ message: `Kunne ikke lage en ny nøkkel: ${error?.code || 'error'}` });
    }
    const audit = auditSecretRotation(recordRotation, 'admin-secret', by, {
      counter: 'admin-secret-rotated',
      logLine: `[security] token signing secret rotated by ${by}; every token signed before now is refused`,
    });
    return res.json({
      ok: true,
      rotatedAt: audit.at,
      auditSaved: audit.saved,
      token: signToken({ role: 'admin', username: req.admin?.username, at: Date.now() }),
    });
  });

  // New Maker callback token, shown here for the Maker .env (an admin can read the current one again
  // with GET /api/admin/system/maker-callback-token). Status callbacks and preview pushes with the
  // old token get 401 from now on (also runs that were started with it).
  app.post('/api/admin/security/maker-callback-token/rotate', adminAuth, async (req, res) => {
    noStore(res);
    if (!(await rotationAllowed(req, res, makerCallbackTokenHolder, MAKER_TOKEN_FROM_ENV_MESSAGE))) return undefined;
    const by = adminLabel(req);
    let token;
    try {
      token = makerCallbackTokenHolder.rotate();
    } catch (error) {
      return res.status(500).json({ message: `Kunne ikke lage et nytt token: ${error?.code || 'error'}` });
    }
    const audit = auditSecretRotation(recordRotation, 'maker-callback-token', by, {
      counter: 'maker-callback-token-rotated',
      logLine: `[security] Maker callback token rotated by ${by}; callbacks with the old token get 401`,
    });
    return res.json({
      ok: true,
      rotatedAt: audit.at,
      auditSaved: audit.saved,
      // Not "token": the admin UI takes a "token" field as its own new login token.
      callbackToken: token,
      envKeys: MAKER_CALLBACK_TOKEN_ENV_KEYS,
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

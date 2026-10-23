// Maker host routes (WS0.4, WS8.25). Registered from server.js with registerMakerHostRoutes(app, {...}),
// so server.js only gains an import and one call.
//
// Superadmin (adminAuth):
//   GET    /api/admin/maker-hosts                 list (no hashes), scopes, legacy token source, counters
//   POST   /api/admin/maker-hosts {label, scopes?, ownerAccountKey?}
//                                                 → 201 { hostId, token, ... }; the token is shown once
//   DELETE /api/admin/maker-hosts/:hostId         revoke (the token gets 401 from then on)
//   GET    /api/admin/maker-hosts/access-log      Maker access log rows (ids only)
// Maker (host token with scope 'jobs'):
//   POST   /api/maker/hosts/heartbeat {runIds, capabilities, version, makerPort}
//                                                 → { pollAfterMs, hubCapabilities, hubLoopLastTickAt }
import { MAKER_HOST_ID_RE, MAKER_HOST_SCOPES, createMakerHost, listMakerHosts, revokeMakerHost } from '../../data/maker-hosts.js';
import { readSecuritySettings } from '../../data/security-settings.js';
import { readMakerAccessLog } from '../maker-access-log.js';
import { DEFAULT_POLL_AFTER_MS, createHostHeartbeatStore, readHubLoopLastTickAt, recordHostHeartbeat } from '../maker-host-meta.js';

/** Maker env variables that hold a host token, per hub target (website-maker lib/hub-target.js). */
export const MAKER_HOST_TOKEN_ENV = Object.freeze({ prod: 'MAKER_HUB_TOKEN', local: 'MAKER_LOCAL_HUB_TOKEN' });

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function adminLabel(req) {
  return `admin:${String(req.admin?.username || '').slice(0, 60)}`;
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/**
 * deps:
 *   adminAuth          the hub admin middleware
 *   makerAuth          createMakerAuth() result (lib/maker-auth.js)
 *   getDataDir()       the hub data dir (optional; defaults inside the stores)
 *   heartbeatStore     createHostHeartbeatStore() (optional; one is made here)
 *   hubCapabilities()  capability strings this hub offers Makers (default none yet)
 *   pollAfterMs()      the poll interval handed to Makers (default 30 s)
 */
export function registerMakerHostRoutes(app, {
  adminAuth,
  makerAuth,
  getDataDir = null,
  heartbeatStore = null,
  hubCapabilities = () => [],
  pollAfterMs = () => DEFAULT_POLL_AFTER_MS,
} = {}) {
  if (!adminAuth || !makerAuth) throw new Error('registerMakerHostRoutes: missing deps');
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);
  const heartbeats = heartbeatStore || createHostHeartbeatStore({ dataDir: dataDir() });

  app.get('/api/admin/maker-hosts', adminAuth, (_req, res) => {
    noStore(res);
    const beats = heartbeats.read();
    const hosts = listMakerHosts({ dataDir: dataDir() }).map((host) => ({
      ...host,
      lastHeartbeatAt: beats[host.hostId]?.lastHeartbeatAt || null,
      heartbeats: beats[host.hostId]?.heartbeats || 0,
    }));
    const status = makerAuth.status();
    res.json({
      hosts,
      scopes: MAKER_HOST_SCOPES,
      tokenEnv: MAKER_HOST_TOKEN_ENV,
      legacyTokenSource: status.legacyTokenSource,
      failures: status.failures,
      counters: readSecuritySettings({ dataDir: dataDir() }).counters,
    });
  });

  app.post('/api/admin/maker-hosts', adminAuth, (req, res) => {
    noStore(res);
    const body = bodyOf(req);
    const by = adminLabel(req);
    try {
      const { host, token } = createMakerHost(
        { label: body.label, scopes: body.scopes, ownerAccountKey: body.ownerAccountKey, createdBy: by },
        { dataDir: dataDir() }
      );
      console.log(`[maker-hosts] host ${host.hostId} (${host.scopes.join(', ')}) created by ${by}`);
      return res.status(201).json({ ok: true, hostId: host.hostId, tokenPrefix: host.tokenPrefix, token, host, tokenEnv: MAKER_HOST_TOKEN_ENV });
    } catch (error) {
      if (['label-required', 'scopes-required', 'bad-owner', 'too-many-hosts'].includes(error?.code)) {
        return res.status(400).json({ message: error.message, code: error.code });
      }
      return res.status(500).json({ message: `Could not create the Maker host: ${error?.code || 'error'}` });
    }
  });

  app.delete('/api/admin/maker-hosts/:hostId', adminAuth, (req, res) => {
    noStore(res);
    const hostId = String(req.params.hostId || '');
    if (!MAKER_HOST_ID_RE.test(hostId)) return res.status(404).json({ message: 'No such Maker host.' });
    const by = adminLabel(req);
    try {
      const host = revokeMakerHost(hostId, { dataDir: dataDir(), by });
      if (!host) return res.status(404).json({ message: 'No such Maker host.' });
      console.log(`[maker-hosts] host ${hostId} revoked by ${by}`);
      return res.json({ ok: true, host });
    } catch (error) {
      return res.status(500).json({ message: `Could not revoke the Maker host: ${error?.code || 'error'}` });
    }
  });

  app.get('/api/admin/maker-hosts/access-log', adminAuth, (req, res) => {
    noStore(res);
    res.json({
      rows: readMakerAccessLog({
        dataDir: dataDir(),
        limit: Number(req.query?.limit) || 200,
        hostId: String(req.query?.hostId || ''),
        clientId: String(req.query?.clientId || ''),
      }),
    });
  });

  app.post('/api/maker/hosts/heartbeat', makerAuth.requireMakerHost('jobs', { hostOnly: true }), (req, res) => {
    noStore(res);
    const hostId = req.makerAuth.hostId;
    let result;
    try {
      result = recordHostHeartbeat(hostId, bodyOf(req), { dataDir: dataDir() });
    } catch (error) {
      return res.status(500).json({ message: `Could not store the heartbeat: ${error?.code || 'error'}` });
    }
    if (!result) return res.status(401).json({ message: 'Unauthorized callback.' });
    heartbeats.note(hostId, { changed: result.changed });
    let capabilities = [];
    try {
      capabilities = (hubCapabilities() || []).map(String);
    } catch {
      capabilities = [];
    }
    return res.json({
      ok: true,
      hostId,
      changed: result.changed,
      ...(result.ignoredHandlers.length ? { ignoredHandlers: result.ignoredHandlers } : {}),
      pollAfterMs: Number(pollAfterMs()) || DEFAULT_POLL_AFTER_MS,
      hubCapabilities: capabilities,
      hubLoopLastTickAt: readHubLoopLastTickAt({ dataDir: dataDir() }),
    });
  });

  return { heartbeatStore: heartbeats };
}

// Change-request routes. The switch is checked first: while changeRequests is off or paused every
// route answers 404 {code:'disabled'} and writes nothing.
//
//   POST /api/hub/change-requests                 site credential or the public site key
//   GET  /api/hub/change-requests                 credential: the list; key only: the quota
//   GET  /api/admin/change-requests               admin, or a developer (clients they can see)
//   PATCH /api/admin/change-requests/:id          admin, or a developer who may work on the client now
//   POST /api/admin/sales/:id/change-requests     admin or a developer who can see the client
import { getAutomationSettings } from '../../data/automation-settings.js';
import { changeRequestIntakeAnswer } from '../delivery-lifecycle.js';
import { canWorkDevelopmentClient, developmentItemVisible } from '../developer-assignment.js';
import { siteCredentialState, siteCredentialStore } from '../site-credentials.js';
import {
  MAX_INTAKE_BYTES,
  applyChangeAction,
  changeRequestsEnabled,
  createChangeRequest,
  getChangeRequest,
  listForClient,
  listItem,
  parseIntake,
  quotaFor,
  readChangeRequests,
  recordView,
} from '../change-requests.js';

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function header(req, name) {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name];
  return text(value, 300);
}

function fail(res, status, code, extra = {}) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ ok: false, code, ...extra });
}

function dataDirOf(getDataDir) {
  return typeof getDataDir === 'function' ? getDataDir() : undefined;
}

function switchOn(dataDir) {
  try {
    return changeRequestsEnabled(getAutomationSettings({ dataDir }));
  } catch {
    return false;
  }
}

function tooLarge(req) {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > MAX_INTAKE_BYTES) return true;
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_INTAKE_BYTES;
  } catch {
    return false;
  }
}

function actorOf(req) {
  const user = req.developmentUser || {};
  return text(user.username || user.email || user.accountKey || 'staff', 120);
}

function clientIdOfSite(site) {
  return text(site?.planSource?.salesClientId || site?.salesClientId, 80);
}

/** 'ok', 'not-found' or 'forbidden' for a developer or admin. */
function staffAccess(user, client, { work = false } = {}) {
  if (!client) return 'not-found';
  if (user?.isAdmin || text(user?.role).toLowerCase() === 'admin') return 'ok';
  if (!developmentItemVisible(user, client)) return 'not-found';
  if (work && !canWorkDevelopmentClient(user, client)) return 'forbidden';
  return 'ok';
}

/**
 * @param {import('express').Express} app
 * @param {{ salesOrDevelopmentAuth: Function, hub: { getSiteByKey: Function }, sales: { getSalesClientById: Function }, getDataDir?: Function, credentialStore?: object }} deps
 */
export function register(app, deps = {}) {
  const { salesOrDevelopmentAuth, hub, sales } = deps;
  if (typeof salesOrDevelopmentAuth !== 'function' || typeof hub?.getSiteByKey !== 'function' || typeof sales?.getSalesClientById !== 'function') {
    throw new Error('change-request-routes: salesOrDevelopmentAuth, hub.getSiteByKey and sales.getSalesClientById are required');
  }
  const dir = () => dataDirOf(deps.getDataDir);
  const credentials = () => deps.credentialStore || siteCredentialStore();

  function closedAnswer(client) {
    const answer = changeRequestIntakeAnswer(client, { settings: getAutomationSettings({ dataDir: dir() }) });
    return answer && answer.open === false ? answer : null;
  }

  function requireStaff(req, res) {
    if (!req.developmentUser && !req.salesUser) {
      fail(res, 401, 'unauthorized');
      return false;
    }
    if (!req.developmentUser) {
      fail(res, 403, 'forbidden');
      return false;
    }
    return true;
  }

  function cmsAuth(req, res) {
    const siteKey = header(req, 'x-site-key');
    const credential = header(req, 'x-site-credential');
    if (!siteKey && !credential) return { error: fail(res, 401, 'unauthorized') };
    const site = siteKey ? hub.getSiteByKey(siteKey) : null;
    if (!site?.id) return { error: fail(res, 404, 'unknown-site') };
    const state = siteCredentialState(req, site, { store: credentials(), res });
    if (state === 'invalid' || state === 'revoked') return { error: fail(res, 401, 'unauthorized') };
    if (state === 'unavailable') return { error: fail(res, 503, 'credential-store-unavailable') };
    const clientId = clientIdOfSite(site);
    const client = clientId ? sales.getSalesClientById(clientId) : null;
    if (!client) return { error: fail(res, 404, 'not-found') };
    const sourceVerified = state === 'valid';
    return { site, siteKey, client, sourceVerified };
  }

  async function intake(res, { fields, client, siteKey, source, sourceVerified, requestedBy }) {
    const closed = closedAnswer(client);
    if (closed) return fail(res, 409, closed.code, { message: closed.message });
    const result = await createChangeRequest({
      fields,
      salesClientId: client.id,
      siteKey,
      source,
      sourceVerified,
      requestedBy,
      client,
      dataDir: dir(),
    });
    res.set('Cache-Control', 'no-store');
    return res.status(result.status).json(result.body);
  }

  app.post('/api/hub/change-requests', async (req, res) => {
    if (!switchOn(dir())) return fail(res, 404, 'disabled');
    if (tooLarge(req)) return fail(res, 413, 'too-large');
    const auth = cmsAuth(req, res);
    if (auth.error) return auth.error;
    const parsed = parseIntake(bodyOf(req));
    if (parsed.field) return fail(res, 400, 'bad-request', { field: parsed.field });
    const requestedBy = auth.sourceVerified ? 'cms:admin' : 'cms:public';
    return intake(res, { fields: parsed.value, client: auth.client, siteKey: auth.siteKey, source: 'cms', sourceVerified: auth.sourceVerified, requestedBy });
  });

  app.get('/api/hub/change-requests', (req, res) => {
    if (!switchOn(dir())) return fail(res, 404, 'disabled');
    const auth = cmsAuth(req, res);
    if (auth.error) return auth.error;
    const limit = listLimit(req.query?.limit);
    if (limit === null) return fail(res, 400, 'bad-request', { field: 'limit' });
    const quota = quotaFor(auth.client, { dataDir: dir() });
    res.set('Cache-Control', 'no-store');
    if (!auth.sourceVerified) return res.json({ ok: true, items: [], itemsHidden: true, quota });
    const items = listForClient(auth.client.id, { dataDir: dir() }).slice(0, limit).map(listItem);
    return res.json({ ok: true, items, quota });
  });

  const staffGate = (req, res, next) => (switchOn(dir()) ? salesOrDevelopmentAuth(req, res, next) : fail(res, 404, 'disabled'));

  app.get('/api/admin/change-requests', staffGate, (req, res) => {
    if (!requireStaff(req, res)) return undefined;
    const clientId = text(req.query?.clientId, 80);
    const status = text(req.query?.status, 40);
    const user = req.developmentUser;
    if (clientId) {
      const client = sales.getSalesClientById(clientId);
      const access = staffAccess(user, client);
      if (access === 'not-found') return fail(res, 404, 'not-found');
    }
    const rows = readChangeRequests(dir()).filter((row) => !status || row.status === status);
    const visible = rows.filter((row) => {
      const client = sales.getSalesClientById(row.salesClientId);
      if (clientId && row.salesClientId !== clientId) return false;
      return staffAccess(user, client) === 'ok';
    });
    visible.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
    const quotaByClient = {};
    for (const row of visible) {
      if (quotaByClient[row.salesClientId]) continue;
      const client = sales.getSalesClientById(row.salesClientId);
      quotaByClient[row.salesClientId] = quotaFor(client, { dataDir: dir() });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, items: visible.map((row) => recordView(row)), quotaByClient });
  });

  app.patch('/api/admin/change-requests/:id', staffGate, async (req, res) => {
    if (!requireStaff(req, res)) return undefined;
    const id = text(req.params.id, 80);
    const current = getChangeRequest(id, { dataDir: dir() });
    if (!current) return fail(res, 404, 'not-found');
    const client = sales.getSalesClientById(current.salesClientId);
    const access = staffAccess(req.developmentUser, client, { work: true });
    if (access === 'not-found') return fail(res, 404, 'not-found');
    if (access === 'forbidden') return fail(res, 403, 'forbidden');
    const closed = closedAnswer(client);
    const action = bodyOf(req).action;
    if (closed && (action === 'accept' || action === 'start')) return fail(res, 409, closed.code, { message: closed.message });
    const result = await applyChangeAction(id, bodyOf(req), { dataDir: dir(), by: actorOf(req), client });
    if (!result.ok) return fail(res, result.status, result.code, result.field ? { field: result.field } : {});
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, request: recordView(result.request), quota: result.quota });
  });

  app.post('/api/admin/sales/:id/change-requests', staffGate, async (req, res) => {
    if (!requireStaff(req, res)) return undefined;
    if (tooLarge(req)) return fail(res, 413, 'too-large');
    const client = sales.getSalesClientById(text(req.params.id, 80));
    const access = staffAccess(req.developmentUser, client);
    if (access === 'not-found') return fail(res, 404, 'not-found');
    if (access === 'forbidden') return fail(res, 403, 'forbidden');
    const body = bodyOf(req);
    if (body.source !== 'admin') return fail(res, 400, 'bad-request', { field: 'source' });
    const parsed = parseIntake(body);
    if (parsed.field) return fail(res, 400, 'bad-request', { field: parsed.field });
    return intake(res, {
      fields: parsed.value,
      client,
      siteKey: text(client.hubSite?.siteKey || client.siteKey, 200),
      source: 'admin',
      sourceVerified: true,
      requestedBy: actorOf(req),
    });
  });
}

function listLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) return null;
  return value;
}

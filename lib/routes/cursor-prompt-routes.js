/**
 * Developer prompt for one client run. Registered through lib/routes/optional-routes.js.
 *
 * While `iteration.cursorPrompt` is off (or paused) the route answers 404 {code:'disabled'}
 * before auth, and writes nothing. On: no credentials is 401, a sales-only role is 403,
 * and developmentAuth (admin or developer) is 200 {prompt}.
 */
import { getAutomationSettings } from '../../data/automation-settings.js';
import { developmentItemVisible } from '../developer-assignment.js';
import { getThread } from '../admin-dev-requests.js';
import { buildCursorPrompt } from '../cursor-prompt.js';
import { listForClient } from '../change-requests.js';
import { readLatestBrief } from '../delivery-brief/store.js';

function cursorPromptOn(settings) {
  const node = settings?.iteration?.cursorPrompt;
  return Boolean(node && node.enabled === true && !node.paused);
}

function capture() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ developmentAuth: Function, salesAuth: Function, sales: object, getDataDir?: () => string }} deps
 */
export function register(app, deps = {}) {
  const { developmentAuth, salesAuth, sales, getDataDir } = deps;

  function settings() {
    const dataDir = typeof getDataDir === 'function' ? getDataDir() : undefined;
    return getAutomationSettings({ dataDir });
  }

  function guard(req, res, next) {
    if (!cursorPromptOn(settings())) {
      res.status(404).json({ code: 'disabled' });
      return;
    }
    if (typeof developmentAuth !== 'function') {
      res.status(401).json({ code: 'unauthorized' });
      return;
    }
    let allowed = false;
    developmentAuth(req, capture(), () => { allowed = true; });
    if (allowed && req.developmentUser) {
      next();
      return;
    }
    const finish = () => {
      if (req.salesUser && req.salesUser.role === 'sales' && req.salesUser.isAdmin !== true) {
        res.status(403).json({ code: 'forbidden' });
        return;
      }
      res.status(401).json({ code: 'unauthorized' });
    };
    if (typeof salesAuth !== 'function') {
      finish();
      return;
    }
    Promise.resolve(salesAuth(req, capture(), () => {})).then(finish, finish);
  }

  app.get('/api/admin/development/:id/cursor-prompt', guard, (req, res) => {
    const client = sales?.getSalesClientById?.(req.params.id) || null;
    if (!client || !developmentItemVisible(req.developmentUser, client)) {
      res.status(404).json({ code: 'not-found' });
      return;
    }
    const dataDir = typeof getDataDir === 'function' ? getDataDir() : undefined;
    let brief = null;
    try {
      brief = readLatestBrief(client.id, { dataDir });
    } catch {
      brief = null;
    }
    let changeRequests = [];
    try {
      changeRequests = listForClient(client.id, { dataDir });
    } catch {
      changeRequests = [];
    }
    let threadAsks = [];
    try {
      const thread = getThread(client.id);
      threadAsks = Array.isArray(thread?.messages) ? thread.messages : [];
    } catch {
      threadAsks = [];
    }
    const prompt = buildCursorPrompt({
      client,
      runId: client.makerRun?.runId || '',
      tier: client.sitePlan?.tierId || client.portalTierId || '',
      services: client.sitePlan?.services || [],
      directives: Array.isArray(brief?.directives) ? brief.directives : [],
      changeRequests,
      threadAsks,
    });
    res.json({ prompt });
  });
}

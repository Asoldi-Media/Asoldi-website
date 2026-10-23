/**
 * AI admin endpoints (Superadmin, adminAuth):
 *
 *   GET /api/admin/ai/status[?probe=1]   profile and its source, overrides, providers (key set, dead; probe
 *                                        only on request), per-task routes with the prod shadow route, spend
 *   GET /api/admin/ai/spend?from&to&by=task|client|provider|model|run&salesClientId=
 *                                        hub ledger totals; with salesClientId also the Maker's run spend
 *   PUT /api/admin/ai/routes             body { profile?, profiles? } -> <dataDir>/ai-routes.override.json
 *                                        (validated against the shared registry and prices; no env change)
 */
import { hubLlm } from '../llm-hooks.js';
import { getHubLlm } from './index.js';

const BY_VALUES = new Set(['task', 'client', 'provider', 'model', 'run']);

function clean(value) {
  return String(value ?? '').trim();
}

function dateParam(value) {
  const text = clean(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerAiAdminRoutes(app, { adminAuth, sales = null, facade = () => hubLlm() || getHubLlm() } = {}) {
  if (typeof adminAuth !== 'function') throw new Error('registerAiAdminRoutes needs adminAuth');

  app.get('/api/admin/ai/status', adminAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const probe = ['1', 'true', 'yes'].includes(clean(req.query?.probe).toLowerCase());
      res.json(await facade().status({ probe }));
    } catch (error) {
      res.status(500).json({ message: clean(error?.message) || 'AI status failed.' });
    }
  });

  app.get('/api/admin/ai/spend', adminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const from = dateParam(req.query?.from);
    const to = dateParam(req.query?.to);
    if (from === undefined || to === undefined) return res.status(400).json({ message: 'from and to must be dates (ISO 8601).' });
    const by = clean(req.query?.by) || 'task';
    if (!BY_VALUES.has(by)) return res.status(400).json({ message: `by must be one of ${[...BY_VALUES].join(', ')}.` });
    const salesClientId = clean(req.query?.salesClientId).slice(0, 200);
    try {
      const result = facade().spend({ from: from || monthStart(), to: to || new Date(), by, salesClientId });
      if (salesClientId && sales?.getSalesClientById) {
        // The client's current run, when the per-run history does not have it yet.
        const current = sales.getSalesClientById(salesClientId)?.makerRun?.aiSpend;
        if (current?.runId && result.maker && !result.maker.runs.some((run) => run.runId === current.runId)) {
          result.maker.runs.push(current);
          result.maker.totalUsd = Math.round((result.maker.totalUsd + (Number(current.totalUsd) || 0)) * 1e10) / 1e10;
          for (const [task, usd] of Object.entries(current.byTask || {})) result.maker.byTask[task] = Math.round(((result.maker.byTask[task] || 0) + (Number(usd) || 0)) * 1e10) / 1e10;
          result.totalUsd = Math.round((result.hub.totalUsd + result.maker.totalUsd) * 1e10) / 1e10;
        }
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: clean(error?.message) || 'AI spend failed.' });
    }
  });

  app.put('/api/admin/ai/routes', adminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return res.status(400).json({ message: 'Send a JSON object: { profile?, profiles? }.' });
    try {
      const result = facade().setRoutesOverride(body, { by: clean(req.admin?.username || req.admin?.sub || 'admin') });
      if (!result.ok) return res.status(400).json({ message: 'The routes override is not valid.', errors: result.errors });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: clean(error?.message) || 'Could not save the routes override.' });
    }
  });
}

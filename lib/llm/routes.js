/**
 * AI admin endpoints (Superadmin, adminAuth):
 *
 *   GET /api/admin/ai/status[?probe=1]   profile and its source, overrides, providers (key set, dead; probe
 *                                        only on request), per-task routes with the prod shadow route, spend
 *   GET /api/admin/ai/spend?from&to&by=task|client|provider|model|run&salesClientId=
 *                                        hub ledger totals; with salesClientId also the Maker's run spend
 *                                        (runs whose newest snapshot `at` is in the range; default: this month)
 *   PUT /api/admin/ai/routes             body { profile?, profiles?, facade? } -> <dataDir>/ai-routes.override.json
 *                                        (validated against the shared registry and prices; no env change).
 *                                        Profiles: legacy or prod (test/replay/record only in safe mode or a
 *                                        local run with AI_PROFILE). `facade: false` is the data-dir off switch.
 *                                        409 for a profile change while the call sites do not use the facade.
 */
import { hubLlmRegistered } from '../llm-hooks.js';
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

export function registerAiAdminRoutes(app, {
  adminAuth,
  sales = null,
  registered = () => hubLlmRegistered(),
  facade = () => registered() || getHubLlm(),
} = {}) {
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
      // The client's current run counts only when its snapshot time is in the range and the per-run
      // history has no row for it (ledger.makerSpendFor).
      const currentMakerRun = salesClientId && sales?.getSalesClientById ? sales.getSalesClientById(salesClientId)?.makerRun?.aiSpend || null : null;
      res.json(facade().spend({ from: from || monthStart(), to: to || new Date(), by, salesClientId, currentMakerRun }));
    } catch (error) {
      res.status(500).json({ message: clean(error?.message) || 'AI spend failed.' });
    }
  });

  app.put('/api/admin/ai/routes', adminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return res.status(400).json({ message: 'Send a JSON object: { profile?, profiles?, facade? }.' });
    try {
      const target = facade();
      // HUB_LLM_FACADE=0: no call site uses the facade, so a profile saved now would not change any call.
      if (!registered() && body.profile && String(body.profile) !== target.profile()) {
        return res.status(409).json({
          message: 'The LLM facade is off on this hub (HUB_LLM_FACADE=0): call sites send their requests directly, so a profile change would have no effect.',
          errors: ['facade not registered'],
        });
      }
      const result = target.setRoutesOverride(body, { by: clean(req.admin?.username || req.admin?.sub || 'admin') });
      if (!result.ok) {
        const conflict = result.code === 'facade_off';
        return res.status(conflict ? 409 : 400).json({ message: conflict ? result.errors[0] : 'The routes override is not valid.', errors: result.errors });
      }
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: clean(error?.message) || 'Could not save the routes override.' });
    }
  });
}

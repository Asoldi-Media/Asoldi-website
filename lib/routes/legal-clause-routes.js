// Processor clause route for client CMS sites. Registered through lib/routes/optional-routes.js.
//
//   GET /api/hub/legal/clauses?language=nb|en&features=<comma list of effective feature keys>
//
// Gives a client CMS the clauses in which Asoldi appears as processor (lib/legal/processor-clauses.js),
// for the privacy page the CMS generates. The CMS reads them at generation time and caches the last
// answer.
//
// While the legalClauses switch is off (the default) or paused the route answers 404 { code: 'disabled' }
// before any credential check, and nothing is read or written; a CMS treats that like offline. Otherwise
// the call needs the site credential (the x-site-credential header of the enrolled site) next to the
// site key; the site key alone is not enough, whatever the site's CMS version. Anything else is refused by
// lib/site-credentials.js (401 for an unknown site, a missing, wrong or revoked credential).
//   200 { ok: true, mode: 'shadow' | 'auto', version, dpaVersion, language, clauses[], subprocessors[], hash }
// In shadow mode the answer is marked so: a CMS shows it in its admin preview only.
// No state changes on any answer.
import * as hubData from '../../data/hub.js';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { processorClausesFor, PROCESSOR_LANGUAGES } from '../legal/processor-clauses.js';
import { requireSiteCredential } from '../site-credentials.js';

const FEATURE_RE = /^[A-Za-z][A-Za-z0-9.]{0,60}$/;
const MAX_FEATURES = 200;

function clauseSwitch(settings) {
  const node = settings?.legalClauses;
  if (!node || node.enabled !== true || (node.paused && typeof node.paused === 'object')) return null;
  return { mode: node.mode === 'auto' ? 'auto' : 'shadow' };
}

function readSettings(getSettings) {
  try {
    return getSettings();
  } catch {
    return null;
  }
}

/** The feature keys of a query value: well-formed, unique, at most MAX_FEATURES. */
export function parseFeatures(value) {
  const out = [];
  for (const part of String(value ?? '').split(',')) {
    const key = part.trim();
    if (FEATURE_RE.test(key) && !out.includes(key)) out.push(key);
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

export function register(app, { getSiteByKey = (key) => hubData.getSiteByKey(key), settings = getAutomationSettings, credentialAuth = null } = {}) {
  const auth = credentialAuth || requireSiteCredential({ getSiteByKey, policy: 'always' });
  const gate = (req, res, next) => {
    if (!clauseSwitch(readSettings(settings))) return res.status(404).json({ code: 'disabled' });
    return next();
  };
  app.get('/api/hub/legal/clauses', gate, auth, (req, res) => {
    const state = clauseSwitch(readSettings(settings));
    if (!state) return res.status(404).json({ code: 'disabled' });
    const language = PROCESSOR_LANGUAGES.includes(String(req.query.language)) ? String(req.query.language) : 'nb';
    const current = readSettings(settings) || {};
    const answer = processorClausesFor({
      features: parseFeatures(req.query.features),
      language,
      params: { changeMonths: Number(current.retention?.changeRequestsMonths) || 24 },
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, mode: state.mode, ...answer });
  });
}

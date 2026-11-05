// Automation promotion routes. Registered through lib/routes/optional-routes.js.
//
// Superadmin (adminAuth):
//   GET  /api/admin/automation/promotion     the promotion dashboard (lib/automation-promotion.js):
//                                            per release-gated switch its release pass, stored and
//                                            effective mode, what keeps it from auto, and the mail
//                                            guard counters; the guard trips; the release key id
//   POST /api/admin/automation/release-pass  {report, switchId?}: checks the signed release suite
//                                            report (schema, digest, this hub's release key, at most
//                                            14 days old) and records a release pass for every
//                                            switch it passed, or only for switchId
//   PUT  /api/admin/automation/release-key   {key}: installs the release key (64 hex characters)
//                                            this hub checks reports with; answers its key id only
//
// While no client is a pilot and no release pass is recorded, every route answers 404
// {code:'disabled'} before the sign-in check, so a hub without pilots answers as it did before.
import { getAutomationSettings, recordReleasePass } from '../../data/automation-settings.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import { promotionRoutesOpen, promotionView } from '../automation-promotion.js';
import {
  passedSwitches,
  readReleaseKeyFile,
  releaseKeyPath,
  reportEvidence,
  verifyReleaseReport,
  writeReleaseKeyFile,
} from '../release-suite.js';

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

export function register(app, deps = {}) {
  const { adminAuth, getDataDir } = deps;
  if (!adminAuth) throw new Error('promotion-routes: missing deps');
  const dataDir = () => (typeof getDataDir === 'function' ? getDataDir() : undefined);

  const open = (_req, res, next) => {
    let settings = null;
    try {
      settings = getAutomationSettings({ dataDir: dataDir() });
    } catch {
      settings = null;
    }
    if (promotionRoutesOpen(settings)) return next();
    noStore(res);
    return res.status(404).json({ code: 'disabled', message: 'Not available.' });
  };
  const by = (req) => `admin:${text(req.admin?.username, 100) || 'superadmin'}`;

  app.get('/api/admin/automation/promotion', open, adminAuth, (_req, res) => {
    noStore(res);
    res.json(promotionView({ dataDir: dataDir() }));
  });

  app.post('/api/admin/automation/release-pass', open, adminAuth, (req, res) => {
    noStore(res);
    const body = bodyOf(req);
    const report = body.report;
    const key = readReleaseKeyFile(releaseKeyPath({ dataDir: dataDir() }));
    const verdict = verifyReleaseReport(report, { key });
    if (!verdict.ok) {
      return res.status(verdict.signature === 'no-key' ? 409 : 422).json({ code: verdict.signature === 'no-key' ? 'no-release-key' : 'report-refused', problems: verdict.problems, signature: verdict.signature });
    }
    const passed = passedSwitches(report);
    const wanted = text(body.switchId, 80);
    if (wanted && !passed.includes(wanted)) {
      return res.status(422).json({ code: 'not-passed', message: `The report does not pass ${wanted}.`, passed });
    }
    const ids = wanted ? [wanted] : passed;
    if (!ids.length) return res.status(422).json({ code: 'nothing-passed', message: 'The report passes no release-gated switch.', passed });
    const recorded = [];
    for (const id of ids) {
      const result = recordReleasePass(id, {
        suite: text(report.suite, 80) || 'release-suite',
        evidence: reportEvidence(report),
        by: by(req),
        dataDir: dataDir(),
      });
      if (!result.ok) return res.status(400).json({ code: 'record-failed', message: result.error || 'The pass was not recorded.', recorded });
      recorded.push({ switchId: id, promotion: result.promotion || 'off' });
    }
    res.json({ recorded, promotion: promotionView({ dataDir: dataDir() }) });
  });

  app.put('/api/admin/automation/release-key', open, adminAuth, (req, res) => {
    noStore(res);
    try {
      const { keyId } = writeReleaseKeyFile(releaseKeyPath({ dataDir: dataDir() }), bodyOf(req).key);
      appendDeliveryAudit({ kind: 'release-key', by: by(req), reason: `release key ${keyId} installed` }, { dataDir: dataDir() });
      return res.json({ installed: true, keyId });
    } catch (error) {
      if (error?.code === 'bad-key') return res.status(400).json({ code: 'bad-key', message: error.message });
      return res.status(500).json({ message: 'The release key was not stored.' });
    }
  });
}

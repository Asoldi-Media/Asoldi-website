// Automation promotion: signed release suite reports, the promotion routes (dark while no client is a
// pilot and no pass is recorded), and the runtime mail guards that pause a kind and raise an alert.
// Real data modules on a temp data dir behind a fake adminAuth; mail goes to a spy, never a transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-promotion-'));
process.env.APP_DATA_DIR = DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(HUB_SAFE_MODE|WORKSHOP_DESK_EMAIL_AUTOSEND)/.test(key)) delete process.env[key];

const express = (await import('express')).default;
const { register } = await import('../lib/routes/promotion-routes.js');
const settingsStore = await import('../data/automation-settings.js');
const suite = await import('../lib/release-suite.js');
const guards = await import('../lib/delivery-guards.js');
const promotionLib = await import('../lib/automation-promotion.js');
const emails = await import('../lib/delivery-emails.js');
const alerts = await import('../lib/delivery-alerts.js');
const { VOCAB_VERSION } = await import('../packages/suite/core/delivery/vocab.js');

const SETTINGS_FILE = join(DATA_DIR, 'automation-settings.json');
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const NOW = Date.parse('2026-11-05T10:00:00.000Z');

function writeSettings(patch) {
  const base = settingsStore.defaultAutomationSettings();
  const merged = { ...base, ...patch, emails: { ...base.emails, ...(patch.emails || {}) } };
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  settingsStore.invalidateAutomationSettingsCache();
}

function resetData() {
  for (const name of ['automation-settings.json', 'delivery-hot', 'delivery-audit', 'secrets', 'outbox', 'delivery-email-shadow.json']) {
    rmSync(join(DATA_DIR, name), { recursive: true, force: true });
  }
  settingsStore.invalidateAutomationSettingsCache();
  alerts.resetDeliveryAlertsMemoryForTests();
}

function report(switches, { createdAt = new Date().toISOString(), key = KEY } = {}) {
  return suite.signReleaseReport({
    schema: suite.RELEASE_REPORT_SCHEMA,
    createdAt,
    suite: 'delivery-e2e',
    code: { commit: '0123456789abcdef', vocabVersion: VOCAB_VERSION },
    profile: 'replay',
    clients: 4,
    switches,
    metrics: {},
  }, key);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
const adminAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer admin') return res.status(401).json({ message: 'Unauthorized' });
  req.admin = { username: 'superadmin' };
  next();
};
register(app, { adminAuth, getDataDir: () => DATA_DIR });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function call(method, path, body, auth = 'Bearer admin') {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ROUTES = [
  ['GET', '/api/admin/automation/promotion'],
  ['POST', '/api/admin/automation/release-pass'],
  ['PUT', '/api/admin/automation/release-key'],
];

test('report: a signed report verifies; changed content, another key, no key and an old report are refused', () => {
  const signed = report({ 'emails.postWorkshop': { status: 'pass', checks: ['outbox'], findings: [] } });
  assert.deepEqual(suite.verifyReleaseReport(signed, { key: KEY }), { ok: true, problems: [], signature: 'valid' });
  assert.deepEqual(suite.passedSwitches(signed), ['emails.postWorkshop']);
  const changed = { ...signed, switches: { ...signed.switches, signing: { status: 'pass' } } };
  const verdict = suite.verifyReleaseReport(changed, { key: KEY });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(' '), /digest does not match/);
  assert.equal(suite.verifyReleaseReport(signed, { key: OTHER_KEY }).signature, 'invalid');
  assert.equal(suite.verifyReleaseReport(signed, { key: '' }).signature, 'no-key');
  const old = report({ signing: { status: 'pass' } }, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.match(suite.verifyReleaseReport(old, { key: KEY }).problems.join(' '), /older than 14 days/);
  // Only release-gated ids count as passed.
  assert.deepEqual(suite.passedSwitches(report({ 'not.a.switch': { status: 'pass' }, gate: { status: 'fail' } })), []);
});

test('dark: with no pilot and no recorded pass every route answers 404 disabled before the sign-in check, and writes nothing', async () => {
  resetData();
  for (const [method, path] of ROUTES) {
    for (const auth of ['Bearer admin', '']) {
      const res = await call(method, path, method === 'GET' ? undefined : { key: KEY, report: report({ signing: { status: 'pass' } }) }, auth);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(await res.json(), { code: 'disabled', message: 'Not available.' });
    }
  }
  assert.equal(existsSync(SETTINGS_FILE), false, 'no settings written');
  assert.equal(existsSync(join(DATA_DIR, 'secrets')), false, 'no key written');
});

test('a pass is recorded from a signed report: superadmin only, key required, promotion only to valid settings', async () => {
  resetData();
  writeSettings({ pilotClientIds: ['pilot-1'] });
  for (const [method, path] of ROUTES) {
    const res = await call(method, path, method === 'GET' ? undefined : {}, '');
    assert.equal(res.status, 401, `${method} ${path} without sign-in`);
  }
  const signed = report({
    'emails.postWorkshop': { status: 'pass', checks: ['outbox'], findings: [] },
    signing: { status: 'pass', checks: ['stages'], findings: [] },
    gate: { status: 'pass', checks: ['gate'], findings: [] },
    brief: { status: 'fail', checks: ['brief'], findings: ['a directive without a quote'] },
  });
  // No release key on this hub yet: nothing is recorded.
  let res = await call('POST', '/api/admin/automation/release-pass', { report: signed });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'no-release-key');
  res = await call('PUT', '/api/admin/automation/release-key', { key: 'not-hex' });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/admin/automation/release-key', { key: KEY });
  assert.equal(res.status, 200);
  const installed = await res.json();
  assert.deepEqual(installed, { installed: true, keyId: suite.keyId(KEY) });
  // A second key does not silently replace the first (negative control: replace: true does).
  res = await call('PUT', '/api/admin/automation/release-key', { key: OTHER_KEY });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'key-exists');
  assert.equal(readFileSync(join(DATA_DIR, 'secrets', 'release-suite.key'), 'utf8').trim(), KEY);
  res = await call('PUT', '/api/admin/automation/release-key', { key: KEY, replace: true });
  assert.equal(res.status, 200);
  // A report signed with another key, and a changed report, are refused.
  res = await call('POST', '/api/admin/automation/release-pass', { report: report({ signing: { status: 'pass' } }, { key: OTHER_KEY }) });
  assert.equal(res.status, 422);
  res = await call('POST', '/api/admin/automation/release-pass', { report: { ...signed, profile: 'live' } });
  assert.equal(res.status, 422);
  // switchId must be one the report passed.
  res = await call('POST', '/api/admin/automation/release-pass', { report: signed, switchId: 'brief' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, 'not-passed');
  assert.equal(settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR }).settings.releases.brief, undefined);

  res = await call('POST', '/api/admin/automation/release-pass', { report: signed });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.recorded.map((row) => row.switchId), ['emails.postWorkshop', 'gate', 'signing']);
  const promotion = Object.fromEntries(body.recorded.map((row) => [row.switchId, row.promotion]));
  // gate offers only shadow for now, so its pass is recorded without a promotion.
  assert.deepEqual(promotion, { 'emails.postWorkshop': 'promoted', gate: 'refused', signing: 'promoted' });
  const { settings, audit } = settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR });
  assert.equal(settings.releases.signing.suite, 'delivery-e2e');
  assert.match(settings.releases.signing.evidence, new RegExp(`report ${signed.digest.slice(0, 16)}; key ${suite.keyId(KEY)}`));
  assert.equal(settings.releases.signing.by, 'admin:superadmin');
  assert.equal(settings.signing.mode, 'auto');
  assert.equal(settings.signing.enabled, false, 'promotion never switches a switch on');
  assert.equal(settings.gate.mode, 'shadow');
  assert.equal(settings.releases.brief, undefined, 'a failed switch gets no pass');
  assert.ok(audit.some((entry) => entry.source === 'release' && /delivery-e2e/.test(entry.reason)));
  // The settings stay valid for the next superadmin edit.
  assert.equal(settingsStore.validateAutomationSettings({}, { current: settings }).ok, true);

  res = await call('GET', '/api/admin/automation/promotion');
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.pilots, 1);
  assert.deepEqual(view.releaseKey, { installed: true, keyId: suite.keyId(KEY) });
  const signing = view.switches.find((row) => row.id === 'signing');
  assert.deepEqual(signing.blockers, ['disabled']);
  assert.equal(signing.spine, true);
  const brief = view.switches.find((row) => row.id === 'brief');
  assert.deepEqual(brief.blockers, ['disabled', 'mode-not-auto', 'no-release']);
});

test('a pass recorded without pilots keeps a pilot-only switch in shadow', () => {
  resetData();
  writeSettings({ pilotClientIds: [] });
  const result = settingsStore.recordReleasePass('delivery.loop', { suite: 'delivery-e2e', dataDir: DATA_DIR, now: new Date(NOW) });
  assert.equal(result.ok, true);
  assert.equal(result.promotion, 'refused');
  const { settings } = settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR });
  assert.ok(settings.releases['delivery.loop'].passedAt);
  assert.equal(settings.delivery.loop.mode, 'shadow');
  assert.equal(settingsStore.validateAutomationSettings({}, { current: settings }).ok, true);
});

// ---------------------------------------------------------------- mail guards

const CLIENT = { id: 'pilot-1', contactEmail: 'owner@example.com', businessName: 'Example Bakery AS' };

function autoSettings() {
  const base = settingsStore.defaultAutomationSettings();
  writeSettings({
    pilotClientIds: ['pilot-1'],
    emails: { ...base.emails, postWorkshop: { ...base.emails.postWorkshop, enabled: true, mode: 'auto', paused: null } },
    releases: { 'emails.postWorkshop': { passedAt: '2026-11-01T00:00:00.000Z', suite: 'delivery-e2e' } },
  });
}

function message(extra = {}) {
  return { to: 'owner@example.com', subject: 'Takk for workshopen', text: 'Hei! Her er neste steg.', ...extra };
}

async function autoSend(msg, { sent, at = NOW, key = 'k' } = {}) {
  return emails.deliverDeliveryEmail({
    kindId: 'postWorkshop',
    client: CLIENT,
    message: msg,
    mode: 'auto',
    dedupeKey: `postWorkshop:${CLIENT.id}:${key}`,
    now: at,
    dataDir: DATA_DIR,
    deps: { sendEmail: async (m) => sent.push(m), stampDeliveryEmail: () => {} },
  });
}

function pausedReason() {
  return settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR }).settings.emails.postWorkshop.paused?.reason || '';
}

function activeAlerts() {
  return alerts.readAlertState({ dataDir: DATA_DIR }).active;
}

test('guards: clean automatic sends go out and pause nothing (positive control)', async () => {
  resetData();
  autoSettings();
  const sent = [];
  for (let i = 0; i < 6; i += 1) assert.equal((await autoSend(message(), { sent, key: `ok-${i}` })).status, 'sent');
  assert.equal(sent.length, 6);
  assert.equal(pausedReason(), '');
  assert.deepEqual(Object.keys(activeAlerts()), []);
  const stats = guards.guardStats({ dataDir: DATA_DIR, now: NOW });
  assert.equal(stats.kinds.postWorkshop.sent, 6);
  assert.equal(stats.kinds.postWorkshop.verdict, null);
});

test('guards: a bounce spike pauses the kind and raises a delivery alert', async () => {
  resetData();
  autoSettings();
  const sent = [];
  for (let i = 0; i < 20; i += 1) await autoSend(message(), { sent, key: `b-${i}` });
  // 1 bounce on 20 sends is 5 %: not more than guards.bounceRatePct, nothing pauses.
  assert.equal(await guards.noteDeliveryEmailFeedback('postWorkshop', 'bounce', { dataDir: DATA_DIR, now: NOW }), null);
  assert.equal(pausedReason(), '');
  // The second bounce makes it 10 %.
  const verdict = await guards.noteDeliveryEmailFeedback('postWorkshop', 'bounce', { dataDir: DATA_DIR, now: NOW + 1000 });
  assert.equal(verdict.code, 'bounce-rate');
  assert.match(pausedReason(), /^guard bounce-rate: 2 bounces on 20 sends \(10 % > 5 %\)/);
  const { settings, audit } = settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR });
  assert.equal(settings.emails.postWorkshop.paused.by, 'guard');
  assert.ok(audit.some((entry) => entry.source === 'guard' && entry.changes.some((change) => change.path === 'emails.postWorkshop.paused')));
  // The alert is raised at once (stored), not only at the next loop tick.
  const active = activeAlerts();
  assert.ok(active['switch-paused:emails.postWorkshop'], JSON.stringify(Object.keys(active)));
  assert.match(active['switch-paused:emails.postWorkshop'].message, /guard bounce-rate/);
  // Paused: the kind's next mail is neither sent nor recorded.
  const client = { ...CLIENT };
  assert.equal(emails.deliveryEmailMode('postWorkshop', client, { settings }), 'off', 'the gate is off in this data, so the kind resolves off before paused');
  assert.equal(settingsStore.effectiveSwitchMode('emails.postWorkshop', { settings }), 'paused');
  const stats = guards.guardStats({ dataDir: DATA_DIR, now: NOW + 1000 });
  assert.equal(stats.trips.at(-1).code, 'bounce-rate');
  assert.equal(stats.trips.at(-1).paused, true);
  // The guard file holds times and types only.
  const raw = readFileSync(guards.guardsPath({ dataDir: DATA_DIR }), 'utf8');
  assert.doesNotMatch(raw, /example\.com|pilot-1|Takk/);
});

test('guards: complaints, an error rate and a volume spike each pause the kind', async () => {
  resetData();
  autoSettings();
  await guards.noteDeliveryEmailFeedback('postWorkshop', 'complaint', { dataDir: DATA_DIR, now: NOW });
  assert.equal(pausedReason(), '', 'one complaint is within guards.complaintsMax');
  const complaint = await guards.noteDeliveryEmailFeedback('postWorkshop', 'complaint', { dataDir: DATA_DIR, now: NOW });
  assert.equal(complaint.code, 'complaints');
  assert.match(pausedReason(), /^guard complaints/);

  resetData();
  autoSettings();
  const failing = [];
  const throwSend = async () => {
    throw new Error('transport down');
  };
  for (let i = 0; i < 4; i += 1) await autoSend(message(), { sent: failing, key: `ok-${i}` });
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(emails.deliverDeliveryEmail({
      kindId: 'postWorkshop', client: CLIENT, message: message(), mode: 'auto', dedupeKey: `postWorkshop:x:err-${i}`, now: NOW, dataDir: DATA_DIR,
      deps: { sendEmail: throwSend, stampDeliveryEmail: () => {} },
    }), /transport down/);
  }
  assert.match(pausedReason(), /^guard error-rate: 2 of 6 sends failed/);

  resetData();
  autoSettings();
  const day = 24 * 60 * 60 * 1000;
  // A usual volume of one mail a day for a week, then six in one day.
  for (let d = 1; d <= 7; d += 1) guards.recordGuardEvent('postWorkshop', 'sent', { dataDir: DATA_DIR, now: NOW - d * day });
  const sent = [];
  for (let i = 0; i < 5; i += 1) await autoSend(message(), { sent, key: `v-${i}` });
  assert.equal(pausedReason(), '', 'five is guards.minSample: no spike yet');
  await autoSend(message(), { sent, key: 'v-5' });
  assert.match(pausedReason(), /^guard volume-spike: 6 sends in 24 h/);
  assert.equal(sent.length, 6, 'the mail that tips the spike was already sent; the next ones are not');
});

test('guards: an empty field or a wrong recipient is not sent and pauses the kind; the right recipient is sent', async () => {
  for (const [label, msg, code] of [
    ['no subject', message({ subject: '' }), 'empty-fields'],
    ['placeholder', message({ text: 'Hei {{name}}' }), 'empty-fields'],
    ['internal address', message({ to: 'ansatte@asoldi.com' }), 'recipient-class'],
    ["another client's address", message({ to: 'someone-else@example.com' }), 'recipient-class'],
  ]) {
    resetData();
    autoSettings();
    const sent = [];
    const result = await autoSend(msg, { sent });
    assert.deepEqual(result, { status: 'guarded', reason: code }, label);
    assert.equal(sent.length, 0, `${label}: nothing reaches the transport`);
    assert.match(pausedReason(), new RegExp(`^guard ${code}`), label);
    assert.ok(activeAlerts()['switch-paused:emails.postWorkshop'], label);
  }
  // Negative control for the recipient check: the client's own address passes.
  resetData();
  autoSettings();
  const sent = [];
  assert.deepEqual(await autoSend(message({ to: 'OWNER@example.com' }), { sent }), { status: 'sent' });
  assert.equal(sent.length, 1);
  assert.equal(pausedReason(), '');
});

test('guards: shadow and manual sends are not guarded (shadow never sends; a person sends manual mails)', async () => {
  resetData();
  autoSettings();
  const sent = [];
  const manual = await emails.deliverDeliveryEmail({
    kindId: 'postWorkshop', client: CLIENT, message: message({ to: 'someone-else@example.com' }), mode: 'manual', dedupeKey: 'postWorkshop:x:manual', now: NOW, dataDir: DATA_DIR,
    deps: { sendEmail: async (m) => sent.push(m), stampDeliveryEmail: () => {} },
  });
  assert.equal(manual.status, 'sent');
  assert.equal(pausedReason(), '');
  assert.equal(existsSync(guards.guardsPath({ dataDir: DATA_DIR })), false, 'no guard state for a manual send');
});

test('no feedback feed: an e-mail kind cannot reach auto while no receiver feeds provider events (blocker, mode, and the positive control)', async () => {
  resetData();
  autoSettings();
  const emailLog = await import('../lib/email-log.js');
  const modeOf = () => emails.deliveryEmailMode('postWorkshop', CLIENT, { settings: settingsStore.getAutomationSettings({ dataDir: DATA_DIR, fresh: true }) });
  const blockersOf = () => promotionLib.promotionBlockers(settingsStore.getAutomationSettings({ dataDir: DATA_DIR, fresh: true }), 'emails.postWorkshop');
  emailLog.markEmailEventFeed(false);
  assert.ok(blockersOf().includes('no-feedback-feed'));
  assert.notEqual(modeOf(), 'auto');
  // A non-mail spine switch is not held back by the feed.
  assert.ok(!promotionLib.promotionBlockers(settingsStore.getAutomationSettings({ dataDir: DATA_DIR, fresh: true }), 'signing').includes('no-feedback-feed'));
  emailLog.markEmailEventFeed(true);
  try {
    assert.ok(!blockersOf().includes('no-feedback-feed'));
    assert.equal(blockersOf().length, 0);
  } finally {
    emailLog.markEmailEventFeed(false);
  }
});

test('release pass: a report from another vocabulary version is refused with code-mismatch and records nothing', async () => {
  resetData();
  writeSettings({ pilotClientIds: ['pilot-1'] });
  await call('PUT', '/api/admin/automation/release-key', { key: KEY });
  const sw = { signing: { status: 'pass', checks: ['stages'], findings: [] } };
  for (const vocabVersion of [VOCAB_VERSION - 1, undefined]) {
    const stale = suite.signReleaseReport({ schema: suite.RELEASE_REPORT_SCHEMA, createdAt: new Date().toISOString(), suite: 'delivery-e2e', code: { commit: '0123456789abcdef', ...(vocabVersion === undefined ? {} : { vocabVersion }) }, profile: 'replay', clients: 4, switches: sw, metrics: {} }, KEY);
    const res = await call('POST', '/api/admin/automation/release-pass', { report: stale });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'code-mismatch');
  }
  assert.equal(settingsStore.readAutomationSettingsFile({ dataDir: DATA_DIR }).settings.releases?.signing, undefined);
  // Positive control: the same report on this hub's vocabulary is accepted.
  const res = await call('POST', '/api/admin/automation/release-pass', { report: report(sw) });
  assert.equal(res.status, 200);
});

test('guards: provider events of the e-mail log reach the guard of the delivery kind (bounce pauses it; other kinds change nothing)', async () => {
  resetData();
  autoSettings();
  const emailLog = await import('../lib/email-log.js');
  const sent = [];
  const at = Date.now();
  for (let i = 0; i < 20; i += 1) await autoSend(message(), { sent, key: `p-${i}`, at });
  // Every automatic mail is logged under its delivery kind with the transport that sends it.
  assert.equal(sent[0].headers?.['X-Mailin-custom'], undefined, 'no Brevo-only header on a mail the Brevo relay does not send');
  const rows = [];
  for (const name of readdirSync(join(DATA_DIR, 'email-log'))) {
    if (!/^messages-/.test(name)) continue;
    for (const line of readFileSync(join(DATA_DIR, 'email-log', name), 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  }
  const logged = rows.filter((row) => row.kind === 'delivery:postWorkshop' && /:p-[0-9]+$/.test(row.dedupeKey));
  assert.equal(logged.length, 20);
  assert.ok(logged.every((row) => row.provider !== 'brevo'), 'logged under the real transport');
  const id = logged[0].id;
  const other = logged[1].id;
  // Negative control: a bounce for a message of another kind counts for no delivery kind.
  emailLog.appendMessage({ id: 'msg_other_kind', siteId: 'site-x', kind: 'order', status: 'accepted', to: 'a@example.com' });
  emailLog.appendEvent({ messageId: 'msg_other_kind', t: 'hardBounce' });
  emailLog.appendEvent({ messageId: 'msg_unknown', t: 'hardBounce' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(guards.guardStats({ dataDir: DATA_DIR, now: at }).kinds.postWorkshop.bounce ?? 0, 0);
  // A delivered event is not feedback.
  emailLog.appendEvent({ messageId: id, t: 'delivered' });
  // Two bounces on 20 sends (10 %) pause the kind.
  emailLog.appendEvent({ messageId: id, t: 'hardBounce' });
  emailLog.appendEvent({ messageId: other, t: 'softBounce' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(pausedReason(), /^guard bounce-rate/);
  emailLog.flushEvents();
});

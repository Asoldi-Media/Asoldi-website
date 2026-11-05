// CMS fleet monitor: enforcement proposals, flips, the staff digest, the health ping and the dark
// default. Runs the real monitor, routes and hub data modules on a temp data dir with invented sites
// (*.test domains) behind a fake adminAuth; the safe-mode outbox case is in
// scripts/cms-fleet-monitor-outbox.test.mjs (it installs safe mode).
//
// Run: node --test scripts/cms-fleet-monitor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-cms-fleet-'));
process.env.APP_DATA_DIR = DATA_DIR;
process.env.DATA_DIR = '';
process.env.PERSIST_PRODUCTION_ENV = '0';

const express = (await import('express')).default;
const hub = await import('../data/hub.js');
const monitor = await import('../lib/cms-fleet-monitor.js');
const fleetRoutes = await import('../lib/routes/cms-fleet-routes.js');
const { registerCmsFeatureRoutes } = await import('../lib/routes/cms-feature-routes.js');
const featureSettingsStore = await import('../data/cms-feature-settings.js');
const settingsStore = await import('../data/automation-settings.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');

const quiet = { warn() {}, error() {}, log() {} };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-11-10 09:00 in Oslo (UTC+1 in November).
const NOW = Date.parse('2026-11-10T08:00:00.000Z');
const STATE_FILE = join(DATA_DIR, monitor.CMS_FLEET_FILE);
const SITES_FILE = join(DATA_DIR, 'sites.json');
const SERVED = ['fa', 'fb', 'fc', 'fe', 'fg', 'fh', 'fk', 'fo', 'fw1', 'fw2', 'fw3', 'fw4'];
const noLease = async () => ({ async release() {} });

function osloDayOf(ms) {
  return monitor.osloDay(ms);
}

/** Seven clean days (count 0) ending on the Oslo day of `base`. */
function cleanWeek(base) {
  return Array.from({ length: 7 }, (_, i) => ({ date: osloDayOf(base - (6 - i) * DAY), count: 0, top: [] }));
}

function cmsSite(id, name, base, { cms = {}, ...extra } = {}) {
  const seen = new Date(base - 2 * HOUR).toISOString();
  return {
    id,
    site_key: `key-${id}-0001`,
    domain: `${id}.test`,
    name,
    websitePlan: 'tier-1-standard',
    features: { users: true },
    featureEnforcement: 'log',
    cms: {
      packageVersion: '2.3.0',
      lastSeenAt: seen,
      lastVerifiedAt: seen,
      featuresRev: 3,
      effectiveHash: 'sha256:0000',
      blockHistory: cleanWeek(base),
      ...cms,
    },
    ...extra,
  };
}

/** The fixture fleet, with every time relative to `base`. */
function fleet(base) {
  const old = new Date(base - 30 * HOUR).toISOString();
  const dayFive = osloDayOf(base - 2 * DAY);
  return [
    cmsSite('fa', 'Fjordlys Keramikk', base),
    cmsSite('fb', 'Bølge Bakeri', base, {
      cms: { blockHistory: cleanWeek(base).map((row) => (row.date === dayFive ? { date: dayFive, count: 4, top: [{ key: 'shop.discounts', route: 'GET /shop/discounts', count: 4 }] } : row)) },
    }),
    cmsSite('fc', 'Cirrus Sykkel', base, { cms: { lastSeenAt: old, lastVerifiedAt: old } }),
    cmsSite('fd', 'Dalen Rammeverksted', base),
    cmsSite('fe', 'Eikeli Frukt', base, { cms: { blockHistory: [] } }),
    cmsSite('fg', 'Granli Garn', base),
    cmsSite('fh', 'Holmen Te', base, {
      cms: { blockHistory: [...cleanWeek(base).slice(0, 6), { date: osloDayOf(base), count: 2, top: [{ key: 'blog', route: 'GET /blog', count: 2 }] }], settingsConflicts: ['shop.seller'] },
    }),
    cmsSite('fk', 'Kvist Snekkeri', base),
    cmsSite('fo', 'Ospeli Glass', base, { featureEnforcement: 'off' }),
    cmsSite('fm', 'Myra Maling', base, { cms: { migrations: { status: 'failed', failed: ['2.3.0-orders'] } } }),
    { id: 'fz', site_key: 'key-fz-0001', domain: 'fz.test', name: 'Zeta Uten CMS', websitePlan: 'tier-1-standard', features: { users: true } },
  ];
}

function writeSites(list) {
  writeFileSync(SITES_FILE, JSON.stringify(list, null, 2));
}

function storedSite(id) {
  return JSON.parse(readFileSync(SITES_FILE, 'utf8')).find((site) => site.id === id);
}

function resetState() {
  rmSync(STATE_FILE, { force: true });
  monitor.resetCmsFleetMemoryForTests();
}

const featureSaved = featureSettingsStore.saveCmsFeatureSettings({ siteConfig: { mode: 'on', siteIds: SERVED } }, { dataDir: DATA_DIR, by: 'test' });
assert.equal(featureSaved.ok, true, JSON.stringify(featureSaved.errors));
const featureSettings = () => featureSettingsStore.readCmsFeatureSettings({ dataDir: DATA_DIR });

const ON = (patch = {}) => {
  const settings = settingsStore.defaultAutomationSettings();
  settings.alerts.to = 'staff@example.com';
  settings.cmsFleet = {
    monitor: { enabled: true, mode: 'auto', paused: null },
    autoApplyFlip: false,
    wakePing: { enabled: true, paused: null },
    ...patch,
  };
  return settings;
};

// Routes behind a fake adminAuth, and the feature routes for the site-config hook.
const app = express();
app.use(express.json());
const adminAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer admin') return res.status(401).json({ message: 'Unauthorized' });
  req.admin = { username: 'superadmin' };
  next();
};
const { siteConfigFeatures } = registerCmsFeatureRoutes(app, { adminAuth, hub, sales: { getSalesClients: () => [] }, getDataDir: () => DATA_DIR, log: quiet });
fleetRoutes.register(app, { adminAuth, hub, getDataDir: () => DATA_DIR });
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
const extraServers = [];

test.after(() => {
  server.close();
  for (const extra of extraServers) {
    extra.closeAllConnections?.();
    extra.close();
  }
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method, path, body, headers = { authorization: 'Bearer admin' }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

const siteConfig = (id) => hub.getSiteConfig(`key-${id}-0001`, false, { withFeatures: siteConfigFeatures });

// ---------------------------------------------------------------- dark by default (negative control)

test('with the switches at their defaults nothing runs, nothing is written and no request or mail leaves', async () => {
  resetState();
  writeSites(fleet(NOW));
  const defaults = settingsStore.defaultAutomationSettings();
  assert.deepEqual(defaults.cmsFleet, {
    monitor: { enabled: false, mode: 'shadow', paused: null },
    autoApplyFlip: false,
    wakePing: { enabled: false, paused: null },
  });
  const configsBefore = fleet(NOW).map((site) => [site.id, siteConfig(site.id)]);
  const sitesBefore = readFileSync(SITES_FILE);
  const filesBefore = readdirSync(DATA_DIR).sort();
  const calls = [];
  const spyFetch = async (...args) => {
    calls.push(['fetch', ...args]);
    return new Response('{}');
  };
  const spyMail = async (message) => calls.push(['mail', message]);
  const flipSpy = async (...args) => {
    calls.push(['flip', ...args]);
    return [];
  };

  assert.deepEqual(await monitor.runFleetReview({ hub, now: NOW, sendMail: spyMail, flip: flipSpy, lease: noLease, log: quiet }), { ran: false, reason: 'off' });
  assert.deepEqual(await monitor.wakePing({ hub, now: NOW, fetchImpl: spyFetch }), { ran: false, reason: 'off' });
  const paused = ON({ monitor: { enabled: true, mode: 'auto', paused: { reason: 'check' } }, wakePing: { enabled: true, paused: { reason: 'check' } } });
  assert.deepEqual(await monitor.runFleetReview({ hub, settings: paused, now: NOW, sendMail: spyMail, flip: flipSpy, lease: noLease, log: quiet }), { ran: false, reason: 'paused' });
  assert.deepEqual(await monitor.wakePing({ hub, settings: paused, now: NOW, fetchImpl: spyFetch }), { ran: false, reason: 'paused' });

  // The background jobs themselves, run at once.
  const review = monitor.startCmsFleetMonitor({ hub, log: quiet, firstMs: 60_000, everyMs: 60_000 });
  const ping = monitor.startCmsWakePing({ hub, log: quiet, firstMs: 60_000, everyMs: 60_000 });
  await review.runNow();
  await ping.runNow();
  review.stop();
  ping.stop();

  assert.deepEqual(calls, [], 'no fetch, mail or flip');
  assert.equal(existsSync(STATE_FILE), false, 'no monitor state file');
  assert.deepEqual(readdirSync(DATA_DIR).sort(), filesBefore, 'no new file in the data dir');
  assert.ok(readFileSync(SITES_FILE).equals(sitesBefore), 'sites.json unchanged');
  for (const [id, config] of configsBefore) assert.deepEqual(siteConfig(id), config, `site-config ${id} unchanged`);
});

// ---------------------------------------------------------------- settings

test('the switches are automation settings: validated, pausable and documented vocabulary keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-cms-fleet-settings-'));
  try {
    const bad = settingsStore.saveAutomationSettings({ cmsFleet: { monitor: { mode: 'always' } } }, { dataDir: dir, by: 'test' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((error) => error.path === 'cmsFleet.monitor.mode'));
    const badFlag = settingsStore.saveAutomationSettings({ cmsFleet: { autoApplyFlip: 'yes' } }, { dataDir: dir, by: 'test' });
    assert.equal(badFlag.ok, false);
    const badPause = settingsStore.saveAutomationSettings({ cmsFleet: { wakePing: { paused: 'now' } } }, { dataDir: dir, by: 'test' });
    assert.equal(badPause.ok, false);
    const ok = settingsStore.saveAutomationSettings(
      { cmsFleet: { monitor: { enabled: true, mode: 'auto', paused: { reason: 'release check' } }, autoApplyFlip: true, wakePing: { enabled: true } } },
      { dataDir: dir, by: 'test' },
    );
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.settings.cmsFleet.monitor.paused.reason, 'release check');
    assert.ok(ok.settings.cmsFleet.monitor.paused.at, 'a pause gets its time');
    assert.equal(monitor.fleetSettings(ok.settings).monitor, 'paused');
    assert.equal(monitor.fleetSettings(ok.settings).wakePing, 'on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const key of ['cmsFleet.monitor.enabled', 'cmsFleet.monitor.mode', 'cmsFleet.monitor.paused', 'cmsFleet.autoApplyFlip', 'cmsFleet.wakePing.enabled', 'cmsFleet.wakePing.paused']) {
    assert.ok(Object.values(vocab.SETTINGS_KEYS).includes(key), key);
  }
});

// ---------------------------------------------------------------- proposals

test('a site with 7 clean days is proposed; a hit on day 5, a 30 h old heartbeat, no tree or a new site is not', () => {
  resetState();
  const review = monitor.reviewFleet({ sites: fleet(NOW), state: null, now: NOW, featureSettings: featureSettings() });
  const row = (id) => review.rows.find((entry) => entry.siteId === id);
  assert.equal(row('fz'), undefined, 'a site without a CMS is out of scope');
  assert.equal(row('fa').proposable, true, JSON.stringify(row('fa').reasons));
  assert.deepEqual(row('fb').reasons, ['block-hits']);
  assert.equal(row('fb').hits.total, 4);
  assert.deepEqual(row('fb').hits.top, [{ key: 'shop.discounts', route: 'GET /shop/discounts', count: 4 }]);
  assert.ok(row('fc').reasons.includes('no-report'));
  assert.equal(row('fc').stale, true);
  assert.deepEqual(row('fd').reasons, ['not-served']);
  assert.deepEqual(row('fe').reasons, ['too-new']);
  assert.deepEqual(row('fo').reasons, ['not-log']);
  const proposed = review.proposals.map((entry) => entry.siteId).sort();
  assert.deepEqual(proposed, ['fa', 'fg', 'fk']);
  assert.equal(review.nextState.sites.fa.proposal.status, 'open');
  assert.equal(review.nextState.sites.fe.watchSince, new Date(NOW).toISOString(), 'the new site is watched from now');
  assert.equal(review.nextState.sites.fc.watchSince, undefined, 'no watch without a fresh report');

  const digest = monitor.buildDigest(review, { now: NOW });
  assert.equal(digest.empty, false);
  assert.match(digest.text, /Ingen kontakt på over 24 timer:\n- Cirrus Sykkel \(fc\.test\): sist kontakt 2026-11-09 03:00/);
  assert.match(digest.text, /Nye innstillingskonflikter:\n- Holmen Te \(fh\.test\): shop\.seller/);
  assert.match(digest.text, /Treff som ville blitt sperret:\n- Holmen Te \(fh\.test\): 2 treff \(blog GET \/blog x2\)/);
  assert.match(digest.text, /Mislykkede migreringer:\n- Myra Maling \(fm\.test\): 2\.3\.0-orders/);
  assert.match(digest.text, /Forslag: slå på håndheving:\n- Fjordlys Keramikk \(fa\.test\)/);
  assert.doesNotMatch(digest.text, /Bølge Bakeri/, 'a hit five days ago is not in the digest and blocks the proposal');
  assert.doesNotMatch(digest.text, /Ikke nåbare/, 'no ping has run');
  assert.equal(digest.subject, `[Asoldi] CMS-flåten: ${Object.values(digest.counts).reduce((a, b) => a + b, 0)} merknader`);

  // A conflict already reported in an earlier digest is not new.
  const again = monitor.reviewFleet({ sites: fleet(NOW + DAY), state: review.nextState, now: NOW + DAY, featureSettings: featureSettings() });
  assert.equal(again.newConflicts.length, 0);
});

test('a new site is proposed once it has been watched for 7 days', () => {
  const first = monitor.reviewFleet({ sites: fleet(NOW), state: null, now: NOW, featureSettings: featureSettings() });
  const fiveDays = monitor.reviewFleet({ sites: fleet(NOW + 5 * DAY), state: first.nextState, now: NOW + 5 * DAY, featureSettings: featureSettings() });
  assert.deepEqual(fiveDays.rows.find((row) => row.siteId === 'fe').reasons, ['too-new']);
  const sixDays = monitor.reviewFleet({ sites: fleet(NOW + 6 * DAY), state: fiveDays.nextState, now: NOW + 6 * DAY, featureSettings: featureSettings() });
  const row = sixDays.rows.find((entry) => entry.siteId === 'fe');
  assert.equal(row.proposable, true, JSON.stringify(row.reasons));
  assert.equal(row.observedSince, monitor.osloDay(NOW));
  assert.equal(sixDays.nextState.sites.fe.proposal.status, 'open');
});

// ---------------------------------------------------------------- routes

test('every fleet route needs the Superadmin token', async () => {
  writeSites(fleet(Date.now()));
  const before = readFileSync(SITES_FILE);
  for (const [method, path] of [['GET', '/api/admin/cms-fleet'], ['POST', '/api/admin/cms-fleet/flip'], ['POST', '/api/admin/cms-fleet/revert'], ['POST', '/api/admin/cms-fleet/dismiss']]) {
    const res = await call(method, path, method === 'POST' ? { all: true, siteId: 'fa' } : undefined, {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.ok(readFileSync(SITES_FILE).equals(before));
});

test('approving a proposal turns enforcement on and the next site-config shows it; revert and dismiss work', async () => {
  resetState();
  writeSites(fleet(Date.now()));
  assert.equal(siteConfig('fa').featureEnforcement, 'log');
  const overview = await call('GET', '/api/admin/cms-fleet');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.proposals.sort(), ['fa', 'fg', 'fk']);
  assert.equal(overview.body.settings.monitor, 'off');
  assert.equal(existsSync(STATE_FILE), false, 'the overview writes nothing');

  const flip = await call('POST', '/api/admin/cms-fleet/flip', { siteIds: ['fa'] });
  assert.equal(flip.status, 200);
  assert.deepEqual(flip.body.results, [{ siteId: 'fa', ok: true, from: 'log', to: 'on' }]);
  const stored = storedSite('fa');
  assert.equal(stored.featureEnforcement, 'on');
  const history = stored.cmsSpecHistory.at(-1);
  assert.deepEqual(history.featureEnforcement, { from: 'log', to: 'on' });
  assert.equal(history.by, 'admin:superadmin');
  assert.equal(siteConfig('fa').featureEnforcement, 'on', 'the next site-config carries it');
  assert.equal(siteConfig('fb').featureEnforcement, 'log', 'other sites unchanged');

  const again = await call('POST', '/api/admin/cms-fleet/flip', { siteIds: ['fa', 'fo', 'nope'] });
  assert.deepEqual(again.body.results.map((row) => [row.siteId, row.ok, row.unchanged || row.error || '']), [
    ['fa', true, true],
    ['fo', false, 'not-in-log'],
    ['nope', false, 'Site not found'],
  ]);
  assert.equal(again.body.results[1].status, 409);
  assert.equal(storedSite('fo').featureEnforcement, 'off');
  assert.equal((await call('POST', '/api/admin/cms-fleet/flip', {})).status, 400);

  // Revert: back to log, and 7 new days before the next proposal.
  const revert = await call('POST', '/api/admin/cms-fleet/revert', { siteId: 'fa', reason: 'shop owner asked' });
  assert.equal(revert.status, 200);
  assert.equal(storedSite('fa').featureEnforcement, 'log');
  assert.equal(siteConfig('fa').featureEnforcement, 'log');
  const twice = await call('POST', '/api/admin/cms-fleet/revert', { siteId: 'fa' });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.result.unchanged, true);
  assert.equal((await call('POST', '/api/admin/cms-fleet/revert', { siteId: 'fo' })).status, 409, 'off is not reverted to log');
  assert.equal((await call('POST', '/api/admin/cms-fleet/revert', { siteId: 'nope' })).status, 404);
  const afterRevert = await call('GET', '/api/admin/cms-fleet');
  assert.ok(afterRevert.body.rows.find((row) => row.siteId === 'fa').reasons.includes('too-new'));
  assert.deepEqual(afterRevert.body.flips.map((row) => [row.siteId, row.from, row.to]), [['fa', 'on', 'log'], ['fa', 'log', 'on']]);

  // Dismiss: no bulk flip for that site.
  assert.equal((await call('POST', '/api/admin/cms-fleet/dismiss', { siteId: 'fg' })).status, 200);
  assert.equal((await call('POST', '/api/admin/cms-fleet/dismiss', { siteId: 'fg' })).status, 409);
  assert.equal((await call('POST', '/api/admin/cms-fleet/dismiss', { siteId: 'fb' })).status, 409, 'nothing to dismiss');
  assert.equal((await call('POST', '/api/admin/cms-fleet/dismiss', { siteId: 'nope' })).status, 404);
  const all = await call('POST', '/api/admin/cms-fleet/flip', { all: true });
  assert.deepEqual(all.body.results.map((row) => row.siteId), ['fk']);
  assert.equal(storedSite('fk').featureEnforcement, 'on');
  assert.equal(storedSite('fg').featureEnforcement, 'log');
});

// ---------------------------------------------------------------- the daily review

test('in shadow the review stores proposals and the digest once a day from 07:00 Oslo and mails nothing', async () => {
  resetState();
  writeSites(fleet(NOW));
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const shadow = ON({ monitor: { enabled: true, mode: 'shadow', paused: null } });
  const early = await monitor.runFleetReview({ hub, settings: shadow, featureSettings: featureSettings(), now: NOW - 2.5 * HOUR, sendMail, lease: noLease, log: quiet });
  assert.deepEqual(early, { ran: false, reason: 'too-early' });
  assert.equal(existsSync(STATE_FILE), false);
  const result = await monitor.runFleetReview({ hub, settings: shadow, featureSettings: featureSettings(), now: NOW, sendMail, lease: noLease, log: quiet });
  assert.equal(result.ran, true);
  assert.deepEqual(result.proposals.sort(), ['fa', 'fg', 'fk']);
  assert.equal(result.mailed, false);
  assert.deepEqual(mails, []);
  const state = monitor.readFleetState({ dataDir: DATA_DIR });
  assert.equal(state.lastReviewDay, '2026-11-10');
  assert.equal(state.lastDigest.mailed, false);
  assert.match(state.lastDigest.text, /Forslag: slå på håndheving/);
  assert.equal(state.sites.fa.proposal.status, 'open');
  assert.deepEqual(await monitor.runFleetReview({ hub, settings: shadow, featureSettings: featureSettings(), now: NOW + HOUR, sendMail, lease: noLease, log: quiet }), { ran: false, reason: 'done-today' });
  monitor.resetCmsFleetMemoryForTests();
  assert.deepEqual(await monitor.runFleetReview({ hub, settings: shadow, featureSettings: featureSettings(), now: NOW + HOUR, sendMail, lease: noLease, log: quiet }), { ran: false, reason: 'done-today' }, 'also from the stored day');
  assert.deepEqual(await monitor.runFleetReview({ hub, settings: shadow, featureSettings: featureSettings(), now: NOW, sendMail, lease: async () => null, log: quiet }), { ran: false, reason: 'done-today' });
});

test('another process holding the review lease means no review', async () => {
  resetState();
  writeSites(fleet(NOW));
  const result = await monitor.runFleetReview({ hub, settings: ON(), featureSettings: featureSettings(), now: NOW, sendMail: async () => {}, lease: async () => null, log: quiet });
  assert.deepEqual(result, { ran: false, reason: 'busy' });
  assert.equal(existsSync(STATE_FILE), false);
});

test('in auto the digest is mailed to alerts.to, and a proposal nobody dismissed is applied after 3 days', async () => {
  resetState();
  const mails = [];
  const sendMail = async (message) => mails.push(message);
  const auto = ON({ autoApplyFlip: true });
  const run = async (days) => {
    writeSites(fleet(NOW + days * DAY));
    return monitor.runFleetReview({ hub, settings: auto, featureSettings: featureSettings(), now: NOW + days * DAY, sendMail, lease: noLease, log: quiet });
  };
  const day0 = await run(0);
  assert.equal(day0.mailed, true);
  assert.deepEqual(day0.applied, []);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'staff@example.com');
  assert.match(mails[0].subject, /^\[Asoldi\] CMS-flåten: \d+ merknader$/);
  assert.equal(monitor.readFleetState({ dataDir: DATA_DIR }).lastDigest.mailed, true);
  assert.deepEqual(monitor.dismissProposal({ siteId: 'fg', by: 'admin:superadmin', dataDir: DATA_DIR, now: NOW }), { ok: true });

  const day2 = await run(2);
  assert.deepEqual(day2.applied, [], 'two days are not enough');
  const day3 = await run(3);
  assert.deepEqual(day3.applied.sort(), ['fa', 'fk']);
  const fa = storedSite('fa');
  assert.equal(fa.featureEnforcement, 'on');
  assert.equal(fa.cmsSpecHistory.at(-1).by, monitor.FLIP_BY_MONITOR);
  assert.equal(storedSite('fg').featureEnforcement, 'log', 'a dismissed proposal is never applied');
  assert.equal(storedSite('fb').featureEnforcement, 'log');
  const state = monitor.readFleetState({ dataDir: DATA_DIR });
  assert.equal(state.sites.fa.proposal.status, 'applied');
  assert.equal(state.sites.fa.proposal.auto, true);
  assert.equal(state.sites.fg.proposal.status, 'dismissed');
  assert.equal(mails.length, 3, 'one digest a day');

  // A failed mail is recorded, never thrown.
  resetState();
  writeSites(fleet(NOW));
  const failing = await monitor.runFleetReview({ hub, settings: ON(), featureSettings: featureSettings(), now: NOW, sendMail: async () => { throw new Error('smtp down'); }, lease: noLease, log: quiet });
  assert.equal(failing.ran, true);
  assert.equal(failing.mailed, false);
  assert.equal(monitor.readFleetState({ dataDir: DATA_DIR }).lastDigest.error, 'smtp down');
});

test('without autoApplyFlip or in shadow nothing is applied', async () => {
  for (const settings of [ON(), ON({ monitor: { enabled: true, mode: 'shadow', paused: null }, autoApplyFlip: true })]) {
    resetState();
    for (const days of [0, 3]) {
      writeSites(fleet(NOW + days * DAY));
      const result = await monitor.runFleetReview({ hub, settings, featureSettings: featureSettings(), now: NOW + days * DAY, sendMail: async () => {}, lease: noLease, log: quiet });
      assert.deepEqual(result.applied, []);
    }
    assert.equal(storedSite('fa').featureEnforcement, 'log');
  }
});

// ---------------------------------------------------------------- health ping

function listen(handler) {
  return new Promise((resolve) => {
    const extra = http.createServer(handler);
    extraServers.push(extra);
    extra.listen(0, '127.0.0.1', () => resolve(extra));
  });
}

test('the health ping records reachable, refused and slow sites, and the overview marks the unreachable one', async () => {
  resetState();
  const seen = [];
  const okServer = await listen((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const slowServer = await listen(() => {});
  const closed = await listen(() => {});
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const base = Date.now();
  writeSites([
    cmsSite('fw1', 'Vik Verksted', base, { domain: `127.0.0.1:${okServer.address().port}` }),
    cmsSite('fw2', 'Vang Vev', base, { domain: `127.0.0.1:${closedPort}` }),
    cmsSite('fw3', 'Varden Vin', base, { domain: `localhost:${slowServer.address().port}` }),
    cmsSite('fw4', 'Vollen Ved', base, { domain: '' }),
    { id: 'fz', site_key: 'key-fz-0001', domain: 'fz.test', name: 'Zeta Uten CMS', websitePlan: 'tier-1-standard', features: { users: true } },
  ]);
  const result = await monitor.wakePing({ hub, settings: ON(), now: base, timeoutMs: 300 });
  assert.equal(result.ran, true);
  assert.deepEqual(Object.keys(result.results).sort(), ['fw1', 'fw2', 'fw3', 'fw4']);
  assert.equal(result.results.fw1.ok, true);
  assert.equal(result.results.fw1.status, 200);
  assert.deepEqual(seen, ['GET /api/cms/health']);
  assert.equal(result.results.fw2.ok, false);
  assert.match(result.results.fw2.error, /ECONNREFUSED/);
  assert.equal(result.results.fw3.error, 'timeout');
  assert.equal(result.results.fw4.skipped, 'no-domain');

  const overview = await call('GET', '/api/admin/cms-fleet');
  const byId = Object.fromEntries(overview.body.rows.map((row) => [row.siteId, row]));
  assert.equal(byId.fw1.unreachable, false);
  assert.equal(byId.fw2.unreachable, true);
  assert.equal(byId.fw3.unreachable, true);
  assert.equal(byId.fw4.unreachable, false, 'a skipped site is not reported as unreachable');
  const digest = monitor.buildDigest(monitor.reviewFleet({ sites: hub.getAllSites(), state: monitor.readFleetState({ dataDir: DATA_DIR }), now: base, featureSettings: featureSettings() }), { now: base });
  assert.match(digest.text, /Ikke nåbare ved siste helsesjekk:\n- Vang Vev \(127\.0\.0\.1:\d+\): ECONNREFUSED\n- Varden Vin \(localhost:\d+\): timeout/);
});

test('ping addresses: a stored scheme or path is dropped, Unicode names are sent as punycode, odd values are refused', () => {
  assert.equal(monitor.wakeHost('https://Fjordlys.test/om-oss'), 'fjordlys.test');
  assert.equal(monitor.wakeHost('kåsa.test'), 'xn--ksa-ula.test');
  assert.equal(monitor.wakeHost('fjordlys.test:8443'), 'fjordlys.test:8443');
  assert.equal(monitor.wakeHost('[::1]:3000'), '[::1]:3000');
  for (const bad of ['', 'a b.test', 'user@fjordlys.test', 'fjordlys.test:99999', 'http://', 'fjord\\lys.test']) assert.equal(monitor.wakeHost(bad), '', bad);
  assert.equal(monitor.isLoopbackHost('127.0.0.1:3000'), true);
  assert.equal(monitor.isLoopbackHost('localhost'), true);
  assert.equal(monitor.isLoopbackHost('[::1]:80'), true);
  assert.equal(monitor.isLoopbackHost('fjordlys.test'), false);
});


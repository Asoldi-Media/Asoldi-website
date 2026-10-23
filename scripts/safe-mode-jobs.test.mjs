import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-safe-jobs-'));
process.env.APP_DATA_DIR = dataDir;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const safeMode = await import('../lib/safe-mode.js');
const { BACKGROUND_JOBS, backgroundJobPlan, runBackgroundJobs } = safeMode;

const quiet = { log() {}, error() {}, warn() {} };

function startedWith(env) {
  safeMode.installSafeMode({ env, dataDir, log: null, egress: false });
  const started = [];
  const map = Object.fromEntries(Object.keys(BACKGROUND_JOBS).map((name) => [name, () => started.push(name)]));
  runBackgroundJobs(map, { log: quiet });
  return started.sort();
}

test('safe mode default: only the outbox loops and local backfills start', () => {
  assert.deepEqual(startedWith({ HUB_SAFE_MODE: '1' }), [
    'firefliesMeetLinkBackfill',
    'nyAssignmentBackfill',
    'salesBookingFactsBackfill',
    'salesReminders',
    'workshopDeskEmails',
  ]);
});

test('Fireflies ingest, live-join, inbox, Myphoner, geocode, LAN autopublish, maps ranking are off by default', () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null, egress: false });
  const plan = backgroundJobPlan();
  for (const name of ['firefliesIngest', 'firefliesLiveJoin', 'inboxBot', 'myphonerWebhookReconcile', 'myphonerRecordingRetry', 'salesGeocodeWarmup', 'lanPreviewAutoPublish', 'mapsRanking', 'salesRecordingBackfill', 'salesLinkBackfill', 'ssuWinsBackfill']) {
    assert.equal(plan[name], 'off', name);
  }
});

test('HUB_SAFE_MODE_ALLOW switches single jobs on by key', () => {
  const started = startedWith({ HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'firefliesIngest,prodPublish,inboxRead' });
  assert.ok(started.includes('firefliesIngest'));
  assert.ok(started.includes('lanPreviewAutoPublish'));
  assert.ok(started.includes('inboxBot'));
  assert.ok(!started.includes('firefliesLiveJoin'));
});

test('off safe mode (Hostinger): every job starts', () => {
  assert.deepEqual(startedWith({ HOSTINGER: '1' }), Object.keys(BACKGROUND_JOBS).sort());
});

test('an unclassified job is off in safe mode and on in production', () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null, egress: false });
  let ran = false;
  runBackgroundJobs({ brandNewLoop: () => { ran = true; } }, { log: quiet });
  assert.equal(ran, false);
  safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir, log: null, egress: false });
  runBackgroundJobs({ brandNewLoop: () => { ran = true; } }, { log: quiet });
  assert.equal(ran, true);
});

test('server.js starts every background job through runBackgroundJobs, each one classified', () => {
  const source = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function startBackgroundJobs() {');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /runBackgroundJobs\(\{/);
  const names = [...body.matchAll(/^ {4}([A-Za-z]+): /gm)].map((m) => m[1]);
  assert.deepEqual(names.slice().sort(), Object.keys(BACKGROUND_JOBS).sort(), 'jobMap keys == BACKGROUND_JOBS keys');
  for (const loop of ['startSalesReminderLoop', 'startWorkshopDeskEmailLoop', 'startFirefliesLiveJoinLoop', 'startInboxBotLoop', 'startFirefliesTranscriptIngestLoop', 'startOfferLetterFillLoop', 'startMyphonerWebhookReconcileLoop', 'startMyphonerRecordingRetryLoop', 'startSalesGeocodeWarmupLoop', 'startLanPreviewAutoPublishLoop', 'startMapsRankingLoop']) {
    assert.ok(body.includes(`${loop}()`), `${loop} is wired through the plan`);
  }
  const outside = source.slice(0, start) + source.slice(start + body.length);
  assert.doesNotMatch(outside, /^\s*start(SalesReminder|WorkshopDeskEmail|FirefliesLiveJoin|InboxBot|FirefliesTranscriptIngest|OfferLetterFill|MyphonerWebhookReconcile|MyphonerRecordingRetry|SalesGeocodeWarmup|LanPreviewAutoPublish|MapsRanking)Loop\(\);/m, 'no loop is started outside the plan');
});

test('server.js: safe mode boots first, health reports it, ingest and prod logins are guarded', () => {
  const source = readFileSync(join(root, 'server.js'), 'utf8');
  const firstImport = source.split('\n').find((line) => line.startsWith('import '));
  assert.equal(firstImport.trim(), "import './lib/safe-mode-boot.js';");
  assert.match(source, /safeMode: isSafeModeActive\(\)/);
  assert.match(source, /function scheduleFirefliesTranscriptIngest[^]*?if \(!safeModeAllows\('firefliesIngest'\)\) return null;/);
  // The contract-letter fill left the ingest tick for its own loop, behind the same switch.
  assert.match(source, /function scheduleOfferLetterFills\(\) \{[^]*?if \(!safeModeAllows\('firefliesIngest'\)\) return null;/);
  assert.match(source, /async function loginToProdAdmin\(\) \{\s*assertSafeModeAllows\('prodPublish'/);
  assert.match(source, /async function loginProdAdmin\(prodBase = ''\) \{\s*assertSafeModeAllows\('prodPublish'/);
  assert.match(source, /async function publishPreviewBridgeJob\(job = \{\}\) \{\s*assertSafeModeAllows\('prodPublish'/);
  assert.match(source, /async function restartMakerTunnel\([^)]*\) \{\s*assertSafeModeAllows\('publicTunnel'/);
  assert.match(source, /registerSafeModeRoutes\(app, \{ adminAuth \}\)/);
});

test('docker-compose.lan.yml keeps LAN autopublish working under safe mode', () => {
  const compose = readFileSync(join(root, 'docker-compose.lan.yml'), 'utf8');
  assert.match(compose, /HUB_SAFE_MODE_ALLOW: "?prodPublish,lan"?/);
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

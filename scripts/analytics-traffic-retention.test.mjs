// Visit-statistics retention: day files older than 26 months (Oslo days). The switch defaults
// off, and while it is off the job creates nothing. shadow counts; auto deletes, except in safe mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-traffic-retention-'));
process.env.APP_DATA_DIR = dataDir;
process.env.DATA_DIR = '';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const store = await import('../data/client-analytics.js');
const settingsStore = await import('../data/automation-settings.js');
const job = await import('../lib/analytics-traffic-retention.js');
const safeMode = await import('../lib/safe-mode.js');
const { BACKGROUND_JOBS } = safeMode;

const quiet = { log() {}, error() {} };
const WINTER = Date.parse('2026-11-12T22:30:00.000Z');

function switchSettings(patch) {
  return { retention: { analyticsTraffic: { enabled: false, mode: 'shadow', paused: null, ...patch } } };
}

function writeDay(site, day, body) {
  const dir = join(dataDir, 'client-analytics-traffic', site);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${day}.jsonl`);
  writeFileSync(path, body);
  return path;
}

test('without a traffic folder and the switch on, the run reports no-data and creates nothing', async () => {
  const before = readdirSync(dataDir).sort();
  let leases = 0;
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'shadow' }),
    acquire: async () => { leases += 1; return null; },
    logger: quiet,
  });
  assert.deepEqual(result, { ran: false, reason: 'no-data' });
  assert.equal(leases, 0);
  assert.deepEqual(readdirSync(dataDir).sort(), before);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic')), false);
  assert.equal(existsSync(join(dataDir, 'email-locks')), false);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic-retention.json')), false);
});

test('the switch defaults off, and a run then asks for no lease and leaves old day files in place', async () => {
  assert.deepEqual(settingsStore.defaultAutomationSettings().retention.analyticsTraffic, {
    enabled: false, mode: 'shadow', paused: null,
  });
  const kept = writeDay('off-site', '2020-01-01', 'stay\n');
  const before = readdirSync(dataDir).sort();
  let leases = 0;
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: settingsStore.defaultAutomationSettings(),
    acquire: async () => { leases += 1; return { release: async () => {} }; },
    logger: quiet,
  });
  assert.deepEqual(result, { ran: false, reason: 'off' });
  assert.equal(leases, 0);
  assert.deepEqual(readdirSync(dataDir).sort(), before);
  assert.equal(existsSync(kept), true);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic-retention.json')), false);
});

test('shadow counts due files in two site folders and deletes nothing', async () => {
  const oldA = writeDay('blue-harbor', '2020-01-01', 'old-a\n');
  const fresh = writeDay('blue-harbor', '2026-11-12', 'new-a\n');
  const oldB = writeDay('pine-studio', '2023-06-01', 'old-b\n');
  const lines = [];
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'shadow' }),
    logger: { log(line) { lines.push(line); }, error() {} },
  });
  assert.equal(result.ran, true);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.cutoffDay, '2024-09-12');
  assert.equal(result.months, 26);
  // The day file from the off-switch test is still there, so it is counted too.
  assert.equal(result.sites, 3);
  assert.equal(result.files, 3);
  assert.equal(result.bytes, Buffer.byteLength('stay\n') + Buffer.byteLength('old-a\n') + Buffer.byteLength('old-b\n'));
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.oldestDay, '2020-01-01');
  for (const path of [oldA, fresh, oldB, join(dataDir, 'client-analytics-traffic', 'off-site', '2020-01-01.jsonl')]) assert.equal(existsSync(path), true, path);
  const raw = readFileSync(join(dataDir, 'client-analytics-traffic-retention.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), result);
  for (const name of ['blue-harbor', 'pine-studio', 'off-site']) {
    assert.equal(raw.includes(name), false, name);
    assert.equal(raw.includes(`/${name}`), false, `/${name}`);
    assert.equal(raw.includes(`\\${name}`), false, name);
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[analytics-retention\] shadow: would delete 3 day file\(s\)/);
});

test('auto deletes only due day files and leaves every other file byte-identical', async () => {
  const site = join(dataDir, 'client-analytics-traffic', 'auto-site');
  mkdirSync(site, { recursive: true });
  const due = join(site, '2020-01-01.jsonl');
  const boundary = join(site, '2024-09-11.jsonl');
  const onCutoff = join(site, '2024-09-12.jsonl');
  const notes = join(site, 'notes.txt');
  const bak = join(site, '2024-01-01.jsonl.bak');
  const nestedDir = join(site, 'nested');
  const nested = join(nestedDir, '2020-01-01.jsonl');
  writeFileSync(due, 'due\n');
  writeFileSync(boundary, 'boundary\n');
  writeFileSync(onCutoff, 'cutoff\n');
  writeFileSync(notes, 'notes\n');
  writeFileSync(bak, 'bak\n');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(nested, 'nested\n');
  const emailDir = join(dataDir, 'email-log');
  mkdirSync(emailDir, { recursive: true });
  const emailFile = join(emailDir, 'messages-202001.jsonl');
  const ranking = join(dataDir, 'client-maps-ranking.json');
  writeFileSync(emailFile, 'mail\n');
  writeFileSync(ranking, '{"rank":1}\n');
  const beforeMail = readFileSync(emailFile);
  const beforeRank = readFileSync(ranking);
  const lines = [];
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    logger: { log(line) { lines.push(line); }, error() {} },
  });
  assert.equal(result.mode, 'auto');
  assert.equal(result.removed >= 1, true);
  assert.equal(existsSync(due), false);
  assert.equal(readFileSync(boundary, 'utf8'), 'boundary\n');
  assert.equal(readFileSync(onCutoff, 'utf8'), 'cutoff\n');
  assert.equal(readFileSync(notes, 'utf8'), 'notes\n');
  assert.equal(readFileSync(bak, 'utf8'), 'bak\n');
  assert.equal(readFileSync(nested, 'utf8'), 'nested\n');
  assert.equal(existsSync(site), true);
  assert.deepEqual(readFileSync(emailFile), beforeMail);
  assert.deepEqual(readFileSync(ranking), beforeRank);
  assert.match(lines.join('\n'), /\[analytics-retention\] deleted \d+ day file\(s\)/);
  // The shadow fixtures from the previous test are due too, and auto removes them.
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic', 'blue-harbor', '2020-01-01.jsonl')), false);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic', 'blue-harbor', '2026-11-12.jsonl')), true);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic', 'pine-studio', '2023-06-01.jsonl')), false);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic', 'blue-harbor')), true);
  assert.equal(existsSync(join(dataDir, 'client-analytics-traffic', 'pine-studio')), true);
});

test('cutoff day uses Oslo dates, keeps the file that can hold the cutoff day, and clamps month ends', async () => {
  assert.equal(job.trafficRetentionCutoffDay(WINTER), '2024-09-12');
  assert.equal(job.trafficDayFileIsDue('2024-09-10', '2024-09-12'), true);
  assert.equal(job.trafficDayFileIsDue('2024-09-11', '2024-09-12'), false);
  assert.equal(job.trafficDayFileIsDue('2024-09-12', '2024-09-12'), false);
  // 22:05 UTC in July is 00:05 the next day in Oslo (summer time, UTC+2).
  assert.equal(job.trafficRetentionCutoffDay(Date.parse('2026-07-15T22:05:00.000Z')), '2024-05-16');
  // 30 April 2027 Oslo is 26 months before 28 February 2025 (not a leap year).
  assert.equal(job.trafficRetentionCutoffDay(Date.parse('2027-04-30T10:00:00.000Z')), '2025-02-28');
  // 30 April 2026 clamps to 29 February 2024.
  assert.equal(job.trafficRetentionCutoffDay(Date.parse('2026-04-30T10:00:00.000Z')), '2024-02-29');

  // A file name that is not a real calendar day is never due, and it does not stop the run.
  assert.equal(job.trafficDayFileIsDue('2020-13-45', '2024-09-12'), false);
  assert.equal(job.trafficDayFileIsDue('2020-02-31', '2024-09-12'), false);
  const odd = writeDay('boundary-site', '2020-13-45', 'odd\n');
  const gone = writeDay('boundary-site', '2024-09-10', 'gone\n');
  const stays = writeDay('boundary-site', '2024-09-11', 'stays\n');
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    logger: quiet,
  });
  assert.equal(result.cutoffDay, '2024-09-12');
  assert.equal(existsSync(gone), false);
  assert.equal(readFileSync(stays, 'utf8'), 'stays\n');
  assert.equal(readFileSync(odd, 'utf8'), 'odd\n');
});

test('a paused switch deletes nothing, and a held lease reports busy', async () => {
  const path = writeDay('paused-site', '2020-01-01', 'paused\n');
  let leases = 0;
  const paused = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto', paused: { reason: 'hold' } }),
    acquire: async () => { leases += 1; return null; },
    logger: quiet,
  });
  assert.deepEqual(paused, { ran: false, reason: 'paused' });
  assert.equal(leases, 0);
  assert.equal(readFileSync(path, 'utf8'), 'paused\n');
  const busy = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    acquire: async () => null,
    logger: quiet,
  });
  assert.deepEqual(busy, { ran: false, busy: true });
  assert.equal(readFileSync(path, 'utf8'), 'paused\n');
});

test('safe mode makes auto report only', async () => {
  const path = writeDay('safe-site', '2020-02-02', 'safe\n');
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null, egress: false });
  try {
    const lines = [];
    const result = await job.runTrafficRetention({
      now: WINTER,
      settings: switchSettings({ enabled: true, mode: 'auto' }),
      logger: { log(line) { lines.push(line); }, error() {} },
    });
    assert.equal(result.ran, true);
    assert.equal(result.mode, 'shadow');
    assert.equal(result.removed, 0);
    assert.equal(readFileSync(path, 'utf8'), 'safe\n');
    assert.match(lines.join('\n'), /\[analytics-retention\] shadow: would delete \d+ day file\(s\)/);
  } finally {
    safeMode.resetSafeModeForTests();
  }
});

test('removeTrafficDayFile refuses a path outside the traffic folder and a non-day name', () => {
  const outside = join(dataDir, 'client-maps-ranking.json');
  if (!existsSync(outside)) writeFileSync(outside, '{"rank":1}\n');
  const before = readFileSync(outside);
  assert.equal(store.removeTrafficDayFile({ path: outside }), false);
  assert.deepEqual(readFileSync(outside), before);
  const site = join(dataDir, 'client-analytics-traffic', 'auto-site');
  const notes = join(site, 'notes.txt');
  assert.equal(store.removeTrafficDayFile({ path: notes }), false);
  assert.equal(readFileSync(notes, 'utf8'), 'notes\n');
  assert.equal(store.removeTrafficDayFile({ path: join(site, '..', '..', 'client-maps-ranking.json') }), false);
  const day = writeDay('link-site', '2020-03-03', 'real\n');
  const link = join(dataDir, 'client-analytics-traffic', 'link-site', '2019-01-01.jsonl');
  // A linked day file: creating a file link needs a privilege on Windows, so that part runs where it can.
  let linked = true;
  try {
    symlinkSync(day, link);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    linked = false;
  }
  if (linked) {
    assert.equal(store.removeTrafficDayFile({ path: link }), false);
    assert.equal(existsSync(link), true);
  }
  assert.equal(readFileSync(day, 'utf8'), 'real\n');
  // A linked site folder (a junction on Windows) is not followed: its day files are neither listed nor deleted.
  const elsewhere = join(dataDir, 'kept-elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, '2019-05-05.jsonl'), 'elsewhere\n');
  const linkedSite = join(dataDir, 'client-analytics-traffic', 'linked-site');
  symlinkSync(elsewhere, linkedSite, 'junction');
  const throughLink = join(linkedSite, '2019-05-05.jsonl');
  assert.equal(existsSync(throughLink), true);
  assert.equal(store.removeTrafficDayFile({ path: throughLink }), false);
  assert.equal(readFileSync(join(elsewhere, '2019-05-05.jsonl'), 'utf8'), 'elsewhere\n');
  const listed = store.listTrafficDayFiles().map((entry) => entry.path);
  assert.equal(listed.includes(link), false);
  assert.equal(listed.includes(throughLink), false);
  assert.equal(listed.includes(day), true);
});

test('the loop runs after its first delay and stops', async () => {
  const runs = [];
  const loop = job.startTrafficRetentionLoop({
    firstDelayMs: 5,
    everyMs: 20,
    logger: quiet,
    run: async () => { runs.push(Date.now()); throw new Error('disk gone'); },
  });
  try {
    const deadline = Date.now() + 5000;
    while (runs.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    loop.stop();
  }
  assert.ok(runs.length >= 2, `${runs.length} runs`);
  const after = runs.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runs.length, after, 'stop() ends the loop');
});

test('the job is classified and server.js starts the loop exactly once', () => {
  assert.deepEqual(BACKGROUND_JOBS.analyticsTrafficRetention, {
    safe: 'on',
    key: '',
    note: 'local data only: visit statistics day files older than 26 months; does nothing while retention.analyticsTraffic is off; report only in safe mode',
  });
  const source = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function startBackgroundJobs() {');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.equal(body.split('analyticsTrafficRetention: () => startTrafficRetentionLoop(),').length - 1, 1);
  assert.equal(source.split('startTrafficRetentionLoop(').length - 1, 1, 'started only from the job map');
});

test('settings validation refuses a pause without a reason and a mode other than shadow or auto', () => {
  const badPause = settingsStore.validateAutomationSettings({
    retention: { analyticsTraffic: { paused: { at: '2026-11-12T00:00:00.000Z' } } },
  });
  assert.equal(badPause.ok, false);
  assert.ok(badPause.errors.some((error) => error.path === 'retention.analyticsTraffic.paused'));
  const badMode = settingsStore.validateAutomationSettings({
    retention: { analyticsTraffic: { mode: 'live' } },
  });
  assert.equal(badMode.ok, false);
  assert.ok(badMode.errors.some((error) => error.path === 'retention.analyticsTraffic.mode'));
  writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify({ retention: { leadMonths: 18 } }));
  settingsStore.invalidateAutomationSettingsCache();
  const read = settingsStore.readAutomationSettingsFile();
  assert.deepEqual(read.settings.retention.analyticsTraffic, { enabled: false, mode: 'shadow', paused: null });
  assert.equal(read.settings.retention.leadMonths, 18);
});

test('any truthy paused value pauses, and null, false, an empty string and zero still run', async () => {
  const path = writeDay('pause-values', '2020-04-04', 'stay-or-go\n');
  for (const paused of [true, 'yes', 1, { reason: 'x' }]) {
    let leases = 0;
    const result = await job.runTrafficRetention({
      now: WINTER,
      settings: switchSettings({ enabled: true, mode: 'auto', paused }),
      acquire: async () => { leases += 1; return { release: async () => {} }; },
      logger: quiet,
    });
    assert.deepEqual(result, { ran: false, reason: 'paused' }, JSON.stringify(paused));
    assert.equal(leases, 0, JSON.stringify(paused));
    assert.equal(readFileSync(path, 'utf8'), 'stay-or-go\n');
  }
  for (const paused of [null, false, '', 0]) {
    let leases = 0;
    const result = await job.runTrafficRetention({
      now: WINTER,
      settings: switchSettings({ enabled: true, mode: 'auto', paused }),
      acquire: async () => { leases += 1; return null; },
      logger: quiet,
    });
    assert.equal(leases, 1, JSON.stringify(paused));
    assert.deepEqual(result, { ran: false, busy: true });
    assert.equal(readFileSync(path, 'utf8'), 'stay-or-go\n');
  }
});

test('removedBytes counts only the files that were actually deleted', async () => {
  rmSync(join(dataDir, 'client-analytics-traffic'), { recursive: true, force: true });
  const kept = writeDay('bytes-site', '2020-05-01', 'aa\n');
  const failed = writeDay('bytes-site', '2020-05-02', 'bbbb\n');
  const gone = writeDay('bytes-site', '2020-05-03', 'cccccc\n');
  const keptBytes = statSync(kept).size;
  const failedBytes = statSync(failed).size;
  const goneBytes = statSync(gone).size;
  const lines = [];
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    logger: { log(line) { lines.push(line); }, error() {} },
    remove(entry) {
      if (entry.path === failed) return false;
      return store.removeTrafficDayFile(entry);
    },
  });
  assert.equal(result.removed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.removedBytes, keptBytes + goneBytes);
  assert.equal(result.bytes, keptBytes + failedBytes + goneBytes);
  assert.match(lines.join('\n'), new RegExp(`deleted 2 day file\\(s\\), ${result.removedBytes} byte\\(s\\)`));
  assert.equal(lines.some((line) => line.includes(`${result.bytes} byte(s)`)), false);
  assert.equal(existsSync(failed), true);
  assert.equal(existsSync(kept), false);
  assert.equal(existsSync(gone), false);
  assert.equal(store.readTrafficRetentionReport().removedBytes, result.removedBytes);
});

test('removedBytes is the size at deletion, after the file has grown', async () => {
  rmSync(join(dataDir, 'client-analytics-traffic'), { recursive: true, force: true });
  const path = writeDay('grow-site', '2020-06-01', 'small\n');
  const listed = statSync(path).size;
  const grown = `small\n${'x'.repeat(40)}`;
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    logger: quiet,
    // sizeOf runs immediately before remove, so growing the file here is the size that is deleted.
    sizeOf(entry) {
      writeFileSync(entry.path, grown);
      return store.trafficDayFileBytes(entry);
    },
  });
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.bytes, listed);
  assert.equal(result.removedBytes, Buffer.byteLength(grown));
  assert.equal(existsSync(path), false);
});

test('a remove that throws is counted as failed and the pass still writes the report', async () => {
  rmSync(join(dataDir, 'client-analytics-traffic'), { recursive: true, force: true });
  const kept = writeDay('throw-site', '2020-07-01', 'aa\n');
  const broken = writeDay('throw-site', '2020-07-02', 'bbb\n');
  const gone = writeDay('throw-site', '2020-07-03', 'cccc\n');
  const keptBytes = statSync(kept).size;
  const goneBytes = statSync(gone).size;
  const errors = [];
  const result = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: true, mode: 'auto' }),
    logger: { log() {}, error(line) { errors.push(line); } },
    remove(entry) {
      if (entry.path === broken) throw new Error('disk full');
      return store.removeTrafficDayFile(entry);
    },
  });
  assert.equal(result.removed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.removedBytes, keptBytes + goneBytes);
  assert.equal(existsSync(broken), true);
  assert.equal(existsSync(kept), false);
  assert.equal(existsSync(gone), false);
  assert.match(errors.join('\n'), /1 day file\(s\) could not be deleted/);
  assert.equal(store.readTrafficRetentionReport().failed, 1);
});

test('legal texts on while deletion is off logs an error and still reports off', async () => {
  const legalOn = {
    retention: { analyticsTraffic: { enabled: false, mode: 'shadow', paused: null } },
    legal: { catalogTexts: { enabled: true } },
  };
  const errors = [];
  let leases = 0;
  const logger = { log() {}, error(line) { errors.push(line); } };
  const off = await job.runTrafficRetention({
    now: WINTER,
    settings: legalOn,
    acquire: async () => { leases += 1; return null; },
    logger,
  });
  assert.deepEqual(off, { ran: false, reason: 'off' });
  assert.equal(leases, 0);
  assert.deepEqual(errors, ['[analytics-retention] the legal texts are on but visit statistics are not being deleted (off)']);

  errors.length = 0;
  const paused = await job.runTrafficRetention({
    now: WINTER,
    settings: {
      retention: { analyticsTraffic: { enabled: true, mode: 'auto', paused: { reason: 'hold' } } },
      legal: { catalogTexts: { enabled: true } },
    },
    acquire: async () => { leases += 1; return null; },
    logger,
  });
  assert.deepEqual(paused, { ran: false, reason: 'paused' });
  assert.equal(leases, 0);
  assert.deepEqual(errors, ['[analytics-retention] the legal texts are on but visit statistics are not being deleted (paused)']);

  errors.length = 0;
  const quietOff = await job.runTrafficRetention({
    now: WINTER,
    settings: switchSettings({ enabled: false }),
    acquire: async () => { leases += 1; return null; },
    logger,
  });
  assert.deepEqual(quietOff, { ran: false, reason: 'off' });
  assert.equal(leases, 0);
  assert.deepEqual(errors, []);

  writeDay('warn-site', '2020-08-01', 'x\n');
  errors.length = 0;
  const shadow = await job.runTrafficRetention({
    now: WINTER,
    settings: {
      retention: { analyticsTraffic: { enabled: true, mode: 'shadow', paused: null } },
      legal: { catalogTexts: { enabled: true } },
    },
    logger,
  });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.removed, 0);
  assert.deepEqual(errors, ['[analytics-retention] the legal texts are on but visit statistics are not being deleted (shadow)']);

  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null, egress: false });
  try {
    errors.length = 0;
    const safe = await job.runTrafficRetention({
      now: WINTER,
      settings: {
        retention: { analyticsTraffic: { enabled: true, mode: 'auto', paused: null } },
        legal: { catalogTexts: { enabled: true } },
      },
      logger,
    });
    assert.equal(safe.mode, 'shadow');
    assert.equal(safe.removed, 0);
    assert.deepEqual(errors, ['[analytics-retention] the legal texts are on but visit statistics are not being deleted (safe mode)']);
  } finally {
    safeMode.resetSafeModeForTests();
  }
});

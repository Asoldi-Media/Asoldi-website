// WS9.48: the seo-ops store (lib/seo-ops/store.js) and the path-qualified backups in
// data/storage-path.js. Runs on a temp data dir with an injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-seo-ops-store-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_BACKUP_KEEP;

const storeModule = await import('../lib/seo-ops/store.js');
const storage = await import('../data/storage-path.js');
const { createSeoOpsStore, sanitizeSeoOpsKey, seoOpsSafeModeGate, RETENTION, MAX_SITE_FILE_BYTES } = storeModule;

const SITES = Number(process.env.SEO_OPS_SIM_SITES || 50);
const DAY = 24 * 60 * 60 * 1000;
const backupDir = () => join(DATA_DIR, 'backups');
const seoBackups = () => (existsSync(backupDir()) ? readdirSync(backupDir()).filter((n) => n.startsWith('seo-ops__')) : []);

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function snapshot(at, n = 10) {
  return {
    ranAt: at.toISOString(),
    cadenceDays: 7,
    costUsd: 0.0074,
    location: { type: 'city', code: 1013316, name: 'Testby' },
    keywords: Array.from({ length: n }, (_, i) => ({
      keyword: `tjeneste ${i} testby`,
      source: i < 3 ? 'agreed' : 'plan',
      depth: 20,
      organic: { position: 3 + (i % 7), url: `https://example.test/side-${i}`, prev: 4 + (i % 7) },
      maps: { position: 1 + (i % 4), prev: 2 },
      aiOverview: { present: i % 2 === 0, cited: i % 5 === 0, citedDomains: ['example.test'] },
      topCompetitors: [{ domain: 'konkurrent.test', position: 1 }, { domain: 'annen.test', position: 2 }],
    })),
  };
}

function post(at, i, site) {
  return {
    id: `bq_${site}_${i}`,
    siteKey: site,
    status: 'ready',
    cluster: `c-${i % 6}`,
    title: `Innlegg ${i} om tjenesten`,
    slug: `innlegg-${i}`,
    html: `<h2>Innlegg ${i}</h2>${'<p>Tekst om tjenesten i Testby, med råd og eksempler for kunder.</p>'.repeat(40)}`,
    excerpt: 'Kort utdrag om tjenesten.',
    seo: { title: `Innlegg ${i}`, description: 'Beskrivelse', focusKeyword: 'tjeneste testby' },
    createdAt: at.toISOString(),
  };
}

test('a simulated year for 50 sites and 50 clients stays within the file budget, and each site file stays under 2 MB', { timeout: 600_000 }, async () => {
  let clock = new Date('2025-11-03T08:00:00.000Z');
  const store = createSeoOpsStore({ now: () => clock });
  const keep = store.keep;
  assert.equal(keep, 3, 'site and client files keep 3 backups by default');
  const siteKeys = Array.from({ length: SITES }, (_, i) => `site${String(i).padStart(3, '0')}`);
  const clientIds = Array.from({ length: SITES }, (_, i) => `sc_${i}`);
  // Weekly data (a rank snapshot, three posts, a report every other week), written in batches of
  // four weeks to keep the test fast; retention and the file budget do not depend on the batch size.
  for (let batch = 0; batch < 13; batch += 1) {
    const weeks = [0, 1, 2, 3].map((w) => ({ week: batch * 4 + w, at: new Date(clock.getTime() + w * 7 * DAY) }));
    for (const key of siteKeys) {
      await store.updateSite(key, (doc) => {
        for (const { week, at } of weeks) {
          doc.ranks.snapshots.push(snapshot(at));
          for (const item of doc.blogQueue) if (item.status === 'ready') item.status = 'published';
          for (let p = 0; p < 3; p += 1) doc.blogQueue.push(post(at, week * 3 + p, key));
          if (week % 2 === 0) doc.reports.push({ kind: 'basic', period: { from: at.toISOString(), to: at.toISOString() }, summary: 'Siste 14 dager: stabilt.', generatedAt: at.toISOString() });
          if (week % 4 === 0) doc.aiVisibility.checks.push({ at: at.toISOString(), engine: 'chatgpt', keyword: 'tjeneste testby', mentioned: false, cited: false, costUsd: 0.02 });
        }
      });
    }
    for (const id of clientIds) {
      await store.updateClient(id, (doc) => {
        for (const { week, at } of weeks) {
          for (let h = 0; h < 5; h += 1) doc.history.push({ at: at.toISOString(), by: 'system', action: 'rank-sync', week, h });
        }
        doc.planSummary = { version: 2, candidates: Array.from({ length: 80 }, (_, i) => ({ keyword: `kandidat ${i}`, volCity: i })) };
      });
    }
    for (const { week, at } of weeks) {
      await store.updateGlobal('health', (doc) => { doc.updatedAt = at.toISOString(); doc.week = week; });
      await store.updateLedger(at.toISOString().slice(0, 7), (doc) => { doc.entries.push({ at: at.toISOString(), purpose: 'tracking', usd: 0.4 }); });
    }
    clock = new Date(clock.getTime() + 28 * DAY);
  }
  await store.updateGlobal('settings', (doc) => { doc.enabled = true; });
  await store.updateGlobal('linkNetwork', (doc) => { doc.rules = { enabled: false }; });

  const counted = [...filesUnder(join(DATA_DIR, 'seo-ops')), ...seoBackups()];
  const budget = SITES * 2 * (1 + keep) + 30;
  assert.ok(counted.length <= budget, `${counted.length} files, budget ${budget}`);
  assert.equal(counted.filter((f) => /\.(lock|tmp)$/.test(f)).length, 0, 'no lock or temp files left');
  for (const key of siteKeys) {
    const size = statSync(store.sitePath(key)).size;
    assert.ok(size < MAX_SITE_FILE_BYTES, `${key} is ${size} bytes`);
    const doc = store.readSite(key);
    assert.equal(doc.ranks.snapshots.length, 52);
    assert.equal(doc.reports.length, RETENTION.reports);
    assert.equal(doc.blogQueue.filter((item) => item.status === 'ready').length, 3, 'open posts are all kept');
    assert.equal(doc.blogQueue.filter((item) => item.status === 'published').length, RETENTION.blogTerminal);
    assert.ok(doc.aiVisibility.checks.length <= 13);
  }
  const client = store.readClient('sc_0');
  assert.equal(client.history.length, RETENTION.clientHistory);
  assert.equal(client.historyArchivedCount, 52 * 5 - RETENTION.clientHistory);
  assert.equal(client.planSummary.candidates.length, RETENTION.planCandidates);
  assert.equal(seoBackups().filter((n) => n.startsWith('seo-ops__health.json')).length, 0, 'health.json has no backups');

  // A year later: snapshots older than 12 months are monthly aggregates, and those go after 24 months.
  clock = new Date(clock.getTime() + 200 * DAY);
  await store.updateSite('site000', (doc) => { doc.ranks.snapshots.push(snapshot(clock)); });
  const aged = store.readSite('site000');
  assert.ok(aged.ranks.snapshots.length < 52);
  assert.ok(aged.ranks.monthly.length >= 5);
  const month = aged.ranks.monthly[0];
  assert.match(month.month, /^\d{4}-\d{2}$/);
  assert.equal(month.keywords.length, 10);
  assert.ok(Number.isFinite(month.keywords[0].avgOrganic));
  clock = new Date(clock.getTime() + 800 * DAY);
  await store.updateSite('site000', (doc) => { doc.ranks.snapshots.push(snapshot(clock)); });
  const old = store.readSite('site000');
  assert.equal(old.ranks.monthly.length, 0, 'aggregates older than 24 months are dropped');
  assert.equal(old.ranks.snapshots.length, 1);
});

test('two sites writing a report the same day keep two separate backup series', async () => {
  const store = createSeoOpsStore();
  await store.updateSite('samedaya', (doc) => { doc.reports.push({ kind: 'basic', summary: 'A' }); });
  await store.updateSite('samedayb', (doc) => { doc.reports.push({ kind: 'basic', summary: 'B' }); });
  const a = seoBackups().filter((n) => n.startsWith('seo-ops__sites__samedaya.json.'));
  const b = seoBackups().filter((n) => n.startsWith('seo-ops__sites__samedayb.json.'));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.match(readFileSync(join(backupDir(), a[0]), 'utf8'), /"summary":"A"/);
  assert.match(readFileSync(join(backupDir(), b[0]), 'utf8'), /"summary":"B"/);
  // A site and a client with the same key never share a backup series either.
  await store.updateClient('samedaya', (doc) => { doc.history.push({ action: 'note' }); });
  assert.equal(seoBackups().filter((n) => n.startsWith('seo-ops__clients__samedaya.json.')).length, 1);
  assert.equal(seoBackups().filter((n) => n.startsWith('seo-ops__sites__samedaya.json.')).length, 1);
});

test('without a qualified backup name, files with the same basename share and prune one backup series', () => {
  const dir = join(DATA_DIR, 'plain');
  mkdirSync(join(dir, 'sites'), { recursive: true });
  mkdirSync(join(dir, 'clients'), { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    storage.writeDataJson(join(dir, 'sites', 'shared-name.json'), { from: 'site', i }, { keep: 2 });
    storage.writeDataJson(join(dir, 'clients', 'shared-name.json'), { from: 'client', i }, { keep: 2 });
  }
  const shared = readdirSync(backupDir()).filter((n) => n.startsWith('shared-name.json.') && !n.endsWith('.latest.json'));
  assert.ok(shared.length <= 2, 'the two files prune each other');
  const latest = JSON.parse(readFileSync(join(backupDir(), 'shared-name.json.latest.json'), 'utf8'));
  assert.equal(latest.from, 'client', 'the site copy was overwritten');
  storage.writeDataJson(join(dir, 'sites', 'shared-name.json'), { from: 'site' }, { backupName: 'plain__sites__shared-name.json', latest: false, keep: 2 });
  assert.equal(readdirSync(backupDir()).filter((n) => n.startsWith('plain__sites__shared-name.json.')).length, 1);
  assert.equal(existsSync(join(backupDir(), 'plain__sites__shared-name.json.latest.json')), false, 'latest:false writes no .latest copy');
  // An unchanged write makes no second backup.
  storage.writeDataJson(join(dir, 'sites', 'shared-name.json'), { from: 'site' }, { backupName: 'plain__sites__shared-name.json', latest: false, keep: 2, atomic: true });
  assert.equal(readdirSync(backupDir()).filter((n) => n.startsWith('plain__sites__shared-name.json.')).length, 1);
});

test('writers of one key in this process are serialized, async writers included', async () => {
  const store = createSeoOpsStore();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.updateSite('busy', async (doc) => {
    await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
    doc.backlinkTargets.push(i);
  })));
  assert.deepEqual(store.readSite('busy').backlinkTargets.sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
});

test('a writer in another process is not lost: the file lock and the re-read keep both sets of changes', { timeout: 120_000 }, async () => {
  const store = createSeoOpsStore();
  const moduleUrl = pathToFileURL(join(process.cwd(), 'lib', 'seo-ops', 'store.js')).href;
  const script = `const { createSeoOpsStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createSeoOpsStore();
    for (let i = 0; i < 40; i += 1) await store.updateSite('shared', (doc) => { doc.backlinkTargets.push('child-' + i); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, APP_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const done = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 40; i += 1) await store.updateSite('shared', (doc) => { doc.backlinkTargets.push(`parent-${i}`); });
  assert.equal(await done, 0, err);
  const targets = store.readSite('shared').backlinkTargets;
  assert.equal(targets.filter((t) => t.startsWith('parent-')).length, 40);
  assert.equal(targets.filter((t) => t.startsWith('child-')).length, 40);
});

test('a broken file stops the update and is left as it was; null from the updater writes nothing', async () => {
  const store = createSeoOpsStore();
  mkdirSync(join(DATA_DIR, 'seo-ops', 'sites'), { recursive: true });
  writeFileSync(store.sitePath('broken'), '{ not json');
  await assert.rejects(store.updateSite('broken', (doc) => { doc.reports.push({}); }), (error) => error.code === 'corrupt');
  assert.equal(readFileSync(store.sitePath('broken'), 'utf8'), '{ not json');
  const before = seoBackups().length;
  const result = await store.updateSite('untouched', () => null);
  assert.equal(result.siteKey, 'untouched');
  assert.equal(existsSync(store.sitePath('untouched')), false);
  assert.equal(seoBackups().length, before);
  await assert.rejects(store.updateSite('notobject', () => 'text'), (error) => error.code === 'invalid-doc');
});

test('keys are made file-safe: plain keys stay, others are cleaned and get a hash, and never leave the folder', () => {
  assert.equal(sanitizeSeoOpsKey('0f3a9c_site-key'), '0f3a9c_site-key');
  const odd = sanitizeSeoOpsKey('Kunde A/B');
  assert.match(odd, /^kunde_a_b-[0-9a-f]{10}$/);
  assert.notEqual(sanitizeSeoOpsKey('Kunde A/B'), sanitizeSeoOpsKey('kunde a b'));
  const escape = sanitizeSeoOpsKey('../../etc/passwd');
  assert.match(escape, /^[a-z0-9_-]+$/);
  const store = createSeoOpsStore();
  assert.ok(store.sitePath('../../etc/passwd').startsWith(join(DATA_DIR, 'seo-ops', 'sites')));
  assert.throws(() => sanitizeSeoOpsKey('  '), (error) => error.code === 'invalid-key');
});

test('ledger months are kept for 13 months, and only the current month keeps backups', async () => {
  let clock = new Date('2026-01-15T00:00:00.000Z');
  const store = createSeoOpsStore({ now: () => clock });
  for (let m = 0; m < 16; m += 1) {
    const month = clock.toISOString().slice(0, 7);
    await store.updateLedger(month, (doc) => { doc.entries.push({ usd: 1 }); });
    await store.updateLedger(month, (doc) => { doc.entries.push({ usd: 2 }); });
    clock = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + 1, 15));
  }
  const ledgers = readdirSync(join(DATA_DIR, 'seo-ops')).filter((n) => n.startsWith('dfs-ledger-')).sort();
  assert.equal(ledgers.length, RETENTION.ledgerMonths);
  assert.equal(ledgers[0], 'dfs-ledger-2026-04.json');
  assert.equal(ledgers.at(-1), 'dfs-ledger-2027-04.json');
  const ledgerBackups = seoBackups().filter((n) => n.startsWith('seo-ops__dfs-ledger-'));
  assert.ok(ledgerBackups.length > 0 && ledgerBackups.every((n) => n.startsWith('seo-ops__dfs-ledger-2027-04.json.')), ledgerBackups.join(', '));
  assert.deepEqual(store.readLedger('2027-04').entries, [{ usd: 1 }, { usd: 2 }]);
  assert.throws(() => store.readLedger('2027-4'), (error) => error.code === 'invalid-key');
});

test('settings fill in the defaults; the safe-mode gate runs only allow-listed sites while hub safe mode is on', async () => {
  const store = createSeoOpsStore();
  const settings = store.readSettings();
  assert.deepEqual(settings.safeMode, { allowSites: [], spendCapUsd: 1, live: false });
  assert.equal(settings.linkNetwork.enabled, false);
  await store.updateGlobal('settings', (doc) => { doc.safeMode = { allowSites: ['canary'], live: false }; });
  const saved = store.readSettings();
  assert.deepEqual(saved.safeMode, { allowSites: ['canary'], spendCapUsd: 1, live: false }, 'defaults fill missing fields');
  assert.equal(saved.budgets.monthlyUsd, 20);
  assert.deepEqual(seoOpsSafeModeGate('anything', { settings: saved, safeMode: false }).allowed, true);
  const blocked = seoOpsSafeModeGate('other', { settings: saved, safeMode: true });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /allowSites/);
  const canary = seoOpsSafeModeGate('canary', { settings: saved, safeMode: true });
  assert.deepEqual([canary.allowed, canary.live, canary.spendCapUsd], [true, false, 1]);
  const live = seoOpsSafeModeGate('canary', { settings: { safeMode: { allowSites: ['canary'], live: true } }, safeMode: true });
  assert.equal(live.live, true);
  // The store reads the process safe mode (off in this test process).
  assert.equal(store.safeModeGate('other').allowed, true);
});

test('deleting a site removes its file and every backup of it', async () => {
  const store = createSeoOpsStore();
  await store.updateSite('gone', (doc) => { doc.reports.push({ summary: 'one' }); });
  await store.updateSite('gone', (doc) => { doc.reports.push({ summary: 'two' }); });
  assert.ok(seoBackups().some((n) => n.startsWith('seo-ops__sites__gone.json.')));
  assert.deepEqual(await store.deleteSite('gone'), { removed: true });
  assert.equal(existsSync(store.sitePath('gone')), false);
  assert.equal(seoBackups().filter((n) => n.startsWith('seo-ops__sites__gone.json')).length, 0);
  assert.ok(store.listSites().includes('busy'));
  assert.equal(store.listSites().includes('gone'), false);
});

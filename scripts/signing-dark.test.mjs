// With the signing switch off, this build answers and writes exactly what an older build does.
// Boots this tree and the build in SIGNING_DARK_BASE_DIR (a checkout of the commit to compare with,
// with its dependencies installed) on the same seed (scripts/fixtures/signing-seed.mjs), runs every
// signing flow (scripts/fixtures/signing-flows.mjs) on both, and compares the responses, every
// /api/hub/site-config answer, the safe-mode outbox and every file in the data folder, after replacing
// times, generated ids, keys and tokens with placeholders. Skipped when SIGNING_DARK_BASE_DIR is unset.
//
// SIGNING_DARK_BASE_DIR=<checkout> node --test scripts/signing-dark.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEAD = resolve(HERE, '..');
const BASE = String(process.env.SIGNING_DARK_BASE_DIR || '').trim();
const skip = !BASE ? 'SIGNING_DARK_BASE_DIR is not set' : (!existsSync(join(BASE, 'server.js')) ? `${BASE} has no server.js` : false);

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-signing-dark-modules-'));
const flows = await import('./fixtures/signing-flows.mjs');
// Auto needs a recorded release pass (lib/spine-mode.js); settings in auto hold the passes.
const { testReleases } = await import('./fixtures/test-releases.mjs');

// Files that differ between any two boots of the same build (process logs, the egress recorder).
const VOLATILE = [/^egress\.jsonl$/, /\.log$/, /^logs\//, /^http-requests/, /^secrets\//, /^security-events/, /^runtime-/];

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
export function normalizeText(text) {
  return String(text)
    .replace(ISO, '<time>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, '<time>')
    .replace(/\d{8}[Tt]\d{6,9}[Zz]/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<day>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\bmem_[a-z0-9]+_[0-9a-f]+\b/g, '<membership>')
    .replace(/_NmP-[0-9a-f]+-Part_/g, '_NmP-<boundary>-Part_')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}\b/g, '<mail-date>')
    .replace(/eyJ[\w-]+(?:\.[\w-]+)*/g, '<token>')
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '<bcrypt>')
    .replace(/\b[0-9a-f]{32,64}\b/g, '<hex>')
    .replace(/\b\d{13}(?:-[a-z0-9]{4,8})?\b/g, '<id>')
    .replace(/\b[A-Z]{2}\d{2}\b/g, '<code>')
    .replace(/\b17\d{8,11}\b/g, '<ms>')
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, '<date>');
}

function normalizeValue(value) {
  return JSON.parse(normalizeText(JSON.stringify(value)));
}

function listFiles(dir, prefix = '') {
  const out = [];
  if (!existsSync(join(dir, prefix))) return out;
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function withoutDataDir(text, dir) {
  let out = String(text);
  for (const form of [dir, JSON.stringify(dir).slice(1, -1), dir.replace(/\\/g, '/')]) out = out.split(form).join('<data>');
  return out;
}

// Files whose names normalize to the same key (outbox mails) are compared as a sorted list. Timed
// backups hold intermediate states, whose order depends on mails sent without waiting, so only their
// number (one per write) is compared; the stores themselves are compared in full.
function dataSnapshot(dir) {
  const groups = {};
  for (const rel of listFiles(dir)) {
    if (VOLATILE.some((re) => re.test(rel))) continue;
    const key = normalizeText(rel);
    const raw = readFileSync(join(dir, rel));
    const text = /\.pdf$/i.test(rel) ? `<pdf ${raw.length > 0}>` : raw.toString('utf8');
    (groups[key] ||= []).push(normalizeText(withoutDataDir(text, dir)));
  }
  return Object.fromEntries(Object.entries(groups).map(([key, values]) => [
    key,
    /^backups\/.+\.<time>\.json$/.test(key) ? `${values.length} timed backups` : values.sort().join('\n'),
  ]));
}

async function runBuild(repo, seedDir, seed, { settings = null } = {}) {
  const { bootHub } = await import(pathToFileURL(join(repo, 'scripts', 'safe-mode', 'hub-boot.mjs')).href);
  const hub = await bootHub(flows.BOOT_ENV, {
    seed: (dir) => {
      cpSync(seedDir, dir, { recursive: true });
      if (settings) writeFileSync(join(dir, 'automation-settings.json'), JSON.stringify(settings));
    },
  });
  try {
    assert.equal(hub.health?.safeMode, true, hub.log().slice(-2000));
    const token = await hub.adminToken(seed.admin.username, seed.admin.password);
    assert.ok(token);
    const steps = await flows.runSigningFlows(hub, seed, { token });
    await new Promise((r) => setTimeout(r, 2000));
    await flows.settledOutbox(hub.dataDir);
    const configs = await flows.siteConfigs(hub);
    return { steps: normalizeValue(steps), configs: normalizeValue(Object.values(configs)), data: dataSnapshot(hub.dataDir) };
  } finally {
    await hub.stop();
  }
}

function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

test('switch off: every flow, every site-config answer and the data folder match the base build', { skip, timeout: 600_000 }, async () => {
  const seedDir = mkdtempSync(join(tmpdir(), 'asoldi-signing-dark-seed-'));
  try {
    const seed = flows.seedSigningData(seedDir);
    const base = await runBuild(resolve(BASE), seedDir, seed);
    const head = await runBuild(HEAD, seedDir, seed);
    for (const name of Object.keys(base.steps)) {
      assert.deepEqual(head.steps[name], base.steps[name], `step ${name}`);
    }
    assert.deepEqual(Object.keys(head.steps), Object.keys(base.steps));
    assert.deepEqual(head.configs, base.configs, 'site-config answers');
    const changed = diffKeys(base.data, head.data);
    const around = (a, b) => {
      const left = String(a ?? '(missing)');
      const right = String(b ?? '(missing)');
      let at = 0;
      while (at < left.length && left[at] === right[at]) at += 1;
      const from = Math.max(0, at - 300);
      return `\nbase: ${left.slice(from, at + 300)}\nhead: ${right.slice(from, at + 300)}`;
    };
    const detail = changed.slice(0, 6).map((key) => `\n--- ${key}${around(base.data[key], head.data[key])}`).join('');
    assert.deepEqual(changed, [], `data files that differ: ${changed.join(', ')}${detail}`);
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('control: with the switch on, the same comparison reports the differences', { skip, timeout: 600_000 }, async () => {
  const seedDir = mkdtempSync(join(tmpdir(), 'asoldi-signing-dark-control-'));
  try {
    const seed = flows.seedSigningData(seedDir);
    const pilots = Object.values(seed.clients);
    const base = await runBuild(resolve(BASE), seedDir, seed);
    const head = await runBuild(HEAD, seedDir, seed, { settings: { pilotClientIds: pilots, releases: testReleases(), signing: { enabled: true, mode: 'auto', paused: null } } });
    const changed = diffKeys(base.data, head.data);
    assert.ok(changed.includes('sales-clients.json'), `sales-clients.json differs (${changed.join(', ')})`);
    assert.ok(changed.includes('sites.json'), 'sites.json differs');
    assert.ok(changed.some((key) => key.startsWith('delivery-audit/')), 'the delivery audit is new');
    assert.notDeepEqual(head.steps['progression-dual'], base.steps['progression-dual'], 'the dual-offer tick answers differently');
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
});

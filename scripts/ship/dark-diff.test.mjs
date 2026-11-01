// Dark-diff self-tests. The unit tests cover the normalizer, the intended file, the secret and
// rollback checks and the route inventory parser. The boot tests run the real harness on data
// seeded by scripts/golden/seed-hub.mjs from invented fixtures (example.com, no phone numbers):
//   - the same release on both sides gives no difference, with --secrets and --rollback;
//   - a seeded behaviour change (a response and a new public route) is reported, and the run exits 1
//     when the intended file omits it;
//   - a release that writes a secret file at boot fails --secrets;
//   - an older release that drops a field on boot fails --rollback unless the field is listed.
//
//   node --test scripts/ship/dark-diff.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, extractRoutes, findLinks, globToRegExp, isTimeKey, loadIntended, makeTextScrubber, normalizeString,
  normalizeValue, probePath, rollbackLosses, secretViolations, snapshotData, diffSnapshots,
} from './dark-diff-lib.mjs';
import {
  addFakeSecrets, controlRefusals, HarnessError, linkNodeModules, main, materializeRef, parseArgs, pick, readSecretNames, removeLink,
  REPO, rollbackStatusDifferences, runDarkDiff,
} from './dark-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(REPO, 'node_modules');
const canBoot = existsSync(join(NODE_MODULES, 'express'));

/* ------------------------------------------------------------------ unit tests */

test('normalization: times, dates, random ids, codes, hashes and temp paths read alike across runs', () => {
  const scrubA = makeTextScrubber([['C:\\tmp\\run-a', '<data>']]);
  const scrubB = makeTextScrubber([['C:\\tmp\\run-b', '<data>']]);
  const a = normalizeValue({
    id: '1793491730403-d1i9ec', offer: 'offer-1793491728211-mod6h6', member: 'mem_mvx2d98z_72131615', at: 1793491730948,
    createdAt: '2026-11-01T10:15:00.123Z', snapshot: 'batch-2-20261031t230010045z', code: 'YA58',
    text: 'Koden din er YA58, møtet er kl. 10:00 den 1. november 2026.', hash: `$2b$12$${'a'.repeat(53)}`,
    file: 'C:\\tmp\\run-a\\outbox\\x.eml', uuid: '0f8fad5b-d9cb-469f-a165-70867728950e', tier: 'tier-1-standard',
    mail: 'owner@example.com', list: [{ n: 2 }, { n: 1 }],
  }, { scrub: scrubA });
  const b = normalizeValue({
    id: '1793491999999-zz9xk2', offer: 'offer-1793491999998-abc123', member: 'mem_mvx2dkmb_7fceecea', at: 1793492000000,
    createdAt: '2026-11-01T10:15:31.999Z', snapshot: 'batch-2-20261031t230027985z', code: 'QK31',
    text: 'Koden din er QK31, møtet er kl. 10:00 den 1. november 2026.', hash: `$2b$12$${'b'.repeat(53)}`,
    file: 'C:\\tmp\\run-b\\outbox\\x.eml', uuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', tier: 'tier-1-standard',
    mail: 'owner@example.com', list: [{ n: 1 }, { n: 2 }],
  }, { scrub: scrubB });
  assert.deepEqual(a, b);
  assert.equal(a.tier, 'tier-1-standard', 'plain ids such as tier names stay');
  assert.equal(a.mail, 'owner@example.com');
  const changed = normalizeValue({ tier: 'tier-2-seo' }, { scrub: scrubA });
  assert.notDeepEqual(changed, normalizeValue({ tier: 'tier-1-standard' }, { scrub: scrubA }), 'a real value change stays visible');
});

test('ids stamped from the clock normalize alike even when their time part is all letters', () => {
  // At 2026-11-01T04:00Z, Date.now().toString(36) starts "mvxa": a time part without a digit.
  const start = Date.parse('2026-11-01T04:00:00Z');
  const run = makeTextScrubber([], { clockWindow: [start - 3_600_000, start + 48 * 3_600_000] });
  const plain = makeTextScrubber([]);
  for (const scrub of [run, plain]) {
    assert.equal(normalizeString('mem_mvxaxykl_df1b74a2', scrub), normalizeString('mem_mvxaxzla_9a3ae486', scrub));
    assert.equal(normalizeString('biz_mvxaxykl_abcdef', scrub), 'biz_<id>', 'a hex part without a digit is still hex');
    assert.equal(normalizeValue({ id: 'mem_mvxaxykl_df1b74a2' }, { scrub }).id, 'mem_<id>');
  }
  // Without a random suffix the clock window decides: an id from inside the run is random...
  assert.equal(normalizeString('job_mvxaxykl', run), 'job_<id>');
  assert.equal(normalizeString('em_MVXAXYKLADCFEBBA', run), 'em_<id>');
  // ...and the same shape outside it is kept, as are plain words after a prefix.
  assert.equal(normalizeString('job_mvxaxykl', plain), 'job_mvxaxykl');
  for (const text of ['tier-standard', 'page-location', 'site-language', 'status-november', 'tier-1-standard']) {
    assert.equal(normalizeString(text, run), text, text);
  }
  assert.equal(normalizeString('page-location-x1y2z3a4', run), 'page-location-<id>', 'a part that is not random can still prefix one');
  // Tokens: random base64url without a digit is a token; a long camelCase name is not.
  assert.equal(normalizeString('QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy_-AbC', plain), '<token>');
  assert.equal(normalizeString('createHubSecretHolderWithFallbackValue', plain), 'createHubSecretHolderWithFallbackValue');
});

test('time keys are whole words or camelCase / snake_case suffixes; counts and amounts keep their numbers', () => {
  for (const key of ['at', 'ts', 'exp', 'iat', 'nbf', 'mtimeMs', 'createdAt', 'updated_at', 'expiresAt', 'sentTs', 'lastSeenAt', 'startDate', 'createdAtMs', 'until']) {
    assert.equal(isTimeKey(key), true, key);
  }
  for (const key of ['attempts', 'counts', 'items', 'limits', 'slots', 'seats', 'credits', 'points', 'vat', 'lat', 'update', 'format', 'stats', 'rate']) {
    assert.equal(isTimeKey(key), false, key);
  }
  const a = normalizeValue({ attempts: 3, counts: 5, items: 2, vat: 25, limits: 7, slots: 4, seats: 1, credits: 10, points: 3, lat: 59, createdAt: 1793491730948, sentTs: 17 });
  const b = normalizeValue({ attempts: 9, counts: 0, items: 7, vat: 0, limits: 99, slots: 2, seats: 3, credits: 0, points: 8, lat: 60, createdAt: 1793499999999, sentTs: 18 });
  const keys = Object.keys(a).filter((key) => a[key] !== b[key]).sort();
  assert.deepEqual(keys, ['attempts', 'counts', 'credits', 'items', 'lat', 'limits', 'points', 'seats', 'slots', 'vat'], 'every count or amount change stays visible; only the times read alike');
});

test('the intended file: globs over difference keys, ignore entries, unused entries are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dark-diff-intended-'));
  try {
    const file = join(dir, 'intended.json');
    writeFileSync(file, JSON.stringify({
      changes: [{ kind: 'route', match: 'route GET /api/new/*', reason: 'new route' }, { match: 'response never-seen*' }],
      ignore: ['data logs/*'],
      allowNewSecrets: ['secrets/new-key'],
      rollbackLost: ['rollback sites.json:*.oldField'],
    }));
    const intended = loadIntended(file);
    const diffs = [
      { kind: 'route', key: 'route GET /api/new/thing', detail: 'answers differently' },
      { kind: 'data', key: 'data logs/today.jsonl rows', detail: 'rows' },
      { kind: 'response', key: 'response flow#1 GET /x body.y', detail: 'differs' },
      { kind: 'data', key: 'route GET /api/new/thing', detail: 'kind must match too' },
    ];
    const out = classify(diffs, intended);
    assert.deepEqual(out.listed.map((d) => d.key), ['route GET /api/new/thing', 'data logs/today.jsonl rows']);
    assert.deepEqual(out.unlisted.map((d) => d.key), ['response flow#1 GET /x body.y', 'route GET /api/new/thing']);
    assert.deepEqual(out.unused, ['response never-seen*']);
    assert.equal(globToRegExp('a*c').test('abbbc'), true);
    assert.equal(globToRegExp('a?c').test('abbc'), false);
    assert.deepEqual(loadIntended(''), { changes: [], ignore: [], allowNewSecrets: [], rollbackLost: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret check: changed, removed and new files are reported by path, never by value', () => {
  const source = { 'secrets/admin-secret': 'h1', 'secrets/webhooks.json': 'h2' };
  assert.deepEqual(secretViolations(source, { ...source }), []);
  const out = secretViolations(source, { 'secrets/admin-secret': 'h9', 'secrets/new-one': 'h3' }, { stage: 'head after boot' });
  assert.deepEqual(out.map((v) => v.key).sort(), ['secret secrets/admin-secret changed', 'secret secrets/new-one new', 'secret secrets/webhooks.json removed']);
  assert.ok(out.every((v) => !/h\d/.test(JSON.stringify(v))));
});

test('rollback check: a dropped field is lost, a reorder is not, a reserved key may not change', () => {
  const written = { 'sites.json': [{ id: 's1', domain: 'a.example', ext: { x: 1 }, extra: 'kept?' }, { id: 's2', domain: 'b.example' }] };
  assert.deepEqual(rollbackLosses(written, { 'sites.json': [written['sites.json'][1], written['sites.json'][0]] }), []);
  const after = { 'sites.json': [{ id: 's2', domain: 'b.example' }, { id: 's1', domain: 'a.example', ext: { x: 2 } }] };
  const losses = rollbackLosses(written, after).map((l) => `${l.key}: ${l.detail}`);
  assert.deepEqual(losses.sort(), ['rollback sites.json:$.id=s1.ext.x: reserved field changed', 'rollback sites.json:$.id=s1.extra: field lost']);
  assert.deepEqual(rollbackLosses({ 'gone.json': { a: 1 } }, {}).map((l) => l.detail), ['file lost']);
});

test('rollback check with a control: only what head keeps and base drops is lost', () => {
  const written = {
    'sales-clients.json': [{ id: 'c1', industry: 'bakery', meetings: [{ id: 'm1' }], delivery: { stage: 'a', at: '2026-11-01T04:00:00.000Z' } }],
    'gone-in-both.json': { a: 1 },
  };
  // Head itself unlinks the meeting and moves the stage (the flows did it); base does the same and
  // also drops industry from a record it saved.
  const control = { 'sales-clients.json': [{ id: 'c1', industry: 'bakery', meetings: [], delivery: { stage: 'b', at: '2026-11-01T05:00:00.000Z' } }, { id: 'c2' }] };
  const after = { 'sales-clients.json': [{ id: 'c1', meetings: [], delivery: { stage: 'b', at: '2026-11-01T05:00:07.000Z' } }, { id: 'c3' }] };
  const losses = rollbackLosses(written, after, { control }).map((l) => `${l.key}: ${l.detail}`);
  assert.deepEqual(losses, ['rollback sales-clients.json:$.id=c1.industry: field lost']);
  // A reserved key that base moves differently from head is reported.
  const moved = { 'sales-clients.json': [{ id: 'c1', industry: 'bakery', meetings: [], delivery: { stage: 'c', at: '2026-11-01T05:00:00.000Z' } }] };
  assert.deepEqual(rollbackLosses(written, moved, { control }).map((l) => `${l.key}: ${l.detail}`), ['rollback sales-clients.json:$.id=c1.delivery.stage: reserved field changed']);
  // A field base drops and then writes back empty is a changed value: head left it as it was.
  const emptied = { 'sales-clients.json': [{ id: 'c1', industry: '', meetings: [], delivery: { stage: 'b', at: '2026-11-01T05:00:03.000Z' } }] };
  assert.deepEqual(rollbackLosses(written, emptied, { control }).map((l) => `${l.key}: ${l.detail}`), ['rollback sales-clients.json:$.id=c1.industry: value changed']);
  // Without a control, only presence and reserved keys are checked (a value change is not judged).
  assert.deepEqual(rollbackLosses(written, emptied).map((l) => l.detail).filter((d) => d === 'value changed'), []);
});

test('rollback statuses: base must answer what head answers on the same data; a tick route base lacks is skipped', () => {
  const head = {
    flows: [{ key: 'f#0', method: 'POST', path: '/x', status: 201 }, { key: 'f#1', method: 'GET', path: '/y', status: 200 }],
    replay: [{ key: 'f#1 replay', method: 'GET', path: '/y', status: 200 }],
    siteConfig: [{ key: 'a.example by-key', status: 200 }],
    ticks: [{ key: 'POST /tick #0', status: 200 }, { key: 'POST /tick #1', status: 200 }],
  };
  const same = JSON.parse(JSON.stringify(head));
  same.ticks = [{ key: 'POST /tick #0', status: 404 }];
  assert.deepEqual(rollbackStatusDifferences(same, head), []);
  const broken = JSON.parse(JSON.stringify(same));
  broken.replay[0].status = 500;
  broken.siteConfig[0].status = 502;
  const keys = rollbackStatusDifferences(broken, head).map((d) => d.key).sort();
  assert.deepEqual(keys, ['rollback replay f#1 replay GET /y status', 'rollback site-config a.example by-key server error', 'rollback site-config a.example by-key status']);
});

test('a rollback pass where head itself is refused what its run accepted does not count as a pass', () => {
  const headFlows = [{ key: 'f#0', method: 'POST', path: '/x', status: 201 }, { key: 'f#1', method: 'GET', path: '/y', status: 200 }, { key: 'g#0', method: 'GET', path: '/z', skipped: 'missing id' }];
  assert.deepEqual(controlRefusals(headFlows, { login: 200, flows: [{ key: 'f#0', status: 201 }, { key: 'f#1', status: 200 }, { key: 'g#0', skipped: 'missing id' }], replay: [{ key: 'f#1 replay', status: 200 }] }), []);
  // Every step refused on both sides would compare equal: the control check catches it.
  const refused = controlRefusals(headFlows, { login: 200, flows: [{ key: 'f#0', method: 'POST', path: '/x', status: 401 }, { key: 'f#1', method: 'GET', path: '/y', skipped: 'missing clientId' }], replay: [{ key: 'f#1 replay', method: 'GET', path: '/y', status: 403 }] });
  assert.deepEqual(refused, ['f#0 POST /x: 401', 'f#1 GET /y: skipped (missing clientId)', 'f#1 replay GET /y: 403']);
  assert.deepEqual(controlRefusals(headFlows, { login: 401, flows: [], replay: [] }), ['admin sign-in answered 401']);
});

test('a data dir with a symbolic link or junction is refused before anything is copied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dark-diff-links-'));
  try {
    const data = join(root, 'data');
    const outside = join(root, 'outside');
    mkdirSync(join(data, 'media'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(data, 'sites.json'), '[]');
    linkNodeModules(join(data, 'media'), outside);
    assert.deepEqual(findLinks(data), ['media/node_modules']);
    await assert.rejects(runDarkDiff({ base: 'HEAD', head: 'HEAD', data }), (error) => error instanceof HarnessError && /links or junctions \(media\/node_modules\)/.test(error.message));
    assert.equal(await main(['--base', 'HEAD', '--head', 'HEAD', '--data', data]), 2);
    // A skipped top-level folder is never copied, so its links do not matter (the run then stops later, for another reason).
    await assert.rejects(runDarkDiff({ base: 'HEAD', head: 'HEAD', data, skipData: ['media'], flows: join(root, 'no-flows') }), /no flows folder/);
    assert.equal(removeLink(join(data, 'media', 'node_modules')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--secret-names: every name of a names-only listing gets a fake file or folder; bad names are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'dark-diff-secret-names-'));
  try {
    const list = join(root, 'names.txt');
    writeFileSync(list, '# names only\nadmin-secret\nsecrets/old-signing-key\narchive/\narchive/2025-key\r\nwebhooks.json\n');
    const names = readSecretNames(list);
    assert.deepEqual(names.map((n) => `${n.name}${n.folder ? '/' : ''}`), ['admin-secret', 'old-signing-key', 'archive/', 'archive/2025-key', 'webhooks.json']);
    const data = join(root, 'data');
    mkdirSync(join(data, 'secrets'), { recursive: true });
    writeFileSync(join(data, 'secrets', 'admin-secret'), 'kept\n');
    assert.deepEqual(addFakeSecrets(data, names).sort(), ['archive/2025-key', 'old-signing-key', 'webhooks.json']);
    assert.equal(readFileSync(join(data, 'secrets', 'admin-secret'), 'utf8'), 'kept\n');
    assert.match(readFileSync(join(data, 'secrets', 'old-signing-key'), 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.ok(JSON.parse(readFileSync(join(data, 'secrets', 'webhooks.json'), 'utf8')).fireflies, 'a known name keeps its shape');
    for (const bad of ['../outside', '/etc/passwd', 'a/../../b', 'C:\\x']) {
      writeFileSync(list, `${bad}\n`);
      assert.throws(() => readSecretNames(list), /refused name/, bad);
    }
    assert.equal(parseArgs(['--base', 'a', '--head', 'b', '--data', 'd', '--secret-names', list]).fakeSecrets, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data snapshots: secret folders compare by presence; a changed value is found', () => {
  const root = mkdtempSync(join(tmpdir(), 'dark-diff-snap-'));
  try {
    for (const side of ['a', 'b']) {
      mkdirSync(join(root, side, 'secrets'), { recursive: true });
      writeFileSync(join(root, side, 'secrets', 'admin-secret'), side === 'a' ? 'x'.repeat(64) : 'y'.repeat(64));
      writeFileSync(join(root, side, 'sites.json'), JSON.stringify([{ id: side === 'a' ? 'site_k2j3h4g5a1' : 'site_z9x8c7v6b5', domain: 'a.example', createdAt: `2026-11-0${side === 'a' ? 1 : 2}T00:00:00Z` }]));
      writeFileSync(join(root, side, 'log.jsonl'), '{"at":"2026-11-01T00:00:00Z","kind":"x"}\n');
    }
    const scrub = makeTextScrubber([]);
    assert.deepEqual(diffSnapshots(snapshotData(join(root, 'a'), { scrub }), snapshotData(join(root, 'b'), { scrub })), []);
    writeFileSync(join(root, 'b', 'sites.json'), JSON.stringify([{ id: 'site_z9x8c7v6b5', domain: 'c.example', createdAt: '2026-11-02T00:00:00Z' }]));
    const diffs = diffSnapshots(snapshotData(join(root, 'a'), { scrub }), snapshotData(join(root, 'b'), { scrub }));
    assert.ok(diffs.some((d) => d.key === 'data sites.json $[0].domain'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route inventory parser: literal routes of a hub tree, probe paths for parameters', () => {
  const routes = extractRoutes(REPO);
  const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  assert.ok(keys.has('GET /api/hub/site-config'));
  assert.ok(keys.has('POST /api/admin/login'));
  assert.ok(routes.length > 100);
  assert.equal(probePath('/api/admin/sales/:id/offer/:kind?'), '/api/admin/sales/dark-diff-probe/offer/dark-diff-probe');
  assert.equal(probePath('/sales-preview/:id/*'), '/sales-preview/dark-diff-probe/dark-diff-probe');
});

test('arguments: the three inputs are required; unknown options are refused', () => {
  assert.throws(() => parseArgs(['--base', 'a', '--head', 'b']), /--data is required/);
  assert.throws(() => parseArgs(['--base', 'a', '--head', 'b', '--data', 'd', '--bogus']), /unknown option/);
  const opts = parseArgs(['--base', 'a', '--head', 'b', '--data', 'd', '--intended', 'i.json', '--secrets', '--rollback']);
  assert.equal(opts.secrets && opts.rollback, true);
  assert.deepEqual(parseArgs(['--base', 'a', '--head', 'b', '--data', 'd', '--skip-data', 'media, recordings']).skipData, ['media', 'recordings']);
  assert.equal(pick({ status: 200, json: { a: [{ b: 'x' }] } }, 'body.a.0.b'), 'x');
});

test('a git ref is checked out through a private index; the repository state is left as it is', { skip: !existsSync(join(REPO, '.git')) }, () => {
  const before = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
  const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dest = mkdtempSync(join(tmpdir(), 'dark-diff-tree-'));
  try {
    const tree = materializeRef(REPO, 'HEAD', join(dest, 'head'));
    assert.equal(tree.commit, head);
    assert.ok(existsSync(join(dest, 'head', 'server.js')));
    assert.equal(execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }), before);
    assert.equal(execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
    assert.throws(() => materializeRef(REPO, 'no-such-ref-for-dark-diff', join(dest, 'x')), /not a commit/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('--fake-secrets fills only the missing live secret files, with random values', () => {
  const root = mkdtempSync(join(tmpdir(), 'dark-diff-fake-secrets-'));
  try {
    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'admin-secret'), 'kept-as-it-is\n');
    const added = addFakeSecrets(root);
    assert.deepEqual(added.sort(), ['email-unsub-key', 'email-webhook-token', 'maker-callback-token', 'webhooks.json']);
    assert.equal(readFileSync(join(root, 'secrets', 'admin-secret'), 'utf8'), 'kept-as-it-is\n');
    assert.match(readFileSync(join(root, 'secrets', 'maker-callback-token'), 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.match(JSON.parse(readFileSync(join(root, 'secrets', 'webhooks.json'), 'utf8')).fireflies.secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(addFakeSecrets(root), [], 'a second call adds nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dependency link is removed without touching its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'dark-diff-link-'));
  try {
    const target = join(root, 'deps');
    mkdirSync(join(target, 'pkg'), { recursive: true });
    writeFileSync(join(target, 'pkg', 'index.js'), 'export {}');
    mkdirSync(join(root, 'tree'));
    assert.equal(linkNodeModules(join(root, 'tree'), target), true);
    assert.ok(existsSync(join(root, 'tree', 'node_modules', 'pkg', 'index.js')));
    assert.equal(removeLink(join(root, 'tree', 'node_modules')), true);
    assert.equal(existsSync(join(root, 'tree', 'node_modules')), false);
    assert.ok(existsSync(join(target, 'pkg', 'index.js')), 'the dependency folder is intact');
    assert.equal(removeLink(target), false, 'a real folder is never removed as a link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ boot self-tests */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.local-data', 'tmp', 'local', '.builds']);

/** A copy of this hub tree (no dependencies, data or build output), optionally patched. */
function copyTree(dest, patch = null) {
  cpSync(REPO, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(REPO, src);
      return !rel || !SKIP_DIRS.has(rel.split(sep)[0]);
    },
  });
  if (patch) {
    const files = { 'server.js': { replace: patch.replace || [], append: patch.append }, ...(patch.files || {}) };
    for (const [rel, edit] of Object.entries(files)) {
      const file = join(dest, ...rel.split('/'));
      let text = readFileSync(file, 'utf8');
      for (const [anchor, replacement] of edit.replace || []) {
        assert.ok(text.includes(anchor), `${rel} anchor missing: ${anchor.slice(0, 60)}`);
        text = text.replace(anchor, replacement);
      }
      if (edit.append) text += `\n${edit.append}\n`;
      writeFileSync(file, text);
    }
  }
  // Linked here, not by the harness: two runs may share a tree, and each run unlinks what it linked.
  linkNodeModules(dest, NODE_MODULES);
  return `dir:${dest}`;
}

function fixtureSet(root) {
  const dir = join(root, 'fixtures');
  const clients = [
    { id: 'demo-bakery', businessName: 'Example Bakery AS', contactEmail: 'owner@example.com', domain: 'bakery.example', offer: 'sent' },
    { id: 'demo-garage', businessName: 'Example Garage AS', contactEmail: 'garage@example.com', domain: '', offer: 'none' },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, clients: clients.map((c) => ({ id: c.id, kind: 'synthetic', tier: 'tier-1-standard', lang: 'nb' })) }));
  for (const c of clients) {
    const cdir = join(dir, c.id);
    mkdirSync(join(cdir, 'transcripts'), { recursive: true });
    writeFileSync(join(cdir, 'client.json'), JSON.stringify({
      version: 1, id: c.id, kind: 'synthetic', label: c.businessName,
      salesClient: { id: `golden_${c.id}`, businessName: c.businessName, contactPerson: 'Kari Example', contactEmail: c.contactEmail, contactPhone: '', industry: 'bakery', websiteDomain: c.domain || null, status: 'active' },
      sitePlan: { version: 1, status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5 },
      offer: { status: c.offer, title: 'Nettside', summary: 'Tier 1 website.' },
    }));
    writeFileSync(join(cdir, 'transcripts.json'), JSON.stringify({ version: 1, client: c.id, meetings: { sales: { storage: 'inline', file: 'transcripts/sales.txt', date: '2026-10-20', language: 'nb' }, workshop: null } }));
    writeFileSync(join(cdir, 'transcripts', 'sales.txt'), 'Selger: Hei, hva trenger dere?\nKunde: En enkel nettside med menyen vår.\nSelger: Det ordner vi.\n');
  }
  return dir;
}

/** Seeded data plus a secrets folder shaped like the live one (fake values). */
function seedData(root) {
  const dataDir = join(root, '.local-data', 'seed');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(APP_DATA_DIR|DATA_DIR|GOLDEN_|HUB_SAFE_MODE|ADMIN_)/.test(key)) delete env[key];
  const cwd = mkdtempSync(join(tmpdir(), 'dark-diff-seed-cwd-'));
  const out = spawnSync(process.execPath, [join(REPO, 'scripts', 'golden', 'seed-hub.mjs'), '--data-dir', dataDir, '--clients', 'all', '--fixtures-dir', fixtureSet(root)], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(out.status, 0, out.stderr);
  const secrets = join(dataDir, 'secrets');
  const fake = (n) => `${'f'.repeat(n)}\n`;
  writeFileSync(join(secrets, 'admin-secret'), fake(96));
  writeFileSync(join(secrets, 'maker-callback-token'), fake(64));
  writeFileSync(join(secrets, 'email-unsub-key'), fake(64));
  writeFileSync(join(secrets, 'email-webhook-token'), fake(48));
  writeFileSync(join(secrets, 'webhooks.json'), `${JSON.stringify({ version: 1, fireflies: { secret: 'a'.repeat(64), token: 'b'.repeat(32), acceptQueryToken: true, rotatedAt: '2026-10-20T10:00:00.000Z', lastVerified: null } }, null, 2)}\n`);
  return dataDir;
}

function flowsDir(root, names) {
  const dir = join(root, `flows-${names.join('-')}`);
  mkdirSync(dir, { recursive: true });
  for (const name of [...names, 'clock']) cpSync(join(HERE, 'flows', `${name}.json`), join(dir, `${name}.json`));
  return dir;
}

describe('dark-diff on a seeded data folder', { skip: !canBoot && 'no hub dependencies installed', concurrency: 2 }, () => {
  let root;
  let data;
  let fingerprint;
  const trees = {};

  const setup = () => {
    if (root) return;
    root = mkdtempSync(join(tmpdir(), 'dark-diff-self-'));
    data = seedData(root);
    fingerprint = JSON.stringify(snapshotData(data, { scrub: (s) => s }));
    trees.same = copyTree(join(root, 'tree-same'));
    trees.changed = copyTree(join(root, 'tree-changed'), {
      replace: [
        ["app.get('/api/hub/site-config', (req, res) => {", "app.get('/api/hub/dark-diff-seeded', (_req, res) => res.json({ ok: true }));\napp.get('/api/hub/site-config', (req, res) => {"],
        ['return res.json(withGoals(config, siteKey));', 'return res.json({ ...withGoals(config, siteKey), seededChange: true });'],
      ],
    });
    trees.secret = copyTree(join(root, 'tree-secret'), {
      append: [
        '{',
        "  const seededFs = await import('node:fs');",
        "  const seededDir = join(getPersistentDataDir(), 'secrets');",
        "  seededFs.writeFileSync(join(seededDir, 'seeded-extra-secret'), `${'e'.repeat(64)}\\n`);",
        "  seededFs.writeFileSync(join(seededDir, 'email-webhook-token'), `${'d'.repeat(48)}\\n`);",
        '}',
      ].join('\n'),
    });
    // An older release that drops a field of every site at boot, and drops one sales field from
    // every client only when it creates a client. Nothing at boot creates one, so only the rollback
    // pass, which drives base's write paths, can show that loss.
    trees.dropping = copyTree(join(root, 'tree-dropping'), {
      append: [
        '{',
        "  const seededFs = await import('node:fs');",
        "  const sitesFile = join(getPersistentDataDir(), 'sites.json');",
        '  const seededSites = JSON.parse(seededFs.readFileSync(sitesFile, "utf8"));',
        '  seededFs.writeFileSync(sitesFile, JSON.stringify(seededSites.map(({ deliveryPhase, ...rest }) => rest), null, 2));',
        '}',
      ].join('\n'),
      files: {
        'data/sales.js': {
          replace: [[
            'state.push(client);',
            'state.push(client);\n  writeSalesFile(state.map(normalizeSalesClient).map(({ industry, ...rest }) => rest));\n  return client;',
          ]],
        },
      },
    });
  };

  test.after(() => {
    for (const tree of Object.values(trees)) assert.equal(removeLink(join(tree.slice(4), 'node_modules')), true);
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('the same release on both sides: no difference, secrets kept, base keeps what head wrote', { timeout: 1_200_000 }, async () => {
    setup();
    // A clock start whose base-36 form begins with four letters: ids stamped from Date.now() then
    // often have no digit at all, which the normalizer must still recognise.
    const clockStart = allLetterClockStart();
    assert.match(Date.parse(clockStart).toString(36).slice(0, 4), /^[a-z]{4}$/);
    const report = await runDarkDiff({ base: trees.same, head: trees.same, data, secrets: true, rollback: true, nodeModules: NODE_MODULES, clockStart });
    assert.deepEqual(report.unlisted, [], JSON.stringify(report.unlisted.slice(0, 5), null, 2));
    assert.deepEqual(report.secretFailures, []);
    assert.deepEqual(report.rollbackFailures, [], JSON.stringify(report.rollbackFailures.slice(0, 5), null, 2));
    assert.equal(report.ok, true);
    // The rollback pass drove base's write paths: the flows again and the replays on head's records.
    assert.ok(report.counts.rollback.steps >= 30, `${report.counts.rollback.steps} rollback steps`);
    assert.ok(report.counts.rollback.replayed >= 15, `${report.counts.rollback.replayed} replayed steps`);
    // The flows really ran: every step answered as its flow expects, none was skipped.
    assert.ok(report.flows.length >= 30, `${report.flows.length} flow steps`);
    assert.deepEqual(report.flows.filter((row) => row.unexpected || row.skipped), []);
    for (const flow of ['signing-admin', 'signing-preview', 'portal-accept', 'onboarding', 'fireflies-link', 'signing-backfill']) {
      assert.ok(report.flows.some((row) => row.key.startsWith(`${flow}#`)), flow);
    }
    assert.ok(report.counts.outbox.head >= 4, 'the signing flows put their mails in the outbox');
    assert.ok(report.counts.routesProbed > 100);
    assert.ok(report.counts.siteConfigs >= 2);
    assert.ok(report.secretFiles >= 5);
    assert.equal(JSON.stringify(snapshotData(data, { scrub: (s) => s })), fingerprint, 'the source data folder was not written');
  });

  test('a seeded behaviour change is reported, and the run exits 1 when the intended file omits it', { timeout: 900_000 }, async () => {
    setup();
    const intended = join(root, 'intended-omits.json');
    writeFileSync(intended, JSON.stringify({ changes: [{ kind: 'response', match: 'response some-other-flow#*', reason: 'not the real change' }] }));
    const out = join(root, 'report-changed.json');
    const code = await main(['--base', trees.same, '--head', trees.changed, '--data', data, '--intended', intended, '--flows', flowsDir(root, ['signing-admin']), '--node-modules', NODE_MODULES, '--out', out]);
    assert.equal(code, 1);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    const keys = report.unlisted.map((d) => d.key);
    assert.ok(keys.some((k) => k.startsWith('site-config ') && k.endsWith('body.seededChange')), keys.join('\n'));
    assert.ok(keys.includes('route GET /api/hub/dark-diff-seeded'), keys.join('\n'));
    assert.deepEqual(report.unusedIntended, ['response some-other-flow#*']);
    // Listing both changes clears them; listing one leaves the other.
    const both = classify(report.unlisted, { changes: [{ kind: 'site-config', match: 'site-config * body.seededChange' }, { kind: 'route', match: 'route GET /api/hub/dark-diff-seeded' }], ignore: [] });
    assert.deepEqual(both.unlisted, []);
    const one = classify(report.unlisted, { changes: [{ kind: 'site-config', match: 'site-config * body.seededChange' }], ignore: [] });
    assert.deepEqual(one.unlisted.map((d) => d.key), ['route GET /api/hub/dark-diff-seeded']);
  });

  test('--secrets: a release that writes secret files at boot fails', { timeout: 900_000 }, async () => {
    setup();
    const report = await runDarkDiff({ base: trees.same, head: trees.secret, data, secrets: true, inventory: false, flows: flowsDir(root, ['signing-admin']), nodeModules: NODE_MODULES });
    assert.equal(report.ok, false);
    const keys = report.secretFailures.map((f) => f.key);
    assert.ok(keys.includes('secret secrets/seeded-extra-secret new'), keys.join('\n'));
    assert.ok(keys.includes('secret secrets/email-webhook-token changed'), keys.join('\n'));
    assert.ok(!JSON.stringify(report).includes('d'.repeat(48)), 'no secret value in the report');
  });

  test('--rollback: an older release that drops a field head wrote, at boot or when it saves, fails unless the field is listed', { timeout: 900_000 }, async () => {
    setup();
    const flows = flowsDir(root, ['signing-admin']);
    const report = await runDarkDiff({ base: trees.dropping, head: trees.same, data, rollback: true, inventory: false, flows, nodeModules: NODE_MODULES });
    const lost = report.rollbackFailures.map((f) => f.key);
    assert.ok(lost.some((k) => /^rollback sites\.json:\$\.id=.*\.deliveryPhase$/.test(k)), lost.join('\n'));
    // The sales field is dropped only when base creates a client, which happens because the
    // rollback pass runs the flows against base. Later saves write it back empty, so it shows as a
    // changed value (or as lost). Head's own client is among the records that lose it.
    const salesLosses = lost.filter((k) => /^rollback sales-clients\.json:\$\.id=.*\.industry$/.test(k));
    assert.ok(salesLosses.length >= 2, lost.join('\n'));
    assert.ok(report.rollbackFailures.filter((f) => salesLosses.includes(f.key)).every((f) => ['field lost', 'value changed'].includes(f.detail)));
    assert.deepEqual(lost.filter((k) => !salesLosses.includes(k) && !/deliveryPhase$/.test(k)), [], 'nothing else differs on the rollback');
    const intended = join(root, 'intended-rollback.json');
    writeFileSync(intended, JSON.stringify({ rollbackLost: ['rollback sites.json:*.deliveryPhase', 'rollback sales-clients.json:*.industry'] }));
    const listed = await runDarkDiff({ base: trees.dropping, head: trees.same, data, rollback: true, inventory: false, flows, intended, nodeModules: NODE_MODULES });
    assert.deepEqual(listed.rollbackFailures, []);
    assert.ok(listed.warnings.some((w) => /industry: (field lost|value changed) \(listed\)/.test(w)));
  });
});

/** The latest whole hour (at most two days back) whose base-36 time begins with four letters, for two hours on. */
function allLetterClockStart(now = Date.now()) {
  const hour = 3_600_000;
  for (let at = Math.floor(now / hour) * hour; at > now - 48 * hour; at -= hour) {
    if (/^[a-z]{4}$/.test(at.toString(36).slice(0, 4)) && /^[a-z]{4}$/.test((at + 2 * hour).toString(36).slice(0, 4))) {
      return new Date(at).toISOString();
    }
  }
  return '2026-11-01T04:00:00.000Z';
}

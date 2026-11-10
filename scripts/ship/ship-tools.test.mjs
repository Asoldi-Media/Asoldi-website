// Self-tests of the committed ship tools: the switch audit, the route probe and the segment runner.
// Each runs on tiny trees built here (no hub dependencies, no client data), and each has a control
// that fails when the tool stops looking: a head default that is on, a dark route that answers,
// a data file the calls write, a segment that fails.
//
//   node --test scripts/ship/ship-tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditSwitches, compareLeaves, envNames, formatAudit, leaves, main as auditMain, stateOf } from './switch-audit.mjs';
import { changedFiles, loadRoutes, main as probeMain, probeRoutes, statusOk } from './route-probe.mjs';
import { expandScript, main as segmentsMain, parseOutput } from './segments.mjs';

const temps = [];
function temp(label) {
  const dir = mkdtempSync(join(tmpdir(), `ship-tools-${label}-`));
  temps.push(dir);
  return dir;
}
function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/* ------------------------------------------------------------------ switch audit */

function auditTree(label, { automation = {}, keys = {}, version = 1, email = {}, envLine = '' } = {}) {
  const root = temp(label);
  put(root, 'data/automation-settings.js', `export const defaultAutomationSettings = () => (${JSON.stringify(automation)});\n`);
  put(root, 'packages/suite/core/delivery/vocab.js', `export const VOCAB_VERSION = ${version};\nexport const SETTINGS_KEYS = ${JSON.stringify(keys)};\n`);
  put(root, 'data/email-store.js', `export const defaultEmailSettings = () => (${JSON.stringify(email)});\n${envLine}\n`);
  put(root, 'server.js', '// no env here\n');
  return root;
}

test('switch audit: leaves and states', () => {
  assert.deepEqual(leaves({ a: { b: false, c: [] }, d: {} }), { 'a.b': false, 'a.c': [], d: {} });
  for (const off of [false, 'off', null, '', 0, [], {}]) assert.equal(stateOf(off), 'off');
  assert.equal(stateOf('shadow'), 'shadow');
  for (const on of [true, 20, 'live', ['x'], { a: 1 }]) assert.equal(stateOf(on), 'CHECK');
  const { rows, removed } = compareLeaves({ a: { on: false }, gone: 1 }, { a: { on: true }, b: { enabled: false, mode: 'shadow' } });
  assert.deepEqual(rows.map((r) => `${r.state} ${r.key} ${r.change}`), ['CHECK a.on changed', 'off b.enabled new', 'shadow b.mode new']);
  assert.deepEqual(removed, ['gone']);
});

test('switch audit: a new switch that is off passes, one that is on is flagged (control), new env names are listed', async () => {
  const base = auditTree('base', { automation: { x: { enabled: false } }, keys: { xKey: 'x.enabled' }, version: 4, envLine: 'const a = process.env.OLD_NAME;' });
  const dark = auditTree('dark', {
    automation: { x: { enabled: false }, feature: { enabled: false, mode: 'shadow', paused: null } },
    keys: { xKey: 'x.enabled', featureKey: 'feature.enabled' },
    version: 5,
    email: { quota: { max: 0 } },
    envLine: 'const a = process.env.OLD_NAME; const b = process.env.NEW_OPTIONAL_NAME;',
  });
  const live = auditTree('live', { automation: { x: { enabled: false }, feature: { enabled: true } }, keys: { xKey: 'x.enabled' }, version: 4 });
  const ok = await auditSwitches(base, dark);
  assert.equal(ok.check, 0);
  assert.deepEqual(ok.env, ['NEW_OPTIONAL_NAME']);
  assert.deepEqual(ok.settingsKeys, { from: 4, to: 5, added: [{ key: 'featureKey', value: 'feature.enabled' }] });
  assert.match(formatAudit(ok), /audit: 0 default\(s\) to check by hand/);
  const bad = await auditSwitches(base, live);
  assert.equal(bad.check, 1);
  assert.match(formatAudit(bad), /CHECK {2}feature\.enabled = true \(new\)/);
  assert.deepEqual([...envNames(dark)].sort(), ['NEW_OPTIONAL_NAME', 'OLD_NAME']);
});

test('switch audit: exit codes, and a tree that cannot be read is exit 2, never an empty report', async () => {
  const base = auditTree('b', {});
  const live = auditTree('l', { automation: { feature: { enabled: true } } });
  const empty = temp('empty');
  const quiet = (fn) => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    return fn().finally(() => {
      console.log = log;
      console.error = err;
    });
  };
  assert.equal(await quiet(() => auditMain([base, base])), 0);
  assert.equal(await quiet(() => auditMain([base, live])), 1);
  assert.equal(await quiet(() => auditMain([base, empty])), 2);
  assert.equal(await quiet(() => auditMain([base])), 2);
});

test('switch audit: a missing export is exit 2 on either side, never an empty set (control); --accept records a reviewed CHECK leaf', async () => {
  const quiet = async (fn) => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.error = err; }
  };
  const base = auditTree('mb', { automation: { feature: { enabled: false } } });
  const renamed = auditTree('mr', { automation: { feature: { enabled: true }, other: { enabled: true } } });
  put(renamed, 'data/automation-settings.js', 'export const defaultSettings = () => ({ feature: { enabled: true } });\n');
  assert.equal(await quiet(() => auditMain([base, renamed])), 2);
  assert.equal(await quiet(() => auditMain([renamed, base])), 2);
  const noKeys = auditTree('mk', {});
  put(noKeys, 'packages/suite/core/delivery/vocab.js', 'export const VOCAB_VERSION = 1;\n');
  assert.equal(await quiet(() => auditMain([base, noKeys])), 2);
  const noEmail = auditTree('me', {});
  put(noEmail, 'data/email-store.js', 'export const other = 1;\n');
  assert.equal(await quiet(() => auditMain([base, noEmail])), 2);

  const limit = auditTree('ml', { automation: { feature: { enabled: false }, quota: { perSiteTestMax: 20 } } });
  assert.equal(await quiet(() => auditMain([base, limit])), 1);
  const accept = join(temp('acc'), 'accept.json');
  writeFileSync(accept, JSON.stringify({ accept: ['defaultAutomationSettings(): quota.perSiteTestMax'] }));
  assert.equal(await quiet(() => auditMain([base, limit, '--accept', accept])), 0);
  const stale = join(temp('acc2'), 'accept.json');
  writeFileSync(stale, JSON.stringify({ accept: ['defaultAutomationSettings(): quota.other'] }));
  assert.equal(await quiet(() => auditMain([base, limit, '--accept', stale])), 1);
  const result = await auditSwitches(base, limit, { accept: ['defaultAutomationSettings(): quota.other'] });
  assert.deepEqual(result.unusedAccepts, ['defaultAutomationSettings(): quota.other']);
  assert.equal(await quiet(() => auditMain([base, limit, '--accept', join(temp('acc3'), 'none.json')])), 2);
});

/* ------------------------------------------------------------------ route probe */

function fakeHub(label, { darkAnswers = 404, writes = false, darkCode = 'disabled' } = {}) {
  const root = temp(label);
  put(root, 'server.js', `
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const server = http.createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  req.resume();
  if (req.url.startsWith('/staff')) return json(401, { code: 'sign-in' });
  if (req.url.startsWith('/dark')) {
    if (${writes}) writeFileSync(join(process.env.APP_DATA_DIR, 'written.json'), '{}');
    return json(${darkAnswers}, ${JSON.stringify(darkCode === null ? { message: 'not found' } : { code: darkCode })});
  }
  return json(404, {});
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('Server running on port ' + process.env.PORT));
`);
  put(root, 'package.json', '{ "type": "module" }');
  return root;
}

function routesFile(rows) {
  const root = temp('routes');
  put(root, 'routes.json', JSON.stringify({ routes: rows }));
  return join(root, 'routes.json');
}

const ROUTES = [{ method: 'GET', path: '/staff/a', expect: 'staff' }, { method: 'POST', path: '/dark/b', body: {}, expect: 'dark' }];

test('route probe: routes file checks and status rules', () => {
  assert.deepEqual(loadRoutes(routesFile(ROUTES)).map((r) => `${r.method} ${r.path} ${r.expect}`), ['GET /staff/a staff', 'POST /dark/b dark']);
  assert.throws(() => loadRoutes(routesFile([])), /lists no route/);
  assert.throws(() => loadRoutes(routesFile([{ path: '/x' }])), /expect must be/);
  assert.throws(() => loadRoutes(routesFile([{ path: 'x', expect: 'dark' }])), /must start with/);
  assert.throws(() => loadRoutes(join(temp('none'), 'missing.json')), /cannot read/);
  assert.equal(statusOk('staff', 401) && statusOk('staff', 403), true);
  assert.equal(statusOk('staff', 200) || statusOk('staff', 404), false);
  assert.equal(statusOk('dark', 404), true);
  assert.equal(statusOk('dark', 401) || statusOk('dark', 200), false);
  assert.equal(statusOk('dark', 404, 'disabled'), true);
  assert.equal(statusOk('dark', 404, 'not found'), false, 'a plain 404 is not a switched-off route');
  assert.equal(statusOk('dark', 404, 'gone', 'gone'), true);
  assert.deepEqual(changedFiles({ 'a.json': '1', 'logs/x': '1' }, { 'a.json': '2', 'logs/x': '2', 'b.json': '1' }), ['a.json', 'b.json']);
});

test('route probe: a hub that answers as required passes; a dark route that answers, or a data file the calls write, fails (controls)', { timeout: 120_000 }, async () => {
  const ok = await probeRoutes(fakeHub('ok'), loadRoutes(routesFile(ROUTES)), { startTimeoutMs: 30_000 });
  assert.equal(ok.problems, 0);
  assert.deepEqual(ok.rows.map((r) => r.status), [401, 404]);
  assert.deepEqual(ok.removalErrors, []);

  const answering = await probeRoutes(fakeHub('answering', { darkAnswers: 200 }), loadRoutes(routesFile(ROUTES)), { startTimeoutMs: 30_000 });
  assert.equal(answering.problems, 1);
  assert.equal(answering.rows[1].ok, false);

  const plain404 = await probeRoutes(fakeHub('plain404', { darkCode: null }), loadRoutes(routesFile(ROUTES)), { startTimeoutMs: 30_000 });
  assert.equal(plain404.problems, 1);
  assert.equal(plain404.rows[1].ok, false);

  const writing = await probeRoutes(fakeHub('writing', { writes: true }), loadRoutes(routesFile(ROUTES)), { startTimeoutMs: 30_000 });
  assert.deepEqual(writing.changed, ['written.json']);
  assert.equal(writing.problems, 1);
});

test('route probe: a tree that does not start, a missing or empty routes file, and a missing tree are exit 2', { timeout: 60_000 }, async () => {
  const quiet = async (fn) => {
    const err = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = err;
    }
  };
  assert.equal(await quiet(() => probeMain([])), 2);
  assert.equal(await quiet(() => probeMain([fakeHub('x'), '--routes', routesFile([])])), 2);
  const broken = temp('broken');
  put(broken, 'server.js', 'process.exit(3);\n');
  await assert.rejects(probeRoutes(broken, loadRoutes(routesFile(ROUTES)), { startTimeoutMs: 10_000 }), /did not start/);
});

/* ------------------------------------------------------------------ segment runner */

test('segment runner: expands npm run parts, runs each segment, reports the failing one and exits 1 (control)', () => {
  const scripts = { test: 'npm run a && node -e "0" && npm run -s b', a: 'node -e "0"', b: 'node -e "process.exit(1)" && node -e "0"', loop: 'npm run loop' };
  assert.deepEqual(expandScript(scripts, 'test'), ['node -e "0"', 'node -e "0"', 'node -e "process.exit(1)"', 'node -e "0"']);
  assert.throws(() => expandScript(scripts, 'missing'), /no script/);
  assert.throws(() => expandScript(scripts, 'loop'), /runs itself/);
  assert.deepEqual(parseOutput('ℹ pass 4\nℹ fail 1\n✖ some test (3ms)\n✖ some test (3ms)\n'), { pass: 4, fail: 1, names: ['some test'] });

  const root = temp('seg');
  put(root, 'package.json', JSON.stringify({ scripts }));
  const logs = join(temp('seglogs'), 'out');
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  let code;
  try {
    code = segmentsMain([root, logs]);
  } finally {
    console.log = log;
  }
  assert.equal(code, 1);
  assert.equal(lines.filter((l) => l.startsWith('PASS')).length, 3);
  assert.equal(lines.filter((l) => l.startsWith('FAIL')).length, 1);
  assert.match(lines.at(-1), /segments: 4, failed: 1/);

  put(root, 'package.json', JSON.stringify({ scripts: { test: 'node -e "0" && node -e "0"' } }));
  console.log = () => {};
  try {
    assert.equal(segmentsMain([root, logs]), 0);
    assert.equal(segmentsMain([root]), 2);
    assert.equal(segmentsMain([root, logs, 'nope']), 2);
  } finally {
    console.log = log;
  }
});

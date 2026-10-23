// dev:safe plan + real boots of server.js. The boots run with fake live-looking keys and the
// independent egress recorder in enforce mode, so nothing can leave the PC even if a guard fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_PORT, DEFAULT_UI_PORT, planDevSafe } from './dev-safe.mjs';
import { ALLOWLIST, AUDIT, LIVE_LIKE, REPO, bootHub } from './safe-mode/hub-boot.mjs';

test('plan: API 3101, UI 3100, data in .local-data/<profile>, safe mode on by default', () => {
  const plan = planDevSafe({ argv: ['--profile', 'golden'], shellEnv: {}, fileEnv: LIVE_LIKE, repoRoot: '/repo' });
  assert.equal(plan.ok, true);
  assert.equal(plan.apiPort, DEFAULT_API_PORT);
  assert.equal(plan.uiPort, DEFAULT_UI_PORT);
  assert.equal(plan.apiEnv.PORT, '3101');
  assert.equal(plan.apiEnv.APP_URL, 'http://127.0.0.1:3100');
  assert.equal(plan.apiEnv.HUB_SAFE_MODE, '1');
  assert.equal(plan.apiEnv.PERSIST_PRODUCTION_ENV, '0');
  assert.equal(plan.apiEnv.LAN_PREVIEW_AUTOPUBLISH, '0');
  assert.match(plan.apiEnv.APP_DATA_DIR.replace(/\\/g, '/'), /\/repo\/\.local-data\/golden$/);
  assert.equal(plan.apiEnv.ADMIN_SECRET, undefined, 'the local hub makes its own signing secret');
  assert.equal(plan.state.on, true);
  assert.equal(plan.uiEnv.API_PROXY_TARGET, 'http://127.0.0.1:3101');
  assert.equal(plan.uiEnv.RESEND_API_KEY, undefined, 'Vite never sees .env secrets');
  assert.equal(plan.uiEnv.HUB_DEV_SAFE, '1', 'vite.config.ts skips its .env define');
  assert.equal(plan.apiEnv.HUB_PUBLIC_URL_FOR_MAKER, 'http://host.docker.internal:3101', 'the Maker in Docker reaches this hub');
});

test('plan: HUB_SAFE_MODE=0 refuses without --unsafe-i-know', () => {
  const refused = planDevSafe({ argv: [], shellEnv: { HUB_SAFE_MODE: '0' }, fileEnv: {}, repoRoot: '/repo' });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal, /--unsafe-i-know/);
  const forced = planDevSafe({ argv: ['--unsafe-i-know'], shellEnv: { HUB_SAFE_MODE: '0' }, fileEnv: {}, repoRoot: '/repo' });
  assert.equal(forced.ok, true);
  assert.equal(forced.state.on, false);
});

test('plan: the Maker port 3000 is never used; bad profile names are refused', () => {
  assert.throws(() => planDevSafe({ argv: ['--ui-port', '3000'], shellEnv: {}, fileEnv: {}, repoRoot: '/repo' }), /Maker/);
  assert.throws(() => planDevSafe({ argv: ['--profile', '../x'], shellEnv: {}, fileEnv: {}, repoRoot: '/repo' }), /profile/);
});

test('plan: --egress-audit preloads the recorder into the API only', () => {
  const plan = planDevSafe({ argv: ['--egress-audit'], shellEnv: {}, fileEnv: {}, repoRoot: REPO });
  assert.match(plan.apiEnv.NODE_OPTIONS, /--require="[^"]+egress-audit\.cjs"/);
  assert.ok(plan.apiEnv.EGRESS_AUDIT_FILE.endsWith('egress.jsonl'));
  assert.equal(plan.uiEnv.NODE_OPTIONS, undefined);
});

test('egress-audit.cjs records every connection, marks loopback listed, and refuses unlisted hosts in enforce mode', { timeout: 60_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-audit-'));
  const file = join(dir, 'egress.jsonl');
  const script = [
    "const http = require('node:http');",
    "const srv = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', async () => {",
    "  const port = srv.address().port;",
    "  console.log('local', await (await fetch('http://127.0.0.1:' + port + '/')).text());",
    "  try { await fetch('https://unlisted.example.invalid/'); console.log('unlisted reached'); } catch (e) { console.log('unlisted', e.cause && e.cause.code); }",
    "  srv.close();",
    "});",
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_OPTIONS: `--require="${AUDIT}"`, EGRESS_AUDIT_FILE: file, EGRESS_AUDIT_ALLOW: ALLOWLIST, EGRESS_AUDIT_ENFORCE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.match(result.stdout, /local ok/);
  assert.match(result.stdout, /unlisted EEGRESSAUDIT/);
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.event === 'audit-start'));
  assert.ok(rows.some((row) => row.host === '127.0.0.1' && row.listed === true && row.blocked === false));
  assert.ok(rows.some((row) => row.host === 'unlisted.example.invalid' && row.listed === false && row.blocked === true));
  rmSync(dir, { recursive: true, force: true });
});

test('server.js with a live-looking .env and no HUB_SAFE_MODE boots in safe mode, writes no production.env, no egress', { timeout: 120_000 }, async () => {
  const hub = await bootHub({ ...LIVE_LIKE, ADMIN_SECRET: '' });
  try {
    assert.ok(hub.health, `hub answered /api/health\n${hub.log().slice(-2000)}`);
    assert.equal(hub.health.safeMode, true);
    assert.match(hub.log(), /\[safe-mode\] ON \(not Hostinger\)/);
    assert.match(hub.log(), /\[mail\] transport=outbox/);
    assert.equal(existsSync(join(hub.dataDir, 'production.env')), false, 'production.env not written');
    const egress = existsSync(join(hub.dataDir, 'egress.jsonl')) ? readFileSync(join(hub.dataDir, 'egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(egress.some((row) => row.event === 'audit-start'), 'the egress recorder ran inside the hub process');
    assert.deepEqual(egress.filter((row) => !row.event && !row.listed), [], 'no unlisted egress');
    const unauth = await fetch(`${hub.base}/api/admin/system/safe-mode`);
    assert.equal(unauth.status, 401);
  } finally {
    await hub.stop();
  }
});

test('server.js with HOSTINGER=1 reports safeMode:false', { timeout: 120_000 }, async () => {
  const hub = await bootHub({ HOSTINGER: '1' });
  try {
    assert.ok(hub.health, `hub answered /api/health\n${hub.log().slice(-2000)}`);
    assert.equal(hub.health.safeMode, false);
    assert.doesNotMatch(hub.log(), /\[safe-mode\] ON/);
  } finally {
    await hub.stop();
  }
});

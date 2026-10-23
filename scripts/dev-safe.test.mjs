// dev:safe plan + real boots of server.js. The boots run with fake live-looking keys and the
// independent egress recorder in enforce mode, so nothing can leave the PC even if a guard fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_PORT, DEFAULT_UI_PORT, planDevSafe } from './dev-safe.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(REPO, 'scripts', 'safe-mode', 'egress-audit.cjs').replace(/\\/g, '/');
const ALLOWLIST = join(REPO, 'scripts', 'safe-mode', 'soak-allowlist.json');

const LIVE_LIKE = {
  APP_URL: 'https://asoldi.com',
  RESEND_API_KEY: 're_fake_live_like',
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_USER: 'contact@asoldi.com',
  SMTP_PASS: 'fake',
  PROD_ADMIN_URL: 'https://asoldi.com',
  PROD_ADMIN_PASSWORD: 'fake-prod-password',
  FIREFLIES_API_KEY: 'fake-ff',
  DEEPSEEK_API_KEY: 'fake-ds',
  ADMIN_SECRET: 'must-not-reach-the-child',
};

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

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function bootHub(extraEnv) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-hub-boot-'));
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) if (/^(HUB_SAFE_MODE|HOSTINGER|EMAIL_REDIRECT_TO)/.test(key)) delete shell[key];
  const env = {
    ...shell,
    ...extraEnv,
    PORT: String(port),
    APP_DATA_DIR: dataDir,
    NODE_OPTIONS: `--require="${AUDIT}"`,
    EGRESS_AUDIT_FILE: join(dataDir, 'egress.jsonl'),
    EGRESS_AUDIT_ALLOW: ALLOWLIST,
    EGRESS_AUDIT_ENFORCE: '1',
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let health = null;
  for (let i = 0; i < 120 && !health; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    base,
    dataDir,
    health,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('server.js with a live-looking .env and no HUB_SAFE_MODE boots in safe mode, writes no production.env, no egress', { timeout: 120_000 }, async () => {
  const hub = await bootHub({ ...LIVE_LIKE, ADMIN_SECRET: '' });
  try {
    assert.ok(hub.health, `hub answered /api/health\n${hub.log().slice(-2000)}`);
    assert.equal(hub.health.safeMode, true);
    assert.match(hub.log(), /\[safe-mode\] ON \(not Hostinger\)/);
    assert.match(hub.log(), /\[mail\] transport=outbox/);
    assert.equal(existsSync(join(hub.dataDir, 'production.env')), false, 'production.env not written');
    const egress = existsSync(join(hub.dataDir, 'egress.jsonl')) ? readFileSync(join(hub.dataDir, 'egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.deepEqual(egress.filter((row) => !row.listed), [], 'no unlisted egress');
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

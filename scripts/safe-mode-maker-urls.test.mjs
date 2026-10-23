// A safe-mode hub with the live .env (APP_URL=https://asoldi.com) must hand the Maker only
// local push and callback URLs, never take the browser-handoff path, bind 127.0.0.1, and
// answer safe-mode refusals with 423. The boot runs with fake keys and the egress recorder
// in enforce mode; the Maker is a fake loopback server in this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDevSafe } from './dev-safe.mjs';
import { LIVE_LIKE, bootHub } from './safe-mode/hub-boot.mjs';

const unitDataDir = mkdtempSync(join(tmpdir(), 'asoldi-maker-urls-'));
process.env.APP_DATA_DIR = unitDataDir;
const urls = await import('../lib/safe-mode-maker-urls.js');
const safeMode = await import('../lib/safe-mode.js');
const { SafeModeEgressError } = await import('../lib/safe-mode-egress.js');

const PUSH = '/api/admin/sales/maker-preview-push';
const CALLBACK = '/api/admin/sales/maker-status-callback';

test('Maker URLs: an empty env still gives a non-empty local URL', () => {
  assert.equal(urls.safeModeMakerPreviewPushUrl({}), `http://host.docker.internal:3000${PUSH}`);
  assert.equal(urls.safeModeMakerCallbackUrl({}), `http://host.docker.internal:3000${CALLBACK}`);
  assert.equal(urls.safeModeMakerPreviewPushUrl({ PORT: '3101' }), `http://host.docker.internal:3101${PUSH}`);
});

test('Maker URLs: prod APP_URL, push and callback env values are ignored; local ones are used', () => {
  const prod = {
    PORT: '3101',
    APP_URL: 'https://asoldi.com',
    HUB_PUBLIC_URL_FOR_MAKER: 'https://asoldi.com',
    SALES_PREVIEW_PUSH_URL: `https://asoldi.com${PUSH}`,
    WEBSITE_MAKER_STATUS_CALLBACK_URL: `https://www.asoldi.com${CALLBACK}`,
    SALES_MAKER_STATUS_CALLBACK_URL: `https://asoldi.com${CALLBACK}`,
  };
  assert.equal(urls.safeModeMakerPreviewPushUrl(prod), `http://host.docker.internal:3101${PUSH}`);
  assert.equal(urls.safeModeMakerCallbackUrl(prod), `http://host.docker.internal:3101${CALLBACK}`);
  const lan = { PORT: '3001', HUB_PUBLIC_URL_FOR_MAKER: 'http://192.168.68.92:3201/' };
  assert.equal(urls.safeModeMakerPreviewPushUrl(lan), `http://192.168.68.92:3201${PUSH}`);
  assert.equal(urls.safeModeMakerCallbackUrl(lan), `http://192.168.68.92:3201${CALLBACK}`);
  const explicit = { SALES_PREVIEW_PUSH_URL: `http://127.0.0.1:3101${PUSH}`, WEBSITE_MAKER_STATUS_CALLBACK_URL: `http://pc2.lan:3201${CALLBACK}` };
  assert.equal(urls.safeModeMakerPreviewPushUrl(explicit), `http://127.0.0.1:3101${PUSH}`);
  assert.equal(urls.safeModeMakerCallbackUrl(explicit), `http://pc2.lan:3201${CALLBACK}`);
  for (const bad of ['ftp://127.0.0.1/x', 'not a url', 'https://127.0.0.1.asoldi.com/x', 'http://asoldi.com@evil.example.com/x']) {
    assert.equal(urls.localHttpUrl(bad), '', bad);
  }
});

test('Maker URLs under npm run dev:safe: push and callback both go to host.docker.internal:3101', () => {
  const plan = planDevSafe({ argv: [], shellEnv: {}, fileEnv: LIVE_LIKE, repoRoot: '/repo' });
  assert.equal(urls.safeModeMakerPreviewPushUrl(plan.apiEnv), `http://host.docker.internal:3101${PUSH}`);
  assert.equal(urls.safeModeMakerCallbackUrl(plan.apiEnv), `http://host.docker.internal:3101${CALLBACK}`, 'not 127.0.0.1, which is the Maker container itself');
});

test('nonLocalUrlsIn finds every off-machine URL in a body', () => {
  assert.deepEqual(urls.nonLocalUrlsIn({ a: `http://host.docker.internal:1${PUSH}`, b: ['http://127.0.0.1:3000/x', 'http://10.0.0.5/y'] }), []);
  assert.deepEqual(urls.nonLocalUrlsIn({ a: `https://asoldi.com${PUSH}`, b: 'see https://example.com/z' }), [`https://asoldi.com${PUSH}`, 'https://example.com/z']);
});

test('hubListenHost: 127.0.0.1 in safe mode, 0.0.0.0 with lan or on Hostinger, HUB_LISTEN_HOST wins in safe mode', () => {
  const install = (env) => safeMode.installSafeMode({ env, dataDir: unitDataDir, log: null, egress: false });
  install({ HUB_SAFE_MODE: '1' });
  assert.equal(safeMode.hubListenHost({}), '127.0.0.1');
  assert.equal(safeMode.hubListenHost({ HUB_LISTEN_HOST: '0.0.0.0' }), '0.0.0.0');
  install({ HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'prodPublish,lan' });
  assert.equal(safeMode.hubListenHost({}), '0.0.0.0', 'the LAN box keeps listening on the LAN');
  install({ HOSTINGER: '1' });
  assert.equal(safeMode.hubListenHost({ HUB_LISTEN_HOST: '127.0.0.1' }), '0.0.0.0', 'production binding never changes');
  safeMode.resetSafeModeForTests();
});

test('isSafeModeError: blocked, egress and fetch-wrapped refusals', () => {
  assert.equal(safeMode.isSafeModeError(new safeMode.SafeModeBlockedError('publicTunnel')), true);
  assert.equal(safeMode.isSafeModeError(new SafeModeEgressError('x', { kind: 'prodPublish' })), true);
  assert.equal(safeMode.isSafeModeError(new TypeError('fetch failed', { cause: new SafeModeEgressError('x') })), true);
  assert.equal(safeMode.isSafeModeError(new Error('boom')), false);
  assert.equal(safeMode.isSafeModeError(null), false);
});

function startFakeMaker() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url.startsWith('/api/runs/v2')) {
        captured.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: `run-maker-urls-${captured.length}`, handoff: {} }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, captured, base: `http://127.0.0.1:${server.address().port}` })));
}

function seedClient(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([{
    id: 'maker-urls-client',
    product: 'asoldi',
    businessName: 'Maker URL Test AS',
    industry: 'bakeri',
    contactPerson: 'Test Person',
    contactEmail: 'maker-urls@example.invalid',
    ownerId: 'sales:test',
    status: 'booked',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2));
}

function postWithHost(base, path, { token, host, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body || {});
    const req = http.request(url, {
      method: 'POST',
      headers: { Host: host, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '';
}

test('server.js with the live-like .env: create-maker-run hands the Maker only local URLs, binds 127.0.0.1, refusals are 423', { timeout: 180_000 }, async (t) => {
  const maker = await startFakeMaker();
  const hub = await bootHub({
    ...LIVE_LIKE,
    ADMIN_SECRET: '',
    ADMIN_USERNAME: 'maker-urls-admin',
    ADMIN_PASSWORD: 'maker-urls-local-test-password',
    SALES_PREVIEW_PUSH_URL: `https://asoldi.com${PUSH}`,
    WEBSITE_MAKER_STATUS_CALLBACK_URL: `https://asoldi.com${CALLBACK}`,
    WEBSITE_MAKER_LOCAL_URL: maker.base,
  }, { seed: seedClient });
  try {
    assert.ok(hub.health, `hub answered /api/health\n${hub.log().slice(-2000)}`);
    assert.equal(hub.health.safeMode, true);
    const token = await hub.adminToken('maker-urls-admin', 'maker-urls-local-test-password');
    assert.ok(token, `local admin login\n${hub.log().slice(-1500)}`);
    const local = `http://host.docker.internal:${hub.port}`;

    // 1) Maker URL typed in Sales (loopback): server-to-server, no browser handoff.
    const first = await postWithHost(hub.base, '/api/admin/sales/maker-urls-client/create-maker-run', { token, host: `127.0.0.1:${hub.port}`, body: { websiteMakerBaseUrl: maker.base } });
    assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 400));
    assert.notEqual(first.json.browserHandoff, true);
    assert.equal(maker.captured.length, 1, 'the hub created the run server-to-server');
    assert.equal(maker.captured[0].salesPreviewPushUrl, `${local}${PUSH}`);
    assert.equal(maker.captured[0].salesCallbackUrl, `${local}${CALLBACK}`);
    assert.deepEqual(urls.nonLocalUrlsIn(maker.captured[0]), [], 'the Maker body names no off-machine URL');
    assert.deepEqual(urls.nonLocalUrlsIn(first.json), [], 'the response names no off-machine URL');

    // 2) A request that looks like it came to asoldi.com, with no Maker URL: before the fix this
    //    returned browserHandoff with asoldi.com push/callback URLs in requestBody.
    const second = await postWithHost(hub.base, '/api/admin/sales/maker-urls-client/create-maker-run', { token, host: 'asoldi.com', body: { forceNewRun: true } });
    assert.equal(second.status, 200, JSON.stringify(second.json).slice(0, 400));
    assert.notEqual(second.json.browserHandoff, true, 'no browser handoff in safe mode');
    assert.equal(second.json.requestBody, undefined);
    assert.equal(maker.captured.length, 2);
    assert.deepEqual(urls.nonLocalUrlsIn(maker.captured[1]), []);
    assert.deepEqual(urls.nonLocalUrlsIn(second.json), []);

    // 3) Safe-mode refusals are 423, not 500.
    const hook = await fetch(`${hub.base}/api/hub/payments-platform/stripe-webhook`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(hook.status, 423);
    const tunnel = await fetch(`${hub.base}/api/admin/sales/maker-tunnel/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(tunnel.status, 423);
    assert.match((await tunnel.json()).message, /safe mode/i);

    // 4) Bound to loopback only.
    const ip = lanAddress();
    if (!ip) {
      t.diagnostic('no non-loopback IPv4 address on this machine; bind check skipped');
    } else {
      const outcome = await new Promise((resolve) => {
        const socket = net.connect(hub.port, ip);
        socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout'); });
        socket.on('connect', () => { socket.destroy(); resolve('connected'); });
        socket.on('error', (error) => resolve(error.code || 'error'));
      });
      assert.notEqual(outcome, 'connected', `the safe-mode hub must not answer on ${ip}`);
    }

    const egress = hub.egressRows();
    assert.ok(egress.some((row) => row.event === 'audit-start'), 'the egress recorder ran inside the hub process');
    assert.deepEqual(egress.filter((row) => !row.event && !row.listed), [], 'no unlisted egress');
  } finally {
    await hub.stop();
    maker.server.close();
  }
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  rmSync(unitDataDir, { recursive: true, force: true });
});


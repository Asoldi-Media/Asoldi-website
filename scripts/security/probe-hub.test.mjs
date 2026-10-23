// WS0.32: read-only hub probe. Runs against local fake servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  emailAlert,
  forgeToken,
  httpGet,
  main as probeMain,
  pinnedLookup,
  resolveOverDoh,
  runProbe,
  writeAlert,
} from './probe-hub.mjs';

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function brokenHub({ safeMode = true } = {}) {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: 5, safeMode }));
  app.get('/api/hub/sites', (_req, res) => res.json([])); // accepts any token: the bug the probe must catch
  app.get('/api/hub/site-config', (_req, res) => res.json({ siteKey: 'x', pendingAdmin: { username: 'a', passwordHash: 'h' } }));
  app.get(/^\/myphoner-recordings\/.*/, (_req, res) => res.type('audio/mpeg').send('ID3'));
  app.get('/api/webhooks/fireflies', (_req, res) => res.json({ ok: true, service: 'fireflies', apiKey: false }));
  app.get('/api/admin/system/security', (_req, res) => res.json({ counters: { 'maker-callback-rejected': { total: 90, lastHour: 45 } } }));
  return app;
}

function healthyHub() {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: 5, safeMode: false }));
  app.get('/api/hub/sites', (req, res) => res.status(req.headers.authorization === 'Bearer good' ? 200 : 401).json({}));
  app.get('/api/hub/site-config', (req, res) => (
    req.query.domain === 'kunde.example'
      ? res.json({ siteKey: 'x', name: 'Kunde', features: {} })
      : res.status(404).json({ message: 'Site not found' })
  ));
  app.get(/^\/myphoner-recordings\/.*/, (_req, res) => res.status(401).send('Unauthorized'));
  app.get('/api/webhooks/fireflies', (_req, res) => res.json({ ok: true, service: 'fireflies', apiKey: true }));
  app.get('/api/admin/system/security', (req, res) => (
    req.headers.authorization === 'Bearer good'
      ? res.json({ counters: { 'maker-callback-rejected': { total: 3, lastHour: 1 } } })
      : res.status(401).json({})
  ));
  return app;
}

test('a healthy hub passes every check, with GET requests only', async () => {
  const methods = new Set();
  const app = healthyHub();
  const wrapper = express();
  wrapper.use((req, _res, next) => { methods.add(req.method); next(); });
  wrapper.use(app);
  const { base, close } = await serve(wrapper);
  try {
    const report = await runProbe({ target: base, expectProd: true, siteDomain: 'kunde.example', adminToken: 'good' });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.deepEqual(report.checks.map((c) => c.id), ['health', 'forged-token:23', 'forged-token:9', 'site-config', 'recordings', 'fireflies', 'counters']);
    assert.deepEqual([...methods], ['GET']);
  } finally {
    await close();
  }
});

test('a broken hub fails: safe mode in prod, forged token accepted, config leak, open recordings, no API key, callback spike', async () => {
  const { base, close } = await serve(brokenHub());
  try {
    const report = await runProbe({ target: base, expectProd: true, siteDomain: 'kunde.example', adminToken: 'any' });
    assert.equal(report.ok, false);
    const failed = Object.fromEntries(report.checks.filter((c) => !c.ok).map((c) => [c.id, c.detail]));
    assert.match(failed.health, /safeMode is ON/);
    assert.match(failed['forged-token:23'], /HTTP 200/);
    assert.match(failed['site-config'], /passwordHash, pendingAdmin/);
    assert.match(failed.recordings, /HTTP 200/);
    assert.match(failed.fireflies, /no Fireflies API key/);
    assert.match(failed.counters, /maker-callback-rejected 45\/h/);
  } finally {
    await close();
  }
});

test('weak passes are failures: 404 recordings (gate gone), unknown site domain, prod without a site domain', async () => {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: 5, safeMode: false }));
  app.get('/api/hub/sites', (_req, res) => res.status(401).json({}));
  app.get('/api/hub/site-config', (_req, res) => res.status(404).json({ message: 'Site not found' }));
  app.get(/^\/myphoner-recordings\/.*/, (_req, res) => res.status(404).send('Not found')); // static 404: no staff gate
  app.get('/api/webhooks/fireflies', (_req, res) => res.json({ ok: true, apiKey: true }));
  const { base, close } = await serve(app);
  try {
    const withDomain = await runProbe({ target: base, siteDomain: 'unknown.example' });
    const failed = Object.fromEntries(withDomain.checks.filter((c) => !c.ok).map((c) => [c.id, c.detail]));
    assert.match(failed.recordings, /HTTP 404 without a login \(want 401\)/);
    assert.match(failed['site-config'], /HTTP 404 for unknown\.example \(want 200/);
    const prodNoDomain = await runProbe({ target: base, expectProd: true });
    const siteConfig = prodNoDomain.checks.find((c) => c.id === 'site-config');
    assert.equal(siteConfig.ok, false);
    assert.match(siteConfig.detail, /--site-domain is required with --expect-prod/);
  } finally {
    await close();
  }
});

test('header-less Maker callbacks and a retired-credential burst have their own thresholds', async () => {
  const app = healthyHub();
  const counters = {
    'maker-callback-missing-token': { total: 80, lastHour: 60 },
    'fireflies-webhook-retired-credential': { total: 40, lastHour: 30 },
  };
  const wrapper = express();
  wrapper.get('/api/admin/system/security', (_req, res) => res.json({ counters }));
  wrapper.use(app);
  const { base, close } = await serve(wrapper);
  try {
    const report = await runProbe({ target: base, adminToken: 'good' });
    const check = report.checks.find((c) => c.id === 'counters');
    assert.equal(check.ok, false);
    assert.match(check.detail, /maker-callback-missing-token 60\/h/);
    assert.equal(check.detail.includes('fireflies-webhook-retired-credential'), false, 'normal Fireflies redelivery is not a spike');
  } finally {
    await close();
  }
});

/** Runs main() with console output captured. */
async function runMain(argv, env, deps) {
  const lines = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = await probeMain(argv, env, deps);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

test('main: a failed DNS lookup still alerts (file + e-mail) and the HTTP checks still run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-probe-main-'));
  const { base, close } = await serve(healthyHub());
  try {
    const mails = [];
    const result = await runMain(
      ['--target', base, '--site-domain', 'kunde.example', '--alert-dir', dir, '--email-to', 'ops@example.com'],
      { RESEND_API_KEY: 'fake-resend-key' },
      {
        resolve: async () => { throw new Error('DoH lookup for hub.example failed: no A record'); },
        fetchImpl: async (url, init) => { mails.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
      }
    );
    assert.equal(result.code, 1);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.dns.ok, false);
    assert.match(byId.dns.detail, /no A record/);
    assert.equal(byId.health.ok, true, 'HTTP checks ran with the system resolver');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].url, 'https://api.resend.com/emails');
    assert.match(mails[0].body.text, /dns: DoH lookup/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: a missing admin token file is a failed check with an alert, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-probe-main-'));
  const { base, close } = await serve(healthyHub());
  try {
    const mails = [];
    const result = await runMain(
      ['--target', base, '--no-doh', '--site-domain', 'kunde.example', '--admin-token-file', join(dir, 'missing-token'), '--alert-dir', dir, '--email-to', 'ops@example.com'],
      { RESEND_API_KEY: 'fake-resend-key' },
      { fetchImpl: async (url, init) => { mails.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } }
    );
    assert.equal(result.code, 1);
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    const tokenCheck = report.checks.find((c) => c.id === 'admin-token');
    assert.equal(tokenCheck.ok, false);
    assert.match(tokenCheck.detail, /cannot read --admin-token-file \(ENOENT\)/);
    assert.equal(report.checks.some((c) => c.id === 'counters'), false, 'no token, no counters call');
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /1 check\(s\) failed/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: all checks pass → exit 0 and no alert; bad arguments → exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-probe-main-'));
  const { base, close } = await serve(healthyHub());
  try {
    const ok = await runMain(['--target', base, '--no-doh', '--expect-prod', '--site-domain', 'kunde.example', '--alert-dir', dir], {}, {});
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal((await runMain(['--target', 'not a url'], {}, {})).code, 2);
    assert.equal((await runMain([], {}, {})).code, 2);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits with code 1 and writes an alert when the host does not resolve', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-probe-cli-'));
  try {
    // DoH goes to a closed local port and the target port is closed: nothing leaves this machine.
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./probe-hub.mjs', import.meta.url)),
      '--target', 'http://probe-nxdomain-check.localhost:9', '--alert-dir', dir,
    ], {
      encoding: 'utf8',
      timeout: 55_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot || '',
        HOME: dir,
        USERPROFILE: dir,
        PROBE_DOH_ENDPOINTS: 'http://127.0.0.1:9/dns-query',
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Assertion failed/);
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(report.checks.find((c) => c.id === 'dns').ok, false);
    assert.equal(report.checks.find((c) => c.id === 'health').ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable hub is a failure, not a crash', async () => {
  const report = await runProbe({ target: 'http://127.0.0.1:9' });
  assert.equal(report.ok, false);
  assert.ok(report.checks.every((c) => !c.ok && /request failed/.test(c.detail)));
});

test('alerts: a JSON file per failure and an e-mail through Resend when configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-probe-alerts-'));
  try {
    const report = { ok: false, target: 'https://hub.example', at: '2026-10-23T10:00:00.000Z', checks: [{ id: 'health', ok: false, detail: 'safeMode is ON in production' }] };
    const file = writeAlert(report, dir);
    assert.deepEqual(readdirSync(dir), [file.split(/[\\/]/).pop()]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).checks[0].id, 'health');

    let sent = null;
    const result = await emailAlert(report, {
      to: 'ops@example.com',
      apiKey: 'fake-resend-key',
      fetchImpl: async (url, init) => {
        sent = { url, init };
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(sent.url, 'https://api.resend.com/emails');
    assert.match(JSON.parse(sent.init.body).text, /health: safeMode is ON/);
    assert.deepEqual(await emailAlert(report, { to: 'ops@example.com', apiKey: '' }), { sent: false, reason: 'no RESEND_API_KEY' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DoH resolution picks the A record and falls back to the second resolver', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://1.1.1.1/')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, json: async () => ({ Answer: [{ type: 5, data: 'alias.example.' }, { type: 1, data: '203.0.113.7' }] }) };
  };
  assert.equal(await resolveOverDoh('hub.example', { fetchImpl }), '203.0.113.7');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/8\.8\.8\.8\/resolve\?name=hub\.example&type=A$/);
  assert.equal(await resolveOverDoh('127.0.0.1', { fetchImpl }), '127.0.0.1');
  await assert.rejects(resolveOverDoh('hub.example', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /no A record/);
});

test('the pinned lookup answers both dns.lookup callback shapes, and requests use it', async () => {
  const lookup = pinnedLookup('127.0.0.1');
  await new Promise((resolve) => lookup('hub.example', { all: true }, (err, list) => { assert.deepEqual(list, [{ address: '127.0.0.1', family: 4 }]); resolve(); }));
  await new Promise((resolve) => lookup('hub.example', {}, (err, address, family) => { assert.equal(address, '127.0.0.1'); assert.equal(family, 4); resolve(); }));
  const { base, close } = await serve(healthyHub());
  try {
    const port = new URL(base).port;
    // A host name that does not resolve anywhere still reaches the pinned address.
    const res = await httpGet(`http://probe-pinned.invalid:${port}/api/health`, { address: '127.0.0.1' });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('forged tokens use the hub token format', () => {
  const token = forgeToken('change-me', { role: 'admin', at: 1 });
  const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
  assert.deepEqual(JSON.parse(raw.data), { role: 'admin', at: 1 });
  assert.match(raw.sig, /^[0-9a-f]{64}$/);
});

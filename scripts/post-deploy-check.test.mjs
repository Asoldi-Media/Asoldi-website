// scripts/post-deploy-check.mjs: GET-only, no credentials, no made-up tokens. Checked against a
// fake answer table, a local recording server, and a real local boot of server.js (127.0.0.1 only).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_BASE, formatReport, main, parseArgs, runPostDeployCheck } from './post-deploy-check.mjs';
import { REPO, bootHub } from './safe-mode/hub-boot.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** A production-like hub answer table. `overrides[path]` replaces one answer. */
function fakeHub(overrides = {}) {
  const answers = {
    '/api/health': { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, safeMode: false, build: { id: SHA.slice(0, 12), commit: SHA, source: 'build-file' } }) },
    '/': { status: 200, contentType: 'text/html; charset=UTF-8', body: '<!doctype html><html><body><div id="root"></div></body></html>' },
    '/api/hub/site-config': { status: 200, contentType: 'application/json', body: JSON.stringify({ id: '1', name: 'Shop', domain: 'shop.example.no', features: { blog: true } }) },
    '/myphoner-recordings': { status: 401, contentType: 'text/plain', body: 'Unauthorized' },
    '/myphoner-audio': { status: 401, contentType: 'text/plain', body: 'Unauthorized' },
    '/api/admin/sales/maker-status-callback': { status: 401, contentType: 'application/json', body: '{"message":"Unauthorized callback."}' },
    ...overrides,
  };
  const calls = [];
  const get = async (url, opts = {}) => {
    calls.push({ url, opts });
    const { pathname } = new URL(url);
    const key = Object.keys(answers).sort((a, b) => b.length - a.length).find((prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)));
    return answers[key || ''] || { status: 404, contentType: 'text/plain', body: 'Not found' };
  };
  return { get, calls };
}

const OPTIONS = { base: 'https://hub.example.test', domain: 'shop.example.no', expectCommit: '', timeoutMs: 1000 };
const failed = (report) => report.checks.filter((check) => !check.ok).map((check) => check.id);

test('arguments: production is the default base, a client domain is required', () => {
  assert.equal(DEFAULT_BASE, 'https://asoldi.com');
  assert.equal(parseArgs(['--domain', 'Shop.Example.no']).base, 'https://asoldi.com');
  assert.equal(parseArgs(['--domain', 'shop.example.no']).domain, 'shop.example.no');
  assert.equal(parseArgs(['--domain', 'a.no', '--base', 'http://127.0.0.1:3101/']).base, 'http://127.0.0.1:3101');
  assert.throws(() => parseArgs([]), /--domain/);
  assert.throws(() => parseArgs(['--domain', 'a.no', '--base', 'https://asoldi.com/api']), /origin/);
  assert.throws(() => parseArgs(['--domain', 'a.no/x']), /host name/);
  assert.throws(() => parseArgs(['--domain', 'a.no', '--expect-commit', 'main']), /sha/);
  assert.throws(() => parseArgs(['--domain', 'a.no', '--token', 'x']), /unknown argument/);
});

test('arguments: a domain with æ, ø or å is accepted in either spelling', () => {
  const unicode = parseArgs(['--domain', 'Frisør-Eksempel.no']);
  assert.equal(unicode.domain, 'frisør-eksempel.no');
  assert.deepEqual(unicode.domainVariants, ['frisør-eksempel.no', 'xn--frisr-eksempel-tqb.no']);
  const puny = parseArgs(['--domain', 'xn--frisr-eksempel-tqb.no']);
  assert.deepEqual(puny.domainVariants, ['xn--frisr-eksempel-tqb.no', 'frisør-eksempel.no']);
  assert.deepEqual(parseArgs(['--domain', 'shop.example.no']).domainVariants, ['shop.example.no']);
  for (const bad of ['a.no:443', 'https://a.no', 'a..no', '.a.no', 'a no', 'a.no@', 'a.no?x', 'a.no#x']) {
    assert.throws(() => parseArgs(['--domain', bad]), /host name/, bad);
  }
});

test('site-config: the hub is asked for the other spelling only when the first is not found', async () => {
  const stored = 'xn--frisr-eksempel-tqb.no';
  const asked = [];
  const answers = fakeHub();
  const get = async (url, opts) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname !== '/api/hub/site-config') return answers.get(url, opts);
    asked.push(searchParams.get('domain'));
    return searchParams.get('domain') === stored
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ domain: stored, features: {} }) }
      : { status: 404, contentType: 'application/json', body: '{"message":"Site not found"}' };
  };
  const options = (domain) => ({ ...OPTIONS, ...parseArgs(['--domain', domain, '--base', OPTIONS.base]) });
  const unicode = await runPostDeployCheck(options('frisør-eksempel.no'), { get });
  assert.deepEqual(failed(unicode), [], formatReport(unicode));
  assert.deepEqual(asked, ['frisør-eksempel.no', stored]);
  assert.match(unicode.checks.find((check) => check.id === 'site-config').detail, /HTTP 200 for xn--frisr-eksempel-tqb\.no/);
  asked.length = 0;
  assert.deepEqual(failed(await runPostDeployCheck(options(stored), { get })), []);
  assert.deepEqual(asked, [stored], 'found at once: no second request');
  // Neither spelling is a hub site: one failure that names both answers.
  asked.length = 0;
  const missing = await runPostDeployCheck(options('ukjent-frisør.no'), { get });
  assert.deepEqual(failed(missing), ['site-config']);
  assert.equal(asked.length, 2);
  assert.match(missing.checks.find((check) => check.id === 'site-config').detail, /HTTP 404 for ukjent-frisør\.no; HTTP 404 for xn--/);
  // Admin fields in any answer fail at once.
  const withAdminFields = async (url, opts) => (new URL(url).pathname === '/api/hub/site-config'
    ? { status: 200, contentType: 'application/json', body: JSON.stringify({ features: {}, clientAdmin: {} }) }
    : answers.get(url, opts));
  assert.deepEqual(failed(await runPostDeployCheck(options('frisør-eksempel.no'), { get: withAdminFields })), ['site-config']);
});

test('a production-like hub passes every check', async () => {
  const hub = fakeHub();
  const report = await runPostDeployCheck({ ...OPTIONS, expectCommit: SHA.slice(0, 10) }, { get: hub.get });
  assert.deepEqual(failed(report), [], formatReport(report));
  assert.deepEqual(report.checks.map((check) => check.id), ['health', 'home', 'site-config', 'recordings', 'audio', 'maker-callback']);
  assert.equal(report.build.commit, SHA);
  assert.match(formatReport(report), /All checks passed/);
});

test('each failure is reported by name', async () => {
  const cases = [
    [{ '/api/health': { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, safeMode: true, build: { id: 'x' } }) } }, ['health'], /safeMode is ON/],
    [{ '/api/health': { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, uptime: 3 }) } }, ['health'], /older build/],
    [{ '/api/health': { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, safeMode: false }) } }, ['health'], /no build id/],
    [{ '/api/health': { status: 502, contentType: 'text/html', body: 'Bad gateway' } }, ['health'], /HTTP 502/],
    [{ '/': { status: 500, contentType: 'text/html', body: 'index.html not found' } }, ['home'], /HTTP 500/],
    [{ '/api/hub/site-config': { status: 200, contentType: 'application/json', body: JSON.stringify({ features: {}, pendingAdmin: { username: 'a', passwordHash: 'h' } }) } }, ['site-config'], /pendingAdmin, passwordHash/],
    [{ '/api/hub/site-config': { status: 404, contentType: 'application/json', body: '{"message":"Site not found"}' } }, ['site-config'], /HTTP 404/],
    [{ '/myphoner-recordings': { status: 404, contentType: 'text/plain', body: 'Not found' } }, ['recordings'], /HTTP 404/],
    [{ '/myphoner-audio': { status: 200, contentType: 'audio/mpeg', body: 'ID3' } }, ['audio'], /HTTP 200/],
    // A route that no longer checks anything (for example a page fallback) is caught.
    [{ '/api/admin/sales/maker-status-callback': { status: 200, contentType: 'text/html', body: '<!doctype html>' } }, ['maker-callback'], /HTTP 200/],
  ];
  for (const [overrides, ids, pattern] of cases) {
    const report = await runPostDeployCheck(OPTIONS, { get: fakeHub(overrides).get });
    assert.deepEqual(failed(report), ids, JSON.stringify(overrides));
    assert.match(formatReport(report), pattern);
    assert.match(formatReport(report), new RegExp(`FAILED: ${ids.join(', ')}`));
  }
  const wrongCommit = await runPostDeployCheck({ ...OPTIONS, expectCommit: 'feedface' }, { get: fakeHub().get });
  assert.deepEqual(failed(wrongCommit), ['health']);
  const down = await runPostDeployCheck(OPTIONS, { get: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(down.ok, false);
  assert.equal(failed(down).length, 6);
  assert.match(down.checks[0].detail, /ECONNREFUSED/);
});

test('only GET requests, with no authorization, cookie or token header', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const path = req.url.split('?')[0];
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (path === '/api/health') return send(200, 'application/json', JSON.stringify({ ok: true, safeMode: false, build: { id: 'abc', commit: SHA } }));
    if (path === '/') return send(200, 'text/html', '<!doctype html><html></html>');
    if (path === '/api/hub/site-config') return send(200, 'application/json', JSON.stringify({ features: {}, domain: 'shop.example.no' }));
    return send(401, 'text/plain', 'Unauthorized');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    assert.equal(await main(['--base', base, '--domain', 'shop.example.no']), 0, lines.join('\n'));
  } finally {
    console.log = saved;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(seen.length, 6);
  for (const row of seen) {
    assert.equal(row.method, 'GET', row.url);
    for (const header of ['authorization', 'cookie', 'x-sales-callback-token', 'x-maker-callback-token']) {
      assert.equal(row.headers[header], undefined, `${header} on ${row.url}`);
    }
    assert.match(row.headers['user-agent'], /asoldi-post-deploy-check/);
  }
});

test('local boot of server.js: every route answers as the check expects (safe mode on here, so only health fails)', { timeout: 180_000 }, async (t) => {
  const domain = 'shop.example.no';
  const adminPassword = `boot-${Date.now()}-pw`;
  const hub = await bootHub(
    {
      HUB_SAFE_MODE: '1',
      PERSIST_PRODUCTION_ENV: '0',
      ADMIN_USERNAME: 'post-deploy-admin',
      ADMIN_PASSWORD: adminPassword,
      ADMIN_SECRET: '',
    },
    {
      seed(dataDir) {
        writeFileSync(join(dataDir, 'sites.json'), JSON.stringify([{
          id: 'site-check-1',
          name: 'Shop',
          domain,
          site_key: 's'.repeat(32),
          clientAdmin: { username: 'eier', email: 'eier@example.no', passwordHash: '$2a$10$abcdefghijklmnopqrstuv', pendingSync: true },
        }]));
      },
    }
  );
  t.after(() => hub.stop());
  assert.ok(hub.health, `hub did not start:\n${hub.log().slice(-3000)}`);
  // /api/health carries the build: here the git checkout the test runs from (no dist build file).
  assert.equal(hub.health.safeMode, true);
  assert.ok(hub.health.build, 'build info in /api/health');
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    head = '';
  }
  if (head && !existsSync(join(REPO, 'dist', 'build-info.json'))) {
    assert.equal(hub.health.build.commit, head);
    assert.equal(hub.health.build.source, 'git');
  }

  const report = await runPostDeployCheck({ base: hub.base, domain, expectCommit: '', timeoutMs: 15_000 });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.health.ok, false);
  assert.match(byId.health.detail, /safeMode is ON/);
  assert.equal(byId['site-config'].ok, true, byId['site-config'].detail);
  assert.equal(byId.recordings.ok, true, byId.recordings.detail);
  assert.equal(byId.audio.ok, true, byId.audio.detail);
  assert.equal(byId['maker-callback'].ok, true, byId['maker-callback'].detail);
  // The home page needs a Vite build (dist/index.html), which a test checkout may not have.
  assert.equal(byId.home.ok, existsSync(join(REPO, 'dist', 'index.html')), byId.home.detail);

  const adminToken = await hub.adminToken('post-deploy-admin', adminPassword);
  assert.ok(adminToken, 'admin login');

  // The callback GET accepts the real token and nothing else.
  const tokenRes = await fetch(`${hub.base}/api/admin/system/maker-callback-token`, { headers: { authorization: `Bearer ${adminToken}` } });
  const { token } = await tokenRes.json();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(hub.dataDir, 'secrets', 'maker-callback-token'), 'utf8').trim(), token);
  const withToken = await fetch(`${hub.base}/api/admin/sales/maker-status-callback`, { headers: { 'x-sales-callback-token': token } });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await withToken.json(), { ok: true });
  assert.equal((await fetch(`${hub.base}/api/admin/sales/maker-status-callback`, { headers: { 'x-sales-callback-token': 'f'.repeat(64) } })).status, 401);

  // The client admin setter refuses a weak password with a Norwegian 400 over HTTP.
  const put = (body) => fetch(`${hub.base}/api/hub/sites/site-check-1/client-admin`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  for (const password of ['kort', 'changeme', '12345678', 'Passord']) {
    const res = await put({ password });
    assert.equal(res.status, 400, password);
    assert.match((await res.json()).message, /minst 8 tegn|for enkelt å gjette/);
  }
  const ok = await put({ name: 'Eier', password: 'kafe-bakke-2026' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).clientAdmin.passwordSet, true);
});

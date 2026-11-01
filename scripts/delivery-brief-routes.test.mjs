// Brief routes (lib/routes/brief-routes.js) on a local express app with the real Maker host auth,
// the real access log and a stubbed LLM. Covers the switch (off, shadow, auto, pilots), ETag/304,
// the 403 for a host without a routed job or linked run, and that nothing is written while off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const baseDir = mkdtempSync(join(tmpdir(), 'asoldi-brief-routes-'));
process.env.APP_DATA_DIR = baseDir;
delete process.env.DATA_DIR;

const hosts = await import('../data/maker-hosts.js');
const hardening = await import('../lib/auth-hardening.js');
const makerAuthLib = await import('../lib/maker-auth.js');
const meta = await import('../lib/maker-host-meta.js');
const accessLog = await import('../lib/maker-access-log.js');
const routes = await import('../lib/routes/brief-routes.js');
const { defaultAutomationSettings } = await import('../data/automation-settings.js');
const { normalizeSitePlan } = await import('../lib/site-plan-model.js');
const { registerOptionalRoutes, OPTIONAL_ROUTE_MODULES } = await import('../lib/routes/optional-routes.js');

const temps = [baseDir];
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-brief-routes-case-'));
  temps.push(dir);
  return dir;
}

const SALES_TEXT = [
  'Selger: Hei, takk for at du tok deg tid i dag.',
  'Kunde: Firmaet heter Eksempel Bad og vi holder til i Eksempelby.',
  'Kunde: Telefonnummeret på siden skal stå helt øverst i menyen.',
  'Selger: Bloggen er inkludert i pakken, og vi skriver innlegg hver måned.',
].join('\n');

const TRANSCRIPTS = { 'syn-r-sales': SALES_TEXT };

function clientRecord(id, runId) {
  return {
    id,
    businessName: 'Eksempel Bad AS',
    developerOwnerId: 'developer:dev-1',
    makerRun: { runId },
    sitePlan: normalizeSitePlan({ status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], pages: 5, billing: 'month', signedAt: '2026-10-02T10:00:00.000Z' }),
    meetings: [{ meetingId: 'syn-r-sales', purpose: 'sales', startedAt: '2026-10-01T10:00:00.000Z', hasTranscript: true }],
  };
}

const briefDeps = {
  readArchivedTranscripts: () => [],
  readStoredMeeting: (meetingId) => (TRANSCRIPTS[meetingId] ? { meetingId, transcript: TRANSCRIPTS[meetingId] } : null),
  offer: () => ({ offer: null, offerHash: '' }),
  sites: () => [],
  profiles: () => [],
  gate: () => null,
  mediaManifest: () => [],
  agreedKeywords: () => null,
  cmsSetup: () => null,
  featureKeys: ['blog.autoPosts'],
  noFeatureAvailability: true,
};

function stubLlm() {
  const state = { calls: 0 };
  return {
    state,
    json: async (request) => {
      state.calls += 1;
      const chunk = String(request.user).split('Transcript part:\n')[1] || '';
      const data = { facts: [], directives: [], iterations: [], promises: [], followUps: [], approvalSignals: [], requests: [], openQuestions: [] };
      if (chunk.includes('Firmaet heter')) data.facts.push({ path: 'identity.brandName', value: 'Eksempel Bad', quote: 'Firmaet heter Eksempel Bad', speaker: 'Kunde' });
      if (chunk.includes('Telefonnummeret')) data.directives.push({ kind: 'change', area: 'chrome.header', ask: 'Nummer øverst', priority: 'must', quote: 'Telefonnummeret på siden skal stå helt øverst', speaker: 'Kunde' });
      return { data, usd: 0, route: { route: 'claude:claude-haiku-5-5:medium' } };
    },
  };
}

function settingsWith(brief, extra = {}) {
  const settings = defaultAutomationSettings();
  return { ...settings, brief: { ...settings.brief, ...brief }, ...extra };
}

function developmentAuth(req, res, next) {
  const who = String(req.headers['x-test-user'] || '');
  if (!who) return res.status(401).json({ message: 'Unauthorized' });
  req.developmentUser = who === 'admin'
    ? { role: 'admin', isAdmin: true, userId: '', username: 'admin', accountKey: 'admin' }
    : { role: 'developer', isAdmin: false, userId: who, username: who, accountKey: `developer:${who}` };
  return next();
}

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function snapshot(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)}|${stat.size}|${stat.mtimeMs}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** A hub-like app with the brief routes; `current.settings` can be changed between requests. */
async function setup(t, { settings = defaultAutomationSettings(), routedJobs = null, extraDeps = {} } = {}) {
  const dir = tempDir();
  accessLog.resetMakerAccessLogMemoForTests();
  const { host, token } = hosts.createMakerHost({ label: 'Test host' }, { dataDir: dir });
  const { token: otherToken } = hosts.createMakerHost({ label: 'Other host' }, { dataDir: dir });
  meta.recordHostHeartbeat(host.hostId, { runIds: ['run-own', 'run-pilot'] }, { dataDir: dir });
  const clients = {
    'syn-own': clientRecord('syn-own', 'run-own'),
    'syn-pilot': clientRecord('syn-pilot', 'run-pilot'),
    'syn-other': clientRecord('syn-other', 'run-other'),
  };
  const current = { settings };
  const makerAuth = makerAuthLib.createMakerAuth({
    legacyHolder: hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 }),
    dataDir: dir,
    env: {},
  });
  const llm = stubLlm();
  const app = express();
  app.use(express.json());
  await routes.register(app, {
    developmentAuth,
    makerAuth,
    sales: { getSalesClientById: (id) => clients[id] || null },
    getDataDir: () => dir,
    settings: () => current.settings,
    briefLlm: llm,
    briefDeps,
    ...(routedJobs ? { routedJobs } : {}),
    log: { warn() {}, error() {}, log() {} },
    ...extraDeps,
  });
  const server = await serve(app);
  t.after(server.close);
  const call = (method, path, { headers = {}, body } = {}) => fetch(`${server.base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { dir, current, token, otherToken, host, clients, llm, call, maker: { 'x-maker-host-token': token }, admin: { 'x-test-user': 'admin' } };
}

test('switch off (the default): every brief route answers 404 brief-disabled and nothing is written', async (t) => {
  const hub = await setup(t);
  const before = snapshot(hub.dir);
  const cases = [
    ['GET', '/api/admin/development/syn-own/brief', hub.admin],
    ['GET', '/api/admin/development/syn-own/brief?format=md', hub.admin],
    ['GET', '/api/admin/development/syn-own/brief/versions', hub.admin],
    ['POST', '/api/admin/development/syn-own/brief/rebuild', hub.admin],
    ['PATCH', '/api/admin/development/syn-own/brief/facts', hub.admin],
    ['GET', '/api/maker/clients/syn-own/brief', hub.maker],
    ['GET', '/api/maker/clients/syn-own/transcripts/' + 'a'.repeat(64), hub.maker],
    ['GET', '/api/maker/clients/syn-own/brief', {}],
    ['GET', '/api/admin/development/syn-own/brief', {}],
  ];
  for (const [method, path, headers] of cases) {
    const response = await hub.call(method, path, { headers, ...(method === 'PATCH' ? { body: { path: 'contact.phone', status: 'accepted' } } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { message: 'The delivery brief is switched off.', code: 'brief-disabled' });
  }
  assert.deepEqual(snapshot(hub.dir), before, 'no access log, no host stamp, no brief file');
  assert.equal(hub.llm.state.calls, 0);
});

test('shadow: the board builds and reads the brief; the Maker gets 404 brief-disabled after its access is logged', async (t) => {
  const hub = await setup(t, { settings: settingsWith({ enabled: true }) });
  const missing = await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: hub.admin });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'no-brief');

  const rebuilt = await hub.call('POST', '/api/admin/development/syn-own/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  assert.equal(rebuilt.status, 200);
  const result = await rebuilt.json();
  assert.equal(result.status, 'built');
  assert.equal(result.version, 1);

  const got = await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: hub.admin });
  assert.equal(got.status, 200);
  const etag = got.headers.get('etag');
  const body = await got.json();
  assert.equal(etag, `"${body.hash}"`);
  assert.equal(body.schema, 'asoldi.delivery-brief/1');
  assert.equal((await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: { ...hub.admin, 'if-none-match': etag } })).status, 304);
  const md = await hub.call('GET', '/api/admin/development/syn-own/brief?format=md', { headers: hub.admin });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(await md.text(), /## Direktiver/);
  const versions = await (await hub.call('GET', '/api/admin/development/syn-own/brief/versions', { headers: hub.admin })).json();
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.mode, 'shadow');

  // Developers see only their own clients and may change only those.
  assert.equal((await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: { 'x-test-user': 'dev-1' } })).status, 200);
  assert.equal((await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: { 'x-test-user': 'dev-2' } })).status, 404);
  assert.equal((await hub.call('GET', '/api/admin/development/syn-own/brief', {})).status, 401);

  const maker = await hub.call('GET', '/api/maker/clients/syn-own/brief', { headers: hub.maker });
  assert.equal(maker.status, 404);
  assert.equal((await maker.json()).code, 'brief-disabled');
  const rows = accessLog.readMakerAccessLog({ dataDir: hub.dir });
  assert.equal(rows[0].kind, 'brief');
  assert.equal(rows[0].allowed, true);
  assert.equal(rows[0].clientId, 'syn-own');
});

test('a host without a routed job or the linked run gets 403, logged; a routed job opens access', async (t) => {
  const pilots = { pilotClientIds: ['syn-own', 'syn-other'] };
  const jobs = [];
  const hub = await setup(t, { settings: settingsWith({ enabled: true, mode: 'auto' }, pilots), routedJobs: (clientId) => jobs.filter((job) => job.salesClientId === clientId) });
  await hub.call('POST', '/api/admin/development/syn-other/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const refused = await hub.call('GET', '/api/maker/clients/syn-other/brief', { headers: hub.maker });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'maker-client-scope');
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-other/transcripts/' + 'b'.repeat(64), { headers: hub.maker })).status, 403);
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-own/brief', { headers: { 'x-maker-host-token': hub.otherToken } })).status, 403, 'another host with no run');
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-own/brief', {})).status, 401);
  const refusals = accessLog.readMakerAccessLog({ dataDir: hub.dir }).filter((row) => !row.allowed);
  assert.ok(refusals.length >= 3);
  assert.ok(refusals.every((row) => row.reason === 'not-routed'));
  assert.ok(refusals.some((row) => row.kind === 'transcript' && row.ref === 'b'.repeat(64)));

  jobs.push({ salesClientId: 'syn-other', hostId: hub.host.hostId, status: 'queued' });
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-other/brief', { headers: hub.maker })).status, 200);
});

test('auto: a pilot client\'s brief and transcripts reach the Maker with ETag and 304; a non-pilot stays in shadow', async (t) => {
  const hub = await setup(t, { settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: ['syn-pilot'] }) });
  const none = await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).code, 'no-brief');
  await hub.call('POST', '/api/admin/development/syn-pilot/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const got = await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker });
  assert.equal(got.status, 200);
  const etag = got.headers.get('etag');
  const body = await got.json();
  assert.equal(etag, `"${body.hash}"`);
  assert.equal(JSON.stringify(body).includes(SALES_TEXT), false, 'no transcript text in the brief');
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: { ...hub.maker, 'if-none-match': etag } })).status, 304);

  const sha = body.transcripts[0].sha256;
  const transcript = await hub.call('GET', `/api/maker/clients/syn-pilot/transcripts/${sha}`, { headers: hub.maker });
  assert.equal(transcript.status, 200);
  assert.equal(transcript.headers.get('cache-control'), 'no-store');
  const tBody = await transcript.json();
  assert.equal(tBody.transcript, SALES_TEXT);
  assert.equal(tBody.sha256, sha);
  assert.equal((await hub.call('GET', `/api/maker/clients/syn-pilot/transcripts/${'c'.repeat(64)}`, { headers: hub.maker })).status, 404);
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-pilot/transcripts/not-a-sha', { headers: hub.maker })).status, 400);

  // syn-own is linked to this host too, but it is not a pilot: shadow, so the Maker gets nothing.
  await hub.call('POST', '/api/admin/development/syn-own/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const shadow = await hub.call('GET', '/api/maker/clients/syn-own/brief', { headers: hub.maker });
  assert.equal(shadow.status, 404);
  assert.equal((await shadow.json()).code, 'brief-disabled');

  const kinds = accessLog.readMakerAccessLog({ dataDir: hub.dir }).map((row) => row.kind);
  assert.ok(kinds.includes('brief') && kinds.includes('transcript'), 'every fetch is logged');
  for (const row of accessLog.readMakerAccessLog({ dataDir: hub.dir })) {
    assert.deepEqual(Object.keys(row).filter((key) => !['at', 'hostId', 'clientId', 'kind', 'allowed', 'reason', 'runId', 'ref'].includes(key)), [], 'ids only');
  }

  // Switching it off again closes everything at once.
  hub.current.settings = defaultAutomationSettings();
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker })).status, 404);
});

test('reviews through the board: directive status and fact review re-assemble the brief without an LLM call', async (t) => {
  const hub = await setup(t, { settings: settingsWith({ enabled: true }) });
  await hub.call('POST', '/api/admin/development/syn-own/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const first = await (await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: hub.admin })).json();
  const directive = first.directives[0];
  const calls = hub.llm.state.calls;
  const patched = await hub.call('PATCH', `/api/admin/development/syn-own/brief/directives/${directive.id}`, { headers: { 'x-test-user': 'dev-1' }, body: { status: 'accepted' } });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).version, 2);
  const fact = await hub.call('PATCH', '/api/admin/development/syn-own/brief/facts', { headers: hub.admin, body: { path: 'identity.brandName', status: 'client-confirmed' } });
  assert.equal(fact.status, 200);
  const latest = await (await hub.call('GET', '/api/admin/development/syn-own/brief', { headers: hub.admin })).json();
  assert.equal(latest.directives.find((row) => row.id === directive.id).status, 'accepted');
  assert.equal(latest.directives.find((row) => row.id === directive.id).reviewedBy, 'dev-1');
  assert.equal(latest.factSources['identity.brandName'].status, 'client-confirmed');
  assert.equal(hub.llm.state.calls, calls, 'no LLM call for a review');
  assert.equal((await hub.call('PATCH', `/api/admin/development/syn-own/brief/directives/${directive.id}`, { headers: hub.admin, body: { status: 'maybe' } })).status, 400);
  assert.equal((await hub.call('PATCH', '/api/admin/development/syn-own/brief/directives/not-an-id', { headers: hub.admin, body: { status: 'accepted' } })).status, 400);
  assert.equal((await hub.call('PATCH', '/api/admin/development/syn-own/brief/facts', { headers: { 'x-test-user': 'dev-2' }, body: { path: 'contact.phone', status: 'accepted' } })).status, 404);
  const started = await hub.call('POST', '/api/admin/development/syn-own/brief/rebuild', { headers: hub.admin });
  assert.equal(started.status, 202);
});

test('the board\'s rebuild shares the lease with the loop: 409 brief-busy while another runner holds it, and no LLM call', async (t) => {
  const hub = await setup(t, { settings: settingsWith({ enabled: true }) });
  const { acquireLease } = await import('../data/email-store.js');
  const held = await acquireLease('brief:syn-other', 60_000);
  for (const body of [{ wait: true }, {}]) {
    const busy = await hub.call('POST', '/api/admin/development/syn-other/brief/rebuild', { headers: hub.admin, body });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'brief-busy');
  }
  assert.equal(hub.llm.state.calls, 0);
  await held.release();
  const built = await hub.call('POST', '/api/admin/development/syn-other/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  assert.equal(built.status, 200);
  assert.ok(hub.llm.state.calls > 0);
  // The lease is released after the rebuild, so the next one can start.
  const again = await hub.call('POST', '/api/admin/development/syn-other/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'unchanged');
});

test('fact reviews through the board: list positions and broken values are refused with 400 and nothing is stored', async (t) => {
  const hub = await setup(t, { settings: settingsWith({ enabled: true }) });
  await hub.call('POST', '/api/admin/development/syn-other/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const versions = async () => (await (await hub.call('GET', '/api/admin/development/syn-other/brief/versions', { headers: hub.admin })).json()).versions.length;
  const before = await versions();
  for (const [body, code] of [
    [{ path: 'claims.stats[0]', status: 'accepted' }, 'bad-fact-path'],
    [{ path: 'products.catalogs', status: 'accepted', value: 'x' }, 'bad-fact-path'],
    [{ path: 'schema', status: 'accepted', value: 'other' }, 'bad-fact-path'],
    [{ path: 'contact.onlineOnly', status: 'accepted', value: 'kanskje' }, 'invalid-review'],
  ]) {
    const response = await hub.call('PATCH', '/api/admin/development/syn-other/brief/facts', { headers: hub.admin, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    const answer = await response.json();
    assert.equal(answer.code, code, JSON.stringify(body));
    if (code === 'invalid-review') assert.ok(answer.errors.length >= 1 && answer.errors.every((row) => typeof row.path === 'string'));
  }
  assert.equal(await versions(), before, 'no new version');
  const { readReviews } = await import('../lib/delivery-brief/store.js');
  assert.equal(readReviews('syn-other', { dataDir: hub.dir }).revision, 0, 'no review stored');
});

test('ETag: with a media signer the ETag follows the signed URLs, so a 304 never keeps an expired link', async (t) => {
  let bucket = 1;
  const media = [{ id: 'media-1', bucket: 'gallery', fileName: 'bad.jpg', mime: 'image/jpeg', bytes: 10, sha256: 'a'.repeat(64), url: 'https://example.com/m/1' }];
  const hub = await setup(t, {
    settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: ['syn-pilot'] }),
    extraDeps: {
      briefDeps: { ...briefDeps, mediaManifest: () => media },
      signMediaUrl: (item) => `${item.url}?exp=${bucket}&sig=s${bucket}`,
    },
  });
  await hub.call('POST', '/api/admin/development/syn-pilot/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  for (const [path, headers] of [['/api/maker/clients/syn-pilot/brief', hub.maker], ['/api/admin/development/syn-pilot/brief', hub.admin]]) {
    bucket = 1;
    const first = await hub.call('GET', path, { headers });
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    const body = await first.json();
    assert.notEqual(etag, `"${body.hash}"`, 'the ETag covers the signed URLs');
    assert.equal(body.facts.media.manifest[0].url, 'https://example.com/m/1?exp=1&sig=s1');
    assert.equal((await hub.call('GET', path, { headers: { ...headers, 'if-none-match': etag } })).status, 304, 'same signature window: 304');
    bucket = 2;
    const later = await hub.call('GET', path, { headers: { ...headers, 'if-none-match': etag } });
    assert.equal(later.status, 200, 'new signatures: the full brief again');
    assert.equal((await later.json()).facts.media.manifest[0].url, 'https://example.com/m/1?exp=2&sig=s2');
  }
});

test('the brief store is registered with the personal-data registry when the routes register, before any rebuild', async (t) => {
  const store = await import('../lib/delivery-brief/store.js');
  store.resetBriefStoreRegistrationForTests();
  const registered = [];
  const hub = await setup(t, { extraDeps: { personalDataRegistry: { registerStore: (entry) => registered.push(entry) } } });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'delivery-briefs');
  assert.equal(registered[0].clientKey, 'directory');
  assert.equal(typeof registered[0].export, 'function');
  assert.equal(typeof registered[0].erase, 'function');
  assert.deepEqual(snapshot(join(hub.dir, 'delivery-briefs')), [], 'registering writes nothing');
  assert.equal(hub.llm.state.calls, 0);
});

test('media links: the build\'s signer signs hub media items only while the media switch is on, with the same links (and ETag) within the hour', async (t) => {
  const assetId = `ma_${'a'.repeat(32)}`;
  let mediaOn = true;
  const signed = [];
  const modules = {
    '../media-manifest.js': {
      MEDIA_ROUTE_PREFIX: '/api/maker/media/',
      MEDIA_URL_TTL_MS: 24 * 60 * 60 * 1000,
      buildMediaManifest: (clientId) => ({ clientId, items: [{ id: assetId, source: 'bank', bucket: 'gallery', name: 'bad.jpg', mime: 'image/jpeg', bytes: 10, sha256: 'b'.repeat(64), rightsConfirmed: true, url: `/api/maker/media/${assetId}?c=${clientId}&exp=1&sig=${'0'.repeat(64)}` }], external: [] }),
      signMediaUrl: ({ assetId: id, clientId, expiresAt }) => {
        signed.push({ id, clientId, expiresAt });
        return `/api/maker/media/${id}?c=${clientId}&exp=${expiresAt}&sig=${'1'.repeat(64)}`;
      },
    },
    '../privacy-settings.js': { signedMediaEnabled: () => mediaOn },
  };
  const { mediaManifest: _media, ...base } = briefDeps;
  const hub = await setup(t, {
    settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: ['syn-pilot'] }),
    extraDeps: { briefDeps: { ...base, modules } },
  });
  await hub.call('POST', '/api/admin/development/syn-pilot/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  const first = await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker });
  assert.equal(first.status, 200);
  const body = await first.json();
  const url = body.facts.media.manifest[0].url;
  assert.match(url, new RegExp(`^/api/maker/media/${assetId}\\?c=syn-pilot&exp=\\d+&sig=1{64}$`));
  const exp = Number(/exp=(\d+)/.exec(url)[1]);
  assert.equal(exp % (60 * 60 * 1000), 0, 'the expiry is on a full hour');
  assert.ok(exp - Date.now() >= 24 * 60 * 60 * 1000 - 5000, 'and about 24 hours away or more');
  assert.deepEqual(signed.at(-1), { id: assetId, clientId: 'syn-pilot', expiresAt: exp }, 'signed with the asset id and the client id');
  const etag = first.headers.get('etag');
  assert.notEqual(etag, `"${body.hash}"`);
  assert.equal((await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: { ...hub.maker, 'if-none-match': etag } })).status, 304, 'the same links within the hour');

  // The media switch goes off: the stored (unsigned) links go out as they are and nothing is signed.
  mediaOn = false;
  const before = signed.length;
  const off = await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker });
  const offBody = await off.json();
  assert.equal(off.headers.get('etag'), `"${offBody.hash}"`);
  assert.equal(offBody.facts.media.manifest[0].url, `/api/maker/media/${assetId}`);
  assert.equal(signed.length, before);
});

test('the Maker never gets live captions as a transcript', async (t) => {
  const captions = 'Kunde: Direkteteksting mens møtet pågår.';
  const stored = { 'syn-r-sales': { meetingId: 'syn-r-sales', transcript: captions, isLive: true } };
  const hub = await setup(t, {
    settings: settingsWith({ enabled: true, mode: 'auto' }, { pilotClientIds: ['syn-pilot'] }),
    extraDeps: { briefDeps: { ...briefDeps, readStoredMeeting: (meetingId) => (stored[meetingId] ? { ...stored[meetingId] } : null) } },
  });
  const rebuilt = await (await hub.call('POST', '/api/admin/development/syn-pilot/brief/rebuild', { headers: hub.admin, body: { wait: true } })).json();
  assert.equal(hub.llm.state.calls, 0, 'captions are never sent to the model');
  assert.equal(rebuilt.status, 'built');
  const body = await (await hub.call('GET', '/api/maker/clients/syn-pilot/brief', { headers: hub.maker })).json();
  assert.deepEqual(body.transcripts, []);
  const sha = createHash('sha256').update(captions).digest('hex');
  const res = await hub.call('GET', `/api/maker/clients/syn-pilot/transcripts/${sha}`, { headers: hub.maker });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'no-transcript');

  // The final copy arrives: the transcript is extracted and served.
  stored['syn-r-sales'] = { meetingId: 'syn-r-sales', transcript: SALES_TEXT, isLive: false, summaryStatus: 'processed' };
  await hub.call('POST', '/api/admin/development/syn-pilot/brief/rebuild', { headers: hub.admin, body: { wait: true } });
  assert.ok(hub.llm.state.calls > 0);
  const finalSha = createHash('sha256').update(SALES_TEXT).digest('hex');
  assert.equal((await hub.call('GET', `/api/maker/clients/syn-pilot/transcripts/${finalSha}`, { headers: hub.maker })).status, 200);
});

test('optional routes: the brief module registers through the shared list', async () => {
  assert.ok(OPTIONAL_ROUTE_MODULES.includes('./brief-routes.js'));
  const app = express();
  const seen = [];
  const fakeApp = new Proxy(app, { get: (target, key) => (['get', 'post', 'patch'].includes(key) ? (path, ...rest) => { seen.push(`${key} ${path}`); return target[key](path, ...rest); } : target[key]) });
  const dir = tempDir();
  const makerAuth = makerAuthLib.createMakerAuth({ legacyHolder: hardening.createHubSecretHolder({ envValue: '', envRule: 'any', lazy: true, dataDir: dir, name: 'maker-callback-token', bytes: 32 }), dataDir: dir, env: {} });
  const registered = await registerOptionalRoutes(fakeApp, { developmentAuth, makerAuth, sales: { getSalesClientById: () => null }, getDataDir: () => dir }, { modules: ['./brief-routes.js'] });
  assert.deepEqual(registered, ['./brief-routes.js']);
  assert.ok(seen.includes('get /api/maker/clients/:id/brief'));
  assert.ok(seen.includes('get /api/maker/clients/:id/transcripts/:sha256'));
  assert.ok(seen.includes('post /api/admin/development/:id/brief/rebuild'));
});

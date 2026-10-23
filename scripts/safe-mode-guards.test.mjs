// One case per safe-mode chokepoint. Network clients are spies installed before safe mode,
// so anything that got past a guard would be visible. No test here reaches the internet:
// blocked requests never connect, and allowed requests hit the spies or a loopback server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-safe-guards-'));
process.env.APP_DATA_DIR = dataDir;
Object.assign(process.env, {
  MYPHONER_API_KEY: 'fake-myphoner',
  MYPHONER_SUBDOMAIN: 'asoldi',
  LUCA_API_KEY: 'fake-luca',
  WORDPRESS_URL: 'https://wp.example.invalid',
  WORDPRESS_USERNAME: 'u',
  WORDPRESS_APP_PASSWORD: 'p',
  DEEPSEEK_API_KEY: 'fake-deepseek',
  ANTHROPIC_API_KEY: 'fake-anthropic',
  GEMINI_API_KEY: 'fake-gemini',
  STRIPE_SECRET_KEY: 'sk_live_fakeLiveKeyForTests',
});

// Last line of defence for the test itself: any non-loopback socket that got past the
// guards is recorded here and refused, so a guard bug can never reach the internet.
const leakedSockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127.|localhost$|::1$)/.test(host)) return realConnect.apply(this, args);
  leakedSockets.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTLEAK' })));
  return this;
};

const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  fetchCalls.push({ url, method: String(init?.method || 'GET').toUpperCase(), body: init?.body });
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, init);
  return new Response(JSON.stringify({ data: { saleInvoices: { nodes: [] } }, ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const safeMode = await import('../lib/safe-mode.js');
const egress = await import('../lib/safe-mode-egress.js');
const ai = await import('../lib/safe-mode-ai.js');
const calendar = await import('../lib/google-calendar.js');
const fireflies = await import('../lib/fireflies-webhook.js');
const myphoner = await import('../lib/myphoner-api.js');
const luca = await import('../lib/employee-luca.js');
const wordpress = await import('../lib/employee-wordpress.js');
const shop = await import('../lib/shop-payments.js');
const stripe = await import('../lib/stripe.js');
const { deepseekChatJson, DeepseekError } = await import('../lib/deepseek.js');
const { claudeMessages } = await import('../lib/claude-messages.js');
const { imapListCommands } = await import('../packages/suite/core/mail/imap.js');
const { imapReadOnly } = await import('../lib/inbox-bot/mail-imap.js');

function install(allow = '', extra = {}) {
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: allow, ...extra }, dataDir, log: null });
}

function intents(kind) {
  return safeMode.readRecentIntents(500).filter((row) => row.kind === kind);
}

function httpRequestOutcome(mod, url, options = {}) {
  return new Promise((resolve) => {
    const req = mod.request(url, options, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end();
  });
}

test('calendar writes return stand-ins and record calendarWrite intents (no Google call)', async () => {
  install();
  const client = { id: 'c1', businessName: 'X', meetingAt: new Date(Date.now() + 3600e3).toISOString(), meetingMode: 'online' };
  const upsert = await calendar.upsertMeetingEvent(client, '', 'sales:x');
  assert.equal(upsert.safeMode, true);
  assert.match(upsert.eventId, /^safe-/);
  assert.equal(upsert.meetLink, 'https://meet.google.com/safe-mode');
  assert.equal(calendar.isRealGoogleMeetLink(upsert.meetLink), false, 'the stand-in link never looks like a real Meet');
  assert.equal((await calendar.deleteMeetingEvent('evt1', 'sales:x')).safeMode, true);
  assert.equal((await calendar.upsertSalesReminderEvent(client, { dueAt: client.meetingAt }, '', 'sales:x')).safeMode, true);
  assert.equal((await calendar.upsertRecordedSalesActionEvent(client, { dueAt: client.meetingAt }, '', 'sales:x')).safeMode, true);
  assert.equal(intents('calendarWrite').length, 4);
});

test('calendarWrite allowed: the guard steps aside (the real code runs and fails without a token)', async () => {
  install('calendarWrite');
  await assert.rejects(() => calendar.upsertMeetingEvent({ meetingAt: new Date().toISOString() }, '', 'nobody'));
});

test('Fireflies: addToLive blocked, transcript ingest blocked by default, allowed with firefliesIngest', async () => {
  install();
  fetchCalls.length = 0;
  const join = await fireflies.addFirefliesToLiveMeeting({ meetingLink: 'https://meet.google.com/abc-defg-hij', apiKey: 'k', fetchImpl: globalThis.fetch });
  assert.equal(join.ok, false);
  assert.equal(join.safeMode, true);
  await assert.rejects(() => fireflies.fetchFirefliesTranscript('m1', { apiKey: 'k', fetchImpl: globalThis.fetch }), /firefliesIngest/);
  await assert.rejects(() => fireflies.fetchRecentFirefliesTranscripts({ apiKey: 'k', fetchImpl: globalThis.fetch }), /firefliesIngest/);
  assert.equal(fetchCalls.length, 0);
  assert.ok(intents('firefliesLiveJoin').length >= 1);
  assert.ok(intents('firefliesIngest').length >= 2);
  install('firefliesIngest');
  await fireflies.fetchRecentFirefliesTranscripts({ apiKey: 'k', fetchImpl: async (url, init) => { fetchCalls.push({ url, init }); return new Response('{"data":{"transcripts":[]}}', { status: 200 }); } });
  assert.equal(fetchCalls.length, 1);
});

test('Fireflies egress: a GraphQL mutation is refused even when ingest (queries) is allowed', async () => {
  install('firefliesIngest');
  fetchCalls.length = 0;
  await assert.rejects(
    () => globalThis.fetch('https://api.fireflies.ai/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation AddToLiveMeeting { addToLiveMeeting(meeting_link:"x") { success } }' }) }),
    (error) => error?.cause?.code === 'ESAFEMODE' && error.cause.kind === 'firefliesLiveJoin'
  );
  await globalThis.fetch('https://api.fireflies.ai/graphql', { method: 'POST', body: JSON.stringify({ query: 'query { transcripts { id } }' }) });
  assert.equal(fetchCalls.length, 1, 'only the query went through');
});

test('Myphoner: writes blocked, GET allowed', async () => {
  install();
  fetchCalls.length = 0;
  const write = await myphoner.myPhonerRequest('/leads/1', { method: 'PATCH', body: { x: 1 } });
  assert.equal(write.success, false);
  assert.equal(write.safeMode, true);
  assert.equal(fetchCalls.length, 0);
  await myphoner.myPhonerRequest('/leads/1', { method: 'GET' });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'GET');
  assert.ok(intents('myphonerWrite').length >= 1);
});

test('Luca accounting: mutations blocked (accountingWrite), queries allowed', async () => {
  install();
  assert.equal(luca.lucaDocumentWrites('mutation CreateInvoice { x }'), true);
  assert.equal(luca.lucaDocumentWrites('\n  query GetIncomeSummary { saleInvoices { nodes { id } } }'), false);
  fetchCalls.length = 0;
  const status = await luca.testLucaConnection();
  assert.equal(status.connected, true, 'the read query went through to the spy');
  assert.equal(fetchCalls.length, 1);
  await assert.rejects(
    () => globalThis.fetch('https://go.lucaregnskap.no/api/v1/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation { createSaleInvoice(input:{}) { id } }' }) }),
    (error) => error?.cause?.kind === 'accountingWrite'
  );
  assert.equal(fetchCalls.length, 1);
});

test('WordPress: writes blocked, reads allowed', async () => {
  install();
  fetchCalls.length = 0;
  const write = await wordpress.wpFetch('/users/1', { method: 'POST', body: '{}' });
  assert.equal(write.safeMode, true);
  assert.equal(fetchCalls.length, 0);
  await wordpress.wpFetch('/users?per_page=1');
  assert.equal(fetchCalls.length, 1);
  assert.ok(intents('wordpressWrite').length >= 1);
});

test('Stripe: webhook admin blocked (423), live keys blocked, test keys allowed', async () => {
  install();
  let factoryCalls = 0;
  shop.setShopPaymentDeps({ stripeFactory: () => { factoryCalls += 1; return {}; } });
  await assert.rejects(() => shop.ensureStripeConnectWebhook({ hubUrl: 'http://127.0.0.1:3101' }), (error) => error.status === 423 && error.kind === 'stripeWebhookAdmin');
  assert.equal(factoryCalls, 0);
  assert.throws(() => stripe.getStripe(), (error) => error.kind === 'paymentsLive');
  const policy = egress.buildEgressPolicy({ allow: new Set(['paymentsTest']) });
  const live = egress.evaluateEgress(policy, { host: 'api.stripe.com', method: 'POST', path: '/v1/checkout/sessions', headers: { authorization: 'Bearer sk_live_x' } });
  assert.deepEqual([live.allowed, live.kind], [false, 'paymentsLive']);
  const testKey = egress.evaluateEgress(policy, { host: 'api.stripe.com', method: 'POST', path: '/v1/checkout/sessions', headers: { authorization: 'Bearer sk_test_x' } });
  assert.equal(testKey.allowed, true);
  const hook = egress.evaluateEgress(policy, { host: 'api.stripe.com', method: 'POST', path: '/v1/webhook_endpoints', headers: { authorization: 'Bearer sk_test_x' } });
  assert.deepEqual([hook.allowed, hook.kind], [false, 'stripeWebhookAdmin']);
  const hookAllowed = egress.evaluateEgress(egress.buildEgressPolicy({ allow: new Set(['paymentsTest', 'stripeWebhookAdmin']) }), { host: 'api.stripe.com', method: 'DELETE', path: '/v1/webhook_endpoints/we_1', headers: { authorization: 'Bearer sk_test_x' } });
  assert.equal(hookAllowed.allowed, true);
  const hookLive = egress.evaluateEgress(egress.buildEgressPolicy({ allow: new Set(['paymentsTest', 'stripeWebhookAdmin']) }), { host: 'api.stripe.com', method: 'POST', path: '/v1/webhook_endpoints', headers: { authorization: 'Bearer sk_live_x' } });
  assert.equal(hookLive.allowed, false, 'webhook admin on a live account also needs paymentsLive');
  // http-level guard (what the Stripe SDK uses): a live-key request never connects.
  const outcome = await httpRequestOutcome(https, 'https://api.stripe.com/v1/charges', { method: 'POST', headers: { Authorization: 'Bearer sk_live_x' } });
  assert.equal(outcome.error?.code, 'ESAFEMODE');
  assert.equal(outcome.error?.kind, 'paymentsLive');
});

test('aiCalls: DeepSeek and Claude return deterministic stubs, record intents, never call the API', async () => {
  install();
  fetchCalls.length = 0;
  const spy = async () => { throw new Error('must not be called'); };
  const parsed = await deepseekChatJson({ system: 's', user: 'u', fetchImpl: spy });
  assert.deepEqual(parsed, { safeModeStub: true });
  const again = await deepseekChatJson({ system: 's', user: 'u', fetchImpl: spy });
  assert.deepEqual(again, parsed, 'deterministic');
  const claude = await claudeMessages({ system: 's', messages: [{ role: 'user', content: 'hi' }], fetchImpl: spy });
  assert.equal(claude.stopReason, 'end_turn');
  assert.equal(claude.content[0].type, 'text');
  assert.equal(ai.aiKeyOrBlank('gemini', 'fake-gemini', 'test'), '');
  assert.ok(intents('aiCalls').length >= 4);
  await assert.rejects(() => globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }), (error) => error?.cause?.kind === 'aiCalls');
  assert.equal(fetchCalls.length, 0);
});

test('aiCalls: a cassette is replayed; replay mode without one throws the provider error', async () => {
  install('', { HUB_SAFE_MODE_AI: 'replay' });
  const request = { model: 'deepseek-chat', system: 'sys 2026-10-23T10:00:00Z', user: 'u', temperature: 0.4, maxTokens: 2000 };
  const key = ai.aiCassetteKey('deepseek', request);
  assert.equal(key, ai.aiCassetteKey('deepseek', { ...request, system: 'sys 2027-01-01T00:00:00Z' }), 'dates do not change the key');
  ai.writeCassette(key, { provider: 'deepseek', response: { answer: 42 } });
  const replayed = await deepseekChatJson({ system: 'sys 2030-05-05T05:05:05Z', user: 'u', fetchImpl: async () => { throw new Error('no'); } });
  assert.deepEqual(replayed, { answer: 42 });
  await assert.rejects(() => deepseekChatJson({ system: 'other', user: 'u', fetchImpl: async () => { throw new Error('no'); } }), (error) => error instanceof DeepseekError && error.code === 'safe-mode');
});

test('aiCalls allowed + HUB_SAFE_MODE_AI_RECORD=1: the real call runs and a cassette is written', async () => {
  install('aiCalls', { HUB_SAFE_MODE_AI_RECORD: '1' });
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  const result = await deepseekChatJson({ system: 'record me', user: 'u', fetchImpl });
  assert.deepEqual(result, { ok: true });
  assert.equal(called, 1);
  const key = ai.aiCassetteKey('deepseek', { model: 'deepseek-chat', system: 'record me', user: 'u', temperature: 0.4, maxTokens: 2000 });
  assert.deepEqual(ai.readCassette(key)?.response, { ok: true });
});

test('paidApi: DataForSEO, SerpAPI, Places, Deepgram, Brave are refused at the egress guard', async () => {
  install();
  fetchCalls.length = 0;
  for (const url of [
    'https://api.dataforseo.com/v3/serp/google/maps/live/advanced',
    'https://serpapi.com/search.json?api_key=secret123',
    'https://places.googleapis.com/v1/places:searchText',
    'https://api.deepgram.com/v1/listen',
    'https://search.brave.com/search?q=x',
  ]) {
    await assert.rejects(() => globalThis.fetch(url, { method: 'POST' }), (error) => error?.cause?.kind === 'paidApi', url);
  }
  assert.equal(fetchCalls.length, 0);
  const logged = intents('paidApi');
  assert.ok(logged.length >= 5);
  assert.ok(logged.every((row) => !/secret123/.test(JSON.stringify(row))), 'query strings (api keys) are never logged');
});

test('prodPublish and unknown hosts: asoldi.com and api.github.com are refused at every layer', async () => {
  install();
  await assert.rejects(() => globalThis.fetch('https://asoldi.com/api/admin/login', { method: 'POST' }), (error) => error?.cause?.kind === 'prodPublish');
  await assert.rejects(() => globalThis.fetch('https://asoldi.com/', { method: 'GET' }), (error) => error?.cause?.kind === 'prodPublish');
  const viaHttps = await httpRequestOutcome(https, 'https://api.github.com/repos/x/y', { method: 'GET' });
  assert.equal(viaHttps.error?.code, 'ESAFEMODE');
  const viaGet = await new Promise((resolve) => {
    https.get('https://asoldi.com/x', () => resolve({})).on('error', (error) => resolve({ error }));
  });
  assert.equal(viaGet.error?.kind, 'prodPublish');
  assert.throws(() => safeMode.assertSafeModeAllows('prodPublish', 'loginToProdAdmin'), (error) => error.status === 423);
});

test('socket layer: SMTP and IMAP connections are refused (emailRedirect / inboxRead)', async () => {
  install('', { SMTP_HOST: 'smtp.hostinger.com' });
  const outcome = (host, port) => new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.on('connect', () => { socket.destroy(); resolve({ connected: true }); });
    socket.on('error', (error) => resolve({ error }));
  });
  const smtp = await outcome('smtp.hostinger.com', 587);
  assert.equal(smtp.error?.code, 'ESAFEMODE');
  assert.equal(smtp.error?.kind, 'emailRedirect');
  const imap = await outcome('imap.hostinger.com', 993);
  assert.equal(imap.error?.kind, 'inboxRead');
});

test('loopback stays reachable: a local server answers through http and fetch', async () => {
  install();
  const server = http.createServer((req, res) => res.end('local ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const viaHttp = await httpRequestOutcome(http, `http://127.0.0.1:${port}/`);
  assert.equal(viaHttp.status, 200);
  const viaFetch = await globalThis.fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await viaFetch.text(), 'local ok');
  server.close();
});

test('inbox: IMAP opens read-only (EXAMINE + BODY.PEEK) in safe mode unless imapFlags is allowed', () => {
  install('inboxRead');
  assert.equal(imapReadOnly(), true);
  assert.deepEqual(imapListCommands({ readOnly: true }), { open: 'EXAMINE INBOX', fetchSpec: '(UID BODY.PEEK[])' });
  assert.deepEqual(imapListCommands({ readOnly: true, headersOnly: true }).fetchSpec, '(UID BODY.PEEK[HEADER])');
  assert.deepEqual(imapListCommands({}), { open: 'SELECT INBOX', fetchSpec: '(UID RFC822)' }, 'default unchanged');
  install('inboxRead,imapFlags');
  assert.equal(imapReadOnly(), false);
});

test('Google read-only traffic is allowed, writes are not', () => {
  const policy = egress.buildEgressPolicy({ allow: new Set(['paymentsTest']) });
  assert.equal(egress.evaluateEgress(policy, { host: 'www.googleapis.com', method: 'GET', path: '/calendar/v3/calendars/primary/events' }).allowed, true);
  assert.equal(egress.evaluateEgress(policy, { host: 'www.googleapis.com', method: 'POST', path: '/calendar/v3/freeBusy' }).allowed, true);
  assert.equal(egress.evaluateEgress(policy, { host: 'oauth2.googleapis.com', method: 'POST', path: '/token' }).allowed, true);
  const insert = egress.evaluateEgress(policy, { host: 'www.googleapis.com', method: 'POST', path: '/calendar/v3/calendars/primary/events' });
  assert.deepEqual([insert.allowed, insert.kind], [false, 'calendarWrite']);
  const send = egress.evaluateEgress(policy, { host: 'gmail.googleapis.com', method: 'POST', path: '/gmail/v1/users/me/messages/send' });
  assert.equal(send.allowed, false, 'Gmail sends never leave');
  assert.equal(egress.evaluateEgress(policy, { host: 'api.brevo.com', method: 'POST', path: '/v3/smtp/email' }).kind, 'brevoSend');
});

test('on Hostinger every guard is a pass-through and no egress guard is installed', async () => {
  safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir, log: null });
  assert.equal(safeMode.isSafeModeActive(), false);
  assert.equal(egress.isEgressGuardInstalled(), false);
  assert.equal(safeMode.guardExternal('calendarWrite', 'x').allowed, true);
  assert.equal(safeMode.safeModeAllows('prodPublish'), true);
  assert.equal(imapReadOnly(), false);
  assert.equal(ai.aiKeyOrBlank('gemini', 'k'), 'k');
  fetchCalls.length = 0;
  const write = await myphoner.myPhonerRequest('/leads/1', { method: 'POST', body: {} });
  assert.notEqual(write.safeMode, true);
  assert.equal(fetchCalls.length, 1, 'the write reaches the (spy) client');
  let called = 0;
  await deepseekChatJson({ system: 's', user: 'u', fetchImpl: async () => { called += 1; return new Response('{"choices":[{"message":{"content":"{}"}}]}', { status: 200 }); } });
  assert.equal(called, 1);
});

test('intent details carry no secrets', () => {
  const scrubbed = safeMode.scrubDetail('POST https://serpapi.com/search.json?api_key=abc123 token=xyz sk_live_ABCDEF123 password: hunter2');
  assert.doesNotMatch(scrubbed, /abc123|xyz|ABCDEF123|hunter2/);
});

test('no test request leaked past the guards to a real socket', () => {
  assert.deepEqual(leakedSockets, []);
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
  rmSync(dataDir, { recursive: true, force: true });
});


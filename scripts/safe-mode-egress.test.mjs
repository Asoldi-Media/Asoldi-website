// Egress guard details: the GraphQL write detector and the socket-layer backstop.
// A spy under the guard refuses every non-loopback socket (code ETESTSPY) and records it,
// so "reached the spy" means "the guard let it through" and nothing ever leaves the PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-safe-egress-'));
process.env.APP_DATA_DIR = dataDir;

const reachedSpy = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  reachedSpy.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTSPY' })));
  return this;
};

const { graphqlDocumentWrites, graphqlTopLevelDefinitions } = await import('../lib/graphql-ops.js');
const egress = await import('../lib/safe-mode-egress.js');
const safeMode = await import('../lib/safe-mode.js');
const luca = await import('../lib/employee-luca.js');

function install(allow = '') {
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: allow }, dataDir, log: null });
}

function socketOutcome(connect) {
  return new Promise((resolve) => {
    const socket = connect();
    socket.on('connect', () => { socket.destroy(); resolve({ connected: true }); });
    socket.on('secureConnect', () => { socket.destroy(); resolve({ connected: true }); });
    socket.on('error', (error) => resolve({ error }));
  });
}

function requestOutcome(mod, url, options = {}) {
  return new Promise((resolve) => {
    const req = mod.request(url, options, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (error) => resolve({ error }));
    req.end();
  });
}

test('GraphQL: a mutation anywhere in the document is a write', () => {
  const cases = [
    ['mutation CreateInvoice { x }', '', true],
    ['\n  query GetIncomeSummary { saleInvoices { nodes { id } } }', '', false],
    ['{ me { id } }', '', false],
    ['query A { me { id } } mutation B { createSaleInvoice(input: {}) { id } }', 'B', true],
    ['query A { me { id } } mutation B { createSaleInvoice(input: {}) { id } }', '', true],
    ['query A { me { id } }\nsubscription S { changes { id } }', 'A', true],
    ['query A { me { id } }', 'B', true],
    ['query A { me { id } }', 'A', false],
    ['query A { me { id } } query B { you { id } }', 'B', false],
    ['# mutation X { y }\nquery A { x }', '', false],
    ['query A { x(arg: "mutation B { y }") }', '', false],
    ['query A { x(arg: """\n} mutation B { y }\n""") }', '', false],
    ['query A($id: ID = "mutation") @cached(ttl: 5) { node(id: $id) { id } }', '', false],
    ['fragment F on Invoice { id } query A { saleInvoices { nodes { ...F } } }', '', false],
    ['fragment F on Invoice { id }', '', true],
    ['query { mutation: me { id } }', '', false],
    ['extend type Query { x: Int }', '', true],
    ['', '', true],
    ['   ', '', true],
    ['query A', '', true],
  ];
  for (const [doc, operationName, expected] of cases) {
    assert.equal(graphqlDocumentWrites(doc, operationName), expected, `${JSON.stringify(doc)} op=${operationName}`);
  }
  assert.deepEqual(graphqlTopLevelDefinitions('query A { x } mutation B { y }').map((d) => `${d.type}:${d.name}`), ['query:A', 'mutation:B']);
});

test('GraphQL: Luca guard and egress body check both see a trailing mutation', () => {
  const multi = 'query A { me { id } } mutation B { createSaleInvoice(input: {}) { id } }';
  assert.equal(luca.lucaDocumentWrites(multi), true);
  assert.equal(luca.lucaDocumentWrites(multi, 'B'), true);
  assert.equal(luca.lucaDocumentWrites('query GetIncomeSummary { saleInvoices { nodes { id } } }'), false);
  assert.equal(egress.graphqlIsMutation(JSON.stringify({ query: multi, operationName: 'B' })), true);
  assert.equal(egress.graphqlIsMutation(JSON.stringify({ query: 'query A { x } query B { y }', operationName: 'C' })), true, 'an operationName that is not a query counts as a write');
  assert.equal(egress.graphqlIsMutation(JSON.stringify({ query: 'query A { x }', operationName: 'A' })), false);
  assert.equal(egress.graphqlIsMutation(JSON.stringify([{ query: '{ a }' }, { query: 'mutation { b }' }])), true, 'batched');
  assert.equal(egress.graphqlIsMutation(JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'x' } } })), true, 'persisted query: unknown');
  const policy = egress.buildEgressPolicy({ allow: new Set(['paymentsTest', 'firefliesIngest']) });
  const lucaPost = egress.evaluateEgress(policy, { host: 'go.lucaregnskap.no', method: 'POST', path: '/api/v1/graphql', body: JSON.stringify({ query: multi, operationName: 'B' }), bodyKnown: true });
  assert.deepEqual([lucaPost.allowed, lucaPost.kind], [false, 'accountingWrite']);
  const ffPost = egress.evaluateEgress(policy, { host: 'api.fireflies.ai', method: 'POST', path: '/graphql', body: JSON.stringify({ query: 'query T { transcripts { id } } mutation L { addToLiveMeeting(meeting_link: "x") { success } }', operationName: 'L' }), bodyKnown: true });
  assert.deepEqual([ffPost.allowed, ffPost.kind], [false, 'firefliesLiveJoin']);
  const ffQuery = egress.evaluateEgress(policy, { host: 'api.fireflies.ai', method: 'POST', path: '/graphql', body: JSON.stringify({ query: 'query T { transcripts { id } }' }), bodyKnown: true });
  assert.equal(ffQuery.allowed, true);
});

test('socket layer: method-gated hosts get no socket on host and port alone', () => {
  const policy = egress.buildEgressPolicy({ allow: new Set(['paymentsTest']), env: { WORDPRESS_URL: 'https://wp.example.invalid' } });
  // The intent kind names the allow key that would admit the socket, else 'rawSocket'.
  const expectedKind = {
    'api.stripe.com': 'rawSocket',
    'www.googleapis.com': 'rawSocket',
    'gmail.googleapis.com': 'rawSocket',
    'oauth2.googleapis.com': 'rawSocket',
    'asoldi.myphoner.com': 'myphonerWrite',
    'go.lucaregnskap.no': 'accountingWrite',
    'wp.example.invalid': 'wordpressWrite',
  };
  for (const [host, kind] of Object.entries(expectedKind)) {
    const raw = egress.evaluateEgress(policy, { host, port: 443, socketOnly: true });
    assert.equal(raw.allowed, false, `${host} raw socket`);
    assert.equal(raw.kind, kind, host);
    assert.equal(egress.evaluateEgress(policy, { host, port: 443, socketOnly: true, fromApprovedRequest: true }).allowed, true, `${host} socket for an approved request`);
  }
  // Host-only rules keep working at the socket layer once their key is allowed.
  const smtp = egress.buildEgressPolicy({ allow: new Set(['emailRedirect']), env: { SMTP_HOST: 'smtp.hostinger.com' } });
  assert.equal(egress.evaluateEgress(smtp, { host: 'smtp.hostinger.com', port: 587, socketOnly: true }).allowed, true);
});

test('socket layer: a raw tls.connect to api.stripe.com:443 is refused in safe mode (default allow has paymentsTest)', async () => {
  install();
  const before = reachedSpy.length;
  const outcome = await socketOutcome(() => tls.connect({ host: 'api.stripe.com', port: 443, servername: 'api.stripe.com' }));
  assert.equal(outcome.error?.code, 'ESAFEMODE', String(outcome.error?.message));
  assert.equal(outcome.error?.kind, 'rawSocket');
  const raw = await socketOutcome(() => net.connect(443, 'www.googleapis.com'));
  assert.equal(raw.error?.code, 'ESAFEMODE');
  assert.equal(reachedSpy.length, before, 'nothing reached the socket');
  assert.ok(safeMode.readRecentIntents(50).some((row) => row.kind === 'rawSocket' && row.host === 'api.stripe.com'));
});

test('socket layer: sockets opened by approved fetch and https requests still pass the guard', async () => {
  install();
  reachedSpy.length = 0;
  const viaFetch = await globalThis.fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events').then(() => ({}), (error) => ({ error }));
  assert.equal(viaFetch.error?.cause?.code, 'ETESTSPY', `fetch GET reached the socket layer and passed it: ${viaFetch.error?.cause?.code}`);
  const viaHttps = await requestOutcome(https, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'GET' });
  assert.equal(viaHttps.error?.code, 'ETESTSPY');
  const stripeTest = await requestOutcome(https, 'https://api.stripe.com/v1/customers', { method: 'GET', headers: { Authorization: 'Bearer sk_test_fake' } });
  assert.equal(stripeTest.error?.code, 'ETESTSPY', 'Stripe with a test key keeps working');
  assert.deepEqual([...new Set(reachedSpy)].sort(), ['api.stripe.com', 'www.googleapis.com']);
  // The approval is per host: inside an approved request's context, another method-gated host is still refused.
  const nested = await new Promise((resolve) => {
    const req = https.request('https://www.googleapis.com/calendar/v3/x', { method: 'GET' });
    req.on('error', () => {
      socketOutcome(() => tls.connect({ host: 'api.stripe.com', port: 443 })).then(resolve);
    });
    req.end();
  });
  assert.equal(nested.error?.code, 'ESAFEMODE');
});

test('socket layer: a write request is still refused before any socket', async () => {
  install();
  reachedSpy.length = 0;
  const insert = await requestOutcome(https, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST' });
  assert.equal(insert.error?.code, 'ESAFEMODE');
  assert.equal(insert.error?.kind, 'calendarWrite');
  assert.deepEqual(reachedSpy, []);
});

test('loopback is untouched by the socket rules', async () => {
  install();
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal((await requestOutcome(http, `http://127.0.0.1:${port}/`)).status, 200);
  const raw = await socketOutcome(() => net.connect(port, '127.0.0.1'));
  assert.equal(raw.connected, true);
  server.close();
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  net.Socket.prototype.connect = realConnect;
  rmSync(dataDir, { recursive: true, force: true });
});

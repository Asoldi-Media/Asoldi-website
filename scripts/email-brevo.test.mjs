// Brevo client: exact requests with a stub network, the safe-mode outbox, the 429 backoff, list
// ownership, key hygiene in errors and the one-recipient rule. No call leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-brevo-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.BREVO_API_KEY;

const store = await import('../data/email-store.js');
const brevo = await import('../lib/brevo.js');
const { installSafeMode, resetSafeModeForTests } = await import('../lib/safe-mode.js');

const KEY = 'fake-brevo-api-key-for-unit-tests-only';
const ENV = { BREVO_API_KEY: KEY };

function stubNetwork(routes = {}) {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
    calls.push({ key, url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    let answer = routes[key];
    if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
    if (typeof answer === 'function') answer = answer(init);
    if (!answer) answer = { status: 200, json: {} };
    if (answer.throw) throw answer.throw;
    const text = answer.json === undefined ? '' : JSON.stringify(answer.json);
    return new Response(text || null, { status: answer.status || 200, headers: answer.headers || {} });
  };
  brevo.setBrevoDeps({ fetch, env: ENV, now: () => Date.parse('2026-11-01T10:00:00Z'), sleep: async (ms) => { sleeps.push(ms); } });
  return { calls, sleeps };
}

const sendPayload = {
  sender: { name: 'Eksempelbutikken', email: 'kunder@asoldi.com' },
  to: [{ email: 'kunde@example.com', name: 'Kari' }],
  replyTo: { email: 'post@example.com' },
  subject: 'Hei',
  htmlContent: '<p>Hei</p>',
  textContent: 'Hei',
  headers: { 'List-Unsubscribe': '<https://asoldi.com/api/hub/email/unsubscribe?t=x>', 'X-Mailin-custom': 'site:s1|test|em_1' },
  tags: ['cms', 's1', 'test'],
};

test.afterEach(() => {
  brevo.setBrevoDeps(null);
  resetSafeModeForTests();
});

test('(a) every function sends the exact path, method, headers and body', async () => {
  await store.patchEmailSite('site_a', { brevoListId: 57 });
  const { calls } = stubNetwork({
    'POST /v3/smtp/email': { status: 201, json: { messageId: '<id-1@smtp-relay.example.com>' } },
    'GET /v3/account': { json: { plan: [{ type: 'subscription', creditsType: 'sendLimit', credits: 4200 }], relay: { enabled: true, data: { userName: 'x' } } } },
    'GET /v3/contacts/folders?limit=50&offset=0': { json: { folders: [{ id: 3, name: 'Annet' }] } },
    'POST /v3/contacts/folders': { status: 201, json: { id: 12 } },
    'POST /v3/contacts/lists': { status: 201, json: { id: 88 } },
    'POST /v3/contacts': { status: 201, json: { id: 1 } },
    'POST /v3/contacts/import': { status: 202, json: { processId: 77 } },
    'POST /v3/contacts/lists/57/contacts/remove': { status: 201, json: { contacts: { success: ['kunde@example.com'] } } },
    'GET /v3/contacts/kunde%40example.com': { json: { email: 'kunde@example.com', listIds: [57], emailBlacklisted: false } },
    'DELETE /v3/contacts/kunde%40example.com': { status: 204 },
    'DELETE /v3/smtp/log/kunde%40example.com': { status: 404, json: { code: 'document_not_found' } },
    'DELETE /v3/smtp/blockedContacts/kunde%40example.com': { status: 204 },
    'GET /v3/webhooks?type=transactional': { json: { webhooks: [] } },
    'POST /v3/webhooks': { status: 201, json: { id: 345 } },
    'POST /v3/senders/domains': { status: 201, json: { id: 9, dns_records: {} } },
    'PUT /v3/senders/domains/butikk.example.com/authenticate': { json: { message: 'ok' } },
    'GET /v3/senders/domains/butikk.example.com': { json: { verified: true, authenticated: true } },
  });

  const sent = await brevo.sendBrevoEmail(sendPayload, { settings: store.readEmailSettings() });
  assert.deepEqual(sent, { providerMessageId: '<id-1@smtp-relay.example.com>', mode: 'brevo' });
  const send = calls.at(-1);
  assert.equal(send.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(send.method, 'POST');
  assert.equal(send.headers['api-key'], KEY);
  assert.deepEqual(send.body, {
    sender: { name: 'Eksempelbutikken', email: 'kunder@asoldi.com' },
    to: [{ email: 'kunde@example.com', name: 'Kari' }],
    replyTo: { email: 'post@example.com' },
    subject: 'Hei',
    htmlContent: '<p>Hei</p>',
    textContent: 'Hei',
    headers: sendPayload.headers,
    tags: ['cms', 's1', 'test'],
  });

  const account = await brevo.getBrevoAccount();
  assert.deepEqual(account, { plan: [{ type: 'subscription', creditsType: 'sendLimit', credits: 4200 }], relay: { enabled: true } });

  assert.equal(await brevo.ensureCmsFolder(), 12);
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts/folders').body, { name: 'Asoldi CMS-kunder' });
  assert.equal(store.readEmailSettings().brevo.folderId, 12, 'the folder id is kept');
  const before = calls.length;
  assert.equal(await brevo.ensureCmsFolder(), 12);
  assert.equal(calls.length, before, 'a known folder needs no call');

  assert.equal(await brevo.ensureSiteList({ id: 'site_b', name: 'Bakeri Øst', domain: 'bakeri.example.com' }), 88);
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts/lists').body, { name: 'cms-site_b-bakeri-ost', folderId: 12 });
  assert.equal(store.readEmailSite('site_b').brevoListId, 88);
  assert.equal(await brevo.ensureSiteList({ id: 'site_a' }), 57, 'an existing list is reused');

  await brevo.upsertContacts(57, ['Kunde@Example.com']);
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts').body, { email: 'kunde@example.com', listIds: [57], updateEnabled: true });
  const many = Array.from({ length: 11 }, (_, i) => `k${i}@example.com`);
  const imported = await brevo.upsertContacts(57, many);
  assert.equal(imported.processId, 77);
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts/import').body, { listIds: [57], jsonBody: many.map((email) => ({ email })), updateExistingContacts: true, emptyContactsAttributes: false });

  await brevo.removeFromList(57, ['kunde@example.com']);
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts/lists/57/contacts/remove').body, { emails: ['kunde@example.com'] });
  assert.deepEqual(await brevo.getContact('kunde@example.com'), { email: 'kunde@example.com', listIds: [57], emailBlacklisted: false });
  assert.deepEqual(await brevo.deleteContact('kunde@example.com'), { ok: true, found: true });
  assert.deepEqual(await brevo.deleteSmtpLog('kunde@example.com'), { ok: true, found: false }, 'a 404 on the log delete is not an error');
  assert.deepEqual(await brevo.unblockTransactional('kunde@example.com'), { ok: true, found: true });

  const hook = await brevo.ensureWebhook({ url: 'https://asoldi.com/api/hub/email/brevo-webhook/tok', token: 'tok' });
  assert.deepEqual(hook, { id: 345, created: true });
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/webhooks').body, {
    url: 'https://asoldi.com/api/hub/email/brevo-webhook/tok',
    description: 'Asoldi CMS e-post',
    events: ['delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'opened', 'click', 'unsubscribed'],
    headers: [{ key: 'x-asoldi-webhook', value: 'tok' }],
    type: 'transactional',
  });
  assert.equal(store.readEmailSettings().brevo.webhookId, 345);

  await brevo.createSenderDomain('https://Butikk.example.com/');
  assert.deepEqual(calls.find((c) => c.key === 'POST /v3/senders/domains').body, { name: 'butikk.example.com' });
  await brevo.authenticateSenderDomain('butikk.example.com');
  assert.deepEqual(await brevo.getSenderDomain('butikk.example.com'), { domain: 'butikk.example.com', verified: true, authenticated: true, dnsRecords: null });
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://api.brevo.com/v3/'), call.url);
    assert.equal(call.headers['api-key'], KEY);
  }
});

test('(a) sandbox mode puts X-Sib-Sandbox: drop into the body headers, not the HTTP headers', async () => {
  const { calls } = stubNetwork({ 'POST /v3/smtp/email': { status: 201, json: { messageId: '<sb@x>' } } });
  const settings = store.deepMerge(store.readEmailSettings(), { brevo: { sandbox: true } });
  const sent = await brevo.sendBrevoEmail(sendPayload, { settings });
  assert.equal(sent.mode, 'sandbox');
  assert.equal(calls[0].body.headers['X-Sib-Sandbox'], 'drop');
  assert.equal(calls[0].headers['X-Sib-Sandbox'], undefined);
});

test('(b) safe mode makes 0 network calls and writes 1 outbox file per send', async () => {
  const { calls } = stubNetwork({});
  installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, egress: false, log: null });
  await store.patchEmailSite('site_safe', { brevoListId: 91 });
  const first = await brevo.sendBrevoEmail(sendPayload);
  const second = await brevo.sendBrevoEmail({ ...sendPayload, to: [{ email: 'annen@example.com' }] });
  assert.equal(first.mode, 'outbox');
  assert.match(first.providerMessageId, /^<outbox-.+@safe-mode\.invalid>$/);
  assert.notEqual(first.outboxId, second.outboxId);
  await brevo.getBrevoAccount();
  await brevo.ensureCmsFolder();
  await brevo.ensureSiteList({ id: 'site_new_safe', name: 'Ny' });
  await brevo.upsertContacts(91, ['a@example.com']);
  await brevo.removeFromList(91, ['a@example.com']);
  await brevo.getContact('a@example.com');
  await brevo.deleteContact('a@example.com');
  await brevo.deleteSmtpLog('a@example.com');
  await brevo.unblockTransactional('a@example.com');
  await brevo.ensureWebhook({ url: 'https://asoldi.com/api/hub/email/brevo-webhook/t', token: 't' });
  await brevo.createSenderDomain('butikk.example.com');
  await brevo.getSenderDomain('butikk.example.com');
  assert.equal(calls.length, 0, 'no call reached the network');
  const day = readdirSync(join(dataDir, 'outbox')).find((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
  const emls = readdirSync(join(dataDir, 'outbox', day)).filter((name) => name.endsWith('.eml'));
  assert.equal(emls.length, 2, 'one outbox file per send');
  assert.equal(store.readEmailSite('site_new_safe').brevoListId, null, 'a stub list id is never stored');
  assert.equal(existsSync(join(dataDir, 'safe-mode', 'intents.jsonl')), true, 'other changes are recorded as intents');
});

test('(c) a 429 with Retry-After: 2 is retried after at least 2 s; 5xx is retried once after 2 s', async () => {
  const { calls, sleeps } = stubNetwork({
    'POST /v3/smtp/email': [
      { status: 429, headers: { 'retry-after': '2' }, json: { code: 'too_many_requests' } },
      { status: 201, json: { messageId: '<after-429@x>' } },
    ],
  });
  const sent = await brevo.sendBrevoEmail(sendPayload);
  assert.equal(sent.providerMessageId, '<after-429@x>');
  assert.equal(calls.length, 2);
  assert.ok(sleeps[0] >= 2000, `slept ${sleeps[0]} ms`);

  const five = stubNetwork({ 'GET /v3/account': [{ status: 503 }, { status: 502 }] });
  await assert.rejects(brevo.getBrevoAccount(), (error) => error.code === 'provider_unavailable');
  assert.equal(five.calls.length, 2, 'one retry, then give up');
  assert.deepEqual(five.sleeps, [2000]);

  const net = stubNetwork({ 'GET /v3/account': [{ throw: new TypeError('fetch failed') }, { json: { plan: [] } }] });
  assert.deepEqual(await brevo.getBrevoAccount(), { plan: [], relay: null });
  assert.equal(net.calls.length, 2, 'a network error is retried once');

  const many = stubNetwork({ 'GET /v3/account': { status: 429, headers: { 'retry-after': '1' } } });
  await assert.rejects(brevo.getBrevoAccount(), (error) => error.code === 'rate_limited');
  assert.equal(many.calls.length, 4, 'three 429 retries at most');

  assert.equal(brevo.retryAfterMs('Sun, 01 Nov 2026 10:00:05 GMT', Date.parse('2026-11-01T10:00:00Z')), 5000);
});

test('(d) removeFromList and upsertContacts refuse list ids not owned by email-sites.json', async () => {
  const { calls } = stubNetwork({});
  await assert.rejects(brevo.removeFromList(4242, ['a@example.com']), (error) => error.code === 'list_not_owned');
  await assert.rejects(brevo.upsertContacts(4242, ['a@example.com']), (error) => error.code === 'list_not_owned');
  await assert.rejects(brevo.removeFromList('57; DROP', ['a@example.com']), (error) => error.code === 'list_not_owned');
  assert.equal(calls.length, 0);
});

test('(e) the key never appears in a thrown error, even when Brevo echoes it', async () => {
  stubNetwork({ 'POST /v3/smtp/email': { status: 401, json: { code: 'unauthorized', message: `Key not found: ${KEY}` } } });
  const error = await brevo.sendBrevoEmail(sendPayload).catch((e) => e);
  assert.equal(error.code, 'provider_rejected');
  assert.equal(error.status, 401);
  const dump = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${error.brevoMessage}`;
  assert.equal(dump.includes(KEY), false);
  brevo.setBrevoDeps({ env: {}, fetch: async () => { throw new Error('must not be called'); } });
  const missing = await brevo.sendBrevoEmail(sendPayload).catch((e) => e);
  assert.equal(missing.code, 'not_configured');
  assert.equal(brevo.brevoConfigured({ env: { BREVO_API_KEY: '********' } }), false, 'a masked env value is no key');
});

test('(f) sendBrevoEmail with two recipients (or none) throws before any call', async () => {
  const { calls } = stubNetwork({});
  await assert.rejects(brevo.sendBrevoEmail({ ...sendPayload, to: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }), (error) => error.code === 'one_recipient_per_call');
  await assert.rejects(brevo.sendBrevoEmail({ ...sendPayload, to: [] }), (error) => error.code === 'one_recipient_per_call');
  assert.equal(calls.length, 0);
});

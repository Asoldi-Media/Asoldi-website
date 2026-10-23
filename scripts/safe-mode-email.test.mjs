// Safe mode email sink: every send lands in <dataDir>/outbox, nothing reaches Resend or SMTP.
// Resend (fetch) and SMTP (raw sockets) are replaced by spies BEFORE safe mode installs, so
// a request that got past the guard would show up in the spies.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-safe-email-'));
process.env.APP_DATA_DIR = dataDir;
Object.assign(process.env, {
  RESEND_API_KEY: 're_fake_for_tests',
  RESEND_FROM: 'Asoldi <contact@asoldi.com>',
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_PORT: '587',
  SMTP_USER: 'contact@asoldi.com',
  SMTP_PASS: 'fake-pass',
});

const fetchCalls = [];
const socketCalls = [];
const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;
globalThis.fetch = async (input, init = {}) => {
  fetchCalls.push({ url: String(input?.url || input), init });
  return new Response(JSON.stringify({ id: 'resend-fake-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
net.Socket.prototype.connect = function spyConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = first && typeof first === 'object' ? first.host : args[1];
  socketCalls.push(String(host || 'localhost'));
  const error = Object.assign(new Error('test: no network'), { code: 'ETESTNONET' });
  process.nextTick(() => this.destroy(error));
  return this;
};

const safeMode = await import('../lib/safe-mode.js');
const email = await import('../lib/email.js');
const { outboxOrSend } = await import('../lib/safe-mode-mail.js');

function outboxIndex() {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test('safe mode on: sendEmail writes one .eml + index line and makes 0 Resend/SMTP requests', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null });
  assert.equal(email.canSendEmail(), true);
  assert.equal(email.resolveMailTransport(), 'outbox');
  await email.sendEmail({
    to: 'kunde@example.invalid',
    subject: 'Påminnelse: møte i morgen',
    text: 'Hei! Vi sees i morgen.',
    html: '<p>Hei! <b>Vi sees</b> i morgen.</p>',
    bcc: 'copy@example.invalid',
    attachments: [{ filename: 'avtale.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }],
  });
  assert.equal(fetchCalls.length, 0, 'no fetch to api.resend.com');
  assert.equal(socketCalls.filter((host) => !/^(127\.|localhost)/.test(host)).length, 0, 'no SMTP socket');
  const index = outboxIndex();
  assert.equal(index.length, 1);
  assert.deepEqual(index[0].to, ['kunde@example.invalid']);
  assert.deepEqual(index[0].bcc, ['copy@example.invalid']);
  assert.equal(index[0].attachments[0].filename, 'avtale.pdf');
  const dayDir = join(dataDir, 'outbox', index[0].day);
  const eml = readFileSync(join(dayDir, `${index[0].id}.eml`), 'utf8');
  assert.match(eml, /Subject: /);
  assert.match(eml, /avtale\.pdf/, 'attachment is inline in the MIME');
  assert.equal(readdirSync(dayDir).filter((name) => name.endsWith('.eml')).length, 1);
  assert.equal(safeMode.safeModeCounters().email.outboxed, 1);
});

test('safe mode on + emailRedirect: one real send, only to EMAIL_REDIRECT_TO, bcc dropped, subject marked', async () => {
  safeMode.installSafeMode({
    env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'emailRedirect', EMAIL_REDIRECT_TO: 'dev-inbox@example.invalid' },
    dataDir,
    log: null,
  });
  fetchCalls.length = 0;
  assert.match(email.resolveMailTransport(), /^redirect:/);
  await email.sendEmail({ to: 'real-client@example.invalid', subject: 'Tilbud', text: 'x', bcc: 'boss@example.invalid' });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.resend.com/emails');
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(body.to, ['dev-inbox@example.invalid']);
  assert.equal(body.bcc, undefined);
  assert.match(body.subject, /^\[SAFE→real-client@example\.invalid\] Tilbud$/);
  const last = outboxIndex().at(-1);
  assert.equal(last.redirectedTo, 'dev-inbox@example.invalid');
});

test('safe mode on, emailRedirect allowed but no EMAIL_REDIRECT_TO: outbox only', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'emailRedirect' }, dataDir, log: null });
  fetchCalls.length = 0;
  await email.sendEmail({ to: 'a@example.invalid', subject: 's', text: 't' });
  assert.equal(fetchCalls.length, 0);
  assert.equal(email.resolveMailTransport(), 'outbox');
});

test('Brevo / Gmail style senders: outboxOrSend sinks to the outbox unless their key is allowed', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null });
  let sends = 0;
  const send = async () => { sends += 1; return { messageId: 'x' }; };
  const message = { to: ['a@example.invalid', 'b@example.invalid'], subject: 'Kampanje', html: '<p>Hei</p>', from: 'Asoldi <contact@asoldi.com>' };
  const out = await outboxOrSend({ channel: 'brevo', allowKey: 'brevoSend', message, send });
  assert.equal(out.outboxed, true);
  assert.equal(sends, 0);
  const row = outboxIndex().find((item) => item.id === out.id);
  assert.equal(row.channel, 'brevo');
  assert.deepEqual(row.to, ['a@example.invalid', 'b@example.invalid']);
  assert.ok(safeMode.readRecentIntents(10).some((intent) => intent.kind === 'brevoSend'));
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'brevoSend' }, dataDir, log: null });
  assert.equal((await outboxOrSend({ channel: 'brevo', allowKey: 'brevoSend', message, send })).sent, true);
  assert.equal(sends, 1);
  safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir, log: null });
  assert.equal((await outboxOrSend({ channel: 'gmail', message, send })).sent, true, 'production sends for real');
  assert.equal(sends, 2);
});

test('on Hostinger (HOSTINGER=1) safe mode stays off and sendEmail is a pass-through', async () => {
  const state = safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir, log: null });
  assert.equal(state.on, false);
  assert.equal(safeMode.isSafeModeActive(), false);
  const before = outboxIndex().length;
  fetchCalls.length = 0;
  await email.sendEmail({ to: 'kunde@example.invalid', subject: 'live path', text: 'x' });
  assert.equal(fetchCalls.length, 1, 'the real transport is used');
  assert.equal(outboxIndex().length, before, 'nothing new in the outbox');
  assert.equal(email.resolveMailTransport(), 'resend');
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
  rmSync(dataDir, { recursive: true, force: true });
});

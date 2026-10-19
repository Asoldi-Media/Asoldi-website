import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeFieldValue, applyFieldOps, normalizeFieldOps, mergeWeekHours } from '../packages/suite/core/facts/merge.js';
import { buildFactPrompt } from '../packages/suite/core/facts/prompt.js';
import { ingestMessage, createInboxTicker } from '../packages/suite/core/inbox/pipeline.js';
import { parseRfc822 } from '../packages/suite/core/mail/mime.js';
import { isAutomatedMail } from '../packages/suite/core/mail/automated.js';
import { extractDocumentText } from '../packages/suite/core/documents/text.js';
import { ASOLDI_FACT_PROMPT, KUNDEDATA_FACT_SCHEMA } from '../packages/suite/harness/asoldi/facts.js';

const SCHEMA = {
  fields: {
    phone: { path: ['contact', 'phone'], kind: 'multi', compare: 'digits' },
    about: { path: ['about'], kind: 'append', hint: 'what they do' },
    color: { path: ['brand', 'colors', 'main'], kind: 'single', pattern: '^#[0-9a-f]{6}$', patternFlags: 'i' },
  },
};

test('facts: add / replace / delete per field kind', () => {
  assert.equal(mergeFieldValue(SCHEMA.fields.phone, '412 34 567', '41234567', 'add'), '412 34 567');
  assert.equal(mergeFieldValue(SCHEMA.fields.phone, '41234567', '99887766', 'add'), '41234567 / 99887766');
  assert.equal(mergeFieldValue(SCHEMA.fields.phone, '41234567 / 99887766', '41234567', 'delete'), '99887766');
  assert.equal(mergeFieldValue(SCHEMA.fields.about, 'Bakery', 'We also cater', 'add'), 'Bakery\nWe also cater');
  assert.equal(mergeFieldValue(SCHEMA.fields.about, 'Bakery\nWe also cater', 'cater', 'delete'), 'Bakery');
  assert.equal(mergeFieldValue(SCHEMA.fields.color, '#111111', '#222222', 'add'), '#222222');
  const ops = normalizeFieldOps(SCHEMA, { phone: '99887766', color: 'red', about: '' }, { phone: 'replace', about: 'delete' });
  assert.deepEqual(ops, { fields: { phone: '99887766' }, fieldActions: { phone: 'replace', about: 'delete' } });
  const record = applyFieldOps({ contact: { phone: '41234567', fax: '1' }, about: 'x' }, SCHEMA, ops.fields, ops.fieldActions);
  assert.deepEqual(record, { contact: { phone: '99887766', fax: '1' }, about: '' });
});

test('facts: hours update touches only named days', () => {
  const week = { status: 'set', days: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
  const parsed = { action: 'set', status: 'set', days: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], touched: [5] };
  assert.deepEqual(mergeWeekHours(week, parsed, '').days, ['a', 'b', 'c', 'd', 'e', 'F', 'g']);
  assert.deepEqual(mergeWeekHours(week, parsed, 'replace').days, parsed.days);
  assert.equal(mergeWeekHours(week, { action: 'unclear' }), week);
});

test('facts prompt: English core default; Asoldi harness reproduces the shipped Norwegian prompt', () => {
  const english = buildFactPrompt({ schema: SCHEMA });
  assert.match(english, /^You receive what a customer writes/);
  assert.match(english, /"about": "what they do"/);
  assert.match(english, /If unsure, use add/);
  assert.doesNotMatch(english, /email from the customer/);
  assert.match(buildFactPrompt({ schema: SCHEMA, source: 'email' }), /email from the customer/);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/asoldi-fact-prompts.json', import.meta.url), 'utf8'));
  assert.equal(buildFactPrompt({ schema: KUNDEDATA_FACT_SCHEMA, ...ASOLDI_FACT_PROMPT }), fixture.gather);
  assert.equal(buildFactPrompt({ schema: KUNDEDATA_FACT_SCHEMA, ...ASOLDI_FACT_PROMPT, source: 'email' }), fixture.gatherEmail);
});

test('inbox pipeline: dedupe, mark before handler, kind handler or fallback', async () => {
  const done = new Set();
  const calls = [];
  const adapters = {
    isProcessed: (box, id) => done.has(`${box}|${id}`),
    markProcessed: (box, id) => { calls.push('mark'); done.add(`${box}|${id}`); },
    prepare: async () => { calls.push('prepare'); return { docs: 1 }; },
    classify: async (_, env) => { calls.push(`classify:${env.fresh}`); return { kind: env.prepared.docs ? 'invoice' : 'other' }; },
    match: () => ({ client: { id: 'c1' } }),
    handlers: { invoice: async (env) => { calls.push('invoice'); throw new Error(`boom ${env.matched.client.id}`); } },
    fallback: async () => ({ kind: 'fallback' }),
  };
  const message = { id: '1', mailbox: 'Inbox@x.test', text: 'New text\n> old quoted text' };
  await assert.rejects(ingestMessage(message, adapters), /boom c1/);
  assert.deepEqual(calls, ['prepare', 'classify:New text', 'mark', 'invoice']);
  assert.deepEqual(await ingestMessage(message, adapters), { skipped: true, reason: 'already' });
  assert.deepEqual(await ingestMessage({ id: '2', mailbox: 'a@x.test' }, { ...adapters, prepare: async () => ({}) }), { kind: 'fallback' });
  assert.deepEqual(await ingestMessage({ id: '' }, adapters), { skipped: true, reason: 'bad-message' });
});

test('inbox ticker: round-robin, busy guard, prepareBatch', async () => {
  const tick = createInboxTicker({ mailboxes: ['a', 'b'] });
  const seen = [];
  let release;
  const slow = tick({ listMessages: (box) => new Promise((resolve) => { release = () => resolve({ messages: [{ box }] }); }), ingest: async (m) => seen.push(m) });
  assert.deepEqual(await tick({ listMessages: async () => ({}), ingest: async () => {} }), { skipped: true, reason: 'busy' });
  release();
  assert.deepEqual(await slow, { mailbox: 'a', skipped: false, reason: '', processed: 1 });
  const second = await tick({ listMessages: async (box) => ({ messages: [{ box }, { box }] }), prepareBatch: (rows) => rows.slice(1), ingest: async (m) => seen.push(m) });
  assert.deepEqual(second, { mailbox: 'b', skipped: false, reason: '', processed: 1 });
  assert.deepEqual(seen, [{ box: 'a' }, { box: 'b' }]);
});

test('mail + documents: rfc822 with attachment, text extraction without AI', async () => {
  const raw = [
    'From: =?UTF-8?Q?P=C3=A5l?= <pal@x.test>',
    'Subject: Logo',
    'Message-ID: <m1@x.test>',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here is the menu',
    '--b1',
    'Content-Type: text/csv; name="menu.csv"',
    'Content-Disposition: attachment; filename="menu.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Pizza;120\n').toString('base64'),
    '--b1--',
  ].join('\r\n');
  const parsed = parseRfc822(raw);
  assert.equal(parsed.from, 'Pål <pal@x.test>');
  assert.equal(parsed.messageId, '<m1@x.test>');
  assert.deepEqual(parsed.attachmentNames, ['menu.csv']);
  const doc = await extractDocumentText({ originalName: 'menu.csv', buffer: parsed.attachments[0].buffer });
  assert.deepEqual(doc, { fileName: 'menu.csv', text: 'Pizza;120\n', kind: 'spreadsheet' });
  const image = await extractDocumentText({ originalName: 'a.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  assert.deepEqual(image, { fileName: 'a.png', text: '', kind: 'image' });
});

test('machine mail is iTIP / Auto-Submitted / DSN, never the subject', () => {
  const rsvp = parseRfc822([
    'From: Client <a@x.test>',
    'Subject: Godkjent: anything',
    'Content-Type: text/calendar; method=REPLY',
    '',
    'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n',
  ].join('\r\n'));
  assert.equal(rsvp.calendarMethod, 'REPLY');
  assert.equal(rsvp.attachments.length, 0);
  assert.equal(isAutomatedMail(rsvp), true);
  assert.equal(isAutomatedMail({ subject: 'Godkjent: logoen', from: 'a@x.test', text: 'Her er filen' }), false);
  assert.equal(isAutomatedMail({
    from: 'a@x.test',
    text: 'Kan vi ta tirsdag kl 14?',
    listId: '<sales@firma.no>',
    precedence: 'list',
  }), false);
  assert.equal(isAutomatedMail({ from: 'mailer-daemon@x.test', contentType: 'multipart/report' }), true);
  assert.equal(isAutomatedMail({ from: 'a@x.test', autoSubmitted: 'auto-replied', text: 'OOO' }), true);
});

// The bot's replies go out as the mailbox it reads and are filed there (Sendt + a read Innboks copy),
// and every hub mail from a mailbox with IMAP access gets a Sendt copy. No test here opens a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-reply-copy-'));
process.env.APP_DATA_DIR = dataDir;

const { appendMailboxCopy, composeRawMessage, imapCredsForSender, SENT_FOLDERS } = await import('../lib/mailbox-copy.js');
const { imapAppendConversation } = await import('../packages/suite/core/mail/imap.js');
const { parseRfc822, BOT_COPY_HEADER } = await import('../packages/suite/core/mail/mime.js');
const { readOpsEvents } = await import('../lib/ops-events.js');
const { mailboxSender, threadHeaders } = await import('../lib/inbox-bot/write.js');
const { listNewMailboxMessages } = await import('../lib/inbox-bot/mail.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ENV = { INBOX_IMAP_ALEXANDER_PASS: 'test-only' };
const MAIL = {
  from: 'Alexander fra Asoldi <alexander@asoldi.com>',
  to: 'kunde@example.com',
  subject: 'Re: Ang møte',
  text: 'Helt i orden, vi finner en ny tid.',
  html: '<p>Helt i orden, vi finner en ny tid.</p>',
  replyTo: 'alexander@asoldi.com',
  headers: { 'In-Reply-To': '<b@example.com>', References: '<a@example.com> <b@example.com>', 'X-Entity-Ref-ID': 'drop-me' },
  salesClientId: 'card-1',
};

test('only an @asoldi.com mailbox with its own INBOX_IMAP_<NAME>_PASS gets copies', () => {
  assert.deepEqual(
    imapCredsForSender('Alexander@asoldi.com', ENV),
    { host: 'imap.hostinger.com', port: 993, user: 'alexander@asoldi.com', pass: 'test-only', mailbox: 'alexander@asoldi.com' },
  );
  assert.equal(imapCredsForSender('contact@asoldi.com', ENV), null, 'no password, no copy');
  assert.equal(imapCredsForSender('kunde@example.com', { INBOX_IMAP_KUNDE_PASS: 'x' }), null, 'never a client mailbox');
});

test('the raw copy keeps the thread headers, drops the per-send id, and marks only the bot copy', async () => {
  const sent = (await composeRawMessage(MAIL)).toString('latin1');
  const head = sent.split('\r\n\r\n')[0];
  assert.match(head, /^From: Alexander fra Asoldi <alexander@asoldi\.com>$/m);
  assert.match(head, /^In-Reply-To: <b@example\.com>$/m);
  assert.match(head, /^References: <a@example\.com> <b@example\.com>$/m);
  assert.doesNotMatch(head, /X-Entity-Ref-ID/i);
  assert.doesNotMatch(head, new RegExp(BOT_COPY_HEADER, 'i'));
  const copy = (await composeRawMessage(MAIL, { botCopy: true })).toString('latin1');
  assert.match(copy.split('\r\n\r\n')[0], new RegExp(`^${BOT_COPY_HEADER}: 1$`, 'm'));
  assert.equal(parseRfc822(copy).botCopy, true, 'the reader recognises its own copy');
  assert.equal(parseRfc822(sent).botCopy, false);
});

test('Sendt first, the next folder name only when the first does not exist, and a read Innboks copy for the bot', async () => {
  const calls = [];
  const append = async (creds, folder, raw) => {
    calls.push({ folder, botCopy: /^X-Bot-Copy: 1$/m.test(raw.toString('latin1')) });
    if (folder === 'INBOX.Sent') throw new Error('IMAP append refused: NO [TRYCREATE] Mailbox does not exist');
  };
  const result = await appendMailboxCopy(MAIL, { fromAddress: 'alexander@asoldi.com', inbox: true, append, env: ENV, system: 'inbox' });
  assert.deepEqual(calls, [
    { folder: 'INBOX.Sent', botCopy: false },
    { folder: 'Sent', botCopy: false },
    { folder: 'INBOX', botCopy: true },
  ]);
  assert.equal(result.sent.ok, true);
  assert.equal(result.sent.folder, 'Sent');
  assert.equal(result.inbox.ok, true);
  assert.deepEqual(SENT_FOLDERS.slice(0, 2), ['INBOX.Sent', 'Sent']);
  const event = readOpsEvents({ system: 'inbox' }).find((row) => row.type === 'copy.appended');
  assert.equal(event.mailbox, 'alexander@asoldi.com');
  assert.equal(event.salesClientId, 'card-1');
  assert.equal(event.sent.ok, true);
  assert.equal('text' in event, false, 'no mail body in the log');
});

test('a refused copy never throws, stops at a real error, and a mailbox without IMAP is skipped', async () => {
  const calls = [];
  const append = async (_creds, folder) => {
    calls.push(folder);
    throw new Error('IMAP append failed: NO quota exceeded');
  };
  const result = await appendMailboxCopy(MAIL, { fromAddress: 'alexander@asoldi.com', append, env: ENV });
  assert.deepEqual(calls, ['INBOX.Sent'], 'a quota error is not a missing folder');
  assert.equal(result.sent.ok, false);
  assert.match(result.sent.error, /quota/);
  assert.equal(result.inbox, null, 'no Innboks copy unless asked');
  assert.deepEqual(await appendMailboxCopy(MAIL, { fromAddress: 'contact@asoldi.com', append, env: ENV }), { skipped: 'no-imap-login' });
});

function scriptedSession(serverLines) {
  const sent = [];
  const written = [];
  const queue = [...serverLines];
  return {
    sent,
    written,
    session: {
      send: (line) => sent.push(line),
      write: (buffer) => written.push(Buffer.from(buffer)),
      waitFor: async () => Buffer.from(`${queue.shift() ?? 'APP1 BAD out of script'}\r\n`),
    },
  };
}

test('APPEND: command with flags and byte length, literal after "+", done on the tagged OK', async () => {
  const bytes = Buffer.from('Subject: møte\r\n\r\nHei', 'utf8');
  const { sent, written, session } = scriptedSession(['+ Ready for literal data', '* 12 EXISTS', 'APP1 OK [APPENDUID 1 9] Append completed.']);
  await imapAppendConversation(session, 'INBOX.Sent', bytes);
  assert.deepEqual(sent, [`APP1 APPEND INBOX.Sent (\\Seen) {${bytes.length}}`], 'the length is in bytes, not characters');
  assert.equal(Buffer.concat(written).toString('utf8'), 'Subject: møte\r\n\r\nHei\r\n');
});

test('APPEND: a refusal before the literal and a NO after it both throw', async () => {
  const refused = scriptedSession(['APP1 NO [TRYCREATE] Mailbox does not exist']);
  await assert.rejects(imapAppendConversation(refused.session, 'Sent', Buffer.from('x')), /refused: NO \[TRYCREATE\]/);
  assert.equal(refused.written.length, 0, 'no literal is written after a refusal');
  const failed = scriptedSession(['+ go', 'APP1 NO Over quota']);
  await assert.rejects(imapAppendConversation(failed.session, 'Sent', Buffer.from('x')), /failed: NO Over quota/);
});

test('the parser exposes References and In-Reply-To for the next reply in the thread', () => {
  const raw = [
    'From: Kunde <kunde@example.com>',
    'To: alexander@asoldi.com',
    'Subject: Re: Møte',
    'Message-ID: <c@example.com>',
    'In-Reply-To: <b@example.com>',
    'References: <a@example.com>',
    ' <b@example.com>',
    '',
    'Kan vi ta fredag?',
  ].join('\r\n');
  const parsed = parseRfc822(raw);
  assert.equal(parsed.inReplyTo, '<b@example.com>');
  assert.equal(parsed.references, '<a@example.com> <b@example.com>');
  assert.deepEqual(threadHeaders({ rfcMessageId: parsed.messageId, references: parsed.references }), {
    'In-Reply-To': '<c@example.com>',
    References: '<a@example.com> <b@example.com> <c@example.com>',
  });
  assert.equal(threadHeaders({ rfcMessageId: 'not-an-id' }), null);
});

test('the bot answers as the mailbox the client wrote to', () => {
  assert.equal(mailboxSender('alexander@asoldi.com'), 'Alexander fra Asoldi <alexander@asoldi.com>');
  assert.equal(mailboxSender(''), 'Alexander fra Asoldi <alexander@asoldi.com>', 'the bot mailbox by default');
});

test('the inbox listing marks the bot\'s own Innboks copy processed and never hands it on', async () => {
  const processed = [];
  const listImap = async () => ({
    skipped: false,
    messages: [
      { id: 'imap:alexander@asoldi.com:uid:10', mailAt: new Date().toUTCString(), from: 'Alexander fra Asoldi <alexander@asoldi.com>', botCopy: true },
      { id: 'imap:alexander@asoldi.com:uid:11', mailAt: new Date().toUTCString(), from: 'Kunde <kunde@example.com>', botCopy: false },
    ],
  });
  process.env.INBOX_IMAP_ALEXANDER_PASS = 'test-only';
  try {
    const listed = await listNewMailboxMessages('alexander@asoldi.com', {
      listImap,
      isProcessed: () => false,
      markProcessed: (_mailbox, id) => processed.push(id),
      getBaseline: () => '2000-01-01T00:00:00.000Z',
      setBaseline: () => {},
    });
    assert.deepEqual(listed.messages.map((message) => message.id), ['imap:alexander@asoldi.com:uid:11']);
    assert.deepEqual(processed, ['imap:alexander@asoldi.com:uid:10']);
  } finally {
    delete process.env.INBOX_IMAP_ALEXANDER_PASS;
  }
});

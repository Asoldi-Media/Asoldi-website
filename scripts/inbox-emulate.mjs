#!/usr/bin/env node
/**
 * Run the inbox responder on Alexander's real IMAP mail without sending or booking anything.
 *
 * Reads the password from INBOX_IMAP_ALEXANDER_PASS in the shell only (never .env, so a local
 * server does not start auto-replying). Works on a temp copy of the data dir: card edits,
 * processed stamps, and filed uploads land there and are thrown away.
 *
 *   $env:INBOX_IMAP_ALEXANDER_PASS = '...'
 *   node scripts/inbox-emulate.mjs [--days 7] [--max 8] [--as kunde@firma.no] [--no-ai] [--keep]
 *
 * --as rewrites From on every message, to see how the bot answers that client's card.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

function arg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

dotenv.config({ override: false });
const MAILBOX = 'alexander@asoldi.com';
if (!String(process.env.INBOX_IMAP_ALEXANDER_PASS || '').trim()) {
  console.error('Set INBOX_IMAP_ALEXANDER_PASS in this shell first.');
  process.exit(1);
}

const sourceDir = String(process.env.APP_DATA_DIR || '').trim() || join(homedir(), '.asoldi-website-data');
const scratch = mkdtempSync(join(tmpdir(), 'asoldi-inbox-emulate-'));
if (existsSync(sourceDir)) {
  for (const name of readdirSync(sourceDir)) {
    if (name.endsWith('.json')) cpSync(join(sourceDir, name), join(scratch, name));
  }
}
process.env.APP_DATA_DIR = scratch;

const sales = await import('../data/sales.js');
const { ingestInboxMessage, markOlderSchedulingDuplicates } = await import('../lib/inbox-bot/index.js');
const { probeImapLogin, listImapRecentMessages } = await import('../lib/inbox-bot/mail-imap.js');
const { categorizeEmail, categorizeEmailHeuristic } = await import('../lib/inbox-bot/categorize.js');
const { freshReplyText } = await import('../lib/inbox-bot/write.js');

const days = Math.max(1, Number(arg('--days', '7')) || 7);
const max = Math.min(20, Math.max(1, Number(arg('--max', '8')) || 8));
const asFrom = arg('--as');

const login = await probeImapLogin(MAILBOX);
console.log(`IMAP ${MAILBOX}: ${login.ok ? 'OK' : `FAIL (${login.reason})`}`);
if (!login.ok) process.exit(2);

const listed = await listImapRecentMessages(MAILBOX, { maxResults: max, days });
const queued = markOlderSchedulingDuplicates(
  (listed.messages || []).map((message) => (asFrom ? { ...message, from: asFrom } : message)),
);
console.log(`${queued.length} message(s) from the last ${days} day(s). Data copy: ${scratch}\n`);

for (const message of queued) {
  const outbound = [];
  const calendar = [];
  const msg = message;
  const before = sales.getSalesClients();
  const result = await ingestInboxMessage(msg, {
    clients: before,
    categorize: has('--no-ai') ? categorizeEmailHeuristic : categorizeEmail,
    sendEmail: async (mail) => { outbound.push(mail); },
    queryBusy: async (kind) => { calendar.push(`freebusy:${kind}`); return { busy: [] }; },
    upsert: async () => { calendar.push('upsert-sales-meeting'); return { id: 'emulated' }; },
    loadNeeds: async () => [],
    now: Number.isNaN(Date.parse(msg.mailAt)) ? new Date() : new Date(msg.mailAt),
    confirmWorkshop: async (client, _prev, next) => {
      calendar.push(`workshop-confirm:${next?.dueAt || ''}`);
      return { ok: true, sent: false, emulated: true, client };
    },
  });
  const clientId = result.salesClientId || '';
  const card = clientId ? sales.getSalesClientById(clientId) : null;
  console.log('─'.repeat(72));
  console.log(`From:    ${msg.from}${asFrom ? '  (rewritten)' : ''}`);
  console.log(`Subject: ${msg.subject}`);
  console.log(`Files:   ${(msg.attachmentNames || []).join(', ') || '—'}`);
  const fresh = freshReplyText(msg.text);
  console.log(`Text:    ${fresh.slice(0, 300)}${fresh.length > 300 ? '…' : ''}`);
  console.log(`Kind:    ${result.kind || result.reason || '—'}`);
  console.log(`Client:  ${card ? `${card.businessName} (${clientId})` : 'no match'}`);
  if (msg.skipWrite) console.log('Skip:    older mail from the same sender — no extra reply');
  if (result.write) console.log(`Write:   ${result.write.kind || result.write.reason || (result.write.wrote ? 'wrote' : 'none')}`);
  const known = new Set((before.find((row) => row.id === clientId)?.nextActions || []).map((row) => row.id));
  for (const row of (card?.nextActions || []).filter((item) => !known.has(item.id))) {
    console.log(`Action:  ${row.name} (${row.format})${row.dueAt ? ` @ ${row.dueAt}` : ''}\n         ${String(row.note || '').replace(/\n/g, '\n         ')}`);
  }
  if (result.item?.status) console.log(`Stored:  ${result.item.status}${result.item.elements?.length ? ` · ${result.item.elements.map((row) => row.bucket).join(', ')}` : ''}`);
  if (calendar.length) console.log(`Calendar (stubbed): ${calendar.join(', ')}`);
  for (const mail of outbound) {
    console.log(`\nWould send to ${mail.to}: ${mail.subject}\n  ${String(mail.text || '').replace(/\n/g, '\n  ')}`);
  }
  if (!outbound.length) console.log('No reply.');
}

if (!has('--keep')) rmSync(scratch, { recursive: true, force: true });

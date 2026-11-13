// Real client mails that went unanswered in October and November 2026, replayed through the bot with
// names and addresses replaced. Each one must now cancel or move the meeting and get an answer from the
// mailbox the client wrote to, with the answer stored for the sales card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-inbox-replay-'));
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const sales = await import('../data/sales.js');
const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
const { categorizeEmailHeuristic } = await import('../lib/inbox-bot/categorize.js');
const { defaultVoidMeeting } = await import('../lib/inbox-bot/meeting.js');
const { listInboxItems } = await import('../lib/inbox-bot/store.js');
const { mergeWriteDecision, sameFamily } = await import('../lib/inbox-bot/decide.js');
const { buildSalesCardLog } = await import('../lib/sales-card-log.js');
const { osloCalendarYmd } = await import('../lib/website-due.js');

// Monday 3 March 2031 09:15 Oslo.
const NOW = new Date('2031-03-03T08:15:00.000Z');
const TODAY_14 = '2031-03-03T13:00:00.000Z';
const TOMORROW_14 = '2031-03-04T13:00:00.000Z';

let seq = 0;

function seed(meetingAt) {
  seq += 1;
  const id = `replay-${seq}`;
  sales.createSalesClient({ id, businessName: `Replay ${seq} AS`, contactEmail: `kunde${seq}@replay.test`, product: 'asoldi' });
  sales.updateSalesClient(id, {
    ownerId: 'sales:rep-1',
    meetingAt,
    agreedTime: true,
    reminders: { thankYouSentAt: '2031-02-27T10:00:00.000Z' },
  });
  sales.rescheduleSalesReminders(id, NOW.getTime());
  return sales.getSalesClientById(id);
}

async function replay(client, text, { subject = 'Re: Påminnelse: Online møte med Asoldi', decideAi } = {}) {
  seq += 1;
  const sent = [];
  const voids = [];
  const result = await ingestInboxMessage({
    id: `replay-msg-${seq}`,
    mailbox: 'alexander@asoldi.com',
    from: `Kunde <${client.contactEmail}>`,
    subject,
    text,
    mailAt: NOW.toISOString(),
    rfcMessageId: `<replay-${seq}@replay.test>`,
  }, {
    categorize: categorizeEmailHeuristic,
    sendEmail: async (payload) => { sent.push(payload); },
    queryBusy: async () => ({ busy: [] }),
    voidMeeting: async (card, options) => {
      voids.push(options);
      return defaultVoidMeeting(card, options);
    },
    decideAi,
    now: NOW,
  });
  const items = listInboxItems({ salesClientId: client.id });
  return { result, sent, voids, item: items[items.length - 1], card: sales.getSalesClientById(client.id) };
}

function assertAnsweredAsAlexander(sent, item) {
  assert.equal(sent.length, 1, 'one answer to the client');
  assert.equal(sent[0].from, 'Alexander fra Asoldi <alexander@asoldi.com>');
  assert.equal(sent[0].replyTo, 'alexander@asoldi.com');
  assert.equal(sent[0].copyToInbox, true, 'filed in Alexander\'s Innboks and Sendt');
  assert.match(sent[0].headers['In-Reply-To'], /^<replay-\d+@replay\.test>$/);
  assert.equal(item.status, 'applied');
  assert.equal(item.replyText, sent[0].text, 'the card keeps exactly what was sent');
  assert.ok(Date.parse(item.repliedAt));
}

test('"Hei må avlyse dagens møte. Beklager" cancels today\'s meeting and asks for a new time', async () => {
  const client = seed(TODAY_14);
  const { sent, voids, item, card } = await replay(client, 'Hei må avlyse dagens møte. Beklager\nMvh\nLudvig', { subject: 'Avlyse' });
  assert.equal(voids.length, 1);
  assert.equal(card.agreedTime, false);
  assertAnsweredAsAlexander(sent, item);
  assert.match(sent[0].text, /Hvilken dag og tid passer bedre/);
  assert.equal(item.kind, 'sales_cancel');
});

test('"Kan vi utsette det til i morgen?" on the meeting day offers times tomorrow', async () => {
  const client = seed(TODAY_14);
  const { sent, item, card } = await replay(client, 'Hallo, jeg er opptatt på den timen på grunn av har kunde . Kan vi utsette det til i morgen?');
  assert.equal(card.agreedTime, false, 'the old time is gone, so no reminder names it');
  assertAnsweredAsAlexander(sent, item);
  assert.equal(item.kind, 'sales_propose');
  assert.ok(item.offeredSlots.length > 0);
  assert.ok(item.offeredSlots.every((iso) => osloCalendarYmd(iso) === '2031-03-04'), 'every offered time is tomorrow');
});

test('"Jeg rekker dessverre ikke møtet i dag … kan du på et annet tidspunkt?" cancels and offers times', async () => {
  const client = seed(TODAY_14);
  const { sent, item, card } = await replay(
    client,
    'Hei Alexander!\n\nJeg rekker dessverre ikke møtet i dag - kom opp et annet møte jeg blir nødt til å delta i..\n\nBeklager - kan du på et annet tidspunkt?\n\nMvh Anna',
    { subject: 'Ang møte' },
  );
  assert.equal(card.agreedTime, false);
  assertAnsweredAsAlexander(sent, item);
  assert.ok(item.offeredSlots.length > 0, 'the answer carries free times');
  assert.ok(item.offeredSlots.every((iso) => osloCalendarYmd(iso) !== '2031-03-03'), 'never today again');
});

test('"… at jeg ikke kan imorgen kl 14 likevel. Kan vi ta det fredag?" offers Friday', async () => {
  const client = seed(TOMORROW_14);
  const { sent, item, card } = await replay(
    client,
    'Hei igjen, Jeg sendte en mail tidligere idag om at jeg ikke kan imorgen kl 14 likevel. Kan vi ta det fredag?',
  );
  assert.equal(card.agreedTime, false);
  assertAnsweredAsAlexander(sent, item);
  assert.equal(item.kind, 'sales_propose');
  assert.ok(item.offeredSlots.length > 0);
  assert.ok(item.offeredSlots.every((iso) => osloCalendarYmd(iso) === '2031-03-07'), 'the times are on Friday');
});

test('"Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen" cancels it', async () => {
  const client = seed(TOMORROW_14);
  const { sent, item, card } = await replay(client, 'Hei! Jeg har svart deg flere ganger at jeg må avlyse møtet i morgen.\n\nMvh Marie');
  assert.equal(card.agreedTime, false);
  assertAnsweredAsAlexander(sent, item);
  assert.equal(item.kind, 'sales_cancel');
});

test('the answer shows on the sales card log next to the client\'s words', async () => {
  const client = seed(TODAY_14);
  await replay(client, 'Hei må avlyse dagens møte. Beklager', { subject: 'Avlyse' });
  const { presentInboxForClient } = await import('../lib/inbox-bot/store.js');
  const card = { ...sales.getSalesClientById(client.id), inboxBot: presentInboxForClient(client.id) };
  const rows = buildSalesCardLog(card, NOW.getTime());
  assert.ok(rows.some((row) => row.name === 'E-post fra kunden' && /avlyse dagens møte/.test(row.text)));
  assert.ok(rows.some((row) => row.name === 'Møtet avlyst på e-post' && /Hvilken dag og tid passer bedre/.test(row.text)));
});

test('reschedule, reschedule_day and cancel are one family: the AI reading another of them never silences the bot', async () => {
  for (const [left, right] of [['reschedule', 'reschedule_day'], ['reschedule_day', 'cancel'], ['cancel', 'reschedule']]) {
    assert.equal(sameFamily(left, right), true, `${left}|${right}`);
  }
  assert.equal(sameFamily('reschedule', 'not_interested'), false, 'a no is still a different request');
  const merged = mergeWriteDecision({ request: 'reschedule_day', intent: 'sales_propose', day: { ymd: '2031-03-04' } }, { request: 'reschedule', reply: '' });
  assert.equal(merged.needsHuman, false);
  assert.equal(merged.request, 'reschedule_day', 'the words pick the action');
  assert.equal(merged.aiRequest, 'reschedule');

  const client = seed(TODAY_14);
  const { sent, item } = await replay(client, 'Hallo, jeg er opptatt på den timen. Kan vi utsette det til i morgen?', {
    decideAi: async () => ({ request: 'reschedule', reply: '' }),
  });
  assert.equal(item.status, 'applied', 'answered, not left for a person');
  assert.equal(sent.length, 1);
});

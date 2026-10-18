import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-workshop-prep-'));
delete process.env.DEEPSEEK_API_KEY;

const sales = await import('../data/sales.js');
const { shouldSendPreWorkshopOnContract } = await import('../lib/workshop-prep-send.js');
const { mergePrepNeedLines } = await import('../lib/workshop-prep-needs.js');
const {
  parseWorkshopTimeHeuristic,
  resolveInboxWorkshopDueAt,
} = await import('../lib/workshop-time-parse.js');
const { osloCalendarYmd } = await import('../lib/website-due.js');
const { categorizeEmailHeuristic } = await import('../lib/inbox-bot/categorize.js');
const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
const { getWorkshopAction } = await import('../lib/workshop-action.js');
const { classifyInboxWrite } = await import('../lib/inbox-bot/write.js');
const { slotIsFree } = await import('../lib/inbox-bot/slots.js');
const { parseDayHint, looksLikeCallFollowup } = await import('../lib/workshop-time-parse.js');

function seedClient(overrides = {}) {
  return sales.createSalesClient({
    id: overrides.id || 'sale-prep-1',
    businessName: overrides.businessName || 'Cafe Nordlys',
    contactEmail: overrides.contactEmail || 'eier@nordlys.no',
    product: overrides.product || 'asoldi',
    ...overrides,
  });
}

test('pre-workshop send is one-shot, skips SSU, and requires Kontrakt turning on', () => {
  const client = { progression: { contractSigned: true }, product: 'asoldi' };
  assert.equal(shouldSendPreWorkshopOnContract({ previousSigned: false, client }), true);
  assert.equal(shouldSendPreWorkshopOnContract({ previousSigned: true, client }), false);
  assert.equal(shouldSendPreWorkshopOnContract({
    previousSigned: false,
    client: { ...client, product: 'ssu' },
  }), false);
  assert.equal(shouldSendPreWorkshopOnContract({
    previousSigned: false,
    client: { ...client, workshop: { deskEmails: { preWorkshopSentAt: '2026-10-10T12:00:00.000Z' } } },
  }), false);
});

test('need list keeps T01 plus red/orange dots and skips Place ID and maker colors', () => {
  const lines = mergePrepNeedLines({
    t01Lines: [{ id: 'logo', title: 'Logo', detail: 'Høy oppløsning' }],
    dots: [
      { id: 'google-place-id', label: 'Google Place ID', mark: 'red' },
      { id: 'color-primary', label: 'Hovedfarge', mark: 'red' },
      { id: 'hero', label: 'Hovedbilde', mark: 'red', detail: 'Mangler' },
      { id: 'logo', label: 'Logo', mark: 'orange' },
    ],
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].title, 'Logo');
  assert.equal(lines[1].title, 'Hovedbilde');
});

test('workshop time parse requires a clock and uses Europe/Oslo', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  const weekday = parseWorkshopTimeHeuristic('Kan vi ta workshopen tirsdag kl 10?', { now });
  assert.ok(weekday?.dueAt);
  assert.equal(osloCalendarYmd(weekday.dueAt), '2026-10-13');
  const dated = parseWorkshopTimeHeuristic('Passer 15.10 kl 14:30', { now });
  assert.ok(dated?.dueAt);
  assert.equal(osloCalendarYmd(dated.dueAt), '2026-10-15');
  assert.equal(parseWorkshopTimeHeuristic('kanskje neste uke', { now }), null);
  assert.equal(parseWorkshopTimeHeuristic('kan vi ta workshop mandag', { now }), null);
  assert.equal(resolveInboxWorkshopDueAt('Hei, takk for tilbudet', '2026-10-13T08:00:00.000Z'), '');
});

test('heuristic labels a dated workshop reply as workshop_time', () => {
  const out = categorizeEmailHeuristic({
    subject: 'Re: Før workshopen',
    text: 'Tirsdag kl 10 passer fint',
  });
  assert.equal(out.kind, 'workshop_time');
  assert.ok(out.dueAt);
});

test('inbox reply with a time before Kontrakt does not book a workshop', async () => {
  const client = seedClient({ id: 'sale-prep-time-1', contactEmail: 'tid@nordlys.no' });
  let confirmed = 0;
  const sent = [];
  await ingestInboxMessage({
    id: 'imap-ws-1',
    mailbox: 'damian@asoldi.com',
    from: 'tid@nordlys.no',
    subject: 'Workshop',
    text: 'Kan vi ta workshopen tirsdag kl 10?',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    queryBusy: async () => ({ busy: [] }),
    sendEmail: async (payload) => { sent.push(payload); },
    confirmWorkshop: async () => {
      confirmed += 1;
      return { sent: true };
    },
  });
  assert.equal(confirmed, 0);
  assert.equal(getWorkshopAction(sales.getSalesClientById(client.id))?.dueAt || '', '');
});

test('inbox reply with a time after Kontrakt books when Damian calendar is free', async () => {
  const client = seedClient({ id: 'sale-prep-time-2', contactEmail: 'tid2@nordlys.no' });
  sales.updateSalesClient(client.id, { progression: { contractSigned: true } });
  let confirmed = 0;
  const result = await ingestInboxMessage({
    id: 'imap-ws-2',
    mailbox: 'damian@asoldi.com',
    from: 'tid2@nordlys.no',
    subject: 'Workshop',
    text: 'Tirsdag kl 10 passer',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    queryBusy: async () => ({ busy: [] }),
    now: new Date('2026-10-10T12:00:00.000Z'),
    loadNeeds: async () => [{ title: 'Logo' }],
    confirmWorkshop: async (live, previous, next) => {
      confirmed += 1;
      assert.ok(next.dueAt);
      return { sent: true, client: live };
    },
  });
  assert.equal(result.kind, 'workshop_book');
  assert.equal(confirmed, 1);
  assert.equal(result.write?.applied?.applied, true);
});

test('busy Damian slot proposes other times instead of booking', async () => {
  const client = seedClient({ id: 'sale-prep-busy', contactEmail: 'busy@nordlys.no' });
  sales.updateSalesClient(client.id, { progression: { contractSigned: true } });
  const now = new Date('2026-10-10T12:00:00.000Z');
  const parsed = parseWorkshopTimeHeuristic('Tirsdag kl 10 passer', { now });
  let confirmed = 0;
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-ws-busy',
    mailbox: 'damian@asoldi.com',
    from: 'busy@nordlys.no',
    subject: 'Workshop',
    text: 'Tirsdag kl 10 passer',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    queryBusy: async () => ({
      busy: [{ start: parsed.dueAt, end: new Date(Date.parse(parsed.dueAt) + 30 * 60 * 1000).toISOString() }],
    }),
    sendEmail: async (payload) => { sent.push(payload); },
    now,
    confirmWorkshop: async () => {
      confirmed += 1;
      return { sent: true };
    },
  });
  assert.equal(confirmed, 0);
  assert.equal(result.kind, 'workshop_propose');
  assert.match(sent[0].text, /opptatt/i);
});

test('call-followup after Kontrakt acks and adds an Admin ring action, not a calendar booking', async () => {
  const client = seedClient({ id: 'sale-prep-call', contactEmail: 'ring@nordlys.no' });
  sales.updateSalesClient(client.id, { progression: { contractSigned: true } });
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-ws-call',
    mailbox: 'damian@asoldi.com',
    from: 'ring@nordlys.no',
    subject: 'Workshop',
    text: 'Dere kan ringe meg på onsdag morgen for å avtale nærmere da jeg ikke helt vet',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    queryBusy: async () => ({ busy: [] }),
    sendEmail: async (payload) => { sent.push(payload); },
    confirmWorkshop: async () => ({ sent: true }),
  });
  assert.equal(result.kind, 'workshop_call');
  assert.match(sent[0].text, /helt i orden/i);
  const actions = sales.getSalesClientById(client.id).workshop?.goalActions || [];
  const row = actions.find((item) => /tid for workshop/i.test(item.name));
  assert.ok(row);
  assert.equal(row.format, 'ring');
  assert.equal(Boolean(row.addToCalendar), false);
  assert.equal(getWorkshopAction(sales.getSalesClientById(client.id))?.dueAt || '', '');
});

test('write is skipped when From is not a known client email', async () => {
  seedClient({ id: 'sale-prep-unknown', contactEmail: 'kjent@nordlys.no' });
  const sent = [];
  let confirmed = 0;
  const result = await ingestInboxMessage({
    id: 'imap-ws-unknown',
    mailbox: 'damian@asoldi.com',
    from: 'fremmed@annet.no',
    subject: 'Workshop',
    text: 'Tirsdag kl 10 passer',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    queryBusy: async () => ({ busy: [] }),
    sendEmail: async (payload) => { sent.push(payload); },
    confirmWorkshop: async () => {
      confirmed += 1;
      return { sent: true };
    },
  });
  assert.equal(confirmed, 0);
  assert.equal(sent.length, 0);
  assert.equal(result.write?.wrote || false, false);
});

test('day hint and call phrasing parse without inventing a clock', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const day = parseDayHint('onsdag passer bra', { now });
  assert.equal(day.ymd, '2026-10-14');
  assert.equal(looksLikeCallFollowup('ring meg onsdag morgen'), true);
  assert.equal(slotIsFree('2026-10-14T07:00:00.000Z', 30, [
    { start: '2026-10-14T07:00:00.000Z', end: '2026-10-14T08:00:00.000Z' },
  ]), false);
  const intent = classifyInboxWrite('onsdag passer bra', { progression: { contractSigned: true } }, { now });
  assert.equal(intent.intent, 'workshop_propose');
  const inThree = parseDayHint('ring meg om 3 dager og sjekk opp', { now });
  assert.equal(inThree.ymd, '2026-10-13');
  const callSoon = classifyInboxWrite('Kan dere ringe meg om 3 dager for å sjekke opp', {
    progression: { contractSigned: true },
  }, { now });
  assert.equal(callSoon.intent, 'workshop_call');
  assert.equal(callSoon.day.ymd, '2026-10-13');
});

test('sales meeting clock that is busy on the rep calendar proposes other times', async () => {
  const client = seedClient({
    id: 'sale-prep-sales-busy',
    contactEmail: 'selgerkunde@nordlys.no',
    ownerId: 'sales:rep-1',
  });
  const now = new Date('2026-10-10T12:00:00.000Z');
  const parsed = parseWorkshopTimeHeuristic('Mandag kl 10 passer', { now });
  const sent = [];
  const result = await ingestInboxMessage({
    id: 'imap-ws-sales-busy',
    mailbox: 'damian@asoldi.com',
    from: 'selgerkunde@nordlys.no',
    subject: 'Møte',
    text: 'Jeg kan ikke da, mandag kl 10 passer',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, {
    now,
    queryBusy: async () => ({
      busy: [{ start: parsed.dueAt, end: new Date(Date.parse(parsed.dueAt) + 60 * 60 * 1000).toISOString() }],
    }),
    sendEmail: async (payload) => { sent.push(payload); },
    upsert: async () => { throw new Error('should not upsert'); },
  });
  assert.equal(result.kind, 'sales_propose');
  assert.match(sent[0].text, /opptatt/i);
  assert.equal(sales.getSalesClientById(client.id).meetingAt || '', '');
});

test('uncertain scheduling text does not write a workshop time', async () => {
  const client = seedClient({ id: 'sale-prep-time-3', contactEmail: 'uklar@nordlys.no' });
  const result = await ingestInboxMessage({
    id: 'imap-ws-3',
    mailbox: 'damian@asoldi.com',
    from: 'uklar@nordlys.no',
    subject: 'Workshop',
    text: 'Kanskje neste uke, vi hører',
    mailAt: '2026-10-10T12:00:00.000Z',
  }, { sendEmail: async () => {}, queryBusy: async () => ({ busy: [] }), decideAi: async () => ({}) });
  assert.equal(/_book$/.test(result.kind || ''), false);
  assert.equal(getWorkshopAction(sales.getSalesClientById(client.id))?.dueAt || '', '');
});

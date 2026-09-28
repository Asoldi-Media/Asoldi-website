import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEmailForClient } from '../lib/email-templates-store.js';
import { deriveReminderSchedule, salesReminderIsDue } from '../data/sales.js';
import { buildSalesSender } from '../lib/sales-sender.js';
import {
  buildSalesCalendarInvite,
  embedInlineEmailAssets,
  getSalesEmailPreviewClient,
  rewriteSalesEmailAssetsToHosted,
} from '../lib/sales-email.js';
import { renderResponsiveSalesEmailHtml } from '../lib/sales-email-layout.js';

test('calendar invite organizer matches the branded From address', () => {
  const previous = process.env.RESEND_FROM;
  process.env.RESEND_FROM = 'Asoldi <contact@asoldi.com>';
  const invite = buildSalesCalendarInvite(getSalesEmailPreviewClient(), {
    meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
    htmlLink: 'https://calendar.google.com/event?eid=test',
    eventId: 'evt-1',
  });
  process.env.RESEND_FROM = previous;
  assert.ok(invite);
  assert.equal(invite.method, 'REQUEST');
  assert.match(invite.content, /METHOD:REQUEST/);
  assert.match(invite.content, /ORGANIZER;CN=Asoldi:mailto:contact@asoldi.com/);
  assert.match(invite.content, /ATTENDEE;.*mailto:daracha777@gmail.com/);
  assert.match(invite.content, /LOCATION:https:\/\/meet\.google\.com\/aaa-bbbb-ccc/);
  assert.match(invite.content, /PARTSTAT=NEEDS-ACTION/);
  assert.match(invite.content, /SEQUENCE:0/);
});

test('a resent confirmation keeps the same Meet link and bumps the invite sequence', () => {
  const invite = buildSalesCalendarInvite(getSalesEmailPreviewClient(), {
    meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
    htmlLink: 'https://calendar.google.com/event?eid=test',
    eventId: 'evt-1',
    inviteSequence: 2,
  });
  assert.match(invite.content, /SEQUENCE:2/);
  assert.match(invite.content, /X-GOOGLE-CONFERENCE:https:\/\/meet\.google\.com\/aaa-bbbb-ccc/);
});

test('in-person invite ignores a leftover Meet link', () => {
  const client = getSalesEmailPreviewClient({ meetingMode: 'in-person' });
  const invite = buildSalesCalendarInvite(client, {
    meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
    eventId: 'evt-irl',
    inviteSequence: 1,
  });
  assert.equal(invite.content.includes('meet.google.com'), false);
  assert.equal(invite.content.includes('X-GOOGLE-CONFERENCE'), false);
  assert.match(invite.content, /SEQUENCE:1/);
});

test('online ICS is still built when the Meet link is missing', () => {
  const client = getSalesEmailPreviewClient({
    calendar: { meetLink: '', htmlLink: 'https://calendar.google.com/event?eid=x', eventId: 'evt-2' },
  });
  const invite = buildSalesCalendarInvite(client, client.calendar);
  assert.ok(invite);
  assert.match(invite.content, /METHOD:REQUEST/);
});

test('sales images stay in the HTML and are not file attachments', () => {
  const html = rewriteSalesEmailAssetsToHosted(`
    <img src="cid:asoldi-hero-desktop" />
    <img src="/email/sales/envelope.png" />
    <img src="https://asoldi.com/email/sales/icon-facebook.png" />
  `);
  const embedded = embedInlineEmailAssets('<img src="/email/sales/hero-desktop.jpg" />');
  assert.match(html, /https:\/\/asoldi\.com\/email\/sales\/hero-banner\.jpg/);
  assert.match(html, /https:\/\/asoldi\.com\/email\/sales\/envelope\.png/);
  assert.match(html, /https:\/\/asoldi\.com\/email\/sales\/icon-facebook\.png/);
  assert.equal(html.includes('cid:'), false);
  assert.deepEqual(embedded.attachments, []);
});

test('in-person confirmation states the address and a 30-minute call-ahead, without a maps button', () => {
  const client = getSalesEmailPreviewClient({ meetingMode: 'in-person', businessName: 'Asoldi' });
  const message = composeEmailForClient(client, 'thank-you').message;
  assert.match(message.subject, /fysisk møte/i);
  assert.match(message.html, /Østre berg 10/);
  assert.match(message.html, /ca\. 30 minutter/);
  assert.match(message.html, /ringer deg litt i forkant/);
  assert.equal(message.html.includes('(fysisk møte)'), false);
  assert.equal(message.html.includes('Åpne i Kart'), false);
  assert.equal(message.html.includes('60 minutter'), false);
  assert.equal(message.html.includes('Åpne Google Meet'), false);
  assert.equal(message.icalEvent?.filename, 'asoldi-fysisk-mote.ics');
});

test('online confirmation keeps the Google Meet CTA', () => {
  const message = composeEmailForClient(getSalesEmailPreviewClient(), 'thank-you').message;
  assert.match(message.subject, /online møte/i);
  assert.match(message.html, /Åpne Google Meet/);
});

test('online calendar blocks 60 minutes while client copy stays 30', () => {
  const client = getSalesEmailPreviewClient();
  const message = composeEmailForClient(client, 'thank-you').message;
  assert.match(message.html, /satt av 30 min/);
  assert.equal(message.html.includes('60 min'), false);
  assert.match(message.icalEvent.content, /DTSTART:20260916T120000Z/);
  assert.match(message.icalEvent.content, /DTEND:20260916T130000Z/);
  assert.match(message.icalEvent.content, /Varighet: ca\. 30 minutter/);
  const irl = buildSalesCalendarInvite(getSalesEmailPreviewClient({ meetingMode: 'in-person' }), {
    eventId: 'evt-irl',
  });
  assert.match(irl.content, /DTEND:20260916T123000Z/);
});

test('3-day reminder copy follows the meeting type', () => {
  const online = composeEmailForClient(getSalesEmailPreviewClient(), 'reminder-3d').message;
  const irl = composeEmailForClient(getSalesEmailPreviewClient({ meetingMode: 'in-person' }), 'reminder-3d').message;
  assert.match(online.subject, /om 3 dager/);
  assert.match(online.html, /Vennlig påminnelse: møtet vårt starter om 3 dager\. 16\.09\.26 kl 14:00\./);
  assert.equal(online.html.includes('online-møtet'), false);
  assert.match(irl.subject, /Fysisk møte/);
  assert.match(irl.html, /Vennlig påminnelse: møtet vårt starter om 3 dager\. 16\.09\.26 kl 14:00\./);
  assert.equal(irl.html.includes('Åpne i Kart'), false);
  assert.equal(irl.html.includes('Trykk på knappen under for å åpne adressen'), false);
  const day = composeEmailForClient(getSalesEmailPreviewClient(), 'reminder-24h').message;
  const dayIrl = composeEmailForClient(getSalesEmailPreviewClient({ meetingMode: 'in-person' }), 'reminder-24h').message;
  assert.match(day.html, /Gleder oss til møtet/);
  assert.match(day.html, /Vennlig påminnelse: møtet vårt starter om 24 timer\. 16\.09\.26 kl 14:00\./);
  assert.equal(day.html.includes('Online møte i morgen'), false);
  assert.match(dayIrl.html, /Gleder oss til møtet/);
  assert.equal(dayIrl.html.includes('Åpne i Kart'), false);
  assert.equal(online.icalEvent, undefined);
});

test('composed welcome mail has hosted images and an ICS invite', () => {
  const message = composeEmailForClient(getSalesEmailPreviewClient(), 'thank-you').message;
  assert.match(message.html, /https:\/\/asoldi\.com\/email\/sales\/hero-banner\.jpg/);
  assert.equal(message.html.includes('cid:'), false);
  assert.deepEqual(message.attachments, []);
  assert.equal(message.icalEvent?.filename, 'asoldi-online-mote.ics');
});

test('3-day reminder is only scheduled when the meeting is more than 3 days away', () => {
  const now = Date.parse('2026-09-14T08:00:00.000Z');
  const far = deriveReminderSchedule({ agreedTime: true, meetingAt: '2026-09-20T12:00:00.000Z' }, now);
  const soon = deriveReminderSchedule({ agreedTime: true, meetingAt: '2026-09-15T12:00:00.000Z' }, now);
  assert.ok(far.reminder3dAt);
  assert.ok(far.reminder24hAt);
  assert.ok(far.reminder1hAt);
  assert.equal(soon.reminder3dAt, '');
  assert.ok(soon.reminder24hAt);
  assert.ok(soon.reminder1hAt);
});

test('due reminders still send after the old 6-hour catch-up window, until the meeting starts', () => {
  const now = Date.parse('2026-09-19T14:00:00.000Z');
  const meetingAt = '2026-09-20T12:00:00.000Z';
  const overdue = '2026-09-17T12:00:00.000Z';
  assert.equal(salesReminderIsDue(overdue, '', { nowMs: now, meetingAt }), true);
  assert.equal(salesReminderIsDue(overdue, '2026-09-17T12:05:00.000Z', { nowMs: now, meetingAt }), false);
  assert.equal(salesReminderIsDue('2026-09-19T18:00:00.000Z', '', { nowMs: now, meetingAt }), false);
  assert.equal(salesReminderIsDue(overdue, '', { nowMs: Date.parse('2026-09-20T13:00:00.000Z'), meetingAt }), false);
});

test('thank-you attaches an ICS invite by default', () => {
  const message = composeEmailForClient(getSalesEmailPreviewClient(), 'thank-you').message;
  assert.equal(message.icalEvent?.filename, 'asoldi-online-mote.ics');
});

test('reminders do not attach an ICS invite', () => {
  const message = composeEmailForClient(getSalesEmailPreviewClient(), 'reminder-24h').message;
  assert.equal(message.icalEvent, undefined);
});

test('ICS organizer matches the salesperson From address', () => {
  const sender = buildSalesSender({
    name: 'Damian',
    fromEmail: 'damian@asoldi.com',
  });
  const invite = composeEmailForClient(getSalesEmailPreviewClient(), 'thank-you', null, { sender }).message.icalEvent;
  assert.match(invite.content, /ORGANIZER;.*mailto:damian@asoldi.com/);
});

test('sent email is one fluid layout with an 800px content column', () => {
  const html = renderResponsiveSalesEmailHtml({
    title: 'Møtet bekreftet',
    bodyHtml: '<p>Hei</p>',
    ctaUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    ctaLabel: 'Åpne Google Meet',
    assets: {
      heroDesktop: 'd.jpg',
      heroMobile: 'm.jpg',
      envelope: 'e.png',
      logoMark: 'l.png',
      customersBadge: 'b.png',
    },
  });
  assert.equal(html.includes('email-only-mobile'), false);
  assert.equal(html.includes('email-only-desktop'), false);
  assert.equal(html.includes('max-width:600px'), false);
  assert.match(html, /max-width:800px/);
  assert.match(html, /customers-badge/);
  assert.match(html, /width:320px/);
  assert.match(html, /#FFE8DA/);
  assert.match(html, /Åpne Google Meet/);
  assert.match(html, /Møtet bekreftet/);
});

test('sales sender identity is Name fra Asoldi with an asoldi.com address', () => {
  const sender = buildSalesSender({
    name: 'Alexander Berg',
    fromEmail: 'alexander@asoldi.com',
  });
  assert.equal(sender.name, 'Alexander');
  assert.equal(sender.fromEmail, 'alexander@asoldi.com');
  assert.equal(sender.from, 'Alexander fra Asoldi <alexander@asoldi.com>');
});

test('personal Gmail is not used as From; the Asoldi mailbox is derived from the name', () => {
  const sender = buildSalesSender({
    name: 'Alexander',
    fromEmail: 'alexander.sales@gmail.com',
  });
  assert.equal(sender.fromEmail, 'alexander@asoldi.com');
  assert.equal(sender.from, 'Alexander fra Asoldi <alexander@asoldi.com>');
});

test('asoldi.com username becomes the From mailbox and display name', () => {
  const sender = buildSalesSender({ username: 'alexander@asoldi.com' });
  assert.equal(sender.name, 'Alexander');
  assert.equal(sender.from, 'Alexander fra Asoldi <alexander@asoldi.com>');
});

test('generic admin From is replaced by the connected Google name', () => {
  const sender = buildSalesSender({
    name: 'Asoldi.com',
    fromEmail: 'contact@asoldi.com',
    username: 'asoldi.com',
    googleName: 'Damian',
  });
  assert.equal(sender.name, 'Damian');
  assert.equal(sender.from, 'Damian fra Asoldi <damian@asoldi.com>');
});

test('confirmation uses first names and leaves the business name unbolded', () => {
  const sender = buildSalesSender({
    name: 'Alexander Berg',
    fromEmail: 'alexander@asoldi.com',
  });
  const message = composeEmailForClient(getSalesEmailPreviewClient({
    contactPerson: 'Kari Nordmann',
    businessName: 'Bakeriet',
  }), 'thank-you', null, { sender }).message;
  assert.match(message.html, /Hei Kari,/);
  assert.match(message.html, /Mvh Alexander fra/);
  assert.match(message.html, /nettsiden til Bakeriet,/);
  assert.equal(message.html.includes('Alexander Berg'), false);
  assert.equal(message.html.includes('Kari Nordmann'), false);
  assert.equal(message.html.includes('<strong>Bakeriet</strong>'), false);
  assert.equal(message.from, 'Alexander fra Asoldi <alexander@asoldi.com>');
});

test('welcome merge fills the salesperson name in the body and From line', () => {
  const sender = buildSalesSender({
    name: 'Alexander',
    fromEmail: 'alexander@asoldi.com',
  });
  const composed = composeEmailForClient(getSalesEmailPreviewClient(), 'thank-you', {
    html: '<p>Mvh {{signerName}} fra Asoldi.com</p>',
    subject: 'Hei {{signerName}}',
  }, { sender });
  assert.equal(composed.values.signerName, 'Alexander');
  assert.equal(composed.message.from, 'Alexander fra Asoldi <alexander@asoldi.com>');
  assert.equal(composed.message.subject, 'Hei Alexander');
  assert.match(composed.message.html, /Mvh Alexander fra Asoldi.com/);
  assert.equal(composed.message.icalEvent?.filename, 'asoldi-online-mote.ics');
});

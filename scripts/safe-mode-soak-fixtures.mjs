/**
 * Seeded fixtures for the safe-mode soak: booked meetings with calendar records, Fireflies meetings
 * and handled inbox mail, all invented (example.invalid addresses, no real people or businesses).
 * They live in scripts/fixtures/safe-mode-soak/*.json and are turned into the data files the hub
 * reads, so the soak can drive the calendar, Fireflies and inbox guards on records that exist.
 *
 * Pure builders: nothing here reads the clock or the disk except loadSoakFixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOAK_FIXTURE_DIR = resolve(HERE, 'fixtures', 'safe-mode-soak');

const HOUR_MS = 60 * 60 * 1000;

/** Reads the three fixture files. Throws when one is missing, unreadable or lists nothing. */
export function loadSoakFixtures(dir = SOAK_FIXTURE_DIR) {
  const read = (name, key) => {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (error) {
      throw new Error(`soak fixture ${name} cannot be read: ${error?.message || error}`);
    }
    if (!Array.isArray(data?.[key]) || !data[key].length) throw new Error(`soak fixture ${name} lists no ${key}`);
    return data;
  };
  return {
    calendar: read('calendar-events.json', 'events'),
    fireflies: read('fireflies-calls.json', 'meetings'),
    inbox: read('inbox-messages.json', 'messages'),
  };
}

/** One sales client per calendar event: booked, with the calendar record a synced meeting carries. */
export function buildCalendarClients(calendar, now = new Date()) {
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
  const owner = String(calendar.owner || 'sales:soak-rep');
  return calendar.events.map((event, i) => {
    const online = event.mode === 'online';
    const startsAt = iso(Number(event.startsInHours || 24) * HOUR_MS);
    return {
      id: `soak-cal-client-${i + 1}`,
      product: 'asoldi',
      businessName: event.businessName,
      contactPerson: 'Example Guest',
      contactEmail: event.contactEmail,
      clientEmail: event.contactEmail,
      phone: '',
      city: 'Exampletown',
      ownerId: owner,
      status: 'booked',
      agreedTime: true,
      meetingAt: startsAt,
      meetingMode: online ? 'online' : 'in-person',
      meetingAddress: online ? '' : String(event.address || ''),
      createdAt: iso(-48 * HOUR_MS),
      updatedAt: iso(-30 * 60 * 1000),
      calendar: {
        eventId: `soak-event-${event.id}`,
        calendarId: 'primary',
        accountKey: owner,
        googleEmail: 'rep-one@example.invalid',
        organizerEmail: 'rep-one@example.invalid',
        meetLink: online ? String(event.meetLink || '') : '',
        syncedAt: iso(-24 * HOUR_MS),
      },
    };
  });
}

/** The google-calendar-tokens.json content: one made-up connected account for the fixture owner. */
export function buildCalendarTokens(calendar) {
  return {
    [String(calendar.owner || 'sales:soak-rep')]: {
      refresh_token: 'soak-not-a-real-token',
      googleEmail: 'rep-one@example.invalid',
      googleName: 'Example Rep',
    },
  };
}

/** The fireflies-meetings.json map: { meetingId: record }. */
export function buildFirefliesStore(fireflies, now = new Date()) {
  const store = {};
  for (const meeting of fireflies.meetings) {
    const startedAt = new Date(now.getTime() - Number(meeting.startsAgoHours || 1) * HOUR_MS).toISOString();
    store[meeting.meetingId] = {
      meetingId: meeting.meetingId,
      event: 'fixture',
      title: meeting.title,
      when: startedAt,
      startedAt,
      firstSeenAt: startedAt,
      durationMinutes: Number(meeting.durationMinutes || 0),
      recordedBy: '',
      hostEmail: 'rep-one@example.invalid',
      attendees: [],
      attendeeEmails: meeting.attendeeEmails || [],
      videoUrl: '',
      videoDownloadUrl: '',
      transcriptUrl: '',
      audioUrl: '',
      meetingLink: '',
      transcript: meeting.transcript || '',
      summary: meeting.summary || '',
      actionItems: '',
      keywords: [],
      at: startedAt,
    };
  }
  return store;
}

/** The inbox-bot.json content: handled mail the bot lists, nothing marked as to be sent. */
export function buildInboxStore(inbox, now = new Date()) {
  const mailbox = String(inbox.mailbox || 'alexander@asoldi.com');
  const items = inbox.messages.map((message) => ({
    id: `inbox-${message.id}`,
    kind: message.kind,
    mailbox,
    messageId: message.id,
    salesClientId: '',
    receivedAt: new Date(now.getTime() - Number(message.receivedHoursAgo || 1) * HOUR_MS).toISOString(),
    summary: message.summary || '',
    text: message.text || '',
    subject: message.subject || '',
    from: message.from,
    fileName: '',
    filePath: '',
    status: message.status || 'handled',
    notified: true,
    elements: [],
    stagedFiles: [],
    found: [],
    signedVerdict: '',
    signedScore: 0,
    signedReasons: [],
    inboundBytes: 0,
    originalBytes: 0,
  }));
  return { processed: {}, sources: {}, baselines: {}, items };
}

/**
 * Egress rows that mean mail left the machine: a mail or mailbox port, or a mail provider host.
 * The soak fails on any (the outbox is the only place mail may go).
 */
export function mailEgress(hosts = []) {
  const ports = new Set([25, 110, 143, 465, 587, 993, 995]);
  return hosts.filter((row) => ports.has(Number(row.port)) || /(^|\.)(smtp|imap|mail)\b|resend\.com|brevo\.com|sendgrid|mailgun|sendinblue/i.test(String(row.host || '')));
}

/**
 * Match a Fireflies meeting record to a sales client.
 *
 * Signals (additive score):
 *   attendee email == client.contactEmail                +70
 *   attendee email domain == client's website domain      +30
 *   meeting host == the client's sales rep (owner email)  +15
 *   meeting start within 3h of client.meetingAt           +25 (+35 within 45 min)
 *   contact person's name among attendee names            +25
 *   business name words in meeting title / attendee names +20
 *   archived / not-sold client                            -20
 *
 * confidence: high >= 70, medium >= 40, otherwise low (treated as unmatched).
 */

const GENERIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'live.no', 'yahoo.com', 'yahoo.no', 'icloud.com',
  'me.com', 'online.no', 'hotmail.no', 'outlook.no', 'protonmail.com', 'proton.me', 'msn.com',
]);
const STOP_WORDS = new Set(['as', 'asa', 'ans', 'da', 'og', 'the', 'and', 'med', 'for', 'av', 'i', 'på', 'enk', 'sa', 'nuf']);

function text(value = '') {
  return String(value ?? '').trim();
}

function lower(value = '') {
  return text(value).toLowerCase();
}

export function normalizeName(value = '') {
  return lower(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(value = '') {
  return normalizeName(value).split(' ').filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function extractEmails(values = []) {
  const out = new Set();
  const list = Array.isArray(values) ? values : [values];
  for (const entry of list) {
    const source = typeof entry === 'string' ? entry : text(entry?.email);
    const matches = String(source || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const email of matches) out.add(email.toLowerCase());
  }
  return [...out];
}

function domainOf(email = '') {
  const at = lower(email).lastIndexOf('@');
  return at === -1 ? '' : lower(email).slice(at + 1);
}

export function websiteDomainOf(value = '') {
  let host = lower(value);
  if (!host) return '';
  host = host.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return host;
}

function meetingStartMs(record = {}) {
  const iso = text(record.startedAt || record.dateString);
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  const num = Number(record.date);
  return Number.isFinite(num) && num > 0 ? num : NaN;
}

export function scoreMeetingAgainstClient(record = {}, client = {}, { ownerEmail = '' } = {}) {
  const reasons = [];
  let score = 0;

  const attendeeEmails = extractEmails([...(record.attendeeEmails || []), ...(record.attendees || [])]);
  const attendeeNames = (Array.isArray(record.attendees) ? record.attendees : []).map((entry) => normalizeName(String(entry).replace(/<[^>]*>/g, '')));
  const contactEmail = lower(client.contactEmail);
  if (contactEmail && attendeeEmails.includes(contactEmail)) {
    score += 70;
    reasons.push('Kontakt-e-post var deltaker');
  }

  const siteDomain = websiteDomainOf(client.websiteDomain);
  if (siteDomain && !GENERIC_MAIL_DOMAINS.has(siteDomain)) {
    if (attendeeEmails.some((email) => domainOf(email) === siteDomain || domainOf(email).endsWith(`.${siteDomain}`))) {
      score += 30;
      reasons.push('Deltaker med bedriftens domene');
    }
  }

  const host = lower(record.hostEmail);
  if (host && ownerEmail && host === lower(ownerEmail)) {
    score += 15;
    reasons.push('Møtet ble holdt av kundens selger');
  }

  const startMs = meetingStartMs(record);
  const bookedTimes = [
    client.agreedTime && client.meetingAt ? Date.parse(client.meetingAt) : NaN,
    Date.parse(client?.workshopAction?.dueAt || ''),
    Date.parse(client?.workshop?.iterationMeeting?.dueAt || ''),
  ].filter((ms) => Number.isFinite(ms));
  if (Number.isFinite(startMs) && bookedTimes.length) {
    const diffMin = Math.min(...bookedTimes.map((when) => Math.abs(startMs - when))) / 60_000;
    if (diffMin <= 45) {
      score += 35;
      reasons.push('Tidspunkt matcher avtalt møte');
    } else if (diffMin <= 180) {
      score += 25;
      reasons.push('Tidspunkt innen 3 timer fra avtalt møte');
    }
  }

  const contactTokens = nameTokens(client.contactPerson);
  if (contactTokens.length && attendeeNames.some((name) => contactTokens.every((token) => name.includes(token)))) {
    score += 25;
    reasons.push('Kontaktperson blant deltakerne');
  }

  const businessTokens = nameTokens(client.businessName);
  if (businessTokens.length) {
    const haystack = normalizeName([record.title, ...(record.attendees || [])].join(' '));
    const hits = businessTokens.filter((token) => haystack.includes(token));
    if (hits.length && hits.length >= Math.ceil(businessTokens.length / 2)) {
      score += 20;
      reasons.push('Bedriftsnavn i møtetittel/deltakere');
    }
  }

  if (client.status && client.status !== 'active') {
    score -= 20;
  }

  return { score, reasons };
}

/** True when this recording is the booked sales meeting, not a later calendar reminder. */
export function recordingMatchesSalesMeeting(client = {}, record = {}) {
  if (!client?.agreedTime || !text(client.meetingAt)) return false;
  const start = Date.parse(text(record?.startedAt || record?.dateString));
  const when = Date.parse(text(client.meetingAt));
  if (!Number.isFinite(start) || !Number.isFinite(when)) return false;
  return Math.abs(start - when) <= 3 * 60 * 60 * 1000;
}

export function confidenceForScore(score = 0) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * @param {object} record  Fireflies meeting record (buildFirefliesMeetingRecord)
 * @param {object[]} clients  sales clients
 * @param {{ ownerEmailById?: Record<string,string> }} options
 */
export function matchMeetingToClients(record = {}, clients = [], { ownerEmailById = {} } = {}) {
  const scored = (Array.isArray(clients) ? clients : [])
    .map((client) => {
      const ownerEmail = ownerEmailById[text(client.ownerId)] || '';
      const { score, reasons } = scoreMeetingAgainstClient(record, client, { ownerEmail });
      return { clientId: text(client.id), businessName: text(client.businessName), score, reasons, confidence: confidenceForScore(score) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  // Two clients tied at the top → ambiguous; drop to medium at most so a human confirms.
  if (best && scored[1] && scored[1].score === best.score && best.confidence === 'high') {
    best.confidence = 'medium';
    best.reasons = [...best.reasons, 'Flere kunder med samme score – bekreft manuelt'];
  }
  return {
    best: best && best.confidence !== 'low' ? best : null,
    candidates: scored.slice(0, 5),
  };
}

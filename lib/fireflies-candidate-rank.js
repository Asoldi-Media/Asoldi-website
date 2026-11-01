// Ranked client candidates for Fireflies recordings that no booked Meet room owns. The ranker never
// links: recordings go onto a card through a person's one-click link (an admin account key, which the
// backfill already treats as a person's link), or, only with fireflies.autoLink.enabled, through the
// guarded auto-link below. Title and names never decide a link.
//
// Signals (points):
//   attendee e-mail equals the client's contact e-mail                 +50
//   attendee domain equals the client's website domain (not free mail)  +30
//   recording within 3 h of a slot the hub booked for the client        +30
//   business-name token overlap of at least 0.8 in the title            +20
//   the contact person among the speakers                               +15
//   client marked not sold                                              -20
// Candidates at or above fireflies.candidateRanker.candidateMinScore are shown.
//
// Auto-link (fireflies.autoLink.enabled, default off) needs both an attendee e-mail exactly equal to
// one client's contact e-mail and a slot the hub booked for that client within slotWindowMinutes
// (30) of the recording start, and exactly one such client.
//
// Link audit: <dataDir>/fireflies-link-audit/<YYYY-MM>.jsonl, ids only, written while the ranker or
// auto-link is on; month files older than 24 months are dropped by the retention purge.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import {
  confidenceForScore,
  isProtectedHumanLink,
  matchMeetingToClients,
} from './fireflies-client-match.js';
import { clientMeetingSlots } from './fireflies-slots.js';
import { listStoredFirefliesMeetings, meetingRefForClient } from './fireflies-webhook.js';
import { firefliesRankSettings } from './privacy-settings.js';
import { registerStore } from './personal-data.js';

export const RANK_SIGNALS = Object.freeze({
  attendeeEmail: 50,
  attendeeDomain: 30,
  bookedSlot: 30,
  titleBusinessName: 20,
  contactSpeaker: 15,
  notSold: -20,
});
export const RANK_SLOT_WINDOW_MS = 3 * 60 * 60 * 1000;
export const TITLE_OVERLAP_MIN = 0.8;
export const AUTO_LINK_BY = 'email-slot';
export const LINK_AUDIT_DIR = 'fireflies-link-audit';
export const LINK_AUDIT_KEEP_MONTHS = 24;
export const AUTO_LINK_EVERY_MS = 10 * 60 * 1000;
export const MAX_CANDIDATES = 5;

export const FREE_MAIL_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.no', 'outlook.com', 'outlook.no', 'live.com', 'live.no',
  'msn.com', 'yahoo.com', 'yahoo.no', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'online.no', 'proton.me',
  'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'getmail.no', 'frisurf.no', 'start.no',
]);

const LEGAL_SUFFIXES = new Set(['as', 'asa', 'enk', 'da', 'ans', 'sa', 'nuf', 'ba', 'ltd', 'ab', 'aps', 'gmbh', 'og', 'and', 'the']);

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

/** Lower case, æ ø å folded, accents dropped, anything else a space. */
export function foldName(value = '') {
  return lower(value)
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value) {
  return foldName(value).split(' ').filter((token) => token.length >= 2);
}

function businessTokens(name) {
  return tokens(name).filter((token) => !LEGAL_SUFFIXES.has(token));
}

function emailDomain(email) {
  const value = lower(email);
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1) : '';
}

export function websiteHost(value = '') {
  const raw = lower(value);
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function startMs(record = {}) {
  const ms = Date.parse(text(record.startedAt || record.dateString));
  return Number.isFinite(ms) ? ms : NaN;
}

function attendeeEmailsOf(record = {}) {
  const out = new Set();
  for (const email of Array.isArray(record.attendeeEmails) ? record.attendeeEmails : []) {
    if (text(email).includes('@')) out.add(lower(email));
  }
  for (const line of Array.isArray(record.attendees) ? record.attendees : []) {
    const matches = String(line || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const email of matches) out.add(lower(email));
  }
  return [...out];
}

/** Speaker names from "Name: text" transcript lines and attendee names. */
export function speakersOf(record = {}) {
  const names = new Set();
  for (const line of String(record.transcript || '').split('\n')) {
    const match = /^([^:\n]{2,80}):\s/.exec(line);
    if (match) names.add(foldName(match[1]));
  }
  for (const entry of Array.isArray(record.attendees) ? record.attendees : []) {
    const name = String(entry || '').replace(/<[^>]*>/g, '').trim();
    if (name && !name.includes('@')) names.add(foldName(name));
  }
  names.delete('');
  return [...names];
}

function contactAmongSpeakers(contact, speakers) {
  const wanted = tokens(contact);
  if (!wanted.length) return false;
  return speakers.some((speaker) => {
    const have = new Set(speaker.split(' '));
    if (wanted.length === 1) return speaker === wanted[0];
    return wanted.every((token) => have.has(token));
  });
}

function titleOverlap(title, businessName) {
  const want = businessTokens(businessName);
  if (!want.length) return 0;
  const have = new Set(tokens(title));
  return want.filter((token) => have.has(token)).length / want.length;
}

function clientEmails(client = {}) {
  return [client.contactEmail, client.clientEmail].map(lower).filter((email) => email.includes('@'));
}

function excludedIds(record = {}) {
  return new Set((Array.isArray(record.excludedClientIds) ? record.excludedClientIds : []).map(text).filter(Boolean));
}

/** Every signal one client scores for one recording: { score, signals: { name: points } }. */
export function scoreClientForRecording(record = {}, client = {}, { internalDomains = ['asoldi.com'], slots = null, speakers = null } = {}) {
  const signals = {};
  const internal = new Set(internalDomains.map(lower));
  const attendees = attendeeEmailsOf(record).filter((email) => !internal.has(emailDomain(email)));
  const contacts = clientEmails(client);
  if (attendees.some((email) => contacts.includes(email))) signals.attendeeEmail = RANK_SIGNALS.attendeeEmail;
  const host = websiteHost(client.websiteDomain);
  if (host && !FREE_MAIL_DOMAINS.includes(host) && !internal.has(host)
    && attendees.some((email) => {
      const domain = emailDomain(email).replace(/^www\./, '');
      return domain === host && !FREE_MAIL_DOMAINS.includes(domain);
    })) {
    signals.attendeeDomain = RANK_SIGNALS.attendeeDomain;
  }
  const at = startMs(record);
  if (Number.isFinite(at)) {
    const list = slots || clientMeetingSlots(client);
    if (list.some((slot) => Number.isFinite(slot.startMs) && Math.abs(slot.startMs - at) <= RANK_SLOT_WINDOW_MS)) {
      signals.bookedSlot = RANK_SIGNALS.bookedSlot;
    }
  }
  if (titleOverlap(record.title, client.businessName) >= TITLE_OVERLAP_MIN) signals.titleBusinessName = RANK_SIGNALS.titleBusinessName;
  if (contactAmongSpeakers(client.contactPerson, speakers || speakersOf(record))) signals.contactSpeaker = RANK_SIGNALS.contactSpeaker;
  if (text(client.status) === 'not-sold') signals.notSold = RANK_SIGNALS.notSold;
  const score = Object.values(signals).reduce((sum, points) => sum + points, 0);
  return { score, signals };
}

const SIGNAL_REASONS = {
  attendeeEmail: 'Deltaker-e-post er kundens kontakt-e-post',
  attendeeDomain: 'Deltakerens domene er kundens nettsted',
  bookedSlot: 'Innen 3 timer fra et møte huben booket',
  titleBusinessName: 'Firmanavnet står i tittelen',
  contactSpeaker: 'Kontaktpersonen snakker i møtet',
  notSold: 'Kunden er markert som ikke solgt',
};

/**
 * Ranked candidates for one recording: [{ clientId, businessName, score, confidence, reasons, signals }],
 * best first, at most `limit`, only at or above `minScore`. Clients the recording was excluded from
 * are left out. Never links.
 */
export function rankRecordingCandidates(record = {}, clients = [], { minScore = 40, internalDomains = ['asoldi.com'], limit = MAX_CANDIDATES, slotsOf = null } = {}) {
  const excluded = excludedIds(record);
  const speakers = speakersOf(record);
  const rows = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    const id = text(client?.id);
    if (!id || excluded.has(id)) continue;
    const { score, signals } = scoreClientForRecording(record, client, {
      internalDomains,
      speakers,
      slots: typeof slotsOf === 'function' ? slotsOf(client) : null,
    });
    if (score < minScore || score <= 0) continue;
    rows.push({
      clientId: id,
      businessName: text(client.businessName),
      score,
      confidence: confidenceForScore(score),
      reasons: Object.keys(signals).map((key) => SIGNAL_REASONS[key]).filter(Boolean),
      signals,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.businessName.localeCompare(b.businessName) || a.clientId.localeCompare(b.clientId));
  return rows.slice(0, Math.max(1, limit));
}

function holderMap(clients = []) {
  const map = new Map();
  for (const client of clients) {
    for (const row of Array.isArray(client?.meetings) ? client.meetings : []) {
      const id = text(row?.meetingId);
      if (id && !id.toLowerCase().startsWith('live:') && !map.has(id)) map.set(id, text(client.id));
    }
  }
  return map;
}

/** A stored recording that is on no card and whose Meet room no client booked. */
export function recordingIsUnowned(record = {}, clients = [], { holders = null } = {}) {
  const id = text(record.meetingId);
  if (!id || id.toLowerCase().startsWith('live:')) return false;
  const map = holders || holderMap(clients);
  if (map.has(id)) return false;
  return !matchMeetingToClients(record, clients, { people: true }).best;
}

/** Candidates for every unowned stored recording: [{ meetingId, title, startedAt, candidates }]. */
export function candidatesForUnownedRecordings({ clients = [], meetings = null, settings } = {}) {
  const config = firefliesRankSettings(settings);
  const list = Array.isArray(meetings) ? meetings : listStoredFirefliesMeetings();
  const holders = holderMap(clients);
  const slotCache = new Map();
  const slotsOf = (client) => {
    if (!slotCache.has(client.id)) slotCache.set(client.id, clientMeetingSlots(client));
    return slotCache.get(client.id);
  };
  const out = [];
  for (const record of list) {
    if (!recordingIsUnowned(record, clients, { holders })) continue;
    out.push({
      meetingId: text(record.meetingId),
      title: text(record.title),
      startedAt: text(record.startedAt),
      candidates: rankRecordingCandidates(record, clients, {
        minScore: config.candidateMinScore,
        internalDomains: config.internalDomains,
        slotsOf,
      }),
    });
  }
  return out;
}

/**
 * Auto-link decision for one unowned recording: { clientId, reason } or { clientId: '', reason }.
 * Needs fireflies.autoLink.enabled, an attendee e-mail exactly equal to the client's contact e-mail,
 * and a slot the hub booked for that client within slotWindowMinutes. Exactly one client must pass.
 */
export function autoLinkDecision(record = {}, clients = [], { settings } = {}) {
  const config = firefliesRankSettings(settings);
  if (!config.autoLinkEnabled) return { clientId: '', reason: 'disabled' };
  const at = startMs(record);
  if (!Number.isFinite(at)) return { clientId: '', reason: 'no-start' };
  const internal = new Set(config.internalDomains);
  const attendees = attendeeEmailsOf(record).filter((email) => !internal.has(emailDomain(email)));
  if (!attendees.length) return { clientId: '', reason: 'no-attendee-email' };
  const excluded = excludedIds(record);
  const windowMs = config.slotWindowMinutes * 60 * 1000;
  const passing = [];
  for (const client of Array.isArray(clients) ? clients : []) {
    const id = text(client?.id);
    if (!id || excluded.has(id)) continue;
    if (!clientEmails(client).some((email) => attendees.includes(email))) continue;
    const slotFits = clientMeetingSlots(client).some((slot) => Number.isFinite(slot.startMs) && Math.abs(slot.startMs - at) <= windowMs);
    if (slotFits) passing.push(id);
  }
  if (passing.length === 1) return { clientId: passing[0], reason: 'email-and-slot' };
  return { clientId: '', reason: passing.length ? 'ambiguous' : 'no-match' };
}

// ---------------------------------------------------------------- audit (ids only)

function auditDir(dataDir) {
  return join(dataDir || getPersistentDataDir(), LINK_AUDIT_DIR);
}

/** The kind of actor behind a link, never the account itself. */
export function linkActorKind(linkedBy = '') {
  const value = text(linkedBy);
  if (isProtectedHumanLink(value)) return 'person';
  if (['meet-link', 'live-join', AUTO_LINK_BY].includes(value)) return value;
  return 'auto';
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/** Appends one ids-only line. Never throws; returns the row or null. */
export function appendFirefliesLinkAudit(entry = {}, { dataDir, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const meetingId = text(entry.meetingId);
  const clientId = text(entry.clientId);
  if (!ID_RE.test(meetingId)) return null;
  const row = {
    at: at.toISOString(),
    action: ['link', 'unlink', 'auto-link', 'candidate-link'].includes(entry.action) ? entry.action : 'link',
    meetingId,
    clientId: ID_RE.test(clientId) ? clientId : null,
    by: ['person', 'meet-link', 'live-join', AUTO_LINK_BY, 'auto', 'unknown'].includes(entry.by) ? entry.by : 'unknown',
  };
  if (Number.isFinite(entry.rank)) row.rank = Math.round(entry.rank);
  if (Number.isFinite(entry.score)) row.score = Math.round(entry.score);
  try {
    const dir = auditDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${row.at.slice(0, 7)}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  } catch {
    return null;
  }
}

/** Month files older than keepMonths: [{ file }]; removed unless dryRun. */
export function purgeFirefliesLinkAudit({ dryRun = true, dataDir, now = new Date(), keepMonths = LINK_AUDIT_KEEP_MONTHS } = {}) {
  const dir = auditDir(dataDir);
  if (!existsSync(dir)) return { items: [] };
  const at = now instanceof Date ? now : new Date(now);
  const cutoff = at.getUTCFullYear() * 12 + at.getUTCMonth() - keepMonths;
  const items = [];
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4})-(\d{2})\.jsonl$/.exec(name);
    if (!match) continue;
    if (Number(match[1]) * 12 + Number(match[2]) - 1 >= cutoff) continue;
    items.push({ file: `${LINK_AUDIT_DIR}/${name}` });
    if (!dryRun) rmSync(join(dir, name), { force: true });
  }
  return { items };
}

// ---------------------------------------------------------------- auto-link pass

/**
 * Auto-links the unowned recordings that pass autoLinkDecision, through `link(clientId, ref)` (the
 * hub's linker). Does nothing unless fireflies.autoLink.enabled. Returns { linked: [{ meetingId, clientId }] }.
 */
export function runAutoLinkPass({ settings, clients = [], meetings = null, link = null } = {}) {
  const config = firefliesRankSettings(settings);
  if (!config.autoLinkEnabled) return { linked: [], skipped: 'disabled' };
  if (typeof link !== 'function') return { linked: [], skipped: 'no-linker' };
  const list = Array.isArray(meetings) ? meetings : listStoredFirefliesMeetings();
  const holders = holderMap(clients);
  const linked = [];
  for (const record of list) {
    if (!recordingIsUnowned(record, clients, { holders })) continue;
    const decision = autoLinkDecision(record, clients, { settings });
    if (!decision.clientId) continue;
    const client = clients.find((entry) => text(entry.id) === decision.clientId);
    const match = {
      clientId: decision.clientId,
      businessName: text(client?.businessName),
      confidence: 'high',
      score: RANK_SIGNALS.attendeeEmail + RANK_SIGNALS.bookedSlot,
      reasons: ['Deltaker-e-post og bookingtid matcher kunden'],
      linkedBy: AUTO_LINK_BY,
    };
    // The linker's hook writes the audit line (lib/privacy-link-hooks.js), marked as an auto-link.
    const ref = { ...meetingRefForClient(record, match, { linkedBy: AUTO_LINK_BY }), audit: { action: 'auto-link', score: match.score } };
    const result = link(decision.clientId, ref);
    if (!result) continue;
    holders.set(text(record.meetingId), decision.clientId);
    linked.push({ meetingId: text(record.meetingId), clientId: decision.clientId });
  }
  return { linked };
}

/** Loop step: the guarded auto-link (fireflies.autoLink.enabled only). */
export const tickSteps = Object.freeze([
  {
    name: 'fireflies-autolink',
    order: 70,
    scope: 'global',
    everyMs: AUTO_LINK_EVERY_MS,
    async run(ctx = {}) {
      if (ctx.mode === 'off' || !firefliesRankSettings(ctx.settings).autoLinkEnabled) return { wrote: false };
      const { activeFirefliesLinker } = await import('./fireflies-linking.js');
      const linker = activeFirefliesLinker();
      const salesModule = ctx.sales || (await import('../data/sales.js'));
      const result = runAutoLinkPass({
        settings: ctx.settings,
        clients: salesModule.getSalesClients(),
        link: linker ? (clientId, ref) => linker.link(clientId, ref) : null,
      });
      return { wrote: result.linked.length > 0, ...result };
    },
  },
]);

registerStore({
  id: 'fireflies-link-audit',
  label: 'Logg over koblinger av møteopptak',
  dir: LINK_AUDIT_DIR,
  clientKey: 'clientId',
  retention: { rule: 'ids-24' },
  personalData: 'Meeting and client ids only',
  purpose: 'Tracing how recordings were linked to clients',
  legalBasis: 'Legitimate interest',
  processors: ['Hostinger'],
  export(clientId, ctx = {}) {
    const dir = auditDir(ctx.dataDir);
    if (!existsSync(dir)) return { records: [] };
    const records = [];
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      for (const row of readLines(join(dir, name))) if (row.clientId === clientId) records.push(row);
    }
    return { records };
  },
  erase(clientId, ctx = {}) {
    const { records } = this.export(clientId, ctx);
    return records.length
      ? { action: 'retain', records: records.length, files: [], reason: 'ids-only-log' }
      : { action: 'none', records: 0, files: [] };
  },
  purge(ctx = {}) {
    return purgeFirefliesLinkAudit({ dryRun: ctx.dryRun !== false, dataDir: ctx.dataDir, now: ctx.now });
  },
});

function readLines(path) {
  let body = '';
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return body.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

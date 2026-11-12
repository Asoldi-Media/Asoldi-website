import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { aiTaskConfigured } from '../llm-hooks.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';
import {
  ASOLDI_CHECKUP_FORMATS,
  ASOLDI_CLIENT_REQUESTS,
  ASOLDI_DECIDE_RULES,
  ASOLDI_INBOX_BRIEF,
} from '../../packages/suite/harness/asoldi/inbox.js';

const REQUESTS = new Set([...ASOLDI_CLIENT_REQUESTS, 'unclear', 'empty']);
const FORMATS = new Set(ASOLDI_CHECKUP_FORMATS);
const PERSON_REQUESTS = new Set(['unclear', 'other', 'contract']);
const CARD_CHANGES = new Set(['reschedule', 'reschedule_day', 'cancel', 'not_interested', 'call', 'not_now']);
const ACTIONABLE = new Set(['reschedule', 'reschedule_day', 'cancel', 'not_interested', 'call', 'not_now']);

const INTENT_TO_REQUEST = {
  sales_book: 'reschedule',
  workshop_book: 'reschedule',
  sales_propose: 'reschedule_day',
  workshop_propose: 'reschedule_day',
  sales_cancel: 'cancel',
  sales_call: 'call',
  workshop_call: 'call',
  walk_away: 'not_interested',
  gather: 'question',
};

const REQUEST_TO_INTENT = {
  reschedule: 'sales_book',
  reschedule_day: 'sales_propose',
  cancel: 'sales_cancel',
  call: 'sales_call',
  not_now: 'sales_call',
  not_interested: 'walk_away',
  question: 'gather',
  info: 'gather',
};

const WEEKDAY_NB = {
  monday: 'mandag',
  tuesday: 'tirsdag',
  wednesday: 'onsdag',
  thursday: 'torsdag',
  friday: 'fredag',
  saturday: 'lørdag',
  sunday: 'søndag',
};

export { ASOLDI_INBOX_BRIEF };

const STILL_NO_RE = /\b(?:ingen av (?:tidene|disse)|passer ikke noen|fortsatt ikke|fortsatt kan ikke|none of (?:those|these)|still can'?t)\b/i;
const CLAIM_RE = /\b(?:booket|flyttet|satt opp|avlyst|cancelled|booked|moved|set up)\b/i;
const KLOKKA_RE = /\bklokka\s+\d{1,2}\b|\b\d{1,2}-tiden\b|\b\d{1,2}\s*pm\b/i;
const PRICE_RE = /\b(?:kr|kroner|NOK)\b|,-/;
const DAY_TIME_RE = /\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b[^.]{0,48}?\bkl\.?\s*(\d{1,2})(?:[:.](\d{2}))?/gi;

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** Drop template leftovers the model still sometimes adds. */
export function polishInboxReply(text = '') {
  return String(text || '')
    .replace(/\s*Møtet er \d+\s*minutter\.?/gi, '')
    .replace(/\s*Det er et kort møte\s*\([^)]*\)[^.]*\./gi, '')
    .replace(/\s*\(?ca\.?\s*30\s*min(?:utter)?\)?\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

export function looksLikeWalkAway(text = '') {
  return /\b(?:avlys(?:e)? (?:alt|hele|det hele)|dropp(?:er)? (?:det|hele møtet|møtet)|glem (?:det|hele)|ikke interessert|ikke aktuelt|vi dropper|ingen vits|ikke noe møte|cancel (?:everything|the whole)|don't want(?: the)? meeting)\b/i
    .test(String(text || ''));
}

export function alreadyTriedReschedule(client = {}) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : []).some((row) => (
    !row?.doneAt && (row.presetKey === 'findMeetingTime' || /ny møtetid|finn møtetid/i.test(row.name || ''))
  ));
}

/** Card meeting time: the open meeting action wins over the legacy meetingAt field. */
export function clientMeetingAt(client = {}) {
  const row = (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .find((item) => !item?.doneAt && (item.presetKey === 'meeting' || item.presetKey === 'meetingBooked') && item.dueAt);
  return String(row?.dueAt || client?.meetingAt || '');
}

export function clientWriteSnapshot(client = {}, { now = new Date() } = {}) {
  const actions = (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .filter((row) => !row?.doneAt)
    .slice(0, 6)
    .map((row) => ({ name: row.name, format: row.format, dueAt: row.dueAt, note: compact(row.note).slice(0, 120) }));
  const meetingAt = clientMeetingAt(client);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const meetingLive = Boolean(meetingAt) && Date.parse(meetingAt) >= nowMs;
  return {
    businessName: client.businessName || '',
    contactPerson: client.contactPerson || '',
    meetingMode: client.meetingMode || 'online',
    meetingAt,
    meetingPassed: Boolean(meetingAt) && Date.parse(meetingAt) < nowMs,
    agreedTime: Boolean(client.agreedTime),
    contractSigned: Boolean(client.progression?.contractSigned),
    meetLink: meetingLive ? String(client.calendar?.meetLink || client.calendar?.confirmedMeetLink || '') : '',
    notes: compact(client.notes).slice(0, 400),
    openActions: actions,
  };
}

export function threadForDecision(message = {}) {
  const fresh = freshReplyText(message.text);
  const full = compact(message.text).slice(0, 2500);
  return {
    subject: String(message.subject || ''),
    fresh,
    thread: full === compact(fresh) ? '' : full,
  };
}

function osloClock(iso = '') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Oslo',
  }).format(new Date(ms));
}

function osloWeekdayNb(iso = '') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const en = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Europe/Oslo' }).format(new Date(ms)).toLowerCase();
  return WEEKDAY_NB[en] || '';
}

/** The model may only name times we actually offer; anything else drops its reply for the fallback. */
export function replyTimesMatch(text = '', slots = []) {
  const offered = new Set((Array.isArray(slots) ? slots : []).map(osloClock).filter(Boolean));
  for (const match of String(text || '').matchAll(/\bkl\.?\s*(\d{1,2})(?:[:.](\d{2}))?|\b(\d{1,2})[:.](\d{2})\b/gi)) {
    const hour = String(match[1] ?? match[3]).padStart(2, '0');
    const minute = String(match[2] ?? match[4] ?? '00').padStart(2, '0');
    if (!offered.has(`${hour}:${minute}`)) return false;
  }
  return true;
}

function allowedDayTimes(allowedTimes = []) {
  return (Array.isArray(allowedTimes) ? allowedTimes : []).flatMap((iso) => {
    const weekday = osloWeekdayNb(iso);
    const clock = osloClock(iso);
    return weekday && clock ? [{ weekday, clock }] : [];
  });
}

function namesUnofferedDayTime(text = '', allowedTimes = []) {
  const allowed = allowedDayTimes(allowedTimes);
  const re = new RegExp(DAY_TIME_RE.source, 'gi');
  let match;
  while ((match = re.exec(String(text || '')))) {
    const weekday = match[1].toLowerCase();
    const clock = `${String(match[2]).padStart(2, '0')}:${String(match[3] || '00').padStart(2, '0')}`;
    if (!allowed.some((row) => row.weekday === weekday && row.clock === clock)) return true;
  }
  return false;
}

function extractUrls(text = '') {
  return String(text || '').match(/\b(?:https?:\/\/|www\.)[^\s]+/gi) || [];
}

/** Drop a model reply that books, prices, or names a time we did not offer. */
export function replyIsSafe(text = '', { allowedTimes = [], meetLink = '' } = {}) {
  const raw = compact(text);
  if (!raw) return true;
  if (CLAIM_RE.test(raw) || KLOKKA_RE.test(raw) || PRICE_RE.test(raw)) return false;
  if (namesUnofferedDayTime(raw, allowedTimes)) return false;
  const allowedLink = compact(meetLink).replace(/\/$/, '');
  for (const url of extractUrls(raw)) {
    const cleaned = url.replace(/[).,]+$/, '').replace(/\/$/, '');
    if (allowedLink && cleaned === allowedLink) continue;
    return false;
  }
  return true;
}

function requestOf(value = {}) {
  if (REQUESTS.has(value.request)) return value.request;
  return INTENT_TO_REQUEST[value.intent] || '';
}

function sameFamily(left = '', right = '') {
  if (!left || !right) return !right;
  if (left === right) return true;
  const pair = `${left}|${right}`;
  return pair === 'cancel|not_interested' || pair === 'not_interested|cancel'
    || pair === 'question|call' || pair === 'call|question';
}

function applySafeReply(next, ai = {}, { allowedTimes = [], meetLink = '' } = {}) {
  const reply = polishInboxReply(ai.reply);
  if (reply.length >= 12 && reply.length <= 900 && replyIsSafe(reply, { allowedTimes, meetLink })) {
    next.reply = reply;
  }
  if (next.needsHuman) return;
  const subject = compact(ai.subject);
  if (subject.length >= 3 && subject.length <= 120) next.subject = subject;
}

export function mergeWriteDecision(heuristic = {}, ai = {}, extra = {}) {
  const allowedTimes = extra.allowedTimes || [];
  const meetLink = extra.meetLink || '';
  const client = extra.client || {};
  const hReq = requestOf(heuristic) || 'other';
  const next = {
    request: hReq,
    intent: heuristic.intent || REQUEST_TO_INTENT[hReq] || 'none',
    dueAt: heuristic.dueAt || '',
    day: heuristic.day || null,
    cancel: Boolean(heuristic.cancel),
    walkAway: hReq === 'not_interested',
    reply: '',
    checkupFormat: 'ring',
    checkupNote: '',
    reason: heuristic.reason || '',
    needsHuman: false,
  };
  if (heuristic.echo) {
    next.request = 'confirm';
    next.intent = 'none';
    return next;
  }
  if (heuristic.cancel && alreadyTriedReschedule(client) && !heuristic.dueAt && STILL_NO_RE.test(heuristic._fresh || '')) {
    next.request = 'not_interested';
    next.intent = 'walk_away';
    next.walkAway = true;
    next.cancel = true;
    next.dueAt = '';
  }
  const aiReq = requestOf(ai);
  if (PERSON_REQUESTS.has(next.request)) {
    next.needsHuman = true;
    const specific = Boolean(heuristic.reason && heuristic.reason !== 'unclear');
    if (!specific && ACTIONABLE.has(aiReq)) next.reason = `ai-sees:${aiReq}`;
    else next.reason = heuristic.reason || 'unclear';
  } else if (aiReq && !sameFamily(next.request, aiReq)) {
    next.needsHuman = true;
    next.reason = `ai-disagrees:${aiReq}`;
  }
  if (next.request === 'not_interested') next.walkAway = true;
  applySafeReply(next, ai, { allowedTimes, meetLink });
  if (FORMATS.has(ai.checkupFormat)) next.checkupFormat = ai.checkupFormat;
  next.checkupNote = compact(ai.checkupNote || ai.note).slice(0, 300);
  return next;
}

function allowedTimesOf(client, offerTimes) {
  const meeting = clientMeetingAt(client);
  const extra = Array.isArray(offerTimes) ? offerTimes : [];
  return [...new Set([meeting, ...extra].filter(Boolean))];
}

export async function decideInboxWrite({
  client,
  message,
  heuristic,
  history = [],
  now = new Date(),
  decideAi,
  offerTimes = '',
} = {}) {
  const fresh = freshReplyText(message?.text);
  const base = { ...heuristic, _fresh: fresh };
  const snapshot = clientWriteSnapshot(client, { now });
  const allowedTimes = allowedTimesOf(client, offerTimes);
  const opts = { client, allowedTimes, meetLink: snapshot.meetLink };
  const fallback = mergeWriteDecision(base, {}, opts);
  const runAi = decideAi || (aiTaskConfigured('inbox.decide', isDeepseekConfigured) ? callDecideAi : null);
  if (!runAi) return fallback;
  try {
    const ai = await runAi({
      client: snapshot,
      thread: threadForDecision(message),
      blob: inboxWriteBlob(message).slice(0, 2000),
      heuristic: { request: heuristic.request, intent: heuristic.intent, dueAt: heuristic.dueAt, cancel: heuristic.cancel },
      history: history.slice(-8),
      offerTimes,
      now: now instanceof Date ? now.toISOString() : String(now),
    }, { salesClientId: String(client?.id || '').trim() });
    const merged = mergeWriteDecision(base, ai || {}, opts);
    if (CARD_CHANGES.has(base.request) && !requestOf(ai || {}) && !merged.needsHuman) {
      return { ...merged, needsHuman: true, reason: 'ai-unavailable' };
    }
    return merged;
  } catch {
    if (CARD_CHANGES.has(base.request)) {
      return { ...fallback, needsHuman: true, reason: 'ai-unavailable' };
    }
    return fallback;
  }
}

/** `meta.salesClientId` is the matched sales client, for the ledger row (it is not sent to the model). */
async function callDecideAi(payload, meta = {}) {
  const salesClientId = String(meta?.salesClientId || '').trim();
  return deepseekChatJson({
    task: 'inbox.decide',
    ctx: salesClientId ? { salesClientId } : undefined,
    temperature: 0.3,
    maxTokens: 600,
    system: `${ASOLDI_INBOX_BRIEF}

${ASOLDI_DECIDE_RULES}`,
    user: JSON.stringify(payload),
  });
}

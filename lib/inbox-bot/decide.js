import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';
import { looksLikeCallFollowup } from '../workshop-time-parse.js';
import {
  ASOLDI_CHECKUP_FORMATS,
  ASOLDI_DECIDE_RULES,
  ASOLDI_INBOX_BRIEF,
  ASOLDI_REPLY_INTENTS,
} from '../../packages/suite/harness/asoldi/inbox.js';

const INTENTS = new Set(ASOLDI_REPLY_INTENTS);

const FORMATS = new Set(ASOLDI_CHECKUP_FORMATS);

export { ASOLDI_INBOX_BRIEF };

const WALK_AWAY_RE = /\b(?:avlys(?:e)? (?:alt|hele|det hele)|dropp(?:er)? (?:det|hele møtet|møtet)|glem (?:det|hele)|ikke interessert|ikke aktuelt|vi dropper|ingen vits|ikke noe møte|cancel (?:everything|the whole)|don't want(?: the)? meeting)\b/i;
const STILL_NO_RE = /\b(?:ingen av (?:tidene|disse)|passer ikke noen|fortsatt ikke|fortsatt kan ikke|none of (?:those|these)|still can'?t)\b/i;

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
  return WALK_AWAY_RE.test(String(text || ''));
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
  return {
    businessName: client.businessName || '',
    contactPerson: client.contactPerson || '',
    meetingMode: client.meetingMode || 'online',
    meetingAt,
    meetingPassed: Boolean(meetingAt) && Date.parse(meetingAt) < nowMs,
    agreedTime: Boolean(client.agreedTime),
    contractSigned: Boolean(client.progression?.contractSigned),
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

export function mergeWriteDecision(heuristic = {}, ai = {}, { client = {} } = {}) {
  const next = {
    intent: heuristic.intent || 'none',
    dueAt: heuristic.dueAt || '',
    day: heuristic.day || null,
    cancel: Boolean(heuristic.cancel),
    walkAway: false,
    reply: '',
    subject: '',
    checkupFormat: 'ring',
    checkupNote: '',
  };
  const aiIntent = INTENTS.has(ai.intent) ? ai.intent : '';
  if (heuristic.unsure) {
    // Follow-up date comes from the client's own words; keep the heuristic call intent.
  } else if (looksLikeWalkAway(heuristic._fresh || '') || aiIntent === 'walk_away') {
    next.intent = 'walk_away';
    next.walkAway = true;
    next.cancel = true;
    next.dueAt = '';
  } else if (heuristic.cancel && alreadyTriedReschedule(client) && !heuristic.dueAt && STILL_NO_RE.test(heuristic._fresh || '')) {
    next.intent = 'walk_away';
    next.walkAway = true;
  } else if (aiIntent && aiIntent !== 'none' && !(heuristic.dueAt && aiIntent === 'walk_away')) {
    if (heuristic.dueAt && /_book$/.test(heuristic.intent)) {
      next.intent = heuristic.intent;
    } else if (/_call$/.test(aiIntent) && !/_call$/.test(heuristic.intent || '') && !looksLikeCallFollowup(heuristic._fresh || '')) {
      // "Hva gjelder dette?" is a question, not a call request: answer it instead of promising a call.
      next.intent = 'gather';
    } else if (aiIntent !== 'sales_book' && aiIntent !== 'workshop_book') {
      next.intent = aiIntent;
    }
  }
  if (next.intent === 'walk_away') next.walkAway = true;
  const reply = polishInboxReply(ai.reply);
  if (reply.length >= 12 && reply.length <= 900) next.reply = reply;
  const subject = compact(ai.subject);
  if (subject.length >= 3 && subject.length <= 120) next.subject = subject;
  if (FORMATS.has(ai.checkupFormat)) next.checkupFormat = ai.checkupFormat;
  next.checkupNote = compact(ai.checkupNote || ai.note).slice(0, 300);
  return next;
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
  const fallback = mergeWriteDecision(base, {}, { client });
  const runAi = decideAi || (isDeepseekConfigured() ? callDecideAi : null);
  if (!runAi) return fallback;
  try {
    const ai = await runAi({
      client: clientWriteSnapshot(client, { now }),
      thread: threadForDecision(message),
      blob: inboxWriteBlob(message).slice(0, 2000),
      heuristic: { intent: heuristic.intent, dueAt: heuristic.dueAt, cancel: heuristic.cancel },
      history: history.slice(-8),
      offerTimes,
      now: now instanceof Date ? now.toISOString() : String(now),
    });
    return mergeWriteDecision(base, ai || {}, { client });
  } catch {
    return fallback;
  }
}

async function callDecideAi(payload) {
  return deepseekChatJson({
    temperature: 0.3,
    maxTokens: 600,
    system: `${ASOLDI_INBOX_BRIEF}

${ASOLDI_DECIDE_RULES}`,
    user: JSON.stringify(payload),
  });
}

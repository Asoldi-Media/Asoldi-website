import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { freshReplyText, inboxWriteBlob } from './thread.js';

const INTENTS = new Set([
  'sales_book',
  'sales_propose',
  'sales_call',
  'workshop_book',
  'workshop_propose',
  'workshop_call',
  'walk_away',
  'gather',
  'none',
]);

const FORMATS = new Set(['sms', 'ring', 'email']);

export const ASOLDI_INBOX_BRIEF = `Asoldi er et norsk byrå som lager nettsider. Salg booker et kort online møte (kunden får 30 min, vi setter av 1 time i kalenderen) for å vise hvordan vi kan bygge nettsiden deres. Etter møtet: tilbud, kontrakt, workshop. Du svarer som Alexander fra Asoldi.
Mål, i denne rekkefølgen: 1) få en konkret møtetid, 2) samle logo/bilder/fakta til kundekortet, 3) hvis de ikke kan avtale nå — vis forståelse og si at vi tar en sjekk om ca. én uke (sms/ring/e-post).
Norsk, kort, menneskelig. Ikke mal-språk. Ikke finn på pris, dato eller at kontrakt er signert. Klokkeslett i svaret MÅ være blant tidene du får oppgitt.`;

const WALK_AWAY_RE = /\b(?:avlys(?:e)? (?:alt|hele|det hele)|dropp(?:er)? (?:det|hele møtet|møtet)|glem (?:det|hele)|ikke interessert|ikke aktuelt|vi dropper|ingen vits|ikke noe møte|cancel (?:everything|the whole)|don't want(?: the)? meeting)\b/i;
const STILL_NO_RE = /\b(?:ingen av (?:tidene|disse)|passer ikke noen|fortsatt ikke|fortsatt kan ikke|none of (?:those|these)|still can'?t)\b/i;

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function looksLikeWalkAway(text = '') {
  return WALK_AWAY_RE.test(String(text || ''));
}

export function alreadyTriedReschedule(client = {}) {
  return (Array.isArray(client?.nextActions) ? client.nextActions : []).some((row) => (
    !row?.doneAt && (row.presetKey === 'findMeetingTime' || /ny møtetid|finn møtetid/i.test(row.name || ''))
  ));
}

export function clientWriteSnapshot(client = {}) {
  const actions = (Array.isArray(client?.nextActions) ? client.nextActions : [])
    .filter((row) => !row?.doneAt)
    .slice(0, 6)
    .map((row) => ({ name: row.name, format: row.format, dueAt: row.dueAt, note: compact(row.note).slice(0, 120) }));
  return {
    businessName: client.businessName || '',
    contactPerson: client.contactPerson || '',
    meetingMode: client.meetingMode || 'online',
    meetingAt: client.meetingAt || '',
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
  if (looksLikeWalkAway(heuristic._fresh || '') || aiIntent === 'walk_away') {
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
    } else if (aiIntent !== 'sales_book' && aiIntent !== 'workshop_book') {
      next.intent = aiIntent;
    }
  }
  if (next.intent === 'walk_away') next.walkAway = true;
  const reply = compact(ai.reply);
  if (reply.length >= 12 && reply.length <= 900) next.reply = reply;
  const subject = compact(ai.subject);
  if (subject.length >= 3 && subject.length <= 120) next.subject = subject;
  if (FORMATS.has(ai.checkupFormat)) next.checkupFormat = ai.checkupFormat;
  next.checkupNote = compact(ai.checkupNote || ai.note).slice(0, 240);
  return next;
}

export async function decideInboxWrite({
  client,
  message,
  heuristic,
  history = [],
  now = new Date(),
  decideAi,
} = {}) {
  const fresh = freshReplyText(message?.text);
  const base = { ...heuristic, _fresh: fresh };
  const fallback = mergeWriteDecision(base, {}, { client });
  const runAi = decideAi || (isDeepseekConfigured() ? callDecideAi : null);
  if (!runAi) return fallback;
  try {
    const ai = await runAi({
      client: clientWriteSnapshot(client),
      thread: threadForDecision(message),
      blob: inboxWriteBlob(message).slice(0, 2000),
      heuristic: { intent: heuristic.intent, dueAt: heuristic.dueAt, cancel: heuristic.cancel },
      history: history.slice(0, 8),
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

Svar JSON:
{
  "intent": "sales_book"|"sales_propose"|"sales_call"|"workshop_book"|"workshop_propose"|"workshop_call"|"walk_away"|"gather"|"none",
  "reply": "norsk e-posttekst, 2–8 setninger, du-form",
  "subject": "kort emne eller tom",
  "checkupFormat": "sms"|"ring"|"email",
  "checkupNote": "kort intern merknad"
}
intent: sales_book/workshop_book kun når kunden gir et nytt klokkeslett i FRESH (ikke i sitert tråd). sales_propose når de flytter/avlyser én tid og vi bør tilby nye. walk_away når de dropper hele møtet, er tydelig uinteresserte, eller har sagt nei til tider vi allerede har foreslått uten å gi en ny dag. gather når de sender fakta/logo-prat uten tid. none når det ikke trengs svar.
checkupFormat kun ved walk_away (hvordan vi følger opp om en uke).`,
    user: JSON.stringify(payload),
  });
}

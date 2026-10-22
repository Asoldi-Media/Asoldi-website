import {
  AFTER_SALE_GOAL,
  GOAL_LABELS,
  clientHasAssignedSalesRep,
  clientIsSalesWin,
  clientMeetingAtIso,
  confirmationSendGaps,
  decorateNextActions,
  getGoalActions,
  dayAfterAtTenIso,
  getVisibleNextActions,
  isAutoContractCheckup,
  isSsuSalesProduct,
  isoToDatetimeLocalOslo,
} from './sales-next-actions.js';
import { salesBookingFacts } from './sales-booking-facts.js';
import { offerLetterNeedsMeetingPick } from './offer-meetings.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Påminnelse turns red this long after its due time (09:00 → 09:30). */
export const REMINDER_LATE_GRACE_MS = 30 * MINUTE_MS;

/** Bekreftelse turns red this long after the meeting was booked. */
export const CONFIRMATION_LATE_MS = HOUR_MS;

/** A past meeting nobody marked stays in Møter this long, then moves to Venter møtebekreftelse. */
export const MISSED_MEETING_AFTER_MS = 72 * HOUR_MS;

/** The 72-hour rule only applies to meetings from this day (Oslo) on; older unmarked meetings stay as they were. */
export const MISSED_MEETING_AUTO_FROM_MS = Date.parse('2026-10-17T00:00:00+02:00');

/** No meeting time yet: the Møte row turns red this long after the booking. */
export const SET_MEETING_TIME_LATE_MS = HOUR_MS;

/** Klargjør tilbud is due this long after the meeting. */
export const OFFER_DUE_AFTER_MEETING_MS = 24 * HOUR_MS;

/** Ring for ny møtetid turns red this long after 10:00. */
export const MISSED_CALL_LATE_GRACE_MS = 30 * MINUTE_MS;

export const SALES_MISSED_LABELS = {
  noShow: 'Møtte ikke opp',
  skipped: 'Hoppet over',
  auto: 'Møtet ble ikke markert',
};

export const SALES_FOCUS_CATEGORIES = [
  { id: 'assign', label: 'Tildel selger', hint: 'Lytt til bookingen og velg en selger.', adminOnly: true },
  { id: 'confirm', label: 'Venter møtebekreftelse', hint: 'Sett møtetid. Neste handling først, ikke gammel backlog.' },
  { id: 'reminders', label: 'Påminnelser', hint: 'Send påminnelse-SMS til kunder med møte i morgen.' },
  { id: 'meetingsToday', label: 'Møter', hint: 'Les deg opp på kunden og hold møtet.' },
  { id: 'offer', label: 'Tilbud', hint: 'Møtet er holdt. Neste steg er å sende tilbud.' },
  { id: 'signature', label: 'Venter signering', hint: 'Tilbudet er sendt. Følg opp til kontrakten er signert.' },
  { id: 'won', label: 'Solgt', hint: 'Oppfølging og mersalg for kunder som har signert.' },
];

export const SALES_FOCUS_CATEGORY_IDS = SALES_FOCUS_CATEGORIES.map((category) => category.id);

/** Categories shown to this login; Tildel selger is admin only. */
export function salesFocusCategoriesFor({ isAdmin = false } = {}) {
  return SALES_FOCUS_CATEGORIES.filter((category) => isAdmin || !category.adminOnly);
}

/** Playbook steps that are not stored action rows; they show as fixed rows in the action list. */
export const FIXED_PLAYBOOK_STEP_IDS = [
  'confirmation',
  'readUp',
  'missedCall',
  'productNotes',
  'sendOffer',
  'offerContractLink',
  'offerLetterReview',
  'contractSigned',
];

export function fixedRowId(stepId) {
  return `fixed:${stepId}`;
}

export const PLAYBOOK_STEP_LABELS = {
  confirmation: 'Bekreftelse sendt',
  reminder: 'Påminnelse-SMS',
  readUp: 'Les deg opp på kunden',
  holdMeeting: 'Hold møtet',
  missedCall: 'Ring for ny møtetid',
  productNotes: 'Produktnotater',
  sendOffer: 'Klargjør tilbud',
  offerContractLink: 'Signer nå-lenke',
  offerLetterReview: 'Sjekk tilbudse-post',
  checkup: 'Checkup',
  contractSigned: 'Kontrakt signert',
};

/** Signer nå: contract is out, the Fireflies letter is not approved yet. */
export function waitingOnOfferLetter(client = {}) {
  return Boolean(client.progression?.offerSent)
    && text(client.offerSentContent) === 'contract'
    && !text(client.offerLetterApprovedAt);
}

function clientHasContactEmail(client = {}) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(client?.contactEmail));
}

function text(value) {
  return String(value ?? '').trim();
}

function parseMs(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : null;
}

function osloDayKey(ms) {
  if (!Number.isFinite(ms)) return '';
  return isoToDatetimeLocalOslo(new Date(ms).toISOString()).slice(0, 10);
}

function meetingDurationMs(client) {
  const minutes = Number(client?.meetingDurationMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * MINUTE_MS;
}

/** Website clients only; SSU has its own flow, Ikke solgt and Sekundær cards are off the board. */
function salesBoardClient(client = {}) {
  if (!client || typeof client !== 'object') return false;
  if (isSsuSalesProduct(client.product)) return false;
  const status = text(client.status);
  return status !== 'not-sold';
}

/** Board clients that are still being sold (won clients sit in Solgt instead). */
export function salesPlaybookEligible(client = {}) {
  return salesBoardClient(client) && !clientIsSalesWin(client);
}

export function clientHasProductNotes(client = {}) {
  const quote = client?.details?.meetingQuote;
  if (!quote || typeof quote !== 'object') return false;
  if (text(quote.productNotes) || text(quote.productGoal) || text(quote.identity)) return true;
  if (Array.isArray(quote.selected) && quote.selected.length) return true;
  return Array.isArray(quote.customSections) && quote.customSections.some((section) => text(section?.title) || text(section?.body));
}

function step(id, goalKey, fields = {}) {
  return {
    id,
    goalKey,
    label: PLAYBOOK_STEP_LABELS[id],
    done: false,
    doneAt: '',
    dueAt: '',
    state: 'waiting',
    detail: '',
    actionId: '',
    ...fields,
  };
}

function timedState(dueMs, nowMs, graceMs = 0) {
  if (dueMs == null) return 'waiting';
  if (nowMs < dueMs) return 'upcoming';
  if (nowMs <= dueMs + graceMs) return 'due';
  return 'overdue';
}

function meetingContext(client, nowMs) {
  const meetingIso = client?.agreedTime ? clientMeetingAtIso(client) : '';
  const meetingMs = parseMs(meetingIso);
  return {
    meetingIso: meetingMs == null ? '' : meetingIso,
    meetingMs,
    meetingEndMs: meetingMs == null ? null : meetingMs + meetingDurationMs(client),
    started: meetingMs != null && nowMs >= meetingMs,
    todayKey: osloDayKey(nowMs),
  };
}

/**
 * The meeting did not happen: the rep marked Møtte ikke opp or Skip for this meeting time, or it
 * passed 72 hours ago without being marked (meetings from 17 Oct 2026 on). A new meeting time ends it.
 * Null otherwise.
 */
export function salesMissedMeeting(client = {}, nowMs = Date.now()) {
  const progression = client.progression || {};
  if (progression.meetingHeld || progression.offerSent) return null;
  const meetingMs = meetingContext(client, nowMs).meetingMs;
  if (meetingMs == null) return null;
  const stored = client.salesPlaybook || {};
  const forThisMeeting = parseMs(stored.missedMeetingAt) === meetingMs;
  const marked = forThisMeeting && (stored.missedKind === 'noShow' || stored.missedKind === 'skipped');
  const markedMs = marked ? parseMs(stored.missedAt) : null;
  let kind = '';
  let atMs = null;
  if (marked && markedMs != null) {
    kind = stored.missedKind;
    atMs = markedMs;
  } else if (meetingMs >= MISSED_MEETING_AUTO_FROM_MS && nowMs - meetingMs > MISSED_MEETING_AFTER_MS) {
    kind = 'auto';
    atMs = meetingMs + MISSED_MEETING_AFTER_MS;
  } else {
    return null;
  }
  const calledAt = forThisMeeting ? text(stored.missedCalledAt) : '';
  const calledMs = parseMs(calledAt);
  return {
    kind,
    label: SALES_MISSED_LABELS[kind],
    at: new Date(atMs).toISOString(),
    callDueAt: dayAfterAtTenIso(atMs),
    calledAt,
    /** No new time after the call: ring again 10:00 two days later. */
    recallDueAt: calledMs == null ? '' : dayAfterAtTenIso(calledMs + 24 * HOUR_MS),
    undoable: kind !== 'auto',
  };
}

function pickRow(actions, predicate) {
  const rows = actions.filter(predicate);
  return rows.find((row) => !row.doneAt) || rows[0] || null;
}

function meetingSteps(client, actions, ctx, nowMs) {
  const progression = client.progression || {};
  const held = Boolean(progression.meetingHeld || progression.offerSent);
  const noMeeting = ctx.meetingMs == null;

  const thankYouAt = text(client.reminders?.thankYouSentAt);
  const confirmation = step('confirmation', 'meetingHeld');
  if (thankYouAt) {
    Object.assign(confirmation, { done: true, doneAt: thankYouAt, state: 'done' });
  } else if (held) {
    Object.assign(confirmation, { done: true, state: 'done', detail: 'Ikke sendt' });
  } else if (noMeeting) {
    confirmation.detail = 'Tid ikke satt';
  } else if (!clientHasAssignedSalesRep(client)) {
    confirmation.detail = 'Sendes når kunden har en selger';
  } else {
    const gaps = confirmationSendGaps(client);
    const bookedMs = parseMs(salesBookingFacts(client).bookedAt) ?? parseMs(client.createdAt);
    confirmation.dueAt = bookedMs == null ? '' : new Date(bookedMs + CONFIRMATION_LATE_MS).toISOString();
    confirmation.state = bookedMs != null && nowMs > bookedMs + CONFIRMATION_LATE_MS ? 'overdue' : 'due';
    confirmation.detail = gaps.length ? `Mangler ${gaps.join(', ')}` : 'Ikke sendt ennå';
  }

  const smsRow = pickRow(actions, (row) => row.presetKey === 'sms1h');
  const reminder = step('reminder', 'meetingHeld', { actionId: smsRow?.id || '' });
  if (smsRow?.doneAt) {
    Object.assign(reminder, { done: true, doneAt: smsRow.doneAt, dueAt: smsRow.dueAt || '', state: 'done' });
  } else if (held) {
    Object.assign(reminder, { done: true, state: 'done', detail: 'Møtet er holdt' });
  } else if (!smsRow || noMeeting) {
    reminder.detail = 'Tid ikke satt';
  } else {
    const dueMs = parseMs(smsRow.dueAt);
    const createdMs = parseMs(smsRow.createdAt);
    let state = timedState(dueMs, nowMs, REMINDER_LATE_GRACE_MS);
    if (state === 'overdue' && createdMs != null && dueMs != null && createdMs > dueMs) state = 'sendNow';
    Object.assign(reminder, { dueAt: smsRow.dueAt || '', state });
  }

  const readUpAt = text(client.salesPlaybook?.readUpAt);
  const readUp = step('readUp', 'meetingHeld');
  if (readUpAt) {
    Object.assign(readUp, { done: true, doneAt: readUpAt, state: 'done' });
  } else if (held) {
    Object.assign(readUp, { done: true, state: 'done', detail: 'Hoppet over' });
  } else if (noMeeting) {
    readUp.detail = 'Tid ikke satt';
  } else {
    readUp.dueAt = ctx.meetingIso;
    readUp.state = osloDayKey(ctx.meetingMs) <= ctx.todayKey ? 'due' : 'upcoming';
  }

  const meetingRow = pickRow(actions, (row) => row.presetKey === 'meeting');
  const holdMeeting = step('holdMeeting', 'meetingHeld', { dueAt: ctx.meetingIso, actionId: meetingRow?.id || '' });
  if (held) {
    Object.assign(holdMeeting, { done: true, state: 'done' });
  } else if (noMeeting) {
    const bookedMs = parseMs(salesBookingFacts(client).bookedAt) ?? parseMs(client.createdAt);
    holdMeeting.dueAt = bookedMs == null ? '' : new Date(bookedMs).toISOString();
    holdMeeting.state = bookedMs == null ? 'due' : timedState(bookedMs, nowMs, SET_MEETING_TIME_LATE_MS);
    holdMeeting.detail = 'Tid ikke satt';
  } else if (nowMs < ctx.meetingMs) {
    holdMeeting.state = 'upcoming';
  } else if (nowMs <= ctx.meetingEndMs) {
    holdMeeting.state = 'due';
    holdMeeting.detail = 'Møtet pågår';
  } else {
    holdMeeting.state = 'overdue';
    holdMeeting.detail = 'Marker møtet som holdt';
  }

  const missed = held || noMeeting ? null : salesMissedMeeting(client, nowMs);
  if (!missed) return [confirmation, reminder, readUp, holdMeeting];
  Object.assign(holdMeeting, { state: 'waiting', detail: missed.label });
  const missedCall = step('missedCall', 'meetingHeld', { detail: missed.label });
  const recallMs = parseMs(missed.recallDueAt);
  if (missed.calledAt && recallMs != null && nowMs < recallMs) {
    Object.assign(missedCall, {
      done: true,
      doneAt: missed.calledAt,
      dueAt: missed.recallDueAt,
      state: 'done',
      detail: 'Sett ny møtetid på Møte-raden. Ring igjen om 2 dager hvis ikke.',
    });
  } else if (missed.calledAt) {
    Object.assign(missedCall, {
      dueAt: missed.recallDueAt,
      state: timedState(recallMs, nowMs, MISSED_CALL_LATE_GRACE_MS),
      detail: 'Fortsatt ingen ny møtetid. Ring igjen.',
    });
  } else {
    Object.assign(missedCall, {
      dueAt: missed.callDueAt,
      state: timedState(parseMs(missed.callDueAt), nowMs, MISSED_CALL_LATE_GRACE_MS),
    });
  }
  return [confirmation, reminder, readUp, holdMeeting, missedCall];
}

function offerSteps(client, nowMs) {
  const progression = client.progression || {};
  const held = Boolean(progression.meetingHeld || progression.offerSent);
  const sent = Boolean(progression.offerSent);

  const productNotes = step('productNotes', 'offerSent');
  if (sent || clientHasProductNotes(client)) {
    Object.assign(productNotes, { done: true, state: 'done' });
  } else if (held) {
    productNotes.state = 'due';
    productNotes.detail = 'Skriv ned hva kunden trenger';
  } else {
    productNotes.detail = 'Skrives under møtet';
  }

  const sendOffer = step('sendOffer', 'offerSent');
  if (sent) {
    Object.assign(sendOffer, { done: true, doneAt: text(client.contractSentAt), state: 'done' });
  } else if (held) {
    const late = getGoalActions(client, 'offerSent').some((row) => {
      const dueMs = parseMs(row.dueAt);
      return !row.doneAt && dueMs != null && dueMs < nowMs;
    });
    const meetingMs = parseMs(clientMeetingAtIso(client));
    const dueMs = meetingMs == null ? null : meetingMs + OFFER_DUE_AFTER_MEETING_MS;
    sendOffer.dueAt = dueMs == null ? '' : new Date(dueMs).toISOString();
    sendOffer.state = late || (dueMs != null && nowMs > dueMs) ? 'overdue' : 'due';
  } else {
    sendOffer.detail = 'Etter møtet';
  }

  const rows = [productNotes, sendOffer];
  if (waitingOnOfferLetter(client)) {
    rows.push(step('offerContractLink', 'offerSent', {
      done: true,
      state: 'done',
      detail: 'Åpne preview med kontrakten åpen',
    }));
    const filled = Boolean(text(client.offerLetterFilledAt));
    const pickMeetings = !filled && offerLetterNeedsMeetingPick(client);
    rows.push(step('offerLetterReview', 'offerSent', {
      done: false,
      state: filled || pickMeetings ? 'due' : 'waiting',
      dueAt: filled || pickMeetings ? new Date(nowMs).toISOString() : '',
      detail: filled
        ? 'Se gjennom e-posten og trykk Ser bra ut'
        : pickMeetings
          ? 'Flere opptak. Velg hvilke som skal brukes, så skrives e-posten.'
          : 'Venter på transkript. E-posten skrives automatisk.',
    }));
  }
  return rows;
}

function contractSteps(client, actions, nowMs) {
  const progression = client.progression || {};
  const sent = Boolean(progression.offerSent);
  const signed = Boolean(progression.contractSigned);

  const checkupRow = pickRow(actions, isAutoContractCheckup);
  const checkup = step('checkup', 'contractSigned', { actionId: checkupRow?.id || '' });
  if (checkupRow?.doneAt) {
    Object.assign(checkup, { done: true, doneAt: checkupRow.doneAt, dueAt: checkupRow.dueAt || '', state: 'done' });
  } else if (signed) {
    Object.assign(checkup, { done: true, state: 'done' });
  } else if (!sent) {
    checkup.detail = 'Etter tilbudet';
  } else if (!checkupRow) {
    checkup.detail = 'Kommer 24 timer etter at kontrakten er sendt';
  } else {
    Object.assign(checkup, { dueAt: checkupRow.dueAt || '', state: timedState(parseMs(checkupRow.dueAt), nowMs) });
  }

  const contractSigned = step('contractSigned', 'contractSigned');
  if (signed) {
    Object.assign(contractSigned, { done: true, doneAt: text(client.contractSignedAt), state: 'done' });
  } else if (sent) {
    contractSigned.detail = 'Venter på kunden';
  }

  return [checkup, contractSigned];
}

/** Fixed checklist per goal. Rows the rep adds stay in Egne handlinger, not here. */
export function getSalesPlaybook(client = {}, nowMs = Date.now()) {
  const actions = decorateNextActions(client);
  const ctx = meetingContext(client, nowMs);
  const progression = client.progression || {};
  const goals = [
    { key: 'meetingHeld', done: Boolean(progression.meetingHeld || progression.offerSent), steps: meetingSteps(client, actions, ctx, nowMs) },
    { key: 'offerSent', done: Boolean(progression.offerSent), steps: offerSteps(client, nowMs) },
    { key: 'contractSigned', done: Boolean(progression.contractSigned), steps: contractSteps(client, actions, nowMs) },
  ].map((goal) => ({ ...goal, label: GOAL_LABELS[goal.key] }));
  const currentGoal = goals.find((goal) => !goal.done) || null;
  return {
    goals,
    currentGoalKey: currentGoal?.key || '',
    meetingAt: ctx.meetingIso,
  };
}

function findStep(playbook, id) {
  for (const goal of playbook.goals) {
    const found = goal.steps.find((entry) => entry.id === id);
    if (found) return found;
  }
  return null;
}

const FIXED_ROW_PLACEMENT = {
  confirmation: 'start',
  readUp: 'beforeMeeting',
  missedCall: 'end',
  productNotes: 'end',
  sendOffer: 'end',
  offerContractLink: 'end',
  offerLetterReview: 'end',
  contractSigned: 'end',
};

/**
 * Playbook steps that have no stored row, for the action list. `placement` says where they sit
 * among the goal's real rows: first, directly before the Møte row, or last.
 */
export function salesFixedRows(client = {}, nowMs = Date.now()) {
  if (!salesBoardClient(client)) return [];
  return getSalesPlaybook(client, nowMs).goals.flatMap((goal) => goal.steps
    .filter((playbookStep) => FIXED_PLAYBOOK_STEP_IDS.includes(playbookStep.id))
    .map((playbookStep) => ({
      ...playbookStep,
      id: fixedRowId(playbookStep.id),
      stepId: playbookStep.id,
      goalKey: goal.key,
      placement: FIXED_ROW_PLACEMENT[playbookStep.id],
    })));
}

/** Goal a stored row is listed under on the board; the auto Checkup sits under Kontrakt. */
export function boardRowGoalKey(action = {}) {
  return isAutoContractCheckup(action) ? 'contractSigned' : text(action.goalKey);
}

/** Done / total per goal, counting fixed rows and stored rows the action list shows. */
export function salesGoalRowCounts(client = {}, nowMs = Date.now()) {
  const counts = {};
  const add = (goalKey, done) => {
    if (!goalKey) return;
    const row = counts[goalKey] || (counts[goalKey] = { done: 0, total: 0 });
    row.total += 1;
    if (done) row.done += 1;
  };
  for (const row of salesFixedRows(client, nowMs)) add(row.goalKey, row.done);
  for (const action of decorateNextActions(client)) {
    if (action.presetKey === 'sendOffer') continue;
    add(boardRowGoalKey(action), Boolean(action.doneAt));
  }
  return counts;
}

function entry(client, category, fields = {}) {
  const state = fields.state || 'waiting';
  return {
    client,
    category,
    stepId: fields.stepId || '',
    focusRowId: fields.focusRowId || '',
    state,
    dueAt: fields.dueAt || '',
    overdue: state === 'overdue',
    sortMs: Number.isFinite(fields.sortMs) ? fields.sortMs : Number.POSITIVE_INFINITY,
    confirmRank: Number.isFinite(fields.confirmRank) ? fields.confirmRank : 2,
  };
}

function stepEntry(client, category, playbookStep, sortMs, extra = {}) {
  return entry(client, category, {
    stepId: playbookStep.id,
    focusRowId: FIXED_PLAYBOOK_STEP_IDS.includes(playbookStep.id) ? fixedRowId(playbookStep.id) : playbookStep.actionId,
    state: playbookStep.state,
    dueAt: playbookStep.dueAt,
    sortMs,
    ...extra,
  });
}

/** Solgt: the next open after-sale row (Oppfølging 1mnd, then upsells) decides the order. */
function wonEntry(client, nowMs) {
  const next = decorateNextActions(client)
    .filter((row) => !row.doneAt && row.goalKey === AFTER_SALE_GOAL)
    .map((row) => ({ row, dueMs: parseMs(row.dueAt) }))
    .sort((a, b) => (a.dueMs ?? Number.POSITIVE_INFINITY) - (b.dueMs ?? Number.POSITIVE_INFINITY))[0];
  if (!next) return entry(client, 'won', { stepId: AFTER_SALE_GOAL });
  return entry(client, 'won', {
    stepId: AFTER_SALE_GOAL,
    focusRowId: next.row.id,
    state: next.dueMs == null ? 'upcoming' : timedState(next.dueMs, nowMs, 24 * HOUR_MS),
    dueAt: next.row.dueAt || '',
    sortMs: next.dueMs,
  });
}

/**
 * Categories the client sits in right now. The goal chips decide: Møte open → Venter
 * møtebekreftelse / Påminnelser / Møter, Møte checked → Tilbud, Tilbud checked → Venter
 * signering, Kontrakt checked → Solgt. Venter møtebekreftelse holds everyone who still
 * needs a meeting time (never set, or past and no longer in Møter) and assigned
 * clients whose confirmation mail has not gone out. Møter and Påminnelser wait
 * until `thankYouSentAt` when the client has an email. No email still enters
 * both; confirmation and email reminders cannot send. Assigning a seller
 * auto-sends that mail when an email exists. A client can
 * sit in more than one category at once, e.g. a forgotten reminder next to Møter.
 * Admins see clients without a seller in Tildel selger.
 */
export function salesFocusEntries(client = {}, nowMs = Date.now(), { isAdmin = false } = {}) {
  if (!salesBoardClient(client)) return [];
  if (clientIsSalesWin(client)) return [wonEntry(client, nowMs)];
  const ctx = meetingContext(client, nowMs);

  if (isAdmin && !clientHasAssignedSalesRep(client)) {
    const bookedMs = parseMs(salesBookingFacts(client).bookedAt) ?? parseMs(client.createdAt);
    return [entry(client, 'assign', { stepId: 'assign', state: 'due', sortMs: ctx.meetingMs ?? bookedMs })];
  }

  const progression = client.progression || {};
  const playbook = getSalesPlaybook(client, nowMs);

  if (progression.offerSent) {
    const entries = [];
    const letter = findStep(playbook, 'offerLetterReview');
    if (letter && !letter.done) {
      entries.push(stepEntry(client, 'offer', letter, parseMs(letter.dueAt) ?? nowMs));
    }
    const checkup = findStep(playbook, 'checkup');
    if (checkup && !checkup.done && checkup.dueAt) {
      entries.push(stepEntry(client, 'signature', checkup, parseMs(checkup.dueAt)));
      return entries;
    }
    const followUp = decorateNextActions(client).find((row) => row.presetKey === 'signatureFollowUp' && !row.doneAt);
    const followUpMs = parseMs(followUp?.dueAt);
    if (followUp && followUpMs != null) {
      entries.push(entry(client, 'signature', {
        stepId: 'signatureFollowUp',
        focusRowId: followUp.id,
        state: timedState(followUpMs, nowMs),
        dueAt: followUp.dueAt,
        sortMs: followUpMs,
      }));
      return entries;
    }
    const signed = findStep(playbook, 'contractSigned');
    const nextOpen = decorateNextActions(client).find((row) => !row.doneAt && parseMs(row.dueAt) != null);
    const nextMs = parseMs(nextOpen?.dueAt) ?? parseMs(client.contractSentAt) ?? parseMs(client.updatedAt);
    entries.push(entry(client, 'signature', {
      stepId: signed?.id || 'contractSigned',
      focusRowId: signed?.focusRowId || nextOpen?.id || '',
      state: nextMs != null ? timedState(nextMs, nowMs) : 'waiting',
      dueAt: nextOpen?.dueAt || '',
      sortMs: nextMs,
    }));
    return entries;
  }

  if (progression.meetingHeld) {
    return [stepEntry(client, 'offer', findStep(playbook, 'sendOffer'), ctx.meetingMs ?? parseMs(client.updatedAt))];
  }

  if (ctx.meetingMs == null) {
    const holdMeeting = findStep(playbook, 'holdMeeting');
    return holdMeeting
      ? [stepEntry(client, 'confirm', holdMeeting, parseMs(holdMeeting.dueAt), { confirmRank: 0 })]
      : [];
  }

  const missedCall = findStep(playbook, 'missedCall');
  if (missedCall) {
    return [entry(client, 'confirm', {
      stepId: 'missedCall',
      focusRowId: fixedRowId('missedCall'),
      state: missedCall.done ? 'upcoming' : missedCall.state,
      dueAt: missedCall.dueAt,
      sortMs: ctx.meetingMs,
      confirmRank: 1,
    })];
  }

  if (clientHasContactEmail(client) && !text(client.reminders?.thankYouSentAt)) {
    const confirmation = findStep(playbook, 'confirmation');
    return confirmation
      ? [stepEntry(client, 'confirm', confirmation, ctx.meetingMs, { confirmRank: 2 })]
      : [];
  }

  const entries = [];

  const reminder = findStep(playbook, 'reminder');
  const reminderDueMs = parseMs(reminder?.dueAt);
  if (
    reminder
    && !reminder.done
    && !ctx.started
    && reminderDueMs != null
    && osloDayKey(reminderDueMs) <= ctx.todayKey
  ) {
    entries.push(stepEntry(client, 'reminders', reminder, reminderDueMs));
  }

  const recentlyPassed = ctx.meetingMs < nowMs && nowMs - ctx.meetingMs <= MISSED_MEETING_AFTER_MS;
  if (!ctx.started || recentlyPassed) {
    const readUp = findStep(playbook, 'readUp');
    const next = !ctx.started && readUp && !readUp.done ? readUp : findStep(playbook, 'holdMeeting');
    entries.push(stepEntry(client, 'meetingsToday', next, ctx.meetingMs));
  } else if (!entries.some((row) => row.category === 'confirm')) {
    const holdMeeting = findStep(playbook, 'holdMeeting');
    if (holdMeeting) {
      entries.push(stepEntry(client, 'confirm', holdMeeting, ctx.meetingMs, { confirmRank: 1 }));
    }
  }

  return entries;
}

function compareNames(a, b) {
  return text(a.client?.businessName).localeCompare(text(b.client?.businessName), 'nb');
}

/** Upcoming soonest first, then newest overdue. Fresh next-actions beat old backlog. */
function compareNextActionFirst(a, b) {
  if (a.overdue !== b.overdue) return a.overdue ? 1 : -1;
  if (a.sortMs !== b.sortMs) return a.overdue ? b.sortMs - a.sortMs : a.sortMs - b.sortMs;
  return compareNames(a, b);
}

function compareEntries(a, b) {
  if (a.category === 'meetingsToday' && b.category === 'meetingsToday') {
    if (a.overdue !== b.overdue) return a.overdue ? 1 : -1;
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    return compareNames(a, b);
  }
  if (a.category === 'confirm' || a.category === 'offer' || a.category === 'signature') {
    if (a.category === b.category) return compareNextActionFirst(a, b);
  }
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const aWaiting = a.state === 'waiting';
  if (aWaiting !== (b.state === 'waiting')) return aWaiting ? 1 : -1;
  if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
  return compareNames(a, b);
}

/** One queue per category. Confirm / Tilbud / Signering: next action first, not old backlog. */
export function groupSalesFocusQueues(clients = [], nowMs = Date.now(), { isAdmin = false } = {}) {
  const queues = Object.fromEntries(SALES_FOCUS_CATEGORY_IDS.map((id) => [id, []]));
  for (const client of Array.isArray(clients) ? clients : []) {
    for (const row of salesFocusEntries(client, nowMs, { isAdmin })) queues[row.category].push(row);
  }
  for (const id of SALES_FOCUS_CATEGORY_IDS) queues[id].sort(compareEntries);
  return queues;
}

/** When the next thing for this entry is due: its own step time, else the client's earliest open action. */
export function salesEntryNextDueMs(row = {}) {
  const own = parseMs(row.dueAt);
  if (own != null && row.category !== 'offer') return own;
  if (row.stepId === 'missedCall') return null;
  const times = getVisibleNextActions(row.client || {})
    .filter((action) => !action.doneAt)
    .map((action) => parseMs(action.dueAt))
    .filter((ms) => ms != null);
  if (own != null) times.push(own);
  return times.length ? Math.min(...times) : null;
}

/**
 * Time shown on a category button. Møter counts down to the next meeting that has not
 * started. The others show the oldest late item (`late`), else the most urgent next time (`at`).
 * Null when nobody in the queue has a time set.
 */
export function salesCategoryClock(queue = [], category = '', nowMs = Date.now()) {
  const rows = Array.isArray(queue) ? queue : [];
  const dues = rows.map(salesEntryNextDueMs).filter((ms) => ms != null);
  if (!dues.length) return null;
  if (category === 'meetingsToday') {
    const upcoming = dues.filter((ms) => ms > nowMs);
    if (upcoming.length) return { kind: 'until', atMs: Math.min(...upcoming) };
    const late = rows.filter((row) => row.overdue).map(salesEntryNextDueMs).filter((ms) => ms != null);
    if (late.length) return { kind: 'late', atMs: Math.min(...late) };
    return { kind: 'now', atMs: Math.max(...dues) };
  }
  const late = rows.filter((row) => row.overdue).map(salesEntryNextDueMs).filter((ms) => ms != null);
  if (late.length) return { kind: 'late', atMs: Math.min(...late) };
  return { kind: 'at', atMs: Math.min(...dues) };
}

/** First category with something red, else the first with anyone in it. */
export function defaultSalesFocusCategory(queues = {}, { isAdmin = false } = {}) {
  const ids = salesFocusCategoriesFor({ isAdmin }).map((category) => category.id);
  const withOverdue = ids.find((id) => (queues[id] || []).some((row) => row.overdue));
  if (withOverdue) return withOverdue;
  return ids.find((id) => (queues[id] || []).length) || ids[0];
}

export function normalizeSalesFocusCategory(value = '', { isAdmin = false } = {}) {
  const id = text(value);
  return salesFocusCategoriesFor({ isAdmin }).some((category) => category.id === id) ? id : '';
}

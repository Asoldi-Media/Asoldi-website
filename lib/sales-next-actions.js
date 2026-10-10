const HOUR_MS = 60 * 60 * 1000;

export const SALES_GOAL_KEYS_ASOLDI = ['meetingHeld', 'offerSent', 'contractSigned'];
export const SALES_GOAL_KEYS_SSU = ['meetingHeld', 'offerSent', 'contractSigned', 'paymentReceived'];

export const GOAL_LABELS = {
  meetingHeld: 'Møte',
  offerSent: 'Tilbud',
  contractSigned: 'Kontrakt',
  paymentReceived: 'Betaling mottatt',
  domainConnected: 'Domene koblet',
  live: 'Live',
  afterSale: 'Etter salg',
};

export const AFTER_SALE_GOAL = 'afterSale';

export const PRESET_LABELS = {
  meeting: 'Møte',
  meetingBooked: 'Møtet booket',
  findMeetingTime: 'Finn møte tidspunkt',
  sms24h: 'SMS 24h',
  sms1h: 'Påminnelse',
  call2h: 'Call 2h',
  sendOffer: 'Send tilbud',
  checkIn: 'Oppsjekk',
  upsell: 'Upsell',
  oppgrader: 'Oppgrader',
  oppfolging: 'Oppfølging',
  oppfolging1mnd: 'Oppfølging 1mnd',
  contractCheckup: 'Checkup',
  custom: 'Custom',
};

export const FOLLOW_UP_1M_NOTE = 'sjekk opp kundens opplevelse: spørr om review, også si ifra om det hadde vært mulig å selge nye tjenester. svarer de ikke send sms med lenke';
export const OFFER_CHECKIN_NAME = 'Oppsjekk sett';
export const CONTRACT_CHECKUP_NAME = 'Checkup';
export const SALES_ACTION_TIMEZONE = 'Europe/Oslo';
const MONTH_MS = 30 * 24 * HOUR_MS;

export const ACTION_FORMATS = ['email', 'sms', 'ring', 'mote', 'sms-ring'];

export const FORMAT_LABELS = {
  email: 'E-post',
  sms: 'SMS',
  ring: 'Ring',
  mote: 'Møte',
  'sms-ring': 'SMS/ring',
};

export function normalizeSalesMeetingMode(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'in-person' || raw === 'in_person' || raw === 'inperson' || raw === 'physical' || raw === 'irl' || raw === 'fysisk') {
    return 'in-person';
  }
  if (raw === 'online') return 'online';
  return '';
}

export function formatMeetingModeLabel(value = '') {
  return normalizeSalesMeetingMode(value) === 'in-person' ? 'IRL' : 'Online';
}

export const GOAL_PRESETS = {
  meetingHeld: ['meetingBooked', 'findMeetingTime', 'sms24h', 'call2h', 'custom'],
  offerSent: ['checkIn', 'custom'],
  contractSigned: ['custom'],
  paymentReceived: ['custom'],
  afterSale: ['upsell', 'oppgrader', 'oppfolging', 'oppfolging1mnd', 'custom'],
};

const RELATIVE_HOURS_BY_PRESET = {
  meeting: 0,
  meetingBooked: 0,
  sms24h: 24,
  sms1h: 24,
  call2h: 2,
};

const FORMAT_BY_PRESET = {
  meeting: 'mote',
  meetingBooked: 'mote',
  upsell: 'mote',
  oppgrader: 'mote',
  oppfolging: 'mote',
  oppfolging1mnd: 'ring',
  sms24h: 'sms',
  sms1h: 'sms',
  call2h: 'ring',
  sendOffer: 'email',
  checkIn: 'ring',
  findMeetingTime: 'ring',
  contractCheckup: 'sms-ring',
  custom: 'mote',
};

export const SMS_REMINDER_NOTE = 'send sms for å sjekke om kunde fortsatt kan møtes';

const PRESET_KEYS = new Set([
  'meeting',
  'meetingBooked',
  'findMeetingTime',
  'sms24h',
  'sms1h',
  'call2h',
  'sendOffer',
  'checkIn',
  'upsell',
  'oppgrader',
  'oppfolging',
  'oppfolging1mnd',
  'contractCheckup',
  'custom',
]);
const GOAL_KEYS = new Set([...SALES_GOAL_KEYS_SSU, AFTER_SALE_GOAL]);
const MAX_ACTION_NOTE_LENGTH = 1000;

function sanitizeActionNote(value = '') {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_ACTION_NOTE_LENGTH);
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function toIso(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

function parseSortIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makeActionId(prefix = 'na') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isSsuSalesProduct(product = '') {
  return String(product || '').trim().toLowerCase() === 'ssu';
}

export function getSalesGoalKeys(product = '') {
  return isSsuSalesProduct(product) ? [...SALES_GOAL_KEYS_SSU] : [...SALES_GOAL_KEYS_ASOLDI];
}

export function formatGoalLabel(key = '') {
  return GOAL_LABELS[key] || key;
}

export function formatPresetLabel(key = '') {
  return PRESET_LABELS[key] || key;
}

export function formatActionFormatLabel(key = '') {
  return FORMAT_LABELS[key] || '';
}

export function defaultFormatForPreset(presetKey = '') {
  return FORMAT_BY_PRESET[presetKey] || 'mote';
}

export function sanitizeActionFormat(value = '', presetKey = '') {
  const key = sanitizeText(value);
  if (ACTION_FORMATS.includes(key)) return key;
  return defaultFormatForPreset(presetKey);
}

export function relativeHoursForPreset(presetKey = '') {
  return Object.prototype.hasOwnProperty.call(RELATIVE_HOURS_BY_PRESET, presetKey)
    ? RELATIVE_HOURS_BY_PRESET[presetKey]
    : null;
}

export function suggestedDueAtForPreset(presetKey, client, nowMs = Date.now()) {
  const meetingMs = parseMs(client?.meetingAt);
  if (presetKey === 'sms24h' && meetingMs != null) return toIso(meetingMs - 24 * HOUR_MS);
  if (presetKey === 'sms1h' && meetingMs != null) {
    return toIso(meetingMs - relativeHoursForPreset('sms1h') * HOUR_MS);
  }
  if (presetKey === 'call2h' && meetingMs != null) return toIso(meetingMs - 2 * HOUR_MS);
  if (presetKey === 'oppfolging1mnd') return toIso(nowMs + MONTH_MS);
  if (presetKey === 'upsell' || presetKey === 'oppgrader' || presetKey === 'oppfolging') {
    return toIso(nowMs + HOUR_MS);
  }
  if ((presetKey === 'meeting' || presetKey === 'meetingBooked') && meetingMs != null) return toIso(meetingMs);
  if (presetKey === 'sendOffer') return toIso(nowMs + HOUR_MS);
  if (presetKey === 'checkIn') return nextDayAtNineAmIso(nowMs);
  return '';
}

function zonedYmd(ms, timeZone = SALES_ACTION_TIMEZONE) {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  const [year, month, day] = formatted.split('-').map((part) => Number(part));
  return { year, month, day };
}

function zonedDateTimeToUtcMs(year, month, day, hour, minute, timeZone = SALES_ACTION_TIMEZONE) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return utcGuess - (asIfUtc - utcGuess);
}

export function nextDayAtNineAmIso(nowMs = Date.now(), timeZone = SALES_ACTION_TIMEZONE) {
  const { year, month, day } = zonedYmd(nowMs, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return toIso(zonedDateTimeToUtcMs(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    9,
    0,
    timeZone,
  ));
}

export function offerCheckInActionId(clientId = '') {
  return `na-oppsjekk-sett-${sanitizeText(clientId) || 'client'}`;
}

export function isAutoOfferCheckIn(action = {}) {
  return Boolean(
    action
    && action.presetKey === 'checkIn'
    && action.goalKey === 'offerSent'
    && String(action.id || '').startsWith('na-oppsjekk-sett-')
  );
}

export function ensureOfferCheckInAction(actions = [], client = {}, nowMs = Date.now()) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const meetingHeld = Boolean(client.progression?.meetingHeld);
  const offerSent = Boolean(client.progression?.offerSent);
  const autoId = offerCheckInActionId(client.id);
  if (!meetingHeld || offerSent || clientIsSalesWin(client)) {
    return list.filter((action) => action.doneAt || !isAutoOfferCheckIn(action));
  }
  if (list.some((action) => !action.doneAt && action.presetKey === 'checkIn' && action.goalKey === 'offerSent')) {
    return list;
  }
  list.push(normalizeNextAction({
    id: autoId,
    goalKey: 'offerSent',
    presetKey: 'checkIn',
    name: OFFER_CHECKIN_NAME,
    note: '',
    format: 'ring',
    dueAt: nextDayAtNineAmIso(nowMs),
    createdAt: toIso(nowMs),
    relativeToMeetingHours: null,
    addToCalendar: false,
    calendarEventId: '',
  }));
  return list;
}

export function contractCheckupActionId(clientId = '') {
  return `na-contract-checkup-${sanitizeText(clientId) || 'client'}`;
}

export function isAutoContractCheckup(action = {}) {
  return Boolean(
    action
    && action.presetKey === 'contractCheckup'
    && String(action.id || '').startsWith('na-contract-checkup-')
  );
}

/** Checkup sits on Tilbud: 24h after the offer went out. It stays open after that goal is checked. */
export function ensureContractCheckupAction(actions = [], client = {}, nowMs = Date.now()) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const offerSent = Boolean(client.progression?.offerSent);
  if (!offerSent) {
    return list.filter((action) => action.doneAt || !isAutoContractCheckup(action));
  }
  if (list.some((action) => action.presetKey === 'contractCheckup')) return list;
  const sentMs = parseMs(client.contractSentAt);
  const baseMs = sentMs != null ? sentMs : nowMs;
  list.push(normalizeNextAction({
    id: contractCheckupActionId(client.id),
    goalKey: 'offerSent',
    presetKey: 'contractCheckup',
    name: CONTRACT_CHECKUP_NAME,
    note: '',
    format: 'sms-ring',
    dueAt: toIso(baseMs + 24 * HOUR_MS),
    createdAt: toIso(nowMs),
    relativeToMeetingHours: null,
    addToCalendar: false,
    sticky: false,
    calendarEventId: '',
  }));
  return list;
}

export function salesGoalFilledCount(client = {}) {
  return ['meetingHeld', 'offerSent', 'contractSigned'].filter((key) => client?.progression?.[key]).length;
}

/** Sending the full offer completes Møte (if it was still open) and Tilbud. */
export function applyOfferSentFromDelivery(client = {}, nowMs = Date.now()) {
  if (client?.progression?.offerSent) {
    return {
      progression: { ...(client.progression || {}) },
      nextActions: decorateNextActions(client),
      changed: false,
    };
  }
  const progression = {
    ...(client.progression || {}),
    meetingHeld: true,
    offerSent: true,
    step0AgreeMeetingTime: true,
  };
  const doneIso = toIso(nowMs);
  const keptActions = decorateNextActions(client)
    .map((action) => {
      if (progression[action.goalKey] && !action.doneAt && !isAutoContractCheckup(action)) {
        return { ...action, doneAt: doneIso, completedByGoal: true };
      }
      return action;
    })
    .filter((action) => action.doneAt || !isAutoOfferCheckIn(action));
  const withCheckup = ensureContractCheckupAction(
    keptActions,
    { ...client, progression, nextActions: keptActions },
    nowMs,
  );
  const nextActions = decorateNextActions({ ...client, progression, nextActions: withCheckup });
  return { progression, nextActions, changed: true };
}

export function presetNeedsMeeting(presetKey = '') {
  return presetKey === 'sms24h' || presetKey === 'call2h';
}

export function normalizeNextAction(raw = {}, fallbackGoalKey = 'meetingHeld') {
  const input = raw && typeof raw === 'object' ? raw : {};
  const presetKey = PRESET_KEYS.has(sanitizeText(input.presetKey)) ? sanitizeText(input.presetKey) : 'custom';
  const goalKey = GOAL_KEYS.has(sanitizeText(input.goalKey)) ? sanitizeText(input.goalKey) : fallbackGoalKey;
  const hasRelative = Object.prototype.hasOwnProperty.call(input, 'relativeToMeetingHours');
  const relativeRaw = input.relativeToMeetingHours;
  const relativeToMeetingHours = !hasRelative
    ? relativeHoursForPreset(presetKey)
    : relativeRaw === null || relativeRaw === ''
      ? null
      : Number.isFinite(Number(relativeRaw))
        ? Number(relativeRaw)
        : null;
  return {
    id: sanitizeText(input.id) || makeActionId(),
    goalKey,
    presetKey,
    name: sanitizeText(input.name) || formatPresetLabel(presetKey),
    note: sanitizeActionNote(input.note),
    format: sanitizeActionFormat(input.format, presetKey),
    dueAt: sanitizeText(input.dueAt),
    doneAt: sanitizeText(input.doneAt),
    createdAt: sanitizeText(input.createdAt) || new Date().toISOString(),
    relativeToMeetingHours: relativeToMeetingHours == null ? null : relativeToMeetingHours,
    sticky: Boolean(input.sticky),
    stickyAnchorId: sanitizeText(input.stickyAnchorId),
    stickyOffsetMs: Number.isFinite(Number(input.stickyOffsetMs)) ? Number(input.stickyOffsetMs) : null,
    sortIndex: parseSortIndex(input.sortIndex),
    addToCalendar: Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? Boolean(input.addToCalendar)
      : presetKey === 'meeting' || presetKey === 'meetingBooked' || presetKey === 'upsell' || presetKey === 'oppgrader' || presetKey === 'oppfolging',
    calendarEventId: sanitizeText(input.calendarEventId),
    meetLink: sanitizeText(input.meetLink),
    firefliesMeetingId: sanitizeText(input.firefliesMeetingId),
    firefliesInvitedAt: sanitizeText(input.firefliesInvitedAt),
    firefliesLiveJoinedAt: sanitizeText(input.firefliesLiveJoinedAt),
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
    firefliesLiveJoinedMeetLink: sanitizeText(input.firefliesLiveJoinedMeetLink),
    completedByGoal: Boolean(input.completedByGoal),
  };
}

/** Extra Møte + calendar toggle. The booked sales meeting (`presetKey === 'meeting'`) stays on confirmation send. */
export function isRecordedSalesAction(action = {}, { includeDone = true } = {}) {
  if (sanitizeText(action?.presetKey) === 'meeting') return false;
  if (sanitizeActionFormat(action?.format, action?.presetKey) !== 'mote') return false;
  if (!action?.addToCalendar) return false;
  if (!includeDone && sanitizeText(action?.doneAt)) return false;
  if (normalizeSalesMeetingMode(action?.meetingMode) === 'in-person') return false;
  return true;
}

export function recordedSalesActions(client = {}, { includeDone = true } = {}) {
  return decorateNextActions(client).filter((action) => isRecordedSalesAction(action, { includeDone }));
}

export function normalizeNextActions(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeNextAction(entry)).filter((entry) => entry.id);
}

export function applyRelativeDueAts(actions = [], meetingAt = '') {
  const meetingMs = parseMs(meetingAt);
  return (Array.isArray(actions) ? actions : []).map((action) => {
    if (action?.doneAt) return action;
    if (action?.relativeToMeetingHours == null || meetingMs == null) return action;
    return {
      ...action,
      dueAt: toIso(meetingMs - Number(action.relativeToMeetingHours) * HOUR_MS),
    };
  });
}

/** SMS 1h (relative to meeting) and explicit sticky both keep a fixed gap to another action. */
export function actionFollowsNeighbor(action = {}) {
  return Boolean(action?.sticky) || action?.relativeToMeetingHours != null;
}

export function isActionFollower(action = {}) {
  if (!action?.id || action.doneAt) return false;
  if (action.sticky && sanitizeText(action.stickyAnchorId)) return true;
  if (action.presetKey === 'meeting') return false;
  if (action.relativeToMeetingHours != null) return true;
  return false;
}

/** Every open action can be pinned, including Møte. Default stays off. */
export function canStickAction(action = {}) {
  return Boolean(action?.id) && !action.doneAt;
}

export function canReorderAction(action = {}) {
  if (!action?.id || action.doneAt) return false;
  if (isMeetingFlowAction(action)) return false;
  return !isActionFollower(action);
}

export function actionAnchorId(action = {}, actions = []) {
  if (action?.sticky && sanitizeText(action.stickyAnchorId)) return sanitizeText(action.stickyAnchorId);
  if (action?.relativeToMeetingHours != null && action.presetKey !== 'meeting') {
    const meeting = (Array.isArray(actions) ? actions : []).find((entry) => (
      entry?.presetKey === 'meeting'
      && entry.goalKey === action.goalKey
      && !entry.doneAt
    ));
    return sanitizeText(meeting?.id);
  }
  return '';
}

export function nextLaterAction(actions = [], action = {}) {
  const dueMs = parseMs(action?.dueAt);
  if (dueMs == null) return null;
  const live = (Array.isArray(actions) ? actions : [])
    .filter((entry) => entry?.id && entry.id !== action.id && !entry.doneAt && parseMs(entry.dueAt) != null)
    .slice()
    .sort(compareByDueAt);
  const laterSameGoal = live.find((entry) => entry.goalKey === action.goalKey && parseMs(entry.dueAt) > dueMs);
  if (laterSameGoal) return laterSameGoal;
  return live.find((entry) => parseMs(entry.dueAt) > dueMs) || null;
}

function bindStickyToNext(actions, action) {
  const anchor = nextLaterAction(actions, action);
  const anchorMs = parseMs(anchor?.dueAt);
  const dueMs = parseMs(action?.dueAt);
  if (!anchor || anchorMs == null || dueMs == null) return null;
  return {
    sticky: true,
    stickyAnchorId: anchor.id,
    stickyOffsetMs: anchorMs - dueMs,
    relativeToMeetingHours: null,
  };
}

function clearStickyFields(action = {}) {
  const wasSticky = Boolean(action.sticky);
  const presetRelative = relativeHoursForPreset(action.presetKey);
  return {
    ...action,
    sticky: false,
    stickyAnchorId: '',
    stickyOffsetMs: null,
    relativeToMeetingHours: wasSticky && presetRelative != null
      ? presetRelative
      : action.relativeToMeetingHours,
  };
}

/** Keep sticky actions at the stored gap before their anchor. Existing non-sticky times are left alone. */
export function applyStickyDueAts(actions = []) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const byId = new Map(list.map((action) => [action.id, action]));
  let changed = true;
  let guard = 0;
  while (changed && guard < list.length + 2) {
    changed = false;
    guard += 1;
    for (const action of list) {
      if (!action.sticky || action.doneAt) continue;
      const anchor = byId.get(sanitizeText(action.stickyAnchorId));
      const anchorMs = parseMs(anchor?.dueAt);
      const offset = Number(action.stickyOffsetMs);
      if (!anchor || anchor.doneAt || anchorMs == null || !Number.isFinite(offset)) continue;
      const nextDue = toIso(anchorMs - offset);
      if (nextDue !== action.dueAt) {
        action.dueAt = nextDue;
        changed = true;
      }
    }
  }
  return list;
}

function createdMs(action = {}) {
  return parseMs(action?.createdAt) || 0;
}

function sortIndexValue(action = {}) {
  const value = Number(action?.sortIndex);
  return Number.isFinite(value) ? value : null;
}

function compareByDueAt(a = {}, b = {}) {
  const aDone = a?.doneAt ? 1 : 0;
  const bDone = b?.doneAt ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;
  const aMs = parseMs(a?.dueAt);
  const bMs = parseMs(b?.dueAt);
  if (aMs == null && bMs == null) return createdMs(a) - createdMs(b);
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  if (aMs !== bMs) return aMs - bMs;
  return createdMs(a) - createdMs(b);
}

function compareActions(a = {}, b = {}) {
  const aDone = a?.doneAt ? 1 : 0;
  const bDone = b?.doneAt ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;
  const aIdx = sortIndexValue(a);
  const bIdx = sortIndexValue(b);
  if (aIdx != null && bIdx != null && aIdx !== bIdx) return aIdx - bIdx;
  if (aIdx != null && bIdx == null) return -1;
  if (aIdx == null && bIdx != null) return 1;
  return compareByDueAt(a, b);
}

function nextCreateSortIndex(actions = [], goalKey = '') {
  const indexes = (Array.isArray(actions) ? actions : [])
    .filter((action) => action.goalKey === goalKey && !action.doneAt && canReorderAction(action))
    .map((action) => sortIndexValue(action))
    .filter((value) => value != null);
  return (indexes.length ? Math.min(...indexes) : 0) - 1;
}

function ensureSortIndexes(actions = []) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const goalKeys = [...new Set(list.map((action) => action.goalKey))];
  for (const goalKey of goalKeys) {
    const free = list.filter((action) => (
      action.goalKey === goalKey && !action.doneAt && canReorderAction(action)
    ));
    const missing = free.filter((action) => sortIndexValue(action) == null);
    if (!missing.length) continue;
    const used = new Set(free.map((action) => sortIndexValue(action)).filter((value) => value != null));
    missing.sort(compareByDueAt);
    let next = 0;
    for (const action of missing) {
      while (used.has(next)) next += 1;
      action.sortIndex = next;
      used.add(next);
      next += 1;
    }
  }
  return list;
}

function packFollowerActions(actions = []) {
  const list = Array.isArray(actions) ? actions.slice() : [];
  const byId = new Map(list.map((action) => [action.id, action]));
  const placed = new Set();
  const result = [];

  function followersOf(anchorId) {
    return list
      .filter((action) => isActionFollower(action) && actionAnchorId(action, list) === anchorId)
      .sort(compareByDueAt);
  }

  function placeCluster(anchor, stack = new Set()) {
    if (!anchor || placed.has(anchor.id)) return;
    if (stack.has(anchor.id)) {
      placed.add(anchor.id);
      result.push(anchor);
      return;
    }
    stack.add(anchor.id);
    for (const follower of followersOf(anchor.id)) {
      if (follower.id === anchor.id) continue;
      placeCluster(follower, stack);
    }
    stack.delete(anchor.id);
    if (!placed.has(anchor.id)) {
      placed.add(anchor.id);
      result.push(anchor);
    }
  }

  const ordered = list.slice().sort(compareActions);
  for (const action of ordered) {
    if (placed.has(action.id)) continue;
    if (action.doneAt) {
      placed.add(action.id);
      result.push(action);
      continue;
    }
    if (isActionFollower(action)) {
      const anchor = byId.get(actionAnchorId(action, list));
      if (anchor && !anchor.doneAt) {
        placeCluster(anchor);
        continue;
      }
    }
    placeCluster(action);
  }
  for (const action of list) {
    if (!placed.has(action.id)) {
      placed.add(action.id);
      result.push(action);
    }
  }
  return result;
}

export function ensureMeetingNextAction(actions = [], client = {}) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const meetingHeld = Boolean(client.progression?.meetingHeld);
  if (meetingHeld) {
    return list.filter((action) => !(action.presetKey === 'meeting' && !action.doneAt));
  }

  const meetingId = `na-meeting-${sanitizeText(client.id) || 'client'}`;
  const scheduledDue = sanitizeText(client.agreedTime ? client.meetingAt : '');
  const index = list.findIndex((action) => action.presetKey === 'meeting');
  if (index >= 0) {
    const current = list[index];
    const stickyOn = Boolean(current.sticky) && Boolean(sanitizeText(current.stickyAnchorId));
    const dueAt = stickyOn ? (current.dueAt || scheduledDue || '') : (scheduledDue || current.dueAt || '');
    list[index] = {
      ...current,
      goalKey: 'meetingHeld',
      name: current.name || PRESET_LABELS.meeting,
      dueAt,
      relativeToMeetingHours: stickyOn ? null : (parseMs(dueAt) != null ? 0 : null),
      addToCalendar: current.addToCalendar !== false,
      format: current.format || 'mote',
      doneAt: '',
      sticky: stickyOn,
      stickyAnchorId: stickyOn ? sanitizeText(current.stickyAnchorId) : '',
      stickyOffsetMs: stickyOn && Number.isFinite(Number(current.stickyOffsetMs)) ? Number(current.stickyOffsetMs) : null,
    };
    return list;
  }

  list.push({
    id: meetingId,
    goalKey: 'meetingHeld',
    presetKey: 'meeting',
    name: PRESET_LABELS.meeting,
    note: '',
    format: 'mote',
    dueAt: scheduledDue,
    doneAt: '',
    createdAt: new Date().toISOString(),
    relativeToMeetingHours: parseMs(scheduledDue) != null ? 0 : null,
    sticky: false,
    stickyAnchorId: '',
    stickyOffsetMs: null,
    addToCalendar: true,
    calendarEventId: '',
  });
  return list;
}

export function osloWallClockToIso(year, month, day, hour = 0, minute = 0) {
  return toIso(zonedDateTimeToUtcMs(year, month, day, hour, minute, SALES_ACTION_TIMEZONE));
}

/** datetime-local value (YYYY-MM-DDTHH:mm) in Europe/Oslo, from a stored ISO instant. */
export function isoToDatetimeLocalOslo(value = '') {
  const ms = parseMs(value);
  if (ms == null) return '';
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: SALES_ACTION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const month = String(parts.month || '').padStart(2, '0');
  const day = String(parts.day || '').padStart(2, '0');
  const hour = String(parts.hour || '').padStart(2, '0');
  const minute = String(parts.minute || '').padStart(2, '0');
  return `${parts.year}-${month}-${day}T${hour}:${minute}`;
}

/** Parse a datetime-local value as Europe/Oslo wall clock, not the browser timezone. */
export function datetimeLocalOsloToIso(value = '') {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return '';
  return toIso(zonedDateTimeToUtcMs(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ));
}

function isDatetimeLocalValue(value = '') {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(String(value || '').trim());
}

function isStoredActionTime(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (isDatetimeLocalValue(raw)) return true;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw) && parseMs(raw) != null;
}

function actionTimeToIso(value = '') {
  if (isDatetimeLocalValue(value)) return datetimeLocalOsloToIso(value);
  return parseMs(value) != null ? sanitizeText(value) : '';
}

/** Keep the clock on dueAt. A datetime that landed in notes is promoted back to dueAt. */
export function resolveActionTimeFields(dueAt = '', note = '') {
  const cleanedNote = sanitizeActionNote(note);
  const fromDue = actionTimeToIso(dueAt);
  if (parseMs(fromDue) != null) {
    if (isStoredActionTime(cleanedNote)) {
      const noteAsIso = actionTimeToIso(cleanedNote);
      if (parseMs(noteAsIso) != null && Math.abs(parseMs(noteAsIso) - parseMs(fromDue)) < 60 * 1000) {
        return { dueAt: fromDue, note: '' };
      }
    }
    return { dueAt: fromDue, note: cleanedNote };
  }
  if (isStoredActionTime(cleanedNote)) {
    const fromNote = actionTimeToIso(cleanedNote);
    if (parseMs(fromNote) != null) return { dueAt: fromNote, note: '' };
  }
  return { dueAt: sanitizeText(dueAt), note: cleanedNote };
}

/** Monday 00:00 Oslo → next Monday 00:00 Oslo. weekOffset shifts by whole Oslo weeks. */
export function osloWeekRange(anchorMs = Date.now(), weekOffset = 0) {
  const { year, month, day } = zonedYmd(anchorMs);
  const noonMs = zonedDateTimeToUtcMs(year, month, day, 12, 0);
  const weekday = new Date(noonMs).getUTCDay();
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = new Date(Date.UTC(year, month - 1, day - daysFromMonday + (Number(weekOffset) || 0) * 7));
  const startYear = monday.getUTCFullYear();
  const startMonth = monday.getUTCMonth() + 1;
  const startDay = monday.getUTCDate();
  const startMs = zonedDateTimeToUtcMs(startYear, startMonth, startDay, 0, 0);
  const nextMonday = new Date(Date.UTC(startYear, startMonth - 1, startDay + 7));
  const endMs = zonedDateTimeToUtcMs(
    nextMonday.getUTCFullYear(),
    nextMonday.getUTCMonth() + 1,
    nextMonday.getUTCDate(),
    0,
    0
  );
  const days = [];
  for (let index = 0; index < 7; index += 1) {
    const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay + index));
    const monthPart = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dayPart = String(cursor.getUTCDate()).padStart(2, '0');
    days.push(`${cursor.getUTCFullYear()}-${monthPart}-${dayPart}`);
  }
  return { timeMin: toIso(startMs), timeMax: toIso(endMs), days, startMs, endMs };
}

export function osloDayKeyFromCalendarStart(start = '', allDay = false) {
  const raw = String(start || '').trim();
  if (allDay && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const local = isoToDatetimeLocalOslo(raw);
  return local ? local.slice(0, 10) : '';
}

export function groupCalendarEventsByOsloDay(events = [], days = []) {
  const buckets = {};
  for (const day of Array.isArray(days) ? days : []) buckets[day] = [];
  for (const event of Array.isArray(events) ? events : []) {
    const day = osloDayKeyFromCalendarStart(event?.start, Boolean(event?.allDay));
    if (!day || !Object.prototype.hasOwnProperty.call(buckets, day)) continue;
    buckets[day].push(event);
  }
  return (Array.isArray(days) ? days : []).map((date) => ({ date, events: buckets[date] || [] }));
}

export function osloMinutesFromMidnight(value = '') {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 0;
  const local = isoToDatetimeLocalOslo(raw);
  const match = String(local).match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Keep 07–20 visible so gaps are obvious; expand only when an event sits outside that window. */
export function salesCalendarHourSpan(events = []) {
  let startHour = 7;
  let endHour = 20;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.allDay) continue;
    const start = osloMinutesFromMidnight(event.start);
    const end = osloMinutesFromMidnight(event.end);
    if (start != null) startHour = Math.min(startHour, Math.floor(start / 60));
    if (end != null) endHour = Math.max(endHour, Math.ceil(end / 60));
  }
  startHour = Math.max(0, startHour);
  endHour = Math.min(24, Math.max(endHour, startHour + 1));
  return { startHour, endHour };
}

function timedEventsOverlap(left = {}, right = {}) {
  const leftStart = osloMinutesFromMidnight(left.start) || 0;
  const leftEnd = osloMinutesFromMidnight(left.end) ?? leftStart + 30;
  const rightStart = osloMinutesFromMidnight(right.start) || 0;
  const rightEnd = osloMinutesFromMidnight(right.end) ?? rightStart + 30;
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function layoutTimedCalendarEvents(events = [], { startHour = 7, hourHeight = 48 } = {}) {
  const timed = (Array.isArray(events) ? events : [])
    .filter((event) => event && !event.allDay)
    .sort((a, b) => (osloMinutesFromMidnight(a.start) || 0) - (osloMinutesFromMidnight(b.start) || 0));
  const columns = [];
  for (let index = 0; index < timed.length; index += 1) {
    const used = new Set();
    for (let prev = 0; prev < index; prev += 1) {
      if (timedEventsOverlap(timed[index], timed[prev])) used.add(columns[prev]);
    }
    let col = 0;
    while (used.has(col)) col += 1;
    columns[index] = col;
  }
  const maxCols = Math.max(1, ...(columns.map((col) => col + 1)));
  return timed.map((event, index) => {
    const startMin = osloMinutesFromMidnight(event.start) || 0;
    const endMin = osloMinutesFromMidnight(event.end) ?? startMin + 30;
    const durationMin = Math.max(endMin - startMin, 15);
    return {
      event,
      top: ((startMin - startHour * 60) / 60) * hourHeight,
      height: Math.max((durationMin / 60) * hourHeight, 18),
      leftPct: (columns[index] / maxCols) * 100,
      widthPct: 100 / maxCols,
    };
  });
}

export function normalizeMeetingAtSource(value = '') {
  const source = sanitizeText(value).toLowerCase();
  return source === 'sales' || source === 'myphoner' ? source : '';
}

/**
 * Once a rep (or admin) writes the meeting time on the action step, MyPhoner
 * must not snap it back to the lead's original booking.
 */
export function resolveMeetingAtOnMyphonerMerge(existing = {}, incomingMeetingAt = '') {
  const currentAt = sanitizeText(existing?.meetingAt);
  const incomingAt = sanitizeText(incomingMeetingAt);
  const source = normalizeMeetingAtSource(existing?.meetingAtSource);
  const keepStored = Boolean(currentAt) && (
    source === 'sales'
    || (!source && clientHasAssignedSalesRep(existing))
  );
  if (keepStored) {
    return {
      meetingAt: currentAt,
      agreedTime: existing?.agreedTime !== false,
      meetingAtSource: source || 'sales',
    };
  }
  if (incomingAt) {
    return {
      meetingAt: incomingAt,
      agreedTime: true,
      meetingAtSource: source === 'sales' ? 'sales' : 'myphoner',
    };
  }
  return {
    meetingAt: currentAt,
    agreedTime: Boolean(existing?.agreedTime) && Boolean(currentAt),
    meetingAtSource: source || '',
  };
}

export const NEW_SALES_ASSIGNMENT_MS = 12 * HOUR_MS;

export function assignmentStampForOwnerChange(previousOwnerId = '', nextOwnerId = '', nowIso = new Date().toISOString()) {
  const next = sanitizeText(nextOwnerId);
  const prev = sanitizeText(previousOwnerId);
  if (!clientHasAssignedSalesRep({ ownerId: next })) return {};
  if (prev === next) return {};
  return { assignedToRepAt: nowIso };
}

export function clientIsNewlyAssigned(client = {}, nowMs = Date.now()) {
  if (!clientHasAssignedSalesRep(client)) return false;
  const assignedMs = Date.parse(String(client?.assignedToRepAt || ''));
  if (!Number.isFinite(assignedMs)) return false;
  const age = nowMs - assignedMs;
  return age >= 0 && age < NEW_SALES_ASSIGNMENT_MS;
}

/** Named meeting-time repairs. Times are Europe/Oslo wall clock. */
export const MEETING_TIME_BACKFILL_TARGETS = [
  {
    id: 'pokebutikk',
    label: 'Pokebutikk',
    meetingAt: osloWallClockToIso(2026, 10, 1, 15, 0),
    match(client = {}) {
      return /pokebutikk/i.test(`${client.businessName || ''} ${client.contactPerson || ''}`);
    },
  },
  {
    id: 'terjesen',
    label: 'Deles Are Terjesen',
    meetingAt: osloWallClockToIso(2026, 10, 7, 15, 0),
    match(client = {}) {
      return /terjesen|deles\s*are/i.test(`${client.businessName || ''} ${client.contactPerson || ''}`);
    },
  },
];

export function ensureSmsReminderAction(actions = [], client = {}) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const hasSchedule = Boolean(client.agreedTime && client.meetingAt);
  const meetingHeld = Boolean(client.progression?.meetingHeld);
  if (meetingHeld || !hasSchedule) {
    return list.filter((action) => !(action.presetKey === 'sms1h' && !action.doneAt));
  }
  const index = list.findIndex((action) => action.presetKey === 'sms1h');
  if (index >= 0) {
    const current = list[index];
    if (!current.doneAt) {
      const stickyOn = Boolean(current.sticky) && Boolean(sanitizeText(current.stickyAnchorId));
      const keepOverride = !stickyOn && current.relativeToMeetingHours == null && parseMs(current.dueAt) != null;
      list[index] = {
        ...current,
        goalKey: 'meetingHeld',
        name: current.name || PRESET_LABELS.sms1h,
        note: current.note || SMS_REMINDER_NOTE,
        format: 'sms',
        relativeToMeetingHours: stickyOn ? null : (keepOverride ? null : relativeHoursForPreset('sms1h')),
        sticky: stickyOn,
        stickyAnchorId: stickyOn ? sanitizeText(current.stickyAnchorId) : '',
        stickyOffsetMs: stickyOn && Number.isFinite(Number(current.stickyOffsetMs)) ? Number(current.stickyOffsetMs) : null,
        addToCalendar: false,
      };
    }
    return list;
  }
  list.push({
    id: `na-sms1h-${sanitizeText(client.id) || 'client'}`,
    goalKey: 'meetingHeld',
    presetKey: 'sms1h',
    name: PRESET_LABELS.sms1h,
    note: SMS_REMINDER_NOTE,
    format: 'sms',
    dueAt: '',
    doneAt: '',
    createdAt: new Date().toISOString(),
    relativeToMeetingHours: relativeHoursForPreset('sms1h'),
    sticky: false,
    stickyAnchorId: '',
    stickyOffsetMs: null,
    addToCalendar: false,
    calendarEventId: '',
  });
  return list;
}

export function ensureWinFollowUpAction(actions = [], client = {}, nowMs = Date.now()) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  if (!clientIsSalesWin(client)) {
    return list.filter((action) => !(action.presetKey === 'oppfolging1mnd' && !action.doneAt));
  }
  if (list.some((action) => action.presetKey === 'oppfolging1mnd')) return list;
  list.push({
    id: `na-oppfolging1mnd-${sanitizeText(client.id) || 'client'}`,
    goalKey: AFTER_SALE_GOAL,
    presetKey: 'oppfolging1mnd',
    name: PRESET_LABELS.oppfolging1mnd,
    note: FOLLOW_UP_1M_NOTE,
    format: 'ring',
    dueAt: toIso(nowMs + MONTH_MS),
    doneAt: '',
    createdAt: toIso(nowMs),
    relativeToMeetingHours: null,
    addToCalendar: false,
    calendarEventId: '',
  });
  return list;
}

export function decorateNextActions(client = {}) {
  const normalized = normalizeNextActions(client.nextActions);
  const withMeeting = ensureMeetingNextAction(normalized, client);
  const withSms = ensureSmsReminderAction(withMeeting, client);
  const withFollowUp = ensureWinFollowUpAction(withSms, client);
  const withSticky = applyStickyDueAts(ensureSortIndexes(withFollowUp));
  const meetingAction = withSticky.find((action) => action.presetKey === 'meeting' && !action.doneAt);
  const meetingClock = sanitizeText(meetingAction?.dueAt) || sanitizeText(client.meetingAt);
  const withRelative = applyRelativeDueAts(withSticky, meetingClock);
  return packFollowerActions(applyStickyDueAts(withRelative));
}

export function getCurrentGoalKey(client = {}) {
  const keys = getSalesGoalKeys(client.product);
  return keys.find((key) => !client.progression?.[key]) || '';
}

export function getVisibleGoalKeys(client = {}) {
  const keys = getSalesGoalKeys(client.product);
  const current = getCurrentGoalKey(client);
  const visible = [];
  for (const key of keys) {
    if (client.progression?.[key] || key === current) visible.push(key);
    if (key === current) break;
  }
  return visible;
}

export function getFutureGoalKeys(client = {}) {
  const keys = getSalesGoalKeys(client.product);
  const visible = new Set(getVisibleGoalKeys(client));
  return keys.filter((key) => !visible.has(key));
}

export function getRemainingGoalCount(client = {}) {
  return getFutureGoalKeys(client).length;
}

function isMeetingFlowAction(action = {}) {
  return action?.presetKey === 'sendOffer';
}

export function getGoalActions(client = {}, goalKey = '') {
  return decorateNextActions(client).filter((action) => !action.doneAt && action.goalKey === goalKey && !isMeetingFlowAction(action));
}

/** Open Tilbud checkup stays on the list after that goal is checked, including on a sold card. */
export function getVisibleNextActions(client = {}) {
  const checkup = decorateNextActions(client).filter((action) => !action.doneAt && isAutoContractCheckup(action));
  const goalKey = clientIsSalesWin(client) ? AFTER_SALE_GOAL : getCurrentGoalKey(client);
  const own = goalKey ? getGoalActions(client, goalKey) : [];
  const seen = new Set(own.map((action) => action.id));
  return [...own, ...checkup.filter((action) => !seen.has(action.id))];
}

export function getActiveNextAction(client = {}) {
  return getVisibleNextActions(client)[0] || null;
}

function liveCalendarActions(client = {}) {
  return decorateNextActions(client).filter((action) => (
    !action.doneAt
    && !isMeetingFlowAction(action)
    && action.addToCalendar
    && parseMs(action.dueAt) != null
  ));
}

/**
 * Important contact point: any incomplete action with add-to-calendar on, even when a
 * reminder sits earlier in the list (e.g. SMS 1h before the meeting).
 */
export function getCalendarNextAction(client = {}) {
  const live = liveCalendarActions(client);
  if (clientIsSalesWin(client)) {
    return live.find((action) => action.goalKey === AFTER_SALE_GOAL) || null;
  }
  const currentGoal = getCurrentGoalKey(client);
  if (currentGoal) {
    const inGoal = live.find((action) => action.goalKey === currentGoal);
    if (inGoal) return inGoal;
  }
  return live[0] || null;
}

/** Booked meeting instant for the client card headline — not the next reminder. */
export function clientMeetingAtIso(client = {}) {
  const stored = sanitizeText(client?.meetingAt);
  if (parseMs(stored) != null) return stored;
  const actions = Array.isArray(client?.nextActions) ? client.nextActions : [];
  const meeting = actions.find((action) => (
    (action?.presetKey === 'meeting' || action?.presetKey === 'meetingBooked')
    && parseMs(action?.dueAt) != null
  ));
  return sanitizeText(meeting?.dueAt);
}

export function getClientNextActionMs(client = {}) {
  const action = getActiveNextAction(client);
  return parseMs(action?.dueAt);
}

function parseYmdParts(value = '') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sanitizeText(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function osloDayStartMs(parts) {
  return zonedDateTimeToUtcMs(parts.year, parts.month, parts.day, 0, 0, SALES_ACTION_TIMEZONE);
}

function osloNextDayStartMs(parts) {
  const noonMs = zonedDateTimeToUtcMs(parts.year, parts.month, parts.day, 12, 0, SALES_ACTION_TIMEZONE);
  return osloDayStartMs(zonedYmd(noonMs + 24 * HOUR_MS));
}

export function clientMatchesMeetingModeFilter(client = {}, modeFilter = '') {
  const wanted = normalizeSalesMeetingMode(modeFilter);
  if (!wanted) return true;
  const actual = normalizeSalesMeetingMode(client?.meetingMode) || 'online';
  return actual === wanted;
}

export function clientNextActionInDateRange(client = {}, fromDate = '', toDate = '') {
  let from = parseYmdParts(fromDate);
  let to = parseYmdParts(toDate);
  if (!from && !to) return true;
  const ms = getClientNextActionMs(client);
  if (ms == null) return false;
  if (from && to && osloDayStartMs(from) > osloDayStartMs(to)) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (from && ms < osloDayStartMs(from)) return false;
  if (to && ms >= osloNextDayStartMs(to)) return false;
  return true;
}

export function clientHasStartedSalesFlow(client = {}) {
  return Boolean(
    client.progression?.meetingHeld
    || client.progression?.offerSent
    || client.progression?.contractSigned
    || client.progression?.paymentReceived
    || (client.agreedTime && client.meetingAt)
  );
}

export function tilbudWasSent(client = {}) {
  if (client?.progression?.offerSent) return true;
  return decorateNextActions(client).some((action) => action.presetKey === 'sendOffer' && action.doneAt);
}

export function defaultAddToCalendar(presetKey = '', client = {}) {
  if (
    presetKey === 'meeting'
    || presetKey === 'meetingBooked'
    || presetKey === 'upsell'
    || presetKey === 'oppgrader'
    || presetKey === 'oppfolging'
  ) return true;
  if (presetKey === 'checkIn' && tilbudWasSent(client)) return true;
  return false;
}

export const RECENT_OVERDUE_MS = 48 * HOUR_MS;

export function laterSalesGoalsDone(progression = {}) {
  return Boolean(
    progression?.offerSent
    || progression?.contractSigned
    || progression?.paymentReceived
    || progression?.checkIn1
    || progression?.checkIn2
  );
}

export function clientIsSalesWin(client = {}) {
  if (sanitizeText(client.status) === 'not-sold') return false;
  if (isSsuSalesProduct(client.product)) {
    return Boolean(client.progression?.contractSigned || client.progression?.paymentReceived);
  }
  return Boolean(client.progression?.contractSigned);
}

export function applyMeetingHeldOrphanReset(client = {}) {
  const migrations = client.salesMigrations && typeof client.salesMigrations === 'object'
    ? { ...client.salesMigrations }
    : {};
  const progression = { ...(client.progression || {}) };
  let nextActions = Array.isArray(client.nextActions) ? client.nextActions.map((action) => ({ ...action })) : [];
  if (migrations.meetingHeldOrphansV1) {
    return { progression, nextActions, salesMigrations: migrations, changed: false };
  }
  let changed = false;
  if (progression.meetingHeld && !laterSalesGoalsDone(progression)) {
    progression.meetingHeld = false;
    progression.step0AgreeMeetingTime = false;
    nextActions = nextActions.map((action) => (
      action?.presetKey === 'meeting' ? { ...action, doneAt: '' } : action
    ));
    changed = true;
  }
  migrations.meetingHeldOrphansV1 = true;
  return { progression, nextActions, salesMigrations: migrations, changed };
}

export function classifyNextActionBucket(client = {}, nowMs = Date.now()) {
  if (clientIsSalesWin(client)) return 'win';
  const ms = getClientNextActionMs(client);
  if (ms == null) {
    return clientHasStartedSalesFlow(client) ? 'recentPastDue' : 'noNextAction';
  }
  if (ms >= nowMs) return 'upcoming';
  if (nowMs - ms <= RECENT_OVERDUE_MS) return 'recentPastDue';
  return 'pastDue';
}

export function groupSalesClientsByNextAction(clients = [], nowMs = Date.now()) {
  const upcoming = [];
  const recentPastDue = [];
  const pastDue = [];
  const noNextAction = [];
  for (const client of clients) {
    if (clientIsSalesWin(client)) continue;
    const bucket = classifyNextActionBucket(client, nowMs);
    if (bucket === 'upcoming') upcoming.push(client);
    else if (bucket === 'recentPastDue') recentPastDue.push(client);
    else if (bucket === 'pastDue') pastDue.push(client);
    else noNextAction.push(client);
  }
  const byMs = (client) => getClientNextActionMs(client) || 0;
  upcoming.sort((a, b) => byMs(a) - byMs(b));
  recentPastDue.sort((a, b) => byMs(a) - byMs(b));
  pastDue.sort((a, b) => byMs(a) - byMs(b));
  noNextAction.sort((a, b) =>
    String(a.businessName || '').localeCompare(String(b.businessName || ''), 'nb-NO', { sensitivity: 'base' })
  );
  return { recentPastDue, upcoming, pastDue, noNextAction };
}

export function inferMeetingHeld(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  if (Object.prototype.hasOwnProperty.call(value, 'meetingHeld')) {
    return Boolean(value.meetingHeld);
  }
  return Boolean(
    value.offerSent
    || value.contractSigned
    || value.checkIn1
    || value.checkIn2
    || value.paymentReceived
  );
}

export function salesProgressBlockedReason(client, key, { fastTrack = false } = {}) {
  const mapped = key === 'step0AgreeMeetingTime' ? 'meetingHeld' : key;
  if (mapped === 'offerSent' && !client?.progression?.meetingHeld) {
    return 'Marker møtet hatt først.';
  }
  if (mapped === 'contractSigned') {
    if (fastTrack) return '';
    if (!client?.progression?.meetingHeld) return 'Marker møtet hatt først.';
    if (!client?.progression?.offerSent) return 'Marker sendt tilbud først.';
  }
  if (mapped === 'paymentReceived' && !client?.progression?.contractSigned) {
    return 'Marker kontrakt signert først.';
  }
  return '';
}

export function salesProgressUncheckReason(client, key) {
  const mapped = key === 'step0AgreeMeetingTime' ? 'meetingHeld' : key;
  const keys = getSalesGoalKeys(client?.product);
  const index = keys.indexOf(mapped);
  if (index === -1) return '';
  const laterDone = keys.slice(index + 1).filter((entry) => client?.progression?.[entry]);
  if (laterDone.length) {
    return `Angre ${formatGoalLabel(laterDone[0])} først.`;
  }
  return '';
}

export function applyProgressionChange(client, key, value, { fastTrack = false, nowMs = Date.now() } = {}) {
  const mappedKey = key === 'step0AgreeMeetingTime' ? 'meetingHeld' : key;
  const writable = [
    'meetingHeld',
    'offerSent',
    'checkIn1',
    'checkIn2',
    'contractSigned',
    'paymentReceived',
    'domainConnected',
    'live',
  ];
  if (!writable.includes(mappedKey)) {
    return { error: 'Ugyldig steg.' };
  }
  if (value) {
    const blocked = salesProgressBlockedReason(client, mappedKey, { fastTrack });
    if (blocked) return { error: blocked };
  } else {
    const blocked = salesProgressUncheckReason(client, mappedKey);
    if (blocked) return { error: blocked };
  }

  const progression = { ...(client.progression || {}) };
  progression[mappedKey] = Boolean(value);
  if (fastTrack && mappedKey === 'contractSigned' && value) {
    progression.meetingHeld = true;
    progression.offerSent = true;
    progression.contractSigned = true;
  }
  progression.step0AgreeMeetingTime = Boolean(progression.meetingHeld);

  const doneIso = toIso(nowMs);
  let keptActions = decorateNextActions(client).map((action) => {
    if (progression[action.goalKey] && !action.doneAt && !isAutoContractCheckup(action)) {
      return { ...action, doneAt: doneIso, completedByGoal: true };
    }
    if (!progression[action.goalKey] && action.completedByGoal && !isAutoContractCheckup(action)) {
      return { ...action, doneAt: '', completedByGoal: false };
    }
    return action;
  });
  const nextClient = { ...client, progression, nextActions: keptActions };
  if (mappedKey === 'meetingHeld' && value) {
    keptActions = ensureOfferCheckInAction(keptActions, nextClient, nowMs);
  } else if (mappedKey === 'meetingHeld' && !value) {
    keptActions = keptActions.filter((action) => action.doneAt || !isAutoOfferCheckIn(action));
  }
  if (mappedKey === 'offerSent' && value) {
    keptActions = ensureContractCheckupAction(keptActions, { ...client, progression, nextActions: keptActions }, nowMs);
  } else if (mappedKey === 'offerSent' && !value) {
    keptActions = keptActions.filter((action) => action.doneAt || !isAutoContractCheckup(action));
  }
  const nextActions = decorateNextActions({
    ...client,
    progression,
    nextActions: keptActions,
  });

  return { progression, nextActions };
}

function dueMatchesSuggested(dueAt, suggestedAt) {
  const dueMs = parseMs(dueAt);
  const suggestedMs = parseMs(suggestedAt);
  if (dueMs == null || suggestedMs == null) return false;
  return Math.abs(dueMs - suggestedMs) < 60 * 1000;
}

export function applyNextActionMutation(client, patch = {}, nowMs = Date.now()) {
  const op = sanitizeText(patch.op || patch.action || 'create').toLowerCase();
  const currentGoal = getCurrentGoalKey(client);
  let actions = decorateNextActions(client);
  const extra = {};

  if (op === 'create') {
    const win = clientIsSalesWin(client);
    const goalKey = win ? AFTER_SALE_GOAL : (sanitizeText(patch.goalKey) || currentGoal);
    if (!win && (!goalKey || goalKey !== currentGoal)) {
      return { error: 'Neste handling kan bare settes på aktivt mål.' };
    }
    const presetKey = PRESET_KEYS.has(sanitizeText(patch.presetKey)) ? sanitizeText(patch.presetKey) : 'custom';
    if (!(GOAL_PRESETS[goalKey] || []).includes(presetKey)) {
      return { error: 'Denne handlingen hører ikke til dette målet.' };
    }
    if (presetNeedsMeeting(presetKey) && !(client.agreedTime && client.meetingAt)) {
      return { error: 'Sett avtalt møtetid før SMS 24h / Call 2h.' };
    }
    const name = sanitizeText(patch.name);
    const resolvedCreate = resolveActionTimeFields(patch.dueAt, patch.note);
    const dueAt = resolvedCreate.dueAt;
    if (!name) return { error: 'Navn på neste handling er påkrevd.' };
    if (!parseMs(dueAt)) return { error: 'Tid for neste handling er påkrevd.' };
    const suggested = suggestedDueAtForPreset(presetKey, client, nowMs);
    const relativeDefault = relativeHoursForPreset(presetKey);
    const keepRelative = relativeDefault != null && dueMatchesSuggested(dueAt, suggested);
    const addToCalendar = Object.prototype.hasOwnProperty.call(patch, 'addToCalendar')
      ? Boolean(patch.addToCalendar)
      : defaultAddToCalendar(presetKey, client);
    const created = normalizeNextAction({
      id: makeActionId(),
      goalKey,
      presetKey,
      name,
      note: resolvedCreate.note,
      format: sanitizeActionFormat(patch.format, presetKey),
      dueAt,
      createdAt: toIso(nowMs),
      relativeToMeetingHours: keepRelative ? relativeDefault : null,
      addToCalendar,
      sortIndex: nextCreateSortIndex(actions, goalKey),
    });
    actions = [...actions, created];
    if (patch.sticky && canStickAction(created)) {
      const bound = bindStickyToNext(actions, created);
      if (!bound) return { error: 'Sticky krever en handling etter denne i tid.' };
      actions[actions.length - 1] = { ...created, ...bound };
    }
    if (presetKey === 'meeting') {
      const createdMode = normalizeSalesMeetingMode(patch.meetingMode);
      if (createdMode) extra.meetingMode = createdMode;
    }
  } else if (op === 'update') {
    const actionId = sanitizeText(patch.id || patch.actionId);
    const index = actions.findIndex((entry) => entry.id === actionId);
    if (index === -1) return { error: 'Handlingen finnes ikke.' };
    const current = actions[index];
    const name = Object.prototype.hasOwnProperty.call(patch, 'name') ? sanitizeText(patch.name) : current.name;
    const incomingDue = Object.prototype.hasOwnProperty.call(patch, 'dueAt') ? patch.dueAt : current.dueAt;
    const incomingNote = Object.prototype.hasOwnProperty.call(patch, 'note') ? patch.note : current.note;
    const resolved = Object.prototype.hasOwnProperty.call(patch, 'dueAt') || Object.prototype.hasOwnProperty.call(patch, 'note')
      ? resolveActionTimeFields(incomingDue, incomingNote)
      : { dueAt: current.dueAt, note: current.note };
    const dueAt = resolved.dueAt;
    const note = resolved.note;
    const format = Object.prototype.hasOwnProperty.call(patch, 'format')
      ? sanitizeActionFormat(patch.format, current.presetKey)
      : current.format;
    if (!name) return { error: 'Navn på neste handling er påkrevd.' };
    if (!parseMs(dueAt)) {
      const modeOnlyMeeting = current.presetKey === 'meeting'
        && Object.prototype.hasOwnProperty.call(patch, 'meetingMode');
      if (!modeOnlyMeeting) return { error: 'Tid for neste handling er påkrevd.' };
    }
    const dueChanged = dueAt !== current.dueAt;
    const addToCalendar = Object.prototype.hasOwnProperty.call(patch, 'addToCalendar')
      ? Boolean(patch.addToCalendar)
      : Boolean(current.addToCalendar);
    const keepRelative = dueChanged
      ? dueMatchesSuggested(dueAt, suggestedDueAtForPreset(current.presetKey, client))
      : current.relativeToMeetingHours != null;
    let nextAction = {
      ...current,
      name,
      note,
      format,
      dueAt,
      addToCalendar: current.presetKey === 'meeting' ? true : addToCalendar,
      relativeToMeetingHours: keepRelative
        ? (relativeHoursForPreset(current.presetKey) ?? current.relativeToMeetingHours)
        : (dueChanged ? null : current.relativeToMeetingHours),
    };
    if (dueChanged && current.relativeToMeetingHours != null && nextAction.relativeToMeetingHours == null) {
      nextAction.sortIndex = nextCreateSortIndex(
        actions.filter((entry) => entry.id !== current.id),
        current.goalKey,
      );
    }
    if (dueChanged && current.sticky) {
      const anchor = actions.find((entry) => entry.id === current.stickyAnchorId);
      const anchorMs = parseMs(anchor?.dueAt);
      const nextMs = parseMs(dueAt);
      if (anchorMs != null && nextMs != null) {
        nextAction.stickyOffsetMs = anchorMs - nextMs;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sticky') && canStickAction(current)) {
      if (patch.sticky) {
        const bound = bindStickyToNext(actions.map((entry, i) => (i === index ? nextAction : entry)), nextAction);
        if (!bound) return { error: 'Sticky krever en handling etter denne i tid.' };
        nextAction = { ...nextAction, ...bound };
      } else {
        nextAction = clearStickyFields(nextAction);
      }
    }
    actions[index] = nextAction;
    if (current.presetKey === 'meeting') {
      const nextMode = Object.prototype.hasOwnProperty.call(patch, 'meetingMode')
        ? normalizeSalesMeetingMode(patch.meetingMode)
        : '';
      if (nextMode) extra.meetingMode = nextMode;
    }
    if (current.presetKey === 'meeting' && parseMs(dueAt)) {
      extra.agreedTime = true;
      extra.meetingAt = dueAt;
      extra.meetingAtSource = 'sales';
      actions[index].relativeToMeetingHours = 0;
      actions = actions.map((action) => (
        action.presetKey === 'sms1h' && !action.doneAt && action.relativeToMeetingHours != null
          ? {
              ...action,
              relativeToMeetingHours: relativeHoursForPreset('sms1h'),
              sticky: false,
              stickyAnchorId: '',
              stickyOffsetMs: null,
            }
          : action
      ));
    }
  } else if (op === 'complete' || op === 'uncomplete') {
    const actionId = sanitizeText(patch.id || patch.actionId);
    const current = actions.find((entry) => entry.id === actionId);
    if (!current) return { error: 'Handlingen finnes ikke.' };
    actions = actions.map((entry) => (
      entry.id === current.id
        ? { ...entry, doneAt: op === 'uncomplete' ? '' : toIso(nowMs) }
        : entry
    ));
    if (op === 'complete' && current.presetKey === 'meeting' && !client.progression?.meetingHeld) {
      const progressed = applyProgressionChange(
        { ...client, nextActions: actions },
        'meetingHeld',
        true,
        { nowMs },
      );
      if (progressed.error) return progressed;
      return {
        nextActions: progressed.nextActions,
        progression: progressed.progression,
        ...extra,
      };
    }
  } else if (op === 'delete') {
    const actionId = sanitizeText(patch.id || patch.actionId);
    const current = actions.find((entry) => entry.id === actionId);
    if (!current) return { error: 'Handlingen finnes ikke.' };
    if (current.presetKey === 'meeting') {
      return { error: 'Møtehandlingen kan ikke slettes. Sett møtetiden her.' };
    }
    if (current.presetKey === 'sms1h') {
      actions = actions.map((entry) => (
        entry.id === current.id ? { ...entry, doneAt: entry.doneAt || toIso(nowMs) } : entry
      ));
    } else {
      actions = actions.filter((entry) => entry.id !== actionId);
    }
  } else if (op === 'reorder') {
    const win = clientIsSalesWin(client);
    const goalKey = win ? AFTER_SALE_GOAL : (sanitizeText(patch.goalKey) || currentGoal);
    if (!win && (!goalKey || goalKey !== currentGoal)) {
      return { error: 'Neste handling kan bare flyttes på aktivt mål.' };
    }
    const orderedIds = (Array.isArray(patch.orderedIds) ? patch.orderedIds : [])
      .map((id) => sanitizeText(id))
      .filter(Boolean);
    const free = actions.filter((action) => (
      action.goalKey === goalKey && !action.doneAt && canReorderAction(action)
    ));
    const freeIds = new Set(free.map((action) => action.id));
    if (!orderedIds.length || orderedIds.length !== free.length || orderedIds.some((id) => !freeIds.has(id))) {
      return { error: 'Kan ikke flytte sticky-handlinger.' };
    }
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    actions = actions.map((action) => (
      rank.has(action.id) ? { ...action, sortIndex: rank.get(action.id) } : action
    ));
  } else {
    return { error: 'Ugyldig handling.' };
  }

  let nextClient = {
    ...client,
    ...extra,
    nextActions: actions,
  };
  let nextActions = decorateNextActions(nextClient);
  const meetingClock = stickyMeetingClock(nextClient, nextActions);
  if (meetingClock.meetingAt) {
    nextClient = { ...nextClient, ...meetingClock };
    nextActions = decorateNextActions(nextClient);
  }
  return {
    nextActions,
    ...extra,
    ...meetingClock,
  };
}

function stickyMeetingClock(client = {}, actions = []) {
  const meeting = (Array.isArray(actions) ? actions : []).find((action) => (
    action?.presetKey === 'meeting' && !action.doneAt && action.sticky
  ));
  const dueAt = sanitizeText(meeting?.dueAt);
  if (!dueAt || dueAt === sanitizeText(client.meetingAt)) return {};
  return { meetingAt: dueAt, agreedTime: true, meetingAtSource: 'sales' };
}

export function clientHasAssignedSalesRep(client = {}) {
  return String(client?.ownerId || '').startsWith('sales:');
}

export function clientNeedsConfirmationSend(client = {}) {
  return clientHasAssignedSalesRep(client) && !String(client?.reminders?.thankYouSentAt || '').trim();
}

export const SALES_PIPELINE_STATES = [
  {
    id: 'awaitingMeetingConfirm',
    label: 'Venter møtebekreftelse',
    hint: 'Møte booket, bekreftelse ikke sendt',
  },
  {
    id: 'upcomingMeeting',
    label: 'Kommende møter',
    hint: 'Bekreftet møte frem i tid',
  },
  {
    id: 'awaitingOfferSend',
    label: 'Venter kontraktsending',
    hint: 'Møtet hatt, tilbud ikke sendt',
  },
  {
    id: 'awaitingContract',
    label: 'Venter kontraktsignering',
    hint: 'Tilbud sendt, kontrakt ikke signert',
  },
  {
    id: 'win',
    label: 'Solgt',
    hint: 'Kontrakt signert',
  },
];

/** First-row choices in the Secondary popup, then the secondary-product row. */
export const SECONDARY_INTEREST_STATES = [
  { id: 'redesign', label: 'Redesign', group: 'primary' },
  { id: 'consulting', label: 'Consulting', group: 'primary' },
  { id: 'video', label: 'Videoproduksjon', group: 'secondary' },
  { id: 'email', label: 'E-post', group: 'secondary' },
  { id: 'social', label: 'Sosiale medier', group: 'secondary' },
];

const SECONDARY_INTEREST_ALIASES = {
  redesign: 'redesign',
  consulting: 'consulting',
  raadgivning: 'consulting',
  radgivning: 'consulting',
  rådgivning: 'consulting',
  video: 'video',
  videoproduction: 'video',
  'video production': 'video',
  videoproduksjon: 'video',
  email: 'email',
  epost: 'email',
  'e-post': 'email',
  social: 'social',
  socialmedia: 'social',
  'social media': 'social',
  sosialemedier: 'social',
  'sosiale medier': 'social',
};

export function normalizeSecondaryInterest(value = '') {
  const raw = sanitizeText(value).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s-]+/g, '');
  return SECONDARY_INTEREST_ALIASES[raw] || SECONDARY_INTEREST_ALIASES[compact] || '';
}

export function secondaryInterestLabel(value = '') {
  const id = normalizeSecondaryInterest(value);
  return SECONDARY_INTEREST_STATES.find((state) => state.id === id)?.label || '';
}

export function emptySalesPipelineCounts() {
  const counts = {};
  for (const state of SALES_PIPELINE_STATES) counts[state.id] = 0;
  for (const state of SECONDARY_INTEREST_STATES) counts[state.id] = 0;
  return counts;
}

export function meetingConfirmationSent(client = {}) {
  return Boolean(String(client?.reminders?.thankYouSentAt || '').trim());
}

export function classifySalesPipelineState(client = {}, nowMs = Date.now()) {
  if (sanitizeText(client.status) === 'not-sold') return '';
  const secondaryInterest = sanitizeText(client.status) === 'secondary'
    ? normalizeSecondaryInterest(client.secondaryInterest)
    : '';
  if (secondaryInterest) return secondaryInterest;
  if (clientIsSalesWin(client)) return 'win';
  if (client.progression?.offerSent && !client.progression?.contractSigned) return 'awaitingContract';
  if (client.progression?.meetingHeld && !client.progression?.offerSent) return 'awaitingOfferSend';
  const meetingMs = parseMs(client.meetingAt);
  const hasMeeting = Boolean(client.agreedTime && meetingMs != null);
  if (hasMeeting && !client.progression?.meetingHeld) {
    if (!meetingConfirmationSent(client)) return 'awaitingMeetingConfirm';
    if (meetingMs >= nowMs) return 'upcomingMeeting';
  }
  return '';
}

export function countSalesPipelineStates(clients = [], nowMs = Date.now()) {
  const counts = emptySalesPipelineCounts();
  for (const client of Array.isArray(clients) ? clients : []) {
    const state = classifySalesPipelineState(client, nowMs);
    if (state && Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
  }
  return counts;
}

/** Fields that must be present before a confirmation or reminder can go out. */
export function confirmationSendGaps(client = {}) {
  const gaps = [];
  if (!String(client?.contactPerson || '').trim()) gaps.push('kontaktnavn');
  if (!String(client?.businessName || '').trim()) gaps.push('bedriftsnavn');
  if (!client?.agreedTime || !String(client?.meetingAt || '').trim()) gaps.push('møtedato');
  const mode = String(client?.meetingMode || '').trim().toLowerCase();
  if (mode !== 'online' && mode !== 'in-person') gaps.push('møtetype');
  const email = String(client?.contactEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) gaps.push('e-post');
  return gaps;
}

/** True when a booked meeting time is already at or before now (do not auto-send confirmation). */
export function meetingTimeHasPassed(client = {}, nowMs = Date.now()) {
  if (!client?.agreedTime) return false;
  const ms = parseMs(client?.meetingAt);
  if (ms == null) return false;
  return ms <= nowMs;
}

export function sameMeetingInstant(left = '', right = '') {
  const a = parseMs(left);
  const b = parseMs(right);
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

/**
 * Auto confirmation is for a new/changed meeting time or IRL/online format
 * (or first-time ready), not for name/notes on the meeting action.
 */
export function confirmationShouldSendOnChange(existing, client, { ownerJustAssigned = false } = {}) {
  if (!existing || ownerJustAssigned) return true;
  if (confirmationSendGaps(existing).length > 0) return true;
  if (!existing.agreedTime || !existing.meetingAt) return true;
  if (!sameMeetingInstant(existing.meetingAt, client?.meetingAt)) return true;
  if (normalizeSalesMeetingMode(existing.meetingMode) !== normalizeSalesMeetingMode(client?.meetingMode)) return true;
  if (existing.contactEmail !== client?.contactEmail) return true;
  if (existing.contactPerson !== client?.contactPerson) return true;
  if (existing.businessName !== client?.businessName) return true;
  return false;
}

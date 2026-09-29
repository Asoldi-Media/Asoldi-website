const HOUR_MS = 60 * 60 * 1000;

export const SALES_GOAL_KEYS_ASOLDI = ['meetingHeld', 'offerSent', 'contractSigned'];
export const SALES_GOAL_KEYS_SSU = ['meetingHeld', 'offerSent', 'contractSigned', 'paymentReceived'];

export const GOAL_LABELS = {
  meetingHeld: 'Møtet hatt',
  offerSent: 'Sendt tilbud',
  contractSigned: 'Kontrakt signert',
  paymentReceived: 'Betaling mottatt',
  domainConnected: 'Domene koblet',
  live: 'Live',
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
  custom: 'Custom',
};

export const FOLLOW_UP_1M_NOTE = 'sjekk opp kundens opplevelse: spørr om review, også si ifra om det hadde vært mulig å selge nye tjenester. svarer de ikke send sms med lenke';
export const OFFER_CHECKIN_NAME = 'Oppsjekk sett';
export const SALES_ACTION_TIMEZONE = 'Europe/Oslo';
const MONTH_MS = 30 * 24 * HOUR_MS;

export const ACTION_FORMATS = ['email', 'sms', 'ring', 'mote'];

export const FORMAT_LABELS = {
  email: 'E-post',
  sms: 'SMS',
  ring: 'Ring',
  mote: 'Møte',
};

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
  sms1h: 1,
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
  if (presetKey === 'sms1h' && meetingMs != null) return toIso(meetingMs - HOUR_MS);
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
  }));
  return list;
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
    addToCalendar: Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? Boolean(input.addToCalendar)
      : presetKey === 'meeting' || presetKey === 'meetingBooked' || presetKey === 'upsell' || presetKey === 'oppgrader' || presetKey === 'oppfolging',
    calendarEventId: sanitizeText(input.calendarEventId),
  };
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

function createdMs(action = {}) {
  return parseMs(action?.createdAt) || 0;
}

function compareActions(a = {}, b = {}) {
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

export function ensureMeetingNextAction(actions = [], client = {}) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const hasSchedule = Boolean(client.agreedTime && client.meetingAt);
  const meetingHeld = Boolean(client.progression?.meetingHeld);
  if (meetingHeld || !hasSchedule) {
    return list.filter((action) => !(action.presetKey === 'meeting' && !action.doneAt));
  }

  const meetingId = `na-meeting-${sanitizeText(client.id) || 'client'}`;
  const index = list.findIndex((action) => action.presetKey === 'meeting');
  if (index >= 0) {
    const current = list[index];
    list[index] = {
      ...current,
      dueAt: client.meetingAt,
      relativeToMeetingHours: 0,
      addToCalendar: current.addToCalendar !== false,
      format: current.format || 'mote',
      doneAt: '',
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
    dueAt: client.meetingAt,
    doneAt: '',
    createdAt: new Date().toISOString(),
    relativeToMeetingHours: 0,
    addToCalendar: true,
    calendarEventId: '',
  });
  return list;
}

export function ensureSmsReminderAction(actions = [], client = {}) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const hasSchedule = Boolean(client.agreedTime && client.meetingAt);
  const meetingHeld = Boolean(client.progression?.meetingHeld);
  if (meetingHeld || !hasSchedule) {
    return list.filter((action) => !(action.presetKey === 'sms1h' && !action.doneAt));
  }
  if (list.some((action) => action.presetKey === 'sms1h')) return list;
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
    relativeToMeetingHours: 1,
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
  return applyRelativeDueAts(withFollowUp, client.meetingAt).slice().sort(compareActions);
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

export function getActiveNextAction(client = {}) {
  const live = decorateNextActions(client).filter((action) => !action.doneAt && !isMeetingFlowAction(action));
  if (clientIsSalesWin(client)) {
    return live.find((action) => action.goalKey === AFTER_SALE_GOAL) || null;
  }
  const currentGoal = getCurrentGoalKey(client);
  if (!currentGoal) return live[0] || null;
  return live.find((action) => action.goalKey === currentGoal) || null;
}

/**
 * The active next action is an "important contact point" when sales chose to put it on
 * their calendar (add-to-calendar toggle). Covers the auto meeting action for an agreed
 * meeting time, the "Møtet booket" preset, and any custom action with the toggle on.
 */
export function getCalendarNextAction(client = {}) {
  const action = getActiveNextAction(client);
  return action && action.addToCalendar ? action : null;
}

export function getClientNextActionMs(client = {}) {
  const action = getActiveNextAction(client);
  return parseMs(action?.dueAt);
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

  let keptActions = decorateNextActions(client).filter((action) => !progression[action.goalKey]);
  const nextClient = { ...client, progression, nextActions: keptActions };
  if (mappedKey === 'meetingHeld' && value) {
    keptActions = ensureOfferCheckInAction(keptActions, nextClient, nowMs);
  } else if (mappedKey === 'meetingHeld' && !value) {
    keptActions = keptActions.filter((action) => action.doneAt || !isAutoOfferCheckIn(action));
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
    const dueAt = sanitizeText(patch.dueAt);
    if (!name) return { error: 'Navn på neste handling er påkrevd.' };
    if (!parseMs(dueAt)) return { error: 'Tid for neste handling er påkrevd.' };
    const suggested = suggestedDueAtForPreset(presetKey, client, nowMs);
    const relativeDefault = relativeHoursForPreset(presetKey);
    const keepRelative = relativeDefault != null && dueMatchesSuggested(dueAt, suggested);
    const addToCalendar = Object.prototype.hasOwnProperty.call(patch, 'addToCalendar')
      ? Boolean(patch.addToCalendar)
      : defaultAddToCalendar(presetKey, client);
    actions = [...actions, normalizeNextAction({
      id: makeActionId(),
      goalKey,
      presetKey,
      name,
      note: patch.note,
      format: sanitizeActionFormat(patch.format, presetKey),
      dueAt,
      createdAt: toIso(nowMs),
      relativeToMeetingHours: keepRelative ? relativeDefault : null,
      addToCalendar,
    })];
  } else if (op === 'update') {
    const actionId = sanitizeText(patch.id || patch.actionId);
    const index = actions.findIndex((entry) => entry.id === actionId);
    if (index === -1) return { error: 'Handlingen finnes ikke.' };
    const current = actions[index];
    const name = Object.prototype.hasOwnProperty.call(patch, 'name') ? sanitizeText(patch.name) : current.name;
    const dueAt = Object.prototype.hasOwnProperty.call(patch, 'dueAt') ? sanitizeText(patch.dueAt) : current.dueAt;
    const note = Object.prototype.hasOwnProperty.call(patch, 'note') ? sanitizeActionNote(patch.note) : current.note;
    const format = Object.prototype.hasOwnProperty.call(patch, 'format')
      ? sanitizeActionFormat(patch.format, current.presetKey)
      : current.format;
    if (!name) return { error: 'Navn på neste handling er påkrevd.' };
    if (!parseMs(dueAt)) return { error: 'Tid for neste handling er påkrevd.' };
    const dueChanged = dueAt !== current.dueAt;
    const addToCalendar = Object.prototype.hasOwnProperty.call(patch, 'addToCalendar')
      ? Boolean(patch.addToCalendar)
      : Boolean(current.addToCalendar);
    actions[index] = {
      ...current,
      name,
      note,
      format,
      dueAt,
      addToCalendar: current.presetKey === 'meeting' ? true : addToCalendar,
      relativeToMeetingHours: dueChanged ? null : current.relativeToMeetingHours,
    };
    if (current.presetKey === 'meeting' && dueChanged) {
      extra.agreedTime = true;
      extra.meetingAt = dueAt;
      actions[index].relativeToMeetingHours = 0;
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
      return { error: 'Møtetiden endres i redigering av kunden, ikke slettes her.' };
    }
    if (current.presetKey === 'sms1h') {
      actions = actions.map((entry) => (
        entry.id === current.id ? { ...entry, doneAt: entry.doneAt || toIso(nowMs) } : entry
      ));
    } else {
      actions = actions.filter((entry) => entry.id !== actionId);
    }
  } else {
    return { error: 'Ugyldig handling.' };
  }

  const nextClient = {
    ...client,
    ...extra,
    nextActions: actions,
  };
  return {
    nextActions: decorateNextActions(nextClient),
    ...extra,
  };
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

export function meetingConfirmationSent(client = {}) {
  return Boolean(String(client?.reminders?.thankYouSentAt || '').trim());
}

export function classifySalesPipelineState(client = {}, nowMs = Date.now()) {
  if (sanitizeText(client.status) === 'not-sold') return '';
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
  const counts = {
    awaitingMeetingConfirm: 0,
    upcomingMeeting: 0,
    awaitingOfferSend: 0,
    awaitingContract: 0,
    win: 0,
  };
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

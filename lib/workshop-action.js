import {
  buildMeetingAttendees,
  deleteMeetingEvent,
  findConnectedCalendarAccountKeysByGoogleEmail,
  shouldForceCalendarRecreate,
  shouldIncludeFireflies,
  upsertMeetingEvent,
  upsertSalesReminderEvent,
} from './google-calendar.js';

export const WORKSHOP_DURATION_MINUTES = 30;
export const WORKSHOP_DEFAULT_NAME = 'Workshop';
export const DAMIAN_WORKSHOP_CALENDAR_EMAIL = 'damian@asoldi.com';
export const WORKSHOP_FORMATS = ['mote', 'sms-ring'];

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function makeWorkshopActionId() {
  return `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeWorkshopFormat(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'sms-ring' || raw === 'smsring' || raw === 'sms/ring') return 'sms-ring';
  return 'mote';
}

export function workshopEventSummary(client = {}, action = {}) {
  const businessName = sanitizeText(client?.businessName);
  const name = sanitizeText(action?.name) || WORKSHOP_DEFAULT_NAME;
  return businessName ? `Asoldi · ${name} · ${businessName}` : `Asoldi · ${name}`;
}

export function normalizeWorkshopAction(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const format = sanitizeWorkshopFormat(input.format);
  const dueAt = parseMs(input.dueAt) != null ? sanitizeText(input.dueAt) : '';
  const addToCalendar = format === 'mote'
    ? Boolean(dueAt)
    : Object.prototype.hasOwnProperty.call(input, 'addToCalendar')
      ? Boolean(input.addToCalendar)
      : false;
  return {
    id: sanitizeText(input.id) || makeWorkshopActionId(),
    name: sanitizeText(input.name) || WORKSHOP_DEFAULT_NAME,
    format,
    dueAt,
    addToCalendar,
    calendarEventId: sanitizeText(input.calendarEventId),
    meetLink: format === 'mote' ? sanitizeText(input.meetLink) : '',
    accountKey: sanitizeText(input.accountKey),
    firefliesInvitedAt: format === 'mote' ? sanitizeText(input.firefliesInvitedAt) : '',
    firefliesMeetingId: sanitizeText(input.firefliesMeetingId),
    firefliesLiveJoinedAt: format === 'mote' ? sanitizeText(input.firefliesLiveJoinedAt) : '',
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
  };
}

/** T06 reads this. Ignore offer startDate, nextActions, details.workshopAction, and client.workshop.action. */
export function getWorkshopAction(client = {}) {
  const raw = client && typeof client === 'object' ? client.workshopAction : null;
  if (!raw || typeof raw !== 'object') return null;
  const normalized = normalizeWorkshopAction(raw);
  if (!normalized.dueAt && !sanitizeText(raw.name) && !sanitizeText(raw.format) && !sanitizeText(raw.calendarEventId)) {
    return null;
  }
  return normalized;
}

export function workshopIsBooked(action = {}) {
  return parseMs(action?.dueAt) != null;
}

export function workshopNeedsCalendarEvent(action = {}) {
  const next = normalizeWorkshopAction(action);
  if (!workshopIsBooked(next)) return false;
  if (next.format === 'mote') return true;
  return Boolean(next.addToCalendar);
}

export function workshopInvitesClient(action = {}) {
  const next = normalizeWorkshopAction(action);
  return next.format === 'mote' && workshopIsBooked(next);
}

/** Offer startDate is date-only copy. It never books a workshop or creates a calendar event. */
export function offerStartDateCreatesEvent(_startDate = '') {
  return false;
}

export function workshopDeleteSendUpdates(action = {}) {
  return sanitizeWorkshopFormat(action?.format) === 'mote' ? 'all' : 'none';
}

export const DAMIAN_CALENDAR_ACCOUNT_KEY = `admin:${DAMIAN_WORKSHOP_CALENDAR_EMAIL}`;

/** Prefer the admin mailbox key when several tokens share damian@asoldi.com. */
export function pickDamianCalendarAccountKey(keys = []) {
  const list = (Array.isArray(keys) ? keys : [])
    .map((key) => sanitizeText(key))
    .filter(Boolean);
  const preferred = list.find((key) => key.toLowerCase() === DAMIAN_CALENDAR_ACCOUNT_KEY.toLowerCase());
  return preferred || list[0] || '';
}

export function resolveDamianWorkshopAccountKey() {
  return pickDamianCalendarAccountKey(
    findConnectedCalendarAccountKeysByGoogleEmail(DAMIAN_WORKSHOP_CALENDAR_EMAIL),
  );
}

export function buildWorkshopSyntheticMeetingClient(client = {}, action = {}) {
  const next = normalizeWorkshopAction(action);
  return {
    businessName: sanitizeText(client?.businessName),
    contactPerson: sanitizeText(client?.contactPerson),
    contactEmail: sanitizeText(client?.contactEmail),
    contactPhone: sanitizeText(client?.contactPhone),
    meetingAt: next.dueAt,
    meetingMode: 'online',
    calendar: {
      eventId: next.calendarEventId,
      meetLink: next.meetLink,
    },
  };
}

export function buildWorkshopInvitePayload(client = {}, action = {}) {
  const next = normalizeWorkshopAction(action);
  const synthetic = buildWorkshopSyntheticMeetingClient(client, next);
  const options = {
    durationMinutes: WORKSHOP_DURATION_MINUTES,
    sendUpdates: 'all',
    includeAttendees: true,
    addFireflies: true,
    summary: workshopEventSummary(client, next),
  };
  const includeFireflies = shouldIncludeFireflies({
    isOnline: true,
    addFireflies: true,
    sendUpdates: 'all',
    alreadyOnEvent: false,
  });
  return {
    client: synthetic,
    options,
    durationMinutes: WORKSHOP_DURATION_MINUTES,
    sendUpdates: 'all',
    meetingMode: 'online',
    includeMeet: true,
    includeFireflies,
    attendees: buildMeetingAttendees(synthetic, {
      includeAttendees: true,
      includeFireflies,
    }),
  };
}

export function buildWorkshopPrivatePayload(client = {}, action = {}) {
  const next = normalizeWorkshopAction(action);
  return {
    action: {
      name: next.name || WORKSHOP_DEFAULT_NAME,
      dueAt: next.dueAt,
      calendarEventId: next.calendarEventId,
    },
    options: {
      durationMinutes: WORKSHOP_DURATION_MINUTES,
    },
    durationMinutes: WORKSHOP_DURATION_MINUTES,
    sendUpdates: 'none',
    attendees: [],
    includeMeet: false,
    includeFireflies: false,
    summary: workshopEventSummary(client, next),
  };
}

export function buildWorkshopCalendarPlan(action = {}, client = {}, previous = {}) {
  const next = normalizeWorkshopAction(action);
  const prev = previous && typeof previous === 'object' && (previous.format || previous.dueAt || previous.calendarEventId)
    ? normalizeWorkshopAction(previous)
    : null;
  if (offerStartDateCreatesEvent(client?.details?.meetingQuote?.startDate) && !workshopIsBooked(next)) {
    return { createEvent: false, kind: 'none', durationMinutes: WORKSHOP_DURATION_MINUTES };
  }
  if (!workshopNeedsCalendarEvent(next)) {
    const existingId = sanitizeText(next.calendarEventId || prev?.calendarEventId);
    return {
      createEvent: false,
      kind: 'none',
      deleteEvent: Boolean(existingId),
      deleteSendUpdates: workshopDeleteSendUpdates(prev || next),
      durationMinutes: WORKSHOP_DURATION_MINUTES,
      attendees: [],
      sendUpdates: 'none',
    };
  }
  if (workshopInvitesClient(next)) {
    const invite = buildWorkshopInvitePayload(client, next);
    return {
      createEvent: true,
      kind: 'invite',
      ...invite,
    };
  }
  const privateEvent = buildWorkshopPrivatePayload(client, next);
  return {
    createEvent: true,
    kind: 'private',
    ...privateEvent,
  };
}

export function workshopEmailShouldSend(previous = {}, next = {}) {
  const prev = previous && typeof previous === 'object' ? normalizeWorkshopAction(previous) : normalizeWorkshopAction({});
  const curr = normalizeWorkshopAction(next);
  if (!workshopIsBooked(curr)) return false;
  if (!workshopIsBooked(prev)) return true;
  return prev.dueAt !== curr.dueAt || prev.format !== curr.format;
}

export async function tryBuildSalesWorkshopEmail(client, calendar = {}, options = {}) {
  try {
    const mod = await import('./sales-email.js');
    if (typeof mod.buildSalesWorkshopEmail !== 'function') return null;
    return mod.buildSalesWorkshopEmail(client, calendar, options);
  } catch {
    return null;
  }
}

export async function syncWorkshopCalendar({ client, previousAction, nextAction } = {}) {
  const previous = normalizeWorkshopAction(previousAction || {});
  const next = normalizeWorkshopAction(nextAction || {});
  const warnings = [];
  const damianKey = resolveDamianWorkshopAccountKey();
  const plan = buildWorkshopCalendarPlan(next, client, previous);
  const existingEventId = sanitizeText(previous.calendarEventId || next.calendarEventId);
  const previousKind = workshopInvitesClient(previous)
    ? 'invite'
    : workshopNeedsCalendarEvent(previous)
      ? 'private'
      : 'none';
  const kindChanged = previousKind !== 'none' && plan.kind !== previousKind;
  let eventId = existingEventId;
  let meetLink = previous.meetLink;
  let firefliesInvitedAt = previous.firefliesInvitedAt;
  let accountKey = previous.accountKey;

  if ((plan.createEvent || (plan.deleteEvent && eventId)) && !damianKey) {
    warnings.push(
      'damian@asoldi.com er ikke koblet til Google Calendar. Workshopen ble lagret, men ikke lagt i kalenderen. Selgerens kalender brukes ikke.'
    );
    if (!plan.createEvent) {
      return {
        action: {
          ...next,
          calendarEventId: '',
          meetLink: '',
          accountKey: '',
          firefliesInvitedAt: '',
        },
        warnings,
      };
    }
    return { action: next, warnings };
  }

  if (eventId && (!plan.createEvent || kindChanged)) {
    try {
      await deleteMeetingEvent(eventId, previous.accountKey || damianKey, {
        sendUpdates: workshopDeleteSendUpdates(previous),
      });
    } catch (error) {
      warnings.push(`Could not remove workshop calendar event: ${error.message}`);
    }
    eventId = '';
    meetLink = '';
    firefliesInvitedAt = '';
    accountKey = '';
  }

  if (!plan.createEvent) {
    return {
      action: {
        ...next,
        calendarEventId: '',
        meetLink: '',
        accountKey: '',
        firefliesInvitedAt: '',
      },
      warnings,
    };
  }

  try {
    if (plan.kind === 'invite') {
      const invite = buildWorkshopInvitePayload(client, { ...next, calendarEventId: eventId, meetLink });
      const forceRecreate = shouldForceCalendarRecreate(previous.dueAt, next.dueAt, eventId);
      const meta = await upsertMeetingEvent(invite.client, eventId, damianKey, {
        ...invite.options,
        forceRecreate,
      });
      return {
        action: {
          ...next,
          addToCalendar: true,
          calendarEventId: sanitizeText(meta.eventId),
          meetLink: sanitizeText(meta.meetLink),
          accountKey: sanitizeText(meta.accountKey) || damianKey,
          firefliesInvitedAt: meta.firefliesInvited
            ? sanitizeText(meta.syncedAt) || new Date().toISOString()
            : firefliesInvitedAt,
        },
        warnings,
      };
    }

    const privateEvent = buildWorkshopPrivatePayload(client, { ...next, calendarEventId: eventId });
    const meta = await upsertSalesReminderEvent(
      client,
      privateEvent.action,
      eventId,
      damianKey,
      privateEvent.options,
    );
    return {
      action: {
        ...next,
        calendarEventId: sanitizeText(meta.eventId),
        meetLink: '',
        accountKey: sanitizeText(meta.accountKey) || damianKey,
        firefliesInvitedAt: '',
      },
      warnings,
    };
  } catch (error) {
    warnings.push(`Workshop calendar sync failed: ${error.message}`);
    return {
      action: {
        ...next,
        calendarEventId: eventId,
        meetLink: next.format === 'mote' ? meetLink : '',
        accountKey,
        firefliesInvitedAt: next.format === 'mote' ? firefliesInvitedAt : '',
      },
      warnings,
    };
  }
}

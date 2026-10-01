import {
  buildMeetingAttendees,
  deleteMeetingEvent,
  findConnectedCalendarAccountKeysByGoogleEmail,
  shouldForceCalendarRecreate,
  shouldIncludeFireflies,
  upsertMeetingEvent,
  upsertSalesReminderEvent,
} from './google-calendar.js';
import {
  WORKSHOP_DURATION_MINUTES,
  WORKSHOP_DEFAULT_NAME,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  normalizeWorkshopAction,
  workshopEventSummary,
  workshopIsBooked,
  workshopNeedsCalendarEvent,
  workshopInvitesClient,
  offerStartDateCreatesEvent,
  workshopDeleteSendUpdates,
  pickDamianCalendarAccountKey,
  buildWorkshopSyntheticMeetingClient,
} from './workshop-action-shared.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export {
  WORKSHOP_DURATION_MINUTES,
  WORKSHOP_DEFAULT_NAME,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_FORMATS,
  sanitizeWorkshopFormat,
  workshopEventSummary,
  normalizeWorkshopAction,
  getWorkshopAction,
  workshopIsBooked,
  workshopNeedsCalendarEvent,
  workshopInvitesClient,
  offerStartDateCreatesEvent,
  workshopDeleteSendUpdates,
  DAMIAN_CALENDAR_ACCOUNT_KEY,
  pickDamianCalendarAccountKey,
  buildWorkshopSyntheticMeetingClient,
  workshopEmailShouldSend,
} from './workshop-action-shared.js';

export function resolveDamianWorkshopAccountKey() {
  return pickDamianCalendarAccountKey(
    findConnectedCalendarAccountKeysByGoogleEmail(DAMIAN_WORKSHOP_CALENDAR_EMAIL),
  );
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


/**
 * Iteration meeting calendar (T07). Same T05 30-minute invite rule, different event.
 * Never writes workshopAction.dueAt / format / name, and never uses client.calendar.
 */

import {
  buildMeetingAttendees,
  deleteMeetingEvent,
  shouldIncludeFireflies,
  upsertSalesReminderEvent,
} from './google-calendar.js';
import {
  DAMIAN_CALENDAR_DISCONNECTED_MESSAGE,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_DURATION_MINUTES,
  WORKSHOP_PRIMARY_CALENDAR_ID,
  resolveDamianWorkshopAccountKey,
  upsertDamianWorkshopInvite,
  workshopDeleteSendUpdates,
  workshopEventSummary,
} from './workshop-action.js';
import {
  ITERATION_DEFAULT_NAME,
  emptyIterationMeeting,
  normalizeIterationMeeting,
} from './workshop-record.js';

export const ITERATION_DURATION_MINUTES = WORKSHOP_DURATION_MINUTES;

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function iterationIsBooked(meeting = {}) {
  return parseMs(meeting?.dueAt) != null;
}

export function iterationNeedsCalendarEvent(meeting = {}) {
  const next = normalizeIterationMeeting(meeting);
  if (!iterationIsBooked(next)) return false;
  if (next.format === 'mote') return true;
  return Boolean(next.addToCalendar);
}

export function iterationInvitesClient(meeting = {}) {
  const next = normalizeIterationMeeting(meeting);
  return next.format === 'mote' && iterationIsBooked(next);
}

export function iterationEmailShouldSend(previous = {}, next = {}, options = {}) {
  if (!options?.send) return false;
  const prev = previous && typeof previous === 'object' ? normalizeIterationMeeting(previous) : normalizeIterationMeeting({});
  const curr = normalizeIterationMeeting(next);
  if (!iterationInvitesClient(curr)) return false;
  if (!sanitizeText(prev.confirmationSentAt)) return true;
  if (!iterationIsBooked(prev)) return true;
  return prev.dueAt !== curr.dueAt || prev.format !== curr.format;
}

export async function tryBuildSalesIterationEmail(client, calendar = {}, options = {}) {
  try {
    const mod = await import('./sales-email.js');
    if (typeof mod.buildSalesIterationEmail !== 'function') return null;
    return mod.buildSalesIterationEmail(client, calendar, options);
  } catch {
    return null;
  }
}

export function buildIterationSyntheticMeetingClient(client = {}, meeting = {}) {
  const next = normalizeIterationMeeting(meeting);
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

export function buildIterationInvitePayload(client = {}, meeting = {}) {
  const next = normalizeIterationMeeting(meeting);
  const synthetic = buildIterationSyntheticMeetingClient(client, next);
  const summary = workshopEventSummary(client, { name: ITERATION_DEFAULT_NAME, ...next });
  const options = {
    durationMinutes: ITERATION_DURATION_MINUTES,
    sendUpdates: 'all',
    includeAttendees: true,
    addFireflies: true,
    forceGuestInvite: true,
    calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
    summary,
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
    durationMinutes: ITERATION_DURATION_MINUTES,
    sendUpdates: 'all',
    meetingMode: 'online',
    includeMeet: true,
    includeFireflies,
    calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
    attendees: buildMeetingAttendees(synthetic, {
      includeAttendees: true,
      includeFireflies,
    }),
    summary,
  };
}

export function buildIterationPrivatePayload(client = {}, meeting = {}) {
  const next = normalizeIterationMeeting(meeting);
  return {
    action: {
      name: ITERATION_DEFAULT_NAME,
      dueAt: next.dueAt,
      calendarEventId: next.calendarEventId,
    },
    options: {
      durationMinutes: ITERATION_DURATION_MINUTES,
    },
    durationMinutes: ITERATION_DURATION_MINUTES,
    sendUpdates: 'none',
    attendees: [],
    includeMeet: false,
    includeFireflies: false,
    summary: workshopEventSummary(client, { name: ITERATION_DEFAULT_NAME, ...next }),
  };
}

export function buildIterationCalendarPlan(meeting = {}, client = {}, previous = {}) {
  const next = normalizeIterationMeeting(meeting);
  const prev = previous && typeof previous === 'object' && (previous.format || previous.dueAt || previous.calendarEventId)
    ? normalizeIterationMeeting(previous)
    : emptyIterationMeeting();
  if (!iterationNeedsCalendarEvent(next)) {
    const existingId = sanitizeText(next.calendarEventId || prev.calendarEventId);
    return {
      createEvent: false,
      kind: 'none',
      deleteEvent: Boolean(existingId),
      deleteSendUpdates: workshopDeleteSendUpdates(prev || next),
      durationMinutes: ITERATION_DURATION_MINUTES,
      attendees: [],
      sendUpdates: 'none',
    };
  }
  if (iterationInvitesClient(next)) {
    const invite = buildIterationInvitePayload(client, next);
    return {
      createEvent: true,
      kind: 'invite',
      ...invite,
    };
  }
  const privateEvent = buildIterationPrivatePayload(client, next);
  return {
    createEvent: true,
    kind: 'private',
    ...privateEvent,
  };
}

export async function syncIterationCalendar({ client, previousMeeting, nextMeeting } = {}) {
  const previous = normalizeIterationMeeting(previousMeeting || {});
  const next = normalizeIterationMeeting(nextMeeting || {});
  const warnings = [];
  const damianKey = resolveDamianWorkshopAccountKey();
  const plan = buildIterationCalendarPlan(next, client, previous);
  const existingEventId = sanitizeText(previous.calendarEventId || next.calendarEventId);
  const previousKind = iterationInvitesClient(previous)
    ? 'invite'
    : iterationNeedsCalendarEvent(previous)
      ? 'private'
      : 'none';
  const kindChanged = previousKind !== 'none' && plan.kind !== previousKind;
  let eventId = existingEventId;
  let meetLink = previous.meetLink;
  let firefliesInvitedAt = previous.firefliesInvitedAt;
  let accountKey = previous.accountKey;

  if ((plan.createEvent || (plan.deleteEvent && eventId)) && !damianKey) {
    warnings.push(DAMIAN_CALENDAR_DISCONNECTED_MESSAGE);
    if (!plan.createEvent) {
      return {
        meeting: {
          ...next,
          calendarEventId: '',
          meetLink: '',
          accountKey: '',
          firefliesInvitedAt: '',
          sentAt: '',
        },
        warnings,
      };
    }
    if (plan.kind === 'invite') {
      return {
        meeting: {
          ...next,
          calendarEventId: '',
          meetLink: '',
          accountKey: '',
          firefliesInvitedAt: '',
          sentAt: '',
        },
        warnings,
        error: DAMIAN_CALENDAR_DISCONNECTED_MESSAGE,
      };
    }
    return { meeting: next, warnings };
  }

  if (eventId && (!plan.createEvent || kindChanged)) {
    try {
      await deleteMeetingEvent(eventId, previous.accountKey || damianKey, {
        sendUpdates: workshopDeleteSendUpdates(previous),
        calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
      });
    } catch (error) {
      warnings.push(`Could not remove iteration calendar event: ${error.message}`);
    }
    eventId = '';
    meetLink = '';
    firefliesInvitedAt = '';
    accountKey = '';
  }

  if (!plan.createEvent) {
    return {
      meeting: {
        ...next,
        calendarEventId: '',
        meetLink: '',
        accountKey: '',
        firefliesInvitedAt: '',
        sentAt: '',
      },
      warnings,
    };
  }

  try {
    if (plan.kind === 'invite') {
      const invite = buildIterationInvitePayload(client, { ...next, calendarEventId: eventId, meetLink });
      const { meta, error } = await upsertDamianWorkshopInvite({
        inviteClient: invite.client,
        options: invite.options,
        eventId,
        previousDueAt: previous.dueAt,
        nextDueAt: next.dueAt,
        damianKey,
      });
      if (error) {
        warnings.push(error);
        const keepEvent = Boolean(sanitizeText(meta.eventId));
        return {
          meeting: {
            ...next,
            addToCalendar: true,
            calendarEventId: keepEvent ? sanitizeText(meta.eventId) : '',
            meetLink: keepEvent ? sanitizeText(meta.meetLink) : '',
            accountKey: keepEvent ? (sanitizeText(meta.accountKey) || damianKey) : '',
            firefliesInvitedAt: keepEvent && meta.firefliesInvited
              ? sanitizeText(meta.syncedAt) || new Date().toISOString()
              : '',
            sentAt: '',
          },
          warnings,
          error,
        };
      }
      return {
        meeting: {
          ...next,
          addToCalendar: true,
          calendarEventId: sanitizeText(meta.eventId),
          meetLink: sanitizeText(meta.meetLink),
          accountKey: sanitizeText(meta.accountKey) || damianKey,
          firefliesInvitedAt: meta.firefliesInvited
            ? sanitizeText(meta.syncedAt) || new Date().toISOString()
            : firefliesInvitedAt,
          sentAt: new Date().toISOString(),
        },
        warnings,
      };
    }

    const privateEvent = buildIterationPrivatePayload(client, { ...next, calendarEventId: eventId });
    const meta = await upsertSalesReminderEvent(
      client,
      privateEvent.action,
      eventId,
      damianKey,
      privateEvent.options,
    );
    return {
      meeting: {
        ...next,
        calendarEventId: sanitizeText(meta.eventId),
        meetLink: '',
        accountKey: sanitizeText(meta.accountKey) || damianKey,
        firefliesInvitedAt: '',
        sentAt: new Date().toISOString(),
      },
      warnings,
    };
  } catch (error) {
    const message = `Iteration calendar sync failed: ${error.message}`;
    warnings.push(message);
    return {
      meeting: {
        ...next,
        calendarEventId: eventId,
        meetLink: next.format === 'mote' ? meetLink : '',
        accountKey,
        firefliesInvitedAt: next.format === 'mote' ? firefliesInvitedAt : '',
      },
      warnings,
      error: plan.kind === 'invite' ? message : undefined,
    };
  }
}

export { DAMIAN_WORKSHOP_CALENDAR_EMAIL };

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
  WORKSHOP_PRIMARY_CALENDAR_ID,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  DAMIAN_CALENDAR_DISCONNECTED_MESSAGE,
  normalizeWorkshopAction,
  workshopEventSummary,
  workshopIsBooked,
  workshopNeedsCalendarEvent,
  workshopInvitesClient,
  offerStartDateCreatesEvent,
  workshopDeleteSendUpdates,
  pickDamianCalendarAccountKey,
  buildWorkshopSyntheticMeetingClient,
  workshopInviteHostError,
  workshopInviteShouldDeleteFailedEvent,
} from './workshop-action-shared.js';
import { emptyFirefliesLiveJoinStamp, firefliesMeetLinksDiffer } from './fireflies-client-match.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export {
  WORKSHOP_DURATION_MINUTES,
  WORKSHOP_DEFAULT_NAME,
  WORKSHOP_PRIMARY_CALENDAR_ID,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  DAMIAN_CALENDAR_DISCONNECTED_MESSAGE,
  WORKSHOP_FORMATS,
  sanitizeWorkshopFormat,
  workshopFormatInvitesClient,
  offerStartDateFromWorkshopDueAt,
  workshopIsConfirmed,
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
  workshopInviteHostError,
  workshopInviteHostOk,
  workshopInviteShouldDeleteFailedEvent,
  damianMeetJoinUrl,
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
    forceGuestInvite: true,
    calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
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
    calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
    attendees: buildMeetingAttendees(synthetic, {
      includeAttendees: true,
      includeFireflies,
    }),
  };
}

export async function upsertDamianWorkshopInvite({
  inviteClient,
  options = {},
  eventId = '',
  previousDueAt = '',
  nextDueAt = '',
  damianKey = '',
} = {}) {
  const forceRecreate = shouldForceCalendarRecreate(previousDueAt, nextDueAt, eventId);
  const meta = await upsertMeetingEvent(inviteClient, eventId, damianKey, {
    ...options,
    calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
    forceGuestInvite: true,
    forceRecreate,
  });
  const hostMeta = {
    googleEmail: meta.googleEmail,
    organizerEmail: meta.organizerEmail,
    meetLink: meta.meetLink,
    firefliesInvited: meta.firefliesInvited,
  };
  const error = workshopInviteHostError(hostMeta);
  if (error && workshopInviteShouldDeleteFailedEvent(hostMeta) && sanitizeText(meta.eventId)) {
    try {
      await deleteMeetingEvent(meta.eventId, damianKey, {
        calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
        sendUpdates: 'all',
      });
    } catch {
      // Still fail closed below; the client is not emailed from this helper.
    }
    return {
      meta: {
        ...meta,
        eventId: '',
        meetLink: '',
        firefliesInvited: false,
      },
      error,
    };
  }
  return { meta, error };
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
    warnings.push(DAMIAN_CALENDAR_DISCONNECTED_MESSAGE);
    if (!plan.createEvent) {
      return {
        action: {
          ...next,
          calendarEventId: '',
          meetLink: '',
          accountKey: '',
          firefliesInvitedAt: '',
          ...emptyFirefliesLiveJoinStamp(),
        },
        warnings,
      };
    }
    if (plan.kind === 'invite') {
      return {
        action: {
          ...next,
          calendarEventId: '',
          meetLink: '',
          accountKey: '',
          firefliesInvitedAt: '',
          ...emptyFirefliesLiveJoinStamp(),
        },
        warnings,
        error: DAMIAN_CALENDAR_DISCONNECTED_MESSAGE,
      };
    }
    return { action: next, warnings };
  }

  if (eventId && (!plan.createEvent || kindChanged)) {
    try {
      await deleteMeetingEvent(eventId, previous.accountKey || damianKey, {
        sendUpdates: workshopDeleteSendUpdates(previous),
        calendarId: WORKSHOP_PRIMARY_CALENDAR_ID,
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
        ...emptyFirefliesLiveJoinStamp(),
      },
      warnings,
    };
  }

  try {
    if (plan.kind === 'invite') {
      const invite = buildWorkshopInvitePayload(client, { ...next, calendarEventId: eventId, meetLink });
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
          action: {
            ...next,
            addToCalendar: true,
            calendarEventId: keepEvent ? sanitizeText(meta.eventId) : '',
            meetLink: keepEvent ? sanitizeText(meta.meetLink) : '',
            accountKey: keepEvent ? (sanitizeText(meta.accountKey) || damianKey) : '',
            firefliesInvitedAt: keepEvent && meta.firefliesInvited
              ? sanitizeText(meta.syncedAt) || new Date().toISOString()
              : '',
          },
          warnings,
          error,
        };
      }
      const nextMeet = sanitizeText(meta.meetLink);
      const joinReset = firefliesMeetLinksDiffer(previous.meetLink, nextMeet)
        ? emptyFirefliesLiveJoinStamp()
        : {};
      return {
        action: {
          ...next,
          addToCalendar: true,
          calendarEventId: sanitizeText(meta.eventId),
          meetLink: nextMeet,
          accountKey: sanitizeText(meta.accountKey) || damianKey,
          firefliesInvitedAt: meta.firefliesInvited
            ? sanitizeText(meta.syncedAt) || new Date().toISOString()
            : firefliesInvitedAt,
          ...joinReset,
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
        ...emptyFirefliesLiveJoinStamp(),
      },
      warnings,
    };
  } catch (error) {
    const message = `Workshop calendar sync failed: ${error.message}`;
    warnings.push(message);
    return {
      action: {
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

export async function maybeSyncWorkshopGoalActionCalendars(client = {}, previousWorkshop = {}, nextWorkshop = {}) {
  const warnings = [];
  const damianKey = resolveDamianWorkshopAccountKey();
  const previousActions = Array.isArray(previousWorkshop?.goalActions) ? previousWorkshop.goalActions : [];
  const nextActions = Array.isArray(nextWorkshop?.goalActions) ? nextWorkshop.goalActions : [];
  const patched = nextActions.map((action) => ({ ...action }));
  const patchedById = new Map(patched.map((action) => [sanitizeText(action.id), action]));
  const shouldSync = (action) => (
    Boolean(action?.addToCalendar)
    && !sanitizeText(action?.doneAt)
    && sanitizeText(action?.dueAt)
  );

  for (const previous of previousActions) {
    const id = sanitizeText(previous.id);
    const current = patchedById.get(id);
    const eventId = sanitizeText(previous.calendarEventId || current?.calendarEventId);
    if (!eventId) continue;
    if (current && shouldSync(current)) continue;
    if (!damianKey && !sanitizeText(previous.accountKey)) continue;
    try {
      await deleteMeetingEvent(eventId, sanitizeText(previous.accountKey) || damianKey);
    } catch (error) {
      warnings.push(`Could not remove workshop reminder: ${error.message}`);
    }
    if (current) current.calendarEventId = '';
  }

  if (!damianKey) {
    if (patched.some(shouldSync)) {
      warnings.push('damian@asoldi.com er ikke koblet til Google Calendar. Påminnelsene ble lagret, men ikke lagt i kalenderen.');
    }
    return { goalActions: patched, warnings };
  }

  for (const action of patched) {
    if (!shouldSync(action)) continue;
    try {
      const meta = await upsertSalesReminderEvent(client, action, action.calendarEventId, damianKey);
      action.calendarEventId = sanitizeText(meta.eventId);
    } catch (error) {
      warnings.push(`Workshop reminder calendar sync failed: ${error.message}`);
    }
  }
  return { goalActions: patched, warnings };
}


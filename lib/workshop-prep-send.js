import * as sales from '../data/sales.js';
import * as emailLib from './email.js';
import { buildPreWorkshopEmail, buildSalesCalendarInvite } from './sales-email.js';
import { loadWorkshopNeedsDocument, openNeedLines } from './workshop-needs.js';
import { mergePrepNeedLines } from './workshop-prep-needs.js';
import {
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  WORKSHOP_DURATION_MINUTES,
  buildWorkshopSyntheticMeetingClient,
  getWorkshopAction,
  normalizeWorkshopAction,
  syncWorkshopCalendar,
  workshopInviteHostOk,
  workshopIsBooked,
} from './workshop-action.js';
import { preWorkshopAutosendForClient, stampWorkshopDeskEmail } from './workshop-desk-emails.js';
import { getWorkshopRecord, mergeWorkshopRecord } from './workshop-record.js';
import { getAutomationSettings } from '../data/automation-settings.js';
import { evaluateDeliveryGate, gateActiveForClient, gateMailRows, gatherGateInputs } from './delivery-gate.js';
import { deliverDeliveryEmail, deliveryEmailMode, schedulingSender } from './delivery-emails.js';

function sanitize(value = '') {
  return String(value ?? '').trim();
}

export function shouldSendPreWorkshopOnContract({ previousSigned = false, client = {} } = {}) {
  if (previousSigned) return false;
  if (!client?.progression?.contractSigned) return false;
  if (sales.isSsuSalesProduct(client.product)) return false;
  if (sanitize(client?.workshop?.deskEmails?.preWorkshopSentAt)) return false;
  return true;
}

export async function loadPrepNeedLines(client, deps = {}) {
  const document = await loadWorkshopNeedsDocument(client, deps);
  return mergePrepNeedLines({
    t01Lines: openNeedLines(document),
    dots: document?.dots || [],
  });
}

function stampPreWorkshop(client) {
  const record = getWorkshopRecord(client);
  return sales.setSalesWorkshop(client.id, mergeWorkshopRecord(record, stampWorkshopDeskEmail(record, 'preWorkshopSentAt')));
}

async function sendBuiltMail(client, built, { icalEvent } = {}) {
  const recipient = sanitize(client?.contactEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, warning: 'Workshop-e-post ble ikke sendt: kunden mangler e-post.' };
  }
  if (!emailLib.canSendEmail()) {
    return { sent: false, warning: 'Workshop-e-post ble ikke sendt: e-post er ikke konfigurert.' };
  }
  await emailLib.sendEmail({
    to: recipient,
    from: built.from,
    replyTo: built.replyTo,
    subject: built.subject,
    text: built.text,
    html: built.html,
    attachments: built.attachments,
    icalEvent,
  });
  return { sent: true, warning: '' };
}

export async function sendPrepWorkshopEmail(client, { sender = {}, needLines = [] } = {}) {
  const built = buildPreWorkshopEmail(client, {}, { sender, hasTime: false, needLines });
  const mailed = await sendBuiltMail(client, built);
  if (mailed.sent) stampPreWorkshop(client);
  return mailed;
}

export async function confirmWorkshopAndMail(client, previousAction, nextAction, {
  sender = {},
  needLines = [],
  includeNeeds = true,
} = {}) {
  const previous = normalizeWorkshopAction(previousAction || {});
  const next = normalizeWorkshopAction(nextAction || {});
  const warnings = [];
  if (!workshopIsBooked(next)) {
    return { ok: false, sent: false, warning: 'Mangler workshop-tid.', warnings, client };
  }

  const sync = await syncWorkshopCalendar({
    client,
    previousAction: previous,
    nextAction: next,
  });
  warnings.push(...(sync.warnings || []));
  let action = normalizeWorkshopAction({
    ...sync.action,
    status: sync.error ? 'draft' : 'confirmed',
  });
  if (sync.error) {
    sales.setSalesWorkshopAction(client.id, action);
    const live = sales.getSalesClientById(client.id) || client;
    const built = buildPreWorkshopEmail(live, { meetLink: action.meetLink }, {
      sender,
      hasTime: true,
      needLines: includeNeeds ? needLines : [],
      workshop: action,
    });
    const mailed = await sendBuiltMail(live, built);
    if (mailed.sent) stampPreWorkshop(live);
    return {
      ok: false,
      sent: mailed.sent,
      warning: sync.error,
      warnings,
      client: sales.getSalesClientById(client.id) || live,
      action,
    };
  }

  sales.setSalesWorkshopAction(client.id, action);
  let live = sales.getSalesClientById(client.id) || client;
  const hostOk = action.format !== 'mote' || workshopInviteHostOk({
    googleEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
    organizerEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
    meetLink: action.meetLink,
    firefliesInvited: Boolean(action.firefliesInvitedAt),
  });
  const built = buildPreWorkshopEmail(live, { meetLink: action.meetLink, eventId: action.calendarEventId }, {
    sender,
    hasTime: true,
    needLines: includeNeeds ? needLines : [],
    workshop: action,
  });
  const synthetic = buildWorkshopSyntheticMeetingClient(live, action);
  const invite = action.format === 'mote'
    ? buildSalesCalendarInvite(synthetic, {
      meetLink: action.meetLink,
      eventId: action.calendarEventId,
    }, {
      sender,
      organizerEmail: DAMIAN_WORKSHOP_CALENDAR_EMAIL,
      organizerName: 'Damian',
      durationMinutes: WORKSHOP_DURATION_MINUTES,
      summary: `Asoldi · ${sanitize(action.name) || 'Workshop'} · ${sanitize(live.businessName) || 'kunde'}`,
    })
    : null;
  const mailed = await sendBuiltMail(live, built, { icalEvent: hostOk ? invite : undefined });
  if (mailed.sent) {
    action = normalizeWorkshopAction({
      ...action,
      confirmationSentAt: action.confirmationSentAt || new Date().toISOString(),
      status: 'confirmed',
    });
    sales.setSalesWorkshopAction(client.id, action);
    stampPreWorkshop(sales.getSalesClientById(client.id) || live);
  }
  live = sales.getSalesClientById(client.id) || live;
  return {
    ok: Boolean(mailed.sent),
    sent: Boolean(mailed.sent),
    warning: mailed.warning || (hostOk ? '' : 'Google Meet ble ikke bekreftet som damian@asoldi.com.'),
    warnings,
    client: live,
    action,
  };
}

/**
 * The settings when the pre-workshop mail uses the gate's lines (the gate runs for the client and
 * emails.preWorkshop.lines is 'gate'), else null and today's mail is sent unchanged.
 */
export function preWorkshopGateSettings(client) {
  let settings;
  try {
    settings = getAutomationSettings();
  } catch {
    return null;
  }
  if (settings?.emails?.preWorkshop?.lines !== 'gate') return null;
  return gateActiveForClient(client, { settings }) ? settings : null;
}

/**
 * The pre-workshop mail with the gate's grouped lines. In shadow (the gate is shadow-only for now)
 * the mail goes to the outbox as a record and never to the transport; nothing is stamped and no
 * calendar event is touched. In auto it follows today's flow with the gate lines and the
 * scheduling Reply-To rule.
 */
async function sendPreWorkshopWithGateLines(client, settings, { sender = {}, deps = {} } = {}) {
  const mode = deliveryEmailMode('preWorkshop', client, { settings });
  if (mode !== 'shadow' && mode !== 'auto') {
    return {
      sent: false,
      skipped: true,
      reason: 'automation-off',
      warning: 'Workshop-e-post ble ikke sendt automatisk: utsendelsen er slått av eller satt på pause under Automatisering.',
      client,
    };
  }
  const inputs = await gatherGateInputs(client, deps);
  const gate = evaluateDeliveryGate(client, inputs);
  const needLines = gateMailRows(gate, inputs.materials);
  const schedSender = await schedulingSender(client, sender, { settings, deps });
  const action = getWorkshopAction(client);
  if (mode === 'auto') {
    if (workshopIsBooked(action) && !sanitize(action.confirmationSentAt)) {
      return confirmWorkshopAndMail(client, action, {
        ...action,
        addToCalendar: action.format === 'mote' ? true : action.addToCalendar,
      }, { sender: schedSender, needLines, includeNeeds: true });
    }
    const built = buildPreWorkshopEmail(client, { meetLink: action?.meetLink }, {
      sender: schedSender,
      hasTime: workshopIsBooked(action),
      needLines,
      ...(workshopIsBooked(action) ? { workshop: action } : {}),
    });
    const mailed = await sendBuiltMail(client, built);
    if (mailed.sent) stampPreWorkshop(client);
    return { ...mailed, client: sales.getSalesClientById(client.id) || client, needLines, gateLines: true };
  }
  const built = buildPreWorkshopEmail(client, { meetLink: action?.meetLink }, {
    sender: schedSender,
    hasTime: workshopIsBooked(action),
    needLines,
    ...(workshopIsBooked(action) ? { workshop: action } : {}),
  });
  const recorded = await deliverDeliveryEmail({
    kindId: 'preWorkshop',
    client,
    message: {
      to: sanitize(client?.contactEmail),
      from: built.from,
      replyTo: built.replyTo,
      subject: built.subject,
      text: built.text,
      html: built.html,
      attachments: built.attachments,
    },
    mode: 'shadow',
    dedupeKey: `preWorkshop:${sanitize(client?.id)}:${sanitize(client?.contractSignedAt) || 'signed'}`,
    deps,
  });
  return {
    sent: false,
    shadow: true,
    status: recorded.status,
    warning: 'Workshop-e-posten med kravlinjene er lagret som skyggeutkast og ikke sendt.',
    client,
    needLines,
    gateLines: true,
  };
}

export async function sendPreWorkshopAfterContractSigned(client, {
  sender = {},
  previousSigned = false,
  fetchMakerRun,
  listMail,
  gateDeps,
} = {}) {
  if (!shouldSendPreWorkshopOnContract({ previousSigned, client })) {
    return { sent: false, skipped: true, client };
  }
  const gateSettings = preWorkshopGateSettings(client);
  if (gateSettings) return sendPreWorkshopWithGateLines(client, gateSettings, { sender, deps: gateDeps || {} });
  // WS8.10 / WS8.56: the legacy autosend follows Superadmin → Automatisering (pause, off) and
  // leaves out test clients that are not pilots.
  if (!preWorkshopAutosendForClient(client)) {
    return {
      sent: false,
      skipped: true,
      reason: 'automation-off',
      warning: client?.isTest === true
        ? 'Workshop-e-post ble ikke sendt automatisk: testkunde som ikke er pilot.'
        : 'Workshop-e-post ble ikke sendt automatisk: utsendelsen er slått av eller satt på pause under Automatisering.',
      client,
    };
  }
  let needLines = [];
  try {
    needLines = await loadPrepNeedLines(client, { fetchMakerRun, listMail });
  } catch {
    needLines = [];
  }
  const action = getWorkshopAction(client);
  if (workshopIsBooked(action)) {
    if (sanitize(action.confirmationSentAt)) {
      const built = buildPreWorkshopEmail(client, { meetLink: action.meetLink }, {
        sender,
        hasTime: true,
        needLines,
        workshop: action,
      });
      const mailed = await sendBuiltMail(client, built);
      if (mailed.sent) stampPreWorkshop(client);
      return {
        ...mailed,
        skippedConfirm: true,
        client: sales.getSalesClientById(client.id) || client,
        needLines,
      };
    }
    return confirmWorkshopAndMail(client, action, {
      ...action,
      addToCalendar: action.format === 'mote' ? true : action.addToCalendar,
    }, { sender, needLines, includeNeeds: true });
  }
  const mailed = await sendPrepWorkshopEmail(client, { sender, needLines });
  return {
    ...mailed,
    client: sales.getSalesClientById(client.id) || client,
    needLines,
  };
}

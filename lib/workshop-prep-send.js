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

function gateBuiltPreWorkshop(client, needLines, schedSender) {
  const action = getWorkshopAction(client);
  return buildPreWorkshopEmail(client, { meetLink: action?.meetLink }, {
    sender: schedSender,
    hasTime: workshopIsBooked(action),
    needLines,
    ...(workshopIsBooked(action) ? { workshop: action } : {}),
  });
}

/**
 * The pre-workshop mail with the gate's grouped lines, sent for a client where the kind is auto
 * (the gate and emails.preWorkshop both auto, a pilot). It replaces today's mail: today's flow with
 * the gate lines and the scheduling Reply-To rule.
 */
async function sendPreWorkshopWithGateLines(client, settings, { sender = {}, deps = {} } = {}) {
  const inputs = await gatherGateInputs(client, deps);
  const gate = evaluateDeliveryGate(client, inputs);
  const needLines = gateMailRows(gate, inputs.materials);
  const schedSender = await schedulingSender(client, sender, { settings, deps });
  const action = getWorkshopAction(client);
  if (workshopIsBooked(action) && !sanitize(action.confirmationSentAt)) {
    return confirmWorkshopAndMail(client, action, {
      ...action,
      addToCalendar: action.format === 'mote' ? true : action.addToCalendar,
    }, { sender: schedSender, needLines, includeNeeds: true });
  }
  const mailed = await sendBuiltMail(client, gateBuiltPreWorkshop(client, needLines, schedSender));
  if (mailed.sent) stampPreWorkshop(client);
  return { ...mailed, client: sales.getSalesClientById(client.id) || client, needLines, gateLines: true };
}

/**
 * In shadow the gate's pre-workshop mail is only a draft: it goes to the outbox as a shadow record
 * (once per signing) and never to the transport. Today's mail is sent beside it, unchanged. A
 * failure here is logged and never stops today's mail. Returns { status, outboxId, lines }.
 */
async function recordPreWorkshopGateShadow(client, settings, { sender = {}, deps = {} } = {}) {
  try {
    const inputs = await gatherGateInputs(client, deps);
    const gate = evaluateDeliveryGate(client, inputs);
    const needLines = gateMailRows(gate, inputs.materials);
    const schedSender = await schedulingSender(client, sender, { settings, deps });
    const built = gateBuiltPreWorkshop(client, needLines, schedSender);
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
    return { status: recorded.status, outboxId: recorded.outboxId || '', lines: needLines.length };
  } catch (error) {
    console.warn('[delivery-gate] pre-workshop shadow draft failed:', error?.message || error);
    return { status: 'failed', outboxId: '', lines: 0 };
  }
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
  // With the gate running for the client and lines set to 'gate': only 'auto' (the gate and the kind
  // both auto, a pilot) replaces today's mail. In shadow today's mail still goes out exactly as
  // before and the gate's mail is recorded beside it as a draft.
  const gateSettings = preWorkshopGateSettings(client);
  const gateMode = gateSettings ? deliveryEmailMode('preWorkshop', client, { settings: gateSettings }) : 'off';
  if (gateMode === 'auto') return sendPreWorkshopWithGateLines(client, gateSettings, { sender, deps: gateDeps || {} });
  const sent = await sendPreWorkshopLegacy(client, { sender, fetchMakerRun, listMail });
  if (gateMode !== 'shadow') return sent;
  return { ...sent, gateShadow: await recordPreWorkshopGateShadow(client, gateSettings, { sender, deps: gateDeps || {} }) };
}

/** Today's pre-workshop mail on contract signing (the legacy autosend). */
async function sendPreWorkshopLegacy(client, { sender = {}, fetchMakerRun, listMail } = {}) {
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

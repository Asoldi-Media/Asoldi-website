import { getWorkshopAction, workshopFormatInvitesClient } from './workshop-action-shared.js';
import { effectiveEmailMode, effectiveModeForClient } from '../data/automation-settings.js';

function envAutosendOn() {
  return String(process.env.WORKSHOP_DESK_EMAIL_AUTOSEND || '0') === '1';
}

/**
 * Workshop reminders autosend when Superadmin → Automatisering sets emails.workshopReminders to
 * enabled + auto and no runtime guard has paused it. WORKSHOP_DESK_EMAIL_AUTOSEND=1 overrides only
 * `enabled` and `mode` (reported as overriddenBy:'env'); a pause still stops the reminders.
 */
export function workshopDeskEmailAutosendEnabled({ settings } = {}) {
  try {
    return effectiveEmailMode('workshopReminders', { settings }) === 'auto';
  } catch (error) {
    console.warn('[automation] settings unreadable; workshop reminders follow WORKSHOP_DESK_EMAIL_AUTOSEND:', error?.message || error);
    return envAutosendOn();
  }
}

/**
 * Whether workshop reminders autosend to this client: the switch is auto (env override and pause
 * applied) and the client is in scope (a test client only when it is a listed pilot).
 */
export function workshopDeskEmailAutosendForClient(client, { settings } = {}) {
  try {
    return effectiveModeForClient('emails.workshopReminders', client, { settings }) === 'auto';
  } catch (error) {
    console.warn('[automation] settings unreadable; workshop reminders follow WORKSHOP_DESK_EMAIL_AUTOSEND:', error?.message || error);
    return envAutosendOn() && client?.isTest !== true;
  }
}

/** The clients the workshop reminder loop may mail: active and in automation scope. */
export function workshopReminderClients(clients, { settings } = {}) {
  return (Array.isArray(clients) ? clients : []).filter((client) => (
    String(client?.status ?? '').trim() === 'active' && workshopDeskEmailAutosendForClient(client, { settings })
  ));
}

/**
 * Whether the pre-workshop email autosends to this client when the contract is signed. It is a
 * legacy kind (auto by default); a switch-off, a pause or a non-pilot test client stops it.
 */
export function preWorkshopAutosendForClient(client, { settings } = {}) {
  try {
    return effectiveModeForClient('emails.preWorkshop', client, { settings }) === 'auto';
  } catch (error) {
    console.warn('[automation] settings unreadable; pre-workshop autosend keeps the legacy default:', error?.message || error);
    return client?.isTest !== true;
  }
}

/** Datainnsamling is always a manual Admin send. Only workshop reminders may autosend. */
export function workshopDeskEmailKindAutosends(kind = '') {
  const key = String(kind || '').trim().toLowerCase();
  return key === 'workshop-reminder-3d' || key === 'workshop-reminder-24h';
}

/** Stamp field on workshop.deskEmails after a desk mail is actually sent. */
export function workshopDeskEmailStampKey(kind = '') {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'workshop-reminder-3d') return 'reminder3dSentAt';
  if (key === 'workshop-reminder-24h') return 'reminder24hSentAt';
  if (key === 'data-innsamling-2') return 'data2SentAt';
  if (key === 'data-innsamling-1' || key.startsWith('data-innsamling')) return 'data1SentAt';
  return '';
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function workshopReminderScheduleAt(kind = '24h', workshopDueAt = '') {
  const ms = parseMs(workshopDueAt);
  if (ms == null) return '';
  if (kind === '3d' || kind === '72h') return new Date(ms - 3 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(ms - 24 * 60 * 60 * 1000).toISOString();
}

export function workshopReminderShouldIncludeIcs(client = {}) {
  return workshopFormatInvitesClient(getWorkshopAction(client)?.format);
}

export function workshopDeskEmailIsDue(atIso = '', sentAt = '', nowMs = Date.now()) {
  if (sanitizeText(sentAt)) return false;
  const at = parseMs(atIso);
  if (at == null) return false;
  return at <= nowMs;
}

export function stampWorkshopDeskEmail(record = {}, key = '', at = new Date().toISOString()) {
  const deskEmails = record?.deskEmails && typeof record.deskEmails === 'object' ? { ...record.deskEmails } : {};
  deskEmails[key] = sanitizeText(at) || new Date().toISOString();
  return { deskEmails };
}

import { getWorkshopAction, workshopFormatInvitesClient } from './workshop-action-shared.js';

export function workshopDeskEmailAutosendEnabled() {
  return String(process.env.WORKSHOP_DESK_EMAIL_AUTOSEND || '0') === '1';
}

/** Datainnsamling is always a manual Admin send. Only workshop reminders may autosend. */
export function workshopDeskEmailKindAutosends(kind = '') {
  const key = String(kind || '').trim().toLowerCase();
  return key === 'workshop-reminder-3d' || key === 'workshop-reminder-24h';
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

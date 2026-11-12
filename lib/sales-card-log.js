/**
 * Right-side sales card log: stamped Notater plus done actions and meetings.
 * Per-action notes in the goal list stay on the left. client.notes stays one string (AI still reads it).
 */

import { isPlaceholderMeetingId } from './offer-meetings.js';
import {
  decorateNextActions,
  formatActionFormatLabel,
} from './sales-next-actions.js';
import { salesMissedMeeting } from './sales-playbook.js';

const MAX_SALES_NOTES_LENGTH = 8000;
const STAMP = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\](?:\s|$)/;

function sanitizeText(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
}

function parseMs(value = '') {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function clipNotes(value = '') {
  const text = sanitizeText(value);
  if (text.length <= MAX_SALES_NOTES_LENGTH) return text;
  return text.slice(-MAX_SALES_NOTES_LENGTH).trim();
}

export function stampSalesNoteLine(text = '', at = new Date().toISOString()) {
  const body = sanitizeText(text);
  if (!body) return '';
  const stamp = parseMs(at) != null ? new Date(parseMs(at)).toISOString() : new Date().toISOString();
  return `[${stamp}] ${body}`;
}

export function appendStampedSalesNote(prev = '', text = '', at = new Date().toISOString()) {
  const line = stampSalesNoteLine(text, at);
  if (!line) return clipNotes(prev);
  const base = sanitizeText(prev);
  return clipNotes(base ? `${base}\n${line}` : line);
}

export function parseSalesNoteLog(notes = '') {
  const text = String(notes ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  if (!sanitizeText(text)) return [];
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    const match = line.match(STAMP);
    const at = match ? match[1] : '';
    if (match && parseMs(at) != null) {
      if (current && (current.at || sanitizeText(current.text))) entries.push(current);
      current = { at: new Date(parseMs(at)).toISOString(), text: line.slice(match[0].length) };
      continue;
    }
    if (!current) current = { at: '', text: line };
    else current.text = current.text ? `${current.text}\n${line}` : line;
  }
  if (current && (current.at || sanitizeText(current.text))) entries.push(current);
  return entries.map((entry) => ({ at: entry.at, text: sanitizeText(entry.text) })).filter((entry) => entry.text);
}

function row(partial) {
  return {
    kind: 'note',
    id: '',
    name: '',
    text: '',
    at: '',
    formatLabel: '',
    ...partial,
  };
}

function actionLogAt(action = {}) {
  if (sanitizeText(action.presetKey) === 'meeting') {
    return sanitizeText(action.dueAt) || sanitizeText(action.doneAt);
  }
  return sanitizeText(action.doneAt) || sanitizeText(action.dueAt);
}

export function buildSalesCardLog(client = {}, nowMs = Date.now()) {
  const rows = [];
  for (const [index, entry] of parseSalesNoteLog(client.notes).entries()) {
    rows.push(row({
      kind: 'note',
      id: `note:${entry.at || index}`,
      name: 'Notat',
      text: entry.text,
      at: entry.at,
    }));
  }

  const usedMeetingIds = new Set();
  const actions = decorateNextActions(client).filter((action) => (
    sanitizeText(action.doneAt) && sanitizeText(action.presetKey) !== 'sendOffer'
  ));
  for (const action of actions) {
    const meetingId = sanitizeText(action.firefliesMeetingId);
    if (meetingId) usedMeetingIds.add(meetingId);
    rows.push(row({
      kind: 'action',
      id: `action:${action.id}`,
      name: sanitizeText(action.name) || 'Handling',
      text: sanitizeText(action.note),
      at: actionLogAt(action),
      formatLabel: formatActionFormatLabel(action.format),
    }));
  }

  for (const meeting of Array.isArray(client.meetings) ? client.meetings : []) {
    const meetingId = sanitizeText(meeting.meetingId);
    if (!meetingId || usedMeetingIds.has(meetingId)) continue;
    if (isPlaceholderMeetingId(meetingId) || sanitizeText(meeting.duplicateOf)) continue;
    usedMeetingIds.add(meetingId);
    rows.push(row({
      kind: 'meeting',
      id: `meeting:${meetingId}`,
      name: sanitizeText(meeting.title) || 'Møte',
      text: sanitizeText(meeting.when),
      at: sanitizeText(meeting.startedAt || meeting.when),
      formatLabel: formatActionFormatLabel('mote'),
    }));
  }

  const playbook = client.salesPlaybook || {};
  if (sanitizeText(playbook.readUpAt)) {
    rows.push(row({
      kind: 'playbook',
      id: 'playbook:readUp',
      name: 'Les deg opp',
      at: sanitizeText(playbook.readUpAt),
    }));
  }
  if (sanitizeText(playbook.missedCalledAt)) {
    rows.push(row({
      kind: 'playbook',
      id: 'playbook:missedCall',
      name: 'Ring for ny møtetid',
      at: sanitizeText(playbook.missedCalledAt),
    }));
  }
  if (sanitizeText(client.contractSignedAt)) {
    rows.push(row({
      kind: 'playbook',
      id: 'playbook:signed',
      name: 'Kontrakt signert',
      at: sanitizeText(client.contractSignedAt),
    }));
  }
  const missed = salesMissedMeeting(client, nowMs);
  if (missed?.kind === 'auto' && sanitizeText(missed.at)) {
    rows.push(row({
      kind: 'playbook',
      id: 'playbook:missed-auto',
      name: missed.label || 'Møtet ble ikke holdt',
      at: sanitizeText(missed.at),
    }));
  }

  return rows.sort((left, right) => {
    const leftMs = parseMs(left.at) ?? 0;
    const rightMs = parseMs(right.at) ?? 0;
    if (leftMs !== rightMs) return rightMs - leftMs;
    return sanitizeText(left.name).localeCompare(sanitizeText(right.name), 'nb');
  });
}

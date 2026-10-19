/**
 * Machine mail: calendar iTIP, DSN, out-of-office, lists. Not a person writing to us.
 * Uses MIME/headers, never the subject line.
 */
import { freshReplyText } from './thread.js';

const MACHINE_LOCAL = /^(mailer-daemon|postmaster|noreply|no-reply)$/i;
const CALENDAR_MACHINE = /^(REPLY|CANCEL|COUNTER|REFRESH)$/i;

function addressLocalPart(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  const email = (angled ? angled[1] : raw).replace(/^mailto:/, '').trim();
  return email.split('@')[0] || '';
}

function calendarMethodOf(message = {}) {
  const listed = String(message.calendarMethod || '').toUpperCase();
  if (listed) return listed;
  const parts = Array.isArray(message.calendar) ? message.calendar : [];
  const fromPart = parts.map((row) => String(row?.method || '').toUpperCase()).find(Boolean);
  if (fromPart) return fromPart;
  const fromType = String(message.contentType || '').match(/method=([a-z]+)/i);
  return fromType ? fromType[1].toUpperCase() : '';
}

export function isAutomatedMail(message = {}) {
  const method = calendarMethodOf(message);
  if (CALENDAR_MACHINE.test(method)) return true;
  if (method === 'REQUEST' && !freshReplyText(message.text)) return true;
  const auto = String(message.autoSubmitted || '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/multipart\/report|message\/delivery-status/i.test(message.contentType || '')) return true;
  if (MACHINE_LOCAL.test(addressLocalPart(message.from))) return true;
  if (/^(bulk|list|junk)$/i.test(String(message.precedence || '').trim())) return true;
  if (String(message.listId || '').trim()) return true;
  return false;
}

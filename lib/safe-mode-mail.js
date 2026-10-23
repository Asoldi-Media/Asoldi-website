/**
 * Outbox sink for email senders outside lib/email.js: Brevo transactional and campaign
 * sends (WS7), Gmail API replies, or any future provider. lib/email.js (Resend, SMTP)
 * already sinks on its own.
 *
 *   const out = await outboxOrSend({ channel: 'brevo', allowKey: 'brevoSend', message, send: () => brevo.send(payload) });
 *   // safe mode off (asoldi.com) or allowKey allowed: { sent: true, result }
 *   // safe mode on:                                    { sent: false, outboxed: true, id }
 *
 * `message` uses the sendEmail shape ({ to, from, subject, text, html, replyTo, bcc, attachments })
 * so the outbox viewer can show it. The egress allowlist refuses the provider hosts anyway.
 */
import { isSafeModeActive, noteSafeModeEmail, recordIntent, safeModeAllows, safeModeDataDir } from './safe-mode.js';
import { writeOutboxEmail } from './safe-mode-outbox.js';

export async function outboxOrSend({ channel = 'email', allowKey = '', message = {}, send } = {}) {
  if (typeof send !== 'function') throw new Error('outboxOrSend needs send()');
  if (!isSafeModeActive() || (allowKey && safeModeAllows(allowKey))) {
    return { sent: true, result: await send() };
  }
  const entry = await writeOutboxEmail(safeModeDataDir(), message, { channel, transport: channel });
  noteSafeModeEmail('outboxed');
  if (allowKey) recordIntent(allowKey, `${channel} send outboxed ${entry.id}`);
  return { sent: false, outboxed: true, id: entry.id };
}

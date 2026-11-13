// A rep's own notetaker (a personal Fireflies or Fathom on their calendar) joins their meetings beside the
// hub's live join: two bots knock, the rep admits his own, and the recording lands in an account the hub
// key cannot read. Its own mails give it away in the rep's mailbox; the hub warns once a day per tool.
import { recordOpsEvent } from '../ops-events.js';
import { firefliesKeyOwnerEmail } from '../fireflies-key-owner.js';
import { parseEmailAddress } from './match-client.js';
import { appendInboxItem, listRecentInboxItems } from './store.js';

const DAY_MS = 86400000;

function text(value = '') {
  return String(value ?? '').trim();
}

/**
 * { tool: 'Fireflies' | 'Fathom', mailbox } when this mail shows the mailbox owner's own notetaker, else null.
 * A Fireflies recap of a meeting the hub key owner's account recorded ("Invited by Damian …") is not one.
 */
export function foreignNotetakerOf(message = {}) {
  const from = parseEmailAddress(message.from);
  const mailbox = text(message.mailbox).toLowerCase();
  const body = `${text(message.subject)}\n${text(message.text)}`.toLowerCase();
  if (!mailbox || mailbox === firefliesKeyOwnerEmail()) return null;
  if (from.endsWith('@fathom.video') && /notetaker|recording|meeting/.test(body)) return { tool: 'Fathom', mailbox };
  if (!from.endsWith('@fireflies.ai')) return null;
  const owner = mailbox.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&');
  const ownAccount = new RegExp(`on behalf of ${owner}|\\(${owner}\\)\\s*invited fireflies|invited by[\\s\\S]{0,120}?${owner}`).test(body)
    || /your fireflies (?:notetaker )?bot/.test(body);
  return ownAccount ? { tool: 'Fireflies', mailbox } : null;
}

/** Log it, and tell `notifyOwner(found)` at most once a day per mailbox and tool. Never throws past the hook. */
export async function ingestForeignNotetaker(message = {}, found = {}, { notifyOwner, nowMs = Date.now() } = {}) {
  const key = `${found.mailbox}:${found.tool}`;
  const told = listRecentInboxItems(400).some((item) => (
    item.kind === 'notetaker_foreign' && (item.found || []).includes(key) && nowMs - Date.parse(item.receivedAt) < DAY_MS
  ));
  appendInboxItem({
    kind: 'notetaker_foreign',
    mailbox: message.mailbox,
    messageId: `${message.id}:notetaker`,
    from: message.from,
    subject: message.subject,
    receivedAt: message.mailAt || new Date(nowMs).toISOString(),
    status: 'logged',
    reason: `notetaker:${found.tool.toLowerCase()}`,
    found: [key],
    summary: `${found.mailbox} har sin egen ${found.tool} koblet til kalenderen. Den tar opp i en konto hubben ikke leser.`,
  });
  recordOpsEvent('fireflies', 'notetaker.foreign', { mailbox: found.mailbox, tool: found.tool, notified: !told });
  if (told || typeof notifyOwner !== 'function') return { kind: 'notetaker', notified: false };
  try {
    await notifyOwner(found);
  } catch (error) {
    console.warn(`[inbox-bot] notetaker notice failed: ${text(error?.message || error)}`);
  }
  return { kind: 'notetaker', notified: true };
}

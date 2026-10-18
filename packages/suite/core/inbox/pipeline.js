/**
 * Inbox pipeline: one message in, one routed result out. Every step that touches a CRM, a store,
 * an AI or a sender is an injected adapter, so a new product only writes new adapters + a harness.
 */

import { freshReplyText } from '../mail/thread.js';

/**
 * Order: validate → already processed? → prepare (attachments to text) → classify → match →
 * mark processed → handler for the kind, or `fallback`.
 * Marking happens before handlers run, so a crashing handler never replays a reply on the next tick.
 *
 * @param {{id: string, mailbox: string, text?: string}} message
 * @param {{
 *   isProcessed: (mailbox: string, id: string) => boolean,
 *   markProcessed: (mailbox: string, id: string) => void,
 *   prepare?: (message: object) => Promise<object>,
 *   classify: (message: object, env: object) => Promise<{kind: string}>,
 *   match?: (message: object, classified: object, env: object) => object,
 *   handlers?: Record<string, (env: object) => Promise<object>>,
 *   fallback: (env: object) => Promise<object>,
 * }} adapters
 */
export async function ingestMessage(message = {}, {
  isProcessed,
  markProcessed,
  prepare = async () => ({}),
  classify,
  match = () => ({}),
  handlers = {},
  fallback,
} = {}) {
  const mailbox = String(message.mailbox || '').toLowerCase();
  const messageId = String(message.id || '');
  if (!mailbox || !messageId) return { skipped: true, reason: 'bad-message' };
  if (isProcessed(mailbox, messageId)) return { skipped: true, reason: 'already' };
  const env = { message, mailbox, messageId, fresh: freshReplyText(message.text) };
  env.prepared = (await prepare(message)) || {};
  env.classified = await classify(message, env);
  env.matched = match(message, env.classified, env) || {};
  markProcessed(mailbox, messageId);
  const handler = handlers[env.classified?.kind];
  return handler ? handler(env) : fallback(env);
}

/**
 * Round-robin mailbox ticker with a busy guard: one mailbox per tick, never two ticks at once.
 * @param {{mailboxes: string[], logPrefix?: string}} options
 */
export function createInboxTicker({ mailboxes = [], logPrefix = '[inbox]' } = {}) {
  let cursor = 0;
  let running = false;
  /**
   * @param {{listMessages: (mailbox: string) => Promise<{skipped?: boolean, reason?: string, messages?: object[]}>,
   *   prepareBatch?: (messages: object[]) => object[], ingest: (message: object) => Promise<unknown>}} adapters
   */
  return async function tick({ listMessages, prepareBatch = (messages) => messages, ingest }) {
    if (running) return { skipped: true, reason: 'busy' };
    running = true;
    try {
      const mailbox = mailboxes[cursor % mailboxes.length];
      cursor += 1;
      const listed = await listMessages(mailbox);
      if (listed.skipped) return { mailbox, skipped: true, reason: listed.reason, processed: 0 };
      let processed = 0;
      for (const message of prepareBatch(listed.messages || [])) {
        await ingest(message);
        processed += 1;
      }
      return { mailbox, skipped: false, reason: '', processed };
    } catch (error) {
      console.error(`${logPrefix} tick failed`, error?.message || error);
      return { skipped: true, reason: error?.reason || 'tick-error', processed: 0 };
    } finally {
      running = false;
    }
  };
}

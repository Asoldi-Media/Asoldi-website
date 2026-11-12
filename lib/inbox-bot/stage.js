import { isSsuSalesProduct } from '../../data/sales.js';
import { clientIsSalesWin } from '../sales-next-actions.js';

export const INBOX_BOT_STAGE_LABELS = {
  meeting: 'Møte',
  offer: 'Tilbud',
  signature: 'Venter signering',
  won: 'Solgt',
  off: 'utenfor salgstavla',
};

/**
 * Where the bot sees the client. Only 'meeting' (before Tilbud) gets replies, bookings and
 * cancellations; Tilbud, Venter signering, Solgt and off-board cards are answered by a person.
 */
export function inboxBotStage(client = {}) {
  if (!client?.id) return 'off';
  if (isSsuSalesProduct(client.product)) return 'off';
  if (String(client.status || 'active') !== 'active') return 'off';
  const progression = client.progression || {};
  if (progression.contractSigned || clientIsSalesWin(client)) return 'won';
  if (progression.offerSent) return 'signature';
  if (progression.meetingHeld) return 'offer';
  return 'meeting';
}

export function inboxBotMayAct(client = {}) {
  return inboxBotStage(client) === 'meeting';
}

import * as sales from '../../data/sales.js';
import { normalizeWorkshopAction, WORKSHOP_DEFAULT_NAME } from '../workshop-action-shared.js';
import { appendInboxItem } from './store.js';

function sanitize(value = '') {
  return String(value || '').trim();
}

export function applyWorkshopTimeFromInbox({
  salesClient,
  dueAt,
  format = '',
  mailbox,
  messageId,
  from,
  subject,
  summary,
  receivedAt,
} = {}) {
  const when = sanitize(dueAt);
  if (!when || Number.isNaN(Date.parse(when))) {
    return {
      applied: false,
      item: appendInboxItem({
        kind: 'workshop_time',
        mailbox,
        messageId,
        salesClientId: salesClient?.id || '',
        from,
        subject,
        summary: summary || 'Uklart workshop-tidspunkt.',
        receivedAt,
        status: 'unmatched',
      }),
    };
  }
  if (!salesClient?.id) {
    return {
      applied: false,
      item: appendInboxItem({
        kind: 'workshop_time',
        mailbox,
        messageId,
        from,
        subject,
        summary: summary || 'Workshop-tid uten treff på kunde.',
        receivedAt,
        status: 'unmatched',
      }),
    };
  }
  const previous = normalizeWorkshopAction(salesClient.workshopAction || {});
  const next = normalizeWorkshopAction({
    ...previous,
    name: previous.name || WORKSHOP_DEFAULT_NAME,
    dueAt: when,
    format: sanitize(format) || previous.format || 'mote',
    addToCalendar: true,
  });
  const updated = sales.setSalesWorkshopAction(salesClient.id, next);
  const row = appendInboxItem({
    kind: 'workshop_time',
    mailbox,
    messageId,
    salesClientId: salesClient.id,
    from,
    subject,
    summary: summary || 'Workshop-tid satt fra e-post.',
    receivedAt,
    status: 'applied',
  });
  return {
    applied: true,
    item: row,
    previous,
    next,
    client: updated || sales.getSalesClientById(salesClient.id),
  };
}

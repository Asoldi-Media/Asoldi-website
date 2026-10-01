/**
 * Send faktura from the admin workshop card using the existing portal invoiceRequest.
 */

import * as clientPortal from '../data/client-portal.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function requestWorkshopInvoice(client = {}) {
  const portalUserId = sanitizeText(client?.portalUserId);
  if (!portalUserId) {
    const error = new Error('Connect on Sales is required before Send faktura.');
    error.status = 400;
    error.code = 'portal-required';
    throw error;
  }
  const profile = clientPortal.getClientProfileByUserId(portalUserId);
  if (!profile) {
    const error = new Error('Connect on Sales is required before Send faktura.');
    error.status = 400;
    error.code = 'portal-required';
    throw error;
  }
  const payment = profile.payment && typeof profile.payment === 'object' ? profile.payment : {};
  const orgNumber = sanitizeText(client.orgNumber || payment.invoiceRequest?.orgNumber).replace(/\D+/g, '');
  const businessName = sanitizeText(client.businessName || payment.invoiceRequest?.businessName || profile.businessName);
  const invoiceEmail = sanitizeText(
    payment.invoiceRequest?.invoiceEmail || profile.email || client.clientEmail || client.contactEmail,
  ).toLowerCase();
  const requestedAt = new Date().toISOString();
  const updated = clientPortal.setClientPayment(portalUserId, {
    ...payment,
    status: 'invoice_requested',
    method: 'faktura',
    invoiceRequest: {
      orgNumber,
      businessName,
      invoiceEmail,
      requestedAt,
    },
  });
  return {
    ok: true,
    invoiceRequest: updated?.payment?.invoiceRequest || {
      orgNumber,
      businessName,
      invoiceEmail,
      requestedAt,
    },
  };
}

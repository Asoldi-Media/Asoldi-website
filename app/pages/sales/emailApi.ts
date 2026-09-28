import { API, salesAuthHeaders, type SalesOffer } from '../Admin/shared';

export type EmailTemplate = {
  id: string;
  key: string;
  name: string;
  subject: string;
  preheader: string;
  html: string;
  grapesProject?: unknown;
  preset?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MergeField = { token: string; label: string; sample?: string };

async function emailRequest(path: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    ...salesAuthHeaders(),
    ...(init?.headers as Record<string, string> || {}),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Request failed (${response.status})`));
  }
  return data;
}

export function listEmailTemplates() {
  return emailRequest('/admin/email-templates') as Promise<{ templates: EmailTemplate[]; mergeFields: MergeField[] }>;
}

export function saveEmailTemplate(template: Partial<EmailTemplate>) {
  const id = template.id;
  if (id) {
    return emailRequest(`/admin/email-templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(template),
    }) as Promise<{ template: EmailTemplate }>;
  }
  return emailRequest('/admin/email-templates', {
    method: 'POST',
    body: JSON.stringify(template),
  }) as Promise<{ template: EmailTemplate }>;
}

export function importEmailTemplate(payload: { name?: string; subject?: string; preheader?: string; html: string; key?: string }) {
  return emailRequest('/admin/email-templates/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  }) as Promise<{ template: EmailTemplate }>;
}

export function deleteEmailTemplate(id: string) {
  return emailRequest(`/admin/email-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function composeSalesEmail(clientId: string, template: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/compose-email?template=${encodeURIComponent(template)}`);
}

export function saveEmailDraft(payload: Record<string, unknown>) {
  return emailRequest('/admin/email-drafts', {
    method: 'POST',
    body: JSON.stringify(payload),
  }) as Promise<{ draft: { id: string }; previewPc: string; previewPhone: string }>;
}

export function sendComposedEmail(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/send-composed-email`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------- offers (tilbud) */

export type OfferTier = {
  id: string;
  name: string;
  shortName: string;
  offerName: string;
  monthlyExMva: number;
  pages: number;
  deliveryWeeks: number;
  includes: string[];
};

export type OfferReadiness = { ready: boolean; missing: { key: string; label: string }[]; message: string };

export function getClientOffer(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer`);
}

export function getClientOfferMeeting(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/meeting`);
}

export function saveClientOffer(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function startNewClientOffer(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/new`, { method: 'POST', body: '{}' });
}

export function useClientOfferMeeting(clientId: string, payload: { title?: string; meetingId?: string; clear?: boolean }) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/use-meeting`, { method: 'POST', body: JSON.stringify(payload) });
}

export function saveClientWorkshopStart(clientId: string, startDate: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ meetingQuote: { startDate } }),
  });
}

export function fillClientOffer(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/fill`, { method: 'POST', body: JSON.stringify(payload) });
}

export function requestClientOfferReview(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/request-review`, { method: 'POST', body: JSON.stringify(payload) });
}

export function sendClientOffer(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/send`, { method: 'POST', body: JSON.stringify(payload) });
}

export type OfferPreview = {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  contractFileName: string;
  contractAvailable: boolean;
  sender: { name: string; email: string; phone: string };
};

/** Renders the exact message the client will get (merge fields resolved) and saves the latest edits first. */
export function previewClientOffer(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/preview`, { method: 'POST', body: JSON.stringify(payload) }) as Promise<{
    offer: SalesOffer;
    preview: OfferPreview;
    placeholders: string[];
    readiness: OfferReadiness;
    blocker: string;
  }>;
}

export function approveClientOfferPreview(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/approve-preview`, { method: 'POST', body: '{}' }) as Promise<{ offer: SalesOffer }>;
}

/** PDF routes need the Authorization header, so fetch as a blob URL (revoke when the preview closes). */
export async function fetchAuthedPdf(path: string) {
  const response = await fetch(`${API}${path}`, { headers: salesAuthHeaders() });
  if (!response.ok) {
    const data = await response.json().catch(() => ({} as { message?: string }));
    throw new Error(String((data as { message?: string }).message || `Kunne ikke hente PDF (${response.status})`));
  }
  const buffer = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
}

/** Opens an authed PDF in a new tab. Prefer PdfPreviewOverlay + fetchAuthedPdf inside the sales terminal. */
export async function openAuthedPdf(path: string) {
  const url = await fetchAuthedPdf(path);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ----------------------------------------------------------------- admin review */

export function listAdminOffers(status = '') {
  return emailRequest(`/admin/offers${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

export function getAdminOffer(id: string) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}`);
}

export function refreshAdminOfferIntent(id: string) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}/client-intent`, { method: 'POST', body: '{}' });
}

export function saveAdminOffer(id: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function reflectAdminOfferContract(id: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}/reflect-contract`, { method: 'POST', body: JSON.stringify(payload) });
}

export function saveAdminOfferContract(id: string, summary: Record<string, unknown>) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}/contract`, { method: 'PUT', body: JSON.stringify({ summary }) });
}

export function verifyAdminOffer(id: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}/verify`, { method: 'POST', body: JSON.stringify(payload) });
}

export function reopenAdminOffer(id: string, payload: Record<string, unknown> = {}) {
  return emailRequest(`/admin/offers/${encodeURIComponent(id)}/reopen`, { method: 'POST', body: JSON.stringify(payload) });
}

export function listFirefliesMeetings(params: { unmatched?: boolean; clientId?: string } = {}) {
  const query = new URLSearchParams();
  if (params.unmatched) query.set('unmatched', '1');
  if (params.clientId) query.set('clientId', params.clientId);
  const suffix = query.toString();
  return emailRequest(`/admin/fireflies/meetings${suffix ? `?${suffix}` : ''}`);
}

export function getFirefliesMeeting(meetingId: string) {
  return emailRequest(`/admin/fireflies/meetings/${encodeURIComponent(meetingId)}`);
}

export function linkFirefliesMeeting(meetingId: string, clientId: string) {
  return emailRequest(`/admin/fireflies/meetings/${encodeURIComponent(meetingId)}/link`, { method: 'POST', body: JSON.stringify({ clientId }) });
}

export function unlinkFirefliesMeeting(meetingId: string) {
  return emailRequest(`/admin/fireflies/meetings/${encodeURIComponent(meetingId)}/unlink`, { method: 'POST', body: '{}' });
}

export function refreshFirefliesMeeting(meetingId: string) {
  return emailRequest(`/admin/fireflies/meetings/${encodeURIComponent(meetingId)}/refresh`, { method: 'POST', body: '{}' });
}

export function firefliesMediaUrl(meetingId: string, kind: 'video' | 'audio' | 'transcript') {
  const token = (salesAuthHeaders() as { Authorization?: string }).Authorization?.replace(/^Bearer\s+/i, '') || '';
  return `${API}/admin/fireflies/meetings/${encodeURIComponent(meetingId)}/media/${kind}?token=${encodeURIComponent(token)}`;
}

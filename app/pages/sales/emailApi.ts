import {
  API,
  salesAuthHeaders,
  type SalesClient,
  type SalesLiveRecording,
  type SalesMeetingRecording,
  type SalesOffer,
} from '../Admin/shared';

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

/** A failed hub request, with the status and JSON body the server answered. */
export class HubRequestError extends Error {
  status: number;
  data: Record<string, unknown>;
  /** The route is not on this server yet: no JSON came back (a 404 page, or the app shell on a GET). */
  missingRoute: boolean;

  constructor(message: string, status: number, data: Record<string, unknown>, missingRoute: boolean) {
    super(message);
    this.name = 'HubRequestError';
    this.status = status;
    this.data = data;
    this.missingRoute = missingRoute;
  }
}

export function isMissingRoute(error: unknown) {
  return error instanceof HubRequestError && error.missingRoute;
}

type HubRequestInit = RequestInit & {
  timeoutMs?: number;
  timeoutMessage?: string;
  /** A newer route an older hub may not have: a non-JSON answer then throws with missingRoute. */
  optionalRoute?: boolean;
};

const SLOW_HUB_MESSAGE = 'Serveren svarte ikke i tide. Prøv igjen.';

async function emailRequest(path: string, init?: HubRequestInit) {
  const { timeoutMs, timeoutMessage, optionalRoute, ...rest } = init || {};
  const headers: Record<string, string> = {
    ...salesAuthHeaders(),
    ...(rest.headers as Record<string, string> || {}),
  };
  if (rest.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const controller = Number(timeoutMs) > 0 ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), Number(timeoutMs)) : 0;
  try {
    const response = await fetch(`${API}${path}`, {
      ...rest,
      headers,
      signal: controller?.signal || rest.signal,
    });
    let parsed = true;
    const data = await response.json().catch(() => {
      parsed = false;
      return {} as Record<string, unknown>;
    });
    // An unknown GET falls through to the app shell (HTML, or a text 500 without a build); an unknown POST is a 404 page.
    const isGet = !rest.method || rest.method.toUpperCase() === 'GET';
    const missingRoute = Boolean(optionalRoute) && !parsed && (isGet || response.status === 404);
    if (!response.ok || missingRoute) {
      const message = String((data as { message?: string }).message || (missingRoute
        ? 'Dette finnes ikke på serveren ennå.'
        : `Request failed (${response.status})`));
      throw new HubRequestError(message, response.status, data as Record<string, unknown>, missingRoute);
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage || 'Forespørselen tok for lang tid. Prøv igjen, eller lim inn Fireflies-lenken på nytt.');
    }
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
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
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer`, { timeoutMs: 20_000 });
}

export function getClientOfferMeeting(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/meeting`, { timeoutMs: 12_000 });
}

export function saveClientOffer(clientId: string, payload: Record<string, unknown>) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function startNewClientOffer(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/new`, { method: 'POST', body: '{}' });
}

export function useClientOfferMeeting(clientId: string, payload: { title?: string; meetingId?: string; meetingIds?: string[]; clear?: boolean }) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/offer/use-meeting`, {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 20_000,
  });
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

/* ------------------------------------------------------ Fireflies recording state */

/** One sales client as jsonSalesClient presents it (liveRecordings, presented meetings). */
export function getSalesClient(clientId: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}`, {
    cache: 'no-store',
    timeoutMs: 15_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
  }) as Promise<{ client?: SalesClient }>;
}

export type LiveJoinAnswer = {
  ok?: boolean;
  queued?: boolean;
  reason?: string;
  message?: string;
  recording?: SalesLiveRecording | null;
  nextAllowedAt?: string;
  client?: SalesClient;
};

/**
 * "Send Fireflies inn nå" for one entry of client.liveRecordings. A refusal (409, or 423 in safe mode)
 * throws a HubRequestError whose data is the same LiveJoinAnswer.
 */
export function requestFirefliesLiveJoin(clientId: string, slotKey: string) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/fireflies/live-join`, {
    method: 'POST',
    body: JSON.stringify({ slotKey }),
    timeoutMs: 20_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
  }) as Promise<LiveJoinAnswer>;
}

/** "Marker uten opptak" (declined) or "Angre" (open) on a placeholder row (meetingId) or a booked slot (slotKey). */
export function setFirefliesRecordingState(
  clientId: string,
  target: { meetingId?: string; slotKey?: string },
  state: 'declined' | 'open',
) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/fireflies/recording`, {
    method: 'POST',
    body: JSON.stringify({ ...target, state }),
    timeoutMs: 20_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<{ meetingId?: string; recording?: SalesMeetingRecording | null; client?: SalesClient }>;
}

export type MeetingPurposePick = '' | 'sales' | 'workshop' | 'iteration';

/** A rep's purpose pick for one recording; '' gives the choice back to the hub. */
export function setClientMeetingPurpose(clientId: string, meetingId: string, purpose: MeetingPurposePick) {
  return emailRequest(`/admin/sales/${encodeURIComponent(clientId)}/meetings/${encodeURIComponent(meetingId)}/purpose`, {
    method: 'POST',
    body: JSON.stringify({ purpose }),
    timeoutMs: 20_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<{ client?: SalesClient }>;
}

/** "Ikke denne kunden": unlink the recording from this client and keep every later match from adding it back. */
export function excludeFirefliesMeeting(meetingId: string, clientId: string) {
  return emailRequest(`/admin/fireflies/meetings/${encodeURIComponent(meetingId)}/exclude`, {
    method: 'POST',
    body: JSON.stringify({ clientId }),
    timeoutMs: 20_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<{ ok?: boolean; client?: SalesClient }>;
}

export type MissingRecordingRow = {
  clientId: string;
  businessName: string;
  ownerId: string;
  meetingId: string;
  slotKey: string;
  kind: string;
  startedAt: string;
  meetLink: string;
  title: string;
  state: 'missing' | 'empty' | 'not-admitted';
  message: string;
  missingAt: string;
  alertedAt: string;
};

/** Booked meetings of the last 60 days that ended without a recording (a rep sees only their own clients). */
export function listMissingFirefliesRecordings() {
  return emailRequest('/admin/fireflies/missing-recordings', {
    cache: 'no-store',
    timeoutMs: 15_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<{ rows?: MissingRecordingRow[]; count?: number }>;
}

export function getFirefliesIngestStatus() {
  return emailRequest('/admin/fireflies/ingest-status', {
    cache: 'no-store',
    timeoutMs: 15_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<Record<string, unknown>>;
}

export function getFirefliesLiveJoinStatus() {
  return emailRequest('/admin/fireflies/live-join-status', {
    cache: 'no-store',
    timeoutMs: 15_000,
    timeoutMessage: SLOW_HUB_MESSAGE,
    optionalRoute: true,
  }) as Promise<Record<string, unknown>>;
}

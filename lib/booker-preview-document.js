/**
 * Forhåndsdokument from the MyPhoner booker call. Does not write Kundedata.
 */

import { deepseekChatJson } from './deepseek.js';
import { isDeepgramConfigured } from './deepgram-transcribe.js';

const PREVIEW_STATUSES = new Set(['transcribing', 'ready', 'needs-key', 'failed']);

function text(value = '') {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function persistPreviewDocument(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const status = PREVIEW_STATUSES.has(text(input.status)) ? text(input.status) : '';
  const callId = text(input.callId);
  const recordingUrl = text(input.recordingUrl);
  const transcriptChat = text(input.transcriptChat).slice(0, 80_000);
  const summary = text(input.summary).slice(0, 8_000);
  const error = text(input.error).slice(0, 400);
  if (!status && !callId && !recordingUrl && !transcriptChat && !summary) return null;
  return {
    callId,
    recordingUrl,
    status: status || (summary || transcriptChat ? 'ready' : 'failed'),
    transcriptChat,
    summary,
    generatedAt: text(input.generatedAt) || nowIso(),
    source: text(input.source) || 'deepgram',
    error,
  };
}

export function shouldEnqueueBookerPreview(client = {}, callId = '') {
  const id = text(callId || client?.myphoner?.latestCallId);
  if (!id && !text(client?.myphoner?.latestRecordingUrl)) return false;
  const current = persistPreviewDocument(client?.previewDocument);
  if (!current) return true;
  if (current.callId && id && current.callId !== id) return true;
  if (current.status === 'ready' && current.callId === id && current.transcriptChat) return false;
  if (current.status === 'transcribing' && current.callId === id) return false;
  if (current.status === 'needs-key' && current.callId === id) return isDeepgramConfigured();
  return current.status === 'failed' || !current.transcriptChat;
}

export const PREVIEW_SYSTEM = `Du skriver kontekst til en Asoldi-utvikler som skal lage en forhåndsvisning.
Kilden er et transkript. Skriv summary på norsk bokmål.

summary skal bare si hva kunden kan ønske i prosjektet, og hva som bør synes på previewen.
Ta med bare det som ble sagt eller tydelig antydet:
- sider, innhold og budskap
- funksjon (booking, skjema, meny, kart, produkter)
- uttrykk og hva en besøkende skal forstå
- noe de vil se, eller noe de sier de mangler

Ikke ta med hvem som ringte, navn, bedriftsnavn, møtetid, møtested, e-post eller telefon.
Ikke finn på sider, funksjoner eller ønsker som ikke ligger i samtalen.
Hvis samtalen sier lite om nettstedet, skriv én kort setning om at grunnlaget er tynt, og nevn bare behovet som faktisk ble sagt.
3–6 korte avsnitt. Ingen overskrifter.

Returner JSON:
{ "summary": "" }`;

export function buildBookerPreviewUserPrompt({ transcriptChat = '' } = {}) {
  return `Samtale:\n${text(transcriptChat) || '(Tomt transkript.)'}`;
}

export async function generateBookerPreviewSummary({
  client = {},
  transcriptChat = '',
  deps = {},
} = {}) {
  const chat = deps.chat;
  const fallback = 'Fant ikke noe i samtalen om hva som bør med på previewen.';
  if (typeof chat !== 'function') {
    return { summary: fallback, source: 'fallback' };
  }
  const result = await chat({
    system: PREVIEW_SYSTEM,
    user: buildBookerPreviewUserPrompt({ client, transcriptChat }),
    temperature: 0.2,
    maxTokens: 900,
  });
  const summary = text(result?.summary).slice(0, 8000);
  if (!summary) {
    const error = new Error('Forhåndsdokumentet manglet sammendrag.');
    error.status = 502;
    throw error;
  }
  return { summary, source: 'ai' };
}

export async function generateBookerPreviewSummaryWithDeepSeek(payload = {}) {
  return generateBookerPreviewSummary({
    ...payload,
    deps: { chat: deepseekChatJson },
  });
}

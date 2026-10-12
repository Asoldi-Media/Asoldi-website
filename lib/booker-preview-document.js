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

const PREVIEW_SYSTEM = `Du skriver et kort forhåndsdokument på norsk bokmål for Asoldi-utviklere.
Kilden er et transkript fra møtebookerens telefonsamtale med kunden (etter MyPhoner), med talere merket Taler 0 / Taler 1.
Dette er ikke salgsmøtet og ikke workshopen.

Skriv feltet summary: 3–8 korte avsnitt som dekker
- hvem som ringte og hvilken bedrift
- hva som ble avtalt (møte, tid, produkt hvis det ble sagt)
- interesse og hva de driver med
- begrensninger, språk, eller ting utvikleren må vite før et salgsmøte

Regler:
- Ikke finn på tidspunkt, priser eller produkter som ikke står i transkriptet.
- Ikke skriv filstier eller API-nøkler.
- Ikke lagre noe i kundedatabanken.

Returner JSON:
{ "summary": "" }`;

export function buildBookerPreviewUserPrompt({ client = {}, transcriptChat = '' } = {}) {
  return [
    `Kunde: ${text(client.businessName) || 'ukjent'}${client.industry ? ` (${text(client.industry)})` : ''}`,
    client.contactPerson ? `Kontakt: ${text(client.contactPerson)}` : '',
    `Booker-samtale:\n${text(transcriptChat) || '(Tomt transkript.)'}`,
  ].filter(Boolean).join('\n\n');
}

export async function generateBookerPreviewSummary({
  client = {},
  transcriptChat = '',
  deps = {},
} = {}) {
  const chat = deps.chat;
  const fallback = text(transcriptChat).slice(0, 1200)
    || 'Booker-samtalen er transkribert, men sammendraget mangler.';
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

/**
 * Decide whether a Fireflies workshop recording is a real workshop.
 * Hard gates first (no LLM). Then DeepSeek for content.
 */

import { deepseekChatJson } from './deepseek.js';

export const MIN_WORKSHOP_SENTENCES = 3;
export const MIN_WORKSHOP_MINUTES = 2;

function text(value = '') {
  return String(value ?? '').trim();
}

export function countTranscriptSentences(transcript = '') {
  return text(transcript)
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8).length;
}

export function workshopDurationMinutes(meeting = {}) {
  const minutes = Number(meeting?.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const raw = Number(meeting?.duration);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 0;
}

export function hardGateWorkshopTranscript({ transcript = '', durationMinutes = 0 } = {}) {
  const body = text(transcript);
  if (!body) return { ok: false, reason: 'empty' };
  const sentenceCount = countTranscriptSentences(body);
  const minutes = Number(durationMinutes) || 0;
  if (minutes > 0 && minutes < MIN_WORKSHOP_MINUTES) {
    return { ok: false, reason: 'short-duration', sentenceCount, durationMinutes: minutes };
  }
  if (sentenceCount < MIN_WORKSHOP_SENTENCES) {
    return { ok: false, reason: 'short-text', sentenceCount, durationMinutes: minutes };
  }
  return { ok: true, reason: '', sentenceCount, durationMinutes: minutes };
}

const EVAL_SYSTEM = `Du vurderer om et Fireflies-transkript er en ekte Asoldi-workshop med kunden om nettsiden.
Returner JSON: { "valid": true|false, "reason": "" }

Gyldig workshop: kunden (eller en som representerer bedriften) er med, og de snakker om nettsiden, innhold, funksjon, merkevare, sider, eller hva som skal bygges.

Ugyldig:
- tom prat, no-show, eller noen som bare sier de tar det senere
- kort intern prat mellom Asoldi-ansatte / selger uten kunden
- bare timeavtale, uten innhold om nettsiden
- under to minutter med innhold selv om teksten ser lang ut på grunn av fyllord

reason er én kort norsk setning.`;

export function buildWorkshopEvalUserPrompt({ transcript = '', durationMinutes = 0, businessName = '' } = {}) {
  return [
    businessName ? `Kunde: ${text(businessName)}` : '',
    durationMinutes ? `Varighet (minutter): ${Number(durationMinutes)}` : '',
    `Transkript:\n${text(transcript).slice(0, 12_000) || '(tomt)'}`,
  ].filter(Boolean).join('\n\n');
}

export function persistTranscriptEval(raw = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const meetingId = text(input.meetingId);
  const reason = text(input.reason).slice(0, 400);
  if (!meetingId && !reason && input.valid == null) return null;
  return {
    meetingId,
    valid: Boolean(input.valid),
    reason,
    durationMinutes: Number(input.durationMinutes) || 0,
    sentenceCount: Number(input.sentenceCount) || 0,
    evaluatedAt: text(input.evaluatedAt) || new Date().toISOString(),
    source: text(input.source) === 'ai' ? 'ai' : 'hard-gate',
  };
}

export function shouldRetryWorkshopEval(existingEval, meeting = {}) {
  const current = persistTranscriptEval(existingEval);
  if (!current) return true;
  if (current.valid) return false;
  const meetingId = text(meeting.meetingId || meeting.id);
  if (meetingId && current.meetingId && current.meetingId !== meetingId) return true;
  const minutes = workshopDurationMinutes(meeting);
  const transcript = text(meeting.transcript || meeting.summary);
  const sentences = countTranscriptSentences(transcript);
  if (minutes > (current.durationMinutes || 0) + 0.2) return true;
  if (sentences > (current.sentenceCount || 0)) return true;
  return false;
}

export async function evaluateWorkshopTranscript({
  transcript = '',
  durationMinutes = 0,
  businessName = '',
  meetingId = '',
  deps = {},
} = {}) {
  const gate = hardGateWorkshopTranscript({ transcript, durationMinutes });
  const base = {
    meetingId: text(meetingId),
    durationMinutes: gate.durationMinutes || Number(durationMinutes) || 0,
    sentenceCount: gate.sentenceCount || countTranscriptSentences(transcript),
    evaluatedAt: new Date().toISOString(),
  };
  if (!gate.ok) {
    return persistTranscriptEval({
      ...base,
      valid: false,
      reason: gate.reason,
      source: 'hard-gate',
    });
  }
  const chat = deps.chat;
  if (typeof chat !== 'function') {
    return persistTranscriptEval({
      ...base,
      valid: true,
      reason: 'hard-gate',
      source: 'hard-gate',
    });
  }
  const result = await chat({
    system: EVAL_SYSTEM,
    user: buildWorkshopEvalUserPrompt({ transcript, durationMinutes, businessName }),
    temperature: 0,
    maxTokens: 200,
  });
  return persistTranscriptEval({
    ...base,
    valid: Boolean(result?.valid),
    reason: text(result?.reason) || (result?.valid ? 'valid' : 'not-workshop'),
    source: 'ai',
  });
}

export async function evaluateWorkshopTranscriptWithDeepSeek(payload = {}) {
  return evaluateWorkshopTranscript({
    ...payload,
    deps: { chat: deepseekChatJson },
  });
}

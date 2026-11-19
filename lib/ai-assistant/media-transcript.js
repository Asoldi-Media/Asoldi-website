/**
 * Client media briefs for the AI assistant and the inbox bot. The categorizer is the shared
 * suite (packages/suite/core/media, same code website-maker runs) with the Asoldi harness.
 * This file only adds env switches, the Kundedata placement, and clientDataBank.media.briefs.
 */

import { createHash } from 'crypto';
import { describeMedia } from '../../packages/suite/core/media/describe.js';
import { mediaKindOf } from '../../packages/suite/core/media/formats.js';
import { buildMediaBriefPrompt } from '../../packages/suite/core/media/prompt.js';
import { demoteForeignBrandLogo, normalizeMediaBrief } from '../../packages/suite/core/media/normalize.js';
import { generateGeminiJson, geminiVisionModelCandidates } from '../../packages/suite/core/media/gemini.js';
import { ASOLDI_MEDIA_HARNESS, ASOLDI_MEDIA_PROMPT_VERSION, placementForKundedata } from '../../packages/suite/harness/asoldi/media.js';
import { aiKeyOrBlank } from '../safe-mode-ai.js';
import { aiTaskConfigured, hubLlm, runLlmTask } from '../llm-hooks.js';
import { geminiUsage } from '../llm/providers/gemini.js';
import { IMAGE_RULES } from '../../packages/suite/core/llm/index.js';
import { VISION_MODEL, claudeVisionLegacy, jsonObjectFrom } from '../llm/claude-vision.js';

export const PORTAL_TRANSCRIPT_VERSION = ASOLDI_MEDIA_PROMPT_VERSION;

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function envMb(name, fallback) {
  const mb = Number(process.env[name]);
  return (Number.isFinite(mb) && mb > 0 ? mb : fallback) * 1024 * 1024;
}

/** True for every image/video/audio type the categorizer reads (svg, gif, avif, ico, bmp, tiff included). */
export function isVisionMedia(fileName = '', buffer = null) {
  return mediaKindOf(fileName, buffer) !== 'other';
}

/**
 * Whether client media can be read: images by Claude (ANTHROPIC_API_KEY), audio and video by Gemini
 * (GEMINI_API_KEY; Claude has no audio or video input). CLIENT_MEDIA_VISION=0 turns both off.
 */
export function isMediaVisionEnabled(kind = 'image') {
  if (process.env.CLIENT_MEDIA_VISION === '0') return false;
  return Boolean(compact(kind === 'image' ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY));
}

/** The task that reads a file of this media kind: images on Claude, audio and video on Gemini. */
export function mediaBriefTask(kind = 'image') {
  return kind === 'image' ? 'assistant.media-brief' : 'assistant.media-brief-av';
}

export function hashMedia(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24);
}

export function buildPortalTranscriptPrompt(input = {}) {
  return buildMediaBriefPrompt({ ...input, harness: ASOLDI_MEDIA_HARNESS });
}

export function normalizePortalTranscript(raw = {}, { fileName = '', kind = 'image', businessName = '' } = {}) {
  const brief = normalizeMediaBrief(raw, {
    fileName,
    kind,
    fieldForSection: ASOLDI_MEDIA_HARNESS.fieldForSection,
    extraFields: ASOLDI_MEDIA_HARNESS.extraFields,
  });
  return demoteForeignBrandLogo(brief, businessName, { fieldForSection: ASOLDI_MEDIA_HARNESS.fieldForSection });
}

/**
 * The describeMedia `generate`. Images (task assistant.media-brief) are read by Claude: the legacy profile
 * sends the plain Claude Haiku 5.5 request, other profiles go through the hub LLM facade (data policy and
 * routes). Audio and video (task assistant.media-brief-av) need Gemini, since Claude has no audio or video
 * input: the legacy profile sends today's Gemini request (same prompt, models, timeout, output cap and
 * temperature as before), other profiles run it only when the task's route allows Gemini. Both are recorded
 * in the AI ledger.
 */
/**
 * A fetch for generateGeminiJson that notes every generateContent attempt (model, HTTP status, usage),
 * so the AI ledger gets one row per attempt when the helper moves on to the next model candidate.
 */
function attemptRecorder() {
  const attempts = [];
  const fetchImpl = async (url, init) => {
    const model = decodeURIComponent((String(url).match(/\/models\/([^/:?]+):generateContent/) || [])[1] || '');
    const started = Date.now();
    try {
      const response = await globalThis.fetch(url, init);
      let json = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      attempts.push({
        provider: 'gemini',
        model,
        servedModel: compact(json?.modelVersion) || model,
        usage: json ? geminiUsage(json) : {},
        status: response.ok ? 'ok' : 'error',
        error: response.ok ? null : { code: 'http', message: `Gemini HTTP ${response.status}` },
        latencyMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      attempts.push({ provider: 'gemini', model, status: 'error', error, latencyMs: Date.now() - started });
      throw error;
    }
  };
  return { attempts, fetchImpl };
}

/** Every attempt before the last one did not give the brief (an error or an answer that was not JSON). */
function earlierAttempts(attempts) {
  return attempts.slice(0, -1).map((attempt) => ({
    ...attempt,
    status: 'error',
    error: attempt.error || { code: 'unusable', message: 'the answer was not used; the next model was tried' },
  }));
}

function mediaBriefThroughFacade(models = [], { salesClientId = '' } = {}) {
  const clientId = compact(salesClientId);
  return async ({ prompt, mimeType, buffer }) => {
    const gemini = async (modelList) => {
      const recorder = attemptRecorder();
      const out = await generateGeminiJson({
        prompt,
        inlineParts: [{ inlineData: { mimeType, data: buffer.toString('base64') } }],
        models: modelList,
        fetchImpl: recorder.fetchImpl,
        purpose: 'media-transcript',
        timeoutMs: 45_000,
        maxOutputTokens: 1200,
        temperature: 0.1,
      });
      const last = recorder.attempts.at(-1);
      const priorAttempts = earlierAttempts(recorder.attempts);
      if (!out?.ok || !out.parsed) {
        throw Object.assign(new Error(out?.error || 'vision call failed'), {
          status: Number(out?.status) || 0,
          code: 'gemini_failed',
          ...(last ? { usage: last.usage || {}, requestedModel: last.model, servedModel: last.servedModel || last.model } : {}),
          ...(priorAttempts.length ? { priorAttempts } : {}),
        });
      }
      return {
        data: out.parsed,
        usage: last?.usage || {},
        ...(last?.model ? { requestedModel: last.model } : {}),
        servedModel: out.model || modelList[0] || '',
        ...(priorAttempts.length ? { priorAttempts } : {}),
      };
    };
    const isImage = /^image\//i.test(String(mimeType || ''));
    try {
      const result = isImage
        ? await runLlmTask('json', {
          task: 'assistant.media-brief',
          ...(clientId ? { ctx: { salesClientId: clientId } } : {}),
          user: prompt,
          images: [{ mime: mimeType, buffer }],
          maxTokens: 1200,
          legacy: {
            provider: 'claude',
            model: VISION_MODEL,
            effort: 'low',
            images: 1,
            run: async () => {
              const raw = await claudeVisionLegacy({ task: 'assistant.media-brief', prompt, images: [{ mime: mimeType, buffer }], maxTokens: 1200, effort: 'low' });
              if (raw.guarded) return { data: null, guarded: true };
              return { text: raw.text, data: jsonObjectFrom(raw.text), usage: raw.usage, servedModel: raw.servedModel, stopReason: raw.stopReason };
            },
          },
        })
        : await runLlmTask('native', {
          task: 'assistant.media-brief-av',
          ...(clientId ? { ctx: { salesClientId: clientId } } : {}),
          provider: 'gemini',
          user: prompt,
          maxTokens: 1200,
          payload: { user: prompt },
          legacy: { provider: 'gemini', model: models[0] || '', images: 0, run: () => gemini(models) },
          run: (entry) => gemini([entry.model]),
        });
      const parsed = result?.data && typeof result.data === 'object' ? result.data : null;
      return { ok: Boolean(parsed), parsed, model: result?.model || '', error: parsed ? '' : 'vision call failed' };
    } catch (error) {
      return { ok: false, parsed: null, model: '', error: compact(error?.message) || 'vision call failed' };
    }
  };
}

/**
 * One brief for a client file (Claude for an image, Gemini for audio and video), or null (vision off, unsupported type, too big, or the call failed).
 * `generate` is injectable for tests: ({prompt, mimeType, buffer}) => {ok, parsed, model} (legacy {data, model} also works).
 * `salesClientId` (the client the file belongs to, when known) is only for the ledger row.
 */
export async function transcribeClientMedia({ buffer, fileName = '', context = {}, generate, salesClientId = '' } = {}) {
  if (!buffer?.length || !isVisionMedia(fileName, buffer)) return null;
  const kind = mediaKindOf(fileName, buffer);
  const task = mediaBriefTask(kind);
  const legacyProfile = (hubLlm()?.profile?.() || 'legacy') === 'legacy';
  if (!generate && legacyProfile) {
    if (!isMediaVisionEnabled(kind)) return null;
    // Hub safe mode: no vision call unless aiCalls is allowed.
    const key = kind === 'image'
      ? aiKeyOrBlank('anthropic', process.env.ANTHROPIC_API_KEY, 'media-transcript')
      : aiKeyOrBlank('gemini', process.env.GEMINI_API_KEY, 'media-transcript');
    if (!key) return null;
  } else if (!generate && (process.env.CLIENT_MEDIA_VISION === '0' || !aiTaskConfigured(task, () => isMediaVisionEnabled(kind)))) {
    return null;
  }
  // The Gemini model list is only for audio and video; an image never reaches Gemini.
  const models = kind === 'image' ? [] : geminiVisionModelCandidates({ primary: process.env.CLIENT_MEDIA_VISION_MODEL || '' });
  const adapted = generate
    ? async (input) => {
        const out = await generate(input);
        return out?.parsed ? out : { ok: Boolean(out?.data), parsed: out?.data || null, model: out?.model || '' };
      }
    : mediaBriefThroughFacade(models, { salesClientId });
  try {
    const brief = await describeMedia({
      buffer,
      fileName,
      context,
      harness: {
        ...ASOLDI_MEDIA_HARNESS,
        // Images go to Claude as JPEG with a long edge of at most 1568 px, so they are not shrunk to Gemini's 768 px.
        limits: { maxEdge: IMAGE_RULES.maxLongEdge, maxImageBytes: envMb('CLIENT_MEDIA_VISION_MAX_IMAGE_MB', 15), maxVideoBytes: envMb('CLIENT_MEDIA_VISION_MAX_VIDEO_MB', 8) },
      },
      generate: adapted,
      models,
      timeoutMs: 45_000,
    });
    if (!brief.ok) return null;
    return { ...brief, hash: hashMedia(buffer), promptVersion: PORTAL_TRANSCRIPT_VERSION };
  } catch {
    return null;
  }
}

export function transcriptContextFromBank(bank = {}) {
  return {
    businessName: compact(bank?.businessCard?.companyName || bank?.generalInfo?.companyName),
    industry: compact(bank?.businessCard?.industry),
    businessWhat: compact(bank?.websiteCreatorQuestions?.businessWhat).slice(0, 200),
  };
}

/** Kundedata media bucket for a brief. */
export function placementFromTranscript(transcript) {
  const { bucket, isLogo, favicon } = placementForKundedata(transcript);
  return { bucket, isLogo, favicon };
}

export function briefFromTranscript(transcript, { url = '' } = {}) {
  return { ...transcript, url, source: 'portal', at: new Date().toISOString() };
}

/** Adds/replaces the brief for this url (or hash) in clientDataBank.media.briefs. */
export function withMediaBrief(bank = {}, brief) {
  if (!brief) return bank;
  const briefs = (Array.isArray(bank?.media?.briefs) ? bank.media.briefs : [])
    .filter((row) => !(row && ((brief.url && row.url === brief.url) || (brief.hash && row.hash === brief.hash && row.source === 'portal'))));
  return { ...bank, media: { ...(bank.media || {}), briefs: [...briefs, brief].slice(-200) } };
}

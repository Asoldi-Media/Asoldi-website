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
import { geminiVisionModelCandidates } from '../../packages/suite/core/media/gemini.js';
import { ASOLDI_MEDIA_HARNESS, ASOLDI_MEDIA_PROMPT_VERSION, placementForKundedata } from '../../packages/suite/harness/asoldi/media.js';

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

export function isMediaVisionEnabled() {
  return process.env.CLIENT_MEDIA_VISION !== '0' && Boolean(compact(process.env.GEMINI_API_KEY));
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
 * One Gemini brief for a client file, or null (vision off, unsupported type, too big, or the call failed).
 * `generate` is injectable for tests: ({prompt, mimeType, buffer}) => {ok, parsed, model} (legacy {data, model} also works).
 */
export async function transcribeClientMedia({ buffer, fileName = '', context = {}, generate } = {}) {
  if (!buffer?.length || !isVisionMedia(fileName, buffer)) return null;
  if (!generate && !isMediaVisionEnabled()) return null;
  const adapted = generate
    ? async (input) => {
        const out = await generate(input);
        return out?.parsed ? out : { ok: Boolean(out?.data), parsed: out?.data || null, model: out?.model || '' };
      }
    : null;
  try {
    const brief = await describeMedia({
      buffer,
      fileName,
      context,
      harness: {
        ...ASOLDI_MEDIA_HARNESS,
        limits: { maxImageBytes: envMb('CLIENT_MEDIA_VISION_MAX_IMAGE_MB', 15), maxVideoBytes: envMb('CLIENT_MEDIA_VISION_MAX_VIDEO_MB', 8) },
      },
      generate: adapted,
      models: geminiVisionModelCandidates({ primary: process.env.CLIENT_MEDIA_VISION_MODEL || '' }),
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

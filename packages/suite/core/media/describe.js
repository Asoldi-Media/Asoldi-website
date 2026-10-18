import { prepareForVision, resolveExt, mediaKindForExt } from './formats.js';
import { measureMedia } from './measure.js';
import { buildMediaBriefPrompt, CORE_PROMPT_VERSION } from './prompt.js';
import { normalizeMediaBrief } from './normalize.js';
import { generateGeminiJson, geminiVisionMaxEdge } from './gemini.js';

/**
 * The one media categorizer. Buffer in, placement brief out. Writes nothing anywhere.
 *
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.fileName
 * @param {{businessName?: string, industry?: string, businessWhat?: string}} [input.context]
 * @param {object} [input.harness] promptVersion, extraRules, extraFields, fieldForSection, labelForSection, limits
 * @param {Function} [input.generate] ({prompt, mimeType, buffer}) => {ok, parsed, model, error}; defaults to Gemini
 * @param {string[]} [input.models] Gemini model order for the default generate
 * @param {Function} [input.onUsage] token usage hook for the default generate
 */
export async function describeMedia({
  buffer,
  fileName = '',
  context = {},
  harness = {},
  generate = null,
  models = [],
  onUsage = null,
  timeoutMs = 50000,
  maxOutputTokens = 1200,
} = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const ext = resolveExt(fileName, bytes);
  const base = {
    ok: false,
    fileName,
    kind: mediaKindForExt(ext),
    error: '',
    promptVersion: Number(harness.promptVersion || CORE_PROMPT_VERSION),
    model: '',
  };
  const prepared = await prepareForVision(bytes, fileName, { maxEdge: geminiVisionMaxEdge(), ...(harness.limits || {}) });
  if (!prepared.ok) return { ...base, error: prepared.error };
  const measured = prepared.kind === 'image' ? await measureMedia(bytes, fileName) : null;
  const prompt = buildMediaBriefPrompt({ ...context, fileName, kind: prepared.kind, measured, textHint: prepared.textHint, harness });
  const call = generate
    ? await generate({ prompt, mimeType: prepared.mimeType, buffer: prepared.buffer })
    : await generateGeminiJson({
        prompt,
        inlineParts: [{ inlineData: { mimeType: prepared.mimeType, data: prepared.buffer.toString('base64') } }],
        models,
        onUsage,
        purpose: 'media-transcript',
        timeoutMs,
        maxOutputTokens,
        temperature: 0.1,
      });
  if (!call?.ok || !call.parsed) return { ...base, error: call?.error || 'vision call failed', model: call?.model || '' };
  const options = {
    fileName,
    kind: prepared.kind,
    measured,
    fieldForSection: harness.fieldForSection,
    labelForSection: harness.labelForSection,
    extraFields: harness.extraFields,
    businessName: context.businessName || '',
  };
  const brief = normalizeMediaBrief(call.parsed, options);
  if (!brief.ok || !brief.primaryWhy) {
    return { ...base, model: call.model || '', error: 'Transcript was missing a depiction or a placement reason', raw: call.parsed };
  }
  return {
    ...base,
    ...brief,
    ok: true,
    model: call.model || '',
    error: '',
    ...(prepared.converted ? { visionInput: prepared.mimeType } : {}),
    ...(prepared.textHint ? { svgText: prepared.textHint } : {}),
  };
}

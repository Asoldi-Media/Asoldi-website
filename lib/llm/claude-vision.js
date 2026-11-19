/**
 * Claude image reads for the hub's legacy profile and its data-dir off switch.
 *
 * Every image and PDF read of the hub is Claude only (Claude Haiku 5.5). The facade sends the request
 * through the shared core; this file is the same read as a plain Messages API call, for the call sites
 * that keep a `legacy.run` (legacy profile, no facade, `facade: false`), so those modes read pictures on
 * Claude too. Pictures are turned into JPEG (long edge at most 1568 px) before they leave, as the core does.
 */
import * as core from '../../packages/suite/core/llm/index.js';
import { claudeLegacyMessages, readAnthropicConfig } from '../claude-messages.js';

/** The model and effort of the legacy vision requests. Fixed on purpose: ANTHROPIC_MODEL belongs to the Infokort agent. */
export const VISION_MODEL = 'claude-haiku-5-5';
/** Adaptive thinking counts toward max_tokens; the core floors the cap at the same value. */
const MIN_MAX_TOKENS = 4096;

function clean(value) {
  return String(value ?? '').trim();
}

/** Images ({buffer|base64, mime} or {url}) as JPEG images within the Claude limits: { mime, base64 } or { url }. */
export async function prepareVisionImages(images = []) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  const out = [];
  for (const image of list) {
    if (image.url) {
      out.push(image);
      continue;
    }
    const buffer = image.buffer ? Buffer.from(image.buffer) : image.base64 ? Buffer.from(String(image.base64).replace(/^data:[^,]*,/, ''), 'base64') : null;
    const size = buffer ? core.jpegSize(buffer) : null;
    const mime = clean(image.mime || image.media_type).toLowerCase();
    if (size && Math.max(size.width, size.height) <= core.IMAGE_RULES.maxLongEdge && (!mime || mime === 'image/jpeg')) {
      out.push({ mime: 'image/jpeg', base64: buffer.toString('base64') });
    } else {
      const prepared = await core.prepareImage(buffer || image);
      out.push({ mime: prepared.mime, base64: prepared.base64 });
    }
  }
  return out;
}

function textOf(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n')
    .trim();
}

/**
 * One image question to Claude as today's plain request. Returns { text, usage, servedModel, stopReason }, or
 * { text: '', guarded: true } while hub safe mode stubs the call. Throws when no key is set or the call fails.
 */
export async function claudeVisionLegacy({ task = '', prompt = '', images = [], maxTokens = MIN_MAX_TOKENS, effort = 'low', env = process.env, fetchImpl, timeoutMs } = {}) {
  const config = { ...readAnthropicConfig(env), model: VISION_MODEL, effort };
  const blocks = core.imageBlocks(await prepareVisionImages(images));
  const out = await claudeLegacyMessages({
    task,
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: String(prompt) }] }],
    maxTokens: Math.max(MIN_MAX_TOKENS, Number(maxTokens) || 0),
    config,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (out?.safeModeStub) return { text: '', guarded: true };
  return { text: textOf(out?.content), usage: out?.usage || {}, servedModel: clean(out?.model) || VISION_MODEL, stopReason: clean(out?.stopReason) };
}

/** The first JSON object in a model answer (code fences and chatter around it are ignored), or null. */
export function jsonObjectFrom(text = '') {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

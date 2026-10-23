/**
 * Gemini for the hub: the raw generateContent call the legacy call sites use (unchanged requests, with
 * usage for the ledger), and the adapter the shared LLM core uses on non-legacy routes. The data policy
 * keeps client data off Gemini until the paid tier is confirmed (WS0.34), so on non-legacy routes Gemini
 * only serves calls the policy allows. @google/genai is loaded on first use.
 */
import { createHash } from 'node:crypto';
import { usageFromGeminiResponse } from '../../../packages/suite/core/llm/index.js';
import { guardAiCall } from '../../safe-mode-ai.js';

function clean(value) {
  return String(value ?? '').trim();
}

export function geminiKeyFrom(env = process.env) {
  return clean(env.GEMINI_API_KEY);
}

/** The text of a generateContent response (SDK `text` getter, or the first candidate's parts). */
export function geminiResponseText(response) {
  let direct = '';
  try {
    direct = response?.text || '';
  } catch {
    direct = '';
  }
  return direct || response?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').filter(Boolean).join('\n') || '';
}

/** Usage of a generateContent response in the ledger's token names (thinking counts as output). */
export function geminiUsage(response) {
  return usageFromGeminiResponse(response || {});
}

let genaiModule = null;
async function loadGenAi() {
  if (!genaiModule) genaiModule = await import('@google/genai');
  return genaiModule.GoogleGenAI;
}

/**
 * One raw generateContent call, exactly as given (model, contents, config). The legacy call sites build
 * their own request and keep their own safe-mode check (aiKeyOrBlank) and timeouts.
 * @returns {Promise<{response:object, text:string, usage:object, servedModel:string}>}
 */
export async function geminiGenerateRaw({ apiKey, request, client = null } = {}) {
  const GoogleGenAI = client ? null : await loadGenAi();
  const ai = client || new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent(request);
  return {
    response,
    text: geminiResponseText(response),
    usage: geminiUsage(response),
    servedModel: clean(response?.modelVersion) || clean(request?.model),
  };
}

function stopReasonOf(response) {
  const reason = clean(response?.candidates?.[0]?.finishReason).toUpperCase();
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(reason) || response?.promptFeedback?.blockReason) return 'refusal';
  return 'end_turn';
}

/** Core adapter: text and JSON calls with optional images (base64 or url) and a system instruction. */
export function createGeminiAdapter({ env = process.env, client = null, guard = guardAiCall } = {}) {
  return async function geminiAdapter(call) {
    const apiKey = geminiKeyFrom(env);
    if (!client && !apiKey) throw Object.assign(new Error('GEMINI_API_KEY is not set on this hub.'), { code: 'provider_dead', status: 401 });
    const parts = [];
    for (const image of call.images || []) {
      if (image?.base64 || image?.buffer) {
        const data = image.base64 ? String(image.base64).replace(/^data:[^,]*,/, '') : Buffer.from(image.buffer).toString('base64');
        parts.push({ inlineData: { mimeType: image.mime || image.media_type || 'image/jpeg', data } });
      } else if (image?.url) {
        parts.push({ fileData: { fileUri: String(image.url), mimeType: image.mime || 'image/jpeg' } });
      }
    }
    parts.push({ text: String(call.user ?? '') });
    const request = {
      model: call.model,
      contents: [{ role: 'user', parts }],
      config: {
        ...(call.system ? { systemInstruction: String(call.system) } : {}),
        ...(call.kind === 'json' ? { responseMimeType: 'application/json' } : {}),
        ...(call.maxTokens ? { maxOutputTokens: call.maxTokens } : {}),
        ...(call.signal ? { abortSignal: call.signal } : {}),
      },
    };
    // Images enter the safe-mode cassette key by hash, so two images never share a replay.
    const imageHashes = (call.images || []).map((image) => createHash('sha256').update(String(image?.base64 || image?.url || (image?.buffer ? Buffer.from(image.buffer).toString('base64') : ''))).digest('hex').slice(0, 16));
    const keyRequest = { model: call.model, system: call.system, user: call.user, images: imageHashes, kind: call.kind, maxTokens: call.maxTokens };
    const raw = await guard({
      provider: 'gemini',
      task: call.task,
      request: keyRequest,
      real: () => geminiGenerateRaw({ apiKey, request, client }),
      stub: () => ({ text: '{}', usage: {}, servedModel: call.model, response: {}, safeModeStub: true }),
      fail: () => Object.assign(new Error('Gemini is blocked by hub safe mode (HUB_SAFE_MODE_ALLOW=aiCalls).'), { code: 'safe_mode', status: 503 }),
    });
    return {
      servedModel: clean(raw?.servedModel) || call.model,
      text: String(raw?.text ?? ''),
      stopReason: stopReasonOf(raw?.response),
      usage: raw?.usage || {},
      ...(raw?.safeModeStub ? { guarded: true } : {}),
    };
  };
}

/** A free key check: models.list (used only when an admin asks for a probe). */
export async function probeGemini({ env = process.env } = {}) {
  const apiKey = geminiKeyFrom(env);
  if (!apiKey) return { ok: false, error: 'not-configured' };
  try {
    const GoogleGenAI = await loadGenAi();
    const ai = new GoogleGenAI({ apiKey });
    const pager = await ai.models.list({ config: { pageSize: 5 } });
    const first = pager?.page || [];
    return { ok: true, models: first.map((model) => model?.name).filter(Boolean).slice(0, 5) };
  } catch (error) {
    return { ok: false, status: Number(error?.status) || 0, error: clean(error?.message).slice(0, 200) || 'probe failed' };
  }
}

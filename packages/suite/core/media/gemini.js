// Gemini JSON over REST: model fallback, RPM pacing, billing breaker, thinking cap.
// The key comes from the caller or GEMINI_API_KEY; usage is reported through onUsage.

const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const DEFAULT_RPM = 12;
const RETIRED_GEMINI_MODELS = new Set(['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']);

let billingUnavailableReason = '';
let rpmWindowStart = 0;
let rpmWindowCount = 0;
const unavailableModels = new Set(RETIRED_GEMINI_MODELS);

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function envNumber(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

export function resetGeminiBillingBreaker() {
  billingUnavailableReason = '';
}

export function geminiBillingUnavailableReason() {
  return billingUnavailableReason;
}

/** Ordered, de-duplicated model list without retired or 404'd models. */
export function geminiVisionModelCandidates({ primary = '', extra = [], fallbacks = [] } = {}) {
  const ordered = [compact(primary), ...extra.map(compact), ...fallbacks.map(compact), ...DEFAULT_MODELS].filter(
    (model) => model && !unavailableModels.has(model) && !RETIRED_GEMINI_MODELS.has(model)
  );
  return [...new Set(ordered)];
}

export function geminiVisionMaxEdge() {
  return envNumber('GEMINI_VISION_MAX_EDGE', 768, 480, 1920);
}

async function waitForRpmSlot() {
  const rpm = envNumber('GEMINI_VISION_RPM', DEFAULT_RPM, 4, 60);
  const now = Date.now();
  if (now - rpmWindowStart >= 60_000) {
    rpmWindowStart = now;
    rpmWindowCount = 0;
  }
  if (rpmWindowCount >= rpm) {
    const waitMs = 60_000 - (now - rpmWindowStart) + 80;
    await new Promise((resolve) => setTimeout(resolve, Math.max(80, waitMs)));
    rpmWindowStart = Date.now();
    rpmWindowCount = 0;
  }
  rpmWindowCount += 1;
}

function stripCodeFences(text = '') {
  return String(text || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function extractGeminiJsonObject(text = '') {
  const raw = stripCodeFences(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function geminiHttpError(status, rawBody = '') {
  let message = '';
  try {
    message = compact(JSON.parse(String(rawBody || ''))?.error?.message || '');
  } catch {
    message = compact(String(rawBody || '')).slice(0, 200);
  }
  if (Number(status) === 403 && /leaked/i.test(message)) return 'Gemini API key was reported as leaked. Update GEMINI_API_KEY.';
  return `Gemini HTTP ${status}${message ? `: ${message}` : ''}`;
}

/** 404/429/5xx: try the next model. Timeouts, billing, and other HTTP errors stop immediately. */
export function geminiShouldTryNextModel(status, { timedOut = false } = {}) {
  if (timedOut) return false;
  const code = Number(status);
  if (code === 402 || code === 403) return false;
  return [404, 429, 500, 503].includes(code);
}

// 2.5 Flash thinks by default and the thoughts eat the output budget (truncated JSON).
// Flash-Lite does not think unless asked; Pro cannot turn thinking off.
export function thinkingConfigFor(model = '') {
  const name = String(model || '').toLowerCase();
  if (/flash-lite/.test(name)) return null;
  if (/2\.5-flash/.test(name)) return { thinkingBudget: 256 };
  if (/2\.5-pro/.test(name)) return { thinkingBudget: 128 };
  return null;
}

export async function generateGeminiJson({
  prompt = '',
  inlineParts = [],
  models = [],
  purpose = 'media-vision',
  timeoutMs = 20000,
  maxOutputTokens = 1400,
  temperature = 0.1,
  apiKey = process.env.GEMINI_API_KEY,
  onUsage = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (billingUnavailableReason) return { ok: false, status: 402, error: billingUnavailableReason, model: '', parsed: null };
  if (!apiKey) return { ok: false, status: 0, error: 'GEMINI_API_KEY missing', model: '', parsed: null };
  const list = (Array.isArray(models) ? models : []).map(compact).filter(Boolean);
  const candidates = (list.length ? list : geminiVisionModelCandidates()).filter((model) => model && !unavailableModels.has(model));
  const parts = [{ text: String(prompt || '') }, ...(Array.isArray(inlineParts) ? inlineParts : [])];
  let last = { ok: false, status: 0, error: 'Gemini call failed', model: '', parsed: null };
  const waitMs = Math.max(4000, Number(timeoutMs) || 20000);

  for (const model of candidates) {
    await waitForRpmSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    const thinkingConfig = thinkingConfigFor(model);
    try {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature,
              responseMimeType: 'application/json',
              maxOutputTokens,
              ...(thinkingConfig ? { thinkingConfig } : {}),
            },
          }),
        }
      );
      const raw = await response.text();
      if (!response.ok) {
        const error = geminiHttpError(response.status, raw);
        last = { ok: false, status: response.status, error, model, parsed: null };
        if (response.status === 402 || response.status === 403) {
          billingUnavailableReason = error;
          console.warn(`[gemini] ${purpose} billing blocked (${model}): ${error}`);
          break;
        }
        if (response.status === 404) unavailableModels.add(model);
        if (!geminiShouldTryNextModel(response.status)) {
          console.warn(`[gemini] ${purpose} failed (${model}): ${error}`);
          break;
        }
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        last = { ok: false, status: response.status, error: 'Gemini returned non-JSON', model, parsed: null };
        continue;
      }
      const text = json?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n') || '';
      const parsed = extractGeminiJsonObject(text);
      if (!parsed) {
        last = { ok: false, status: response.status, error: 'Gemini answer was not JSON', model, parsed: null };
        continue;
      }
      if (typeof onUsage === 'function') {
        try {
          onUsage({ provider: 'gemini', model, purpose, json });
        } catch {
          // usage logging never breaks a call
        }
      }
      return { ok: true, status: response.status, parsed, model, json, error: '' };
    } catch (error) {
      const aborted = /abort/i.test(String(error?.name || error?.message));
      last = { ok: false, status: 0, error: aborted ? 'Gemini timed out' : compact(error?.message || error), model, parsed: null };
      if (aborted || !geminiShouldTryNextModel(last.status, { timedOut: aborted })) {
        console.warn(`[gemini] ${purpose} failed (${model}): ${last.error}`);
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

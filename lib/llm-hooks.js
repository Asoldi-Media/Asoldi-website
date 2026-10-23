/**
 * Dependency-free entry point to the hub LLM facade (lib/llm).
 *
 * Several call-site modules (lib/deepseek.js, lib/workshop-transcript-eval.js, lib/ai-assistant/chat.js)
 * are also bundled into the browser app, so they cannot import lib/llm (node:fs, provider SDKs).
 * The server registers the facade at boot (lib/llm/boot.js); call sites reach it through this module.
 * Without a registered facade (browser bundle, unit tests, scripts) every call runs its legacy path
 * directly, exactly as before the facade existed.
 */
const state = { facade: null };

export function registerHubLlm(facade) {
  state.facade = facade && typeof facade === 'object' ? facade : null;
  return state.facade;
}

/** The registered facade, or null. */
export function hubLlm() {
  return state.facade;
}

/**
 * Whether a task can run right now. With the facade: its view (legacy profile: today's provider key;
 * other profiles: a configured provider on the task's route). Without it: `legacyCheck()`.
 */
export function aiTaskConfigured(task, legacyCheck) {
  const facade = state.facade;
  if (facade && typeof facade.configuredFor === 'function') {
    try {
      return Boolean(facade.configuredFor(task));
    } catch {
      // fall through to the legacy check
    }
  }
  return Boolean(typeof legacyCheck === 'function' ? legacyCheck() : legacyCheck);
}

/**
 * One LLM call of `kind` ('json' | 'text' | 'native') through the facade, or `request.legacy.run()` when
 * no facade is registered. The result always has { data, text, provider, model, passthrough }.
 *   request.legacy = { provider, model, run: async () => ({ data?, text?, usage?, servedModel? }) }
 */
export async function runLlmTask(kind, request = {}) {
  const facade = state.facade;
  if (facade && typeof facade[kind] === 'function') return facade[kind](request);
  const legacy = request.legacy;
  if (!legacy || typeof legacy.run !== 'function') {
    throw Object.assign(new Error(`No LLM facade is registered and "${request.task}" has no legacy call.`), { code: 'llm_unavailable', status: 503 });
  }
  const out = (await legacy.run()) || {};
  return {
    data: out.data,
    text: out.text ?? '',
    content: out.content,
    usage: out.usage || {},
    provider: legacy.provider || '',
    model: out.servedModel || legacy.model || '',
    passthrough: true,
    raw: out.raw,
  };
}

/**
 * Dependency-free entry point to the hub LLM facade (lib/llm).
 *
 * Several call-site modules (lib/deepseek.js, lib/workshop-transcript-eval.js, lib/ai-assistant/chat.js)
 * are also bundled into the browser app, so they cannot import lib/llm (node:fs, provider SDKs).
 * The server registers the facade at boot (lib/llm/boot.js); call sites reach it through this module.
 * Without a registered facade (browser bundle, unit tests, scripts), or while the data-dir off switch
 * is set (`facade: false` in ai-routes.override.json), every call runs its legacy path directly,
 * exactly as before the facade existed.
 */
const state = { facade: null };

export function registerHubLlm(facade) {
  state.facade = facade && typeof facade === 'object' ? facade : null;
  return state.facade;
}

/** The registered facade, whether or not the off switch is set (admin routes, the spend callback). */
export function hubLlmRegistered() {
  return state.facade;
}

/** The facade the call sites use: the registered one unless its off switch is set; otherwise null. */
export function hubLlm() {
  const facade = state.facade;
  if (!facade) return null;
  if (typeof facade.enabled === 'function') {
    try {
      if (facade.enabled() === false) return null;
    } catch {
      // a facade that cannot answer keeps serving; its calls record their own errors
    }
  }
  return facade;
}

/**
 * Whether a task can run right now. With the facade: its view (legacy profile: today's provider key;
 * other profiles: a configured provider on the task's route). Without it: `legacyCheck()`.
 */
export function aiTaskConfigured(task, legacyCheck) {
  const facade = hubLlm();
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
 * The message for a task that cannot run. Call sites that run today's provider (no facade, the off
 * switch, or the legacy profile) keep their own message; on other profiles the missing piece may be any
 * provider on the task's route, so the message names none.
 */
export function aiUnavailableMessage(task, legacyMessage) {
  const facade = hubLlm();
  let profile = 'legacy';
  try {
    profile = facade && typeof facade.profile === 'function' ? facade.profile() || 'legacy' : 'legacy';
  } catch {
    profile = 'legacy';
  }
  return profile === 'legacy' ? legacyMessage : 'AI er ikke konfigurert for denne oppgaven.';
}

/** Marks earlier provider attempts of one call on an error, so the ledger writes a row for each. */
export function withPriorAttempts(error, attempts = []) {
  if (error && typeof error === 'object' && Array.isArray(attempts) && attempts.length) {
    try {
      error.priorAttempts = [...attempts];
    } catch {
      // a frozen error keeps its own shape
    }
  }
  return error;
}

/**
 * One LLM call of `kind` ('json' | 'text' | 'native') through the facade, or `request.legacy.run()` when
 * no facade is in use. The result always has { data, text, provider, model, passthrough }.
 *   request.legacy = { provider, model, run: async () => ({ data?, text?, usage?, servedModel?, priorAttempts? }) }
 */
export async function runLlmTask(kind, request = {}) {
  const facade = hubLlm();
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

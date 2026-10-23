/**
 * Registers the hub LLM facade for the call sites (lib/llm-hooks.js). server.js imports this once.
 * HUB_LLM_FACADE=0 (optional env, read only) skips the registration: every call site then runs its
 * request directly, as before the facade, and nothing is recorded in the AI ledger.
 * A facade that fails to build is never fatal: the call sites keep their direct path.
 */
import { registerHubLlm } from '../llm-hooks.js';
import { getHubLlm } from './index.js';

export function bootHubLlm({ env = process.env, log = console } = {}) {
  if (String(env.HUB_LLM_FACADE ?? '').trim() === '0') {
    log?.log?.('[ai] LLM facade off (HUB_LLM_FACADE=0): call sites run their requests directly.');
    registerHubLlm(null);
    return null;
  }
  try {
    const facade = registerHubLlm(getHubLlm());
    log?.log?.(`[ai] LLM facade on, profile ${facade.profile()}.`);
    return facade;
  } catch (error) {
    log?.warn?.(`[ai] LLM facade not available (${error?.message || error}); call sites run their requests directly.`);
    registerHubLlm(null);
    return null;
  }
}

bootHubLlm();

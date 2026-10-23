/**
 * Dependency-free hook points for hub safe mode.
 *
 * lib/deepseek.js and lib/claude-messages.js are also bundled into the browser app
 * (through shared helpers), so they cannot import lib/safe-mode-ai.js, which pulls in
 * node:fs. They call these hooks instead; lib/safe-mode-ai.js registers the real guard
 * when it loads (lib/safe-mode-boot.js imports it on the server). Without a registered
 * guard every call runs as is.
 */
const hooks = { aiCall: null };

export function registerSafeModeAiGuard(guard) {
  hooks.aiCall = typeof guard === 'function' ? guard : null;
}

/** args: { provider, task, request, real, stub, fail } (see lib/safe-mode-ai.js guardAiCall). */
export function runAiCall(args) {
  return hooks.aiCall ? hooks.aiCall(args) : args.real();
}

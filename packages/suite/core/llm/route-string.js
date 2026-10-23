// Route strings: "provider:model[:effort][|provider:model[:effort]...]".
// The first entry is the primary; the rest are fallbacks tried in order on provider failure.

import { CLAUDE_MODELS, EFFORTS, PROVIDERS } from './constants.js';
import { RouteConfigError } from './errors.js';

export const LEGACY_PLACEHOLDER = '${legacy}';

/** Parses one route string. Throws RouteConfigError with the offending part. */
export function parseRoute(route) {
  const raw = String(route ?? '').trim();
  if (!raw) throw new RouteConfigError('Empty route string.');
  if (raw === LEGACY_PLACEHOLDER) return [{ provider: 'legacy', model: 'legacy', effort: null, raw }];
  return raw.split('|').map((part) => parseRouteEntry(part, raw));
}

export function parseRouteEntry(part, whole = part) {
  const text = String(part ?? '').trim();
  const pieces = text.split(':').map((p) => p.trim());
  if (pieces.length < 2 || pieces.length > 3 || pieces.some((p) => !p)) {
    throw new RouteConfigError(`Route entry "${text}" in "${whole}" must be provider:model[:effort].`, { route: whole });
  }
  const [providerRaw, modelRaw, effortRaw] = pieces;
  const provider = providerRaw.toLowerCase() === 'anthropic' ? 'claude' : providerRaw.toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new RouteConfigError(`Unknown provider "${providerRaw}" in "${whole}". Known: ${PROVIDERS.join(', ')}.`, { route: whole });
  }
  const model = modelRaw.toLowerCase();
  if (provider === 'claude' && !CLAUDE_MODELS.includes(model)) {
    throw new RouteConfigError(`Claude model "${modelRaw}" in "${whole}" is not allowed. Use one of ${CLAUDE_MODELS.join(', ')}.`, { route: whole });
  }
  let effort = null;
  if (effortRaw !== undefined) {
    effort = effortRaw.toLowerCase();
    if (!EFFORTS.includes(effort)) throw new RouteConfigError(`Effort "${effortRaw}" in "${whole}" must be one of ${EFFORTS.join('|')}.`, { route: whole });
  }
  return { provider, model, effort, raw: text };
}

export function formatRouteEntry(entry) {
  return [entry.provider, entry.model, entry.effort].filter(Boolean).join(':');
}

export function formatRoute(chain = []) {
  return chain.map(formatRouteEntry).join('|');
}

export function sameEntry(a, b) {
  return a && b && a.provider === b.provider && a.model === b.model;
}

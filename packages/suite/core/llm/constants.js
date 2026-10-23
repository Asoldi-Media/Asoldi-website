// Fixed vocabulary of the LLM core: providers, data classes, efforts, profiles, tiers, Claude limits.
// Everything here is part of the frozen contract (contract.js); add values, never rename them.

export const PROVIDERS = Object.freeze(['claude', 'deepseek', 'gemini', 'openai', 'replay']);

/** What each provider can take. Vision means image input; tools means a Claude-shaped tool loop. */
export const PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({ vision: true, tools: true, json: true }),
  deepseek: Object.freeze({ vision: false, tools: false, json: true }),
  gemini: Object.freeze({ vision: true, tools: false, json: true }),
  openai: Object.freeze({ vision: true, tools: false, json: true }),
  replay: Object.freeze({ vision: true, tools: true, json: true }),
});

/** Ordered from least to most sensitive. The effective class of a call is the max of all inputs. */
export const DATA_CLASSES = Object.freeze(['public', 'business', 'personal', 'transcript']);

export const TASK_KINDS = Object.freeze(['json', 'text', 'tools']);

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** `production` is accepted as an alias of `prod`. */
export const PROFILES = Object.freeze(['legacy', 'prod', 'test', 'replay', 'record']);
export const PROFILE_ALIASES = Object.freeze({ production: 'prod' });
export const DEFAULT_PROFILE = 'legacy';

export const TIERS = Object.freeze(['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']);

/** The only Claude models a route may name. */
export const CLAUDE_MODELS = Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);

export const CLAUDE_RULES = Object.freeze({
  /** Sampling parameters return 400 on these models; the request builder never emits them. */
  forbiddenParams: Object.freeze(['temperature', 'top_p', 'top_k']),
  thinking: Object.freeze({ type: 'adaptive' }),
  defaultEffort: 'medium',
  /** Thinking counts toward max_tokens, so JSON (and every other) Claude call gets at least this cap. */
  maxTokensFloor: 4096,
  /** A `max_tokens` stop is retried once on the same model with the cap doubled. */
  maxTokensRetryFactor: 2,
  maxTokensRetries: 1,
  maxOutputTokens: 128000,
  /** Non-streaming requests above this cap risk HTTP timeouts; the builder flags them for streaming. */
  streamAboveMaxTokens: 16000,
  toolChoice: 'auto',
  strictTools: true,
  /** Server-side refusal fallback (Anthropic-internal, same vendor). Haiku 5.5 has none. Not allowed on Batches. */
  serverFallback: Object.freeze({
    models: Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5']),
    value: 'default',
    beta: 'server-side-fallback-2026-07-01',
  }),
  /** A refusal is final: the item goes to review and no other vendor is tried. */
  refusal: Object.freeze({ needsReview: true, crossVendorRetry: false }),
  image: Object.freeze({ mime: 'image/jpeg', maxLongEdge: 1568, maxImages: 6, jpegQuality: 80 }),
});

/** Budget defaults per the owner decision: alert at 100 %, hard stop only for a runaway or a loop. */
export const BUDGET_RULES = Object.freeze({
  alertRatio: 1,
  runawayFactor: 5,
  loopMaxRepeats: 3,
  loopMaxIdentical: 6,
  periodicScopesMode: 'alert-only',
});

export function normalizeProfile(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  const resolved = PROFILE_ALIASES[key] || key;
  return PROFILES.includes(resolved) ? resolved : '';
}

/** Accepts 'tier-3-ecommerce', 3, '3', 'tier3', 'tier-3'. Unknown values give ''. */
export function normalizeTier(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).trim().toLowerCase();
  if (TIERS.includes(raw)) return raw;
  const digit = raw.match(/^(?:tier[-_ ]?)?([123])$/);
  return digit ? TIERS[Number(digit[1]) - 1] : '';
}

export function dataClassRank(value) {
  return DATA_CLASSES.indexOf(String(value || ''));
}

/** The most sensitive of the given classes; unknown or empty values are ignored. */
export function maxDataClass(...values) {
  let best = -1;
  for (const value of values) best = Math.max(best, dataClassRank(value));
  return best < 0 ? 'public' : DATA_CLASSES[best];
}

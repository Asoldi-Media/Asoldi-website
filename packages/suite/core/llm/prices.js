// The one price table for LLM calls, and the cost math (cache reads and writes, long-context tiers,
// batch discount, US-only inference). Every ledger row is priced here, from the model that served the call.
//
// verifiedAt is the date a person or agent read the provider's live pricing page. An entry without it is
// an estimate: the ledger flags it `priceVerified:false`, and pre-call budget estimates use CEILING.

export const PRICE_TABLE_VERSION = 1;

/** Pre-call budget rate for unverified or unknown models (USD per million tokens). */
export const CEILING = Object.freeze({ inPerM: 5, outPerM: 25 });

/** Routes may not use a price checked longer ago than this. */
export const PRICE_MAX_AGE_DAYS = 120;

const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing (live page read 2026-10-23)';
const GEMINI_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing paid tier (page last updated 2026-10-22, read 2026-10-23)';
const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/pricing standard tier (read 2026-10-23)';
const DEEPSEEK_SOURCE = 'unverified estimate: the DeepSeek pricing page listed no figures on 2026-10-23';

function entry(fields) {
  const out = { batchDiscount: 1, inferenceGeoUsMultiplier: 1, ...fields };
  if (out.longContext) out.longContext = Object.freeze({ ...out.longContext });
  return Object.freeze(out);
}

export const PRICES = Object.freeze({
  'claude-haiku-5-5': entry({
    provider: 'claude',
    inPerM: 0.1,
    outPerM: 0.5,
    cacheReadPerM: 0.01,
    cacheWrite5mPerM: 0.125,
    cacheWrite1hPerM: 0.2,
    // The prompt (input + cache read + cache write) decides the rate card for the whole request, output included.
    longContext: { thresholdTokens: 100000, inPerM: 0.5, outPerM: 2.5, cacheReadPerM: 0.05, cacheWrite5mPerM: 0.625, cacheWrite1hPerM: 1 },
    batchDiscount: 0.5,
    inferenceGeoUsMultiplier: 1.1,
    source: ANTHROPIC_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'claude-sonnet-5-5': entry({
    provider: 'claude',
    inPerM: 2,
    outPerM: 10,
    cacheReadPerM: 0.1,
    cacheWrite5mPerM: 2.5,
    cacheWrite1hPerM: 4,
    batchDiscount: 0.5,
    inferenceGeoUsMultiplier: 1.1,
    source: ANTHROPIC_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'claude-opus-5-5': entry({
    provider: 'claude',
    inPerM: 4,
    outPerM: 20,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 5,
    cacheWrite1hPerM: 8,
    batchDiscount: 0.5,
    inferenceGeoUsMultiplier: 1.1,
    source: ANTHROPIC_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'gemini-2.5-pro': entry({
    provider: 'gemini',
    inPerM: 1.25,
    outPerM: 10,
    cacheReadPerM: 0.125,
    cacheWrite5mPerM: 1.25,
    cacheWrite1hPerM: 1.25,
    longContext: { thresholdTokens: 200000, inPerM: 2.5, outPerM: 15, cacheReadPerM: 0.25, cacheWrite5mPerM: 2.5, cacheWrite1hPerM: 2.5 },
    batchDiscount: 0.5,
    source: GEMINI_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'gemini-2.5-flash': entry({
    provider: 'gemini',
    inPerM: 0.3,
    outPerM: 2.5,
    cacheReadPerM: 0.03,
    cacheWrite5mPerM: 0.3,
    cacheWrite1hPerM: 0.3,
    batchDiscount: 0.5,
    source: GEMINI_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'gemini-2.5-flash-lite': entry({
    provider: 'gemini',
    inPerM: 0.1,
    outPerM: 0.4,
    cacheReadPerM: 0.01,
    cacheWrite5mPerM: 0.1,
    cacheWrite1hPerM: 0.1,
    batchDiscount: 0.5,
    source: GEMINI_SOURCE,
    verifiedAt: '2026-10-23',
  }),
  'gpt-4.1': entry({ provider: 'openai', inPerM: 2, outPerM: 8, cacheReadPerM: 0.5, source: OPENAI_SOURCE, verifiedAt: '2026-10-23' }),
  'gpt-4.1-mini': entry({ provider: 'openai', inPerM: 0.4, outPerM: 1.6, cacheReadPerM: 0.1, source: OPENAI_SOURCE, verifiedAt: '2026-10-23' }),
  'gpt-4o': entry({ provider: 'openai', inPerM: 2.5, outPerM: 10, cacheReadPerM: 1.25, source: OPENAI_SOURCE, verifiedAt: '2026-10-23' }),
  'gpt-4o-mini': entry({ provider: 'openai', inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.075, source: OPENAI_SOURCE, verifiedAt: '2026-10-23' }),
  'deepseek-flash': entry({ provider: 'deepseek', inPerM: 0.27, outPerM: 1.1, cacheReadPerM: 0.07, source: DEEPSEEK_SOURCE, verifiedAt: null }),
  'deepseek-v4-pro': entry({ provider: 'deepseek', inPerM: 0.55, outPerM: 2.19, cacheReadPerM: 0.14, source: DEEPSEEK_SOURCE, verifiedAt: null }),
  'deepseek-chat': entry({ provider: 'deepseek', inPerM: 0.27, outPerM: 1.1, cacheReadPerM: 0.07, source: DEEPSEEK_SOURCE, verifiedAt: null }),
  'deepseek-reasoner': entry({ provider: 'deepseek', inPerM: 0.55, outPerM: 2.19, cacheReadPerM: 0.14, source: DEEPSEEK_SOURCE, verifiedAt: null }),
});

export function priceEntry(model = '', table = PRICES) {
  const key = String(model || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

export function isPriceVerified(model, table = PRICES) {
  return Boolean(priceEntry(model, table)?.verifiedAt);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Usage in the core's shape; accepts the core's names or Anthropic's snake_case names. */
export function normalizeUsage(usage = {}) {
  const u = usage || {};
  const cacheCreation = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  let write5m = num(u.cacheWrite5mTokens ?? cacheCreation?.ephemeral_5m_input_tokens);
  const write1h = num(u.cacheWrite1hTokens ?? cacheCreation?.ephemeral_1h_input_tokens);
  const writeTotal = num(u.cacheWriteTokens ?? u.cache_creation_input_tokens);
  // A total with no TTL breakdown is a 5-minute write (the default TTL).
  if (!write5m && !write1h && writeTotal) write5m = writeTotal;
  return {
    inputTokens: num(u.inputTokens ?? u.input_tokens),
    outputTokens: num(u.outputTokens ?? u.output_tokens),
    cacheReadTokens: num(u.cacheReadTokens ?? u.cache_read_input_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
  };
}

export function promptTokens(usage) {
  const u = normalizeUsage(usage);
  return u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
}

function round(value) {
  return Math.round(value * 1e10) / 1e10;
}

/** The rate card that applies to a request with this prompt size. */
export function rateCard(entryValue, usage) {
  if (!entryValue) return null;
  const long = entryValue.longContext;
  if (long && promptTokens(usage) > long.thresholdTokens) return { ...entryValue, ...long };
  return entryValue;
}

/**
 * Cost of one call in USD.
 * @returns {{usd:number, priceVerified:boolean, priceKnown:boolean, model:string, longContext:boolean}}
 * Unknown models are priced at CEILING and flagged; cache categories fall back to the input rate.
 */
export function priceUsage({ model = '', usage = {}, batch = false, inferenceGeo = '', table = PRICES } = {}) {
  const u = normalizeUsage(usage);
  const known = priceEntry(model, table);
  const card = known ? rateCard(known, u) : { ...CEILING };
  const inRate = card.inPerM;
  const usd =
    u.inputTokens * inRate +
    u.outputTokens * card.outPerM +
    u.cacheReadTokens * (card.cacheReadPerM ?? inRate) +
    u.cacheWrite5mTokens * (card.cacheWrite5mPerM ?? inRate) +
    u.cacheWrite1hTokens * (card.cacheWrite1hPerM ?? inRate);
  let multiplier = 1;
  if (batch && known) multiplier *= known.batchDiscount || 1;
  if (String(inferenceGeo).toLowerCase() === 'us' && known) multiplier *= known.inferenceGeoUsMultiplier || 1;
  return {
    usd: round((usd / 1e6) * multiplier),
    priceVerified: Boolean(known?.verifiedAt),
    priceKnown: Boolean(known),
    model: String(model || ''),
    longContext: Boolean(known?.longContext && card !== known),
  };
}

/**
 * Cost of a Claude response, priced from the model that served it. With a server-side fallback the
 * response carries `usage.iterations` (one entry per attempt); those are the billing source of truth.
 * An iteration without its own `model` is priced at the requested model for a declined `message`
 * attempt and at `response.model` for the `fallback_message` attempt that served the reply.
 */
export function priceResponse({ requestedModel = '', response = {}, batch = false, inferenceGeo = '', table = PRICES } = {}) {
  const servedModel = String(response?.model || requestedModel || '');
  const usage = response?.usage || {};
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (!iterations.length) {
    return { ...priceUsage({ model: servedModel, usage, batch, inferenceGeo, table }), servedModel, attempts: 1 };
  }
  let usd = 0;
  let verified = true;
  let knownAll = true;
  for (const item of iterations) {
    const model = String(item?.model || (item?.type === 'fallback_message' ? servedModel : requestedModel || servedModel));
    const priced = priceUsage({ model, usage: item, batch, inferenceGeo, table });
    usd += priced.usd;
    verified = verified && priced.priceVerified;
    knownAll = knownAll && priced.priceKnown;
  }
  return { usd: round(usd), priceVerified: verified, priceKnown: knownAll, model: servedModel, servedModel, attempts: iterations.length, longContext: false };
}

/**
 * Rates for a pre-call budget estimate: the listed rates when verified, CEILING otherwise.
 * Estimates are deliberately pessimistic for models nobody has priced.
 */
export function budgetRates(model, table = PRICES) {
  const known = priceEntry(model, table);
  return known?.verifiedAt ? { inPerM: known.inPerM, outPerM: known.outPerM, verified: true } : { ...CEILING, verified: false };
}

export function estimateCallUsd({ model = '', inputTokens = 0, outputTokens = 0, table = PRICES } = {}) {
  const known = priceEntry(model, table);
  const rates = budgetRates(model, table);
  let inRate = rates.inPerM;
  let outRate = rates.outPerM;
  if (rates.verified && known?.longContext && num(inputTokens) > known.longContext.thresholdTokens) {
    inRate = known.longContext.inPerM;
    outRate = known.longContext.outPerM;
  }
  return round((num(inputTokens) * inRate + num(outputTokens) * outRate) / 1e6);
}

function daysBetween(fromIso, now) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  if (!Number.isFinite(from)) return Infinity;
  return (now.getTime() - from) / 86_400_000;
}

/**
 * Checks every model a set of routes names. `missing` and `stale` are errors; `unverified` is a warning
 * (the model is priced at CEILING for budgets until someone reads its pricing page).
 */
export function checkModelPrices(models = [], { now = new Date(), maxAgeDays = PRICE_MAX_AGE_DAYS, table = PRICES } = {}) {
  const missing = [];
  const unverified = [];
  const stale = [];
  for (const model of [...new Set(models.map((m) => String(m || '').toLowerCase()).filter(Boolean))]) {
    const known = priceEntry(model, table);
    if (!known) missing.push(model);
    else if (!known.verifiedAt) unverified.push(model);
    else if (daysBetween(known.verifiedAt, now) > maxAgeDays) stale.push(model);
  }
  return { ok: !missing.length && !stale.length, missing, unverified, stale };
}

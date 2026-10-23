// Data policy: which provider may see which data class.
//
// Two rules are hard-coded and a config file can only make them stricter:
//   1. DeepSeek never receives personal or transcript data.
//   2. Gemini receives anything above `public` only when the policy records a confirmed paid tier
//      (free-tier Gemini API data may be used by Google).
// Any payload carrying person fields (names of people, email, phone, address) counts as personal.

import { DATA_CLASSES, PROVIDERS, dataClassRank, maxDataClass } from './constants.js';
import { PolicyBlockedError, RouteConfigError } from './errors.js';
import { formatRouteEntry, parseRoute } from './route-string.js';

export const DEFAULT_REDIRECT = 'claude:claude-haiku-5-5:low';
const NEVER_PERSONAL = new Set(['deepseek']);
const BILLING_TIERS = ['paid', 'free', 'unknown'];

/**
 * { version:1, providers: { gemini: { allow:[...], billingTier:'paid'|'free'|'unknown', paidTierConfirmedAt:'2026-10-23'|null,
 *   dpa?:string, confirmedBy?:string, note?:string }, ... }, redirect: 'claude:claude-haiku-5-5:low' }
 */
export function validatePolicy(policy) {
  const errors = [];
  const warnings = [];
  if (!policy || typeof policy !== 'object') return { ok: false, errors: ['policy must be an object'], warnings };
  if (policy.version !== 1) errors.push('policy.version must be 1');
  const providers = policy.providers;
  if (!providers || typeof providers !== 'object') errors.push('policy.providers must be an object');
  for (const [name, spec] of Object.entries(providers || {})) {
    if (!PROVIDERS.includes(name)) errors.push(`policy.providers.${name}: unknown provider`);
    if (!spec || !Array.isArray(spec.allow)) {
      errors.push(`policy.providers.${name}.allow must be a list of data classes`);
      continue;
    }
    for (const cls of spec.allow) if (!DATA_CLASSES.includes(cls)) errors.push(`policy.providers.${name}.allow: unknown class "${cls}"`);
    if (spec.billingTier !== undefined && !BILLING_TIERS.includes(spec.billingTier)) errors.push(`policy.providers.${name}.billingTier must be ${BILLING_TIERS.join('|')}`);
    if (NEVER_PERSONAL.has(name) && spec.allow.some((cls) => cls === 'personal' || cls === 'transcript')) {
      warnings.push(`policy.providers.${name} allows personal/transcript; the core ignores that and never sends them to ${name}.`);
    }
  }
  try {
    redirectRoute(policy);
  } catch (error) {
    errors.push(`policy.redirect: ${error.message}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** The route used when the policy removes every entry of a chain. Accepts the older "next-allowed-in-chain-else-<route>" form. */
export function redirectRoute(policy = {}) {
  const raw = String(policy?.redirect || DEFAULT_REDIRECT).replace(/^next-allowed-in-chain-else-/, '');
  return parseRoute(raw);
}

const PERSON_KEY = /^(?:first|last|full|given|family|middle|sur|contact|owner|person|customer|employee|staff|founder|daglig[-_]?leder)[-_ ]?(?:name|navn)$|^(?:e-?mail|e-?post|emails|phone|phones|telefon|telephone|mobile|mobil|tlf|address|adresse|street|gateadresse|postal[-_ ]?address|home[-_ ]?address|birth[-_ ]?date|date[-_ ]?of[-_ ]?birth|fødselsdato|fodselsdato|personnummer|fødselsnummer|fodselsnummer|ssn|national[-_ ]?id|contact[-_ ]?person|kontaktperson|people|persons|employees|staff)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// International numbers need a leading +. Local numbers: 8 digits, or 2-2-2-2 / 3-2-3 groups split by single
// spaces. Dashes are not accepted as separators, so ISO dates (2026-10-23) never look like phones, and digits
// glued to letters (ids, base64) are not phones either.
const PHONE = /(?:\+\d{1,3}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4}){1,4})|(?:(?<![\w-])\d{8}(?![\w-]))|(?:\b\d{2} \d{2} \d{2} \d{2}\b)|(?:\b\d{3} \d{2} \d{3}\b)/;

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') return Object.values(value).some(hasValue);
  return true;
}

/**
 * Finds person fields in a payload: keys that name a person's data (with a value) and email or phone
 * patterns in any string. Bounded walk, so a huge payload cannot stall a call.
 * @returns {{found:boolean, fields:string[], patterns:string[]}}
 */
export function detectPersonFields(payload, { maxNodes = 5000, maxChars = 400000 } = {}) {
  const fields = [];
  const patterns = new Set();
  let nodes = 0;
  let chars = 0;
  const scanString = (text) => {
    if (chars > maxChars) return;
    const slice = text.slice(0, Math.max(0, maxChars - chars));
    chars += slice.length;
    if (EMAIL.test(slice)) patterns.add('email');
    if (PHONE.test(slice)) patterns.add('phone');
  };
  const walk = (value, path) => {
    if (nodes++ > maxNodes || value === null || value === undefined) return;
    if (typeof value === 'string') return scanString(value);
    if (typeof value !== 'object') return;
    // Image and document blocks carry base64, not person data.
    if (value.type === 'image' || value.type === 'document') return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (PERSON_KEY.test(key) && hasValue(child)) fields.push(at);
      walk(child, at);
    }
  };
  walk(payload, '');
  return { found: fields.length > 0 || patterns.size > 0, fields, patterns: [...patterns] };
}

/**
 * The data class a call is handled as.
 *   effective = max(task class, ctx.dataClass, 'personal' if the payload carries person fields)
 *   ctx.synthetic === true  -> 'public' (fixture data, no real person behind it)
 *   ctx.redacted === true   -> personal/transcript count as 'business' (caller ran a redaction check)
 */
export function effectiveDataClass({ task = {}, ctx = {}, payload } = {}) {
  const declared = task.dataClass || 'public';
  const call = DATA_CLASSES.includes(ctx.dataClass) ? ctx.dataClass : null;
  const detection = payload === undefined ? { found: false, fields: [], patterns: [] } : detectPersonFields(payload);
  const detected = detection.found ? 'personal' : null;
  const reasons = [];
  let effective = maxDataClass(declared, call, detected);
  if (call && dataClassRank(call) > dataClassRank(declared)) reasons.push(`ctx.dataClass=${call}`);
  if (detected && dataClassRank(detected) > dataClassRank(maxDataClass(declared, call))) {
    reasons.push(`person fields: ${[...detection.fields.slice(0, 5), ...detection.patterns].join(', ')}`);
  }
  if (ctx.synthetic === true) {
    effective = 'public';
    reasons.push('synthetic fixture data');
  } else if (ctx.redacted === true && (effective === 'personal' || effective === 'transcript')) {
    effective = 'business';
    reasons.push('redacted payload');
  }
  return { declared, call, detected, effective, reasons, personFields: detection };
}

/** Whether `provider` may see `dataClass` under `policy`. */
export function providerAllows(policy, provider, dataClass) {
  if (provider === 'replay') return { allowed: true, reason: 'replay' };
  if (NEVER_PERSONAL.has(provider) && (dataClass === 'personal' || dataClass === 'transcript')) {
    return { allowed: false, reason: `${provider} never receives ${dataClass} data` };
  }
  const spec = policy?.providers?.[provider];
  if (!spec) return { allowed: false, reason: `${provider} is not listed in the data policy` };
  if (!Array.isArray(spec.allow) || !spec.allow.includes(dataClass)) {
    return { allowed: false, reason: `policy does not allow ${dataClass} data on ${provider}` };
  }
  if (provider === 'gemini' && dataClass !== 'public' && !(spec.billingTier === 'paid' && spec.paidTierConfirmedAt)) {
    return { allowed: false, reason: 'gemini paid tier not confirmed; only public data may go there' };
  }
  return { allowed: true, reason: '' };
}

/**
 * Drops chain entries the policy forbids. When nothing is left, the policy redirect route is used
 * if it is allowed; otherwise PolicyBlockedError.
 * @returns {{chain:object[], redirects:{from:string, to:string|null, reason:string}[]}}
 */
export function applyPolicy(chain = [], dataClass = 'public', policy = {}) {
  const allowed = [];
  const blocked = [];
  for (const entry of chain) {
    const verdict = providerAllows(policy, entry.provider, dataClass);
    if (verdict.allowed) allowed.push(entry);
    else blocked.push({ from: formatRouteEntry(entry), reason: verdict.reason });
  }
  if (allowed.length) {
    const to = blocked.length ? formatRouteEntry(allowed[0]) : null;
    return { chain: allowed, redirects: blocked.map((b) => ({ ...b, to })) };
  }
  let fallback;
  try {
    fallback = redirectRoute(policy);
  } catch (error) {
    throw new RouteConfigError(`Policy redirect route is invalid: ${error.message}`);
  }
  const usable = fallback.filter((entry) => providerAllows(policy, entry.provider, dataClass).allowed);
  if (!usable.length) {
    throw new PolicyBlockedError(`No provider in the route may receive ${dataClass} data.`, { dataClass, blocked });
  }
  const to = formatRouteEntry(usable[0]);
  return { chain: usable, redirects: blocked.map((b) => ({ ...b, to })) };
}

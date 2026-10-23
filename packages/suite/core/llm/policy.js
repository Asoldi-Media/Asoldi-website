// Data policy: which provider may see which data class (owner decision Q5).
//
// Hard rules, hard-coded; a config file can only make them stricter:
//   1. DeepSeek never receives personal or transcript data.
//   2. DeepSeek receives anything above `public` (real client data) only when the call is synthetic or
//      redacted, and the payload check agrees (no real-looking email or phone is left).
//   3. Gemini receives data only when the policy records a confirmed paid tier (free-tier Gemini API data
//      may be used by Google). `allowUnpaidPublic: true` opts public data back in; the default is off.
// A provider spec may also carry `tasks` / `families`: the provider is then used only for those tasks
// (OpenAI is the third evaluation judge and nothing else).
// Any payload carrying person fields (names of people, email, phone, address) counts as personal.
// The policy applies in every profile, `legacy` included.

import { DATA_CLASSES, PROVIDERS, dataClassRank, maxDataClass } from './constants.js';
import { PolicyBlockedError, RouteConfigError } from './errors.js';
import { formatRouteEntry, parseRoute } from './route-string.js';
import { FAMILY_PATTERN, TASK_KEY_PATTERN } from './tasks-schema.js';

export const DEFAULT_REDIRECT = 'claude:claude-haiku-5-5';
const NEVER_PERSONAL = new Set(['deepseek']);
const CLIENT_DATA_ONLY_SYNTHETIC_OR_REDACTED = new Set(['deepseek']);
const BILLING_TIERS = ['paid', 'free', 'unknown'];

/**
 * { version:1, providers: { gemini: { allow:[...], billingTier:'paid'|'free'|'unknown', paidTierConfirmedAt:'2026-10-23'|null,
 *   allowUnpaidPublic?:boolean, tasks?:string[], families?:string[], dpa?:string, confirmedBy?:string, note?:string }, ... },
 *   redirect: 'claude:claude-haiku-5-5' }
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
    if (spec.allowUnpaidPublic !== undefined && typeof spec.allowUnpaidPublic !== 'boolean') errors.push(`policy.providers.${name}.allowUnpaidPublic must be true or false`);
    if (spec.tasks !== undefined && !(Array.isArray(spec.tasks) && spec.tasks.every((t) => TASK_KEY_PATTERN.test(String(t))))) errors.push(`policy.providers.${name}.tasks must be a list of task keys`);
    if (spec.families !== undefined && !(Array.isArray(spec.families) && spec.families.every((f) => FAMILY_PATTERN.test(String(f))))) errors.push(`policy.providers.${name}.families must be a list of kebab-case families`);
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

// ---------- person-field detection ----------

const PERSON_KEY = /^(?:first|last|full|given|family|middle|sur|contact|owner|person|customer|employee|staff|founder|daglig[-_]?leder)[-_ ]?(?:name|navn)$|^(?:e-?mail|e-?post|emails|phone|phones|telefon|telephone|mobile|mobil|tlf|address|adresse|street|gateadresse|postal[-_ ]?address|home[-_ ]?address|birth[-_ ]?date|date[-_ ]?of[-_ ]?birth|fødselsdato|fodselsdato|personnummer|fødselsnummer|fodselsnummer|ssn|national[-_ ]?id|contact[-_ ]?person|kontaktperson|people|persons|employees|staff)$/i;

// International numbers need a leading +. Local numbers: 8 digits, or 2-2-2-2 / 3-2-3 groups split by single
// spaces. Dashes are not separators, so ISO dates never look like phones; digits glued to letters (ids,
// base64) are not phones; a group inside a longer run of numbers (SVG paths, coordinates) is not a phone.
// Every alternative has bounded quantifiers, so the scan is linear in the text length.
const PHONE = new RegExp(
  [
    String.raw`\+\d{1,3}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4}){1,4}`,
    String.raw`(?<![\w.,-])\d{8}(?![\w-]|[.,]\d)`,
    String.raw`(?<![\d.,][ ,]?)(?<![\w-])\d{2} \d{2} \d{2} \d{2}(?![ ,]?\d)(?![.,]\d)`,
    String.raw`(?<![\d.,][ ,]?)(?<![\w-])\d{3} \d{2} \d{3}(?![ ,]?\d)(?![.,]\d)`,
  ].join('|'),
  'g',
);
// YYYYMMDD written without separators is a date, not a phone.
const COMPACT_DATE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Reserved fixture values. A synthetic payload may only carry these; anything else looks real.
 *   email: a domain under example.<tld> or example, or a .test / .invalid / .example / .localhost TLD
 *   phone: the national part (last 8 digits) starts with 0 (no Norwegian subscriber number does), repeats one
 *          digit, is 12345678 / 87654321, or is in the US 555-0100..0199 fiction range
 */
export const FIXTURE_RULES = Object.freeze({
  emailDomain: 'example.<tld>, *.example.<tld>, *.test, *.invalid, *.example, *.localhost',
  phone: 'national part starts with 0, repeats one digit, 12345678, 87654321, or US 555-01xx',
});
const FIXTURE_DOMAIN = /(?:^|\.)example(?:\.[a-z]{2,24})?$|\.(?:test|invalid|example|localhost)$/;

export function isFixtureEmailDomain(domain = '') {
  return FIXTURE_DOMAIN.test(String(domain).toLowerCase());
}

export function isFixturePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (/^1?55501\d\d$/.test(digits.slice(-10)) || /55501\d\d$/.test(digits)) return true;
  const national = digits.slice(-8);
  if (!national) return false;
  return national.startsWith('0') || /^(\d)\1+$/.test(national) || national === '12345678' || national === '87654321';
}

const MAX_AT_CANDIDATES = 10000;

function isLocalChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45;
}

function isDomainChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 45;
}

function validDomain(domain) {
  const labels = domain.split('.');
  if (labels.length < 2 || labels.length > 10) return false;
  for (const label of labels) {
    if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return false;
  }
  return /^[a-z]{2,24}$/i.test(labels[labels.length - 1]);
}

/**
 * Calls visit(domain) for each email address in `text`. Linear: it jumps from '@' to '@' and looks at most
 * 64 characters back (local part) and 253 forward (domain). Stops when visit returns true.
 */
function scanEmails(text, visit) {
  let at = text.indexOf('@');
  let candidates = 0;
  while (at !== -1 && candidates < MAX_AT_CANDIDATES) {
    candidates += 1;
    let start = at;
    while (start > 0 && at - start < 64 && isLocalChar(text.charCodeAt(start - 1))) start -= 1;
    let end = at + 1;
    while (end < text.length && end - at - 1 < 253 && isDomainChar(text.charCodeAt(end))) end += 1;
    if (start < at && end > at + 1) {
      const domain = text.slice(at + 1, end).replace(/[.-]+$/, '').toLowerCase();
      if (validDomain(domain) && visit(domain)) return;
    }
    at = text.indexOf('@', at + 1);
  }
}

function scanPhones(text, visit) {
  PHONE.lastIndex = 0;
  let count = 0;
  for (const match of text.matchAll(PHONE)) {
    if (++count > MAX_AT_CANDIDATES) return;
    const value = match[0];
    if (/^\d{8}$/.test(value) && COMPACT_DATE.test(value)) continue;
    if (visit(value)) return;
  }
}

// Redaction placeholders count as empty: [NAME], <email>, ***, xxx, REDACTED, anonymisert, fjernet.
const PLACEHOLDER = /^\s*(?:\[[^\]]{0,40}\]|<[^>]{0,40}>|\{\{?[^}]{0,40}\}?\}|\*+|x{2,}|redacted|removed|anonymi[sz]ed|anonymisert|fjernet|skjult)\s*$/i;

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0 && !PLACEHOLDER.test(value);
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') return Object.values(value).some(hasValue);
  return true;
}

/**
 * Finds person fields in a payload: keys that name a person's data (with a real value, not a redaction
 * placeholder) and email or phone patterns in any string. Bounded walk and linear-time scans, so a huge or
 * hostile payload cannot stall a call.
 * @returns {{found:boolean, fields:string[], patterns:string[], realPatterns:string[]}}
 *   patterns: kinds found at all; realPatterns: kinds with at least one value that is not a reserved fixture value
 */
export function detectPersonFields(payload, { maxNodes = 5000, maxChars = 400000 } = {}) {
  const fields = [];
  const patterns = new Set();
  const real = new Set();
  let nodes = 0;
  let chars = 0;
  const scanString = (text) => {
    if (chars >= maxChars) return;
    const slice = text.length > maxChars - chars ? text.slice(0, maxChars - chars) : text;
    chars += slice.length;
    if (slice.includes('@')) {
      scanEmails(slice, (domain) => {
        patterns.add('email');
        if (!isFixtureEmailDomain(domain)) real.add('email');
        return real.has('email');
      });
    }
    if (/\d/.test(slice)) {
      scanPhones(slice, (value) => {
        patterns.add('phone');
        if (!isFixturePhone(value)) real.add('phone');
        return real.has('phone');
      });
    }
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
  return { found: fields.length > 0 || patterns.size > 0, fields, patterns: [...patterns], realPatterns: [...real] };
}

/**
 * The data class a call is handled as.
 *   effective = max(task class, ctx.dataClass, 'personal' if the payload carries person fields)
 *   ctx.synthetic === true -> 'public' (fixture data), unless the payload holds a real-looking email or phone
 *   ctx.redacted === true  -> personal/transcript count as 'business', unless the payload still holds person
 *                             fields, or an email or phone that is not a fixture value (the redaction failed)
 * `synthetic` / `redacted` in the result say whether the flag was accepted; the policy reads them.
 */
export function effectiveDataClass({ task = {}, ctx = {}, payload } = {}) {
  const declared = task.dataClass || 'public';
  const call = DATA_CLASSES.includes(ctx.dataClass) ? ctx.dataClass : null;
  const detection = payload === undefined ? { found: false, fields: [], patterns: [], realPatterns: [] } : detectPersonFields(payload);
  const detected = detection.found ? 'personal' : null;
  const reasons = [];
  let effective = maxDataClass(declared, call, detected);
  if (call && dataClassRank(call) > dataClassRank(declared)) reasons.push(`ctx.dataClass=${call}`);
  if (detected && dataClassRank(detected) > dataClassRank(maxDataClass(declared, call))) {
    reasons.push(`person fields: ${[...detection.fields.slice(0, 5), ...detection.patterns].join(', ')}`);
  }
  let synthetic = false;
  let redacted = false;
  if (ctx.synthetic === true) {
    if (detection.realPatterns.length) {
      reasons.push(`synthetic flag ignored: real-looking ${detection.realPatterns.join('/')} in the payload`);
    } else {
      synthetic = true;
      effective = 'public';
      reasons.push('synthetic fixture data');
    }
  } else if (ctx.redacted === true) {
    if (detection.realPatterns.length || detection.fields.length) {
      reasons.push(`redaction incomplete: ${[...detection.fields.slice(0, 5), ...detection.realPatterns].join(', ')} still in the payload`);
    } else {
      redacted = true;
      if (effective === 'personal' || effective === 'transcript') effective = 'business';
      reasons.push('redacted payload');
    }
  }
  return { declared, call, detected, effective, reasons, synthetic, redacted, personFields: detection };
}

function paidGemini(spec) {
  return spec.billingTier === 'paid' && Boolean(spec.paidTierConfirmedAt);
}

/**
 * Whether `provider` may see `dataClass` under `policy`.
 * @param {object} [call] {synthetic, redacted, task, family} from effectiveDataClass and the task registry
 */
export function providerAllows(policy, provider, dataClass, call = {}) {
  if (provider === 'replay') return { allowed: true, reason: 'replay' };
  if (NEVER_PERSONAL.has(provider) && (dataClass === 'personal' || dataClass === 'transcript')) {
    return { allowed: false, reason: `${provider} never receives ${dataClass} data` };
  }
  if (CLIENT_DATA_ONLY_SYNTHETIC_OR_REDACTED.has(provider) && dataClass !== 'public' && !(call.synthetic === true || call.redacted === true)) {
    return { allowed: false, reason: `${provider} receives ${dataClass} client data only when it is synthetic or redacted` };
  }
  const spec = policy?.providers?.[provider];
  if (!spec) return { allowed: false, reason: `${provider} is not listed in the data policy` };
  if (!Array.isArray(spec.allow) || !spec.allow.includes(dataClass)) {
    return { allowed: false, reason: `policy does not allow ${dataClass} data on ${provider}` };
  }
  if (Array.isArray(spec.tasks) || Array.isArray(spec.families)) {
    const byTask = Array.isArray(spec.tasks) && call.task && spec.tasks.includes(call.task);
    const byFamily = Array.isArray(spec.families) && call.family && spec.families.includes(call.family);
    if (!byTask && !byFamily) return { allowed: false, reason: `${provider} is limited to ${[...(spec.tasks || []), ...(spec.families || []).map((f) => `family ${f}`)].join(', ')}` };
  }
  if (provider === 'gemini' && !paidGemini(spec)) {
    if (dataClass !== 'public') return { allowed: false, reason: 'gemini paid tier not confirmed; client data may not go there' };
    if (spec.allowUnpaidPublic !== true) return { allowed: false, reason: 'gemini paid tier not confirmed (allowUnpaidPublic is off)' };
  }
  return { allowed: true, reason: '' };
}

/**
 * Drops chain entries the policy forbids. When nothing is left, the policy redirect route is used
 * if it is allowed; otherwise PolicyBlockedError.
 * @param {object} [call] {synthetic, redacted, task, family}
 * @returns {{chain:object[], redirected:boolean, redirects:{from:string, to:string|null, reason:string}[]}}
 *   redirected: every original entry was blocked and the chain is the redirect route
 */
export function applyPolicy(chain = [], dataClass = 'public', policy = {}, call = {}) {
  const allowed = [];
  const blocked = [];
  for (const entry of chain) {
    const verdict = providerAllows(policy, entry.provider, dataClass, call);
    if (verdict.allowed) allowed.push(entry);
    else blocked.push({ from: formatRouteEntry(entry), reason: verdict.reason });
  }
  if (allowed.length) {
    const to = blocked.length ? formatRouteEntry(allowed[0]) : null;
    return { chain: allowed, redirected: false, redirects: blocked.map((b) => ({ ...b, to })) };
  }
  let fallback;
  try {
    fallback = redirectRoute(policy);
  } catch (error) {
    throw new RouteConfigError(`Policy redirect route is invalid: ${error.message}`);
  }
  const usable = fallback.filter((entry) => providerAllows(policy, entry.provider, dataClass, call).allowed);
  if (!usable.length) {
    throw new PolicyBlockedError(`No provider in the route may receive ${dataClass} data.`, { dataClass, blocked });
  }
  const to = formatRouteEntry(usable[0]);
  return { chain: usable, redirected: true, redirects: blocked.map((b) => ({ ...b, to })) };
}

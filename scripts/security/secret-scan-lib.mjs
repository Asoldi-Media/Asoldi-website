/**
 * Secret and client-data scanner rules. This repo is public: anything committed
 * here is published, so the scan blocks new secrets, values from local .env
 * files, retired (rotated) secrets, client personal data and client-data paths.
 *
 * Findings never carry the matched value: only path, line, rule and a hint
 * (an env key name or a retired-secret label). Callers must not print values.
 */
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------- secret patterns

export const SECRET_RULES = [
  // A PEM block on one line with a body of a few characters is a test fixture; a real key body is hundreds of characters.
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:(.{0,400}?)-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)?/g,
    fake: (_value, match) => match[1] !== undefined && match[1].replace(/\\n|\s/g, '').length < 100,
  },
  { id: 'gcp-private-key-id', re: /"private_key_id"\s*:\s*"([0-9a-f]{40})"/g, group: 1 },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { id: 'sk-key', re: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{32,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'google-oauth-secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { id: 'brevo-key', re: /\bx(?:keysib|smtpsib)-[A-Za-z0-9-]{40,}/g },
  // Real Stripe keys are long random alphanumerics after the prefix (no underscores).
  { id: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, check: (value) => /[0-9]/.test(value.slice(8)) },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9]{20,}/g },
  { id: 'resend-key', re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'supabase-pat', re: /\bsbp_[a-f0-9]{40}\b/g },
  // Anchored on '://': the scheme part backtracks quadratically over long dotted runs.
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@'"`<>]+:[^\s/@'"`<>]{6,})@[A-Za-z0-9.-]+/g, group: 1, anchor: '://', precheck: urlCredentialsPrecheck },
  { id: 'service-role-jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g, check: jwtIsServiceRole },
  {
    id: 'secret-assignment',
    re: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY))\s*[:=]\s*['"]([^'"\s]{16,})['"]/g,
    group: 2,
    check: (value) => looksRandom(value) && !looksFake(value),
  },
];

function jwtIsServiceRole(_value, match) {
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

export function shannonEntropy(value) {
  const text = String(value || '');
  if (!text) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** A credential-like random string: letters and digits mixed, high entropy, not a sentence or a path. */
export function looksRandom(value) {
  const text = String(value || '');
  if (text.length < 16 || /\s/.test(text)) return false;
  if (/^(?:https?:|\/|\.\/|\$\{|process\.env)/i.test(text)) return false;
  if (!/[0-9]/.test(text) || !/[A-Za-z]/.test(text)) return false;
  return shannonEntropy(text) >= 3.5;
}

const FAKE_MARKERS = /fake|test|dummy|example|sample|placeholder|mock|redacted|xxxx|0000|1234|abcd|changeme|change-me|your[_-]|<[a-z_-]+>|\*\*\*/i;

/** True for values that are obviously fixtures. Allowlisted secret hits must pass this. */
export function looksFake(value) {
  const text = String(value || '');
  if (!text) return true;
  if (FAKE_MARKERS.test(text)) return true;
  const distinct = new Set(text.replace(/^[a-z]+[_-](?:live|test)[_-]/i, '')).size;
  return distinct <= 6;
}

// ---------------------------------------------------------------- client personal data (public repo)

// Run through anchoredMatches on '@': on a long dotted run the local part backtracks quadratically.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const PHONE_RE = /(?<![\w+])(?:\+47|0047)[\s.-]?(?:\d[\s.-]?){7}\d\b/g;
// Norwegian mobile numbers written without +47: 8 digits starting with 4 or 9. Not part of a longer
// number, id, version, decimal or spaced digit group (a card number, an org number, a timestamp).
// Grouped as people write them: 9xx xx xxx, 9x xx xx xx, 9xxx xxxx (\s also covers a no-break space).
const LOCAL_PHONE_GROUPED_RE = /(?<![\w.+/-]|\d\s)[49]\d(?:\d\s\d{2}\s\d{3}|\s\d{2}\s\d{2}\s\d{2}|\d{2}\s\d{4})(?!\w|[.,/:-]\d|\s\d)/g;
// Unbroken 9xxxxxxx is also how ids look, so it counts only as a whole quoted value or on a line about a phone.
const LOCAL_PHONE_PLAIN_RE = /(?<![\w.+/-]|\d\s)[49]\d{7}(?!\w|[.,/:-]\d|\s\d)/g;
const PHONE_HINT_RE = /tlf|telefon|phone|mobil|whatsapp|\bsms\b|\btel\b|\bring\b|\bmob\b/i;
const NATIONAL_ID_RE = /(?<!\d)(\d{6})[ ]?(\d{5})(?!\d)/g;
const CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

export const DEFAULT_ALLOWED_EMAIL_DOMAINS = [
  'asoldi.com',
  'example.com',
  'example.org',
  'example.net',
  'example.no',
  'test',
  'invalid',
  'localhost',
  'local',
  'users.noreply.github.com',
  'noreply.github.com',
  'anthropic.com',
  'cursor.com',
  'fireflies.ai',
  'sentry.io',
  'stripe.com',
  'google.com',
  'gserviceaccount.com',
];

// Test card numbers published by Stripe and the card schemes.
const TEST_CARD_PREFIXES = ['4242424242424242', '4000', '5555555555554444', '2223003122003222', '378282246310005', '6011111111111117', '3056930009020004'];

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function looksLikeCardNumber(raw) {
  const digits = raw.replace(/[ -]/g, '');
  // 15 (Amex) or 16 digits; longer digit runs are ids such as Google Maps CIDs.
  if (digits.length !== 15 && digits.length !== 16) return false;
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(digits)) return false;
  if (TEST_CARD_PREFIXES.some((prefix) => digits.startsWith(prefix))) return false;
  if (new Set(digits).size <= 3) return false;
  // Plain digit runs of 13 digits are usually millisecond timestamps.
  if (!/[ -]/.test(raw) && digits.length === 13 && /^1[5-9]/.test(digits)) return false;
  return luhnValid(digits);
}

/** Norwegian fødselsnummer / D-number: valid date and both mod-11 control digits. */
export function isNorwegianNationalId(value) {
  const d = String(value || '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const n = [...d].map(Number);
  let day = n[0] * 10 + n[1];
  const month = n[2] * 10 + n[3];
  if (day > 40) day -= 40; // D-number
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  const k1w = [3, 7, 6, 1, 8, 9, 4, 5, 2];
  const k2w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let k1 = 11 - (k1w.reduce((s, w, i) => s + w * n[i], 0) % 11);
  if (k1 === 11) k1 = 0;
  if (k1 === 10 || k1 !== n[9]) return false;
  let k2 = 11 - (k2w.reduce((s, w, i) => s + w * n[i], 0) % 11);
  if (k2 === 11) k2 = 0;
  if (k2 === 10 || k2 !== n[10]) return false;
  return new Set(d).size > 2;
}

/** Last 8 digits: the Norwegian number without +47 / 0047. */
function nationalPhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-8);
}

/** Fixture numbers: few distinct digits, a run like 1234 / 9876, 0000, or pairs like 99887766. */
export function phoneLooksFake(national) {
  const digits = String(national || '');
  if (new Set(digits).size <= 3) return true;
  if (/0000|0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321/.test(digits)) return true;
  return /^(\d)\1(\d)\2(\d)\3(\d)\4$/.test(digits);
}

function domainAllowed(domain, allowedDomains) {
  const host = String(domain || '').toLowerCase();
  return allowedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// ---------------------------------------------------------------- paths that must never be committed here

export const BLOCKED_PATH_RULES = [
  { id: 'env-file', re: /(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]+)?$/i },
  { id: 'env-backup', re: /(?:^|\/)production\.env$/i },
  { id: 'key-file', re: /\.(?:pem|key|p12|pfx|jks|keystore)$/i },
  { id: 'service-account', re: /(?:^|\/)(?:gen-lang-client-[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|[^/]*\.sa\.json)$/i },
  { id: 'secrets-dir', re: /(?:^|\/)(?:secrets|\.asoldi-secrets)\// },
  { id: 'hub-data-file', re: /(?:^|\/)(?:users|admin|sales-clients|sites|client-portal|clients|fireflies-meetings|fireflies-notified|offers|sales-offers|reset-tokens|webhooks|token-revocations)\.json$/i },
  { id: 'data-dir', re: /(?:^|\/)\.asoldi-(?:website|cms)-data\// },
  { id: 'transcript', re: /(?:^|\/)(?:[^/]*transcripts?[^/]*\.(?:jsonl?|txt|vtt|srt|md)|cursor-transcripts\/)/i },
  { id: 'private-fixtures', re: /(?:^|\/)(?:fixtures-private|golden-private|\.golden-reports|\.ai-cassettes|\.generated-runs)\//i },
  { id: 'client-export', re: /\.(?:eml|mbox|msg|pst)$/i },
  { id: 'daily-log', re: /^docs\/daily-logs\//i },
  { id: 'plan-file', re: /(?:^|\/)plans\/publish-ready[^/]*\//i },
  { id: 'scratch-file', re: /(?:^|\/)tmp-[^/]+\.(?:mjs|js|json|html|py|txt)$|^tmp\//i },
];

export function blockedPathRule(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return BLOCKED_PATH_RULES.find((rule) => rule.re.test(normalized))?.id || '';
}

// ---------------------------------------------------------------- allowlist

function globToRegExp(glob) {
  let out = '';
  const text = String(glob || '').replace(/\\/g, '/');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (text[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function normalizeAllowlist(raw = {}) {
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((row) => row && typeof row.path === 'string' && typeof row.rule === 'string' && String(row.reason || '').trim())
    .map((row) => ({ path: row.path, rule: row.rule, reason: String(row.reason), re: globToRegExp(row.path) }));
  return {
    entries,
    emailDomains: [...DEFAULT_ALLOWED_EMAIL_DOMAINS, ...(Array.isArray(raw.emailDomains) ? raw.emailDomains : [])].map((d) => String(d).toLowerCase()),
    emails: new Set((Array.isArray(raw.emails) ? raw.emails : []).map((e) => String(e).toLowerCase())),
    phones: new Set((Array.isArray(raw.phones) ? raw.phones : []).map(nationalPhone)),
  };
}

function allowEntry(allowlist, path, rule) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return allowlist.entries.find((row) => (row.rule === rule || row.rule === '*') && row.re.test(normalized)) || null;
}

// ---------------------------------------------------------------- known values and retired hashes

// _API$: keys named after the service alone, such as FIREFLIES_API (the hPanel name for the Fireflies key).
const SECRET_KEY_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASS$|_PASS_|PWD|API_KEY|APIKEY|_KEY$|_API$|PRIVATE|CREDENTIAL|_AUTH$|^AUTH|DSN|WEBHOOK)/i;

/** Values worth matching from a parsed .env map: secret-like key names, 12+ characters, not plain URLs. */
export function knownValuesFromEnv(map = {}, source = '.env') {
  const out = [];
  for (const [key, raw] of Object.entries(map)) {
    const value = String(raw ?? '').trim();
    if (value.length < 12 || !SECRET_KEY_NAME.test(key)) continue;
    if (/^https?:\/\/[^@\s]+$/i.test(value)) continue;
    if (/^(?:true|false|\d+)$/i.test(value)) continue;
    out.push({ key, value, source });
  }
  return out;
}

export function parseEnvText(text = '') {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).replace(/^export\s+/, '').trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function retiredHash(salt, value) {
  return createHmac('sha256', String(salt)).update(String(value)).digest('hex');
}

/** retired.json → matcher. Entries hold { label, length, hash } only; the salt is per machine. */
export function buildRetiredMatcher(raw) {
  if (!raw || typeof raw.salt !== 'string' || !Array.isArray(raw.entries)) return null;
  const byLength = new Map();
  for (const entry of raw.entries) {
    const length = Number(entry?.length);
    if (!Number.isInteger(length) || length < 8 || !/^[0-9a-f]{64}$/.test(String(entry?.hash || ''))) continue;
    if (!byLength.has(length)) byLength.set(length, new Map());
    byLength.get(length).set(entry.hash, String(entry.label || 'retired'));
  }
  if (!byLength.size) return null;
  const lengths = [...byLength.keys()].sort((a, b) => a - b);
  return { salt: raw.salt, byLength, lengths, min: lengths[0], max: lengths[lengths.length - 1] };
}

const TOKEN_SPLIT = /[\s"'`,;()<>[\]{}|\\]+/;
const SUB_SPLIT = /[=&?:/#]+/;

function candidateStrings(line, matcher) {
  const out = new Set();
  for (const token of line.split(TOKEN_SPLIT)) {
    if (token.length < matcher.min) continue;
    out.add(token);
    for (const part of token.split(SUB_SPLIT)) if (part.length >= matcher.min) out.add(part);
  }
  return out;
}

/** Labels of retired secrets found in the line (exact tokens, plus a little slack around them). */
export function retiredHitsInLine(line, matcher) {
  if (!matcher) return [];
  const hits = new Set();
  for (const candidate of candidateStrings(line, matcher)) {
    for (const length of matcher.lengths) {
      if (candidate.length < length || candidate.length > length + 8) continue;
      const table = matcher.byLength.get(length);
      for (let start = 0; start + length <= candidate.length; start += 1) {
        const label = table.get(retiredHash(matcher.salt, candidate.slice(start, start + length)));
        if (label) hits.add(label);
      }
    }
  }
  return [...hits];
}

// ---------------------------------------------------------------- scanning

/**
 * Matches of a global regex that contain `anchor`, found by running the regex only on a slice
 * around each occurrence of the anchor. Linear in the line length, so a single-line JSON dump or
 * minified bundle of any size is scanned, while a regex whose leading part can backtrack (an
 * e-mail local part, a URL scheme) never runs over the whole line. `match.index` is absolute.
 */
export function* anchoredMatches(text, re, anchor, { before = 128, after = 320, precheck = null } = {}) {
  const seen = new Set();
  for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + anchor.length)) {
    if (precheck && !precheck(text, at)) continue;
    const start = Math.max(0, at - before);
    const slice = text.slice(start, at + anchor.length + after);
    re.lastIndex = 0;
    for (const match of slice.matchAll(re)) {
      const absStart = start + match.index;
      if (absStart > at || absStart + match[0].length <= at || seen.has(absStart)) continue;
      seen.add(absStart);
      match.index = absStart;
      yield match;
    }
  }
}

// Cheap tests before the slice regex runs, so a line with very many '@' or '://' stays fast.
const EMAIL_DOMAIN_AT = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;
function emailPrecheck(text, at) {
  if (!/[A-Za-z0-9._%+-]/.test(text[at - 1] || '')) return false;
  EMAIL_DOMAIN_AT.lastIndex = at + 1;
  return EMAIL_DOMAIN_AT.test(text);
}
function urlCredentialsPrecheck(text, at) {
  // A bounded look ahead: indexOf over the rest of the line would be quadratic again.
  return text.slice(at + 3, at + 320).includes('@');
}

/** Unbroken 8-digit local numbers count when quoted on their own or on a line about a phone. */
function plainLocalPhoneCounts(text, match) {
  const before = text[match.index - 1];
  const after = text[match.index + match[0].length];
  if ((before === '"' || before === "'") && after === before) return true;
  return PHONE_HINT_RE.test(text);
}

/**
 * Scans lines of one file. `lines` is [{ line: number, text: string }]. Lines of any length are
 * scanned (a JSON dump or minified bundle is one line): every rule is linear in the line length.
 * Returns findings: { path, line, rule, kind: 'secret'|'pii'|'path', hint, allowlisted?, reason? }.
 */
export function scanLines(path, lines, { allowlist = normalizeAllowlist(), knownValues = [], retired = null } = {}) {
  const findings = [];
  const push = (finding) => findings.push({ path, ...finding });

  for (const { line, text } of lines) {
    if (!text) continue;

    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      const matches = rule.anchor
        ? anchoredMatches(text, rule.re, rule.anchor, { precheck: rule.precheck })
        : text.matchAll(rule.re);
      for (const match of matches) {
        const value = rule.group ? match[rule.group] : match[0];
        if (rule.check && !rule.check(value, match)) continue;
        const entry = allowEntry(allowlist, path, rule.id);
        const fake = rule.fake ? rule.fake(value, match) : looksFake(value);
        if (entry && fake) continue;
        if (rule.id === 'url-credentials' && looksFake(value)) continue;
        push({
          line,
          rule: rule.id,
          kind: 'secret',
          hint: entry ? 'allowlisted path, but the value does not look like a test fixture' : '',
        });
      }
    }

    for (const known of knownValues) {
      if (text.includes(known.value)) push({ line, rule: 'known-value', kind: 'secret', hint: `${known.key} (${known.source})` });
    }

    for (const label of retiredHitsInLine(text, retired)) {
      push({ line, rule: 'retired-secret', kind: 'secret', hint: label });
    }

    for (const match of anchoredMatches(text, EMAIL_RE, '@', { precheck: emailPrecheck })) {
      const address = match[0].toLowerCase();
      if (domainAllowed(match[1], allowlist.emailDomains) || allowlist.emails.has(address)) continue;
      if (/\.(?:png|jpe?g|gif|svg|webp|avif|js|css)$/i.test(address)) continue; // image@2x.png and similar
      if (allowEntry(allowlist, path, 'email')) continue;
      push({ line, rule: 'email', kind: 'pii', hint: '' });
    }

    const phones = [
      ...text.matchAll(PHONE_RE),
      ...text.matchAll(LOCAL_PHONE_GROUPED_RE),
      ...[...text.matchAll(LOCAL_PHONE_PLAIN_RE)].filter((match) => plainLocalPhoneCounts(text, match)),
    ];
    for (const match of phones) {
      const national = nationalPhone(match[0]);
      if (allowlist.phones.has(national) || phoneLooksFake(national)) continue;
      if (allowEntry(allowlist, path, 'phone')) continue;
      push({ line, rule: 'phone', kind: 'pii', hint: '' });
    }

    for (const match of text.matchAll(NATIONAL_ID_RE)) {
      if (!isNorwegianNationalId(`${match[1]}${match[2]}`)) continue;
      if (allowEntry(allowlist, path, 'national-id')) continue;
      push({ line, rule: 'national-id', kind: 'pii', hint: '' });
    }

    for (const match of text.matchAll(CARD_RE)) {
      if (!looksLikeCardNumber(match[0])) continue;
      if (allowEntry(allowlist, path, 'card-number')) continue;
      push({ line, rule: 'card-number', kind: 'pii', hint: '' });
    }
  }
  return findings;
}

export function scanPath(path, { allowlist = normalizeAllowlist() } = {}) {
  const rule = blockedPathRule(path);
  if (!rule) return null;
  if (allowEntry(allowlist, path, rule) || allowEntry(allowlist, path, 'path')) return null;
  return { path, line: 0, rule: `path:${rule}`, kind: 'path', hint: '' };
}

export function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((value, index) => ({ line: index + 1, text: value }));
}

/** One line per finding, no values. */
export function formatFinding(finding) {
  const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  return `${where}  ${finding.rule}${finding.hint ? `  (${finding.hint})` : ''}`;
}

export function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

/**
 * Secret, client-data and planning-vocabulary scanner rules. The same file is used in every
 * Asoldi repo; a profile (PROFILES) says which rule groups a repo enforces. A public repo
 * publishes everything committed, so its profile blocks new secrets, values from local .env
 * files, retired (rotated) secrets, client personal data, internal planning words and
 * client-data paths. A private repo blocks secrets only.
 *
 * Findings never carry the matched value: only path, line, rule and a hint
 * (an env key name, a retired-secret label or a names-file line). Callers must not print values.
 */
import { createHash, createHmac } from 'node:crypto';

// ---------------------------------------------------------------- profiles

// The secret path rules: files that hold credentials. Every profile blocks them.
const SECRET_PATH_RULE_IDS = new Set(['env-file', 'env-backup', 'key-file', 'service-account', 'secrets-dir', 'redact-backup']);

/**
 * Rule groups per repo profile. `public`: secrets, client data, planning words and every path rule
 * (a repo anyone can read). `private`: secrets and secret paths only (a repo whose fixtures hold
 * real client data by design).
 */
export const PROFILES = Object.freeze({
  public: Object.freeze({ name: 'public', secrets: true, pii: true, plan: true, paths: 'all' }),
  private: Object.freeze({ name: 'private', secrets: true, pii: false, plan: false, paths: 'secrets' }),
});

/** A profile by name (or a profile object), with the public profile as the default. */
export function resolveProfile(value) {
  if (value && typeof value === 'object') return { ...PROFILES.public, ...value };
  const name = String(value || 'public').trim().toLowerCase();
  if (!PROFILES[name]) throw new Error(`unknown scan profile: ${name}`);
  return PROFILES[name];
}

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

// ---------------------------------------------------------------- planning vocabulary (public repo)

// Words of the internal planning process: task and area ids (two capital letters and a number,
// with or without a task number), release-batch and branch names of the planning process, its
// "streams" word and the planning documents' file names. Code, comments, tests, docs and commit
// messages in a public repo describe the behaviour instead. Every pattern is written so that the
// pattern's own source text does not match it.
export const PLAN_RULES = [
  { id: 'plan-id', re: /\bWS\d{1,2}(?:\.\d{1,2}[a-z]?)?\b/g },
  { id: 'plan-batch', re: /\bwave[ -]?\d{1,2}[a-z]?\b/gi },
  { id: 'plan-branch', re: /\bwf\/w\d{1,2}[a-z]?\b/gi },
  { id: 'plan-word', re: /\bwork[ -]?streams?\b/gi },
  { id: 'plan-file', re: /\b(?:MASTER[-_ ]PLAN|K-PHASE[-_]TASKS|L-TRANSCRIPT[-_]COVERAGE|USER[-_]BRIEF|[A-L]2?-WS\d{1,2}-[a-z0-9-]+|publish-ready-\d{4}-\d{2})\b/g },
];

export const PLAN_RULE_IDS = new Set(PLAN_RULES.map((rule) => rule.id));

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names (one per line, '#' comments) from a file kept outside the repo → a matcher. A name
 * matches case-insensitively as a whole word (letters and digits of any script around it end the
 * match); whitespace inside a name matches any whitespace. Names shorter than 3 characters are
 * skipped. Findings name the line of the names file, never the name.
 */
export function buildNamesMatcher(text) {
  const names = [];
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const name = raw.trim();
    if (!name || name.startsWith('#') || name.length < 3) return;
    const pattern = escapeRegExp(name).replace(/\s+/g, '\\s+');
    names.push({
      label: `names file line ${index + 1}`,
      needle: name.toLowerCase().split(/\s+/)[0],
      re: new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'),
    });
  });
  return names.length ? { names } : null;
}

/** Labels of listed names in the line (one per name). */
export function listedNameHits(text, matcher) {
  if (!matcher) return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const row of matcher.names) {
    if (!lower.includes(row.needle)) continue;
    row.re.lastIndex = 0;
    if (row.re.test(text)) hits.push(row.label);
  }
  return hits;
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
  'example',
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
  // The words the planning-word cleanup puts in place of task ids: kept outside the public repos.
  { id: 'plan-words', re: /(?:^|\/)plan-words\.json$/i },
  { id: 'scratch-file', re: /(?:^|\/)tmp-[^/]+\.(?:mjs|js|json|html|py|txt)$|^tmp\//i },
  // The original a --redact --apply run keeps next to each file it changed: it holds the values.
  { id: 'redact-backup', re: /\.bak-redact$/i },
];

/** The blocked-path rule id for `path` under `profile` ('' when the path may be committed). */
export function blockedPathRule(path, profile = PROFILES.public) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const { paths } = resolveProfile(profile);
  if (paths === 'none') return '';
  const all = paths === 'all';
  return BLOCKED_PATH_RULES.find((rule) => (all || SECRET_PATH_RULE_IDS.has(rule.id)) && rule.re.test(normalized))?.id || '';
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

// A commit-pinned entry never lets these through: a value from a local .env file or a retired
// secret stays a finding in every commit, and '*' would not be precise.
const COMMIT_ENTRY_FORBIDDEN_RULES = new Set(['*', 'known-value', 'retired-secret']);

/**
 * commitEntries pin one finding in one historical commit: { commit: <40-hex sha>, path: <exact
 * path, no glob>, line: <line in that commit's version of the file>, rule, reason }. A commit is
 * immutable, so an entry covers exactly one line of one blob; the same line in any other commit,
 * in the staged changes or in the tracked files is still reported. Invalid entries are dropped.
 */
export function normalizeCommitEntries(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .filter((row) => {
      if (!row || typeof row !== 'object') return false;
      if (!/^[0-9a-f]{40}$/i.test(String(row.commit || ''))) return false;
      if (typeof row.path !== 'string' || !row.path.trim() || /[*?]/.test(row.path)) return false;
      if (!Number.isInteger(row.line) || row.line < 1) return false;
      if (typeof row.rule !== 'string' || !row.rule || COMMIT_ENTRY_FORBIDDEN_RULES.has(row.rule) || row.rule.startsWith('path:')) return false;
      return String(row.reason || '').trim().length > 0;
    })
    .map((row) => ({
      commit: row.commit.toLowerCase(),
      path: row.path.trim().replace(/\\/g, '/'),
      line: row.line,
      rule: row.rule,
      reason: String(row.reason),
    }));
}

/** The commit-pinned entry that covers `finding` ({ path, line, rule }) in `commit`, or null. */
export function commitEntryFor(allowlist, commit, finding) {
  const sha = String(commit || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha) || !finding?.line) return null;
  const path = String(finding.path || '').replace(/\\/g, '/');
  return (allowlist?.commitEntries || []).find((row) => (
    row.commit === sha && row.path === path && row.line === finding.line && row.rule === finding.rule
  )) || null;
}

/**
 * fixtureValues let one exact fixture value through wherever it appears in the matching paths:
 * { path: <glob>, rule, sha256: <hex sha256 of the matched value>, reason }. Use it for a test
 * value that has to look real (a credential in a URL, a password a test signs in with), or for one
 * contact that only some files may hold (rule 'email': the hash of the lowercase address; rule
 * 'phone': the hash of its 8 national digits). Only the hash is stored, a different value in the
 * same file is still reported, and an entry never covers a value from a local .env file or a
 * retired secret.
 */
export function normalizeFixtureValues(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .filter((row) => (
      row && typeof row.path === 'string' && row.path.trim()
      && typeof row.rule === 'string' && row.rule && !COMMIT_ENTRY_FORBIDDEN_RULES.has(row.rule) && !row.rule.startsWith('path:')
      && /^[0-9a-f]{64}$/i.test(String(row.sha256 || ''))
      && String(row.reason || '').trim()
    ))
    .map((row) => ({ path: row.path, rule: row.rule, sha256: row.sha256.toLowerCase(), reason: String(row.reason), re: globToRegExp(row.path) }));
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fixtureValueAllowed(allowlist, path, rule, value) {
  const rows = allowlist?.fixtureValues;
  if (!rows?.length) return false;
  const normalized = String(path || '').replace(/\\/g, '/');
  const candidates = rows.filter((row) => row.rule === rule && row.re.test(normalized));
  if (!candidates.length) return false;
  const hash = sha256Hex(value);
  return candidates.some((row) => row.sha256 === hash);
}

export function normalizeAllowlist(raw = {}) {
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((row) => row && typeof row.path === 'string' && typeof row.rule === 'string' && String(row.reason || '').trim())
    .map((row) => ({ path: row.path, rule: row.rule, reason: String(row.reason), re: globToRegExp(row.path) }));
  return {
    entries,
    commitEntries: normalizeCommitEntries(raw.commitEntries),
    fixtureValues: normalizeFixtureValues(raw.fixtureValues),
    emailDomains: [...DEFAULT_ALLOWED_EMAIL_DOMAINS, ...(Array.isArray(raw.emailDomains) ? raw.emailDomains : [])].map((d) => String(d).toLowerCase()),
    emails: new Set((Array.isArray(raw.emails) ? raw.emails : []).map((e) => String(e).toLowerCase())),
    phones: new Set((Array.isArray(raw.phones) ? raw.phones : []).map(nationalPhone)),
  };
}

/** The client-data rule ids. */
export const PII_RULE_IDS = new Set(['listed-name', 'email', 'phone', 'national-id', 'card-number']);

/**
 * The entry that lets `rule` through in `path`. A '*' entry covers the secret and path rules only
 * (a secret hit must still look fake): client data and planning words need an entry that names
 * the rule.
 */
function allowEntry(allowlist, path, rule) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const star = !PII_RULE_IDS.has(rule) && !PLAN_RULE_IDS.has(rule);
  return allowlist.entries.find((row) => (row.rule === rule || (star && row.rule === '*')) && row.re.test(normalized)) || null;
}

const GLOB_CHARS = /[*?]/;

/**
 * Entries that let client data or planning words through in more than one file: a client-data or
 * planning rule on a glob path. A public repo allows these rules by exact path or by exact value
 * only. Returns [{ path, rule }].
 */
export function broadDataEntries(allowlist) {
  return (allowlist?.entries || [])
    .filter((row) => (PII_RULE_IDS.has(row.rule) || PLAN_RULE_IDS.has(row.rule)) && GLOB_CHARS.test(row.path))
    .map((row) => ({ path: row.path, rule: row.rule }));
}

/**
 * What the allowlist `next` (raw JSON) lets through beyond `base` (raw JSON; {} when there was
 * none) that is broader than one exact value: a new entry whose rule is '*' or whose path is a
 * glob, a new entry for a client-data or planning rule (it hides every such finding in its file),
 * and a new allowed e-mail domain. Exact values (emails, phones, fixtureValues), commit-pinned
 * entries and one-file entries for a secret rule (whose hits must still look fake) are not
 * counted. Returns hints without values.
 */
export function allowlistWidening(base = {}, next = {}) {
  const before = normalizeAllowlist(base || {});
  const after = normalizeAllowlist(next || {});
  const key = (row) => `${row.path}\u0000${row.rule}`;
  const known = new Set(before.entries.map(key));
  const out = [];
  for (const row of after.entries) {
    if (known.has(key(row))) continue;
    const dataRule = PII_RULE_IDS.has(row.rule) || PLAN_RULE_IDS.has(row.rule);
    if (row.rule === '*' || GLOB_CHARS.test(row.path) || dataRule) out.push(`new entry: rule ${row.rule} on ${row.path}`);
  }
  const domains = new Set(before.emailDomains);
  const added = after.emailDomains.filter((domain) => !domains.has(domain)).length;
  if (added) out.push(`${added} new allowed e-mail domain(s)`);
  return out;
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

// Tokens split on whitespace, quotes and brackets; parts of a token split on URL and assignment marks.
const TOKEN_RE = /[^\s"'`,;()<>[\]{}|\\]+/g;
const SUB_RE = /[^=&?:/#]+/g;

/** Candidate strings with their offset in the line: each token and each part of a token. */
function candidateSpans(line, matcher) {
  const out = new Map();
  for (const token of line.matchAll(TOKEN_RE)) {
    if (token[0].length < matcher.min) continue;
    out.set(`${token.index}:${token[0].length}`, { start: token.index, text: token[0] });
    for (const part of token[0].matchAll(SUB_RE)) {
      if (part[0].length >= matcher.min) out.set(`${token.index + part.index}:${part[0].length}`, { start: token.index + part.index, text: part[0] });
    }
  }
  return [...out.values()];
}

/** Retired secrets found in the line, with their position: [{ label, start, end }]. */
export function retiredSpansInLine(line, matcher) {
  if (!matcher) return [];
  const spans = [];
  const seen = new Set();
  for (const candidate of candidateSpans(line, matcher)) {
    for (const length of matcher.lengths) {
      if (candidate.text.length < length || candidate.text.length > length + 8) continue;
      const table = matcher.byLength.get(length);
      for (let start = 0; start + length <= candidate.text.length; start += 1) {
        const label = table.get(retiredHash(matcher.salt, candidate.text.slice(start, start + length)));
        if (!label) continue;
        const abs = candidate.start + start;
        const key = `${abs}:${length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        spans.push({ label, start: abs, end: abs + length });
      }
    }
  }
  return spans;
}

/** Labels of retired secrets found in the line (exact tokens, plus a little slack around them). */
export function retiredHitsInLine(line, matcher) {
  return [...new Set(retiredSpansInLine(line, matcher).map((span) => span.label))];
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
 * Secret hits in one line with their position: [{ rule, hint, start, end, label }]. `start..end`
 * covers the value (the credential part of a URL, the quoted value of an assignment), which is
 * what a redaction replaces. Every occurrence of a known .env value is listed. Shared by the
 * scan and the redaction, so both see exactly the same secrets.
 */
export function secretHitsInLine(path, text, { allowlist = normalizeAllowlist(), knownValues = [], retired = null } = {}) {
  const hits = [];
  if (!text) return hits;
  for (const rule of SECRET_RULES) {
    if (rule.anchor) {
      if (!text.includes(rule.anchor)) continue;
    } else {
      // One test() first: matchAll() copies the regex, which costs more than the scan of a line
      // that has no match (almost every line).
      rule.re.lastIndex = 0;
      const hit = rule.re.test(text);
      rule.re.lastIndex = 0;
      if (!hit) continue;
    }
    const matches = rule.anchor
      ? anchoredMatches(text, rule.re, rule.anchor, { precheck: rule.precheck })
      : text.matchAll(rule.re);
    for (const match of matches) {
      const value = rule.group ? match[rule.group] : match[0];
      if (value === undefined) continue;
      if (rule.check && !rule.check(value, match)) continue;
      const entry = allowEntry(allowlist, path, rule.id);
      const fake = rule.fake ? rule.fake(value, match) : looksFake(value);
      if (entry && fake) continue;
      if (rule.id === 'url-credentials' && looksFake(value)) continue;
      if (fixtureValueAllowed(allowlist, path, rule.id, value)) continue;
      const start = match.index + (rule.group ? Math.max(0, match[0].indexOf(value)) : 0);
      hits.push({
        rule: rule.id,
        hint: entry ? 'allowlisted path, but the value does not look like a test fixture' : '',
        label: rule.id,
        start,
        end: start + value.length,
      });
    }
  }

  for (const known of knownValues) {
    for (let at = text.indexOf(known.value); at !== -1; at = text.indexOf(known.value, at + known.value.length)) {
      hits.push({ rule: 'known-value', hint: `${known.key} (${known.source})`, label: known.key, start: at, end: at + known.value.length });
    }
  }

  for (const span of retiredSpansInLine(text, retired)) {
    hits.push({ rule: 'retired-secret', hint: span.label, label: span.label, start: span.start, end: span.end });
  }
  return hits;
}

/**
 * Scans lines of one file. `lines` is [{ line: number, text: string }]. Lines of any length are
 * scanned (a JSON dump or minified bundle is one line): every rule is linear in the line length.
 * `profile` picks the rule groups (secrets, pii, plan); `names` is a buildNamesMatcher() result.
 * Returns findings: { path, line, rule, kind: 'secret'|'pii'|'plan'|'path', hint }.
 */
export function scanLines(path, lines, { allowlist = normalizeAllowlist(), knownValues = [], retired = null, profile = PROFILES.public, names = null } = {}) {
  const findings = [];
  const push = (finding) => findings.push({ path, ...finding });
  const rules = resolveProfile(profile);

  for (const { line, text } of lines) {
    if (!text) continue;

    if (rules.secrets) {
      // One finding per pattern match; a known value or a retired secret once per line.
      const once = new Set();
      for (const hit of secretHitsInLine(path, text, { allowlist, knownValues, retired })) {
        if (hit.rule === 'known-value' || hit.rule === 'retired-secret') {
          const key = `${hit.rule}\u0000${hit.hint}`;
          if (once.has(key)) continue;
          once.add(key);
        }
        push({ line, rule: hit.rule, kind: 'secret', hint: hit.hint });
      }
    }

    if (rules.plan) {
      for (const rule of PLAN_RULES) {
        rule.re.lastIndex = 0;
        if (!rule.re.test(text) || allowEntry(allowlist, path, rule.id)) continue;
        rule.re.lastIndex = 0;
        for (const _match of text.matchAll(rule.re)) push({ line, rule: rule.id, kind: 'plan', hint: '' });
      }
    }

    if (!rules.pii) continue;

    for (const hit of piiHitsInLine(path, text, { allowlist, names })) push({ line, rule: hit.rule, kind: 'pii', hint: hit.hint });
  }
  return findings;
}

/**
 * Client personal data in one line: [{ rule, hint, start, end, value }]. `value` is the matched
 * text, for in-process use only (the client-data scrub replaces it); never print it. Listed
 * names carry no position. Shared by the scan and the scrub, so both see the same data.
 */
export function piiHitsInLine(path, text, { allowlist = normalizeAllowlist(), names = null } = {}) {
  const hits = [];
  if (!text) return hits;
  const listed = listedNameHits(text, names);
  if (listed.length && !allowEntry(allowlist, path, 'listed-name')) {
    for (const label of listed) hits.push({ rule: 'listed-name', hint: label, start: -1, end: -1, value: '' });
  }

  for (const match of anchoredMatches(text, EMAIL_RE, '@', { precheck: emailPrecheck })) {
    const address = match[0].toLowerCase();
    if (domainAllowed(match[1], allowlist.emailDomains) || allowlist.emails.has(address)) continue;
    if (/\.(?:png|jpe?g|gif|svg|webp|avif|js|css)$/i.test(address)) continue; // image@2x.png and similar
    if (allowEntry(allowlist, path, 'email') || fixtureValueAllowed(allowlist, path, 'email', address)) continue;
    hits.push({ rule: 'email', hint: '', start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  const phones = [
    ...text.matchAll(PHONE_RE),
    ...text.matchAll(LOCAL_PHONE_GROUPED_RE),
    ...[...text.matchAll(LOCAL_PHONE_PLAIN_RE)].filter((match) => plainLocalPhoneCounts(text, match)),
  ];
  for (const match of phones) {
    const national = nationalPhone(match[0]);
    if (allowlist.phones.has(national) || phoneLooksFake(national)) continue;
    if (allowEntry(allowlist, path, 'phone') || fixtureValueAllowed(allowlist, path, 'phone', national)) continue;
    hits.push({ rule: 'phone', hint: '', start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  for (const match of text.matchAll(NATIONAL_ID_RE)) {
    if (!isNorwegianNationalId(`${match[1]}${match[2]}`)) continue;
    if (allowEntry(allowlist, path, 'national-id')) continue;
    hits.push({ rule: 'national-id', hint: '', start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  for (const match of text.matchAll(CARD_RE)) {
    if (!looksLikeCardNumber(match[0])) continue;
    if (allowEntry(allowlist, path, 'card-number')) continue;
    hits.push({ rule: 'card-number', hint: '', start: match.index, end: match.index + match[0].length, value: match[0] });
  }
  return hits;
}

/** The 8 national digits of a Norwegian phone number (+47 / 0047 dropped). */
export function nationalPhoneDigits(value) {
  return nationalPhone(value);
}

/** True when `address`'s domain is one the scan allows (asoldi.com, example.*, test domains …). */
export function emailDomainAllowed(domain, allowlist = normalizeAllowlist()) {
  return domainAllowed(domain, allowlist.emailDomains);
}

export function scanPath(path, { allowlist = normalizeAllowlist(), profile = PROFILES.public } = {}) {
  const rule = blockedPathRule(path, profile);
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

// UTF-16 without a byte-order mark: at least this share of the sampled characters has a zero high
// byte (Latin text), and no character is NUL.
const UTF16_ZERO_SHARE = 0.9;

function utf16OrderWithoutBom(buffer) {
  if (buffer.length < 4 || buffer.length % 2) return '';
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000) & ~1);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample.length; i += 2) {
    if (sample[i] === 0 && sample[i + 1] === 0) return '';
    if (sample[i] === 0) evenZero += 1;
    if (sample[i + 1] === 0) oddZero += 1;
  }
  const chars = sample.length / 2;
  if (oddZero >= chars * UTF16_ZERO_SHARE && evenZero === 0) return 'utf16le';
  if (evenZero >= chars * UTF16_ZERO_SHARE && oddZero === 0) return 'utf16be';
  return '';
}

function utf16ToString(bytes, encoding) {
  if (encoding === 'utf16le') return bytes.toString('utf16le');
  const swapped = Buffer.from(bytes);
  swapped.swap16();
  return swapped.toString('utf16le');
}

/**
 * A file's bytes as text: { text, encoding: 'utf8'|'utf16le'|'utf16be', bom }. UTF-8 keeps a
 * byte-order mark in the text. UTF-16 is read with a byte-order mark (as PowerShell's '>' and
 * Notepad write it) or, without one, when it is plainly UTF-16 Latin text. null for anything else
 * that holds a NUL byte (binary, UTF-32).
 */
export function decodeText(buffer) {
  const bomLe = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomBe = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  if (bomLe || bomBe) {
    if (buffer.length % 2 || (bomLe && buffer.length >= 4 && buffer[2] === 0 && buffer[3] === 0)) return null;
    const encoding = bomLe ? 'utf16le' : 'utf16be';
    return { text: utf16ToString(buffer.subarray(2), encoding), encoding, bom: true };
  }
  if (!isProbablyBinary(buffer)) return { text: buffer.toString('utf8'), encoding: 'utf8', bom: false };
  const encoding = utf16OrderWithoutBom(buffer);
  return encoding ? { text: utf16ToString(buffer, encoding), encoding, bom: false } : null;
}

/** The bytes of `text` in the encoding decodeText() read it in ({ encoding, bom }). */
export function encodeText(text, { encoding = 'utf8', bom = false } = {}) {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  const body = Buffer.from(text, 'utf16le');
  if (encoding === 'utf16be') body.swap16();
  if (!bom) return body;
  return Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), body]);
}

// ---------------------------------------------------------------- redaction

function redactionLabel(label) {
  return String(label || 'secret').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'secret';
}

/** Replaces each span ({ start, end, label }) with <redacted:LABEL>; overlapping spans merge. */
export function redactLine(text, spans) {
  if (!spans.length) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  let out = '';
  let at = 0;
  for (const span of merged) {
    out += `${text.slice(at, span.start)}<redacted:${redactionLabel(span.label)}>`;
    at = span.end;
  }
  return out + text.slice(at);
}

const PEM_BEGIN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * The text with every secret the scan reports replaced by <redacted:KEY> (KEY: the env key name,
 * the retired-secret label or the rule id). A private key is removed whole: on one line (an
 * escaped JSON value) up to its END marker, or over several lines, whose body lines become empty
 * so the line numbers stay the same. Client data and planning words are never touched.
 * Returns { text, redactions: [{ line, rule, hint }] } with no values.
 */
export function redactText(path, text, ctx = {}) {
  const lines = String(text).split('\n');
  const redactions = [];
  let inPem = false;
  for (let i = 0; i < lines.length; i += 1) {
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    const body = cr ? lines[i].slice(0, -1) : lines[i];
    if (inPem) {
      const end = body.match(PEM_END);
      lines[i] = end ? body.slice(end.index + end[0].length) + cr : cr;
      if (end) inPem = false;
      continue;
    }
    const hits = secretHitsInLine(path, body, ctx).map((hit) => {
      if (hit.rule !== 'private-key') return hit;
      const rest = body.slice(hit.start);
      const end = rest.match(PEM_END);
      if (end) return { ...hit, end: hit.start + end.index + end[0].length };
      if (PEM_BEGIN.test(rest)) inPem = true;
      return { ...hit, end: body.length };
    });
    if (!hits.length) continue;
    lines[i] = redactLine(body, hits) + cr;
    for (const hit of hits) redactions.push({ line: i + 1, rule: hit.rule, hint: hit.hint });
  }
  return { text: lines.join('\n'), redactions };
}

// ---------------------------------------------------------------- ratchets

/**
 * A ratchet list ({ about, kind, files: { path: count } }) holds the findings a repo still has
 * of one kind. A check fails when a file that is not listed has a finding or a listed count
 * grows; a lower count passes, and shrinkRatchet() lowers the list to match.
 */
export function countFindingsByPath(findings, kinds) {
  const wanted = new Set([].concat(kinds));
  const counts = {};
  for (const finding of findings) {
    if (!wanted.has(finding.kind)) continue;
    counts[finding.path] = (counts[finding.path] || 0) + 1;
  }
  return counts;
}

export function ratchetProblems(list, counts) {
  const allowed = list?.files || {};
  const unlisted = [];
  const grown = [];
  const shrunk = [];
  for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(path in allowed)) unlisted.push({ path, count });
    else if (count > allowed[path]) grown.push({ path, count, allowed: allowed[path] });
  }
  for (const [path, limit] of Object.entries(allowed).sort(([a], [b]) => a.localeCompare(b))) {
    const count = counts[path] || 0;
    if (count < limit) shrunk.push({ path, count, allowed: limit });
  }
  return { unlisted, grown, shrunk, ok: !unlisted.length && !grown.length };
}

/** The list lowered to the current counts: never a new file and never a higher count. */
export function shrinkRatchet(list, counts) {
  const files = {};
  for (const [path, limit] of Object.entries(list?.files || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const next = Math.min(limit, counts[path] || 0);
    if (next > 0) files[path] = next;
  }
  return { ...list, files };
}

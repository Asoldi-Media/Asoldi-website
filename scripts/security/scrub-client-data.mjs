#!/usr/bin/env node
/**
 * Replaces the e-mail addresses and phone numbers the public scan flags (npm run scan:public) in
 * tests, fixtures, scripts and Markdown docs with addresses on reserved domains (example.com and
 * the .test top-level domain) and fixture numbers. Code that runs in production (lib/, data/, app/,
 * src/, packages/, server.js, public/, and server/, client/ and admin/ in the CMS) is never
 * changed: a finding there is printed, for an allowlist entry or a reviewed change.
 *
 *   node scripts/security/scrub-client-data.mjs --check [--root DIR]   exit 1 when a file would change
 *   node scripts/security/scrub-client-data.mjs --write [--root DIR]   rewrite, then lower the offender list
 *
 * What changes:
 *   - a flagged address keeps a role local part ("post", "hei", "booking", one letter) and any
 *     other local part becomes person-<hash>. On a company domain it moves to a neutral word on the
 *     .test top-level domain, which is reserved for testing (company-name.no → "maple.test"); on a
 *     public mail or social platform (gmail.com, x.com …) it becomes <local>@example.com. The same
 *     address maps the same way in every file, so a fixture and the assertion that reads it agree;
 *   - in a file with a flagged address on a company domain, that domain also changes in URLs,
 *     host names and regular expressions (company-name\.no), and the company name taken from the
 *     domain changes to the same word inside strings, comments and docs, so code that compares a
 *     business name with its website still sees a match. Names are never changed in code
 *     (identifiers), and addresses on that domain the allowlist keeps (placeholders) keep it;
 *   - a phone number keeps its first digit and its layout (+47, spaces) and gets fixture digits
 *     (<first digit>0000<3 digits>), which the scan treats as a fixture.
 * Asoldi's own contacts and placeholders in .secret-scan-allowlist.json are never flagged, so
 * never replaced. Files under `scrubExclude` in scripts/security/scan-profile.json, the scan tools
 * themselves (scripts/security/) and docs/security.md are left alone; excluded files keep their
 * entries on the client-data offender list.
 *
 * The scrub only knows e-mail addresses and phone numbers. It prints, by path and line only, the
 * places a person should still look at: company names it could not tell from ordinary words, a
 * replaced company domain that other files still use, and name parts of replaced addresses that
 * are still in the file. Those fixtures need a synthetic business written by hand.
 *
 * Deterministic and idempotent: the replacements derive from the values alone (a hash for names,
 * words and numbers), and a second --write finds nothing to replace. Values are never printed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countFindingsByPath,
  isProbablyBinary,
  nationalPhoneDigits,
  piiHitsInLine,
  scanLines,
  shrinkRatchet,
  splitLines,
} from './secret-scan-lib.mjs';
import { listRepoFiles, loadAllowlist, loadProfileConfig, rootOrDir } from './secret-scan.mjs';
import { textRegions } from './neutralize-plan-ids.mjs';

// Code that runs in production: never rewritten (test files inside them still are).
const RUNTIME = /^(?:lib|data|app|src|packages|public|components|server|client|admin|admin-dist)\/|^server\.js$/;
const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?|(?:^|\/)test-[\w.-]+\.m?js)$/i;
const DOC_FILE = /\.(?:md|mdc|markdown)$/i;
const JS_FILE = /\.[cm]?[jt]sx?$/i;
const MEDIA = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|m4a|pdf|zip)$/i;

/** Never scrubbed: the scan tools, their tests and fixtures, and the doc that explains them. */
export const BUILTIN_EXCLUDE = Object.freeze(['scripts/security/**', 'docs/security.md']);

/** Public mail and social platforms: their domain is not a client's, so URLs keep it. */
export const PLATFORM_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.no', 'outlook.com', 'live.com', 'live.no', 'msn.com',
  'yahoo.com', 'yahoo.no', 'icloud.com', 'me.com', 'mac.com', 'online.no', 'protonmail.com', 'proton.me',
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'google.com', 'youtube.com',
]);

/** Neutral words for company domains: plants, so no word is a business, a person or a place. */
export const NEUTRAL_WORDS = Object.freeze([
  'acorn', 'alder', 'aspen', 'basil', 'birch', 'bramble', 'cedar', 'clover', 'cress', 'dahlia',
  'daisy', 'elder', 'elm', 'fern', 'flax', 'gorse', 'hazel', 'heather', 'iris', 'ivy',
  'juniper', 'larch', 'laurel', 'maple', 'moss', 'nettle', 'oak', 'olive', 'pine', 'poppy',
  'quince', 'reed', 'rowan', 'sage', 'sorrel', 'tansy', 'thyme', 'vetch', 'willow', 'yarrow',
]);

/**
 * Local parts that name a role or a mailbox, not a person: kept (a trailing number too, "tid2").
 * Anything else becomes person-<hash>.
 */
const ROLE_LOCALS = new Set([
  'post', 'postmottak', 'postmaster', 'hei', 'hallo', 'hello', 'hi', 'kontakt', 'contact', 'info', 'mail', 'epost',
  'email', 'faktura', 'invoice', 'billing', 'regnskap', 'booking', 'bestilling', 'order', 'ordre', 'orders', 'salg',
  'sales', 'shop', 'butikk', 'support', 'help', 'hjelp', 'admin', 'webmaster', 'web', 'noreply', 'no-reply',
  'donotreply', 'mailer-daemon', 'owner', 'eier', 'team', 'office', 'kontor', 'kundeservice', 'service', 'resepsjon',
  'dev', 'developer', 'test', 'demo', 'preview', 'scan', 'logo', 'first', 'second', 'third', 'last', 'other',
  'others', 'someone', 'someone-else', 'anyone', 'nobody', 'new', 'ny', 'old', 'gammel', 'user', 'bruker', 'kunde',
  'client', 'customer', 'guest', 'gjest', 'member', 'medlem', 'staff', 'ansatt', 'skip', 'seller', 'buyer', 'press',
  'presse', 'jobb', 'jobs', 'careers', 'hr', 'it', 'news', 'nyheter', 'newsletter', 'marketing', 'reply',
]);

/**
 * Domain names that are ordinary words (kafe.no, firma.no …): the word in a file is not a company
 * name, so the scrub does not change it outside addresses and host names.
 */
const COMMON_WORD_LABELS = new Set([
  'test', 'demo', 'example', 'sample', 'firma', 'bedrift', 'kafe', 'cafe', 'kafeen', 'cafeen', 'kunde', 'kunder',
  'annet', 'other', 'shop', 'butikk', 'store', 'salong', 'salon', 'frisor', 'post', 'mail', 'epost', 'info', 'site',
  'web', 'home', 'hjem', 'old', 'new', 'regnskap', 'byra', 'bakeri', 'restaurant', 'hotell', 'hotel', 'klinikk',
  'tannlege', 'nordlys', 'fjord', 'byen', 'sentrum',
]);

// The second-level labels of country domains such as co.uk and com.au.
const SECOND_LEVEL = /^(?:co|com|org|net|ac|gov|edu)$/;

function hash(value, length = 6) {
  return createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0, length);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True for a path the scrub may rewrite. */
export function isScrubTarget(path) {
  if (MEDIA.test(path)) return false;
  if (TEST_FILE.test(path)) return true;
  if (/(?:^|\/)(?:fixtures|__fixtures__|golden)\//.test(path)) return true;
  if (RUNTIME.test(path)) return false;
  return DOC_FILE.test(path) || /^(?:scripts|test|tests|docs)\//.test(path);
}

/** A glob (`*` within a folder, `**` across folders) as an anchored RegExp. */
export function globToRegExp(glob) {
  const source = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`);
}

/** The label that names the company: "name" in name.no, sub.name.no and name.co.uk. */
export function domainLabel(domain) {
  const labels = String(domain).toLowerCase().split('.');
  if (labels.length >= 3 && SECOND_LEVEL.test(labels[labels.length - 2])) return labels[labels.length - 3];
  return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
}

/**
 * Neutral words for company domains, one per domain: a hashed start in NEUTRAL_WORDS, the next free
 * word on a clash, in sorted order. Returns Map<domain, word>.
 */
export function assignWords(domains) {
  const used = new Set();
  const out = new Map();
  for (const domain of [...new Set(domains)].sort()) {
    const start = parseInt(hash(domain, 8), 16) % NEUTRAL_WORDS.length;
    let word = '';
    for (let k = 0; k < NEUTRAL_WORDS.length && !word; k += 1) {
      const candidate = NEUTRAL_WORDS[(start + k) % NEUTRAL_WORDS.length];
      if (!used.has(candidate)) word = candidate;
    }
    for (let n = 2; !word; n += 1) {
      const candidate = `${NEUTRAL_WORDS[start]}-${n}`;
      if (!used.has(candidate)) word = candidate;
    }
    used.add(word);
    out.set(domain, word);
  }
  return out;
}

/** The mapped local part: a role word (with a trailing number) is kept, anything else is person-<hash>. */
export function mappedLocal(local, address) {
  const lower = String(local).toLowerCase();
  const stem = lower.replace(/\d+$/, '');
  if (lower.length === 1 || ROLE_LOCALS.has(lower) || (stem && ROLE_LOCALS.has(stem))) return local;
  return `person-${hash(address)}`;
}

function sameCaseStart(original, replacement) {
  return /^[A-Z]/.test(original) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

/** The word in the case of the text it replaces: TASS → OAK, Tass → Oak, tass → oak. */
function caseLike(found, word) {
  if (/\p{Lu}/u.test(found) && found === found.toUpperCase()) return word.toUpperCase();
  if (/^\p{Lu}/u.test(found)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** The fixture number for a national number: first digit kept, then 0000 and three hashed digits. */
function fixtureNumber(national, used) {
  let n = parseInt(hash(national, 6), 16) % 1000;
  for (;;) {
    const candidate = `${national[0]}0000${String(n).padStart(3, '0')}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    n = (n + 1) % 1000;
  }
}

/** A pattern for the 8 national digits written with any of the usual separators, alone or after +47 / 0047. */
function phonePattern(national) {
  const body = [...national].join('[\\s.-]?');
  return new RegExp(`(?:(?<=\\+47[\\s.-]?)|(?<=0047[\\s.-]?)|(?<![\\d]))${body}(?!\\d)`, 'g');
}

function replaceDigits(text, digits) {
  let i = 0;
  return text.replace(/\d/g, () => digits[i++]);
}

/**
 * A domain as a pattern that also matches its regular-expression forms (name\.no in a regex
 * literal, name\\.no in a string built into a RegExp). The first dot's form is captured as `sep`.
 */
function domainSource(domain) {
  const labels = String(domain).split('.').map(escapeRegExp);
  return labels.slice(1).reduce((source, label, i) => `${source}${i === 0 ? '(?<sep>\\\\{0,2}\\.)' : '\\k<sep>'}${label}`, labels[0]);
}

/**
 * The flagged e-mail addresses and phone numbers in one file's text: [{ rule, value }]. An address
 * right after an escape in a string ("\npost@…") is read without the escape letter.
 */
export function fileHits(path, text, allowlist) {
  const hits = [];
  for (const { text: line } of splitLines(text)) {
    for (const hit of piiHitsInLine(path, line, { allowlist })) {
      if (hit.rule === 'phone') hits.push({ rule: 'phone', value: hit.value });
      if (hit.rule !== 'email') continue;
      let value = hit.value;
      if (line[hit.start - 1] === '\\' && /^[ntrbfv]/.test(value)) {
        value = value.slice(1);
        if (allowlist.emails.has(value.toLowerCase())) continue;
      }
      hits.push({ rule: 'email', value });
    }
  }
  return hits;
}

/**
 * Builds the value maps from the flagged hits. Returns { addresses: Map<lower address,
 * replacement>, domains: Map<lower domain, replacement domain>, words: Map<lower domain, word>,
 * phones: Map<national, fixture> }.
 */
export function buildMaps(hits) {
  const addresses = new Map();
  const phones = new Map();
  const used = new Set();
  const emails = [...new Set(hits.filter((h) => h.rule === 'email').map((h) => h.value.toLowerCase()))].sort();
  const companyDomains = emails.map((address) => address.slice(address.lastIndexOf('@') + 1)).filter((domain) => !PLATFORM_DOMAINS.has(domain));
  const words = assignWords(companyDomains);
  const domains = new Map([...words].map(([domain, word]) => [domain, `${word}.test`]));
  for (const address of emails) {
    const at = address.lastIndexOf('@');
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    addresses.set(address, `${mappedLocal(local, address)}@${PLATFORM_DOMAINS.has(domain) ? 'example.com' : domains.get(domain)}`);
  }
  const numbers = [...new Set(hits.filter((h) => h.rule === 'phone').map((h) => nationalPhoneDigits(h.value)))].sort();
  for (const national of numbers) phones.set(national, fixtureNumber(national, used));
  return { addresses, domains, words, phones };
}

// Addresses and host names in the text: a company name inside one is not changed by the name step.
const HOST_OR_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|(?<![\w-])[\p{L}\p{N}-]+(?:\\{0,2}\.[\p{L}\p{N}-]+)+/gu;

/** The company-name pattern for a domain label, or null when the label is too short or an ordinary word. */
export function namePattern(label) {
  const words = String(label).toLowerCase().split('-').filter(Boolean);
  const letters = words.join('');
  if (letters.length < 4 || COMMON_WORD_LABELS.has(letters) || words.every((word) => COMMON_WORD_LABELS.has(word))) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${words.map(escapeRegExp).join('[-\\s]?')}(?![\\p{L}\\p{N}_-])`, 'giu');
}

/** Name parts of a local part ("kari.nordmann" → kari, nordmann) worth looking for after a rewrite. */
function nameParts(local) {
  return String(local).toLowerCase().split(/[._+\-\d]+/).filter((part) => part.length >= 3 && !ROLE_LOCALS.has(part));
}

/** Lines whose letters, run together, still hold one of `needles` (letters only, lower case). */
function linesHolding(text, needles) {
  const wanted = needles.filter((needle) => needle.length >= 4);
  if (!wanted.length) return [];
  const lines = [];
  for (const { line, text: row } of splitLines(text)) {
    const letters = row.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (wanted.some((needle) => letters.includes(needle))) lines.push(line);
  }
  return lines;
}

/**
 * Applies the maps to one file's text. `domains`: the company domains with a flagged address in
 * this file (their URLs, host names and company names change here too). Returns { text, count }.
 */
export function applyMaps(text, maps, { path = '', domains = [], allowlist = { emails: new Set() } } = {}) {
  let out = text;
  let count = 0;
  for (const [address, replacement] of maps.addresses) {
    const at = address.lastIndexOf('@');
    const re = new RegExp(`(?:(?<=\\\\[ntrbfv])|(?<![A-Za-z0-9._%+-]))${escapeRegExp(address.slice(0, at))}@${domainSource(address.slice(at + 1))}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'gi');
    out = out.replace(re, (found, ...args) => {
      count += 1;
      const sep = args[args.length - 1]?.sep || '.';
      const foundLocal = found.slice(0, found.indexOf('@'));
      const [newLocal, newDomain] = replacement.split('@');
      // A kept local part keeps its case ("Kari@…"); the domain takes the found domain's first-letter case.
      const local = newLocal.toLowerCase() === foundLocal.toLowerCase() ? foundLocal : newLocal;
      return `${local}@${sameCaseStart(found.slice(found.indexOf('@') + 1), newDomain.replace(/\./g, sep))}`;
    });
  }
  for (const domain of domains) {
    const replacement = maps.domains.get(domain);
    if (!replacement) continue;
    const re = new RegExp(`(?<![A-Za-z0-9-])${domainSource(domain)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'gi');
    out = out.replace(re, (found, ...args) => {
      const groups = args[args.length - 1];
      const offset = args[args.length - 3];
      const whole = args[args.length - 2];
      // An address on this domain the allowlist keeps (a placeholder) keeps its domain.
      if (whole[offset - 1] === '@') {
        const local = whole.slice(0, offset - 1).match(/[A-Za-z0-9._%+-]+$/)?.[0] || '';
        if (allowlist.emails.has(`${local}@${domain}`.toLowerCase())) return found;
      }
      count += 1;
      return sameCaseStart(found, replacement.replace(/\./g, groups?.sep || '.'));
    });
  }
  for (const [national, fixture] of maps.phones) {
    out = out.replace(phonePattern(national), (found) => {
      count += 1;
      return replaceDigits(found, fixture);
    });
  }
  const names = domains
    .map((domain) => ({ re: namePattern(domainLabel(domain)), word: maps.words.get(domain) }))
    .filter((row) => row.re && row.word);
  if (names.length) {
    const regions = JS_FILE.test(path) ? textRegions(path, out) : [{ start: 0, end: out.length }];
    let result = '';
    let at = 0;
    for (const region of regions) {
      const slice = out.slice(region.start, region.end);
      const hosts = [...slice.matchAll(HOST_OR_ADDRESS)].map((m) => [m.index, m.index + m[0].length]);
      let next = slice;
      for (const { re, word } of names) {
        next = next.replace(re, (found, offset) => {
          if (hosts.some(([start, end]) => offset >= start && offset < end)) return found;
          count += 1;
          return caseLike(found, word);
        });
      }
      result += out.slice(at, region.start) + next;
      at = region.end;
    }
    out = result + out.slice(at);
  }
  return { text: out, count };
}

/**
 * The scrub over a repo or exported tree. Returns { changed: [{ path, count }], excluded: [{ path,
 * count }], runtime: [findings], left: [findings], review: [{ path, line, reason }], written,
 * ratchet, mapped }.
 */
export function run({ root, write = false } = {}) {
  const config = loadProfileConfig(root);
  const allowlist = loadAllowlist(root);
  const exclude = [...BUILTIN_EXCLUDE, ...config.scrubExclude].map(globToRegExp);
  const ctx = { allowlist, knownValues: [], retired: null, profile: { secrets: false, pii: true, plan: false, paths: 'none' }, names: null };
  const files = [];
  const hits = [];
  const excluded = [];
  const runtime = [];
  const others = [];
  for (const path of listRepoFiles(root)) {
    let buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;
    const text = buffer.toString('utf8');
    if (exclude.some((re) => re.test(path))) {
      const findings = scanLines(path, splitLines(text), ctx);
      if (findings.length) excluded.push({ path, count: findings.length });
      continue;
    }
    if (!isScrubTarget(path)) {
      runtime.push(...scanLines(path, splitLines(text), ctx));
      others.push({ path, text });
      continue;
    }
    const own = fileHits(path, text, allowlist);
    files.push({ path, text, hits: own });
    hits.push(...own);
  }
  const maps = buildMaps(hits);
  const changed = [];
  const left = [];
  const after = [];
  const review = [];
  const touched = new Set();
  for (const file of files) {
    const domains = [...new Set(file.hits.filter((h) => h.rule === 'email').map((h) => h.value.toLowerCase().split('@').pop()))]
      .filter((domain) => maps.domains.has(domain))
      .sort();
    const result = applyMaps(file.text, maps, { path: file.path, domains, allowlist });
    if (result.text !== file.text) {
      changed.push({ path: file.path, count: result.count });
      touched.add(file.path);
      if (write) writeFileSync(join(root, file.path), result.text);
    }
    const findings = scanLines(file.path, splitLines(result.text), ctx);
    left.push(...findings);
    after.push(...findings);
    // What the scrub cannot tell: a company name written another way, name parts of a replaced address.
    const labels = domains.filter((domain) => namePattern(domainLabel(domain))).map((domain) => domainLabel(domain).replace(/[^a-z0-9]/g, ''));
    for (const line of linesHolding(result.text, labels)) review.push({ path: file.path, line, reason: 'company name from a replaced domain' });
    const parts = file.hits.filter((h) => h.rule === 'email' && maps.addresses.get(h.value.toLowerCase())?.startsWith('person-'))
      .flatMap((h) => nameParts(h.value.slice(0, h.value.lastIndexOf('@'))));
    for (const line of linesHolding(result.text, [...new Set(parts)])) review.push({ path: file.path, line, reason: 'name part of a replaced address' });
  }
  // A replaced company domain that files without a flagged address on it still use.
  const replaced = [...maps.domains.keys()].filter((domain) => namePattern(domainLabel(domain)));
  if (replaced.length) {
    for (const file of [...files.filter((f) => !touched.has(f.path)), ...others]) {
      const lower = file.text.toLowerCase();
      if (!replaced.some((domain) => lower.includes(domain))) continue;
      for (const { line, text: row } of splitLines(file.text)) {
        if (replaced.some((domain) => row.toLowerCase().includes(domain))) review.push({ path: file.path, line, reason: 'a replaced company domain, used here unchanged' });
      }
    }
  }
  // The offender list keeps what the scrub may not touch: excluded files and production code.
  for (const row of excluded) for (let i = 0; i < row.count; i += 1) after.push({ path: row.path, kind: 'pii' });
  after.push(...runtime);
  let ratchet = '';
  if (write && config.ratchets.pii && existsSync(join(root, config.ratchets.pii))) {
    const file = join(root, config.ratchets.pii);
    const list = JSON.parse(readFileSync(file, 'utf8'));
    const next = shrinkRatchet(list, countFindingsByPath(after, ['pii']));
    if (JSON.stringify(next.files) !== JSON.stringify(list.files || {})) {
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      ratchet = config.ratchets.pii;
    }
  }
  return {
    changed,
    excluded,
    runtime,
    left,
    review,
    written: write,
    ratchet,
    mapped: { addresses: maps.addresses.size, domains: maps.domains.size, phones: maps.phones.size },
  };
}

function printReport(report) {
  const total = report.changed.reduce((sum, row) => sum + row.count, 0);
  console.log(`scrub-client-data: ${report.written ? 'replaced' : 'would replace'} ${total} value(s) in ${report.changed.length} file(s) (${report.mapped.addresses} address(es), ${report.mapped.domains} company domain(s), ${report.mapped.phones} phone number(s)).`);
  for (const row of report.changed) console.log(`  ${row.path}  (${row.count})`);
  if (report.excluded.length) {
    console.log('Left in excluded files (scrubExclude in scripts/security/scan-profile.json):');
    for (const row of report.excluded) console.log(`  ${row.path}  (${row.count})`);
  }
  if (report.runtime.length) {
    console.log('Left in production code (allowlist the contact or change it in a reviewed commit):');
    for (const finding of report.runtime) console.log(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  }
  if (report.left.length) {
    console.log('Still flagged after the rewrite (national ids, card numbers, or values in an unexpected form):');
    for (const finding of report.left) console.log(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  }
  if (report.review.length) {
    console.log(`To review by hand (${report.review.length}): business details the scrub does not know. Replace these fixtures with a synthetic business:`);
    for (const row of report.review) console.log(`  ${row.path}:${row.line}  ${row.reason}`);
  }
  if (report.ratchet) console.log(`Lowered ${report.ratchet}.`);
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) {
    console.error('usage: scrub-client-data.mjs --check | --write [--root DIR]');
    return 2;
  }
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(cwd, argv[rootIndex + 1]) : rootOrDir(cwd);
  const report = run({ root, write });
  printReport(report);
  return !write && report.changed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`scrub-client-data: ${error?.message || error}`);
    process.exit(2);
  }
}

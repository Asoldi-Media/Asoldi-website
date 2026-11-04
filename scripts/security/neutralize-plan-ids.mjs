#!/usr/bin/env node
/**
 * Rewords internal planning words (task and area ids, planning batch and branch names, the
 * planning documents' names) into neutral area words, in comments, Markdown prose and test titles
 * only. It never changes code: identifiers, string values, JSON and Markdown code spans are left,
 * and printed so a person can reword them in a separate, reviewed commit.
 *
 *   node scripts/security/neutralize-plan-ids.mjs --check [--root DIR] [--words FILE]   exit 1 when a file would change
 *   node scripts/security/neutralize-plan-ids.mjs --write [--root DIR] [--words FILE]   rewrite, then lower the offender list
 *
 * Every id becomes the word of its area. A words file kept outside the public repos can give a
 * more precise word per task (see loadWords). Deterministic and idempotent: the same input and
 * words file give the same output, and a second --write changes nothing. Files listed under
 * `codemodSkip` in scripts/security/scan-profile.json are left alone (copies of files from another
 * repo: reword them at the source and copy them again).
 *
 * Kept as they are and listed with the values left in code: an id quoted inside a comment
 * (owner: '<id>' in an example), which stands for a value; and an id whose words already follow
 * it in the next few words, which is dropped instead of doubled.
 *
 * JavaScript and TypeScript files are parsed with the TypeScript compiler, so a comment is a
 * comment and a test title is the first argument of test()/it()/describe(). After rewriting, each
 * file is parsed again and its code tokens (everything but comments and test titles) must be
 * unchanged, or the file is not written and the run fails.
 *
 * Run it from the repo it rewrites, or with --root for another checkout or an exported tree
 * (TypeScript is loaded from this repo's node_modules).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  countFindingsByPath,
  decodeText,
  encodeText,
  isProbablyBinary,
  shrinkRatchet,
  scanLines,
  splitLines,
} from './secret-scan-lib.mjs';
import { isTrackedIn, listRepoFiles, loadAllowlist, loadProfileConfig, rootOrDir } from './secret-scan.mjs';

// ---------------------------------------------------------------- the word table

/** Area words by area number: the only words this public file holds. */
export const AREA_WORDS = Object.freeze({
  0: 'platform',
  1: 'import',
  2: 'site intelligence',
  3: 'branding',
  4: 'developer automation',
  5: 'publish',
  6: 'CMS',
  7: 'email',
  8: 'delivery',
  9: 'SEO',
});

/**
 * Words for single tasks are not kept in this public file. They come from a JSON file outside the
 * repo, { "areas": { "<n>": word }, "tasks": { "<area>.<task>": word } }, given with --words, the
 * PLAN_WORDS_FILE environment variable or ~/.asoldi-secrets/plan-words.json. Without one, every
 * id gets the word of its area. A words file tracked in the repo being rewritten is an error.
 */
export function defaultWordsFile(env = process.env) {
  return env.PLAN_WORDS_FILE || join(homedir(), '.asoldi-secrets', 'plan-words.json');
}

/** { areas, tasks } with string words only. */
export function normalizeWords(raw = {}) {
  const pick = (table) => Object.fromEntries(
    Object.entries(table && typeof table === 'object' ? table : {})
      .filter(([, word]) => typeof word === 'string' && word.trim())
      .map(([key, word]) => [String(key), word.trim()]),
  );
  return { areas: pick(raw.areas), tasks: pick(raw.tasks) };
}

/** The words in `file`, or null when there is none. `required`: a missing file is an error. */
export function loadWords(file, root, { required = false } = {}) {
  if (!file) return null;
  if (!existsSync(file)) {
    if (required) throw new Error('the --words file does not exist');
    return null;
  }
  if (isTrackedIn(root, file)) throw new Error('the words file is tracked in this repo; keep it outside the repo');
  return normalizeWords(JSON.parse(readFileSync(file, 'utf8')));
}

// Words that keep their lower-case first letter at the start of a sentence (code names).
const KEEP_CASE = /^(?:cms-spec|seo-ops)\b/;

export function taskWord(area, task, words = null) {
  const key = task ? `${Number(area)}.${task}` : '';
  return (key && words?.tasks?.[key]) || words?.areas?.[String(Number(area))] || AREA_WORDS[Number(area)] || 'internal';
}

// One id: area digits, optional task, optional "/<area>.<task>" continuations, optional section reference.
const ID = String.raw`\bWS(\d{1,2})(?:\.(\d{1,2}[a-z]?))?((?:\/\d{1,2}\.\d{1,2}[a-z]?)*)(?:\s?§\s?\d+(?:\.\d+)*(?: [a-z](?![\w]))?)?\b`;
const SEP = String.raw`(?:\s*[,;+&]\s*|\s*\/\s*|\s+(?:and|or|og)\s+)`;
const RUN_RE = new RegExp(`${ID}(?:${SEP}${ID})*`, 'g');
const SECTION_OF_PLAN_RE = /§\s?\d+(?:\.\d+)*\s+of\s+the\s+WS(\d{1,2})\s+plan\b/g;
const ID_RE = new RegExp(ID, 'g');
const OTHER_RULES = [
  { re: /\bwork[ -]?(stream)(s)?\b/gi, word: (m) => matchCase(m[0], m[2] ? 'areas' : 'area') },
  { re: /\bwave[ -]?(\d{1,2}[a-z]?)\b/gi, word: (m) => matchCase(m[0], `release ${m[1]}`) },
  { re: /\bwf\/w\d{1,2}[a-z]?(?:-[A-Za-z0-9._-]+)?/gi, word: () => 'a feature branch' },
  {
    re: /\b(?:MASTER[-_ ]PLAN|K-PHASE[-_]TASKS|L-TRANSCRIPT[-_]COVERAGE|USER[-_]BRIEF|[A-L]2?-WS\d{1,2}-[a-z0-9-]+|publish-ready-\d{4}-\d{2})(?:\.md)?(?:\s?§\s?\d+(?:\.\d+)*)?/g,
    word: () => 'the internal notes',
  },
];

function matchCase(original, word) {
  return /^[A-Z]/.test(original) ? word[0].toUpperCase() + word.slice(1) : word;
}

function termsOfRun(runText, table) {
  const terms = [];
  for (const m of runText.matchAll(ID_RE)) {
    const words = [taskWord(m[1], m[2], table)];
    for (const extra of String(m[3] || '').split('/').filter(Boolean)) {
      const [area, task] = extra.split('.');
      words.push(taskWord(area, task, table));
    }
    for (const word of words) if (!terms.some((t) => t.toLowerCase() === word.toLowerCase())) terms.push(word);
  }
  return terms;
}

function separatorOf(runText) {
  const between = runText.replace(ID_RE, '\u0000').split('\u0000').slice(1, -1);
  const first = between.find(Boolean) || ', ';
  if (/\//.test(first)) return ' / ';
  if (/\band\b/.test(first)) return ' and ';
  if (/\bor\b/.test(first)) return ' or ';
  if (/\bog\b/.test(first)) return ' og ';
  return ', ';
}

// What may precede a sentence start on a line: comment markers, list and heading marks, quotes.
const LINE_LEAD = /^[\s/*#>|`'"-]*(?:\d+\.\s+)?$/;

function atSentenceStart(text, index) {
  const lineStart = Math.max(text.lastIndexOf('\n', index - 1) + 1, 0);
  const before = text.slice(lineStart, index);
  if (LINE_LEAD.test(before)) return true;
  return /[.!?]\s+$/.test(before);
}

function capitalize(word) {
  if (KEEP_CASE.test(word) || !/^[a-z]/.test(word)) return word;
  return word[0].toUpperCase() + word.slice(1);
}

const QUOTES = new Set(["'", '"', '`']);
const WORD_SPLIT = /[^\p{L}\p{N}-]+/u;

/** True when every word of `terms` stands in the next few words after `end` on the same line. */
function wordsFollow(terms, whole, end) {
  const lineEnd = whole.indexOf('\n', end);
  const following = whole.slice(end, lineEnd === -1 ? whole.length : lineEnd).toLowerCase().split(WORD_SPLIT).filter(Boolean).slice(0, 8);
  const needed = terms.flatMap((term) => term.toLowerCase().split(WORD_SPLIT)).filter(Boolean);
  return needed.length > 0 && needed.every((word) => following.includes(word));
}

/**
 * The text with planning words reworded. `startsSentence`: the text's first character starts a
 * sentence (a test title). `words`: a loadWords() result (null: area words only). Returns
 * { text, count }.
 */
export function neutralizeText(text, { startsSentence = false, words = null } = {}) {
  let count = 0;
  // "§<n> of the <area id> plan" points into the planning documents: it becomes "the <area> design".
  let out = String(text).replace(SECTION_OF_PLAN_RE, (_m, area) => {
    count += 1;
    return `the ${taskWord(area, '', words)} design`;
  });
  out = out.replace(RUN_RE, (run, ...rest) => {
    const offset = rest[rest.length - 2];
    const whole = rest[rest.length - 1];
    // A quoted id stands for a value ("owner: '<id>'" in an example): left, and listed with the values.
    const quote = whole[offset - 1];
    if (QUOTES.has(quote) && whole[offset + run.length] === quote) return run;
    count += 1;
    const terms = termsOfRun(run, words);
    // "(…)" holding only ids: drop it when the words already stand right before it on the line.
    const open = whole.slice(0, offset).match(/\(\s*$/);
    const close = whole.slice(offset + run.length).match(/^\s*\)/);
    let replacement = terms.join(separatorOf(run));
    if (open && close) {
      const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
      const before = whole.slice(lineStart, offset - open[0].length).toLowerCase();
      if (terms.every((term) => before.includes(term.toLowerCase()))) return '\u0001';
    }
    const start = (offset === 0 && startsSentence) || atSentenceStart(whole, offset);
    // The words already follow ("<id> shared LLM core"): drop the id instead of doubling them.
    if (!open && wordsFollow(terms, whole, offset + run.length)) return start ? '\u0005' : '\u0004';
    if (start) replacement = capitalize(replacement);
    // Mark the replacement, so a word repeated right after it ("<word> <word>") can be dropped below.
    return `\u0002${replacement}\u0003`;
  });
  // A dropped "(…)" leaves "\u0001" inside its parentheses: remove both and the space before them.
  out = out.replace(/\s?\(\s*\u0001\s*\)/g, '');
  // A dropped id leaves "\u0004" (or "\u0005" at a sentence start): remove it with the colon or
  // dash and the space after it, and start the sentence with a capital letter.
  out = out.replace(/([\u0004\u0005])(?:\s*[:–—-]\s+|\s*:\s*|\s+)?(\S?)/g, (_m, mark, ch) => (mark === '\u0005' ? ch.toUpperCase() : ch));
  // "<id> heartbeat" → "Maker heartbeat heartbeat": keep one. "<id>'s" after a word ending in s → "s'".
  out = out.replace(/([\w-]+)\u0003(\s+)\1(?![\w-])/gi, '$1\u0003');
  out = out.replace(/s\u0003's\b/g, "s\u0003'");
  out = out.replace(/[\u0002\u0003]/g, '');
  for (const rule of OTHER_RULES) {
    out = out.replace(rule.re, (...m) => {
      count += 1;
      return rule.word(m);
    });
  }
  return { text: out, count };
}

// ---------------------------------------------------------------- regions a rewrite may touch

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const MD_EXT = /\.(?:md|mdc|markdown)$/i;
const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?|(?:^|\/)test-[\w.-]+\.m?js)$/i;
const TEST_CALLEES = new Set(['test', 'it', 'describe', 'suite']);
const TEST_OWNERS = new Set(['t', 'test', 'it', 'describe', 'suite']);

function scriptKind(path) {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function parse(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

const K = ts.SyntaxKind;
// Tokens whose text may hold "//" or "/*" without being a comment.
const OPAQUE_KINDS = new Set([
  K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail,
  K.RegularExpressionLiteral, K.JsxText,
]);
// Nodes whose text is a value or a name: compared one by one when checking that code is unchanged.
const VALUE_KINDS = new Set([...OPAQUE_KINDS, K.Identifier, K.PrivateIdentifier, K.NumericLiteral, K.BigIntLiteral]);

/** [start, end) of every string, template part, regular expression and JSX text, in order. */
function opaqueRanges(sourceFile) {
  const out = [];
  const visit = (node) => {
    if (OPAQUE_KINDS.has(node.kind)) out.push([node.kind === K.JsxText ? node.pos : node.getStart(sourceFile), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Every comment in the file: a linear scan for "//" and "/*" that steps over the parser's string,
 * template, regular-expression and JSX-text tokens, the only places those marks can stand
 * without starting a comment.
 */
function commentRanges(text, sourceFile) {
  const opaque = opaqueRanges(sourceFile);
  const out = [];
  let next = 0;
  let i = text.startsWith('#!') ? text.indexOf('\n') + 1 || text.length : 0;
  while (i < text.length) {
    while (next < opaque.length && opaque[next][1] <= i) next += 1;
    if (next < opaque.length && opaque[next][0] <= i) {
      i = opaque[next][1];
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      if (text[end - 1] === '\r') end -= 1;
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The parts of a JavaScript or TypeScript file that hold text rather than code: every comment,
 * string, template part, regular expression and JSX text, as [{ start, end, kind }] sorted by
 * start. Names (identifiers, keys written without quotes) are never inside one.
 */
export function textRegions(path, text) {
  const sourceFile = parse(path, text);
  const regions = commentRanges(text, sourceFile);
  for (const [start, end] of opaqueRanges(sourceFile)) regions.push({ start, end, kind: 'literal' });
  return regions.sort((a, b) => a.start - b.start);
}

function isTestCallee(expression) {
  if (ts.isIdentifier(expression)) return TEST_CALLEES.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expression.expression;
    return ts.isIdentifier(owner) && TEST_OWNERS.has(owner.text) && (TEST_CALLEES.has(expression.name.text) || ['skip', 'only', 'todo'].includes(expression.name.text));
  }
  return false;
}

/**
 * Test-title literal tokens: the first argument of test()/it()/describe() and their
 * .skip/.only/.todo forms. A template title gives its text parts (head, middles, tail), never
 * the expressions between them. Returns [{ node, start, end }] with start..end the text inside
 * the quotes or between the template marks.
 */
function testTitleParts(sourceFile) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length && isTestCallee(node.expression)) {
      const first = node.arguments[0];
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
        out.push({ node: first, start: first.getStart(sourceFile) + 1, end: first.getEnd() - 1 });
      } else if (ts.isTemplateExpression(first)) {
        const head = first.head;
        out.push({ node: head, start: head.getStart(sourceFile) + 1, end: head.getEnd() - 2 });
        for (const span of first.templateSpans) {
          const literal = span.literal;
          const close = ts.isTemplateTail(literal) ? 1 : 2;
          out.push({ node: literal, start: literal.getStart(sourceFile) + 1, end: literal.getEnd() - close });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * The parts of a JavaScript or TypeScript file the codemod may rewrite: every comment, and in a
 * test file the inside of each test title. [{ start, end, kind: 'comment'|'title' }], sorted.
 */
export function jsRegions(path, text, sourceFile = parse(path, text)) {
  const regions = commentRanges(text, sourceFile);
  if (TEST_FILE.test(path)) {
    for (const part of testTitleParts(sourceFile)) {
      if (part.end > part.start) regions.push({ start: part.start, end: part.end, kind: part.node.parent && ts.isTemplateSpan(part.node.parent) ? 'title-part' : 'title' });
    }
  }
  return regions.sort((a, b) => a.start - b.start);
}

/**
 * The file's syntax without its comments: every node kind in order, with the text of each name and
 * literal (test-title text as a placeholder). Two versions with the same list differ only in
 * comments, whitespace and test titles. With `literals: false` strings, templates, regular
 * expressions and JSX text are placeholders too: two versions with the same list have the same
 * names and structure.
 */
export function codeTokens(path, text, sourceFile = parse(path, text), { literals = true } = {}) {
  const titles = new Set(TEST_FILE.test(path) ? testTitleParts(sourceFile).map((part) => part.node) : []);
  const out = [];
  const visit = (node) => {
    if (titles.has(node)) out.push(`${node.kind}:<title>`);
    else if (!literals && OPAQUE_KINDS.has(node.kind)) out.push(`${node.kind}:<text>`);
    else if (node.kind === K.JsxText) out.push(`${node.kind}:${text.slice(node.pos, node.end)}`);
    else if (VALUE_KINDS.has(node.kind)) out.push(`${node.kind}:${node.getText(sourceFile)}`);
    else out.push(String(node.kind));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Markdown prose: everything outside fenced code blocks and inline code spans. */
export function markdownRegions(text) {
  const regions = [];
  let fence = null;
  let at = 0;
  for (const line of String(text).split('\n')) {
    const lineStart = at;
    at += line.length + 1;
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    let cursor = 0;
    for (const span of line.matchAll(/(`+)[^`]*?\1/g)) {
      if (span.index > cursor) regions.push({ start: lineStart + cursor, end: lineStart + span.index, kind: 'prose' });
      cursor = span.index + span[0].length;
    }
    if (cursor < line.length) regions.push({ start: lineStart + cursor, end: lineStart + line.length, kind: 'prose' });
  }
  return regions;
}

function rewriteRegions(text, regions, words) {
  let out = '';
  let at = 0;
  let count = 0;
  for (const region of regions) {
    const slice = text.slice(region.start, region.end);
    const result = neutralizeText(slice, { startsSentence: region.kind === 'title', words });
    out += text.slice(at, region.start) + result.text;
    at = region.end;
    count += result.count;
  }
  return { text: out + text.slice(at), count };
}

const PLAN_ONLY = { secrets: false, pii: false, plan: true, paths: 'none' };
const QUICK = /\bWS\d|wave[ -]?\d|wf\/w\d|work[ -]?stream|MASTER[-_ ]PLAN|K-PHASE|TRANSCRIPT[-_]COVERAGE|USER[-_]BRIEF|-WS\d|publish-ready-\d/i;

function globToRegExp(glob) {
  const source = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`);
}

/**
 * One file → { text, count, error }. `error` when the rewrite would change a code token (the
 * file is then left as it is).
 */
export function neutralizeFile(path, text, { words = null } = {}) {
  if (!QUICK.test(text)) return { text, count: 0 };
  if (MD_EXT.test(path)) return rewriteRegions(text, markdownRegions(text), words);
  if (!JS_EXT.test(path)) return { text, count: 0 };
  const sourceFile = parse(path, text);
  const result = rewriteRegions(text, jsRegions(path, text, sourceFile), words);
  if (!result.count) return { text, count: 0 };
  const before = codeTokens(path, text, sourceFile);
  const after = codeTokens(path, result.text);
  if (before.length !== after.length || before.some((token, i) => token !== after[i])) {
    return { text, count: 0, error: 'a code token would change; left as it is' };
  }
  return result;
}

/**
 * The codemod over a repo or exported tree. Returns { changed: [{ path, count }], left: findings
 * outside comments, docs and titles, skipped: [{ path, count }], errors: [{ path, error }],
 * written: bool, ratchet: <list file lowered, or ''> }. `words`: a loadWords() result (null: area
 * words only); run() never looks for a words file itself.
 */
export function run({ root, write = false, words = null } = {}) {
  const config = loadProfileConfig(root);
  const allowlist = loadAllowlist(root);
  const skip = config.codemodSkip.map(globToRegExp);
  const ctx = { allowlist, knownValues: [], retired: null, profile: PLAN_ONLY, names: null };
  const changed = [];
  const left = [];
  const skipped = [];
  const errors = [];
  const after = [];
  for (const path of listRepoFiles(root)) {
    const abs = join(root, path);
    let buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;
    // UTF-8, or other text (Latin-1) byte for byte, so a rewrite changes only the words it replaces.
    const read = decodeText(buffer);
    if (!read) continue;
    const text = read.text;
    if (!QUICK.test(text)) continue;
    if (skip.some((re) => re.test(path))) {
      const findings = scanLines(path, splitLines(text), ctx);
      if (findings.length) skipped.push({ path, count: findings.length });
      after.push(...findings);
      continue;
    }
    const result = neutralizeFile(path, text, { words });
    if (result.error) errors.push({ path, error: result.error });
    if (result.count && result.text !== text) {
      let bytes = null;
      try {
        bytes = encodeText(result.text, read);
      } catch (error) {
        errors.push({ path, error: `${error.message}; left as it was` });
      }
      if (bytes) {
        changed.push({ path, count: result.count });
        if (write) writeFileSync(abs, bytes);
      }
    }
    const findings = scanLines(path, splitLines(result.text), ctx);
    left.push(...findings);
    after.push(...findings);
  }
  let ratchet = '';
  if (write && config.ratchets.plan && existsSync(join(root, config.ratchets.plan))) {
    const file = join(root, config.ratchets.plan);
    const list = JSON.parse(readFileSync(file, 'utf8'));
    const next = shrinkRatchet(list, countFindingsByPath(after, ['plan']));
    if (JSON.stringify(next.files) !== JSON.stringify(list.files || {})) {
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      ratchet = config.ratchets.plan;
    }
  }
  return { changed, left, skipped, errors, written: write, ratchet, words: words ? Object.keys(words.tasks).length : 0 };
}

function printReport(report) {
  const total = report.changed.reduce((sum, row) => sum + row.count, 0);
  const verb = report.written ? 'rewrote' : 'would rewrite';
  console.log(`neutralize-plan-ids: ${verb} ${total} planning word(s) in ${report.changed.length} file(s) (${report.words ? `area words and ${report.words} task word(s) from the words file` : 'area words only'}).`);
  for (const row of report.changed) console.log(`  ${row.path}  (${row.count})`);
  if (report.left.length) {
    console.log(`Left in code, JSON, Markdown code spans or quoted in comments (${report.left.length}); reword them in a separate, reviewed commit:`);
    for (const finding of report.left) console.log(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  }
  if (report.skipped.length) {
    console.log('Skipped copies (reword at the source, then copy them again):');
    for (const row of report.skipped) console.log(`  ${row.path}  (${row.count})`);
  }
  for (const row of report.errors) console.log(`ERROR ${row.path}: ${row.error}`);
  if (report.ratchet) console.log(`Lowered ${report.ratchet}.`);
  if (report.written && report.changed.some((row) => row.path.startsWith('packages/suite/'))) {
    console.log('Files under packages/suite changed: restamp the suite manifest with scripts/sync-suite.mjs and copy the suite to its consumers again.');
  }
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env } = {}) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) {
    console.error('usage: neutralize-plan-ids.mjs --check | --write [--root DIR] [--words FILE]');
    return 2;
  }
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(cwd, argv[rootIndex + 1]) : rootOrDir(cwd);
  const wordsIndex = argv.indexOf('--words');
  const words = wordsIndex >= 0
    ? loadWords(resolve(cwd, argv[wordsIndex + 1] || ''), root, { required: true })
    : loadWords(defaultWordsFile(env), root);
  const report = run({ root, write, words });
  printReport(report);
  if (report.errors.length) return 2;
  return !write && report.changed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`neutralize-plan-ids: ${error?.message || error}`);
    process.exit(2);
  }
}

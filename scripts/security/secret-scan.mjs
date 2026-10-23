#!/usr/bin/env node
/**
 * Secret and client-data scan for this public repo.
 *
 *   node scripts/security/secret-scan.mjs --staged        pre-commit: lines and paths being committed
 *   node scripts/security/secret-scan.mjs --commit-msg F  commit-msg: the message being committed
 *   node scripts/security/secret-scan.mjs --pre-push      pre-push: every commit being pushed (refs on stdin),
 *                                                          with its message and any merge-resolution lines
 *   node scripts/security/secret-scan.mjs --range A..B    every commit in a range
 *   node scripts/security/secret-scan.mjs --tracked       audit: every tracked file as it is now
 *   node scripts/security/secret-scan.mjs --history       audit: every commit on every branch
 *   node scripts/security/secret-scan.mjs --stdin         text piped in
 *   node scripts/security/secret-scan.mjs <files…>        those files
 *
 * Options: --json, --summary, --secrets-only, --no-env, --no-retired.
 *
 * What counts as a finding (lib: secret-scan-lib.mjs):
 *   - credential patterns (private keys, sk-/AIza/ghp_/xkeysib-/sk_live_/whsec_/JWT service_role …);
 *   - any 12+ character secret-like value from the local .env files (this checkout's main .env,
 *     the sibling website-maker and website-cms .env files and ~/.asoldi-website-data/production.env,
 *     or SECRET_SCAN_ENV_FILES), compared in memory;
 *   - retired (rotated) secrets: salted hashes in ~/.asoldi-secrets/retired.json
 *     (or ASOLDI_RETIRED_SECRETS), never stored in the repo;
 *   - client personal data: e-mail addresses outside allowed domains, +47 phone numbers,
 *     fødselsnummer, card numbers;
 *   - paths that hold secrets or client data (.env, keys, data JSON, transcripts, daily logs, …).
 * Fake test fixtures are allowed through .secret-scan-allowlist.json (path + rule + reason);
 * an allowlisted secret hit must still look fake, so a real key pasted there is caught.
 * commitEntries (commit + path + line + rule + reason) let one finding through in one past
 * commit, for history that is not rewritten; they never cover .env values or retired secrets,
 * and the scan output lists every finding they let through.
 *
 * Output never contains a matched value. Exit 0 clean, 1 findings, 2 error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRetiredMatcher,
  commitEntryFor,
  formatFinding,
  isProbablyBinary,
  knownValuesFromEnv,
  normalizeAllowlist,
  parseEnvText,
  scanLines,
  scanPath,
  splitLines,
} from './secret-scan-lib.mjs';

export const ALLOWLIST_FILE = '.secret-scan-allowlist.json';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ZERO_SHA = /^0+$/;

function git(args, { cwd, input, maxBuffer = 512 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    input,
    maxBuffer,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitText(args, opts) {
  return git(args, opts).toString('utf8');
}

export function repoRootOf(cwd) {
  return gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

function mainCheckoutRoot(cwd) {
  try {
    const common = gitText(['rev-parse', '--git-common-dir'], { cwd }).trim();
    const abs = isAbsolute(common) ? common : resolve(cwd, common);
    return dirname(abs);
  } catch {
    return '';
  }
}

export function defaultEnvFiles(cwd, env = process.env) {
  if (env.SECRET_SCAN_ENV_FILES !== undefined) {
    return env.SECRET_SCAN_ENV_FILES.split(delimiter).map((p) => p.trim()).filter(Boolean);
  }
  const files = new Set();
  const root = repoRootOf(cwd);
  const main = mainCheckoutRoot(cwd) || root;
  files.add(join(root, '.env'));
  files.add(join(main, '.env'));
  for (const sibling of ['asoldi-website', 'website-maker', 'website-cms']) {
    files.add(join(dirname(main), sibling, '.env'));
  }
  files.add(join(homedir(), '.asoldi-website-data', 'production.env'));
  return [...files];
}

export function loadKnownValues(files) {
  const values = [];
  const seen = new Set();
  for (const file of files) {
    if (!existsSync(file)) continue;
    let map;
    try {
      map = parseEnvText(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const label = file.replace(/\\/g, '/').split('/').slice(-2).join('/');
    for (const row of knownValuesFromEnv(map, label)) {
      if (seen.has(row.value)) continue;
      seen.add(row.value);
      values.push(row);
    }
  }
  return values;
}

export function defaultRetiredFile(env = process.env) {
  return env.ASOLDI_RETIRED_SECRETS || join(homedir(), '.asoldi-secrets', 'retired.json');
}

export function loadRetired(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return buildRetiredMatcher(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function loadAllowlist(root) {
  const file = join(root, ALLOWLIST_FILE);
  if (!existsSync(file)) return normalizeAllowlist({});
  return normalizeAllowlist(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Parses `git diff`/`git log -p` output with -U0 into { path → [{line,text}] } per commit,
 * plus the list of paths that were added or changed.
 */
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Git quotes paths with special characters C-style ("b/a\"b", octal bytes for UTF-8). */
export function unquoteGitPath(value) {
  const text = String(value || '');
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  const bytes = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next || '')) {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Regular hunks: '@@ -a,b +c,d @@'. Combined (merge) hunks: '@@@ -a,b -c,d +e,f @@@', one '-' range per parent.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const COMBINED_HUNK_HEADER = /^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/;
const MESSAGE_END = '\u0001endmsg';

/**
 * One line of a hunk with `parents` marker columns (git's combined diff format; one column for a
 * regular diff). A line with a '-' column is not in the result and is in each parent marked '-'.
 * Any other line is in the result and in each parent marked ' ' ('+': that parent lacks it).
 * Returns null when the line does not fit the counts that are left (the hunk is over).
 */
function hunkLine(lineText, hunk) {
  const columns = lineText.slice(0, hunk.parents);
  if (columns.length !== hunk.parents || /[^ +-]/.test(columns)) return null;
  const inResult = !columns.includes('-');
  if (!inResult && columns.includes('+')) return null;
  const inParent = [...columns].map((column) => (inResult ? column === ' ' : column === '-'));
  if (inResult && hunk.newLeft <= 0) return null;
  if (!inResult && !inParent.some(Boolean)) return null;
  for (let i = 0; i < hunk.parents; i += 1) {
    if (inParent[i] && hunk.oldLeft[i] <= 0) return null;
  }
  for (let i = 0; i < hunk.parents; i += 1) if (inParent[i]) hunk.oldLeft[i] -= 1;
  if (inResult) hunk.newLeft -= 1;
  // Added relative to every parent: a new line, or a line written while resolving a merge.
  return { inResult, added: !columns.includes(' ') && inResult };
}

/**
 * '--- '/'+++ ' are file headers only between 'diff --git' (or 'diff --cc') and the first hunk of
 * that file. Inside a hunk exactly the line counts from the hunk header are consumed, so an added
 * line whose text starts with '++ ' is content and cannot end or re-attribute the file.
 *
 * With `git log --format=%x01commit %H%n%B%n%x01endmsg` the commit messages are returned too, as
 * entries { commit, path: '', message: true, lines } (commit messages are public as well).
 */
export function parsePatch(text) {
  const files = [];
  let commit = '';
  let current = null;
  let message = null;
  let state = 'none'; // 'message' | 'header' | 'hunk' | 'between' (after a hunk, before the next one or file)
  let hunk = null;
  let lineNo = 0;
  for (const raw of String(text).split('\n')) {
    const lineText = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (state === 'message') {
      if (lineText === MESSAGE_END) {
        state = 'none';
        continue;
      }
      message.lines.push({ line: message.lines.length + 1, text: lineText });
      continue;
    }
    if (state === 'hunk') {
      const open = hunk.newLeft > 0 || hunk.oldLeft.some((n) => n > 0);
      if (open) {
        const row = hunkLine(lineText, hunk);
        if (row) {
          if (row.added && current) current.lines.push({ line: lineNo, text: lineText.slice(hunk.parents) });
          if (row.inResult) lineNo += 1;
          continue;
        }
        if (lineText.startsWith('\\')) continue; // "\ No newline at end of file"
      } else if (lineText.startsWith('\\')) {
        continue;
      }
      state = 'between';
    }
    if (lineText.startsWith('\u0001commit ')) {
      commit = lineText.slice(8).trim();
      current = null;
      message = { commit, path: '', message: true, lines: [] };
      files.push(message);
      state = 'message';
      continue;
    }
    if (lineText.startsWith('diff --git ') || lineText.startsWith('diff --cc ') || lineText.startsWith('diff --combined ')) {
      current = null;
      state = 'header';
      continue;
    }
    if (state === 'header') {
      if (lineText.startsWith('+++ ')) {
        // Git ends the header with a tab when the path contains a space.
        const target = unquoteGitPath(lineText.slice(4).replace(/\t$/, ''));
        if (target === '/dev/null') {
          current = null;
        } else {
          current = { commit, path: target.startsWith('b/') ? target.slice(2) : target, lines: [] };
          files.push(current);
        }
        continue;
      }
      if (lineText.startsWith('Binary files ')) {
        const m = lineText.match(/ and (?:"b\/(.+)"|b\/(.+)) differ$/);
        if (m) files.push({ commit, path: m[1] !== undefined ? unquoteGitPath(`"${m[1]}"`) : m[2], lines: [], binary: true });
        continue;
      }
    }
    if ((state === 'header' || state === 'between') && lineText.startsWith('@@')) {
      const combined = lineText.match(COMBINED_HUNK_HEADER);
      if (combined) {
        const parents = combined[1].length - 1;
        const ranges = combined[2].trim().split(' ');
        if (ranges.length !== parents) continue;
        hunk = {
          parents,
          oldLeft: ranges.map((range) => (range.includes(',') ? Number(range.split(',')[1]) : 1)),
          newLeft: combined[4] === undefined ? 1 : Number(combined[4]),
        };
        lineNo = Number(combined[3]);
        state = 'hunk';
        continue;
      }
      const m = lineText.match(HUNK_HEADER);
      if (!m) continue;
      hunk = {
        parents: 1,
        oldLeft: [m[1] === undefined ? 1 : Number(m[1])],
        newLeft: m[3] === undefined ? 1 : Number(m[3]),
      };
      lineNo = Number(m[2]);
      state = 'hunk';
    }
  }
  return files;
}

/**
 * Commit message lines to scan. The e-mail in a "Co-authored-by: Name <mail>" style trailer is a
 * git identity (public in every commit's author field anyway), so only that part is dropped;
 * the rest of the line is still scanned.
 */
export function messageLinesForScan(lines) {
  return lines.map((row) => ({ ...row, text: row.text.replace(/^([A-Za-z][A-Za-z-]*-by:[^<\n]*)<[^<>\s@]+@[^<>\s]+>\s*$/i, '$1') }));
}

// Images, fonts, audio and video: scanned by path only (their bytes are not text).
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|m4a)$/i;

function scanPatchFiles(files, ctx) {
  const findings = [];
  for (const file of files) {
    if (file.message) {
      // Commit messages are public too; path rules do not apply to them.
      const label = `${file.commit.slice(0, 10)}:commit-message`;
      for (const finding of scanLines('', messageLinesForScan(file.lines), ctx)) findings.push({ ...finding, path: label });
      continue;
    }
    const label = file.commit ? `${file.commit.slice(0, 10)}:${file.path}` : file.path;
    const pathFinding = scanPath(file.path, ctx);
    if (pathFinding) findings.push({ ...pathFinding, path: label });
    if (file.binary || MEDIA_EXT.test(file.path)) continue;
    for (const finding of scanLines(file.path, file.lines, ctx)) {
      // A commit-pinned allowlist entry covers this one line of this one commit (never a .env
      // value or a retired secret); the count is reported so nothing passes silently.
      if (file.commit && commitEntryFor(ctx.allowlist, file.commit, finding)) {
        if (Array.isArray(ctx.allowedByCommit)) ctx.allowedByCommit.push(`${label}:${finding.line} ${finding.rule}`);
        continue;
      }
      findings.push({ ...finding, path: label });
    }
  }
  return findings;
}

/**
 * Diff options that do not depend on the user's git config: no rename detection (a 100% rename
 * has no '+++' header and no content lines), fixed a/ b/ prefixes (diff.noprefix and
 * diff.mnemonicPrefix change them), whole-repo paths (diff.relative), every file as text (a
 * secret in a file git thinks is binary is still found), no external diff or textconv.
 * Deleted files need no filter: their header is '+++ /dev/null' and they add no lines. (On
 * `git log`, --diff-filter would also drop whole commits, and with them their messages.)
 */
export const DIFF_ARGS = [
  '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--text',
  '--src-prefix=a/', '--dst-prefix=b/',
];
// --cc: merge commits show the lines that differ from every parent, so a secret written while
// resolving a conflict (or added to a merge with --amend) is scanned; regular commits as usual.
const LOG_ARGS = ['-p', '--cc', '--no-show-signature', ...DIFF_ARGS, `--format=%x01commit %H%n%B%n${MESSAGE_END}`];

export function scanStaged(cwd, ctx) {
  const patch = gitText(['diff', '--cached', ...DIFF_ARGS, '--diff-filter=ACMR'], { cwd });
  return scanPatchFiles(parsePatch(patch), ctx);
}

export function scanRevisions(cwd, revArgs, ctx) {
  const patch = gitText(['log', ...LOG_ARGS, ...revArgs], { cwd });
  return scanPatchFiles(parsePatch(patch), ctx);
}

/** The commit-msg hook: the message file, without git's '#' comment lines and what follows a scissors line. */
export function scanCommitMessageFile(file, ctx) {
  const lines = [];
  for (const row of splitLines(readFileSync(file, 'utf8'))) {
    if (/^# -+ >8 -+$/.test(row.text)) break;
    if (row.text.startsWith('#')) continue;
    lines.push(row);
  }
  return scanLines('', messageLinesForScan(lines), ctx).map((finding) => ({ ...finding, path: 'commit-message' }));
}

export function commitExists(cwd, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per line. When the remote
 * sha is unknown here (someone else pushed it), scan everything not on any remote-tracking ref.
 */
export function prePushRevArgs(stdinText, { hasCommit = () => true } = {}) {
  const sets = [];
  for (const line of String(stdinText || '').split(/\r?\n/)) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO_SHA.test(localSha)) continue;
    const known = remoteSha && !ZERO_SHA.test(remoteSha) && hasCommit(remoteSha);
    sets.push(known ? [`${remoteSha}..${localSha}`] : [localSha, '--not', '--remotes']);
  }
  return sets;
}

export function scanTracked(cwd, ctx, { root = repoRootOf(cwd) } = {}) {
  const findings = [];
  const listing = gitText(['ls-files', '-z'], { cwd: root });
  for (const path of listing.split('\0').filter(Boolean)) {
    const pathFinding = scanPath(path, ctx);
    if (pathFinding) findings.push(pathFinding);
    const file = join(root, path);
    let buffer;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;
    findings.push(...scanLines(path, splitLines(buffer.toString('utf8')), ctx));
  }
  return findings;
}

export function scanFiles(paths, ctx) {
  const findings = [];
  for (const path of paths) {
    const pathFinding = scanPath(path, ctx);
    if (pathFinding) findings.push(pathFinding);
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;
    findings.push(...scanLines(path.replace(/\\/g, '/'), splitLines(buffer.toString('utf8')), ctx));
  }
  return findings;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function buildContext(cwd, { env = process.env, useEnv = true, useRetired = true } = {}) {
  const root = repoRootOf(cwd);
  return {
    root,
    allowlist: loadAllowlist(root),
    allowedByCommit: [],
    knownValues: useEnv ? loadKnownValues(defaultEnvFiles(cwd, env)) : [],
    retired: useRetired ? loadRetired(defaultRetiredFile(env)) : null,
  };
}

function summarize(findings) {
  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
  return byRule;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, stdinText } = {}) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const rangeIndex = argv.indexOf('--range');
  const messageIndex = argv.indexOf('--commit-msg');
  const files = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--range' && argv[i - 1] !== '--commit-msg');
  const ctx = buildContext(cwd, { env, useEnv: !flags.has('--no-env'), useRetired: !flags.has('--no-retired') });

  let mode = 'files';
  let findings = [];
  if (flags.has('--staged')) {
    mode = 'staged';
    findings = scanStaged(cwd, ctx);
  } else if (messageIndex >= 0) {
    mode = 'commit-msg';
    const file = argv[messageIndex + 1];
    findings = scanCommitMessageFile(isAbsolute(file) ? file : resolve(cwd, file), ctx);
  } else if (flags.has('--pre-push')) {
    mode = 'pre-push';
    const sets = prePushRevArgs(stdinText ?? readStdin(), { hasCommit: (sha) => commitExists(cwd, sha) });
    for (const revArgs of sets) findings.push(...scanRevisions(cwd, revArgs, ctx));
  } else if (rangeIndex >= 0) {
    mode = 'range';
    findings = scanRevisions(cwd, [argv[rangeIndex + 1]], ctx);
  } else if (flags.has('--history')) {
    mode = 'history';
    findings = scanRevisions(cwd, ['--all'], ctx);
  } else if (flags.has('--tracked')) {
    mode = 'tracked';
    findings = scanTracked(cwd, ctx, { root: ctx.root });
  } else if (flags.has('--stdin')) {
    mode = 'stdin';
    findings = scanLines('<stdin>', splitLines(stdinText ?? readStdin()), ctx);
  } else if (files.length) {
    findings = scanFiles(files, ctx);
  } else {
    console.error('usage: secret-scan.mjs --staged | --commit-msg <file> | --pre-push | --range A..B | --tracked | --history | --stdin | <files…>');
    return 2;
  }
  if (flags.has('--secrets-only')) findings = findings.filter((f) => f.kind === 'secret');

  const counts = {
    secret: findings.filter((f) => f.kind === 'secret').length,
    pii: findings.filter((f) => f.kind === 'pii').length,
    path: findings.filter((f) => f.kind === 'path').length,
  };
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ mode, counts, byRule: summarize(findings), findings, allowedByCommit: ctx.allowedByCommit }, null, 2)}\n`);
    return findings.length ? 1 : 0;
  }
  if (!flags.has('--summary')) for (const finding of findings) console.log(formatFinding(finding));
  const sources = `${ctx.knownValues.length} env values, ${ctx.retired ? 'retired hashes loaded' : 'no retired hashes'}`;
  if (ctx.allowedByCommit.length) {
    console.log(`secret-scan: let through by commit-pinned allowlist entries: ${ctx.allowedByCommit.join(', ')}`);
  }
  if (!findings.length) {
    console.log(`secret-scan (${mode}): clean (${sources}).`);
    return 0;
  }
  if (flags.has('--summary')) {
    for (const [rule, count] of Object.entries(summarize(findings)).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${rule}`);
  }
  console.log(
    `secret-scan (${mode}): ${findings.length} finding(s): ${counts.secret} secret, ${counts.pii} client data, ${counts.path} path (${sources}).`
  );
  if (['staged', 'commit-msg', 'pre-push'].includes(mode)) {
    console.log('This repo is public. Remove the value or file. A fake test value can be allowlisted in .secret-scan-allowlist.json with a reason.');
  }
  return 1;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`secret-scan: ${error?.message || error}`);
      process.exit(2);
    }
  );
}

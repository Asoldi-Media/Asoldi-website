#!/usr/bin/env node
/**
 * Secret, client-data and planning-vocabulary scan. The same script runs in every Asoldi repo;
 * scripts/security/scan-profile.json says which rule groups the repo enforces (secret-scan-lib:
 * PROFILES): `public` (secrets, client data, planning words, every blocked path) or `private`
 * (secrets and secret paths only).
 *
 *   node scripts/security/secret-scan.mjs --staged          pre-commit: lines and paths being committed
 *   node scripts/security/secret-scan.mjs --commit-msg F    commit-msg: the message being committed
 *   node scripts/security/secret-scan.mjs --pre-push        pre-push: every commit being pushed (refs on stdin),
 *                                                            its merge-resolution lines, --commits over the
 *                                                            pushed range and the message of a pushed annotated tag
 *   node scripts/security/secret-scan.mjs --commits A..B    the messages of every commit in a range, merges included
 *   node scripts/security/secret-scan.mjs --range A..B      every commit in a range: lines and messages
 *   node scripts/security/secret-scan.mjs --tracked         audit: every tracked file as it is now
 *   node scripts/security/secret-scan.mjs --tracked --ratchet [--shrink]
 *                                                            the tracked files against the offender lists
 *   node scripts/security/secret-scan.mjs --history         audit: every commit on every branch
 *   node scripts/security/secret-scan.mjs --workspace DIR   every file under DIR, without git
 *   node scripts/security/secret-scan.mjs --redact DIR [--apply] [--backup-dir DIR]
 *                                                            secrets under DIR replaced by <redacted:KEY>
 *   node scripts/security/secret-scan.mjs --stdin           text piped in
 *   node scripts/security/secret-scan.mjs <files…>          those files
 *
 * Options: --json, --summary, --secrets-only, --no-env, --no-retired, --profile public|private,
 * --names FILE (names to refuse, one per line, from a file outside the repo).
 *
 * What counts as a finding (lib: secret-scan-lib.mjs):
 *   - credential patterns (private keys, sk-/AIza/ghp_/xkeysib-/sk_live_/whsec_/JWT service_role …);
 *   - any 12+ character secret-like value from the local .env files (this checkout's main .env,
 *     the sibling asoldi-website, website-maker and website-cms .env files and
 *     ~/.asoldi-website-data/production.env, or SECRET_SCAN_ENV_FILES), compared in memory;
 *   - retired (rotated) secrets: salted hashes in ~/.asoldi-secrets/retired.json
 *     (or ASOLDI_RETIRED_SECRETS), never stored in a repo;
 *   - public profile: client personal data (e-mail addresses outside allowed domains, phone
 *     numbers, fødselsnummer, card numbers, names from --names or ~/.asoldi-secrets/scan-names.txt
 *     or SECRET_SCAN_NAMES), planning words (task and area ids, planning branch and batch
 *     names, planning file names) and paths that hold client data;
 *   - every profile: paths that hold secrets (.env, keys, service accounts, secrets/, redaction backups).
 * Every rule is checked per pushed commit, because each commit is published. With
 * SECRET_SCAN_PLAN_NET_DIFF=1 (or --plan-net-diff) planning words in file lines are checked on the
 * pushed result instead (the diff from the remote to the pushed tip): set it only when the
 * planning words of earlier commits in the push may be published; the scan lists every one it lets
 * through. In a repo whose committed profile is public, --staged uses the public rules and refuses
 * a staged scan-profile.json that names a weaker profile.
 * Fake test fixtures are allowed through .secret-scan-allowlist.json (path + rule + reason, or
 * the sha256 of one fixture value); an allowlisted secret hit must still look fake, so a real
 * key pasted there is caught. commitEntries (commit + path + line + rule + reason) let one
 * finding through in one past commit, for history that is not rewritten; they never cover .env
 * values or retired secrets, and the scan output lists every finding they let through.
 *
 * --redact is a dry run unless --apply is given: it lists what it would replace. --apply keeps
 * each changed file's original once (never overwritten) as <backup dir>/<folder>-<hash>/<path>.bak-redact,
 * outside the folder: --backup-dir, ASOLDI_REDACT_BACKUPS or ~/.asoldi-secrets/redact-backups.
 * Delete those copies after checking the result. Only secrets are replaced. A folder that holds
 * one of the env files the known values come from, or the backup dir, is refused.
 *
 * Output never contains a matched value. Exit 0 clean, 1 findings, 2 error.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNamesMatcher,
  buildRetiredMatcher,
  commitEntryFor,
  countFindingsByPath,
  formatFinding,
  isProbablyBinary,
  knownValuesFromEnv,
  normalizeAllowlist,
  parseEnvText,
  PROFILES,
  ratchetProblems,
  redactText,
  resolveProfile,
  scanLines,
  scanPath,
  shrinkRatchet,
  splitLines,
} from './secret-scan-lib.mjs';

export const ALLOWLIST_FILE = '.secret-scan-allowlist.json';
export const PROFILE_FILE = 'scripts/security/scan-profile.json';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Untracked copies (logs, exported chats) can be large; --workspace and --redact read up to this.
const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;
const ZERO_SHA = /^0+$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

/** The git top level, or `cwd` itself outside a git checkout (an exported tree). */
export function rootOrDir(cwd) {
  try {
    return repoRootOf(cwd);
  } catch {
    return resolve(cwd);
  }
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
  const root = rootOrDir(cwd);
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

export function defaultNamesFile(env = process.env) {
  return env.SECRET_SCAN_NAMES || join(homedir(), '.asoldi-secrets', 'scan-names.txt');
}

/** True when `file` is tracked in the git checkout at `root`. */
export function isTrackedIn(root, file) {
  const rel = relative(root, resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  try {
    git(['ls-files', '--error-unmatch', '--', rel.replace(/\\/g, '/')], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/**
 * The names matcher from `file`. The names are client data themselves, so the file must stay
 * out of the repo: a tracked names file is an error. `required`: a missing file is an error too.
 */
export function loadNames(file, root, { required = false } = {}) {
  if (!file) return null;
  if (!existsSync(file)) {
    if (required) throw new Error('the --names file does not exist');
    return null;
  }
  if (isTrackedIn(root, file)) throw new Error('the names file is tracked in this repo; keep it outside the repo');
  return buildNamesMatcher(readFileSync(file, 'utf8'));
}

export function loadAllowlist(root) {
  const file = join(root, ALLOWLIST_FILE);
  if (!existsSync(file)) return normalizeAllowlist({});
  return normalizeAllowlist(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * scripts/security/scan-profile.json: { profile, ratchets: { plan, pii }, codemodSkip, scrubExclude }.
 * Without the file a repo gets the public profile and no ratchet lists.
 */
export function loadProfileConfig(root) {
  const file = join(root, PROFILE_FILE);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    profile: resolveProfile(raw.profile || 'public'),
    ratchets: raw.ratchets && typeof raw.ratchets === 'object' ? raw.ratchets : {},
    codemodSkip: Array.isArray(raw.codemodSkip) ? raw.codemodSkip.map(String) : [],
    scrubExclude: Array.isArray(raw.scrubExclude) ? raw.scrubExclude.map(String) : [],
  };
}

/** The profile name in a scan-profile.json text ('public' when the file or the field is missing). */
function profileNameOf(text) {
  if (text === null) return 'public';
  try {
    return String(JSON.parse(text).profile || 'public').trim().toLowerCase();
  } catch {
    return 'invalid';
  }
}

function gitShow(cwd, spec) {
  try {
    return gitText(['show', spec], { cwd });
  } catch {
    return null;
  }
}

/**
 * The committed (HEAD) and staged profile names (committed: null before the first commit). A repo
 * whose committed profile is public keeps the public rules for --staged, whatever the working tree
 * or the index says.
 */
export function stagedProfiles(cwd) {
  let committed = null;
  try {
    git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd });
    committed = profileNameOf(gitShow(cwd, `HEAD:${PROFILE_FILE}`));
  } catch {
    committed = null;
  }
  return { committed, staged: profileNameOf(gitShow(cwd, `:${PROFILE_FILE}`)) };
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

function scanPatchFiles(files, ctx, { label: labelFor = null } = {}) {
  const findings = [];
  for (const file of files) {
    if (file.message) {
      // Commit messages are public too; path rules do not apply to them.
      const label = `${file.commit.slice(0, 10)}:commit-message`;
      for (const finding of scanLines('', messageLinesForScan(file.lines), ctx)) findings.push({ ...finding, path: label });
      continue;
    }
    const label = labelFor ? labelFor(file) : (file.commit ? `${file.commit.slice(0, 10)}:${file.path}` : file.path);
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
const LOG_ARGS_NO_MESSAGES = ['-p', '--cc', '--no-show-signature', ...DIFF_ARGS, `--format=%x01commit %H%n${MESSAGE_END}`];
// Messages only (no -p): every commit the range selects, merge commits included.
const MESSAGE_ARGS = ['--no-show-signature', `--format=%x01commit %H%n%B%n${MESSAGE_END}`];

/** The same context with other rule groups (pre-push checks planning words on the pushed result only). */
function withRules(ctx, rules) {
  return { ...ctx, profile: { ...ctx.profile, ...rules } };
}

export function scanStaged(cwd, ctx) {
  const patch = gitText(['diff', '--cached', ...DIFF_ARGS, '--diff-filter=ACMR'], { cwd });
  const { committed, staged } = stagedProfiles(cwd);
  if (committed !== 'public') return scanPatchFiles(parsePatch(patch), ctx);
  const findings = scanPatchFiles(parsePatch(patch), { ...ctx, profile: PROFILES.public });
  if (staged !== 'public') {
    findings.push({ path: PROFILE_FILE, line: 0, rule: 'path:profile-weakened', kind: 'path', hint: 'the committed profile is public' });
  }
  return findings;
}

export function scanRevisions(cwd, revArgs, ctx, { messages = true } = {}) {
  const patch = gitText(['log', ...(messages ? LOG_ARGS : LOG_ARGS_NO_MESSAGES), ...revArgs], { cwd });
  return scanPatchFiles(parsePatch(patch), ctx);
}

/** --commits: the message of every commit the revision arguments select, merge commits included. */
export function scanCommitMessages(cwd, revArgs, ctx) {
  const text = gitText(['log', ...MESSAGE_ARGS, ...revArgs], { cwd });
  return scanPatchFiles(parsePatch(text), ctx);
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
 * pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per line → one entry per
 * pushed ref: { localRef, localSha, remoteSha } (remoteSha '' when the remote sha is unknown here).
 */
export function prePushRefs(stdinText, { hasCommit = () => true } = {}) {
  const refs = [];
  for (const line of String(stdinText || '').split(/\r?\n/)) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO_SHA.test(localSha)) continue;
    const known = remoteSha && !ZERO_SHA.test(remoteSha) && hasCommit(remoteSha);
    refs.push({ localRef, localSha, remoteSha: known ? remoteSha : '' });
  }
  return refs;
}

/**
 * pre-push stdin → git revision arguments per pushed ref. When the remote sha is unknown here
 * (someone else pushed it), scan everything not on any remote-tracking ref.
 */
export function prePushRevArgs(stdinText, { hasCommit = () => true } = {}) {
  return prePushRefs(stdinText, { hasCommit }).map(({ localSha, remoteSha }) => (
    remoteSha ? [`${remoteSha}..${localSha}`] : [localSha, '--not', '--remotes']
  ));
}

/**
 * The commit the pushed result is compared with: the remote sha; the pushed commit itself when
 * every pushed commit is already on a remote-tracking ref (a tag or a new branch at a pushed
 * commit: nothing new); for a new branch the one commit where the pushed commits meet the
 * remote-tracking refs; the empty tree when this clone has no remote-tracking ref or the pushed
 * history meets none. null when the pushed commits meet them in more than one place.
 */
export function pushBase(cwd, { localSha, remoteSha }) {
  if (remoteSha) return remoteSha;
  if (!gitText(['for-each-ref', '--format=%(objectname)', 'refs/remotes'], { cwd }).trim()) return EMPTY_TREE;
  if (!gitText(['rev-list', localSha, '--not', '--remotes'], { cwd }).trim()) return localSha;
  const boundary = gitText(['rev-list', '--boundary', localSha, '--not', '--remotes'], { cwd })
    .split(/\r?\n/)
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1).trim());
  if (!boundary.length) return EMPTY_TREE;
  return boundary.length === 1 ? boundary[0] : null;
}

/** The message lines of an annotated tag object ([] for a commit or a lightweight tag). */
export function tagMessageLines(cwd, sha) {
  try {
    if (gitText(['cat-file', '-t', sha], { cwd }).trim() !== 'tag') return [];
    const body = gitText(['cat-file', 'tag', sha], { cwd });
    const at = body.indexOf('\n\n');
    const message = at === -1 ? '' : body.slice(at + 2);
    // A signed tag ends with its signature block, which is not part of the message.
    return splitLines(message.split(/\n-----BEGIN (?:PGP|SSH) SIGNATURE-----/)[0].replace(/\n$/, ''));
  } catch {
    return [];
  }
}

/**
 * pre-push: every pushed commit's lines (secrets, client data, planning words, paths), the
 * messages of every pushed commit (--commits) and of every pushed annotated tag. With
 * `planNetDiff`, planning words in file lines count on the pushed result only (the diff from the
 * push base to the tip), and every per-commit planning finding that lets through is listed in
 * ctx.letThrough. When the pushed commits have no single base, planning words stay per commit.
 */
export function scanPrePush(cwd, stdinText, ctx, { planNetDiff = false } = {}) {
  const findings = [];
  for (const ref of prePushRefs(stdinText, { hasCommit: (sha) => commitExists(cwd, sha) })) {
    const revArgs = ref.remoteSha ? [`${ref.remoteSha}..${ref.localSha}`] : [ref.localSha, '--not', '--remotes'];
    const base = planNetDiff && ctx.profile.plan ? pushBase(cwd, ref) : null;
    if (base === null) {
      findings.push(...scanRevisions(cwd, revArgs, ctx, { messages: false }));
    } else {
      findings.push(...scanRevisions(cwd, revArgs, withRules(ctx, { plan: false }), { messages: false }));
      const planOnly = withRules(ctx, { secrets: false, pii: false, plan: true, paths: 'none' });
      const patch = gitText(['diff', ...DIFF_ARGS, base, ref.localSha], { cwd });
      const tip = ref.localSha.slice(0, 10);
      findings.push(...scanPatchFiles(parsePatch(patch), planOnly, { label: (file) => `${tip}:${file.path}` }));
      if (Array.isArray(ctx.letThrough)) {
        for (const finding of scanRevisions(cwd, revArgs, planOnly, { messages: false })) ctx.letThrough.push(`${finding.path}:${finding.line} ${finding.rule}`);
      }
    }
    findings.push(...scanCommitMessages(cwd, revArgs, ctx));
    if (ref.localRef.startsWith('refs/tags/')) {
      const label = `${ref.localSha.slice(0, 10)}:tag-message`;
      for (const finding of scanLines('', messageLinesForScan(tagMessageLines(cwd, ref.localSha)), ctx)) findings.push({ ...finding, path: label });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- files without git

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Every regular file under `dir` as a relative '/' path, sorted. Skips .git and node_modules,
 * and never follows a symbolic link or a junction.
 */
export function walkFiles(dir, { skipDirs = WALK_SKIP_DIRS } = {}) {
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit(resolve(dir), '');
  return out.sort();
}

/** The repo's files: `git ls-files`, or every file under `root` when it is not a git checkout. */
export function listRepoFiles(root) {
  try {
    return gitText(['ls-files', '-z'], { cwd: root }).split('\0').filter(Boolean);
  } catch {
    return walkFiles(root);
  }
}

function readText(file, maxBytes) {
  try {
    if (statSync(file).size > maxBytes) return null;
    const buffer = readFileSync(file);
    return isProbablyBinary(buffer) ? null : buffer.toString('utf8');
  } catch {
    return null;
  }
}

function scanFileList(root, paths, ctx, { maxBytes = MAX_FILE_BYTES } = {}) {
  const findings = [];
  for (const path of paths) {
    const pathFinding = scanPath(path, ctx);
    if (pathFinding) findings.push(pathFinding);
    const text = readText(join(root, path), maxBytes);
    if (text === null) continue;
    findings.push(...scanLines(path, splitLines(text), ctx));
  }
  return findings;
}

export function scanTracked(cwd, ctx, { root = rootOrDir(cwd) } = {}) {
  return scanFileList(root, listRepoFiles(root), ctx);
}

/** --workspace: every file under `dir` (no git needed); paths in the output are relative to it. */
export function scanWorkspace(dir, ctx) {
  return scanFileList(resolve(dir), walkFiles(dir), ctx, { maxBytes: MAX_WORKSPACE_FILE_BYTES });
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

export function defaultBackupRoot(env = process.env) {
  return env.ASOLDI_REDACT_BACKUPS || join(homedir(), '.asoldi-secrets', 'redact-backups');
}

function realOrResolved(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** True when `path` is `dir` or inside it (both resolved through links; case-insensitive on Windows). */
export function isInside(dir, path) {
  const norm = (value) => {
    const out = realOrResolved(value).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };
  const base = norm(dir);
  const target = norm(path);
  return target === base || target.startsWith(`${base}/`);
}

/**
 * The folder the originals of one --redact target go to: <backup root>/<folder name>-<hash of its
 * path>, so two targets never share one and a later run finds the first originals again.
 */
export function backupDirFor(root, backupRoot) {
  const id = createHash('sha256').update(realOrResolved(root).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 10);
  return join(backupRoot, `${basename(resolve(root)) || 'folder'}-${id}`);
}

/**
 * --redact: the secrets in every text file under `dir`, replaced by <redacted:KEY>. A dry run
 * unless `apply`; with `apply` each changed file's original is kept once (never overwritten) as
 * <backupDirFor(dir)>/<path>.bak-redact, outside `dir`, so a later `git add` in `dir` cannot pick
 * it up. A folder that holds one of `envSources` (the env files the known values come from) or
 * the backup root is refused: those files must keep their values. Returns { files: [{ path,
 * redactions, backup }], backupDir } with no values.
 */
export function redactWorkspace(dir, ctx, { apply = false, backupRoot = defaultBackupRoot(), envSources = ctx.envSources || [] } = {}) {
  const root = resolve(dir);
  const held = envSources.filter((file) => existsSync(file) && isInside(root, file));
  if (held.length) throw new Error(`the folder holds ${held.length} env file(s) the known values come from; redact a folder without them`);
  if (isInside(root, backupRoot)) throw new Error('the backup folder is inside the folder being redacted; pick another --backup-dir');
  const backupDir = backupDirFor(root, backupRoot);
  const files = [];
  for (const path of walkFiles(root)) {
    if (/\.bak-redact$/i.test(path)) continue;
    const abs = join(root, path);
    const text = readText(abs, MAX_WORKSPACE_FILE_BYTES);
    if (text === null) continue;
    const result = redactText(path, text, ctx);
    if (!result.redactions.length) continue;
    const row = { path, redactions: result.redactions, backup: '' };
    if (apply) {
      const backup = join(backupDir, `${path}.bak-redact`);
      if (!existsSync(backup)) {
        mkdirSync(dirname(backup), { recursive: true });
        writeFileSync(backup, readFileSync(abs));
      }
      writeFileSync(abs, result.text);
      row.backup = backup;
    }
    files.push(row);
  }
  return { files, backupDir };
}

// ---------------------------------------------------------------- ratchets

const RATCHET_KINDS = { plan: ['plan'], pii: ['pii'] };

/**
 * The tracked files against the repo's offender lists (scan-profile.json `ratchets`): any secret
 * or blocked path fails, and each list fails on a new file or a higher count.
 */
export function ratchetReport(root, { allowlist = loadAllowlist(root), config = loadProfileConfig(root) } = {}) {
  const ctx = { root, allowlist, knownValues: [], retired: null, profile: config.profile, names: null };
  const findings = scanTracked(root, ctx, { root });
  const lists = {};
  for (const [kind, file] of Object.entries(config.ratchets)) {
    if (!RATCHET_KINDS[kind]) continue;
    const abs = join(root, file);
    const list = existsSync(abs) ? JSON.parse(readFileSync(abs, 'utf8')) : { files: {} };
    const counts = countFindingsByPath(findings, RATCHET_KINDS[kind]);
    lists[kind] = { file, list, counts, ...ratchetProblems(list, counts) };
  }
  const ratcheted = new Set(Object.keys(lists).flatMap((kind) => RATCHET_KINDS[kind]));
  const hard = findings.filter((finding) => !ratcheted.has(finding.kind));
  return { findings, hard, lists, ok: !hard.length && Object.values(lists).every((row) => row.ok) };
}

/** Lowers every offender list to the current counts (never adds a file or raises a count). */
export function shrinkRatchets(root, report = ratchetReport(root)) {
  const written = [];
  for (const row of Object.values(report.lists)) {
    const next = shrinkRatchet(row.list, row.counts);
    if (JSON.stringify(next.files) === JSON.stringify(row.list.files || {})) continue;
    writeFileSync(join(root, row.file), `${JSON.stringify(next, null, 2)}\n`);
    written.push(row.file);
  }
  return written;
}

// ---------------------------------------------------------------- main

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function buildContext(cwd, { env = process.env, useEnv = true, useRetired = true, profile = null, namesFile = null } = {}) {
  const root = rootOrDir(cwd);
  const config = loadProfileConfig(root);
  const names = namesFile
    ? loadNames(namesFile, root, { required: true })
    : loadNames(defaultNamesFile(env), root);
  const envSources = useEnv ? defaultEnvFiles(cwd, env).filter((file) => existsSync(file)) : [];
  return {
    root,
    config,
    profile: profile ? resolveProfile(profile) : config.profile,
    allowlist: loadAllowlist(root),
    allowedByCommit: [],
    letThrough: [],
    envSources,
    knownValues: useEnv ? loadKnownValues(envSources) : [],
    retired: useRetired ? loadRetired(defaultRetiredFile(env)) : null,
    names,
  };
}

function summarize(findings) {
  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
  return byRule;
}

const VALUE_FLAGS = new Set(['--range', '--commit-msg', '--commits', '--workspace', '--redact', '--names', '--profile', '--backup-dir']);

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function printRatchet(report) {
  for (const finding of report.hard) console.log(formatFinding(finding));
  for (const [kind, row] of Object.entries(report.lists)) {
    for (const item of row.unlisted) console.log(`${item.path}  ${kind}: ${item.count} finding(s), not in ${row.file}`);
    for (const item of row.grown) console.log(`${item.path}  ${kind}: ${item.count} finding(s), ${row.file} allows ${item.allowed}`);
    const total = Object.values(row.counts).reduce((sum, n) => sum + n, 0);
    console.log(`ratchet ${kind}: ${total} finding(s) in ${Object.keys(row.counts).length} file(s); ${row.unlisted.length} new file(s), ${row.grown.length} grown, ${row.shrunk.length} lower than listed.`);
  }
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, stdinText } = {}) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const files = argv.filter((arg, i) => !arg.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
  const ctx = buildContext(cwd, {
    env,
    useEnv: !flags.has('--no-env'),
    useRetired: !flags.has('--no-retired'),
    profile: flagValue(argv, '--profile'),
    namesFile: flagValue(argv, '--names') ? resolve(cwd, flagValue(argv, '--names')) : null,
  });
  const sources = `${ctx.knownValues.length} env values, ${ctx.retired ? 'retired hashes loaded' : 'no retired hashes'}, profile ${ctx.profile.name || 'custom'}`;

  if (flagValue(argv, '--redact') !== undefined) {
    const dir = resolve(cwd, flagValue(argv, '--redact'));
    const apply = flags.has('--apply');
    const backupRoot = flagValue(argv, '--backup-dir') ? resolve(cwd, flagValue(argv, '--backup-dir')) : defaultBackupRoot(env);
    const result = redactWorkspace(dir, ctx, { apply, backupRoot });
    const count = result.files.reduce((sum, row) => sum + row.redactions.length, 0);
    if (flags.has('--json')) {
      process.stdout.write(`${JSON.stringify({ mode: 'redact', apply, count, backupDir: result.backupDir, files: result.files }, null, 2)}\n`);
    } else {
      for (const row of result.files) {
        for (const item of row.redactions) console.log(formatFinding({ path: row.path, ...item }));
      }
    }
    if (!count) {
      console.log(`secret-scan (redact): nothing to redact (${sources}).`);
      return 0;
    }
    if (apply) {
      console.log(`secret-scan (redact): replaced ${count} value(s) in ${result.files.length} file(s). Each original is kept once under ${result.backupDir} as <path>.bak-redact; delete those copies after checking.`);
      return 0;
    }
    console.log(`secret-scan (redact): would replace ${count} value(s) in ${result.files.length} file(s) (dry run; add --apply to write) (${sources}).`);
    return 1;
  }

  if (flags.has('--ratchet')) {
    const report = ratchetReport(ctx.root, { allowlist: ctx.allowlist, config: ctx.config });
    printRatchet(report);
    if (flags.has('--shrink')) {
      const written = shrinkRatchets(ctx.root, report);
      console.log(written.length ? `ratchet: lowered ${written.join(', ')}` : 'ratchet: nothing to lower');
    }
    return report.ok ? 0 : 1;
  }

  let mode = 'files';
  let findings = [];
  if (flags.has('--staged')) {
    mode = 'staged';
    findings = scanStaged(cwd, ctx);
  } else if (flagValue(argv, '--commit-msg') !== undefined) {
    mode = 'commit-msg';
    const file = flagValue(argv, '--commit-msg');
    findings = scanCommitMessageFile(isAbsolute(file) ? file : resolve(cwd, file), ctx);
  } else if (flags.has('--pre-push')) {
    mode = 'pre-push';
    const planNetDiff = flags.has('--plan-net-diff') || env.SECRET_SCAN_PLAN_NET_DIFF === '1';
    findings = scanPrePush(cwd, stdinText ?? readStdin(), ctx, { planNetDiff });
  } else if (flagValue(argv, '--commits') !== undefined) {
    mode = 'commits';
    findings = scanCommitMessages(cwd, [flagValue(argv, '--commits')], ctx);
  } else if (flagValue(argv, '--range') !== undefined) {
    mode = 'range';
    findings = scanRevisions(cwd, [flagValue(argv, '--range')], ctx);
  } else if (flags.has('--history')) {
    mode = 'history';
    findings = scanRevisions(cwd, ['--all'], ctx);
  } else if (flags.has('--tracked')) {
    mode = 'tracked';
    findings = scanTracked(cwd, ctx, { root: ctx.root });
  } else if (flagValue(argv, '--workspace') !== undefined) {
    mode = 'workspace';
    findings = scanWorkspace(resolve(cwd, flagValue(argv, '--workspace')), ctx);
  } else if (flags.has('--stdin')) {
    mode = 'stdin';
    findings = scanLines('<stdin>', splitLines(stdinText ?? readStdin()), ctx);
  } else if (files.length) {
    findings = scanFiles(files, ctx);
  } else {
    console.error('usage: secret-scan.mjs --staged | --commit-msg <file> | --pre-push [--plan-net-diff] | --commits A..B | --range A..B | --tracked [--ratchet [--shrink]] | --history | --workspace <dir> | --redact <dir> [--apply] [--backup-dir <dir>] | --stdin | <files…>');
    return 2;
  }
  if (flags.has('--secrets-only')) findings = findings.filter((f) => f.kind === 'secret');

  const counts = {
    secret: findings.filter((f) => f.kind === 'secret').length,
    pii: findings.filter((f) => f.kind === 'pii').length,
    plan: findings.filter((f) => f.kind === 'plan').length,
    path: findings.filter((f) => f.kind === 'path').length,
  };
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ mode, counts, byRule: summarize(findings), findings, allowedByCommit: ctx.allowedByCommit, letThrough: ctx.letThrough }, null, 2)}\n`);
    return findings.length ? 1 : 0;
  }
  if (!flags.has('--summary')) for (const finding of findings) console.log(formatFinding(finding));
  if (ctx.allowedByCommit.length) {
    console.log(`secret-scan: let through by commit-pinned allowlist entries: ${ctx.allowedByCommit.join(', ')}`);
  }
  if (ctx.letThrough.length) {
    console.log(`secret-scan: planning words in pushed commits that the pushed result no longer has, let through by SECRET_SCAN_PLAN_NET_DIFF (they will be public in history): ${ctx.letThrough.join(', ')}`);
  }
  if (!findings.length) {
    console.log(`secret-scan (${mode}): clean (${sources}).`);
    return 0;
  }
  if (flags.has('--summary')) {
    for (const [rule, count] of Object.entries(summarize(findings)).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${rule}`);
  }
  console.log(
    `secret-scan (${mode}): ${findings.length} finding(s): ${counts.secret} secret, ${counts.pii} client data, ${counts.plan} planning, ${counts.path} path (${sources}).`
  );
  if (['staged', 'commit-msg', 'pre-push', 'commits'].includes(mode)) {
    console.log(ctx.profile.pii
      ? 'This repo is public. Remove the value, file or planning word (describe the behaviour instead). A fake test value can be allowlisted in .secret-scan-allowlist.json with a reason.'
      : 'Remove the secret or file. A fake test value can be allowlisted in .secret-scan-allowlist.json with a reason.');
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

export { PROFILES };

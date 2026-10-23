/**
 * Which build is running, for /api/health and the post-deploy check (scripts/post-deploy-check.mjs).
 *
 * Sources, in order (never the env: a stale or hand-set variable must not claim a build):
 *   1. dist/build-info.json, written by the Vite build (vite.config.ts writeBuildInfo):
 *      { commit, builtAt }. Hostinger runs that build after every git deploy (postinstall).
 *   2. The git checkout the server runs from, read as files (.git/HEAD, the ref file or
 *      packed-refs; a worktree's ".git" file is followed). No git binary is needed.
 *   3. Nothing: { commit: null, builtAt: null, source: 'none' }.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

export const BUILD_INFO_FILE = 'build-info.json';
const SHA_RE = /^[0-9a-f]{40}$/;

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function cleanSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

function cleanIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The git dir of a checkout: <root>/.git, or the folder a worktree's ".git" file points to. */
export function gitDirOf(root) {
  const dotGit = join(root, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return '';
  }
  if (stat.isDirectory()) return dotGit;
  const match = readText(dotGit).match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return '';
  return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
}

function commonDirOf(gitDir) {
  const pointer = readText(join(gitDir, 'commondir')).trim();
  if (!pointer) return gitDir;
  return isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
}

function resolveRef(gitDir, ref) {
  for (const dir of [...new Set([gitDir, commonDirOf(gitDir)])]) {
    const loose = cleanSha(readText(join(dir, ref)));
    if (loose) return loose;
    for (const line of readText(join(dir, 'packed-refs')).split(/\r?\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && cleanSha(sha)) return cleanSha(sha);
    }
  }
  return null;
}

/** The commit checked out at `root`, read from the git files, or null. */
export function gitCommitAt(root) {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const head = readText(join(gitDir, 'HEAD')).trim();
  if (!head) return null;
  const ref = head.match(/^ref:\s*(.+)$/);
  return ref ? resolveRef(gitDir, ref[1].trim()) : cleanSha(head);
}

/** { commit, builtAt, id, source } for the build in `distDir`, served from `repoRoot`. */
export function readBuildInfo({ distDir, repoRoot } = {}) {
  if (distDir) {
    const file = join(distDir, BUILD_INFO_FILE);
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readText(file));
        const commit = cleanSha(raw?.commit);
        const builtAt = cleanIso(raw?.builtAt);
        if (commit || builtAt) {
          return { commit, builtAt, id: commit ? commit.slice(0, 12) : `built-${builtAt}`, source: 'build-file' };
        }
      } catch {
        /* a damaged file counts as missing */
      }
    }
  }
  const commit = repoRoot ? gitCommitAt(repoRoot) : null;
  if (commit) return { commit, builtAt: null, id: commit.slice(0, 12), source: 'git' };
  return { commit: null, builtAt: null, id: null, source: 'none' };
}

/** What the Vite build writes into dist/build-info.json. `commit` comes from the checkout, never the env. */
export function buildInfoForBuild({ repoRoot, now = new Date() } = {}) {
  return { commit: repoRoot ? gitCommitAt(repoRoot) : null, builtAt: now.toISOString() };
}

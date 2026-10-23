// /api/health build info: dist/build-info.json from the Vite build, else the git checkout read as
// files, never the env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO_FILE, buildInfoForBuild, gitCommitAt, readBuildInfo } from '../lib/build-info.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-build-info-'));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = '0123456789abcdef0123456789abcdef01234567';
const SHA_C = 'c'.repeat(40);

test('dist/build-info.json wins; a damaged file counts as missing', () => {
  const root = tempDir();
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify({ commit: SHA_B.toUpperCase(), builtAt: '2026-10-23T10:00:00Z' }));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), `${SHA_C}\n`);
  assert.deepEqual(readBuildInfo({ distDir: dist, repoRoot: root }), {
    commit: SHA_B,
    builtAt: '2026-10-23T10:00:00.000Z',
    id: SHA_B.slice(0, 12),
    source: 'build-file',
  });
  writeFileSync(join(dist, BUILD_INFO_FILE), '{not json');
  assert.equal(readBuildInfo({ distDir: dist, repoRoot: root }).commit, SHA_C, 'falls back to git');
  writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify({ commit: null, builtAt: '2026-10-23T10:00:00Z' }));
  assert.deepEqual(readBuildInfo({ distDir: dist }), { commit: null, builtAt: '2026-10-23T10:00:00.000Z', id: 'built-2026-10-23T10:00:00.000Z', source: 'build-file' });
});

test('git files: branch ref, packed-refs, detached HEAD and a worktree .git file', () => {
  const root = tempDir();
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${SHA_A}\n`);
  assert.equal(gitCommitAt(root), SHA_A);
  rmSync(join(root, '.git', 'refs', 'heads', 'main'));
  writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/main\n`);
  assert.equal(gitCommitAt(root), SHA_B);
  writeFileSync(join(root, '.git', 'HEAD'), `${SHA_C}\n`);
  assert.equal(gitCommitAt(root), SHA_C);

  // A linked worktree: .git is a file pointing at <common>/worktrees/<name>, refs live in <common>.
  const wt = tempDir();
  const wtGit = join(root, '.git', 'worktrees', 'one');
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'refs', 'heads', 'feature'), `${SHA_A}\n`);
  assert.equal(gitCommitAt(wt), SHA_A);
  assert.deepEqual(readBuildInfo({ distDir: join(wt, 'dist'), repoRoot: wt }), { commit: SHA_A, builtAt: null, id: SHA_A.slice(0, 12), source: 'git' });

  const none = tempDir();
  assert.deepEqual(readBuildInfo({ distDir: join(none, 'dist'), repoRoot: none }), { commit: null, builtAt: null, id: null, source: 'none' });
  writeFileSync(join(none, '.git'), 'not a pointer\n');
  assert.equal(gitCommitAt(none), null);
});

test('this checkout: the commit read from the git files equals git rev-parse HEAD', () => {
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return; // no git binary or not a checkout (a git archive copy): nothing to compare
  }
  assert.equal(gitCommitAt(repoRoot), head);
  const info = buildInfoForBuild({ repoRoot, now: new Date('2026-10-23T10:00:00Z') });
  assert.deepEqual(info, { commit: head, builtAt: '2026-10-23T10:00:00.000Z' });
});

test('the env never claims a build', () => {
  const root = tempDir();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_COMMIT: SHA_A, SOURCE_VERSION: SHA_A, BUILD_COMMIT: SHA_A, COMMIT_SHA: SHA_A, VERCEL_GIT_COMMIT_SHA: SHA_A });
    assert.deepEqual(readBuildInfo({ distDir: join(root, 'dist'), repoRoot: root }).source, 'none');
    assert.equal(buildInfoForBuild({ repoRoot: root }).commit, null);
  } finally {
    for (const key of ['GIT_COMMIT', 'SOURCE_VERSION', 'BUILD_COMMIT', 'COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('the Vite build writes dist/build-info.json, and /api/health reports it', () => {
  const vite = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
  assert.match(vite, /writeBuildInfo\(\)/);
  assert.match(vite, /buildInfoForBuild\(\{ repoRoot: __dirname \}\)/);
  const server = readFileSync(join(repoRoot, 'server.js'), 'utf8');
  assert.match(server, /readBuildInfo\(\{ distDir: distPath, repoRoot: __dirname \}\)/);
  assert.match(server, /build: BUILD_INFO/);
});

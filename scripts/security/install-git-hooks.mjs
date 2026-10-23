#!/usr/bin/env node
/**
 * Points this clone at the versioned hooks in .githooks (pre-commit: secret scan of the
 * staged lines; commit-msg: the same scan of the message; pre-push: secret scan of every commit
 * being pushed, its message and merge-resolution lines, then npm test).
 *
 *   npm run hooks:install          set core.hooksPath=.githooks for this clone
 *   node scripts/security/install-git-hooks.mjs --check
 *   node scripts/security/install-git-hooks.mjs --uninstall
 *
 * core.hooksPath is a per-clone setting (worktrees of the clone share it). It never runs
 * on Hostinger: nothing calls this from npm install.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function currentHooksPath(cwd) {
  try {
    return git(['config', '--get', 'core.hooksPath'], cwd);
  } catch {
    return '';
  }
}

export function installHooks(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  for (const hook of HOOKS) {
    const file = join(root, '.githooks', hook);
    if (!existsSync(file)) throw new Error(`.githooks/${hook} is missing`);
    try { chmodSync(file, 0o755); } catch { /* Windows: git runs hooks through sh anyway */ }
  }
  git(['config', 'core.hooksPath', '.githooks'], root);
  return { root, hooksPath: currentHooksPath(root) };
}

export function uninstallHooks(cwd = process.cwd()) {
  try {
    git(['config', '--unset', 'core.hooksPath'], cwd);
  } catch {
    // not set
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) {
      const path = currentHooksPath(process.cwd());
      console.log(path === '.githooks' ? 'hooks: installed (.githooks)' : `hooks: not installed (core.hooksPath=${path || 'unset'})`);
      process.exit(path === '.githooks' ? 0 : 1);
    }
    if (args.includes('--uninstall')) {
      uninstallHooks();
      console.log('hooks: core.hooksPath unset.');
      process.exit(0);
    }
    const { hooksPath } = installHooks();
    console.log(`hooks: core.hooksPath=${hooksPath}. pre-commit scans staged lines, commit-msg the message; pre-push scans pushed commits and runs npm test.`);
  } catch (error) {
    console.error(`hooks: ${error?.message || error}`);
    process.exit(1);
  }
}

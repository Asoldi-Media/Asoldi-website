/**
 * OneDrive Files On-Demand marks node_modules as dataless. Vite then dies with
 * "connection timed out" reading package.json, so localhost:3000 is
 * ERR_CONNECTION_REFUSED. Keep real modules on the Mac disk, not in CloudStorage.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LINK = join(ROOT, 'node_modules');
const SENTINEL = join(LINK, '@jridgewell', 'resolve-uri', 'package.json');

export function isCloudSyncedWorkspace(cwd = ROOT) {
  return /CloudStorage|OneDrive/i.test(String(cwd || ''));
}

export function localModulesDir(home = homedir()) {
  return join(home, 'Library', 'Caches', 'asoldi-website', 'node_modules');
}

export function isDatalessPath(file) {
  if (!file || !existsSync(file)) return false;
  try {
    const out = spawnSync('ls', ['-lO', file], { encoding: 'utf8' });
    return /\bdataless\b/.test(out.stdout || '');
  } catch {
    return false;
  }
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export function modulesNeedRelocate({
  cwd = ROOT,
  link = LINK,
  sentinel = SENTINEL,
  localDir = localModulesDir(),
} = {}) {
  if (!isCloudSyncedWorkspace(cwd)) return false;
  if (!existsSync(link)) return true;
  if (isDatalessPath(sentinel) || isDatalessPath(link)) return true;
  if (isSymlink(link)) {
    try {
      const target = readlinkSync(link);
      const abs = resolve(dirname(link), target);
      return abs !== resolve(localDir);
    } catch {
      return true;
    }
  }
  return true;
}

function npmInstall(cwd) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed (${result.status})`);
  }
}

function moveDir(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }
  const copied = spawnSync('ditto', [from, to], { stdio: 'inherit' });
  if (copied.status !== 0) throw new Error(`ditto failed (${copied.status})`);
  rmSync(from, { recursive: true, force: true });
}

function pointRepoAtLocal(link, localDir) {
  if (isSymlink(link)) unlinkSync(link);
  else if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(localDir, link);
}

export function ensureOfflineNodeModules({
  cwd = ROOT,
  link = LINK,
  localDir = localModulesDir(),
  sentinel = SENTINEL,
} = {}) {
  if (!isCloudSyncedWorkspace(cwd)) {
    return { relocated: false, reason: 'not-cloud' };
  }
  mkdirSync(dirname(localDir), { recursive: true });
  const linkIsReal = existsSync(link) && !isSymlink(link);
  const localHasVite = existsSync(join(localDir, '.bin', 'vite'));
  const linkHasVite = existsSync(join(link, '.bin', 'vite'));
  const already = isSymlink(link)
    && resolve(dirname(link), readlinkSync(link)) === resolve(localDir)
    && localHasVite
    && !isDatalessPath(sentinel);

  if (already) return { relocated: false, reason: 'already-local', localDir };

  if (linkIsReal && linkHasVite && !isDatalessPath(sentinel)) {
    console.log(`[dev] moving node_modules off OneDrive → ${localDir}`);
    moveDir(link, localDir);
    pointRepoAtLocal(link, localDir);
    return { relocated: true, localDir, action: 'moved' };
  }

  if (linkIsReal && isDatalessPath(sentinel)) {
    console.log('[dev] OneDrive node_modules is dataless — replacing with a local cache.');
    rmSync(link, { recursive: true, force: true });
  } else if (isSymlink(link)) {
    try { rmSync(link); } catch { /* replace below */ }
  }

  if (!existsSync(join(localDir, '.bin', 'vite'))) {
    if (!existsSync(link)) symlinkSync(localDir, link);
    console.log(`[dev] installing node_modules at ${localDir}`);
    npmInstall(cwd);
    if (existsSync(link) && !isSymlink(link)) moveDir(link, localDir);
  }

  pointRepoAtLocal(link, localDir);
  return { relocated: true, localDir, action: 'linked' };
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const result = ensureOfflineNodeModules();
  console.log('[dev] node_modules', result);
}

/**
 * Folders that hold secrets (<dataDir>/secrets): readable by the account that runs the hub only.
 *
 * POSIX: mode 0700 on the folder; the files inside are written with mode 0600.
 * Windows: file modes do nothing there, so the folder ACL is reset to the current user only
 * (inheritance removed, full control for this user, inherited by every file inside). The LAN
 * hub on PC2 and local dev run on Windows.
 *
 * Permissions are best effort: a failing icacls or chmod is logged and never thrown, because
 * the folder still lives in the hub's own data dir. Tests pass `exec`, `chmod` and `log` stubs.
 */
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync } from 'fs';
import { userInfo } from 'os';
import { resolve } from 'path';

const restricted = new Set();

/** DOMAIN\user of this process, as icacls expects it; '' when unknown. */
export function windowsAccountName(env = process.env) {
  let user = String(env.USERNAME || '').trim();
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = '';
    }
  }
  if (!user) return '';
  const domain = String(env.USERDOMAIN || '').trim();
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Restricts one path to this account: icacls on win32 (a folder gets an entry that its files and
 * sub-folders inherit), chmod 0700 (folder) or 0600 (file) elsewhere. Returns true when the call
 * went through. Never throws: a failure is logged through `log`.
 */
export function restrictPath(target, {
  platform = process.platform,
  directory = false,
  exec = execFileSync,
  chmod = chmodSync,
  log = console.warn,
} = {}) {
  try {
    if (platform === 'win32') {
      const account = windowsAccountName();
      if (!account) return false;
      exec('icacls', [target, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)F' : 'F'}`, '/Q'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 15_000,
      });
      return true;
    }
    chmod(target, directory ? 0o700 : 0o600);
    return true;
  } catch (error) {
    try {
      log(`[security] could not restrict ${platform === 'win32' ? 'the ACL of' : 'the mode of'} ${directory ? 'the secrets folder' : 'a secret file'}: ${error?.code || error?.message || error}`);
    } catch {
      /* logging is best effort too */
    }
    return false;
  }
}

/**
 * Creates the folder when missing and restricts it to this account (once per process and
 * folder). Never throws for the ACL step: the folder still lives in the hub's own data dir.
 */
export function ensurePrivateDir(dir, { platform = process.platform, exec, chmod, log } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = resolve(dir);
  if (restricted.has(key)) return dir;
  restricted.add(key);
  restrictPath(dir, { platform, directory: true, exec, chmod, log });
  return dir;
}

export function resetPrivateDirCacheForTests() {
  restricted.clear();
}

/**
 * Folders that hold secrets (<dataDir>/secrets): readable by the account that runs the hub only.
 *
 * POSIX: mode 0700 on the folder; the files inside are written with mode 0600.
 * Windows: file modes do nothing there, so the folder ACL is reset to the current user only
 * (inheritance removed, full control for this user, inherited by every file inside). The LAN
 * hub on PC2 and local dev run on Windows.
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

function restrictWindowsDir(dir) {
  const account = windowsAccountName();
  if (!account) return false;
  // (OI)(CI): files and folders created inside inherit the same single entry.
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/Q'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  });
  return true;
}

/**
 * Creates the folder when missing and restricts it to this account (once per process and
 * folder). Never throws for the ACL step: the folder still lives in the hub's own data dir.
 */
export function ensurePrivateDir(dir, { platform = process.platform } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = resolve(dir);
  if (restricted.has(key)) return dir;
  restricted.add(key);
  try {
    if (platform === 'win32') restrictWindowsDir(dir);
    else chmodSync(dir, 0o700);
  } catch (error) {
    console.warn(`[security] could not restrict ${platform === 'win32' ? 'the ACL of' : 'the mode of'} the secrets folder: ${error?.code || error?.message || error}`);
  }
  return dir;
}

export function resetPrivateDirCacheForTests() {
  restricted.clear();
}

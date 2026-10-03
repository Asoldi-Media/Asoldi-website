import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../data/storage-path.js';

function safeClientId(salesClientId = '') {
  const id = String(salesClientId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) throw new Error('Missing client id.');
  return id;
}

export function ensureDevHandoffDir() {
  const dir = join(getPersistentDataDir(), 'dev-handoffs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function devHandoffZipPath(salesClientId = '') {
  return join(ensureDevHandoffDir(), `${safeClientId(salesClientId)}.zip`);
}

export function deleteDevHandoff(salesClientId = '') {
  const file = devHandoffZipPath(salesClientId);
  rmSync(file, { force: true });
}

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { extname, join, normalize, sep } from 'path';
import { randomUUID } from 'crypto';
import { getPersistentDataDir } from '../data/storage-path.js';

const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.heic',
  '.mp4', '.mov', '.webm', '.m4v',
  '.pdf', '.xlsx', '.xls', '.csv', '.tsv', '.txt', '.md', '.docx', '.odt',
]);

function safeUserId(userId = '') {
  return String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function safeFileName(name = '') {
  const base = String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base || 'file';
}

export function clientUploadsRoot() {
  const dir = join(getPersistentDataDir(), 'client-uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function clientUploadDir(userId) {
  const id = safeUserId(userId);
  if (!id) throw new Error('Mangler bruker.');
  const dir = join(clientUploadsRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function clientMediaPublicPath(userId, fileName) {
  return `/client-media/${safeUserId(userId)}/${encodeURIComponent(fileName)}`;
}

export function resolveClientMediaPath(userId, fileName) {
  const id = safeUserId(userId);
  const name = String(fileName || '').split(/[/\\]/).pop();
  if (!id || !name) return null;
  const root = normalize(clientUploadDir(id));
  const full = normalize(join(root, name));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return existsSync(full) ? full : null;
}

export function isAllowedClientUploadName(fileName = '') {
  return ALLOWED_EXT.has(extname(String(fileName || '')).toLowerCase());
}

export async function saveClientUploadBuffer(userId, { buffer, originalName = 'file', prefix = '' } = {}) {
  if (!buffer || !buffer.length) throw new Error('Tom fil.');
  const ext = extname(originalName || '').toLowerCase() || '.bin';
  if (ext !== '.bin' && !ALLOWED_EXT.has(ext)) {
    throw Object.assign(new Error(`Filtypen ${ext} er ikke tillatt.`), { status: 400 });
  }
  const fileName = `${prefix ? `${prefix}-` : ''}${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(originalName)}`;
  const dest = join(clientUploadDir(userId), fileName);
  await writeFile(dest, buffer);
  return {
    fileName,
    url: clientMediaPublicPath(userId, fileName),
    bytes: buffer.length,
  };
}

export function createClientUploadWriteStream(userId, originalName) {
  const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(originalName)}`;
  const dest = join(clientUploadDir(userId), fileName);
  return {
    fileName,
    url: clientMediaPublicPath(userId, fileName),
    stream: createWriteStream(dest),
    path: dest,
  };
}

export function readClientMedia(userId, fileName) {
  const full = resolveClientMediaPath(userId, fileName);
  if (!full) return null;
  return {
    path: full,
    buffer: readFileSync(full),
    fileName: String(fileName || '').split(/[/\\]/).pop(),
  };
}

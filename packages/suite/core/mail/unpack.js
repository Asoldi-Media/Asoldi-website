/**
 * Unpacks container attachments (zip, Outlook winmail.dat) into the files they hold,
 * so every inner photo or document goes through the normal media/document pipeline.
 */

import { createRequire } from 'node:module';

const MAX_ENTRIES = 40;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const TNEF_SIGNATURE = 0x223e9f78;

const require = createRequire(import.meta.url);
let AdmZip;
/** adm-zip is optional and loaded on first use (sync, so callers stay sync). */
export function loadZip() {
  if (AdmZip === undefined) {
    try {
      AdmZip = require('adm-zip');
    } catch {
      AdmZip = null;
    }
  }
  return AdmZip;
}

function nameOf(file = {}) {
  return String(file.originalName || file.originalname || file.name || file.fileName || file.filename || '');
}

function mimeOf(file = {}) {
  return String(file.mimeType || file.mimetype || file.contentType || '').toLowerCase();
}

export function isZipFile(file = {}) {
  return /\.zip$/i.test(nameOf(file)) || /application\/(x-)?zip|zip-compressed/.test(mimeOf(file));
}

export function isTnefFile(file = {}) {
  const buffer = file.buffer;
  if (/ms-tnef/.test(mimeOf(file)) || /^winmail\.dat$/i.test(nameOf(file))) return true;
  return Boolean(buffer?.length >= 4 && buffer.readUInt32LE(0) === TNEF_SIGNATURE);
}

export function isContainerFile(file = {}) {
  return isZipFile(file) || isTnefFile(file);
}

function cString(data) {
  return Buffer.from(data).toString('latin1').replace(/\0+$/, '').trim();
}

/**
 * Minimal TNEF reader: attachment titles + bytes, and the plain-text body when present.
 * shortcut: uses the 8.3 attachment title (extension intact) and skips MAPI long names and RTF bodies; parse attAttachment props if names matter.
 */
export function parseTnef(buffer) {
  const buf = Buffer.from(buffer || []);
  if (buf.length < 6 || buf.readUInt32LE(0) !== TNEF_SIGNATURE) return null;
  const files = [];
  let body = '';
  let current = null;
  let pos = 6;
  while (pos + 9 <= buf.length) {
    const id = buf.readUInt32LE(pos + 1) & 0xffff;
    const length = buf.readUInt32LE(pos + 5);
    const start = pos + 9;
    if (start + length > buf.length) break;
    const data = buf.subarray(start, start + length);
    pos = start + length + 2;
    if (id === 0x9002) {
      current = { originalName: '', buffer: null };
      files.push(current);
    } else if (id === 0x8010 && current) {
      current.originalName = cString(data);
    } else if (id === 0x800f && current) {
      current.buffer = Buffer.from(data);
    } else if (id === 0x800c) {
      body = cString(data);
    }
  }
  return {
    body,
    files: files.filter((file) => file.buffer?.length).map((file, index) => ({ originalName: file.originalName || `attachment-${index + 1}.bin`, buffer: file.buffer })),
  };
}

function zipEntries(buffer) {
  const Zip = loadZip();
  if (!Zip) return [];
  try {
    return new Zip(Buffer.from(buffer))
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .filter((entry) => !/(^|\/)(__MACOSX|\.)/.test(entry.entryName))
      .map((entry) => ({ originalName: entry.entryName.split('/').pop(), buffer: entry.getData() }));
  } catch {
    return [];
  }
}

function asFile(entry) {
  return { originalName: entry.originalName, name: entry.originalName, buffer: entry.buffer, mimeType: '' };
}

/**
 * Replaces zip / winmail.dat entries with their contents (one nested level). Other files pass through.
 * @param {{depth?: number, bodyFileName?: string}} [options] bodyFileName names the TNEF body text file
 */
export function expandContainerFiles(files = [], { depth = 0, bodyFileName = 'message-body.txt' } = {}) {
  const out = [];
  let total = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.buffer || !isContainerFile(file) || depth > 1) {
      out.push(file);
      continue;
    }
    let inner = [];
    if (isTnefFile(file)) {
      const parsed = parseTnef(file.buffer);
      if (!parsed) {
        out.push(file);
        continue;
      }
      inner = parsed.files;
      if (parsed.body) inner.push({ originalName: bodyFileName, buffer: Buffer.from(parsed.body, 'utf8') });
    } else {
      inner = zipEntries(file.buffer);
    }
    const kept = [];
    for (const entry of inner) {
      if (out.length + kept.length >= MAX_ENTRIES) break;
      total += entry.buffer.length;
      if (total > MAX_TOTAL_BYTES) break;
      kept.push(asFile(entry));
    }
    out.push(...expandContainerFiles(kept, { depth: depth + 1, bodyFileName }));
  }
  return out.slice(0, MAX_ENTRIES);
}

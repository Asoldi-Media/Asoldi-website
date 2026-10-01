/**
 * Append-only workshop / iteration notes with files.
 * Disk: ~/.asoldi-website-data/workshop-notes/<clientId>/<noteId>/
 * Not hub media, not Kundedata, not Maker.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { randomUUID } from 'crypto';
import { getPersistentDataDir } from '../data/storage-path.js';
import { appendHeardFact } from './workshop-needs.js';
import { getWorkshopRecord, mergeWorkshopRecord } from './workshop-record.js';

export const WORKSHOP_NOTES_DIR = 'workshop-notes';
const MAX_TEXT = 8000;

function nowIso() {
  return new Date().toISOString();
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function safeToken(value = '', max = 80) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, max);
}

function safeFileName(name = '') {
  const base = String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base || 'file';
}

function mimeFromName(name = '') {
  const ext = extname(String(name || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

export function workshopNotesRoot() {
  const dir = join(getPersistentDataDir(), WORKSHOP_NOTES_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function workshopNoteDir(clientId, noteId) {
  const client = safeToken(clientId);
  const note = safeToken(noteId);
  if (!client || !note) fail(400, 'Ugyldig notatsti.');
  const dir = join(workshopNotesRoot(), client, note);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function noteFilePath(clientId, noteId, file) {
  const dir = normalize(workshopNoteDir(clientId, noteId));
  const name = `${safeToken(file.id, 80)}-${safeFileName(file.originalName)}`;
  const full = normalize(join(dir, name));
  if (full !== dir && !full.startsWith(dir + sep)) fail(400, 'Ugyldig filsti.');
  return full;
}

function storedFileFromUpload(upload = {}) {
  return {
    id: sanitizeText(upload.id) || `wf-${randomUUID().slice(0, 8)}`,
    originalName: safeFileName(upload.originalName || upload.originalname || 'fil'),
    mime: sanitizeText(upload.mime || upload.mimetype) || 'application/octet-stream',
    bytes: Number(upload.bytes || upload.size || upload.buffer?.length) || 0,
    buffer: upload.buffer,
  };
}

function writeFiles(clientId, noteId, files = []) {
  const stored = [];
  for (const upload of files) {
    const file = storedFileFromUpload(upload);
    if (!file.buffer || !Buffer.isBuffer(file.buffer)) continue;
    const path = noteFilePath(clientId, noteId, file);
    writeFileSync(path, file.buffer);
    stored.push({
      id: file.id,
      originalName: file.originalName,
      mime: file.mime,
      bytes: file.bytes,
    });
  }
  return stored;
}

function heardFromNote({ clientId, kind, text, at }) {
  const detail = sanitizeText(text).slice(0, 400);
  if (!detail) return null;
  const title = kind === 'iteration' ? 'Hørt i iterasjonsnotat' : 'Hørt i workshop-notat';
  const entry = {
    id: `heard.${kind}.${Date.now()}`,
    title,
    detail,
    source: kind === 'iteration' ? 'iteration-note' : 'workshop-note',
    quote: detail,
    at,
  };
  try {
    appendHeardFact(clientId, entry);
  } catch {
    // T01 sidecar is best-effort; the fact still lives on workshop.heardFacts.
  }
  return entry;
}

export function appendWorkshopDeskNote({
  client,
  kind = 'workshop',
  text = '',
  files = [],
  by = '',
} = {}) {
  const clientId = sanitizeText(client?.id);
  if (!clientId) fail(400, 'Sales client is required.');
  const noteKind = kind === 'iteration' ? 'iteration' : 'workshop';
  const body = sanitizeText(text).slice(0, MAX_TEXT);
  const uploads = Array.isArray(files) ? files : [];
  if (!body && !uploads.length) fail(400, 'Skriv et notat eller legg ved en fil.');
  const id = `wn-${randomUUID()}`;
  const at = nowIso();
  const storedFiles = writeFiles(clientId, id, uploads);
  const current = getWorkshopRecord(client);
  const heard = heardFromNote({ clientId, kind: noteKind, text: body, at });
  if (noteKind === 'iteration') {
    const entry = {
      id,
      at,
      by: sanitizeText(by),
      text: body,
      files: storedFiles,
      doneAt: '',
      doneBy: '',
    };
    return mergeWorkshopRecord(current, {
      iterationLog: [...current.iterationLog, entry],
      heardFacts: heard ? [...current.heardFacts, heard] : current.heardFacts,
    });
  }
  const note = {
    id,
    kind: 'workshop',
    at,
    by: sanitizeText(by),
    text: body,
    files: storedFiles,
  };
  return mergeWorkshopRecord(current, {
    notes: [...current.notes, note],
    heardFacts: heard ? [...current.heardFacts, heard] : current.heardFacts,
  });
}

export function markIterationLogDone(client, entryId, { done = true, by = '' } = {}) {
  const current = getWorkshopRecord(client);
  const target = sanitizeText(entryId);
  if (!target) fail(400, 'entryId is required.');
  let found = false;
  const iterationLog = current.iterationLog.map((row) => {
    if (row.id !== target) return row;
    found = true;
    return {
      ...row,
      doneAt: done ? (row.doneAt || nowIso()) : '',
      doneBy: done ? sanitizeText(by) : '',
    };
  });
  if (!found) fail(404, 'Fant ikke iterasjonsmeldingen.');
  return mergeWorkshopRecord(current, { iterationLog });
}

export function readWorkshopNoteFile(clientId, noteId, fileId) {
  const recordClientId = safeToken(clientId);
  const recordNoteId = safeToken(noteId);
  const recordFileId = safeToken(fileId);
  if (!recordClientId || !recordNoteId || !recordFileId) fail(400, 'Ugyldig fil.');
  const dir = join(workshopNotesRoot(), recordClientId, recordNoteId);
  if (!existsSync(dir)) fail(404, 'Fant ikke filen.');
  const match = readdirSync(dir).find((name) => name.startsWith(`${recordFileId}-`));
  if (!match) fail(404, 'Fant ikke filen.');
  const full = normalize(join(dir, match));
  const root = normalize(dir);
  if (full !== root && !full.startsWith(root + sep)) fail(400, 'Ugyldig filsti.');
  const originalName = match.slice(recordFileId.length + 1) || match;
  return {
    buffer: readFileSync(full),
    originalName,
    mime: mimeFromName(originalName),
    bytes: statSync(full).size,
  };
}

export function workshopNoteFileUrl(clientId, noteId, fileId) {
  return `/api/admin/sales/${encodeURIComponent(clientId)}/workshop/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(fileId)}`;
}

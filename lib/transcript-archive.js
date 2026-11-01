// Transcript archive: <dataDir>/transcript-archive/<clientId>/<sha256>.json, one file per linked
// recording with talk. Files are content-addressed and written once; a newer copy of the same meeting
// replaces the older one. The archive keeps a transcript after the Fireflies store prunes its record
// (a year after the last change), until the client's retention date (lib/personal-data.js).
//
// Behind privacy.archive.enabled (default off): with the switch off, linking and unlinking write and
// delete nothing here. The daily purge (lib/delivery-retention.js, privacy.purge) removes expired files.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import * as sales from '../data/sales.js';
import { listStoredFirefliesMeetings, readStoredFirefliesMeeting } from './fireflies-webhook.js';
import { clientRetention, isValidClientId, registerStore, perClientPath, listFilesUnder } from './personal-data.js';
import { transcriptArchiveEnabled } from './privacy-settings.js';

export const TRANSCRIPT_ARCHIVE_DIR = 'transcript-archive';
export const TRANSCRIPT_ARCHIVE_KIND = 'asoldi.transcript-archive/1';
export const ARCHIVE_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const SHA_RE = /^[a-f0-9]{64}$/;

function text(value) {
  return String(value ?? '').trim();
}

function rootOf(dataDir) {
  return join(dataDir || getPersistentDataDir(), TRANSCRIPT_ARCHIVE_DIR);
}

function clientDir(clientId, dataDir) {
  if (!isValidClientId(clientId)) return '';
  return join(rootOf(dataDir), text(clientId));
}

function nowDate(now) {
  if (now instanceof Date) return now;
  const parsed = new Date(now ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** sha256 of the transcript text as stored (the archive's content address). */
export function transcriptSha(transcript = '') {
  return createHash('sha256').update(String(transcript ?? ''), 'utf8').digest('hex');
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** The archive record for a stored Fireflies meeting (§ archive fields). */
export function archiveRecordFor(record = {}, { clientId, linkedBy = '', purpose = '', now = new Date(), retain = { basis: '', until: '' } } = {}) {
  const transcript = String(record.transcript ?? '');
  return {
    kind: TRANSCRIPT_ARCHIVE_KIND,
    clientId: text(clientId),
    meetingId: text(record.meetingId),
    purpose: text(purpose || record.purpose || record.match?.purpose),
    title: text(record.title),
    startedAt: text(record.startedAt),
    durationMinutes: record.durationMinutes === '' || record.durationMinutes == null ? '' : Number(record.durationMinutes) || 0,
    attendees: asList(record.attendees).map(text).filter(Boolean),
    hostEmail: text(record.hostEmail),
    transcript,
    summary: text(record.summary),
    actionItems: asList(record.actionItems).map(text).filter(Boolean),
    keywords: asList(record.keywords).map(text).filter(Boolean),
    sha256: transcriptSha(transcript),
    archivedAt: nowDate(now).toISOString(),
    linkedBy: text(linkedBy || record.match?.linkedBy),
    retainUntil: text(retain.until),
    retainBasis: text(retain.basis),
  };
}

function writeOnce(path, body) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    if (existsSync(path)) return false;
    renameSync(tmp, path);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function archiveFiles(clientId, dataDir) {
  const dir = clientDir(clientId, dataDir);
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SHA_RE.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
    .map((name) => ({ name, path: join(dir, name), sha256: name.replace(/\.json$/, '') }));
}

/**
 * Archives one linked recording for a client: { written, sha256, skipped? }. A recording without
 * talk is skipped (a later link pass archives it once the transcript is in). An older copy of the
 * same meeting in the client's folder is replaced.
 */
export function archiveTranscript({
  clientId,
  meetingId,
  record = null,
  linkedBy = '',
  purpose = '',
  client = undefined,
  dataDir,
  now = new Date(),
  settings,
} = {}) {
  const dir = clientDir(clientId, dataDir);
  if (!dir) return { written: false, skipped: 'bad-client-id' };
  const stored = record || readStoredFirefliesMeeting(meetingId);
  if (!stored || !text(stored.meetingId)) return { written: false, skipped: 'no-record' };
  if (!text(stored.transcript)) return { written: false, skipped: 'no-transcript' };
  const owner = client === undefined ? sales.getSalesClientById(clientId) : client;
  const retain = owner ? clientRetention(owner, { settings }) : { basis: 'unknown', until: '' };
  const entry = archiveRecordFor(stored, { clientId, linkedBy, purpose, now, retain });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${entry.sha256}.json`);
  const written = existsSync(path) ? false : writeOnce(path, `${JSON.stringify(entry, null, 2)}\n`);
  // One copy per meeting: an older transcript of the same meeting is superseded.
  for (const file of archiveFiles(clientId, dataDir)) {
    if (file.sha256 === entry.sha256) continue;
    const other = readJson(file.path);
    if (text(other?.meetingId) === entry.meetingId) rmSync(file.path, { force: true });
  }
  return { written, sha256: entry.sha256 };
}

/** Deletes the client's archived copies of one meeting (every meeting when meetingId is ''). Returns the count. */
export function deleteArchivedTranscripts(clientId, meetingId = '', { dataDir } = {}) {
  let removed = 0;
  const wanted = text(meetingId);
  for (const file of archiveFiles(clientId, dataDir)) {
    const entry = wanted ? readJson(file.path) : null;
    if (wanted && text(entry?.meetingId) !== wanted) continue;
    rmSync(file.path, { force: true });
    removed += 1;
  }
  const dir = clientDir(clientId, dataDir);
  if (dir && existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  return removed;
}

/** Every archived transcript of a client, newest meeting first. */
export function readArchivedTranscripts(clientId, { dataDir } = {}) {
  return archiveFiles(clientId, dataDir)
    .map((file) => readJson(file.path))
    .filter((entry) => entry && text(entry.meetingId))
    .sort((a, b) => Date.parse(b.startedAt || b.archivedAt || 0) - Date.parse(a.startedAt || a.archivedAt || 0));
}

/**
 * One transcript by its sha256: the archived copy, else the stored Fireflies meeting on the client's
 * card (or matched to the client) whose transcript has that sha. null when neither has it.
 */
export function readTranscriptBySha(clientId, sha, { dataDir, readStored = readStoredFirefliesMeeting } = {}) {
  const wanted = text(sha).toLowerCase();
  if (!SHA_RE.test(wanted) || !isValidClientId(clientId)) return null;
  const dir = clientDir(clientId, dataDir);
  const path = dir ? join(dir, `${wanted}.json`) : '';
  if (path && existsSync(path)) {
    const entry = readJson(path);
    if (entry && text(entry.sha256) === wanted) return { ...entry, source: 'archive' };
  }
  const client = sales.getSalesClientById(clientId);
  const ids = new Set((client?.meetings || []).map((row) => text(row?.meetingId)).filter(Boolean));
  for (const row of listStoredFirefliesMeetings({ clientId })) ids.add(text(row.meetingId));
  for (const id of ids) {
    const stored = readStored(id);
    if (stored && text(stored.transcript) && transcriptSha(stored.transcript) === wanted) {
      return { ...archiveRecordFor(stored, { clientId }), archivedAt: '', source: 'fireflies' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- link hooks (switch-gated)

/** Linker hook: a recording went onto a client card. Archives it when privacy.archive is on. */
export function onTranscriptLinked(clientId, meetingId, { ref = {}, settings, dataDir, now } = {}) {
  if (!transcriptArchiveEnabled(settings)) return { written: false, skipped: 'disabled' };
  if (!text(meetingId) || text(meetingId).toLowerCase().startsWith('live:')) return { written: false, skipped: 'placeholder' };
  return archiveTranscript({
    clientId,
    meetingId,
    linkedBy: text(ref.linkedBy),
    purpose: text(ref.purpose),
    dataDir,
    now,
    settings,
  });
}

/** Linker hook: a recording left a client card. Deletes its archived copy when privacy.archive is on. */
export function onTranscriptUnlinked(clientId, meetingId, { settings, dataDir } = {}) {
  if (!transcriptArchiveEnabled(settings)) return 0;
  if (!text(meetingId)) return 0;
  return deleteArchivedTranscripts(clientId, meetingId, { dataDir });
}

// ---------------------------------------------------------------- sync (backfill) and purge

/**
 * Recordings with talk on client cards that have no archived copy yet. With `apply` they are archived.
 * Returns { planned: [{ clientId, meetingId, sha256 }], written }.
 */
export function syncTranscriptArchive({ apply = false, dataDir, now = new Date(), settings, clients = null, readStored = readStoredFirefliesMeeting } = {}) {
  const list = Array.isArray(clients) ? clients : sales.getSalesClients();
  const planned = [];
  let written = 0;
  for (const client of list) {
    if (!isValidClientId(client?.id)) continue;
    const have = new Set(archiveFiles(client.id, dataDir).map((file) => file.sha256));
    for (const row of Array.isArray(client.meetings) ? client.meetings : []) {
      const meetingId = text(row?.meetingId);
      if (!meetingId || meetingId.toLowerCase().startsWith('live:')) continue;
      const stored = readStored(meetingId);
      if (!stored || !text(stored.transcript)) continue;
      const sha256 = transcriptSha(stored.transcript);
      if (have.has(sha256)) continue;
      planned.push({ clientId: client.id, meetingId, sha256 });
      if (!apply) continue;
      const result = archiveTranscript({ clientId: client.id, meetingId, record: stored, linkedBy: row.linkedBy, purpose: row.purpose, client, dataDir, now, settings });
      if (result.written) written += 1;
    }
  }
  return { planned, written };
}

/**
 * Archived files past their retention date. The date is recomputed from the client as it is now
 * (signing, not-sold and contract end move it); a file whose client is gone keeps its stored date, or
 * archivedAt plus retention.leadMonths. Nothing is purged while the sales store reads as empty.
 */
export function purgeTranscriptArchive({ dryRun = true, dataDir, now = new Date(), settings } = {}) {
  const at = nowDate(now);
  const root = rootOf(dataDir);
  if (!existsSync(root)) return { items: [] };
  const clients = sales.getSalesClients();
  const folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && isValidClientId(entry.name));
  if (!clients.length && folders.length) return { items: [], skipped: 'empty-sales-store' };
  const byId = new Map(clients.map((client) => [text(client.id), client]));
  const leadMonths = Number(settings?.retention?.leadMonths) > 0 ? Number(settings.retention.leadMonths) : 12;
  const items = [];
  for (const folder of folders) {
    const client = byId.get(folder.name) || null;
    const live = client ? clientRetention(client, { settings }) : null;
    for (const file of archiveFiles(folder.name, dataDir)) {
      const entry = readJson(file.path) || {};
      let until = live ? live.until : text(entry.retainUntil);
      if (!live && !until) {
        const archived = Date.parse(text(entry.archivedAt));
        until = Number.isFinite(archived) ? new Date(archived + leadMonths * 30.4375 * 86_400_000).toISOString() : '';
      }
      const basis = live ? live.basis : 'client-gone';
      if (!until || Date.parse(until) > at.getTime()) continue;
      items.push({ clientId: folder.name, meetingId: text(entry.meetingId), sha256: file.sha256, retainUntil: until, basis });
      if (!dryRun) rmSync(file.path, { force: true });
    }
    if (!dryRun) {
      const dir = join(root, folder.name);
      if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    }
  }
  return { items };
}

/** Loop step: archives recordings that arrived without a link pass (privacy.archive on only). */
export const tickSteps = Object.freeze([
  {
    name: 'transcript-archive-sync',
    order: 80,
    scope: 'global',
    everyMs: ARCHIVE_SYNC_EVERY_MS,
    async run(ctx = {}) {
      if (ctx.mode === 'off' || !transcriptArchiveEnabled(ctx.settings)) return { wrote: false };
      const result = syncTranscriptArchive({ apply: true, dataDir: ctx.dataDir, now: ctx.now, settings: ctx.settings });
      return { wrote: result.written > 0, written: result.written };
    },
  },
]);

registerStore({
  id: 'transcript-archive',
  label: 'Transkripsjonsarkiv',
  dir: `${TRANSCRIPT_ARCHIVE_DIR}/<clientId>`,
  clientKey: 'path',
  retention: { rule: 'transcript' },
  personalData: 'Full meeting transcripts and attendees',
  purpose: 'The meeting record behind the delivery brief',
  legalBasis: 'Legitimate interest (leads); contract (clients)',
  processors: ['Hostinger'],
  export(clientId, ctx = {}) {
    return { records: readArchivedTranscripts(clientId, { dataDir: ctx.dataDir }) };
  },
  erase(clientId, ctx = {}) {
    const path = perClientPath(TRANSCRIPT_ARCHIVE_DIR, clientId, { ctx });
    const files = path ? listFilesUnder(path, ctx).map((file) => file.path) : [];
    if (!files.length) return { action: 'none', records: 0, files: [] };
    if (!ctx.dryRun) deleteArchivedTranscripts(clientId, '', { dataDir: ctx.dataDir });
    return { action: 'delete', records: files.length, files };
  },
  purge(ctx = {}) {
    return purgeTranscriptArchive({ dryRun: ctx.dryRun !== false, dataDir: ctx.dataDir, now: ctx.now, settings: ctx.settings });
  },
});

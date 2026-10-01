/**
 * Admin ↔ developer request threads (T02).
 *
 * Staging lives next to sales-clients.json. Nothing is written to Maker,
 * Kundedata, hub media, or products until the developer commits a file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { randomUUID } from 'crypto';
import { getDataFilePath, getPersistentDataDir, writeDataJson } from '../data/storage-path.js';
import * as sales from '../data/sales.js';
import { isSsuSalesProduct } from '../data/sales.js';
import * as clientPortal from '../data/client-portal.js';
import { saveClientUploadBuffer } from './client-media-store.js';
import { isPrivateMakerUrl } from './laptop-preview.js';
import {
  DOMAIN_HELP_BUY,
  DOMAIN_HELP_OWNED,
  domainHelpLabel,
  domainHelpMessage,
  isValidDomainName,
  normalizeDomainInput,
} from './domain-setup.js';

export const REQUESTS_INDEX_FILE = 'admin-dev-requests.json';
export const REQUESTS_FILES_DIR = 'admin-dev-request-files';

const MAX_TEXT = 8000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
};

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

function uniqueUrls(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = sanitizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function sanitizeRequestKind(value = '') {
  const kind = sanitizeText(value);
  if (kind === DOMAIN_HELP_OWNED || kind === DOMAIN_HELP_BUY) return kind;
  return '';
}

function lastKindFromThread(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const kind = sanitizeRequestKind(messages[index]?.kind);
    if (kind) return kind;
  }
  return '';
}

function uniqueRequestKinds(thread) {
  const seen = [];
  for (const message of thread?.messages || []) {
    const kind = sanitizeRequestKind(message?.kind);
    if (kind && !seen.includes(kind)) seen.push(kind);
  }
  return seen;
}

export function findSalesClientForPortalUser({
  portalUserId = '',
  email = '',
  salesClientId = '',
} = {}) {
  const explicitId = sanitizeText(salesClientId);
  if (explicitId) {
    const client = sales.getSalesClientById(explicitId);
    if (client) return client;
  }
  const userId = sanitizeText(portalUserId);
  const mail = sanitizeText(email).toLowerCase();
  const clients = sales.getSalesClients();
  if (userId) {
    const hit = clients.find((row) => sanitizeText(row.portalUserId) === userId);
    if (hit) return hit;
  }
  if (mail) {
    const hit = clients.find((row) => sanitizeText(row.contactEmail).toLowerCase() === mail);
    if (hit) return hit;
  }
  return null;
}

export function mimeFromName(name = '', fallback = '') {
  const fromExt = MIME_BY_EXT[extname(String(name || '')).toLowerCase()];
  const given = sanitizeText(fallback).toLowerCase();
  return fromExt || given || 'application/octet-stream';
}

export function makerUploadFieldForName(name = '', mime = '') {
  const ext = extname(String(name || '')).toLowerCase();
  const kind = String(mime || '').toLowerCase();
  if (kind.startsWith('image/') || IMAGE_EXT.has(ext)) return 'generalImages';
  if (kind.startsWith('video/') || VIDEO_EXT.has(ext)) return 'generalVideos';
  if (kind.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'generalAudio';
  return 'mainMedia';
}

export function recommendedCommitDestination(client = null) {
  return sanitizeText(client?.makerRun?.runId) ? 'maker' : 'client-uploads';
}

function normalizeMakerBase(value = '') {
  const raw = sanitizeText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function makerAuthHeaders() {
  const key = sanitizeText(process.env.WEBSITE_MAKER_API_KEY || process.env.WEBSITEMAKER_API_KEY);
  return key ? { 'x-api-key': key } : {};
}

export function requestsIndexPath() {
  return getDataFilePath(REQUESTS_INDEX_FILE);
}

export function requestsFilesRoot() {
  const dir = join(getPersistentDataDir(), REQUESTS_FILES_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function clientFilesDir(salesClientId) {
  const id = safeToken(salesClientId);
  if (!id) fail(400, 'Ugyldig salgskunde.');
  const dir = join(requestsFilesRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function stagingFilePath(salesClientId, file) {
  const dir = normalize(clientFilesDir(salesClientId));
  const name = `${safeToken(file.id, 80)}-${safeFileName(file.originalName)}`;
  const full = normalize(join(dir, name));
  if (full !== dir && !full.startsWith(dir + sep)) fail(400, 'Ugyldig filsti.');
  return full;
}

function emptyThread(salesClientId) {
  return {
    salesClientId,
    messages: [],
    unreadForAdmin: 0,
    unreadForDeveloper: 0,
    updatedAt: '',
  };
}

function readIndex() {
  const path = requestsIndexPath();
  if (!existsSync(path)) return { threads: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const threads = parsed?.threads && typeof parsed.threads === 'object' ? parsed.threads : {};
    return { threads };
  } catch {
    return { threads: {} };
  }
}

function writeIndex(index) {
  writeDataJson(requestsIndexPath(), { threads: index?.threads && typeof index.threads === 'object' ? index.threads : {} });
}

function requireEligibleClient(salesClientId) {
  const id = sanitizeText(salesClientId);
  if (!id) fail(400, 'Mangler salgskunde.');
  const client = sales.getSalesClientById(id);
  if (!client) fail(404, 'Fant ikke salgskunden.');
  if (isSsuSalesProduct(client.product)) fail(400, 'SSU-kunder har ikke utviklertråd.');
  return client;
}

function findFileInThread(thread, fileId) {
  const target = sanitizeText(fileId);
  if (!target) return null;
  for (const message of thread.messages || []) {
    for (const file of message.files || []) {
      if (file.id === target) return { message, file };
    }
  }
  return null;
}

function lastSnippet(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const last = messages[messages.length - 1];
  if (!last) return '';
  const text = sanitizeText(last.text);
  if (text) return text.slice(0, 140);
  const name = last.files?.[0]?.originalName;
  return name ? String(name) : '';
}

function presentThread(client, thread) {
  const lastKind = lastKindFromThread(thread);
  const requestKinds = uniqueRequestKinds(thread);
  return {
    salesClientId: client.id,
    businessName: client.businessName || '',
    makerRunId: sanitizeText(client.makerRun?.runId),
    portalUserId: sanitizeText(client.portalUserId),
    recommendedDestination: recommendedCommitDestination(client),
    unreadForAdmin: Number(thread.unreadForAdmin) || 0,
    unreadForDeveloper: Number(thread.unreadForDeveloper) || 0,
    updatedAt: thread.updatedAt || '',
    lastKind,
    lastKindLabel: domainHelpLabel(lastKind),
    requestKinds,
    requestKindLabels: requestKinds.map((kind) => domainHelpLabel(kind)).filter(Boolean),
    messages: Array.isArray(thread.messages) ? thread.messages : [],
  };
}

export function getThread(salesClientId, { readerRole } = {}) {
  const client = requireEligibleClient(salesClientId);
  const index = readIndex();
  const stored = index.threads[client.id] || emptyThread(client.id);
  let thread = stored;
  const role = sanitizeText(readerRole).toLowerCase();
  if (role === 'admin' && Number(thread.unreadForAdmin) > 0) {
    thread = { ...thread, unreadForAdmin: 0 };
    index.threads[client.id] = thread;
    writeIndex(index);
  } else if (role === 'developer' && Number(thread.unreadForDeveloper) > 0) {
    thread = { ...thread, unreadForDeveloper: 0 };
    index.threads[client.id] = thread;
    writeIndex(index);
  }
  return presentThread(client, thread);
}

export function listThreads({ unreadKey = 'unreadForAdmin' } = {}) {
  const index = readIndex();
  const rows = [];
  for (const [salesClientId, thread] of Object.entries(index.threads || {})) {
    if (!Array.isArray(thread?.messages) || thread.messages.length === 0) continue;
    let client;
    try {
      client = requireEligibleClient(salesClientId);
    } catch {
      continue;
    }
    const lastKind = lastKindFromThread(thread);
    rows.push({
      salesClientId: client.id,
      businessName: client.businessName || '',
      updatedAt: thread.updatedAt || '',
      unreadForAdmin: Number(thread.unreadForAdmin) || 0,
      unreadForDeveloper: Number(thread.unreadForDeveloper) || 0,
      lastSnippet: lastSnippet(thread),
      lastAuthorRole: thread.messages[thread.messages.length - 1]?.authorRole || '',
      lastKind,
      lastKindLabel: domainHelpLabel(lastKind),
      requestKinds: uniqueRequestKinds(thread),
    });
  }
  const unreadField = unreadKey === 'unreadForDeveloper' ? 'unreadForDeveloper' : 'unreadForAdmin';
  rows.sort((a, b) => {
    const aUnread = a[unreadField] > 0 ? 1 : 0;
    const bUnread = b[unreadField] > 0 ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return rows;
}

export function addMessage({
  salesClientId,
  authorRole,
  authorLabel = '',
  text = '',
  files = [],
  kind = '',
  domain = '',
} = {}) {
  const client = requireEligibleClient(salesClientId);
  const role = sanitizeText(authorRole).toLowerCase();
  if (role !== 'admin' && role !== 'developer' && role !== 'client') fail(400, 'Ugyldig avsender.');
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
  const incoming = Array.isArray(files) ? files : [];
  if (!body && incoming.length === 0) fail(400, 'Skriv en melding eller legg ved en fil.');
  const requestKind = sanitizeRequestKind(kind);
  const host = normalizeDomainInput(domain);

  const storedFiles = [];
  for (const entry of incoming) {
    const buffer = entry?.buffer;
    if (!buffer || !buffer.length) fail(400, 'Tom fil.');
    const originalName = safeFileName(entry.originalName || entry.name || 'file');
    const id = randomUUID();
    const mime = mimeFromName(originalName, entry.mime || entry.mimetype);
    const record = {
      id,
      originalName,
      mime,
      bytes: buffer.length,
      committed: null,
    };
    writeFileSync(stagingFilePath(client.id, record), buffer);
    storedFiles.push(record);
  }

  const index = readIndex();
  const current = index.threads[client.id] || emptyThread(client.id);
  const defaultLabel = role === 'admin' ? 'Admin' : role === 'developer' ? 'Utvikler' : 'Kunde';
  const message = {
    id: randomUUID(),
    at: nowIso(),
    authorRole: role,
    authorLabel: sanitizeText(authorLabel) || defaultLabel,
    text: body,
    kind: requestKind,
    domain: host,
    files: storedFiles,
  };
  const next = {
    ...current,
    salesClientId: client.id,
    messages: [...(current.messages || []), message],
    updatedAt: message.at,
    unreadForAdmin: Number(current.unreadForAdmin) || 0,
    unreadForDeveloper: Number(current.unreadForDeveloper) || 0,
  };
  if (role === 'admin') next.unreadForDeveloper += 1;
  else if (role === 'developer') next.unreadForAdmin += 1;
  else {
    next.unreadForAdmin += 1;
    next.unreadForDeveloper += 1;
  }
  index.threads[client.id] = next;
  writeIndex(index);
  return presentThread(client, next);
}

export function addClientDomainHelp({
  portalUserId = '',
  salesClientId = '',
  email = '',
  authorLabel = '',
  kind = '',
  domain = '',
  businessName = '',
} = {}) {
  const requestKind = sanitizeRequestKind(kind);
  if (!requestKind) fail(400, 'Ugyldig type domeneforespørsel.');
  const host = normalizeDomainInput(domain);
  if (!isValidDomainName(host)) fail(400, 'Skriv inn et gyldig domenenavn.');
  const client = findSalesClientForPortalUser({ portalUserId, email, salesClientId });
  if (!client) fail(409, 'Denne kontoen er ikke koblet til et kundekort hos Asoldi ennå.');
  return addMessage({
    salesClientId: client.id,
    authorRole: 'client',
    authorLabel: sanitizeText(authorLabel) || sanitizeText(businessName) || client.businessName || 'Kunde',
    text: domainHelpMessage({
      kind: requestKind,
      domain: host,
      businessName: businessName || client.businessName,
    }),
    kind: requestKind,
    domain: host,
  });
}

export function readStagingFile(salesClientId, fileId) {
  const client = requireEligibleClient(salesClientId);
  const index = readIndex();
  const thread = index.threads[client.id] || emptyThread(client.id);
  const found = findFileInThread(thread, fileId);
  if (!found) fail(404, 'Fant ikke filen.');
  const path = stagingFilePath(client.id, found.file);
  if (!existsSync(path)) fail(404, 'Fant ikke filen.');
  return {
    path,
    buffer: readFileSync(path),
    file: found.file,
  };
}

function markFileCommitted(client, fileId, committed) {
  const index = readIndex();
  const thread = index.threads[client.id];
  if (!thread) fail(404, 'Fant ikke tråden.');
  let updated = false;
  const messages = (thread.messages || []).map((message) => ({
    ...message,
    files: (message.files || []).map((file) => {
      if (file.id !== fileId) return file;
      updated = true;
      return { ...file, committed };
    }),
  }));
  if (!updated) fail(404, 'Fant ikke filen.');
  const next = { ...thread, messages, updatedAt: nowIso() };
  index.threads[client.id] = next;
  writeIndex(index);
  return presentThread(client, next);
}

function requireUncommittedFile(client, fileId) {
  const index = readIndex();
  const thread = index.threads[client.id] || emptyThread(client.id);
  const found = findFileInThread(thread, fileId);
  if (!found) fail(404, 'Fant ikke filen.');
  if (found.file.committed) fail(400, 'Filen er allerede lagt inn.');
  const path = stagingFilePath(client.id, found.file);
  if (!existsSync(path)) fail(404, 'Fant ikke filen.');
  return { ...found, path, buffer: readFileSync(path) };
}

async function commitToClientUploads(client, fileId) {
  const portalUserId = sanitizeText(client.portalUserId);
  if (!portalUserId) fail(400, 'Koble kunden via Connect på Sales først.');
  const found = requireUncommittedFile(client, fileId);
  const saved = await saveClientUploadBuffer(portalUserId, {
    buffer: found.buffer,
    originalName: found.file.originalName,
    prefix: 'dev-request',
  });
  const profileNow = clientPortal.getClientProfileByUserId(portalUserId)
    || clientPortal.upsertClientProfile(portalUserId, {});
  const current = profileNow?.clientDataBank && typeof profileNow.clientDataBank === 'object'
    ? profileNow.clientDataBank
    : {};
  const media = current.media && typeof current.media === 'object' ? current.media : {};
  clientPortal.setClientDataBank(portalUserId, {
    ...current,
    media: {
      ...media,
      uncategorized: uniqueUrls([...(media.uncategorized || []), saved.url]),
    },
  }, { businessId: profileNow?.businessId });
  return markFileCommitted(client, fileId, {
    at: nowIso(),
    destination: 'client-uploads',
    url: saved.url,
  });
}

function browserHandoffPayload(client, found, base) {
  const field = makerUploadFieldForName(found.file.originalName, found.file.mime);
  const runId = sanitizeText(client.makerRun?.runId);
  return {
    ok: true,
    browserHandoff: true,
    websiteMakerBaseUrl: base,
    runId,
    fileId: found.file.id,
    originalName: found.file.originalName,
    mime: found.file.mime,
    field,
    downloadPath: `/api/admin/dev-requests/${encodeURIComponent(client.id)}/files/${encodeURIComponent(found.file.id)}`,
    uploadUrl: `${base}/api/runs/${encodeURIComponent(runId)}/uploads`,
  };
}

async function commitToMaker(client, fileId, {
  websiteMakerBaseUrl = '',
  publicHost = false,
  fetchImpl,
} = {}) {
  const runId = sanitizeText(client.makerRun?.runId);
  if (!runId) fail(400, 'Opprett eller knytt et Maker-run.');
  const base = normalizeMakerBase(websiteMakerBaseUrl);
  if (!base) fail(400, 'Website Maker-adressen mangler.');
  const found = requireUncommittedFile(client, fileId);
  if (publicHost && isPrivateMakerUrl(base)) {
    return browserHandoffPayload(client, found, base);
  }
  const field = makerUploadFieldForName(found.file.originalName, found.file.mime);
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') fail(500, 'Mangler fetch for Maker-opplasting.');
  const form = new FormData();
  const bytes = found.buffer instanceof Uint8Array ? found.buffer : new Uint8Array(found.buffer);
  form.append(
    field,
    new Blob([bytes], { type: found.file.mime || 'application/octet-stream' }),
    found.file.originalName
  );
  let response;
  try {
    response = await fetchFn(`${base}/api/runs/${encodeURIComponent(runId)}/uploads`, {
      method: 'POST',
      headers: makerAuthHeaders(),
      body: form,
    });
  } catch (error) {
    fail(502, error?.message || 'Kunne ikke nå Website Maker.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(
      response.status >= 400 && response.status <= 599 ? response.status : 502,
      data.error || data.message || 'Website Maker avviste filen.'
    );
  }
  return markFileCommitted(client, fileId, {
    at: nowIso(),
    destination: 'maker',
    field,
  });
}

export async function commitFile({
  salesClientId,
  fileId,
  destination,
  websiteMakerBaseUrl = '',
  publicHost = false,
  fetchImpl,
} = {}) {
  const client = requireEligibleClient(salesClientId);
  const dest = sanitizeText(destination) || recommendedCommitDestination(client);
  if (dest === 'client-uploads') return commitToClientUploads(client, fileId);
  if (dest === 'maker') {
    return commitToMaker(client, fileId, { websiteMakerBaseUrl, publicHost, fetchImpl });
  }
  fail(400, 'Ugyldig destinasjon.');
}

export function completeCommit({
  salesClientId,
  fileId,
  destination = 'maker',
  field = '',
  url = '',
} = {}) {
  const client = requireEligibleClient(salesClientId);
  const dest = sanitizeText(destination);
  if (dest !== 'maker') fail(400, 'Bekreftelse gjelder bare Maker-opplasting.');
  const found = requireUncommittedFile(client, fileId);
  const resolvedField = sanitizeText(field)
    || makerUploadFieldForName(found.file.originalName, found.file.mime);
  return markFileCommitted(client, fileId, {
    at: nowIso(),
    destination: 'maker',
    field: resolvedField,
    url: sanitizeText(url),
  });
}

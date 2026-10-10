import { existsSync, readFileSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from '../../data/storage-path.js';

const STORE_PATH = getDataFilePath('inbox-bot.json');
const MAX_PROCESSED = 2000;
const MAX_ITEMS = 400;

function emptyStore() {
  return {
    processed: {},
    sources: {},
    items: [],
  };
}

function readStore() {
  ensurePersistentDataDir();
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return {
      processed: parsed.processed && typeof parsed.processed === 'object' ? parsed.processed : {},
      sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const next = store && typeof store === 'object' ? store : emptyStore();
  const processedEntries = Object.entries(next.processed || {});
  if (processedEntries.length > MAX_PROCESSED) {
    next.processed = Object.fromEntries(processedEntries.slice(processedEntries.length - MAX_PROCESSED));
  }
  if (Array.isArray(next.items) && next.items.length > MAX_ITEMS) {
    next.items = next.items.slice(next.items.length - MAX_ITEMS);
  }
  writeDataJson(STORE_PATH, next);
}

export function processedKey(mailbox = '', messageId = '') {
  return `${String(mailbox || '').trim().toLowerCase()}:${String(messageId || '').trim()}`;
}

export function isProcessed(mailbox, messageId) {
  return Boolean(readStore().processed[processedKey(mailbox, messageId)]);
}

export function markProcessed(mailbox, messageId) {
  const store = readStore();
  store.processed[processedKey(mailbox, messageId)] = new Date().toISOString();
  writeStore(store);
}

export function mailboxSource(mailbox = '') {
  return String(readStore().sources[String(mailbox || '').trim().toLowerCase()] || '');
}

export function setMailboxSource(mailbox = '', source = '') {
  const store = readStore();
  store.sources[String(mailbox || '').trim().toLowerCase()] = String(source || '');
  writeStore(store);
}

export function listInboxItems(filter = {}) {
  const salesClientId = String(filter.salesClientId || '').trim();
  const kind = String(filter.kind || '').trim();
  const status = String(filter.status || '').trim();
  return readStore().items.filter((item) => {
    if (salesClientId && item.salesClientId !== salesClientId) return false;
    if (kind && item.kind !== kind) return false;
    if (status && item.status !== status) return false;
    return true;
  });
}

export function appendInboxItem(item = {}) {
  const store = readStore();
  const row = {
    id: String(item.id || `inbox-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
    kind: String(item.kind || 'other'),
    mailbox: String(item.mailbox || ''),
    messageId: String(item.messageId || ''),
    salesClientId: String(item.salesClientId || ''),
    receivedAt: String(item.receivedAt || new Date().toISOString()),
    summary: String(item.summary || '').slice(0, 400),
    subject: String(item.subject || '').slice(0, 200),
    from: String(item.from || '').slice(0, 200),
    fileName: String(item.fileName || ''),
    filePath: String(item.filePath || ''),
    status: String(item.status || 'unmatched'),
    notified: Boolean(item.notified),
    elements: Array.isArray(item.elements) ? item.elements : [],
    stagedFiles: Array.isArray(item.stagedFiles) ? item.stagedFiles : [],
    signedVerdict: String(item.signedVerdict || ''),
    signedScore: Number(item.signedScore) || 0,
    signedReasons: Array.isArray(item.signedReasons) ? item.signedReasons.map((row) => String(row)).slice(0, 12) : [],
    inboundBytes: Number(item.inboundBytes) || 0,
    originalBytes: Number(item.originalBytes) || 0,
  };
  store.items.push(row);
  writeStore(store);
  return row;
}

export function updateInboxItem(id, patch = {}) {
  const store = readStore();
  const index = store.items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  store.items[index] = { ...store.items[index], ...patch, id: store.items[index].id };
  writeStore(store);
  return store.items[index];
}

export function pendingContractCount() {
  return readStore().items.filter((item) => item.kind === 'signed_contract' && item.salesClientId && item.status === 'pending').length;
}

export function presentInboxForClient(salesClientId = '') {
  const id = String(salesClientId || '').trim();
  const items = id ? listInboxItems({ salesClientId: id }) : [];
  const contracts = items.filter((item) => item.kind === 'signed_contract');
  const staged = items.filter((item) => item.status === 'staged');
  return {
    pendingContracts: contracts.filter((item) => item.status === 'pending').length,
    contracts: contracts.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      receivedAt: item.receivedAt,
      summary: item.summary,
      from: item.from,
      subject: item.subject,
      status: item.status,
      signedVerdict: item.signedVerdict || '',
      signedScore: item.signedScore || 0,
      signedReasons: item.signedReasons || [],
    })),
    stagedElements: staged.length,
    unmatched: items.filter((item) => item.status === 'unmatched').length,
  };
}

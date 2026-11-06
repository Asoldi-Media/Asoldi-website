import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { appendInboxItem, listInboxItems, updateInboxItem } from './store.js';

const SAVED_STATUSES = ['unsigned_copy', 'accepted', 'unmatched', 'already_signed'];

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
}

function sha256Hex(buffer) {
  return buffer && buffer.length ? createHash('sha256').update(buffer).digest('hex') : '';
}

export function inboxContractsRoot() {
  const dir = join(getPersistentDataDir(), 'inbox-contracts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function inboxContractDir(salesClientId = '') {
  const id = safeSegment(salesClientId);
  const dir = join(inboxContractsRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveInboxContractPath(salesClientId = '', fileName = '') {
  const name = String(fileName || '').split(/[/\\]/).pop();
  if (!name || name.includes('..')) return '';
  const full = join(inboxContractDir(salesClientId), name);
  return existsSync(full) ? full : '';
}

/** Stored sha256, or the saved file's hash for items filed before the sha was kept. */
function itemSha(item = {}) {
  if (item.sha256) return String(item.sha256);
  if (!item.salesClientId || !item.fileName) return '';
  const path = resolveInboxContractPath(item.salesClientId, item.fileName);
  if (!path) return '';
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return '';
  }
}

/** The contract item this client already has for the same PDF bytes (same mail in two mailboxes, or sent twice). */
export function findSignedContractBySha(salesClientId = '', sha256 = '') {
  const id = String(salesClientId || '');
  const sha = String(sha256 || '');
  if (!sha) return null;
  return listInboxItems({ kind: 'signed_contract' })
    .find((item) => String(item.salesClientId || '') === id && itemSha(item) === sha) || null;
}

/**
 * File an inbound contract on the card. A file is written (and fileName set) only when there are bytes;
 * the same PDF for the same client returns the earlier item with `duplicate: true` and writes nothing
 * (`dedupe: false` for the preview signer, which has its own once-only guard). `text` keeps the client's
 * fresh words from the mail, so a question next to the PDF is not lost.
 */
export function saveSignedContract({
  salesClientId,
  mailbox,
  messageId,
  from,
  subject,
  text = '',
  summary,
  receivedAt,
  originalName,
  buffer,
  status = 'pending',
  reason = '',
  signedVerdict = '',
  signedScore = 0,
  signedReasons = [],
  inboundBytes = 0,
  originalBytes = 0,
  isAsoldiContract,
  dedupe = true,
} = {}) {
  const sha256 = sha256Hex(buffer);
  const existing = dedupe ? findSignedContractBySha(salesClientId, sha256) : null;
  if (existing) return { ...existing, duplicate: true };
  const base = {
    kind: 'signed_contract',
    mailbox,
    messageId,
    from,
    subject,
    text,
    receivedAt,
    reason,
    signedVerdict,
    signedScore,
    signedReasons,
    inboundBytes,
    originalBytes,
  };
  // appendInboxItem keeps a fixed field list, so the dedupe hash and the Asoldi check ride on a patch.
  const extra = {
    ...(sha256 ? { sha256 } : {}),
    ...(typeof isAsoldiContract === 'boolean' ? { isAsoldiContract } : {}),
  };
  const withExtra = (row) => (Object.keys(extra).length ? updateInboxItem(row.id, extra) || row : row);
  if (!salesClientId) return withExtra(appendInboxItem({ ...base, summary, status: 'unmatched' }));
  const savedStatus = SAVED_STATUSES.includes(status) ? status : 'pending';
  let file = {};
  if (buffer && buffer.length) {
    const fileName = `${safeSegment(messageId)}-${safeSegment(originalName || 'kontrakt.pdf')}`;
    const filePath = join(inboxContractDir(salesClientId), fileName);
    writeFileSync(filePath, buffer);
    file = { fileName, filePath };
  }
  return withExtra(appendInboxItem({
    ...base,
    ...file,
    salesClientId,
    summary: summary || 'Kontrakt mottatt.',
    status: savedStatus,
    notified: savedStatus === 'pending',
  }));
}

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { appendInboxItem } from './store.js';

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
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

export function saveSignedContract({
  salesClientId,
  mailbox,
  messageId,
  from,
  subject,
  summary,
  receivedAt,
  originalName,
  buffer,
  status = 'pending',
  signedVerdict = '',
  signedScore = 0,
  signedReasons = [],
  inboundBytes = 0,
  originalBytes = 0,
} = {}) {
  if (!salesClientId) {
    return appendInboxItem({
      kind: 'signed_contract',
      mailbox,
      messageId,
      from,
      subject,
      summary,
      receivedAt,
      status: 'unmatched',
      signedVerdict,
      signedScore,
      signedReasons,
      inboundBytes,
      originalBytes,
    });
  }
  const fileName = `${safeSegment(messageId)}-${safeSegment(originalName || 'kontrakt.pdf')}`;
  const dest = join(inboxContractDir(salesClientId), fileName);
  if (buffer && buffer.length) writeFileSync(dest, buffer);
  const savedStatus = status === 'unsigned_copy' ? 'unsigned_copy' : 'pending';
  return appendInboxItem({
    kind: 'signed_contract',
    mailbox,
    messageId,
    salesClientId,
    from,
    subject,
    summary: summary || 'Kontrakt mottatt.',
    receivedAt,
    fileName,
    filePath: dest,
    status: savedStatus,
    notified: savedStatus === 'pending',
    signedVerdict,
    signedScore,
    signedReasons,
    inboundBytes,
    originalBytes,
  });
}

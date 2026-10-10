import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as clientPortal from '../../data/client-portal.js';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { persistMediaFiles, ingestSourcesIntoBank } from '../ai-assistant/service.js';
import { applyNoteToBank, interpretLooseNote } from '../ai-assistant/gather.js';
import { isDocumentSource, isMediaAssetSource, partitionAssistantFiles } from '../ai-assistant/source-kind.js';
import { appendInboxItem, listInboxItems, updateInboxItem } from './store.js';
import { normalizeMediaBucket } from './categorize.js';

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
}

export function inboxStagingRoot() {
  const dir = join(getPersistentDataDir(), 'inbox-bot-staging');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function stageFiles(salesClientId, files = []) {
  const dir = join(inboxStagingRoot(), safeSegment(salesClientId || 'unmatched'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const staged = [];
  for (const file of files) {
    const originalName = file.originalName || file.filename || file.name || 'file';
    const fileName = `${Date.now()}-${safeSegment(originalName)}`;
    const dest = join(dir, fileName);
    if (file.buffer?.length) writeFileSync(dest, file.buffer);
    staged.push({
      fileName,
      originalName,
      path: dest,
      bucket: normalizeMediaBucket(file.bucket),
      isLogo: Boolean(file.isLogo),
    });
  }
  return staged;
}

function filesAsAssistant(files = []) {
  return files.map((file) => ({
    originalName: file.originalName || file.filename || file.name || 'file',
    name: file.originalName || file.filename || file.name || 'file',
    buffer: file.buffer,
    mimeType: file.mimeType || file.contentType || '',
  }));
}

function bucketMapFrom(elements = [], files = []) {
  const map = {};
  for (const row of Array.isArray(elements) ? elements : []) {
    if (!row?.fileName) continue;
    map[row.fileName] = {
      bucket: normalizeMediaBucket(row.bucket),
      isLogo: Boolean(row.isLogo) || normalizeMediaBucket(row.bucket) === 'logos',
    };
  }
  for (const file of files) {
    const name = file.originalName || file.filename || file.name;
    if (name && (file.bucket || file.isLogo)) {
      map[name] = {
        bucket: normalizeMediaBucket(file.bucket),
        isLogo: Boolean(file.isLogo),
      };
    }
  }
  return map;
}

async function writeElementsToPortal(portalUserId, { text = '', files = [], elements = [] } = {}) {
  const assistantFiles = filesAsAssistant(files);
  const buckets = bucketMapFrom(elements, files);
  const split = partitionAssistantFiles(assistantFiles);
  if (split.media.length) {
    await persistMediaFiles(portalUserId, split.media, { buckets, text, prefix: 'inbox' });
  }
  const documents = assistantFiles.filter((file) => isDocumentSource(file) && !isMediaAssetSource(file));
  const note = await interpretLooseNote(text, clientPortal.getClientProfileByUserId(portalUserId)?.clientDataBank || {});
  if (note) {
    const current = clientPortal.getClientProfileByUserId(portalUserId);
    const bank = applyNoteToBank(current?.clientDataBank || {}, note);
    clientPortal.setClientDataBank(portalUserId, bank, { businessId: current?.businessId });
    if (note.productText) {
      await ingestSourcesIntoBank(portalUserId, { text: note.productText, files: documents });
    } else if (documents.length) {
      await ingestSourcesIntoBank(portalUserId, { text, files: documents });
    }
  } else if (documents.length) {
    await ingestSourcesIntoBank(portalUserId, { text, files: documents });
  }
}

export async function fileClientElements({
  salesClient,
  mailbox,
  messageId,
  from,
  subject,
  summary,
  receivedAt,
  text = '',
  files = [],
  elements = [],
} = {}) {
  const assistantFiles = filesAsAssistant(files);
  const salesClientId = String(salesClient?.id || '');
  const portalUserId = String(salesClient?.portalUserId || '');

  if (!portalUserId) {
    const stagedFiles = stageFiles(salesClientId || 'unmatched', assistantFiles.map((file, index) => ({
      ...file,
      bucket: elements[index]?.bucket,
      isLogo: elements[index]?.isLogo,
    })));
    return appendInboxItem({
      kind: 'client_elements',
      mailbox,
      messageId,
      salesClientId,
      from,
      subject,
      summary: summary || 'Vedlegg venter på portal-Connect.',
      receivedAt,
      status: salesClientId ? 'staged' : 'unmatched',
      elements,
      stagedFiles,
    });
  }

  await writeElementsToPortal(portalUserId, { text, files: assistantFiles, elements });
  return appendInboxItem({
    kind: 'client_elements',
    mailbox,
    messageId,
    salesClientId,
    from,
    subject,
    summary: summary || 'Vedlegg lagt i kundedata.',
    receivedAt,
    status: 'filed',
    elements,
  });
}

export async function replayStagedElements(salesClient) {
  const portalUserId = String(salesClient?.portalUserId || '');
  const salesClientId = String(salesClient?.id || '');
  if (!portalUserId || !salesClientId) return { replayed: 0 };
  const rows = listInboxItems({ salesClientId, status: 'staged' });
  let replayed = 0;
  for (const row of rows) {
    const files = [];
    for (const entry of row.stagedFiles || []) {
      try {
        files.push({
          originalName: entry.originalName || entry.fileName,
          buffer: readFileSync(entry.path),
          bucket: entry.bucket,
          isLogo: entry.isLogo,
        });
      } catch {
        // skip missing staged bytes
      }
    }
    if (!files.length) continue;
    await writeElementsToPortal(portalUserId, {
      text: row.summary || '',
      files,
      elements: row.elements,
    });
    updateInboxItem(row.id, { status: 'filed' });
    replayed += 1;
  }
  return { replayed };
}

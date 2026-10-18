import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as clientPortal from '../../data/client-portal.js';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { persistMediaFiles, ingestSourcesIntoBank } from '../ai-assistant/service.js';
import { applyNoteToBank, filledFieldKeys, interpretLooseNote } from '../ai-assistant/gather.js';
import { partitionAssistantFiles } from '../ai-assistant/source-kind.js';
import { extractIngestText } from '../ai-assistant/products-ingest.js';
import { expandContainerFiles } from '../ai-assistant/unpack-files.js';
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
  return expandContainerFiles(files.map((file) => ({
    originalName: file.originalName || file.filename || file.name || 'file',
    name: file.originalName || file.filename || file.name || 'file',
    buffer: file.buffer,
    mimeType: file.mimeType || file.contentType || '',
    bucket: file.bucket,
    isLogo: file.isLogo,
  })));
}

// File-name / classifier guesses are `weak`: Gemini's look at the pixels overrides them.
function bucketMapFrom(elements = [], files = []) {
  const map = {};
  for (const row of Array.isArray(elements) ? elements : []) {
    if (!row?.fileName) continue;
    map[row.fileName] = {
      bucket: normalizeMediaBucket(row.bucket),
      isLogo: Boolean(row.isLogo) || normalizeMediaBucket(row.bucket) === 'logos',
      weak: true,
    };
  }
  for (const file of files) {
    const name = file.originalName || file.filename || file.name;
    if (name && (file.bucket || file.isLogo)) {
      map[name] = {
        bucket: normalizeMediaBucket(file.bucket),
        isLogo: Boolean(file.isLogo),
        weak: true,
      };
    }
  }
  return map;
}

// Kundedata field / media bucket → developer-page dot id (lib/client-data-points.js). Domain is not a dot.
const FIELD_DOT = {
  companyAddress: 'address',
  companyPhone: 'phone',
  companyEmail: 'company-email',
  instagramUrl: 'instagram',
  facebookUrl: 'facebook',
  industry: 'industry',
  websiteGoal: 'website-goal',
  town: 'town',
  country: 'country',
  websiteLanguage: 'language',
  toneOfVoice: 'tone',
  businessWhat: 'business-what',
  businessStory: 'business-story',
  differentiator: 'differentiator',
  targetAudience: 'target-audience',
  keyMessage: 'key-message',
  extraContext: 'extra-context',
  wantedPages: 'wanted-pages',
  customSections: 'custom-sections',
  mainCtaText: 'main-cta',
  reviews: 'reviews',
  orgNumber: 'org-number',
  primaryColor: 'color-primary',
  secondaryColor: 'color-secondary',
  accentColor: 'color-accent',
  websiteDomain: 'domain',
};
const BUCKET_DOT = {
  logos: 'logo',
  mainHeroImages: 'hero',
  aboutImages: 'about-images',
  teamImages: 'team-images',
  locationImages: 'location-images',
  icons: 'icons',
  illustrationImages: 'illustrations',
  offeringImages: 'offering-images',
  galleryImages: 'gallery',
  uncategorized: 'uncategorized-media',
};

/** What one email gave us, as developer-page dot ids (plus `domain`). */
export function foundFrom(note, media = [], buckets = {}) {
  const found = new Set();
  for (const key of note ? filledFieldKeys(note) : []) found.add(FIELD_DOT[key] || key);
  if (note?.hoursText) found.add('opening-hours');
  if (note?.people?.some((person) => person.action !== 'remove')) found.add('staff-name');
  if (note?.partners?.some((group) => group.action !== 'remove')) found.add('partner-item');
  if (note?.productText) found.add('product-name');
  for (const file of media) {
    const role = buckets[file.originalName] || {};
    found.add(role.isLogo ? 'logo' : BUCKET_DOT[normalizeMediaBucket(role.bucket)]);
  }
  return [...found];
}

async function documentText(documents = []) {
  const parts = [];
  for (const file of documents) {
    const { text } = await extractIngestText(file).catch(() => ({ text: '' }));
    if (String(text || '').trim()) parts.push(`Vedlegg «${file.originalName}»: ${String(text).slice(0, 6000)}`);
  }
  return parts.join('\n\n');
}

async function readEmail({ text = '', files = [], elements = [], bank = {}, interpret = interpretLooseNote } = {}) {
  const split = partitionAssistantFiles(files);
  const docText = await documentText(split.documents);
  const note = await interpret([text, docText].filter(Boolean).join('\n\n'), bank, { source: 'email' });
  const buckets = bucketMapFrom(elements, files);
  for (const row of note?.mediaFiles || []) {
    if (row.fileName) buckets[row.fileName] = { bucket: row.bucket, isLogo: row.isLogo };
  }
  return { note, split, buckets, found: foundFrom(note, split.media, buckets) };
}

async function writeElementsToPortal(portalUserId, { text = '', files = [], elements = [], interpret, transcribe } = {}) {
  const assistantFiles = filesAsAssistant(files);
  const bank = clientPortal.getClientProfileByUserId(portalUserId)?.clientDataBank || {};
  const { note, split, buckets } = await readEmail({ text, files: assistantFiles, elements, bank, interpret });
  let found = foundFrom(note, split.media, buckets);
  let documents = split.documents;
  if (split.media.length) {
    const saved = await persistMediaFiles(portalUserId, split.media, { buckets, prefix: 'inbox', transcribe });
    const placedBuckets = Object.fromEntries(saved.placed.map((row) => [row.fileName, row]));
    found = foundFrom(note, split.media, placedBuckets);
    if (saved.productFiles.length) {
      documents = [...documents, ...saved.productFiles];
      found.push('product-name');
    }
  }
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
  return [...new Set(found)];
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
  interpret = interpretLooseNote,
  transcribe,
} = {}) {
  const assistantFiles = filesAsAssistant(files);
  const salesClientId = String(salesClient?.id || '');
  const portalUserId = String(salesClient?.portalUserId || '');

  if (!portalUserId) {
    const { note, found } = await readEmail({ text, files: assistantFiles, elements, interpret });
    if (!assistantFiles.length && !note) return null;
    const stagedFiles = stageFiles(salesClientId || 'unmatched', assistantFiles.map((file) => {
      const row = (Array.isArray(elements) ? elements : []).find((entry) => entry?.fileName === file.originalName);
      return { ...file, bucket: row?.bucket ?? file.bucket, isLogo: row?.isLogo ?? file.isLogo };
    }));
    return appendInboxItem({
      kind: 'client_elements',
      mailbox,
      messageId,
      salesClientId,
      from,
      subject,
      summary: summary || 'Vedlegg venter på portal-Connect.',
      text,
      receivedAt,
      status: salesClientId ? 'staged' : 'unmatched',
      elements,
      stagedFiles,
      found,
    });
  }

  const found = await writeElementsToPortal(portalUserId, { text, files: assistantFiles, elements, interpret, transcribe });
  if (!assistantFiles.length && !found.length) return null;
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
    found,
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
    if (!files.length && !row.text) continue;
    const found = await writeElementsToPortal(portalUserId, {
      text: row.text || row.summary || '',
      files,
      elements: row.elements,
    });
    updateInboxItem(row.id, { status: 'filed', found: found.length ? found : row.found });
    replayed += 1;
  }
  return { replayed };
}

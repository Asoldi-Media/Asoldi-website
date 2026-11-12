import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { aiTaskConfigured } from '../llm-hooks.js';
import { pdfLooksLikeAsoldiContract } from './pdf-text.js';
import { parseWorkshopTimeHeuristic } from '../workshop-time-parse.js';
import { isDocumentSource, isMediaAssetSource } from '../ai-assistant/source-kind.js';
import { isContainerFile } from '../ai-assistant/unpack-files.js';
import { KUNDEDATA_MEDIA_BUCKETS } from '../../packages/suite/harness/asoldi/media.js';
import {
  ASOLDI_BUCKET_CUES,
  ASOLDI_CATEGORIZE_PROMPT,
  ASOLDI_EDIT_REQUEST_CUE,
  ASOLDI_INBOX_KINDS,
  ASOLDI_INBOX_SUMMARIES,
} from '../../packages/suite/harness/asoldi/inbox.js';

export const MEDIA_BUCKETS = KUNDEDATA_MEDIA_BUCKETS;

const KINDS = new Set(ASOLDI_INBOX_KINDS);
const BUCKET_CUES = ASOLDI_BUCKET_CUES.map((cue) => ({ ...cue, re: new RegExp(cue.pattern) }));
const EDIT_RE = new RegExp(ASOLDI_EDIT_REQUEST_CUE, 'i');

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function looksLikeClientFile(name = '') {
  const file = { fileName: String(name || '') };
  return isMediaAssetSource(file) || isDocumentSource(file) || isContainerFile(file);
}

function inferBucket(fileName = '', text = '') {
  const name = String(fileName || '').toLowerCase();
  const blob = `${name} ${text}`.toLowerCase();
  const cue = BUCKET_CUES.find((row) => row.re.test(blob));
  return cue ? { bucket: cue.bucket, isLogo: Boolean(cue.isLogo) } : { bucket: 'uncategorized', isLogo: false };
}

export function normalizeInboxKind(kind = '') {
  const value = compact(kind);
  return KINDS.has(value) ? value : 'other';
}

export function normalizeMediaBucket(bucket = '') {
  const value = compact(bucket);
  return MEDIA_BUCKETS.includes(value) ? value : 'uncategorized';
}

export function categorizeEmailHeuristic({
  subject = '',
  text = '',
  attachmentNames = [],
  pdfText = '',
} = {}) {
  const names = Array.isArray(attachmentNames) ? attachmentNames : [];
  const blob = `${subject} ${text}`.slice(0, 4000);
  // Only a PDF counts: an Asoldi-kontrakt .pdf name, or PDF text with our org number / CHAPANA.
  const contractPdf = names.some((name) => pdfLooksLikeAsoldiContract('', name))
    || pdfLooksLikeAsoldiContract(pdfText, '');
  if (contractPdf) {
    return {
      kind: 'signed_contract',
      summary: compact(subject) || ASOLDI_INBOX_SUMMARIES.signed_contract,
      match: {},
      elements: [],
      dueAt: '',
    };
  }

  const hasMedia = names.some(looksLikeClientFile);
  const parsedTime = parseWorkshopTimeHeuristic(blob);
  const dueAt = parsedTime?.dueAt || '';
  const edit = EDIT_RE.test(blob);
  if (edit && !hasMedia) {
    return {
      kind: 'edit_request',
      summary: compact(subject) || ASOLDI_INBOX_SUMMARIES.edit_request,
      match: {},
      elements: [],
      dueAt,
    };
  }

  if (hasMedia) {
    const elements = names.filter(looksLikeClientFile).map((fileName) => {
      const inferred = inferBucket(fileName, blob);
      return { fileName, bucket: inferred.bucket, isLogo: inferred.isLogo };
    });
    return {
      kind: 'client_elements',
      summary: compact(subject) || ASOLDI_INBOX_SUMMARIES.client_elements,
      match: {},
      elements,
      dueAt,
    };
  }

  if (dueAt) {
    return {
      kind: 'workshop_time',
      summary: compact(subject) || ASOLDI_INBOX_SUMMARIES.workshop_time,
      match: {},
      elements: [],
      dueAt,
    };
  }

  return {
    kind: 'other',
    summary: compact(subject) || ASOLDI_INBOX_SUMMARIES.other,
    match: {},
    elements: [],
    dueAt: '',
  };
}

/**
 * AI answer on top of the heuristic. signed_contract follows the heuristic both ways: a contract PDF
 * stays signed_contract, and an AI signed_contract without one falls back to the heuristic kind.
 */
export function mergeCategorize(base, parsed = {}) {
  const next = {
    kind: normalizeInboxKind(parsed.kind || base.kind),
    summary: compact(parsed.summary || base.summary).slice(0, 400),
    match: {
      orgNumber: compact(parsed.match?.orgNumber || ''),
      businessName: compact(parsed.match?.businessName || ''),
      email: compact(parsed.match?.email || ''),
    },
    elements: Array.isArray(parsed.elements) && parsed.elements.length
      ? parsed.elements.map((row) => ({
        fileName: compact(row?.fileName),
        bucket: normalizeMediaBucket(row?.bucket),
        isLogo: Boolean(row?.isLogo) || normalizeMediaBucket(row?.bucket) === 'logos',
      })).filter((row) => row.fileName)
      : base.elements,
    dueAt: compact(parsed.dueAt || base.dueAt),
  };
  if (base.kind === 'signed_contract') next.kind = 'signed_contract';
  else if (next.kind === 'signed_contract') next.kind = base.kind;
  return next;
}

/** `input.salesClientId` (the sender's client, when known) is only for the ledger row; it is not sent to the model. */
export async function categorizeEmail(input = {}) {
  const heuristic = categorizeEmailHeuristic(input);
  if (!aiTaskConfigured('inbox.categorize', isDeepseekConfigured)) return heuristic;
  const salesClientId = compact(input.salesClientId);
  try {
    const parsed = await deepseekChatJson({
      task: 'inbox.categorize',
      ctx: salesClientId ? { salesClientId } : undefined,
      temperature: 0.1,
      maxTokens: 700,
      system: ASOLDI_CATEGORIZE_PROMPT,
      user: JSON.stringify({
        from: input.from || '',
        to: input.to || '',
        subject: input.subject || '',
        text: compact(input.text).slice(0, 3500),
        attachmentNames: input.attachmentNames || [],
        pdfText: compact(input.pdfText).slice(0, 4000),
        heuristic,
      }),
    });
    return mergeCategorize(heuristic, parsed);
  } catch {
    return heuristic;
  }
}

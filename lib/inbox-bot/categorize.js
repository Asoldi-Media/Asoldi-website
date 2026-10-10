import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { pdfLooksLikeAsoldiContract } from './pdf-text.js';

export const MEDIA_BUCKETS = [
  'mainHeroImages',
  'aboutImages',
  'teamImages',
  'locationImages',
  'logos',
  'icons',
  'illustrationImages',
  'offeringImages',
  'galleryImages',
  'uncategorized',
];

const KINDS = new Set(['signed_contract', 'client_elements', 'edit_request', 'other']);

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function looksLikeImageName(name = '') {
  return /\.(png|jpe?g|webp|gif|svg|avif|heic)$/i.test(String(name || ''));
}

function looksLikeDocName(name = '') {
  return /\.(pdf|xlsx|xls|csv|docx|txt|md)$/i.test(String(name || ''));
}

function inferBucket(fileName = '', text = '') {
  const name = String(fileName || '').toLowerCase();
  const blob = `${name} ${text}`.toLowerCase();
  if (/logo|favicon|merke/.test(blob)) return { bucket: 'logos', isLogo: true };
  if (/hero|hovedbilde|banner|cover/.test(blob)) return { bucket: 'mainHeroImages', isLogo: false };
  if (/ansatt|team|staff|portrait/.test(blob)) return { bucket: 'teamImages', isLogo: false };
  if (/lokasjon|location|map|butikk|fasade/.test(blob)) return { bucket: 'locationImages', isLogo: false };
  if (/om.?oss|about/.test(blob)) return { bucket: 'aboutImages', isLogo: false };
  if (/meny|menu|rett|tjeneste|offering/.test(blob)) return { bucket: 'offeringImages', isLogo: false };
  if (/ikon|icon/.test(blob)) return { bucket: 'icons', isLogo: false };
  if (/illustr/.test(blob)) return { bucket: 'illustrationImages', isLogo: false };
  if (/galleri|gallery/.test(blob)) return { bucket: 'galleryImages', isLogo: false };
  return { bucket: 'uncategorized', isLogo: false };
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
  const contractPdf = names.some((name) => pdfLooksLikeAsoldiContract(pdfText, name))
    || pdfLooksLikeAsoldiContract(pdfText, '');
  if (contractPdf) {
    return {
      kind: 'signed_contract',
      summary: compact(subject) || 'Kontrakt mottatt som PDF.',
      match: {},
      elements: [],
    };
  }

  const hasMedia = names.some((name) => looksLikeImageName(name) || looksLikeDocName(name));
  const edit = /rediger|endre (?:nettsiden|siden|teksten)|fiks|fix the (?:site|page)|change the website/i.test(blob);
  if (edit && !hasMedia) {
    return {
      kind: 'edit_request',
      summary: compact(subject) || 'Redigeringsforespørsel.',
      match: {},
      elements: [],
    };
  }

  if (hasMedia) {
    const elements = names.filter((name) => looksLikeImageName(name) || looksLikeDocName(name)).map((fileName) => {
      const inferred = inferBucket(fileName, blob);
      return { fileName, bucket: inferred.bucket, isLogo: inferred.isLogo };
    });
    return {
      kind: 'client_elements',
      summary: compact(subject) || 'Vedlegg til kundedata.',
      match: {},
      elements,
    };
  }

  return {
    kind: 'other',
    summary: compact(subject) || 'E-post uten kjent type.',
    match: {},
    elements: [],
  };
}

function mergeCategorize(base, parsed = {}) {
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
  };
  if (base.kind === 'signed_contract') next.kind = 'signed_contract';
  return next;
}

export async function categorizeEmail(input = {}) {
  const heuristic = categorizeEmailHeuristic(input);
  if (!isDeepseekConfigured()) return heuristic;
  try {
    const parsed = await deepseekChatJson({
      temperature: 0.1,
      maxTokens: 700,
      system: `Du kategoriserer innkommende e-post til Asoldi. Finn ikke på fakta.
Svar JSON:
{
  "kind": "signed_contract"|"client_elements"|"edit_request"|"other",
  "summary": "én kort setning på norsk",
  "match": { "orgNumber": "", "businessName": "", "email": "" },
  "elements": [{ "fileName": "", "bucket": "logos"|"mainHeroImages"|"aboutImages"|"teamImages"|"locationImages"|"icons"|"illustrationImages"|"offeringImages"|"galleryImages"|"uncategorized", "isLogo": false }]
}
signed_contract = PDF that is our Asoldi service agreement (filename Asoldi-kontrakt, org 934327497, CHAPANA). Whether the client signed the bottom is decided later by size/vision — still kind signed_contract. client_elements = logo, bilder, meny, produkter eller annen nettside-data. edit_request = de ber om å endre nettsiden uten slike vedlegg. other = resten.
bucket kun når kind er client_elements. match fylles fra e-posten eller PDF-teksten.`,
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

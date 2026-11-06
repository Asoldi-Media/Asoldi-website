import { createHash } from 'node:crypto';
import { listOffers } from '../../data/offers.js';
import { pdfLooksLikeAsoldiContract } from './pdf-text.js';
import { listInboxItems } from './store.js';
import { aiKeyOrBlank } from '../safe-mode-ai.js';
import { aiTaskConfigured, runLlmTask } from '../llm-hooks.js';
import { geminiGenerateRaw } from '../llm/providers/gemini.js';

export const TINY_PDF_BYTES = 1000;
const VISION_MS = 12000;
const SIGNED_PAGE_PROMPT = `This is the LAST PAGE of an Asoldi service agreement.
LEFT column is "For CHAPANA (Asoldi Marketing)" and already has a printed signature stamp. Ignore the left column.
RIGHT column is "For Client". Decide if the CLIENT has signed at the bottom:
- handwriting, ink, a drawn name, a signature image, a tick in a name, or a filled date under the right signature line
- vs a blank signature line and "Date: ____________"
Return JSON only: {"clientSigned":true|false,"clientDateFilled":true|false,"confidence":0-1,"notes":""}`;

/** Downloaded unsigned PDF mailed back still counts when From is the client. */
export function inboundContractAcceptedByEmail({ inspection = {}, matched = {} } = {}) {
  if (matched?.via !== 'email' || !matched.client) return false;
  if (!inspection?.isAsoldiContract) return false;
  return (Number(inspection.inboundBytes) || 0) >= TINY_PDF_BYTES;
}

function latin1(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('latin1') : Buffer.from(buffer || []).toString('latin1');
}

export function countPdfImageXObjects(buffer) {
  return (latin1(buffer).match(/\/Subtype\s*\/Image\b/g) || []).length;
}

export function countPdfEof(buffer) {
  return (latin1(buffer).match(/%%EOF/g) || []).length;
}

export function guessPdfPageCount(buffer) {
  const text = latin1(buffer);
  const counted = text.match(/\/Type\s*\/Pages\b[^>]*\/Count\s+(\d+)/);
  if (counted) return Number(counted[1]) || 0;
  return (text.match(/\/Type\s*\/Page\b/g) || []).length;
}

export function fingerprintPdfBuffer(buffer, fileName = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return {
    byteLength: bytes.length,
    pageCount: guessPdfPageCount(bytes),
    imageCount: countPdfImageXObjects(bytes),
    eofCount: countPdfEof(bytes),
    sha256: bytes.length ? createHash('sha256').update(bytes).digest('hex') : '',
    fileName: String(fileName || ''),
    source: 'buffer',
  };
}

export function clientDateSignals(text = '') {
  const raw = String(text || '');
  const blanks = (raw.match(/\b(?:Date|Dato):\s*_{4,}/gi) || []).length;
  const filled = (raw.match(/\b(?:Date|Dato):\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/gi) || []).length;
  const clientBlock = /\bfor kunden\b|\bfor client\b/i.test(raw);
  return {
    blankClientDate: blanks >= 1,
    clientDateFilled: clientBlock && blanks === 0 && filled >= 2,
  };
}

export function emailLooksSigned(text = '') {
  const raw = String(text || '');
  if (/\bsigned up\b/i.test(raw)) return false;
  if (/\b(?:usignert|unsigned)\b/i.test(raw)) return false;
  if (/\b(?:ikke|not|n['’]t|not yet|haven't|hasn't|have not)\b[^.!?\n]{0,40}\b(?:signert|signed|underskrevet|signeres)/i.test(raw)) return false;
  const parts = raw.split(/(?<=[.!?])\s+|\n+/);
  const claims = parts.filter((part) => (
    /vedlagt (?:den )?signerte|signert kontrakt|signerte avtalen|jeg har signert|kontrakten er underskrevet|(?:jeg har )?skrevet under|signed contract|underskrevet|\bsignert\b/i.test(part)
  ));
  if (!claims.length) return false;
  return claims.some((part) => {
    const line = part.trim();
    if (/\?\s*$/.test(line) || /^(?:har dere|have you|skal den)\b/i.test(line)) return false;
    return true;
  });
}

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Score whether an inbound Asoldi PDF is the unsigned original bounced back,
 * or a copy the client actually signed at the bottom.
 *
 * `likely` → notify Admin "Kontrakt mottatt"
 * `possible` → still notify, labelled as needs a look
 * `unsigned` → save on the card, do not alarm
 */
export function scoreContractSigning(input = {}) {
  const inboundBytes = Number(input.inboundBytes) || 0;
  const originalBytes = Number(input.originalBytes) || 0;
  const inboundPages = Number(input.inboundPages) || 0;
  const originalPages = Number(input.originalPages) || 0;
  const eofCount = Number(input.eofCount) || 0;
  const imageCount = Number(input.imageCount) || 0;
  const originalImageCount = Number(input.originalImageCount) || 0;
  const blankClientDate = Boolean(input.blankClientDate);
  const clientDateFilled = Boolean(input.clientDateFilled);
  const emailSaysSigned = Boolean(input.emailSaysSigned);
  const originalSource = String(input.originalSource || '');
  const shaMatch = Boolean(input.shaMatch);
  const vision = input.vision && typeof input.vision === 'object' ? input.vision : null;

  const reasons = [];
  let score = 0;

  if (shaMatch) {
    return { score: -8, verdict: 'unsigned', reasons: ['identical-to-sent'] };
  }
  if (inboundBytes && inboundBytes < TINY_PDF_BYTES) {
    score -= 3;
    reasons.push('tiny-file');
  }
  if (originalBytes > 0 && inboundBytes > 0) {
    const ratio = inboundBytes / originalBytes;
    if (ratio >= 1.2) {
      score += 3;
      reasons.push('much-larger-than-sent');
    } else if (ratio >= 1.08) {
      score += 2;
      reasons.push('larger-than-sent');
    } else if (ratio >= 1.03) {
      score += 1;
      reasons.push('slightly-larger-than-sent');
    } else if (Math.abs(ratio - 1) <= 0.02) {
      score -= originalSource === 'rebuilt' ? 1 : 2;
      reasons.push('same-size-as-sent');
    }
  }
  if (originalPages > 0 && inboundPages > originalPages) {
    score += 3;
    reasons.push('extra-pages');
  }
  if (eofCount >= 2) {
    score += 2;
    reasons.push('incremental-pdf');
  }
  if (originalImageCount > 0 && imageCount > originalImageCount) {
    score += 2;
    reasons.push('extra-images');
  } else if (!originalImageCount && imageCount >= 4) {
    score += 2;
    reasons.push('many-images');
  }
  if (clientDateFilled) {
    score += 2;
    reasons.push('client-date-filled');
  }
  if (blankClientDate) {
    score -= 1;
    reasons.push('client-date-blank');
  }
  if (emailSaysSigned) {
    score += 1;
    reasons.push('email-says-signed');
  }
  if (input.rightBottomExtra) {
    score += 2;
    reasons.push('right-bottom-writing');
  }
  if (input.rightDateFilled && !clientDateFilled) {
    score += 2;
    reasons.push('right-bottom-date');
  }

  const visionConfidence = Number(vision?.confidence);
  const visionSure = Number.isFinite(visionConfidence) ? visionConfidence >= 0.5 : true;
  if (vision && visionSure && vision.clientSigned === true) {
    score += 3;
    reasons.push('vision-signed-bottom');
  } else if (vision && visionSure && vision.clientSigned === false) {
    score -= 2;
    reasons.push('vision-blank-bottom');
  }
  if (vision && visionSure && vision.clientDateFilled === true && !clientDateFilled) {
    score += 1;
    reasons.push('vision-date-filled');
  }

  let verdict = 'unsigned';
  if (score >= 3) verdict = 'likely';
  else if (score >= 1) verdict = 'possible';
  return { score, verdict, reasons };
}

function parseJsonObject(text = '') {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isPrintedLabel(text = '') {
  return /^(for (?:kunden|client|chapana)\b|signatur(?:e)?\b|dato:\s*_{2,}|date:\s*_{2,}|_{4,}|date:\s*$|dato:\s*$|signering av avtale)/i.test(String(text || '').trim());
}

function templateItems(opts = {}) {
  if (Array.isArray(opts.template)) return opts.template;
  if (Array.isArray(opts.items)) return opts.items;
  return [];
}

function nearTemplate(item, template) {
  const str = String(item.str || '').trim();
  return template.some((row) => (
    String(row.str || '').trim() === str
    && Math.abs((Number(row.x) || 0) - (Number(item.x) || 0)) <= 2
    && Math.abs((Number(row.y) || 0) - (Number(item.y) || 0)) <= 2
  ));
}

function isWrapFragment(text = '') {
  const raw = String(text || '').trim();
  if (/\)\s*:?\s*$/.test(raw)) return true;
  const words = raw.split(/\s+/).filter(Boolean);
  return words.length >= 6 || (words.length >= 4 && raw.length > 36);
}

function inLabelWrap(item, labels) {
  return labels.some((label) => {
    if (Math.abs(item.x - label.x) > 8) return false;
    const lines = Math.max(2, Math.ceil(String(label.str || '').length / 28));
    const wrapBottom = label.y - lines * 16;
    return item.y <= label.y + 2 && item.y >= wrapBottom - 8;
  });
}

/** Last page text items with pdf.js coordinates (origin bottom-left). */
export async function lastPageItems(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await withTimeout(pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise, 8000, 'pdfjs-timeout');
  try {
    const page = await doc.getPage(doc.numPages);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = [];
    for (const item of content.items || []) {
      const str = String(item.str || '');
      if (!str.trim()) continue;
      items.push({
        str,
        x: Number(item.transform?.[4]) || 0,
        y: Number(item.transform?.[5]) || 0,
      });
    }
    return { items, width: viewport.width, height: viewport.height, pageCount: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

/** Writing in the client signature column, ignoring printed labels and wrapped name lines. */
export function signatureAreaCues(items = [], opts = {}) {
  const nonempty = (Array.isArray(items) ? items : [])
    .map((row) => ({ str: String(row.str || ''), x: Number(row.x) || 0, y: Number(row.y) || 0 }))
    .filter((row) => row.str.trim());
  if (!nonempty.length) return { extraCount: 0, extraText: '', rightDateFilled: false, clientBlock: null };

  const clientLabel = nonempty.find((row) => /^for kunden\b|^for client\b/i.test(row.str.trim()));
  if (!clientLabel) return { extraCount: 0, extraText: '', rightDateFilled: false, clientBlock: false };

  const signLabel = nonempty.find((row) => /^signatur(?:e)?\b/i.test(row.str.trim()));
  const template = templateItems(opts);
  const extras = [];
  let rightDateFilled = false;
  const wrapLabels = [clientLabel, signLabel].filter(Boolean);
  const belowY = (signLabel?.y ?? clientLabel.y) - 2;

  for (const item of nonempty) {
    const text = item.str.trim();
    if (item.x < clientLabel.x - 4) continue;
    if (item.y > belowY) continue;
    if (template.length && nearTemplate(item, template)) continue;
    if (/^(dato|date):\s*\d{1,2}[./-]/i.test(text)) {
      rightDateFilled = true;
      continue;
    }
    if (isPrintedLabel(text)) continue;
    if (inLabelWrap(item, wrapLabels) || isWrapFragment(text)) continue;
    extras.push(text);
  }
  return {
    extraCount: extras.length,
    extraText: extras.join(' ').slice(0, 120),
    rightDateFilled,
    clientBlock: true,
  };
}

const SIGNATURE_REASONS = new Set([
  'right-bottom-writing',
  'client-date-filled',
  'right-bottom-date',
  'vision-signed-bottom',
  'vision-date-filled',
]);

export function hasSignatureSignal(inspection = {}) {
  const reasons = Array.isArray(inspection.reasons) ? inspection.reasons : [];
  if (reasons.includes('vision-blank-bottom')) return false;
  return reasons.some((reason) => SIGNATURE_REASONS.has(reason));
}

export function hasPreviewAcceptedContract(clientId = '') {
  const id = String(clientId || '').trim();
  if (!id) return false;
  return listInboxItems({ salesClientId: id, kind: 'signed_contract' }).some((item) => (
    item.signedVerdict === 'preview_accept' || String(item.messageId || '').startsWith(`preview-${id}`)
  ));
}

export function contractAlreadySigned(client = {}) {
  if (client?.progression?.contractSigned) return true;
  const id = String(client?.id || '').trim();
  if (!id) return false;
  return listOffers().some((offer) => offer.salesClientId === id && offer.acceptance?.acceptedAt);
}

export function awaitingSignature(client = {}) {
  if (contractAlreadySigned(client)) return false;
  if (client?.progression?.offerSent) return true;
  return Boolean(client?.contractSentAt);
}

function decideFail(reason, status = 'pending') {
  return { status, markSold: false, reason };
}

export function decideInboundContract({ client, matched = {}, inspection = {} } = {}) {
  if (!client?.id) return decideFail('unmatched', 'unmatched');
  if (contractAlreadySigned(client)) return decideFail('already_signed', 'already_signed');
  if (!(Number(inspection.inboundBytes) || 0)) return decideFail('no-pdf');
  if (!inspection.isAsoldiContract) return decideFail('not-asoldi-contract');
  if (inspection.clientBlock === false) return decideFail('no-signature-block');
  if (inspection.shaMatch || inspection.verdict === 'unsigned') return decideFail('unsigned_copy', 'unsigned_copy');
  if (!awaitingSignature(client)) return decideFail('not-awaiting-signature');
  if (matched.via !== 'email') return decideFail('not-client-address');
  if (inspection.verdict === 'possible') return decideFail('possible');
  if (!hasSignatureSignal(inspection)) return decideFail('no-signature-signal');
  return { status: 'accepted', markSold: true, reason: 'signed' };
}

async function screenshotLastPage(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const shot = await parser.getScreenshot({
      last: 1,
      scale: 1.2,
      desiredWidth: 900,
      imageBuffer: true,
      imageDataUrl: true,
    });
    const page = Array.isArray(shot?.pages) ? shot.pages[shot.pages.length - 1] : null;
    if (!page) return null;
    const bytes = page.data ? Buffer.from(page.data) : null;
    const dataUrl = String(page.dataUrl || '');
    if (!bytes?.length && !dataUrl) return null;
    return { bytes, dataUrl, mimeType: 'image/png' };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** `meta.salesClientId` is the contract's sales client, for the ledger row (it is not sent to the model). */
export async function askVisionIfSigned(screenshot, meta = {}) {
  if (!screenshot) return null;
  const salesClientId = String(meta?.salesClientId || '').trim();
  // Task inbox.inspect-contract: the legacy profile sends today's Gemini request; other profiles route
  // the screenshot through the hub LLM facade (the data policy decides the provider).
  if (!aiTaskConfigured('inbox.inspect-contract', () => String(process.env.GEMINI_API_KEY || '').trim())) return null;
  const dataUrl = screenshot.dataUrl || '';
  const base64 = dataUrl.includes(',')
    ? dataUrl.slice(dataUrl.indexOf(',') + 1)
    : (screenshot.bytes ? Buffer.from(screenshot.bytes).toString('base64') : '');
  if (!base64) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const result = await withTimeout(runLlmTask('json', {
    task: 'inbox.inspect-contract',
    ...(salesClientId ? { ctx: { salesClientId } } : {}),
    user: SIGNED_PAGE_PROMPT,
    images: [{ mime: screenshot.mimeType || 'image/png', base64 }],
    legacy: {
      provider: 'gemini',
      model,
      images: 1,
      run: async () => {
        // Hub safe mode: no Gemini call unless aiCalls is allowed (the intent is recorded).
        const apiKey = String(aiKeyOrBlank('gemini', process.env.GEMINI_API_KEY, 'inspect-contract') || '').trim();
        if (!apiKey) return { data: null, guarded: true };
        const raw = await geminiGenerateRaw({
          apiKey,
          request: {
            model,
            contents: [{
              role: 'user',
              parts: [
                { text: SIGNED_PAGE_PROMPT },
                { inlineData: { mimeType: screenshot.mimeType || 'image/png', data: base64 } },
              ],
            }],
          },
        });
        return { text: raw.text, data: parseJsonObject(raw.text), usage: raw.usage, servedModel: raw.servedModel };
      },
    },
  }), VISION_MS, 'vision-timeout');
  const parsed = result?.data && typeof result.data === 'object' ? result.data : null;
  if (!parsed) return null;
  return {
    clientSigned: parsed.clientSigned === true,
    clientDateFilled: parsed.clientDateFilled === true,
    confidence: Number(parsed.confidence),
    notes: String(parsed.notes || '').slice(0, 240),
  };
}

async function enrichPageCount(buffer, fallback) {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      return { pages: Number(info?.total) || fallback, parsed: Boolean(info?.total) };
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return { pages: fallback, parsed: false };
  }
}

async function rebuildOriginalFingerprint(client = {}) {
  if (!client?.id) return null;
  try {
    const { getOfferForClient } = await import('../../data/sales-offers.js');
    const { buildContractPdf, contractInputsForOffer, offerContractIsAvailable } = await import('../offer-contract-pdf.js');
    const { clientWithOfferParty } = await import('../offer-readiness.js');
    const offer = getOfferForClient(client.id);
    if (!offer || !offerContractIsAvailable(offer)) return null;
    const dateRaw = client.contractSentAt || offer.sentAt;
    const date = dateRaw ? new Date(dateRaw) : new Date();
    const view = clientWithOfferParty(client, offer, {});
    const buffer = await buildContractPdf({
      client: view,
      ...contractInputsForOffer(offer, client),
      date: Number.isNaN(date.getTime()) ? new Date() : date,
    });
    return { ...fingerprintPdfBuffer(buffer), source: 'rebuilt' };
  } catch {
    return null;
  }
}

function storedOriginal(original = {}) {
  const byteLength = Number(original?.byteLength) || 0;
  const sha256 = String(original?.sha256 || '');
  if (!byteLength && !sha256) return null;
  return {
    byteLength,
    pageCount: Number(original.pageCount) || 0,
    imageCount: Number(original.imageCount) || 0,
    eofCount: Number(original.eofCount) || 0,
    sha256,
    fileName: String(original.fileName || ''),
    source: String(original.source || 'sent'),
  };
}

export async function inspectInboundContract({
  buffer,
  fileName = '',
  pdfText = '',
  emailText = '',
  original = null,
  client = null,
  vision = true,
} = {}) {
  const inbound = fingerprintPdfBuffer(buffer || Buffer.alloc(0), fileName);
  const parsed = buffer?.length
    ? await enrichPageCount(buffer, inbound.pageCount)
    : { pages: inbound.pageCount, parsed: false };
  inbound.pageCount = parsed.pages;
  const emailSaysSigned = emailLooksSigned(emailText);
  let baseline = storedOriginal(original);
  if (!baseline && client) baseline = await rebuildOriginalFingerprint(client);

  const shaMatch = Boolean(baseline?.sha256 && inbound.sha256 && baseline.sha256 === inbound.sha256);
  let layoutCues = null;
  let pageText = '';
  if (buffer?.length && !shaMatch) {
    try {
      const page = await lastPageItems(buffer);
      pageText = (page.items || []).map((row) => row.str).join(' ');
      layoutCues = signatureAreaCues(page.items);
    } catch {
      layoutCues = null;
    }
  }
  const asoldi = pdfLooksLikeAsoldiContract(pdfText || pageText, fileName);
  if (!asoldi) layoutCues = layoutCues?.clientBlock ? layoutCues : null;
  const dates = clientDateSignals(`${pdfText} ${pageText}`);
  if (layoutCues?.rightDateFilled) dates.clientDateFilled = true;
  let visionResult = null;
  if (vision && asoldi && parsed.parsed && buffer?.length >= TINY_PDF_BYTES && !shaMatch) {
    try {
      const shot = await withTimeout(screenshotLastPage(buffer), VISION_MS, 'screenshot-timeout');
      visionResult = await askVisionIfSigned(shot, { salesClientId: client?.id });
    } catch {
      visionResult = null;
    }
  }

  const scored = scoreContractSigning({
    inboundBytes: inbound.byteLength,
    originalBytes: baseline?.byteLength || 0,
    inboundPages: inbound.pageCount,
    originalPages: baseline?.pageCount || 0,
    eofCount: inbound.eofCount,
    imageCount: inbound.imageCount,
    originalImageCount: baseline?.imageCount || 0,
    blankClientDate: dates.blankClientDate,
    clientDateFilled: dates.clientDateFilled,
    emailSaysSigned,
    originalSource: baseline?.source || '',
    shaMatch,
    rightBottomExtra: Boolean(layoutCues?.extraCount),
    rightDateFilled: Boolean(layoutCues?.rightDateFilled),
    vision: visionResult,
  });

  const status = scored.verdict === 'unsigned' ? 'unsigned_copy' : 'pending';
  const summaryBits = {
    likely: 'Signert kontrakt (sjekket bunnen).',
    possible: 'Mulig signert kontrakt — sjekk bunnen av PDF.',
    unsigned: 'Usignert kopi av sendt kontrakt.',
  };
  const reasons = [...scored.reasons];
  if (layoutCues?.clientBlock === false) reasons.push('no-client-block');

  return {
    isAsoldiContract: asoldi,
    verdict: scored.verdict,
    status,
    score: scored.score,
    reasons,
    summary: summaryBits[scored.verdict] || summaryBits.unsigned,
    inboundBytes: inbound.byteLength,
    originalBytes: baseline?.byteLength || 0,
    inboundPages: inbound.pageCount,
    originalPages: baseline?.pageCount || 0,
    imageCount: inbound.imageCount,
    shaMatch,
    clientBlock: layoutCues ? layoutCues.clientBlock : null,
    vision: visionResult,
  };
}

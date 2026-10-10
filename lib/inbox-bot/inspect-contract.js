import { createHash } from 'node:crypto';
import { pdfLooksLikeAsoldiContract } from './pdf-text.js';

const TINY_PDF_BYTES = 1000;
const VISION_MS = 12000;

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
  const blanks = (raw.match(/Date:\s*_{4,}/gi) || []).length;
  const filled = (raw.match(/Date:\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/gi) || []).length;
  return {
    blankClientDate: blanks >= 1,
    clientDateFilled: blanks === 0 && filled >= 2,
  };
}

export function emailLooksSigned(text = '') {
  return /signert|underskrevet|signed(?:\s+(?:the\s+)?(?:contract|agreement))?|vedlagt (?:den )?signerte/i.test(String(text || ''));
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

function isTemplateSignatureLabel(text = '') {
  return /^(for client\b.*|signature\b.*|date:\s*_{4,}|_{4,}|date:)$/i.test(String(text || '').trim());
}

async function lastPageTextCues(buffer) {
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
    const midX = viewport.width / 2;
    const bottomBand = viewport.height * 0.42;
    const extras = [];
    let rightDateFilled = false;
    for (const item of content.items || []) {
      const text = String(item.str || '').trim();
      if (!text) continue;
      const x = Number(item.transform?.[4]) || 0;
      const y = Number(item.transform?.[5]) || 0;
      if (x < midX || y > bottomBand) continue;
      if (/^date:\s*\d{1,2}[./-]/i.test(text)) rightDateFilled = true;
      if (isTemplateSignatureLabel(text)) continue;
      extras.push(text);
    }
    return {
      extraCount: extras.length,
      extraText: extras.join(' ').slice(0, 120),
      rightDateFilled,
    };
  } finally {
    await doc.destroy();
  }
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

async function askVisionIfSigned(screenshot) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || !screenshot) return null;
  const dataUrl = screenshot.dataUrl || '';
  const base64 = dataUrl.includes(',')
    ? dataUrl.slice(dataUrl.indexOf(',') + 1)
    : (screenshot.bytes ? Buffer.from(screenshot.bytes).toString('base64') : '');
  if (!base64) return null;
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const response = await withTimeout(ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        {
          text: `This is the LAST PAGE of an Asoldi service agreement.
LEFT column is "For CHAPANA (Asoldi Marketing)" and already has a printed signature stamp. Ignore the left column.
RIGHT column is "For Client". Decide if the CLIENT has signed at the bottom:
- handwriting, ink, a drawn name, a signature image, a tick in a name, or a filled date under the right signature line
- vs a blank signature line and "Date: ____________"
Return JSON only: {"clientSigned":true|false,"clientDateFilled":true|false,"confidence":0-1,"notes":""}`,
        },
        { inlineData: { mimeType: screenshot.mimeType || 'image/png', data: base64 } },
      ],
    }],
  }), VISION_MS, 'vision-timeout');
  const text = response?.text
    || response?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n')
    || '';
  const parsed = parseJsonObject(text);
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
      ...contractInputsForOffer(offer),
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
  const asoldi = pdfLooksLikeAsoldiContract(pdfText, fileName);
  const inbound = fingerprintPdfBuffer(buffer || Buffer.alloc(0), fileName);
  const parsed = buffer?.length
    ? await enrichPageCount(buffer, inbound.pageCount)
    : { pages: inbound.pageCount, parsed: false };
  inbound.pageCount = parsed.pages;
  const dates = clientDateSignals(pdfText);
  const emailSaysSigned = emailLooksSigned(emailText);
  let baseline = storedOriginal(original);
  if (!baseline && client) baseline = await rebuildOriginalFingerprint(client);

  const shaMatch = Boolean(baseline?.sha256 && inbound.sha256 && baseline.sha256 === inbound.sha256);
  let layoutCues = null;
  if (asoldi && parsed.parsed && buffer?.length >= TINY_PDF_BYTES && !shaMatch) {
    try {
      layoutCues = await lastPageTextCues(buffer);
    } catch {
      layoutCues = null;
    }
  }
  let visionResult = null;
  if (vision && asoldi && parsed.parsed && buffer?.length >= TINY_PDF_BYTES && !shaMatch) {
    try {
      const shot = await withTimeout(screenshotLastPage(buffer), VISION_MS, 'screenshot-timeout');
      visionResult = await askVisionIfSigned(shot);
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

  return {
    isAsoldiContract: asoldi,
    verdict: scored.verdict,
    status,
    score: scored.score,
    reasons: scored.reasons,
    summary: summaryBits[scored.verdict] || summaryBits.unsigned,
    inboundBytes: inbound.byteLength,
    originalBytes: baseline?.byteLength || 0,
    inboundPages: inbound.pageCount,
    originalPages: baseline?.pageCount || 0,
    imageCount: inbound.imageCount,
    shaMatch,
    vision: visionResult,
  };
}

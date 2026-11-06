const ASOLDI_ORG_RE = /(?<!\d)9\s*3\s*4\s*3\s*2\s*7\s*4\s*9\s*7(?!\d)/;
const PDF_NAME_RE = /\.pdf$/i;
const CONTRACT_NAME_RE = /asoldi.?kontrakt/i;

export function compactPdfText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export async function extractPdfText(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 5).toString('ascii') : '';
  if (head && !head.startsWith('%PDF')) return '';
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return compactPdfText(parsed?.text || '').slice(0, 12000);
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return '';
  }
}

/** True for a .pdf name, a pdf mime type or a buffer that starts with %PDF. */
export function isPdfAttachment({ fileName = '', mimeType = '', buffer = null } = {}) {
  if (PDF_NAME_RE.test(String(fileName || '').trim())) return true;
  if (String(mimeType || '').toLowerCase().includes('pdf')) return true;
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 4).toString('ascii') === '%PDF';
}

/** Org number 934327497 as its own token; spaces inside it are fine, digits glued on either side are not. */
export function textHasAsoldiOrgNumber(text = '') {
  return ASOLDI_ORG_RE.test(String(text || ''));
}

/**
 * Our own service agreement: a PDF named Asoldi-kontrakt, or PDF text with the org number or CHAPANA.
 * `text` is extracted PDF text (only a real PDF yields any). A non-PDF name never counts, and generic
 * words like "tjenesteavtale" or "Asoldi Marketing" (a bank receipt) are not enough.
 */
export function pdfLooksLikeAsoldiContract(text = '', fileName = '', { mimeType = '', buffer = null } = {}) {
  const name = String(fileName || '');
  if (CONTRACT_NAME_RE.test(name) && isPdfAttachment({ fileName: name, mimeType, buffer })) return true;
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return textHasAsoldiOrgNumber(raw) || /chapana/i.test(raw);
}

function partName(part = {}) {
  return String(part?.filename || part?.originalName || '');
}

/**
 * Our contract among every PDF of a mail, not only the first: a PDF named Asoldi-kontrakt wins, then
 * the first whose text has the org number or CHAPANA. `firstText` is the already extracted text of `first`.
 * @returns {Promise<{ pdf: object, text: string } | null>}
 */
export async function findAsoldiContractPdf(parts = [], { first = null, firstText } = {}) {
  const pdfs = (Array.isArray(parts) ? parts : []).filter((part) => part?.buffer?.length && isPdfAttachment({
    fileName: partName(part),
    mimeType: part.mimeType,
    buffer: part.buffer,
  }));
  const textOf = async (part) => (part === first && typeof firstText === 'string' ? firstText : extractPdfText(part.buffer));
  const named = pdfs.find((part) => pdfLooksLikeAsoldiContract('', partName(part), part));
  if (named) return { pdf: named, text: await textOf(named) };
  for (const part of pdfs) {
    const text = await textOf(part);
    if (pdfLooksLikeAsoldiContract(text, partName(part), part)) return { pdf: part, text };
  }
  return null;
}

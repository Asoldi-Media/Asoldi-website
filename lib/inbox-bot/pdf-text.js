const ASOLDI_ORG = '934327497';

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

export function pdfLooksLikeAsoldiContract(text = '', fileName = '') {
  const name = String(fileName || '').toLowerCase();
  if (/asoldi-kontrakt|asoldi.?kontrakt|service.?agreement/.test(name)) return true;
  const raw = compactPdfText(text).replace(/\s+/g, '');
  const digits = raw.replace(/\D+/g, '');
  if (digits.includes(ASOLDI_ORG)) return true;
  return /chapana|asoldi marketing|service agreement/i.test(text);
}

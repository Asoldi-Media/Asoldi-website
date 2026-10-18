/**
 * Plain text out of any document a customer sends: pdf, docx, doc, odt, ods, xlsx, csv,
 * pptx/odp, rtf, html, Apple .pages/.numbers/.key, plain text.
 * PDF parsing and image OCR are injected (`pdfText`, `imageText`): they need a subprocess or an AI key.
 */

import { loadZip } from '../mail/unpack.js';
import { prepareForVision } from '../media/formats.js';
import { sniffSourceKind, VIDEO_EXT } from './kind.js';

export const PER_FILE_CHARS = 14_000;
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.rtf']);

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extOf(fileName = '') {
  const name = String(fileName || '').split(/[/\\]/).pop() || '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function openZip(buffer) {
  const Zip = loadZip();
  if (!Zip) return null;
  try {
    return new Zip(Buffer.from(buffer));
  } catch {
    return null;
  }
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

function odtCellText(cellXml = '') {
  return decodeXmlEntities(
    String(cellXml || '')
      .replace(/<text:tab[^/]*\/>/gi, '\t')
      .replace(/<text:line-break[^/]*\/>/gi, ' ')
      .replace(/<text:s[^/]*\/>/gi, ' ')
      .replace(/<\/text:p>/gi, ' ')
      .replace(/<\/text:h>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Table-aware ODT text so 2-column menus (Café | Take away) stay aligned.
 * Non-table paragraphs are appended afterward.
 */
export function extractTextFromOdt(buffer) {
  if (!buffer?.length) return '';
  try {
    const entry = openZip(buffer)?.getEntry('content.xml');
    if (!entry) return '';
    const xml = entry.getData().toString('utf8');
    const chunks = [];
    const tables = [...String(xml).matchAll(/<table:table\b[\s\S]*?<\/table:table>/gi)];
    tables.forEach((match, tableIndex) => {
      chunks.push(`=== TABLE ${tableIndex + 1} ===`);
      for (const rowMatch of (match[0] || '').matchAll(/<table:table-row\b[\s\S]*?<\/table:table-row>/gi)) {
        const cells = [...(rowMatch[0] || '').matchAll(/<table:table-cell\b[\s\S]*?<\/table:table-cell>/gi)].map((cell) => odtCellText(cell[0] || ''));
        // Keep empty cells so column positions stay stable for dual-price menus.
        if (cells.some((cell) => cell)) chunks.push(cells.join(' | '));
      }
      chunks.push('');
    });
    const withoutTables = String(xml).replace(/<table:table\b[\s\S]*?<\/table:table>/gi, ' ');
    const loose = decodeXmlEntities(
      withoutTables
        .replace(/<text:tab[^/]*\/>/gi, '\t')
        .replace(/<text:line-break[^/]*\/>/gi, '\n')
        .replace(/<text:s[^/]*\/>/gi, ' ')
        .replace(/<\/text:p>/gi, '\n')
        .replace(/<\/text:h>/gi, '\n')
        .replace(/<\/text:list-item>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (loose) {
      if (chunks.length) chunks.push('=== OTHER TEXT ===', loose);
      else chunks.push(loose);
    }
    return chunks.join('\n').trim();
  } catch {
    return '';
  }
}

function extractDocxText(buffer) {
  const entry = openZip(buffer)?.getEntry('word/document.xml');
  if (!entry) return '';
  return compact(entry.getData().toString('utf8').replace(/<[^>]+>/g, ' '));
}

function extractSlidesText(buffer) {
  try {
    const entries = (openZip(buffer)?.getEntries() || [])
      .filter((entry) => /^(ppt\/slides\/slide\d+|content)\.xml$/.test(entry.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    return compact(entries.map((entry) => entry.getData().toString('utf8').replace(/<[^>]+>/g, ' ')).join(' '));
  } catch {
    return '';
  }
}

// shortcut: pulls readable Latin-1 runs out of Word 97 binaries (no tables/formatting); use a real .doc parser if clients send many.
export function extractLegacyDocText(buffer) {
  const raw = Buffer.from(buffer);
  const runs = (decoded) => (decoded.match(/[\u0020-\u007E\u00A0-\u00FF]{8,}/g) || []).filter((run) => / \S/.test(run));
  const wide = runs(raw.toString('utf16le'));
  const narrow = runs(raw.toString('latin1'));
  const pick = wide.join(' ').length >= narrow.join(' ').length ? wide : narrow;
  return compact(pick.join(' '));
}

function snappyBlock(buf) {
  let pos = 0;
  let size = 0;
  for (let shift = 0; pos < buf.length; shift += 7) {
    const byte = buf[pos++];
    size += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  const out = Buffer.alloc(Math.min(size, 64 * 1024 * 1024));
  let o = 0;
  while (pos < buf.length && o < out.length) {
    const tag = buf[pos++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = buf.readUIntLE(pos, bytes);
        pos += bytes;
      }
      n += 1;
      buf.copy(out, o, pos, pos + n);
      pos += n;
      o += n;
      continue;
    }
    let n;
    let offset;
    if (type === 1) {
      n = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | buf[pos++];
    } else if (type === 2) {
      n = (tag >> 2) + 1;
      offset = buf.readUInt16LE(pos);
      pos += 2;
    } else {
      n = (tag >> 2) + 1;
      offset = buf.readUInt32LE(pos);
      pos += 4;
    }
    if (!offset || offset > o) break;
    for (let i = 0; i < n && o < out.length; i += 1, o += 1) out[o] = out[o - offset];
  }
  return out.subarray(0, o);
}

/** iWork .iwa = chunks of [type 0, uint24 length, snappy block]. */
export function decodeIwa(buffer) {
  const buf = Buffer.from(buffer);
  const parts = [];
  for (let pos = 0; pos + 4 <= buf.length;) {
    const length = buf.readUIntLE(pos + 1, 3);
    if (buf[pos] === 0) parts.push(snappyBlock(buf.subarray(pos + 4, pos + 4 + length)));
    pos += 4 + length;
  }
  return Buffer.concat(parts);
}

// shortcut: reads readable UTF-8 runs out of the iWork protobufs (text order kept, no tables/styles); use a protobuf schema if layout matters.
export function extractIworkText(buffer) {
  const zip = openZip(buffer);
  if (!zip) return '';
  const legacy = zip.getEntry('index.xml');
  if (legacy) return compact(legacy.getData().toString('utf8').replace(/<[^>]+>/g, ' '));
  const iwa = zip.getEntries()
    .filter((entry) => /^Index\/.*\.iwa$/.test(entry.entryName))
    .sort((a, b) => Number(!/Document\.iwa$/.test(a.entryName)) - Number(!/Document\.iwa$/.test(b.entryName)));
  const runs = [];
  for (const entry of iwa) {
    let decoded;
    try {
      decoded = decodeIwa(entry.getData()).toString('utf8');
    } catch {
      continue;
    }
    for (const run of decoded.match(/[\p{L}\p{N}\p{P}\p{Zs}\n]{12,}/gu) || []) {
      const text = compact(run);
      if (/\p{L}{2,} \S/u.test(text) && !runs.includes(text)) runs.push(text);
    }
  }
  return compact(runs.join('\n'));
}

function stripMarkup(value = '') {
  return compact(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function extractRtfText(buffer) {
  const raw = Buffer.from(buffer).toString('latin1');
  return compact(raw
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/gi, ' ')
    .replace(/[{}]/g, ' '));
}

function extractOdsText(buffer) {
  try {
    const entry = openZip(buffer)?.getEntry('content.xml');
    if (!entry) return '';
    return compact(entry.getData().toString('utf8').replace(/<text:p[^>]*>/g, '\n').replace(/<[^>]+>/g, ' '));
  } catch {
    return '';
  }
}

function looksLikeUtf8Text(buffer) {
  if (!buffer?.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1200));
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
  }
  return odd / sample.length < 0.08;
}

/** Text runs inside an uncompressed PDF; last resort when no PDF parser is wired. */
export function extractPdfTextRough(buffer, maxChars = PER_FILE_CHARS) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer || '');
  const chunks = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)) {
    const text = match[0].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
    if (/[\p{L}0-9]/u.test(text)) chunks.push(text);
  }
  return compact(chunks.join(' ')).slice(0, maxChars);
}

async function extractSpreadsheetText(buffer, { sheetLabel, maxChars }) {
  const xlsx = await import('xlsx');
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheets = [];
  for (const name of workbook.SheetNames.slice(0, 8)) {
    const csv = xlsx.utils.sheet_to_csv(workbook.Sheets[name]);
    if (compact(csv)) sheets.push(`${sheetLabel} ${name}:\n${csv}`);
  }
  return sheets.join('\n\n').slice(0, maxChars);
}

/**
 * @param {{buffer?: Buffer, text?: string, originalName?: string, name?: string, fileName?: string, mimeType?: string}} file
 * @param {{pdfText?: (buf: Buffer) => Promise<string>, imageText?: (buf: Buffer, mimeType: string) => Promise<string>,
 *   imageMaxEdge?: number, sheetLabel?: string, maxChars?: number}} [options]
 * @returns {Promise<{fileName: string, text: string, kind: string}>}
 */
export async function extractDocumentText(file = {}, {
  pdfText = null,
  imageText = null,
  imageMaxEdge = 1600,
  sheetLabel = 'Sheet',
  maxChars = PER_FILE_CHARS,
} = {}) {
  const name = file.originalName || file.name || file.fileName || 'file';
  const ext = extOf(name);
  const buffer = file.buffer;
  const kind = sniffSourceKind(file);
  const out = (text, k) => ({ fileName: name, text, kind: k });
  const pdf = async (buf) => (pdfText ? compact(await pdfText(buf).catch(() => '')) : '');
  if (!buffer) return out(compact(file.text || ''), kind);
  if (kind === 'image') {
    if (!imageText) return out('', 'image');
    const prepared = await prepareForVision(buffer, name, { maxEdge: imageMaxEdge });
    return out(prepared.ok && prepared.kind === 'image' ? await imageText(prepared.buffer, prepared.mimeType) : '', 'image');
  }
  if (kind === 'video' || VIDEO_EXT.has(ext)) return out('', 'video');
  if (kind === 'spreadsheet' || ['.xlsx', '.xls', '.csv', '.ods'].includes(ext)) {
    if (ext === '.csv' || ext === '.tsv') return out(buffer.toString('utf8').slice(0, maxChars), 'spreadsheet');
    if (ext === '.ods') {
      try {
        const fromXlsx = await extractSpreadsheetText(buffer, { sheetLabel, maxChars });
        if (fromXlsx) return out(fromXlsx, 'spreadsheet');
      } catch {
        // fall through to XML inside the ODS zip
      }
      return out(extractOdsText(buffer).slice(0, maxChars), 'spreadsheet');
    }
    return out(await extractSpreadsheetText(buffer, { sheetLabel, maxChars }), 'spreadsheet');
  }
  if (ext === '.odt') return out(extractTextFromOdt(buffer), 'document');
  if (ext === '.docx') return out(extractDocxText(buffer), 'document');
  if (ext === '.doc') return out(extractLegacyDocText(buffer).slice(0, maxChars), 'document');
  if (['.pages', '.numbers', '.key'].includes(ext)) {
    const preview = openZip(buffer)?.getEntry('QuickLook/Preview.pdf')?.getData() || null;
    const fromPreview = preview ? await pdf(preview) : '';
    const text = fromPreview.length >= 40 ? fromPreview : extractIworkText(buffer);
    return out(text.slice(0, maxChars), 'document');
  }
  if (ext === '.pptx' || ext === '.odp') return out(extractSlidesText(buffer).slice(0, maxChars), 'document');
  if (ext === '.rtf' || (kind === 'document' && String(file.mimeType || '').includes('rtf'))) return out(extractRtfText(buffer).slice(0, maxChars), 'document');
  if (ext === '.html' || ext === '.htm' || ext === '.xml') return out(stripMarkup(buffer.toString('utf8')).slice(0, maxChars), 'document');
  if (TEXT_EXT.has(ext) || String(file.mimeType || file.mimetype || '').startsWith('text/')) return out(buffer.toString('utf8').slice(0, maxChars), 'document');
  if (ext === '.pdf' || kind === 'document') {
    const parsed = await pdf(buffer);
    if (parsed.length >= 40) return out(parsed.slice(0, maxChars), 'document');
    return out(extractPdfTextRough(buffer, maxChars), 'document');
  }
  if (looksLikeUtf8Text(buffer)) return out(buffer.toString('utf8').slice(0, maxChars), 'document');
  return out(compact(file.text || ''), kind);
}

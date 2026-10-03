/**
 * Generic source typing: documents stay documents, media stays media.
 * Prefer file bytes, then MIME, then extension. Never send a PDF/ODT/DOCX
 * through an image model just because a browser labelled it oddly.
 */

function compact(value = '') {
  return String(value ?? '').trim();
}

function extOf(fileName = '') {
  const name = compact(fileName).split(/[/\\]/).pop() || '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function headBytes(buffer, length = 16) {
  if (!buffer) return [];
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
    return [...buffer.subarray(0, length)];
  }
  if (buffer instanceof Uint8Array) return [...buffer.subarray(0, length)];
  return [];
}

function asciiHead(buffer, length = 64) {
  const bytes = headBytes(buffer, length);
  return bytes.map((code) => (code >= 32 && code < 127 ? String.fromCharCode(code) : ' ')).join('');
}

function sampleAscii(buffer, length = 800) {
  const bytes = headBytes(buffer, length);
  if (!bytes.length) return '';
  return bytes.map((code) => String.fromCharCode(code)).join('');
}

const DOCUMENT_EXT = new Set(['.pdf', '.odt', '.ods', '.odp', '.docx', '.doc', '.rtf', '.txt', '.md', '.html', '.htm', '.xml', '.json']);
const SPREADSHEET_EXT = new Set(['.xlsx', '.xls', '.csv', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.avif', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);

function looksLikePdf(buffer, ext, mime) {
  const head = asciiHead(buffer, 8);
  return head.startsWith('%PDF') || ext === '.pdf' || mime.includes('pdf');
}

function looksLikeZip(buffer) {
  const bytes = headBytes(buffer, 4);
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeOfficeDocument(buffer, ext, mime) {
  if (['.odt', '.ods', '.odp', '.docx', '.doc', '.rtf'].includes(ext)) return true;
  if (mime.includes('opendocument') || mime.includes('wordprocessingml') || mime.includes('msword')) return true;
  if (!looksLikeZip(buffer)) return false;
  const sample = sampleAscii(buffer, 2400);
  return /opendocument|word\/|\[Content_Types\]\.xml|mimetype/.test(sample);
}

function looksLikeSpreadsheet(buffer, ext, mime) {
  if (SPREADSHEET_EXT.has(ext)) return true;
  if (mime.includes('spreadsheet') || mime.includes('excel')) return true;
  if (!looksLikeZip(buffer)) return false;
  return /xl\/|opendocument\.spreadsheet|workbook\.xml/.test(sampleAscii(buffer, 2400));
}

function looksLikeImage(buffer, ext, mime) {
  const bytes = headBytes(buffer, 12);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  if (asciiHead(buffer, 4) === 'RIFF' && sampleAscii(buffer, 12).includes('WEBP')) return true;
  if (mime.startsWith('image/') && !mime.includes('svg')) return IMAGE_EXT.has(ext) || !ext;
  return IMAGE_EXT.has(ext) && !DOCUMENT_EXT.has(ext) && !SPREADSHEET_EXT.has(ext);
}

function looksLikeVideo(buffer, ext, mime) {
  if (VIDEO_EXT.has(ext) || mime.startsWith('video/')) return true;
  const text = asciiHead(buffer, 12);
  return text.includes('ftyp') && !looksLikeImage(buffer, ext, mime);
}

export function sniffSourceKind(file = {}) {
  const fileName = file.originalName || file.originalname || file.name || file.fileName || '';
  const mime = compact(file.mimeType || file.mimetype || file.contentType).toLowerCase();
  const ext = extOf(fileName);
  const buffer = file.buffer;

  if (looksLikePdf(buffer, ext, mime)) return 'document';
  if (looksLikeSpreadsheet(buffer, ext, mime)) return 'spreadsheet';
  if (looksLikeOfficeDocument(buffer, ext, mime)) return 'document';
  if (DOCUMENT_EXT.has(ext) || mime.includes('text/')) return 'document';
  if (looksLikeVideo(buffer, ext, mime)) return 'video';
  if (looksLikeImage(buffer, ext, mime)) return 'image';
  return 'unknown';
}

export function isDocumentSource(file = {}) {
  const kind = sniffSourceKind(file);
  return kind === 'document' || kind === 'spreadsheet';
}

export function isMediaAssetSource(file = {}) {
  const kind = sniffSourceKind(file);
  return kind === 'image' || kind === 'video';
}

export function isMediaAssetFileName(fileName = '') {
  return isMediaAssetSource({ fileName });
}

export function partitionAssistantFiles(files = []) {
  const documents = [];
  const media = [];
  const other = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (isDocumentSource(file)) documents.push(file);
    else if (isMediaAssetSource(file)) media.push(file);
    else other.push(file);
  }
  return { documents, media, other };
}

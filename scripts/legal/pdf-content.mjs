/**
 * A digest of a PDF's content that does not depend on the zlib build that compressed it.
 *
 * pdfkit compresses page contents and images with zlib's deflate, and two zlib builds (the one
 * bundled with official Node builds and a system zlib, for example) can write different bytes for
 * the same input. Inflating gives the same bytes back with any build. So the normalized form
 * inflates every FlateDecode stream, drops each stream's /Length (the compressed size), and drops
 * the cross-reference table and the startxref offset (byte positions that follow from those
 * sizes). Everything else, the text, fonts, images, metadata and document id, stays in.
 *
 * It reads the PDFs pdfkit writes: direct /Length integers and one filter name per stream. Any
 * other shape throws, so a check built on it fails instead of comparing the wrong thing.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const OBJECT_HEADER = /\d+\s+\d+\s+obj\b/g;
const STREAM_KEYWORD = /\bstream(\r\n|\n)/g;
const LENGTH_ENTRY = /\/Length(?![0-9A-Za-z])\s*(\d+)(\s+\d+\s+R\b)?/g;
const FILTER_ENTRY = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/;

function lastObjectHeaderEnd(text, from, to) {
  OBJECT_HEADER.lastIndex = from;
  let end = -1;
  for (let match = OBJECT_HEADER.exec(text); match && match.index < to; match = OBJECT_HEADER.exec(text)) {
    end = match.index + match[0].length;
  }
  return end;
}

/** The PDF with every FlateDecode stream inflated and every compressed-size field removed, as a Buffer. */
export function normalizedPdf(input) {
  const pdf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const text = pdf.toString('latin1');
  if (!text.startsWith('%PDF-')) throw new Error('not a PDF');
  const out = [];
  let cursor = 0;
  STREAM_KEYWORD.lastIndex = 0;
  for (let match = STREAM_KEYWORD.exec(text); match; match = STREAM_KEYWORD.exec(text)) {
    const headerEnd = lastObjectHeaderEnd(text, cursor, match.index);
    if (headerEnd < 0) throw new Error(`stream at byte ${match.index} has no object header`);
    const dictionary = text.slice(headerEnd, match.index);
    const lengths = [...dictionary.matchAll(LENGTH_ENTRY)];
    if (lengths.length !== 1) throw new Error(`stream at byte ${match.index}: expected one /Length, found ${lengths.length}`);
    if (lengths[0][2]) throw new Error(`stream at byte ${match.index}: /Length is an indirect reference`);
    const filter = FILTER_ENTRY.exec(dictionary)?.[1] || '';
    if (filter.startsWith('[')) throw new Error(`stream at byte ${match.index}: filter arrays are not read`);
    const start = match.index + match[0].length;
    const end = start + Number(lengths[0][1]);
    const tail = /^(\r\n|\n|\r)?endstream\b/.exec(text.slice(end, end + 12));
    if (!tail) throw new Error(`stream at byte ${match.index}: /Length does not end at endstream`);
    const raw = pdf.subarray(start, end);
    const body = filter === '/FlateDecode' ? inflateSync(raw) : raw;
    out.push(Buffer.from(text.slice(cursor, headerEnd), 'latin1'));
    out.push(Buffer.from(`${dictionary.replace(LENGTH_ENTRY, '')}stream\n`, 'latin1'));
    out.push(body, Buffer.from('\nendstream', 'latin1'));
    cursor = end + tail[0].length;
    STREAM_KEYWORD.lastIndex = cursor;
  }
  const rest = text
    .slice(cursor)
    .replace(/\bxref\s+[\s\S]*?(?=\btrailer\b)/, '')
    .replace(/\bstartxref\s+\d+/, 'startxref');
  out.push(Buffer.from(rest, 'latin1'));
  return Buffer.concat(out);
}

/** SHA-256 of normalizedPdf(input): equal for two PDFs with the same content, whatever zlib wrote them. */
export function pdfContentSha256(input) {
  return createHash('sha256').update(normalizedPdf(input)).digest('hex');
}

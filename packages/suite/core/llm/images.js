// Image blocks for vision calls: JPEG only, at most 1568 px on the long edge, at most 6 images per call.
// prepareImage() converts and shrinks with sharp (optional dependency, loaded lazily); the block builders
// only check, so a request that breaks the rule fails before it reaches a provider.

import { CLAUDE_RULES } from './constants.js';
import { InvalidRequestError } from './errors.js';

export const IMAGE_RULES = CLAUDE_RULES.image;

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

/** Width and height from a JPEG's SOF marker, or null when the bytes are not a readable JPEG. */
export function jpegSize(input) {
  const buf = toBuffer(input);
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 <= buf.length) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function cleanBase64(value) {
  return String(value || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
}

/**
 * One Claude image content block from {base64, mime} | {buffer, mime} | {url}.
 * Base64/buffer images must be JPEG with a long edge <= maxLongEdge (checked from the bytes).
 * URL images are passed through; declared width/height, when given, are checked too.
 */
export function imageBlock(input = {}, { maxLongEdge = IMAGE_RULES.maxLongEdge, mime = IMAGE_RULES.mime } = {}) {
  const image = toBuffer(input) ? { buffer: input } : input || {};
  if (image.url) {
    const url = String(image.url);
    if (!/^https:\/\//i.test(url)) throw new InvalidRequestError('Image URLs must be https.');
    const edge = Math.max(Number(image.width) || 0, Number(image.height) || 0);
    if (edge > maxLongEdge) throw new InvalidRequestError(`Image is ${edge}px on the long edge; the limit is ${maxLongEdge}px.`);
    return { type: 'image', source: { type: 'url', url } };
  }
  const declared = String(image.mime || image.media_type || '').toLowerCase();
  if (declared && declared !== mime) throw new InvalidRequestError(`Images must be ${mime} (got ${declared}). Convert with prepareImage().`);
  const buffer = toBuffer(image.buffer) || (image.base64 ? Buffer.from(cleanBase64(image.base64), 'base64') : null);
  if (!buffer || !buffer.length) throw new InvalidRequestError('Image has no data (base64, buffer or url).');
  const size = jpegSize(buffer);
  if (!size) throw new InvalidRequestError(`Image is not a readable ${mime}. Convert with prepareImage().`);
  const edge = Math.max(size.width, size.height);
  if (edge > maxLongEdge) throw new InvalidRequestError(`Image is ${edge}px on the long edge; the limit is ${maxLongEdge}px. Shrink with prepareImage().`);
  return { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } };
}

/** All image blocks for one call; more than maxImages is an error, never a silent cut. */
export function imageBlocks(images = [], { maxImages = IMAGE_RULES.maxImages, maxLongEdge = IMAGE_RULES.maxLongEdge } = {}) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (list.length > maxImages) throw new InvalidRequestError(`${list.length} images in one call; the limit is ${maxImages}.`, { images: list.length });
  return list.map((image) => imageBlock(image, { maxLongEdge }));
}

/** Image blocks already inside a messages array (tool loops, multi-turn calls). */
export function countImageBlocks(messages = []) {
  let count = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) if (block?.type === 'image') count += 1;
  }
  return count;
}

/**
 * Any image (buffer or base64, any format sharp reads) -> JPEG at quality 80, long edge <= 1568 px,
 * EXIF rotation applied, transparency flattened on white. Needs the optional `sharp` package.
 * @returns {Promise<{mime:string, base64:string, width:number, height:number, bytes:number}>}
 */
export async function prepareImage(input, { maxLongEdge = IMAGE_RULES.maxLongEdge, quality = IMAGE_RULES.jpegQuality } = {}) {
  const direct = toBuffer(input);
  const buffer = direct || toBuffer(input?.buffer) || (input?.base64 ? Buffer.from(cleanBase64(input.base64), 'base64') : null);
  if (!buffer || !buffer.length) throw new InvalidRequestError('prepareImage needs a buffer or base64 image.');
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new InvalidRequestError('prepareImage needs the optional "sharp" package.');
  }
  const out = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: maxLongEdge, height: maxLongEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  return { mime: IMAGE_RULES.mime, base64: out.data.toString('base64'), width: out.info.width, height: out.info.height, bytes: out.data.length };
}

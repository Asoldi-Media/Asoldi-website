// Every media format a client or template can send, turned into something Gemini can read.
// Pure: buffers in, buffers out. No disk, no network.

const MB = 1024 * 1024;

/** Gemini reads these directly. They are only downscaled. */
export const IMAGE_PASS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
/** Gemini rejects or misreads these. They are rasterized first. */
export const IMAGE_CONVERT = new Set(['.gif', '.avif', '.bmp', '.ico', '.cur', '.tif', '.tiff', '.svg']);
export const VIDEO_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
export const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

export const DEFAULT_LIMITS = {
  maxEdge: 768,
  maxImageBytes: 15 * MB,
  maxVideoBytes: 3 * MB,
  maxAudioBytes: 2 * MB,
};

let sharpPromise = null;
export function loadSharp() {
  if (!sharpPromise) sharpPromise = import('sharp').then((mod) => mod.default || mod).catch(() => null);
  return sharpPromise;
}

export function extOf(fileName = '') {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(fileName || '').split(/[?#]/)[0]);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/** Magic bytes, for attachments named "image001" or with the wrong extension. */
export function sniffExt(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length < 12) return '';
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (ascii(0, 4) === 'GIF8') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return '.wav';
  if (ascii(0, 2) === 'BM') return '.bmp';
  if (b.readUInt16LE(0) === 0 && (b.readUInt16LE(2) === 1 || b.readUInt16LE(2) === 2) && b.readUInt16LE(4) > 0) return b.readUInt16LE(2) === 2 ? '.cur' : '.ico';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return '.tiff';
  if (ascii(0, 4) === 'OggS') return '.ogg';
  if (ascii(0, 4) === 'fLaC') return '.flac';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return '.mp3';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.webm';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    // AVIF often has major brand mif1 and lists avif among the compatible brands.
    if (/avi[fs]/.test(ascii(8, Math.min(b.length, 40)).toLowerCase())) return '.avif';
    if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return '.heic';
    if (brand === 'qt  ') return '.mov';
    if (brand.startsWith('m4a')) return '.m4a';
    return '.mp4';
  }
  const head = ascii(0, Math.min(b.length, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!doctype svg')) && head.includes('<svg'))) return '.svg';
  return '';
}

function knownExt(ext) {
  return Boolean(IMAGE_PASS[ext] || IMAGE_CONVERT.has(ext) || VIDEO_MIME[ext] || AUDIO_MIME[ext]);
}

/** Extension we trust: the file name when it is a media type, else the bytes. */
export function resolveExt(fileName = '', buffer = null) {
  const named = extOf(fileName);
  const sniffed = buffer ? sniffExt(buffer) : '';
  if (!knownExt(named)) return knownExt(sniffed) ? sniffed : named;
  // Image magic bytes are reliable, so a GIF named .jpg is converted and a PNG named .jpg gets the right mime.
  if (sniffed && mediaKindForExt(named) === 'image' && mediaKindForExt(sniffed) === 'image') return sniffed;
  return named;
}

export function mediaKindForExt(ext = '') {
  if (IMAGE_PASS[ext] || IMAGE_CONVERT.has(ext)) return 'image';
  if (VIDEO_MIME[ext]) return 'video';
  if (AUDIO_MIME[ext]) return 'audio';
  return 'other';
}

export function mediaKindOf(fileName = '', buffer = null) {
  return mediaKindForExt(resolveExt(fileName, buffer));
}

function decodeXml(value = '') {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Words written inside an SVG (title, desc, text, aria-label). Outlined text has none. */
export function svgTextHint(buffer) {
  const source = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])).toString('utf8').slice(0, 400_000);
  const words = [];
  const push = (value) => {
    const text = decodeXml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text && !words.includes(text)) words.push(text);
  };
  for (const match of source.matchAll(/<(title|desc|text)\b[^>]*>([\s\S]*?)<\/\1>/gi)) push(match[2]);
  for (const match of source.matchAll(/\baria-label\s*=\s*"([^"]+)"/gi)) push(match[1]);
  return words.join(' · ').slice(0, 300);
}

/**
 * Uncompressed BMP / ICO-DIB bitmap → RGBA. Covers what real logos and favicons use
 * (8-bit palette, 24-bit, 32-bit with or without bitfields).
 * shortcut: no RLE-compressed BMP (rare in client uploads); add RLE4/RLE8 if one shows up.
 */
function decodeDib(buf, dibStart, pixelStart, { icon = false } = {}) {
  const headerSize = buf.readUInt32LE(dibStart);
  const width = buf.readInt32LE(dibStart + 4);
  let height = buf.readInt32LE(dibStart + 8);
  const bpp = buf.readUInt16LE(dibStart + 14);
  const compression = headerSize >= 20 ? buf.readUInt32LE(dibStart + 16) : 0;
  if (icon) height = Math.trunc(height / 2);
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;
  if (![0, 3].includes(compression) || ![8, 24, 32].includes(bpp)) return null;
  const colorsUsed = headerSize >= 36 ? buf.readUInt32LE(dibStart + 32) : 0;
  const paletteStart = dibStart + headerSize + (compression === 3 && headerSize === 40 ? 12 : 0);
  const palette = bpp === 8 ? colorsUsed || 256 : 0;
  const start = pixelStart ?? paletteStart + palette * 4;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = start + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      let r;
      let g;
      let b;
      let a = 255;
      if (bpp === 8) {
        const p = paletteStart + buf[row + x] * 4;
        [b, g, r] = [buf[p], buf[p + 1], buf[p + 2]];
      } else {
        const p = row + x * (bpp / 8);
        [b, g, r] = [buf[p], buf[p + 1], buf[p + 2]];
        if (bpp === 32) {
          a = buf[p + 3];
          if (a) anyAlpha = true;
        }
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  // 32-bit without a real alpha channel stores 0 everywhere; treat it as opaque.
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width, height, data: out };
}

/** BMP or ICO/CUR → { png } (embedded PNG) or { raw: {width,height,data} }. */
export function decodeBitmap(buffer, ext = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  try {
    if (ext === '.bmp') {
      const raw = decodeDib(buf, 14, buf.readUInt32LE(10));
      return raw ? { raw } : null;
    }
    const count = buf.readUInt16LE(4);
    let best = null;
    for (let i = 0; i < count && 6 + i * 16 + 16 <= buf.length; i += 1) {
      const at = 6 + i * 16;
      const width = buf[at] || 256;
      const size = buf.readUInt32LE(at + 8);
      const offset = buf.readUInt32LE(at + 12);
      if (offset + size > buf.length) continue;
      if (!best || width > best.width) best = { width, size, offset };
    }
    if (!best) return null;
    const entry = buf.subarray(best.offset, best.offset + best.size);
    if (entry[0] === 0x89 && entry.subarray(1, 4).toString('latin1') === 'PNG') return { png: entry };
    const raw = decodeDib(entry, 0, null, { icon: true });
    return raw ? { raw } : null;
  } catch {
    return null;
  }
}

/** A sharp instance for any still image, or null when this format cannot be decoded here. */
export async function openImage(buffer, ext, { density } = {}) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const options = { failOn: 'none', animated: false, limitInputPixels: 60_000_000 };
  if (ext === '.bmp' || ext === '.ico' || ext === '.cur') {
    const decoded = decodeBitmap(buffer, ext);
    if (!decoded) return null;
    if (decoded.png) return sharp(decoded.png, options);
    const { width, height, data } = decoded.raw;
    return sharp(data, { raw: { width, height, channels: 4 } });
  }
  return sharp(buffer, ext === '.svg' && density ? { ...options, density } : options);
}

async function rasterize(buffer, ext, maxEdge) {
  let density;
  if (ext === '.svg') {
    // Render vectors near the target size instead of upscaling a 24px raster.
    const probe = await openImage(buffer, ext);
    const meta = probe ? await probe.metadata().catch(() => ({})) : {};
    const side = Math.max(Number(meta.width || 0), Number(meta.height || 0)) || 300;
    density = Math.max(36, Math.min(2400, Math.round((72 * maxEdge) / side)));
  }
  const image = await openImage(buffer, ext, { density });
  if (!image) return null;
  const meta = await image.metadata();
  const hasAlpha = Boolean(meta.hasAlpha) || ext === '.svg';
  const resized = image.rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  const out = hasAlpha ? await resized.png({ compressionLevel: 8 }).toBuffer() : await resized.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  return { buffer: out, mimeType: hasAlpha ? 'image/png' : 'image/jpeg' };
}

/**
 * One media file → an inline part Gemini accepts.
 * Returns { ok, kind, ext, mimeType, buffer, converted, textHint, error }.
 * Never throws; an unreadable or unsupported file returns ok:false with a reason.
 */
export async function prepareForVision(buffer, fileName = '', limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const ext = resolveExt(fileName, bytes);
  const kind = mediaKindForExt(ext);
  const base = { ok: false, kind, ext, mimeType: '', buffer: null, converted: false, textHint: '', error: '' };
  if (!bytes.length) return { ...base, error: 'empty file' };
  if (kind === 'video') {
    if (bytes.length > lim.maxVideoBytes) return { ...base, error: `video larger than ${Math.round(lim.maxVideoBytes / MB)}MB skipped for cost` };
    return { ...base, ok: true, mimeType: VIDEO_MIME[ext], buffer: bytes };
  }
  if (kind === 'audio') {
    if (bytes.length > lim.maxAudioBytes) return { ...base, error: `audio larger than ${Math.round(lim.maxAudioBytes / MB)}MB skipped for cost` };
    return { ...base, ok: true, mimeType: AUDIO_MIME[ext], buffer: bytes };
  }
  if (kind !== 'image') return { ...base, error: `unsupported file type ${ext || '(unknown)'}` };
  if (bytes.length > lim.maxImageBytes) return { ...base, error: `image larger than ${Math.round(lim.maxImageBytes / MB)}MB` };
  const textHint = ext === '.svg' ? svgTextHint(bytes) : '';
  const maxEdge = Math.max(128, Number(lim.maxEdge) || DEFAULT_LIMITS.maxEdge);

  if (IMAGE_PASS[ext]) {
    const passThrough = { ...base, ok: true, mimeType: IMAGE_PASS[ext], buffer: bytes, textHint };
    // sharp's prebuilt libvips has no HEVC decoder; Gemini reads HEIC itself.
    if (ext === '.heic' || ext === '.heif') return passThrough;
    try {
      const image = await openImage(bytes, ext);
      if (!image) return passThrough;
      const meta = await image.metadata();
      if (bytes.length <= 700_000 && Math.max(Number(meta.width || 0), Number(meta.height || 0)) <= maxEdge) return passThrough;
      const out = await rasterize(bytes, ext, maxEdge);
      return out ? { ...passThrough, ...out } : passThrough;
    } catch {
      return passThrough;
    }
  }

  try {
    const out = await rasterize(bytes, ext, maxEdge);
    if (!out) {
      const sharp = await loadSharp();
      return { ...base, textHint, error: sharp ? `could not decode ${ext}` : `converter unavailable for ${ext} (install sharp)` };
    }
    return { ...base, ok: true, converted: true, textHint, ...out };
  } catch (error) {
    return { ...base, textHint, error: `could not decode ${ext}: ${String(error?.message || error).slice(0, 120)}` };
  }
}

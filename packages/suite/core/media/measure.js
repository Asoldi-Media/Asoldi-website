import { decodeBitmap, loadSharp, mediaKindForExt, openImage, resolveExt } from './formats.js';

export function aspectClassOf(width, height) {
  const ratio = width > 0 && height > 0 ? width / height : 0;
  if (!ratio) return '';
  if (ratio >= 0.78 && ratio <= 1.28) return 'square';
  return ratio > 1.28 ? 'landscape' : 'portrait';
}

async function imageSizeFallback(buffer) {
  try {
    const mod = await import('image-size');
    const fn = mod.imageSize || mod.default;
    const dim = fn(buffer);
    return { width: Number(dim?.width || 0), height: Number(dim?.height || 0) };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function alphaSample(image) {
  const { data, info } = await image.resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels || 4;
  const pixels = info.width * info.height;
  if (!pixels) return null;
  let transparent = 0;
  for (let i = 3; i < data.length; i += channels) if (data[i] < 250) transparent += 1;
  return { hasAlpha: transparent / pixels > 0.02, alphaCoverage: Math.round((transparent / pixels) * 1000) / 1000 };
}

/**
 * Size, aspect, frames and transparency measured by code, so the model is told facts
 * instead of guessing them. Never throws. hasAlpha stays null when it could not be measured.
 */
export async function measureMedia(buffer, fileName = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const ext = resolveExt(fileName, bytes);
  const out = {
    ext,
    fileName: String(fileName || ''),
    bytes: bytes.length,
    width: 0,
    height: 0,
    ratio: 0,
    aspectClass: '',
    maxSide: 0,
    frames: 1,
    hasAlpha: null,
    alphaCoverage: 0,
  };
  if (!bytes.length || mediaKindForExt(ext) !== 'image') return out;
  try {
    const image = await openImage(bytes, ext);
    if (image) {
      const meta = await image.metadata();
      out.width = Number(meta.width || 0);
      out.height = Number(meta.pageHeight || meta.height || 0);
      if (ext === '.gif' || ext === '.webp') {
        const sharp = await loadSharp();
        const animated = await sharp(bytes, { animated: true, failOn: 'none' }).metadata().catch(() => ({}));
        out.frames = Number(animated.pages) > 1 ? Number(animated.pages) : 1;
      }
      const alpha = await alphaSample(image).catch(() => null);
      if (alpha) Object.assign(out, alpha);
    }
  } catch {
    // fall through to the header-only reader
  }
  if (!out.width || !out.height) {
    const decoded = ext === '.bmp' || ext === '.ico' || ext === '.cur' ? decodeBitmap(bytes, ext) : null;
    const dim = decoded?.raw ? decoded.raw : await imageSizeFallback(bytes);
    out.width = Number(dim.width || 0);
    out.height = Number(dim.height || 0);
  }
  if (out.width > 0 && out.height > 0) {
    out.ratio = Math.round((out.width / out.height) * 1000) / 1000;
    out.maxSide = Math.max(out.width, out.height);
    out.aspectClass = aspectClassOf(out.width, out.height);
  }
  return out;
}

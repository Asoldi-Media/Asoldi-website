import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { prepareForVision, sniffExt, svgTextHint, decodeBitmap } from '../packages/suite/core/media/formats.js';
import { measureMedia } from '../packages/suite/core/media/measure.js';
import { describeMedia } from '../packages/suite/core/media/describe.js';
import { demoteForeignBrandLogo, transcriptMatchesClientBrand, transcriptNamesForeignBrand } from '../packages/suite/core/media/normalize.js';
import { ASOLDI_MEDIA_HARNESS, placementForKundedata } from '../packages/suite/harness/asoldi/media.js';

const red = { r: 220, g: 30, b: 30, alpha: 1 };

function bmp24(width, height) {
  const stride = Math.floor((24 * width + 31) / 32) * 4;
  const pixels = stride * height;
  const buf = Buffer.alloc(54 + pixels);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(54 + pixels, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) buf.set([30, 30, 220], 54 + y * stride + x * 3);
  return buf;
}

function ico(entries) {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    head[at] = entry.width % 256;
    head[at + 1] = entry.width % 256;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(entry.data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([head, ...entries.map((entry) => entry.data)]);
}

function dib32(size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) pixels.set([30, 30, 220, i % 2 ? 255 : 0], i * 4);
  return Buffer.concat([header, pixels, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
}

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><title>Bakkes Bakeri</title><rect width="240" height="60" fill="#c33"/><text x="10" y="40">Bakkes</text></svg>');

async function fixtures() {
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: red } }).png().toBuffer();
  const frame = await sharp({ create: { width: 120, height: 80, channels: 4, background: red } }).raw().toBuffer();
  // The gif encoder merges identical frames, so the second frame is blue.
  const frame2 = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 30, g: 30, b: 220, alpha: 1 } } }).raw().toBuffer();
  const gif = await sharp(Buffer.concat([frame, frame2]), { raw: { width: 120, height: 160, channels: 4, pageHeight: 80 } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
  const avif = await sharp({ create: { width: 300, height: 200, channels: 3, background: red } }).avif().toBuffer();
  const tiff = await sharp({ create: { width: 200, height: 200, channels: 3, background: red } }).tiff().toBuffer();
  const smallPng = await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  return { png, gif, avif, tiff, smallPng, bmp: bmp24(64, 32), icoPng: ico([{ width: 48, data: smallPng }]), icoDib: ico([{ width: 16, data: dib32(16) }]) };
}

test('magic bytes identify every format, also with a wrong or missing name', async () => {
  const f = await fixtures();
  assert.equal(sniffExt(f.png), '.png');
  assert.equal(sniffExt(f.gif), '.gif');
  assert.equal(sniffExt(f.avif), '.avif');
  assert.equal(sniffExt(f.tiff), '.tiff');
  assert.equal(sniffExt(f.bmp), '.bmp');
  assert.equal(sniffExt(f.icoPng), '.ico');
  assert.equal(sniffExt(svg), '.svg');
  const named = await prepareForVision(f.gif, 'image001.jpg');
  assert.equal(named.ext, '.gif');
  assert.equal(named.converted, true);
});

test('svg, gif, avif, bmp, ico and tiff all become png/jpeg Gemini can read', async () => {
  const f = await fixtures();
  const cases = [
    ['logo.svg', svg],
    ['spin.gif', f.gif],
    ['photo.avif', f.avif],
    ['scan.tiff', f.tiff],
    ['old.bmp', f.bmp],
    ['favicon.ico', f.icoPng],
    ['legacy.ico', f.icoDib],
  ];
  for (const [name, buffer] of cases) {
    const out = await prepareForVision(buffer, name);
    assert.equal(out.ok, true, `${name}: ${out.error}`);
    assert.match(out.mimeType, /^image\/(png|jpeg)$/, name);
    const meta = await sharp(out.buffer).metadata();
    assert.ok(meta.width > 0 && meta.height > 0, name);
    assert.ok(Math.max(meta.width, meta.height) <= 768, name);
  }
  const vector = await prepareForVision(svg, 'logo.svg');
  assert.match(vector.textHint, /Bakkes Bakeri/);
  assert.ok((await sharp(vector.buffer).metadata()).width >= 600, 'small viewBox is rendered near maxEdge, not upscaled');
});

test('png/jpeg pass through or downscale; video/audio respect the cost caps; unknown types say why', async () => {
  const f = await fixtures();
  const big = await prepareForVision(f.png, 'hero.png');
  assert.equal(big.ok, true);
  assert.ok((await sharp(big.buffer).metadata()).width <= 768);
  const small = await prepareForVision(f.smallPng, 'icon.png');
  assert.equal(small.buffer, f.smallPng);
  const heic = await prepareForVision(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]), 'iphone.heic');
  assert.equal(heic.mimeType, 'image/heic');
  const video = await prepareForVision(Buffer.alloc(4 * 1024 * 1024, 1), 'clip.mp4');
  assert.equal(video.ok, false);
  assert.match(video.error, /video larger/);
  const audio = await prepareForVision(Buffer.alloc(1000, 1), 'jingle.mp3');
  assert.equal(audio.ok, true);
  assert.equal(audio.mimeType, 'audio/mpeg');
  const doc = await prepareForVision(Buffer.from('hello world, plain text here'), 'notes.txt');
  assert.equal(doc.ok, false);
  assert.match(doc.error, /unsupported/);
});

test('measure reads size, frames and alpha for every format', async () => {
  const f = await fixtures();
  const gif = await measureMedia(f.gif, 'spin.gif');
  assert.equal(gif.width, 120);
  assert.equal(gif.height, 80);
  assert.equal(gif.frames, 2);
  const vector = await measureMedia(svg, 'logo.svg');
  assert.equal(vector.aspectClass, 'landscape');
  const icon = await measureMedia(f.icoPng, 'favicon.ico');
  assert.equal(icon.width, 48);
  assert.equal(icon.hasAlpha, true);
  const bmp = await measureMedia(f.bmp, 'old.bmp');
  assert.deepEqual([bmp.width, bmp.height], [64, 32]);
  assert.ok(decodeBitmap(f.icoDib, '.ico')?.raw);
  assert.equal(svgTextHint(Buffer.from('<svg><path d="M0"/></svg>')), '');
});

test('describeMedia sends the converted image and returns a harnessed brief; nothing is written to disk', async () => {
  const before = new Set(readdirSync(tmpdir()));
  let seen = null;
  const brief = await describeMedia({
    buffer: svg,
    fileName: 'logo.svg',
    context: { businessName: 'Bakkes Bakeri' },
    harness: ASOLDI_MEDIA_HARNESS,
    generate: async (input) => {
      seen = input;
      return {
        ok: true,
        model: 'stub',
        parsed: { depicts: 'Red wordmark reading Bakkes.', visibleText: ['Bakkes'], medium: 'logo', primarySection: 'logo', primaryWhy: 'Header logo, the wordmark names the bakery.', logoKind: 'client', productInfo: false },
      };
    },
  });
  assert.equal(seen.mimeType, 'image/png');
  assert.match(seen.prompt, /Words written inside this vector file.*Bakkes Bakeri/);
  assert.match(seen.prompt, /productInfo/);
  assert.equal(brief.ok, true);
  assert.equal(brief.promptVersion, 5);
  assert.equal(brief.primaryField, 'logo');
  assert.equal(brief.logoFormat, 'wordmark');
  assert.equal(brief.productInfo, false);
  assert.deepEqual(placementForKundedata(brief), { bucket: 'logos', isLogo: true, favicon: false, productInfo: false });
  // The shared temp dir also changes under other processes; only our own leftovers count.
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => !before.has(name) && /vips|sharp|suite|media|logo/i.test(name)), []);
});

test('a foreign brand logo is demoted to work, and a menu photo is product info', async () => {
  const f = await fixtures();
  const partner = await describeMedia({
    buffer: f.png,
    fileName: 'client-logo.png',
    context: { businessName: 'Bakkes Bakeri' },
    harness: ASOLDI_MEDIA_HARNESS,
    generate: async () => ({ ok: true, model: 'stub', parsed: { depicts: 'Logo of Superhero Burger.', visibleText: ['SUPERHERO BURGER'], medium: 'logo', primarySection: 'logo', primaryWhy: 'Logo.' } }),
  });
  assert.equal(partner.logoKind, 'partner');
  assert.notEqual(partner.primarySection, 'logo');
  assert.equal(transcriptMatchesClientBrand({ visibleText: ['STERK', 'SNILL', 'SS&U'] }, 'SS&U'), true);
  assert.equal(transcriptMatchesClientBrand({ visibleText: ['CLASSUM'] }, 'SS&U'), false);
  assert.equal(transcriptNamesForeignBrand({ visibleText: ['STERK', 'SNILL', 'SS&U'] }, 'SS&U'), false);
  assert.equal(transcriptNamesForeignBrand({ visibleText: ['STERK', 'SNILL', 'S&U'] }, 'Bakeriet'), true);
  // Gemini sometimes calls a printed price list medium "logo"; its own non-logo section must survive.
  const priceList = demoteForeignBrandLogo({ medium: 'logo', primarySection: 'offerings', alternateSection: 'gallery', logoKind: 'client', visibleText: ['PRISLISTE', 'Surdeigsbrød 69,-'] }, 'Bakkes Bakeri');
  assert.equal(priceList.primarySection, 'offerings');
  assert.equal(priceList.logoKind, 'partner');
  assert.deepEqual(demoteForeignBrandLogo(priceList, 'Bakkes Bakeri'), priceList);
  const landscapeList = await describeMedia({
    buffer: await sharp({ create: { width: 800, height: 600, channels: 3, background: red } }).jpeg().toBuffer(),
    fileName: 'IMG_2041.jpg',
    context: { businessName: 'Bakkes Bakeri' },
    harness: ASOLDI_MEDIA_HARNESS,
    generate: async () => ({ ok: true, model: 'stub', parsed: { depicts: 'Price list.', visibleText: ['PRISLISTE', 'Surdeigsbrød 69,-'], medium: 'logo', primarySection: 'offerings', alternateSection: 'gallery', logoKind: 'client', primaryWhy: 'Offerings.', productInfo: true } }),
  });
  assert.equal(landscapeList.primarySection, 'offerings');
  assert.equal(placementForKundedata(landscapeList).bucket, 'offeringImages');
  const menu = await describeMedia({
    buffer: f.png,
    fileName: 'meny.jpg',
    harness: ASOLDI_MEDIA_HARNESS,
    generate: async () => ({ ok: true, model: 'stub', parsed: { depicts: 'Printed price list with ten pastries.', medium: 'photo', primarySection: 'offerings', primaryWhy: 'Offerings section, readable prices.', productInfo: 'true' } }),
  });
  assert.equal(menu.productInfo, true);
  assert.equal(placementForKundedata(menu).bucket, 'offeringImages');
  const failed = await describeMedia({ buffer: f.png, fileName: 'x.png', generate: async () => ({ ok: false, error: 'boom' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'boom');
});

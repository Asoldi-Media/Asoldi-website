import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionAssistantFiles, sniffSourceKind } from '../lib/ai-assistant/source-kind.js';
import { capCatalogsToProductLimit, PRODUCT_IMPORT_CAP } from '../lib/client-product-catalog.js';

test('PDF and ODT stay documents even if MIME says image', () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  assert.equal(sniffSourceKind({
    fileName: 'Catering-koldtbord-24.pdf',
    mimeType: 'image/jpeg',
    buffer: pdf,
  }), 'document');
  const odt = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('mimetypeapplication/vnd.oasis.opendocument.text'),
  ]);
  assert.equal(sniffSourceKind({
    fileName: 'Allergi-meny 1.odt',
    mimeType: 'application/octet-stream',
    buffer: odt,
  }), 'document');
  assert.equal(sniffSourceKind({
    fileName: 'meny.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), 'document');
});

test('real photos are media; mix partitions documents from media', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffSourceKind({ fileName: 'tallerken.jpg', mimeType: 'image/jpeg', buffer: jpeg }), 'image');
  const split = partitionAssistantFiles([
    { originalName: 'Allergi-meny 1.odt', mimeType: 'application/vnd.oasis.opendocument.text' },
    { originalName: 'Meny.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
    { originalName: 'hero.jpg', mimeType: 'image/jpeg', buffer: jpeg },
  ]);
  assert.equal(split.documents.length, 2);
  assert.equal(split.media.length, 1);
});

test('assistant catalog hard-caps at 200 products', () => {
  const products = Array.from({ length: 350 }, (_, index) => ({ title: `Vare ${index + 1}`, price: '10 kr' }));
  const capped = capCatalogsToProductLimit([{
    layout: 'normal',
    label: 'Shop',
    categories: [{ name: 'Alle', products }],
  }]);
  assert.equal(capped.truncated, true);
  assert.equal(capped.kept, PRODUCT_IMPORT_CAP);
  assert.equal(capped.dropped, 150);
  assert.equal(capped.catalogs[0].categories[0].products.length, 200);
});

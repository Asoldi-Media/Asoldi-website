import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  assertImportedPreviewHasAssets,
  collectRelativeAssetRefs,
  fillExportZipWithMakerAssets,
  ensureSharedPreviewStyles,
  inlineLocalStylesheets,
  makerAssetFetchUrls,
  recoverMissingStylesheets,
  rewriteCssForStaticPreview,
} from '../lib/preview-bundle-assets.js';

const htmlRefs = collectRelativeAssetRefs(
  '<link href="localasset://theme.css" rel="stylesheet"><script src="assets/app.js"></script>'
);
assert.deepEqual([...htmlRefs].sort(), ['assets/app.js', 'assets/theme.css']);
assert.deepEqual(
  [...collectRelativeAssetRefs(
    '<script src="/preview/run-1/custom/asset?id=webflow.js"></script>'
  )],
  ['assets/webflow.js']
);

assert.equal(
  rewriteCssForStaticPreview('src:url(localasset://brand.woff)'),
  'src:url(brand.woff)'
);
assert.equal(
  rewriteCssForStaticPreview('src:url(/preview/run-1/step/1/asset?id=brand.woff)'),
  'src:url(brand.woff)'
);

const urls = makerAssetFetchUrls({
  makerBase: 'http://192.168.68.92:3000',
  runId: 'run-1',
  exportStep: 'custom',
  assetPath: 'assets/theme.css',
});
assert.ok(urls[0].includes('/preview/run-1/custom/asset?id=theme.css'));
assert.ok(urls.some((url) => url.includes('/preview/run-1/step/1/asset?id=theme.css')));

const zip = new AdmZip();
zip.addFile(
  'index.html',
  Buffer.from('<html><head><link href="assets/theme.css" rel="stylesheet"></head><body>ok</body></html>')
);
const files = new Map([
  [
    'http://maker.test/preview/run-1/custom/asset?id=theme.css',
    {
      ok: true,
      contentType: 'text/css',
      body: 'body{color:red} @font-face{src:url(localasset://brand.woff)}',
    },
  ],
  [
    'http://maker.test/preview/run-1/custom/asset?id=brand.woff',
    { ok: true, contentType: 'font/woff', body: 'wOFF' },
  ],
]);
const filled = await fillExportZipWithMakerAssets({
  makerBase: 'http://maker.test',
  runId: 'run-1',
  exportStep: 'custom',
  zipBuffer: zip.toBuffer(),
  fetchImpl: async (url) => {
    const hit = files.get(String(url));
    if (!hit) return { ok: false, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      headers: { get: () => hit.contentType },
      arrayBuffer: async () => Buffer.from(hit.body),
    };
  },
});
assert.equal(filled.added, 2);
const out = new AdmZip(filled.buffer);
assert.ok(out.getEntry('assets/theme.css'));
assert.ok(out.getEntry('assets/brand.woff'));
assert.match(out.getEntry('assets/theme.css').getData().toString('utf8'), /url\(brand\.woff\)/);

const emptyCssZip = new AdmZip();
emptyCssZip.addFile(
  'index.html',
  Buffer.from('<html><head><link href="assets/missing.css" rel="stylesheet"></head><body>x</body></html>')
);
await assert.rejects(
  () =>
    fillExportZipWithMakerAssets({
      makerBase: 'http://maker.test',
      runId: 'run-1',
      exportStep: 'custom',
      zipBuffer: emptyCssZip.toBuffer(),
      fetchImpl: async () => ({ ok: false, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) }),
    }),
  /missing CSS\/JS/
);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-css-'));
await fs.mkdir(path.join(tmp, 'assets'), { recursive: true });
await fs.writeFile(path.join(tmp, 'assets', 'theme.css'), 'body{color:red} @font-face{src:url(brand.woff)}', 'utf8');
const inlined = inlineLocalStylesheets(
  '<link rel="stylesheet" href="assets/theme.css"><body>Hi</body>',
  [tmp]
);
assert.match(inlined, /<style data-preview-css="theme.css">/);
assert.match(inlined, /url\(assets\/brand\.woff\)/);
assert.doesNotMatch(inlined, /<link rel="stylesheet"/);

const sharedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-css-'));
await fs.mkdir(path.join(sharedTmp, 'assets'), { recursive: true });
await fs.writeFile(path.join(sharedTmp, 'assets', 'theme.css'), 'body{color:red}', 'utf8');
await fs.writeFile(
  path.join(sharedTmp, 'index.html'),
  '<html><head><link rel="stylesheet" href="assets/theme.css"></head><body>home</body></html>',
  'utf8'
);
const shared = ensureSharedPreviewStyles(
  '<html><head><link rel="stylesheet" href="https://demo.example/home_v2.html/demo/assets/css/style.css"></head><body>about</body></html>',
  [sharedTmp]
);
assert.match(shared, /<style data-preview-css="theme.css">/);
assert.match(shared, /body\{color:red\}/);
assert.doesNotMatch(shared, /home_v2\.html/);
await fs.rm(sharedTmp, { recursive: true, force: true });
await fs.rm(tmp, { recursive: true, force: true });

const inlinedOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-only-'));
await fs.writeFile(
  path.join(inlinedOnly, 'index.html'),
  '<html><head><link href="assets/theme.css" rel="stylesheet"><style data-preview-css="theme.css">body{color:red}</style></head><body>ok</body></html>',
  'utf8'
);
assertImportedPreviewHasAssets(inlinedOnly);
await fs.rm(inlinedOnly, { recursive: true, force: true });

const recovered = await recoverMissingStylesheets(
  '<html><head><link rel="stylesheet" href="assets/missing.css"><script src="assets/app.js"></script></head><body><img src="https://demo.example.com/hero.jpg"></body></html>',
  {
    fetchImpl: async (url) => {
      if (String(url) === 'https://demo.example.com/') {
        return {
          ok: true,
          text: async () => '<link rel="stylesheet" href="/theme.css">',
          headers: { get: () => 'text/html' },
        };
      }
      if (String(url) === 'https://demo.example.com/theme.css') {
        return {
          ok: true,
          text: async () => 'body{color:blue}',
          headers: { get: () => 'text/css' },
        };
      }
      return { ok: false, text: async () => '', headers: { get: () => '' } };
    },
  }
);
assert.match(recovered, /data-preview-css="recovered"/);
assert.match(recovered, /body\{color:blue\}/);
assert.doesNotMatch(recovered, /assets\/missing\.css/);
assert.match(recovered, /assets\/app\.js/);

const recoveredNested = await recoverMissingStylesheets(
  '<html><head><link rel="stylesheet" href="assets/missing.css"></head><body><img src="https://demo.example.com/main-demo/hero.jpg"></body></html>',
  {
    fetchImpl: async (url) => {
      if (String(url) === 'https://demo.example.com/') {
        return { ok: true, text: async () => '<html></html>', headers: { get: () => 'text/html' } };
      }
      if (String(url) === 'https://demo.example.com/main-demo/') {
        return {
          ok: true,
          text: async () => '<link rel="stylesheet" href="/wp-content/theme.css">',
          headers: { get: () => 'text/html' },
        };
      }
      if (String(url) === 'https://demo.example.com/wp-content/theme.css') {
        return { ok: true, text: async () => 'h1{color:green}', headers: { get: () => 'text/css' } };
      }
      return { ok: false, text: async () => '', headers: { get: () => '' } };
    },
  }
);
assert.match(recoveredNested, /h1\{color:green\}/);
assert.match(recoveredNested, /data-preview-css="recovered"/);

const recoveredIgnoresSvgXmlns = await recoverMissingStylesheets(
  `<html><head><link rel="stylesheet" href="assets/missing.css"></head><body>
    ${'<svg xmlns="http://www.w3.org/2000/svg"></svg>'.repeat(20)}
    <img src="https://themepanthers.com/wp/nest/d1/wp-content/uploads/hero.jpg">
    <link rel="shortlink" href="https://themepanthers.com/wp/nest/d1/">
  </body></html>`,
  {
    fetchImpl: async (url) => {
      if (/w3\.org/i.test(String(url))) {
        throw new Error(`must not fetch w3.org: ${url}`);
      }
      if (String(url) === 'https://themepanthers.com/wp/nest/d1/') {
        return {
          ok: true,
          text: async () => '<link rel="stylesheet" href="/wp-content/themes/nest/style.css">',
          headers: { get: () => 'text/html' },
        };
      }
      if (String(url) === 'https://themepanthers.com/wp-content/themes/nest/style.css') {
        return {
          ok: true,
          text: async () => 'body{font-family:Quicksand}',
          headers: { get: () => 'text/css' },
        };
      }
      return { ok: false, text: async () => '', headers: { get: () => '' } };
    },
  }
);
assert.match(recoveredIgnoresSvgXmlns, /font-family:Quicksand/);
assert.doesNotMatch(recoveredIgnoresSvgXmlns, /recovered from [^"']*w3\.org/);

console.log('preview-bundle-assets tests passed');

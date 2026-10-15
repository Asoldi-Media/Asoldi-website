import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import {
  embedSrcFromRequest,
  hrefForPreviewRoute,
  labelForPreviewRoute,
  listSalesPreviewPages,
  pagesFromSitemapXml,
  previewBaseFromRequestPath,
  previewWantsEmbed,
  renderSalesPreviewChrome,
  routeFromPreviewRelativePath,
} from '../lib/sales-preview-pages.js';

assert.equal(routeFromPreviewRelativePath(''), '/');
assert.equal(routeFromPreviewRelativePath('index.html'), '/');
assert.equal(routeFromPreviewRelativePath('shop'), '/shop');
assert.equal(routeFromPreviewRelativePath('shop/index.html'), '/shop');
assert.equal(
  routeFromPreviewRelativePath('product/handmade-rainbow-mosaic-candle-holder/index.html'),
  '/product/handmade-rainbow-mosaic-candle-holder'
);
assert.equal(labelForPreviewRoute('/'), 'Hjem');
assert.equal(labelForPreviewRoute('/about-us'), 'About Us');
assert.equal(previewBaseFromRequestPath('/sales-preview/garnstogo/shop', 'id-1'), '/sales-preview/garnstogo/');
assert.equal(
  hrefForPreviewRoute('/sales-preview/client-1/', '/shop'),
  '/sales-preview/client-1/shop?asoldi-embed=1'
);

assert.equal(previewWantsEmbed({ query: { 'asoldi-embed': '1' } }), true);
assert.equal(previewWantsEmbed({ headers: { 'sec-fetch-dest': 'iframe' } }), true);
assert.equal(
  previewWantsEmbed({
    get: (name) => (name === 'sec-fetch-dest' ? 'document' : ''),
    query: {},
  }),
  false
);
assert.equal(
  embedSrcFromRequest({ originalUrl: '/sales-preview/client-1/shop' }),
  '/sales-preview/client-1/shop?asoldi-embed=1'
);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://asoldi.com/sales-preview/client-1/</loc></url>
  <url><loc>https://asoldi.com/sales-preview/client-1/shop</loc></url>
  <url><loc>https://asoldi.com/sales-preview/client-1/about-us</loc></url>
</urlset>`;
const fromSitemap = pagesFromSitemapXml(sitemap, ['/sales-preview/client-1']);
assert.deepEqual(
  fromSitemap.map((page) => page.route),
  ['/', '/about-us', '/shop']
);
assert.equal(fromSitemap[0].label, 'Hjem');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'sales-preview-pages-'));
try {
  await writeFile(path.join(tmp, 'index.html'), '<html></html>');
  await mkdir(path.join(tmp, 'shop'), { recursive: true });
  await writeFile(path.join(tmp, 'shop', 'index.html'), '<html></html>');
  await mkdir(path.join(tmp, 'assets'), { recursive: true });
  await writeFile(path.join(tmp, 'assets', 'x.html'), '<html></html>');
  const walked = await listSalesPreviewPages(tmp, { clientId: 'client-1' });
  assert.deepEqual(
    walked.map((page) => page.route),
    ['/', '/shop']
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const chrome = renderSalesPreviewChrome({
  previewBase: '/sales-preview/client-1/',
  pages: [
    { route: '/', label: 'Hjem' },
    { route: '/shop', label: 'Shop' },
  ],
  currentRoute: '/',
  iframeSrc: '/sales-preview/client-1/?asoldi-embed=1',
  title: 'Garnstogo',
});
assert.match(chrome, /id="asoldi-preview-chrome"/);
assert.match(chrome, /<label[^>]*>Sider<\/label>/);
assert.match(chrome, /<select id="asoldi-preview-pages">/);
assert.match(chrome, /Garnstogo/);
assert.match(chrome, /iframe id="asoldi-preview-frame"/);
assert.match(chrome, /\/sales-preview\/client-1\/shop\?asoldi-embed=1/);
assert.doesNotMatch(chrome, /Signer kontrakt/);

console.log('sales-preview-pages tests passed');

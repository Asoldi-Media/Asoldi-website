import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAN_ASOLDI_ORIGIN,
  PUBLIC_SALES_ORIGIN,
  buildLaptopPreviewEntry,
  buildMakerExportUrl,
  buildPreviewBundleUploadUrl,
  buildPublicSalesPreviewUrl,
  buildSalesPreviewPath,
  clientNeedsPublicPreviewSnapshot,
  injectPreviewBaseHref,
  injectPreviewRobotsMeta,
  injectSalesPreviewContractWidget,
  isPreviewCrawler,
  isPreviewProtectedPath,
  PREVIEW_ROBOTS_TAG,
  isAllowedPreviewBridgeExportUrl,
  isAllowedPreviewBundleUploadUrl,
  isPrivateMakerUrl,
  lanAsoldiOriginFromMakerUrl,
  rewritePreviewAssetPaths,
  rewriteMakerPreviewRefs,
  toPublicSalesPreviewUrl,
} from '../lib/laptop-preview.js';

assert.equal(buildSalesPreviewPath('abc 1'), '/sales-preview/abc%201/');
assert.equal(buildPublicSalesPreviewUrl('client-1'), `${PUBLIC_SALES_ORIGIN}/sales-preview/client-1/`);
assert.equal(
  toPublicSalesPreviewUrl('/sales-preview/client-1/', 'client-1'),
  `${PUBLIC_SALES_ORIGIN}/sales-preview/client-1/`
);
assert.equal(
  toPublicSalesPreviewUrl('http://192.168.68.92:3200/sales-preview/client-1/', 'client-1'),
  `${PUBLIC_SALES_ORIGIN}/sales-preview/client-1/`
);
assert.equal(
  toPublicSalesPreviewUrl('https://random.trycloudflare.com/preview/run-9/step/3/view?route=/', 'client-1'),
  `${PUBLIC_SALES_ORIGIN}/sales-preview/client-1/`
);

assert.equal(buildLaptopPreviewEntry({ id: 'x' }), null);
assert.equal(buildLaptopPreviewEntry({ id: 'client-1', makerRun: { runId: 'run-9' } }), null);

const entry = buildLaptopPreviewEntry({
  id: 'client-1',
  businessName: 'Mong Sushi',
  websiteImport: {
    previewUrl: '/sales-preview/client-1/',
    importedAt: '2026-08-14T12:00:00.000Z',
  },
  makerRun: { runId: 'run-9' },
});
assert.equal(entry.publicPreviewUrl, `${PUBLIC_SALES_ORIGIN}/sales-preview/client-1/`);
assert.equal(entry.laptopUrl, entry.publicPreviewUrl);

assert.equal(isPrivateMakerUrl('http://192.168.68.92:3000'), true);
assert.equal(isPrivateMakerUrl('https://asoldi.com'), false);
assert.equal(
  lanAsoldiOriginFromMakerUrl('http://192.168.68.92:3000/preview/run-9'),
  'http://192.168.68.92:3200'
);
assert.equal(lanAsoldiOriginFromMakerUrl('https://asoldi.com'), LAN_ASOLDI_ORIGIN);

const exportUrl = buildMakerExportUrl({
  makerBaseUrl: 'http://192.168.68.92:3000',
  runId: 'run-9',
  clientId: '1785835834488-xz9wdd',
  siteFolder: 'Mong Sushi',
});
assert.equal(
  exportUrl.startsWith('http://192.168.68.92:3000/api/runs/run-9/export?'),
  true
);
assert.equal(
  decodeURIComponent(new URL(exportUrl).searchParams.get('baseUrl')),
  `${PUBLIC_SALES_ORIGIN}/sales-preview/1785835834488-xz9wdd/`
);

assert.equal(
  buildPreviewBundleUploadUrl('1785835834488-xz9wdd'),
  `${PUBLIC_SALES_ORIGIN}/api/admin/sales/1785835834488-xz9wdd/receive-preview-bundle`
);
assert.equal(
  isAllowedPreviewBridgeExportUrl(
    'http://192.168.68.92:3000/api/runs/run-9/export?step=latest'
  ),
  true
);
assert.equal(
  isAllowedPreviewBridgeExportUrl('https://evil.example/api/runs/run-9/export'),
  false
);
assert.equal(
  isAllowedPreviewBundleUploadUrl(
    `${PUBLIC_SALES_ORIGIN}/api/admin/sales/client-1/receive-preview-bundle`
  ),
  true
);
assert.equal(
  isAllowedPreviewBundleUploadUrl('https://evil.example/api/admin/sales/client-1/receive-preview-bundle'),
  false
);

assert.equal(
  clientNeedsPublicPreviewSnapshot({
    id: '1785835834488-xz9wdd',
    makerRun: { runId: 'run-9' },
  }),
  true
);
assert.equal(
  clientNeedsPublicPreviewSnapshot({
    id: '1785835834488-xz9wdd',
    makerRun: { runId: 'run-9' },
    websiteImport: { importRoot: '/data/sales-site-imports/1785835834488-xz9wdd' },
  }),
  false
);
assert.equal(
  injectPreviewBaseHref('<html><head><title>x</title></head></html>', 'client-1'),
  '<html><head><base href="/sales-preview/client-1/"><title>x</title></head></html>'
);

const withBody = injectSalesPreviewContractWidget(
  '<html><body><p>site</p></body></html>',
  'client-1'
);
assert.match(withBody, /src="\/sales-preview-contract\.js"/);
assert.match(withBody, /data-sales-client-id="client-1"/);
assert.equal(
  withBody,
  '<html><body><p>site</p><script src="/sales-preview-contract.js" data-sales-client-id="client-1" charset="utf-8" defer></script></body></html>'
);
assert.equal(
  injectSalesPreviewContractWidget(withBody, 'client-1'),
  withBody
);
assert.equal(
  injectSalesPreviewContractWidget('<p>no body</p>', 'client-1'),
  '<p>no body</p><script src="/sales-preview-contract.js" data-sales-client-id="client-1" charset="utf-8" defer></script>'
);
assert.equal(injectSalesPreviewContractWidget('<p>x</p>', ''), '<p>x</p>');

// Root-absolute assets must be pulled back inside the preview folder.
assert.equal(
  rewritePreviewAssetPaths('<link rel="stylesheet" href="/css/style.css">', 'client-1'),
  '<link rel="stylesheet" href="/sales-preview/client-1/css/style.css">'
);
assert.equal(
  rewritePreviewAssetPaths('<img src="/img/a.png" srcset="/img/a.png 1x, /img/b.png 2x">', 'client-1'),
  '<img src="/sales-preview/client-1/img/a.png" srcset="/sales-preview/client-1/img/a.png 1x, /sales-preview/client-1/img/b.png 2x">'
);
assert.equal(
  rewritePreviewAssetPaths('body{background:url("/img/bg.jpg")}', 'client-1'),
  'body{background:url("/sales-preview/client-1/img/bg.jpg")}'
);
assert.equal(
  rewritePreviewAssetPaths('<a href="//cdn.example.com/x.css">', 'client-1'),
  '<a href="//cdn.example.com/x.css">'
);
assert.equal(
  rewritePreviewAssetPaths('<a href="https://example.com/x">', 'client-1'),
  '<a href="https://example.com/x">'
);
assert.equal(
  rewritePreviewAssetPaths('<a href="relative/page.html">', 'client-1'),
  '<a href="relative/page.html">'
);
assert.equal(
  rewritePreviewAssetPaths('<a href="/sales-preview/client-1/page.html">', 'client-1'),
  '<a href="/sales-preview/client-1/page.html">'
);
assert.equal(
  rewritePreviewAssetPaths('<link href="localasset://theme.css" rel="stylesheet">', 'client-1'),
  '<link href="assets/theme.css" rel="stylesheet">'
);

assert.equal(
  rewriteMakerPreviewRefs(
    '<script src="/preview/81809674-2f51-4ae2-9587-20a128dc1591/custom/asset?id=0e3fe9e1bf0a4a5c.js"></script>'
  ),
  '<script src="assets/0e3fe9e1bf0a4a5c.js"></script>'
);
assert.equal(
  rewriteMakerPreviewRefs(
    '<script src="http://localhost:3000/preview/run-9/step/2/asset?id=webflow.js"></script><a href="/preview/run-9/custom?route=%2Fmeny">Meny</a>'
  ),
  '<script src="assets/webflow.js"></script><a href="./meny">Meny</a>'
);
assert.equal(
  rewritePreviewAssetPaths(
    '<script src="/preview/run-9/custom/asset?id=webflow.js"></script><a href="/preview/run-9/custom?route=%2Fmeny">Meny</a>',
    'client-1'
  ),
  '<script src="/sales-preview/client-1/assets/webflow.js"></script><a href="/sales-preview/client-1/meny">Meny</a>'
);
assert.equal(
  rewritePreviewAssetPaths(
    '<script src="./preview/run-9/custom/asset?id=gsap.js"></script>',
    'client-1'
  ),
  '<script src="/sales-preview/client-1/assets/gsap.js"></script>'
);

assert.equal(isPreviewCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
assert.equal(isPreviewCrawler('Mozilla/5.0 AppleWebKit GPTBot/1.0'), true);
assert.equal(isPreviewCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0'), false);
assert.equal(isPreviewProtectedPath('/sales-preview/abc/'), true);
assert.equal(isPreviewProtectedPath('/previews'), true);
assert.equal(isPreviewProtectedPath('/pricing'), false);

const withMeta = injectPreviewRobotsMeta('<html><head><meta name="robots" content="index,follow"><title>x</title></head></html>');
assert.match(withMeta, /noindex,nofollow,noarchive,nosnippet,noimageindex/);
assert.match(withMeta, /name="referrer" content="no-referrer"/);
assert.equal(withMeta.includes('index,follow'), false);
assert.equal(PREVIEW_ROBOTS_TAG.includes('noindex'), true);

const robotsTxt = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
assert.match(robotsTxt, /Disallow: \/sales-preview/);
assert.match(robotsTxt, /Disallow: \/live-preview/);
assert.match(robotsTxt, /Disallow: \/previews/);
assert.match(robotsTxt, /User-agent: Googlebot/);

console.log('laptop-preview tests passed');

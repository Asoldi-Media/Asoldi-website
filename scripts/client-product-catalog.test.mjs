import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogsToLegacyProducts,
  coerceCatalogLayout,
  legacyProductsToCatalogs,
  mergeImportedCatalogs,
  resolvePortalCatalogs,
  summarizeCatalogs,
} from '../lib/client-product-catalog.js';
import { parseKoldtbordText } from '../lib/ai-assistant/products-import-deterministic.js';
import { makerBundleToClientDataBank } from '../lib/maker-bundle-to-bank.js';
import { detectLayoutFromIndustry, detectLayoutFromEvidence, parseLayoutChoice } from '../lib/ai-assistant/layout-detect.js';
import {
  collectHtmlProducts,
  detectStorePlatform,
  extractJsonLdProducts,
  extractJsImportUrls,
  extractPricedMenuItems,
  extractPricedRecordsFromSource,
  extractPricingCards,
  extractSameOriginLinks,
  isLikelyProductHref,
  looksLikeJsShell,
  mapShopifyProductsJson as mapShopify,
  mapWooStoreProducts,
  formatWooStorePrice,
} from '../lib/ai-assistant/products-scrape.js';
import { isPrivateIp, parsePublicHttpUrl } from '../lib/ai-assistant/safe-url.js';
import { extractUrlsFromText, shouldIngestSources } from '../lib/ai-assistant/products-ingest.js';
import { extractFirstUrl } from '../lib/ai-assistant/chat.js';

test('legacy kundedata products migrate into a normal catalog', () => {
  const legacy = [{
    id: 'cat-1',
    categoryName: 'Kaker',
    items: [{ id: 'p1', title: 'Marsipankake', price: '450', description: '8 bit', imageUrl: '/img/kake.jpg' }],
  }];
  const catalogs = legacyProductsToCatalogs(legacy);
  assert.equal(catalogs[0].layout, 'normal');
  assert.equal(catalogs[0].categories[0].name, 'Kaker');
  assert.equal(catalogs[0].categories[0].products[0].title, 'Marsipankake');
  assert.equal(catalogs[0].categories[0].products[0].imageUrl, '/img/kake.jpg');
});

test('resolvePortalCatalogs prefers productCatalogs and mirrors legacy products', () => {
  const resolved = resolvePortalCatalogs({
    productCatalogs: [{
      layout: 'meny',
      categories: [{
        name: 'Forretter',
        products: [{ title: 'Suppe', price: '129', allergens: 'gluten', extraOptions: [{ name: 'Brød', price: '20' }] }],
      }],
    }],
    products: [{ categoryName: 'Old', items: [{ title: 'Should not win' }] }],
  });
  assert.equal(resolved.productCatalogs[0].layout, 'meny');
  assert.equal(resolved.products[0].categoryName, 'Forretter');
  assert.equal(resolved.products[0].items[0].title, 'Suppe');
});

test('summarizeCatalogs counts categories and products', () => {
  const summary = summarizeCatalogs([{
    layout: 'tiers',
    categories: [
      { name: 'Pakker', products: [{ title: 'Basic', included: ['1 bruker'] }, { title: 'Pro', included: ['5 brukere'] }] },
    ],
  }]);
  assert.equal(summary.layout, 'tiers');
  assert.equal(summary.categoryCount, 1);
  assert.equal(summary.productCount, 2);
  assert.equal(summary.categories[0].name, 'Pakker');
});

test('industry detection picks meny / tiers / normal', () => {
  assert.equal(detectLayoutFromIndustry('Restaurant i Trondheim').layout, 'meny');
  assert.equal(detectLayoutFromIndustry('SaaS-abonnement').layout, 'tiers');
  assert.equal(detectLayoutFromIndustry('Blomsterbutikk').layout, 'normal');
  assert.equal(detectLayoutFromIndustry('').layout, null);
});

test('evidence and typed layout choice', () => {
  assert.equal(detectLayoutFromEvidence('Forrett Hovedrett Allergener', '').layout, 'meny');
  assert.equal(parseLayoutChoice('Vi vil ha meny'), 'meny');
  assert.equal(parseLayoutChoice('tiers / pakker'), 'tiers');
});

test('legacy mirror round-trips catalog titles', () => {
  const catalogs = legacyProductsToCatalogs([{
    categoryName: 'Retail',
    items: [{ title: 'Lampe', price: '799', description: 'LED' }],
  }]);
  const legacy = catalogsToLegacyProducts(catalogs);
  assert.equal(legacy[0].items[0].title, 'Lampe');
});

test('public Woo store API maps into categories without API keys', () => {
  assert.equal(formatWooStorePrice({ price: '129900', currency_minor_unit: 2 }), '1299 kr');
  const catalog = mapWooStoreProducts([
    {
      name: 'JOOLA Backpack Vision PRO',
      short_description: '<p>Sekk</p>',
      prices: { price: '89900', regular_price: '99900', currency_minor_unit: 2 },
      images: [{ src: 'https://shop.example/wp-content/uploads/bag.jpg' }],
      categories: [{ name: 'Tilbehør' }],
    },
  ], { layout: 'normal' });
  assert.equal(catalog.categories[0].name, 'Tilbehør');
  assert.equal(catalog.categories[0].products[0].title, 'JOOLA Backpack Vision PRO');
  assert.equal(catalog.categories[0].products[0].price, '899 kr');
  assert.equal(catalog.categories[0].products[0].comparePrice, '999 kr');
});

test('public Shopify JSON maps into categories without API keys', () => {
  const catalog = mapShopify({
    products: [
      {
        title: 'Hoodie',
        body_html: '<p>Warm</p>',
        product_type: 'Klær',
        variants: [{ price: '599', compare_at_price: '799' }],
        images: [{ src: 'https://cdn.example.com/hoodie.jpg' }],
      },
      {
        title: 'Kopp',
        product_type: 'Interiør',
        variants: [{ price: '199' }],
      },
    ],
  }, { layout: 'normal' });
  assert.equal(catalog.layout, 'normal');
  assert.equal(catalog.categories.length, 2);
  const clothes = catalog.categories.find((row) => row.name === 'Klær');
  assert.equal(clothes.products[0].title, 'Hoodie');
  assert.equal(clothes.products[0].comparePrice, '799');
  assert.equal(clothes.products[0].imageUrl, 'https://cdn.example.com/hoodie.jpg');
});

test('store platform is detected from public HTML, never from a client name', () => {
  assert.equal(detectStorePlatform({
    html: '<script>window.Shopify = {theme:{}}</script><link href="https://cdn.shopify.com/s/files/1/x.css">',
    url: 'https://any-shop.example/collections/all',
  }).platform, 'shopify');
  assert.equal(detectStorePlatform({
    html: '<body class="woocommerce"><div class="wc-block-grid"></div>',
    url: 'https://any-store.example/shop',
  }).platform, 'woocommerce');
  assert.equal(detectStorePlatform({
    html: '<main><h1>Lunsjmeny</h1><p>Suppe 129 kr</p></main>',
    url: 'https://kafe.example/meny',
  }).platform, 'custom');
});

test('custom HTML crawl reads JSON-LD menus and priced lines without Woo markup', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Menu","hasMenuSection":{"@type":"MenuSection","name":"Drikke","hasMenuItem":{"@type":"MenuItem","name":"Cortado","offers":{"price":"42"}}}}</script>
    <article class="product-card"><h3>Lampe</h3><span>799 kr</span><img src="/lampe.jpg"></article>
  `;
  const products = collectHtmlProducts(html);
  assert.ok(products.some((row) => row.title === 'Cortado' && row.price === '42'));
  assert.ok(products.some((row) => row.title === 'Lampe' && /799/.test(row.price)));
  const menu = extractPricedMenuItems('<p>Toast 89 kr</p><p>Nav</p>');
  assert.equal(menu[0].title, 'Toast');
});

test('JSON-LD products and same-origin product links extract', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"Latte","offers":{"price":"49"},"image":"https://cafe.no/latte.jpg"}</script>
    <a href="/meny/frokost">Frokost</a>
    <a href="https://other.com/product/x">skip</a>
  `;
  const products = extractJsonLdProducts(html);
  assert.equal(products[0].title, 'Latte');
  assert.equal(products[0].price, '49');
  const links = extractSameOriginLinks(html, 'https://cafe.no/');
  assert.ok(links.includes('https://cafe.no/meny/frokost'));
  assert.equal(isLikelyProductHref('/products/hoodie'), true);
});

test('catalog URLs include pricing, plans and services, not account chrome', () => {
  assert.equal(isLikelyProductHref('/pricing'), true);
  assert.equal(isLikelyProductHref('/priser'), true);
  assert.equal(isLikelyProductHref('/tjenester'), true);
  assert.equal(isLikelyProductHref('/services/web-development'), true);
  assert.equal(isLikelyProductHref('/pakker'), true);
  assert.equal(isLikelyProductHref('/about'), false);
  assert.equal(isLikelyProductHref('/login'), false);
  assert.equal(isLikelyProductHref('/kunde/ai-assistant'), false);
});

test('JS shells are detected and priced objects are read from bundles', () => {
  const shell = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';
  assert.equal(looksLikeJsShell(shell), true);
  assert.equal(looksLikeJsShell('<main><h1>Meny</h1><p>Toast 89 kr</p></main>'), false);
  const bundle = `
    const c=[{id:"tier-1-standard",name:"Tier 1: Standard",shortName:"Starter",description:"Simpel nettside.",monthlyExMva:999,includes:["Hosting","Kontaktskjema"]},
    {id:"Starter",name:"Starter",description:"Sosiale medier.",normalPrice:"1 999,-/mnd",features:["Strategi","Rapportering"]},
    {id:"mail",name:"Starter",price:"1 499,-/mnd",description:"E-post pakke.",includedFeatures:["2 kampanjer per måned","Kalender"]},
    {id:"skreddersydd",name:"Skreddersydd",price:"Etter avtale",description:"Avanserte behov.",includedFeatures:["API-integrasjoner"]}];
  `;
  const products = extractPricedRecordsFromSource(bundle);
  assert.ok(products.some((row) => row.title === 'Starter' && /999/.test(row.price) && /mnd/.test(row.price)));
  assert.ok(products.some((row) => row.title === 'Starter' && /1 999/.test(row.price)));
  assert.ok(products.some((row) => row.title === 'Starter' && /1 499/.test(row.price)));
  assert.ok(products.some((row) => row.title === 'Skreddersydd' && /avtale/i.test(row.price)));
  const imports = extractJsImportUrls(
    'import{t as M}from"./website-tiers-aaa.js";const x="assets/Pricing-bbb.js"',
    'https://agency.example/assets/index-ccc.js',
  );
  assert.ok(imports.includes('https://agency.example/assets/website-tiers-aaa.js'));
  assert.ok(imports.includes('https://agency.example/assets/Pricing-bbb.js'));
});

test('pricing cards and Service JSON-LD extract without shop markup', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Offer","name":"SEO-pakke","price":"1499","priceCurrency":"NOK"}</script>
    <article class="pricing-card"><h3>Vekst</h3><p>2 999,-/mnd</p><ul><li>Profiloptimalisering</li><li>Annonser</li></ul></article>
  `;
  const products = collectHtmlProducts(html);
  assert.ok(products.some((row) => row.title === 'SEO-pakke' && /1499/.test(row.price)));
  const cards = extractPricingCards(html);
  assert.equal(cards[0].title, 'Vekst');
  assert.match(cards[0].price, /2 999/);
  assert.ok(cards[0].included.includes('Profiloptimalisering'));
});

test('SSRF guard blocks private hosts and allows https shops', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.0.5'), true);
  assert.throws(() => parsePublicHttpUrl('http://shop.no'), /https/);
  assert.throws(() => parsePublicHttpUrl('https://localhost/admin'), /adressen/);
  assert.throws(() => parsePublicHttpUrl('https://192.168.1.10/products'), /Interne/);
  const ok = parsePublicHttpUrl('https://butikk.no/meny');
  assert.equal(ok.hostname, 'butikk.no');
});

test('chat extracts the first public URL', () => {
  assert.equal(extractFirstUrl('se https://butikk.no/produkter takk'), 'https://butikk.no/produkter');
});

test('natural chat finds a bare domain and does not ingest "pris" small talk', () => {
  const spoken = 'jeg har ingen filer, men sjekk ut asoldi.com for prisene på produkter';
  const urls = extractUrlsFromText(spoken);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/asoldi\.com\/?$/);
  assert.equal(extractFirstUrl(spoken), urls[0]);
  assert.equal(shouldIngestSources({ text: spoken }), true);
  assert.equal(shouldIngestSources({ text: 'hva slags priser bruker dere egentlig?' }), false);
  assert.equal(shouldIngestSources({ text: 'Toast 89 kr\nKaffe 45 kr\nBolle 30 kr' }), true);
  assert.equal(extractUrlsFromText('skriv til hei@asoldi.com').length, 0);
  assert.match(extractFirstUrl('sjekk www.topspin.no/meny'), /topspin\.no\/meny/);
});

test('explicit cake catalog stays normal even when industry is restaurant', () => {
  const coerced = coerceCatalogLayout({
    layout: 'normal',
    label: 'Kaker',
    categories: [{ name: 'Kaker', products: [{ title: 'Marsipankake' }] }],
  }, 'restaurant café meny');
  assert.equal(coerced.layout, 'normal');
});

test('summarize and merge keep separate Maker catalogs', () => {
  const merged = mergeImportedCatalogs([], [
    { layout: 'meny', label: 'Meny', categories: [{ name: 'Drikke', products: [{ title: 'Kaffe', price: '45 kr' }] }] },
    { layout: 'meny', label: 'Tapas', categories: [{ name: 'Tapas', products: [{ title: 'Tapas', included: ['Reker'] }] }] },
    { layout: 'normal', label: 'Kaker', categories: [{ name: 'Kaker', products: [{ title: 'Ostekake', price: '380 kr' }] }] },
  ]);
  assert.equal(merged.length, 3);
  const summary = summarizeCatalogs(merged);
  assert.equal(summary.productCount, 3);
  assert.equal(summary.catalogCount, 3);
  assert.match(summary.layoutLabel, /Meny/);
  assert.match(summary.layoutLabel, /Kaker/);
});

test('koldtbord parser recovers run-on PDF text and extras', () => {
  const parsed = parseKoldtbordText('KOLDTBORD Alternativ 1 Roastbiff med remulade Egg og reker Kr: 355,- Alternativ 2 Samme som alternativ 1, men med karbonade Kr: 405,- I tillegg pr pers: Vilt-gryte med ris: 185,- Biff-gryte med ris: 155,- Salat med rømmedressing: 35,-');
  assert.equal(parsed.label, 'Koldtbord');
  assert.equal(parsed.categories[0].products[0].name, 'Alternativ 1');
  assert.ok(parsed.categories[0].products[0].included.includes('Roastbiff med remulade'));
  const extras = parsed.categories[1].products.map((row) => row.name);
  assert.ok(extras.includes('Salat med rømmedressing'));
});

test('maker bundle maps CLIENT_FIELDS into kundedata', () => {
  const bank = makerBundleToClientDataBank({
    id: 'bundle-1',
    name: 'Byneset Bydelskafe',
    data: {
      businessName: 'Byneset Bydelskafe',
      industry: 'restaurant',
      email: 'freidis.g.dahl@hotmail.com',
      businessWhat: 'Nabolagskafe',
      reviews: 'Koselig',
      town: 'Trondheim',
    },
    productCatalogs: [{
      layout: 'meny',
      label: 'Meny',
      categories: [{ name: 'Drikke', products: [{ name: 'Kaffe', price: '45 kr' }] }],
    }],
  }, {});
  assert.equal(bank.businessCard.companyName, 'Byneset Bydelskafe');
  assert.equal(bank.generalInfo.companyEmail, 'freidis.g.dahl@hotmail.com');
  assert.equal(bank.websiteCreatorQuestions.businessWhat, 'Nabolagskafe');
  assert.equal(bank.websiteCreatorQuestions.reviews, 'Koselig');
  assert.equal(bank.websiteCreatorQuestions.town, 'Trondheim');
  assert.equal(bank.productCatalogs[0].categories[0].products[0].title, 'Kaffe');
  assert.equal(bank.makerLink.bundleId, 'bundle-1');
});

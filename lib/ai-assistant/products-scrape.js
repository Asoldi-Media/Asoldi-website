/**
 * Universal public product scrape. Detect the store platform from HTML/URL,
 * then use that platform's public catalog if it exists (Woo Store API,
 * Shopify /products.json, WP REST, BigCommerce storefront). Otherwise crawl
 * JSON-LD, microdata, generic product cards, and priced menu lines.
 * Never key on a client name or one shop's markup.
 */
import { assertPublicHttpUrl, parsePublicHttpUrl, sameOrigin } from './safe-url.js';
import { detectLayoutFromEvidence } from './layout-detect.js';
import {
  defaultCategoryName,
  normalizeProductCatalog,
  normalizeProductItem,
} from '../client-product-catalog.js';
import { saveClientUploadBuffer } from '../client-media-store.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGES = 30;
const MAX_PRODUCTS = 200;
const MAX_IMAGES = 80;
const MAX_HTML_BYTES = 1_800_000;
const MAX_IMAGE_BYTES = 6_000_000;
const PRODUCT_HREF =
  /(?:product|produkt|products|produkter|shop|butikk|meny|menu|collection|kategori|category|rett|dish)/i;

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
};

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value = '') {
  return compact(decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

export function isLikelyProductHref(href = '') {
  return PRODUCT_HREF.test(String(href || ''));
}

function imageUrlOf(node) {
  const image = Array.isArray(node?.image) ? node.image[0] : node?.image;
  if (typeof image === 'string') return compact(image);
  return compact(image?.url || image?.contentUrl || '');
}

function offerPriceOf(node) {
  const offer = Array.isArray(node?.offers) ? node.offers[0] : node?.offers;
  return compact(offer?.price || offer?.lowPrice || node?.price || '');
}

export function detectStorePlatform({ html = '', url = '' } = {}) {
  const hay = `${html}\n${url}`.toLowerCase();
  if (/cdn\.shopify\.com|shopify\.theme|myshopify\.com|\/cdn\/shop\/|shopify-section/i.test(hay)) {
    return { platform: 'shopify', confidence: 'high' };
  }
  if (/woocommerce|wc-block|wc-store|wp-json\/wc\/|wc-ajax|wp-content\/plugins\/woocommerce/i.test(hay)) {
    return { platform: 'woocommerce', confidence: 'high' };
  }
  if (/bigcommerce|stencil-utils|cdn11\.bigcommerce/i.test(hay)) {
    return { platform: 'bigcommerce', confidence: 'high' };
  }
  if (/static\.squarespace|squarespace-cdn|sqs-product/i.test(hay)) {
    return { platform: 'squarespace', confidence: 'medium' };
  }
  if (/parastorage|wixstatic|wix\.com\/store/i.test(hay)) {
    return { platform: 'wix', confidence: 'medium' };
  }
  return { platform: 'custom', confidence: 'low' };
}

export function extractJsonLdProducts(html = '') {
  const blocks = [...String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const products = [];
  const visit = (node, category = '') => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, category));
      return;
    }
    if (typeof node !== 'object') return;
    const type = String(node['@type'] || node.type || '');
    const nextCategory = compact(node.name) && /menusection|itemlist/i.test(type)
      ? compact(node.name)
      : category;
    if (/product|menuitem|dish|food/i.test(type) && compact(node.name) && !/menusection|menuitemlist/i.test(type)) {
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      products.push({
        title: compact(node.name),
        description: stripHtml(node.description),
        price: offerPriceOf(node),
        comparePrice: compact(offer?.highPrice || ''),
        imageUrl: imageUrlOf(node),
        category: compact(node.category || nextCategory || node.brand?.name || ''),
      });
    }
    if (node['@graph']) visit(node['@graph'], nextCategory);
    if (node.hasMenuSection) visit(node.hasMenuSection, nextCategory);
    if (node.hasMenuItem) visit(node.hasMenuItem, nextCategory);
    if (node.itemListElement) visit(node.itemListElement, nextCategory);
    if (node.item) visit(node.item, nextCategory);
  };
  for (const match of blocks) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // ignore broken json-ld
    }
  }
  return products.filter((row) => row.title);
}

export function extractSameOriginLinks(html = '', baseUrl) {
  const base = typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl;
  const hrefs = [...String(html || '').matchAll(/\bhref=["']([^"'#]+)["']/gi)].map((row) => row[1]);
  const out = [];
  const seen = new Set();
  for (const href of hrefs) {
    try {
      const resolved = new URL(href, base);
      if (!sameOrigin(resolved, base)) continue;
      resolved.hash = '';
      const key = resolved.href;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolved.href);
    } catch {
      // skip
    }
  }
  return out;
}

export function extractSitemapLocs(xml = '', baseUrl) {
  const locs = [...String(xml || '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((row) => compact(row[1]));
  return locs.filter((loc) => {
    try {
      return sameOrigin(loc, baseUrl);
    } catch {
      return false;
    }
  });
}

export function formatWooStorePrice(prices = {}) {
  const source = prices && typeof prices === 'object' ? prices : {};
  const minor = Number(source.currency_minor_unit ?? 2);
  const raw = compact(source.price || source.sale_price || source.regular_price);
  if (!raw) return '';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  const value = minor > 0 ? numeric / (10 ** minor) : numeric;
  const printed = Number.isInteger(value) ? String(value) : value.toFixed(Math.min(2, minor));
  return `${printed} kr`;
}

export function mapWooStoreProducts(rows = [], { layout = 'normal' } = {}) {
  const products = Array.isArray(rows) ? rows : [];
  const byCategory = new Map();
  for (const product of products.slice(0, MAX_PRODUCTS)) {
    const categoryName = compact(product?.categories?.[0]?.name || product?.category) || defaultCategoryName(layout);
    if (!byCategory.has(categoryName)) byCategory.set(categoryName, []);
    const image = Array.isArray(product?.images) ? product.images[0] : product?.images;
    const prices = product?.prices && typeof product.prices === 'object' ? product.prices : {};
    const price = formatWooStorePrice(prices);
    const regular = formatWooStorePrice({ ...prices, price: prices.regular_price });
    byCategory.get(categoryName).push(normalizeProductItem({
      title: stripHtml(product?.name || product?.title),
      description: stripHtml(product?.short_description || product?.description || ''),
      price,
      comparePrice: regular && regular !== price ? regular : '',
      imageUrl: compact(image?.src || image?.thumbnail || image?.url || ''),
    }, { keepEmpty: true }));
  }
  return normalizeProductCatalog({
    layout,
    label: layout === 'meny' ? 'Meny' : layout === 'tiers' ? 'Tiers' : 'Produkter',
    categories: [...byCategory.entries()].map(([name, items]) => ({ name, products: items })),
  }, { keepEmptyProducts: true });
}

function titleFromBlock(block = '') {
  return compact(
    (block.match(/<(?:h1|h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|h4)>/i) || [])[1]
    || (block.match(/itemprop=["']name["'][^>]*>([^<]+)/i) || [])[1]
    || (block.match(/<(?:a)[^>]*class=["'][^"']*(?:title|name|product)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1]
  );
}

function priceFromBlock(block = '') {
  return compact(
    (block.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || [])[1]
    || (block.match(/<(?:bdi|span)[^>]*>([^<]*\d[^<]*kr[^<]*)/i) || [])[1]
    || (block.match(/(\d+[.,]?\d*)\s*(?:kr|,-)/i) || [])[0]
    || (block.match(/amount[^>]*>([\s\S]*?)<\/(?:span|bdi)/i) || [])[1]
  );
}

function imageFromBlock(block = '') {
  return compact(
    (block.match(/<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i) || [])[1]
  );
}

export function extractWooLoopProducts(html = '') {
  const cards = [...String(html || '').matchAll(/<li[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)];
  const products = [];
  for (const card of cards) {
    const block = card[1] || '';
    const title = compact(
      (block.match(/woocommerce-loop-product__title[^>]*>([^<]+)/i) || [])[1]
      || titleFromBlock(block)
    );
    const price = compact(
      (block.match(/woocommerce-Price-amount[^>]*>[\s\S]*?<bdi[^>]*>([^<]+)/i) || [])[1]
      || priceFromBlock(block)
    );
    if (title) {
      products.push({
        title: stripHtml(title),
        price: stripHtml(price).replace(/&nbsp;/g, ' '),
        imageUrl: imageFromBlock(block),
      });
    }
  }
  return products;
}

export function extractMicrodataProducts(html = '') {
  const blocks = [...String(html || '').matchAll(/itemtype=["'][^"']*(?:Product|MenuItem|Offer)["'][^>]*>([\s\S]{0,4000}?)<\/(?:div|li|article|section|span)>/gi)];
  return blocks.map((card) => {
    const block = card[1] || '';
    return {
      title: stripHtml(titleFromBlock(block) || (block.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i) || [])[1]),
      description: stripHtml((block.match(/itemprop=["']description["'][^>]*>([\s\S]*?)<\//i) || [])[1]),
      price: stripHtml(priceFromBlock(block)),
      imageUrl: imageFromBlock(block),
    };
  }).filter((row) => row.title);
}

export function extractGenericProductCards(html = '') {
  const cards = [...String(html || '').matchAll(
    /<(article|li|div)([^>]*class=["'][^"']*(?:product|produkt|menu-item|meny-item|card-product|product-card|grid-item)[^"']*["'][^>]*)>([\s\S]{0,3500}?)<\/\1>/gi
  )];
  return cards.map((card) => {
    const block = card[3] || '';
    return {
      title: stripHtml(titleFromBlock(block)),
      description: stripHtml((block.match(/<(?:p|span)[^>]*class=["'][^"']*(?:desc|excerpt|summary)[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]),
      price: stripHtml(priceFromBlock(block)),
      imageUrl: imageFromBlock(block),
    };
  }).filter((row) => row.title && row.title.length >= 2 && row.title.length <= 120);
}

export function extractPricedMenuItems(html = '') {
  const lined = String(html || '')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const products = [];
  for (const raw of lined.split('\n')) {
    const line = stripHtml(raw);
    if (!line || line.length > 140) continue;
    const match = line.match(/^(.*?)(?:\s{1,}|\s*[.\u00b7•]+\s*)(\d+[.,]?\d*)\s*(?:kr|,-)?$/i);
    if (!match) continue;
    const title = compact(match[1]).replace(/[.\u00b7•:\-–]+$/g, '').trim();
    if (!title || title.length < 2 || /^(meny|menu|pris|price|kategori)$/i.test(title)) continue;
    if (!/\d/.test(match[2])) continue;
    products.push({
      title,
      price: `${match[2].replace(',', '.')} kr`.replace('. kr', ' kr'),
    });
  }
  return products;
}

export function collectHtmlProducts(html = '') {
  const merged = [
    ...extractJsonLdProducts(html),
    ...extractMicrodataProducts(html),
    ...extractWooLoopProducts(html),
    ...extractGenericProductCards(html),
  ];
  if (!merged.length) merged.push(...extractPricedMenuItems(html));
  return dedupeProducts(merged);
}

export function dedupeProducts(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = compact(row.title || row.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function mapWpRestProducts(rows = [], { layout = 'normal' } = {}) {
  const products = (Array.isArray(rows) ? rows : []).map((row) => {
    const title = stripHtml(row?.title?.rendered || row?.title || row?.name);
    const image = row?.featured_media_src_url
      || row?._embedded?.['wp:featuredmedia']?.[0]?.source_url
      || '';
    return normalizeProductItem({
      title,
      description: stripHtml(row?.excerpt?.rendered || row?.content?.rendered || ''),
      price: compact(row?.price || row?.meta?.price || ''),
      imageUrl: compact(image),
      category: compact(row?.product_cat?.[0] || ''),
    }, { keepEmpty: true });
  }).filter((row) => row.title);
  return catalogFromRawProducts(products, layout);
}

export function mapShopifyProductsJson(payload = {}, { layout = 'normal' } = {}) {
  const rows = Array.isArray(payload?.products) ? payload.products : [];
  const byCategory = new Map();
  for (const product of rows.slice(0, MAX_PRODUCTS)) {
    const categoryName = compact(product?.product_type) || defaultCategoryName(layout);
    if (!byCategory.has(categoryName)) byCategory.set(categoryName, []);
    const variant = Array.isArray(product?.variants) ? product.variants[0] : null;
    const image = Array.isArray(product?.images) ? product.images[0] : product?.image;
    const included = Array.isArray(product?.options)
      ? product.options.flatMap((option) => (option?.values || []).map((value) => compact(`${option.name}: ${value}`))).filter(Boolean)
      : [];
    byCategory.get(categoryName).push(normalizeProductItem({
      title: product?.title,
      description: stripHtml(product?.body_html || product?.description || ''),
      price: compact(variant?.price || ''),
      comparePrice: compact(variant?.compare_at_price || ''),
      imageUrl: compact(image?.src || image?.url || ''),
      allergens: /\ballerg/i.test(String(product?.tags || '')) ? compact(product.tags) : '',
      included: layout === 'tiers' ? included : [],
      extraOptions: [],
    }, { keepEmpty: true }));
  }
  return normalizeProductCatalog({
    layout,
    label: layout === 'meny' ? 'Meny' : layout === 'tiers' ? 'Tiers' : 'Normal',
    categories: [...byCategory.entries()].map(([name, products]) => ({ name, products })),
  }, { keepEmptyProducts: true });
}

function catalogFromRawProducts(rawProducts, layout) {
  const byCategory = new Map();
  for (const row of rawProducts.slice(0, MAX_PRODUCTS)) {
    const categoryName = compact(row.category) || defaultCategoryName(layout);
    if (!byCategory.has(categoryName)) byCategory.set(categoryName, []);
    byCategory.get(categoryName).push(normalizeProductItem(row, { keepEmpty: true }));
  }
  return normalizeProductCatalog({
    layout,
    categories: [...byCategory.entries()].map(([name, products]) => ({ name, products })),
  }, { keepEmptyProducts: true });
}

async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: accept ? { ...DEFAULT_HEADERS, Accept: accept } : DEFAULT_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, text: '', contentType: '' };
    const contentType = String(response.headers.get('content-type') || '');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_HTML_BYTES) {
      return { ok: true, status: response.status, text: buffer.subarray(0, MAX_HTML_BYTES).toString('utf8'), contentType };
    }
    return { ok: true, status: response.status, text: buffer.toString('utf8'), contentType, buffer };
  } catch {
    return { ok: false, status: 0, text: '', contentType: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadProductImages(userId, catalog, onProgress) {
  if (!userId || !catalog) return catalog;
  let downloaded = 0;
  const next = {
    ...catalog,
    categories: await Promise.all((catalog.categories || []).map(async (category) => ({
      ...category,
      products: await Promise.all((category.products || []).map(async (product) => {
        const source = compact(product.imageUrl || product.image);
        if (!source || downloaded >= MAX_IMAGES) return product;
        try {
          parsePublicHttpUrl(source);
          const result = await fetchText(source);
          if (!result.ok || !result.buffer || result.buffer.length > MAX_IMAGE_BYTES) return product;
          const ext = /\.webp(\?|$)/i.test(source) ? '.webp'
            : /\.png(\?|$)/i.test(source) ? '.png'
              : /\.gif(\?|$)/i.test(source) ? '.gif'
                : '.jpg';
          const saved = await saveClientUploadBuffer(userId, {
            buffer: result.buffer,
            originalName: `product${ext}`,
            prefix: 'prod',
          });
          downloaded += 1;
          onProgress?.({ downloaded, imageUrl: saved.url });
          return { ...product, imageUrl: saved.url, image: saved.url };
        } catch {
          return product;
        }
      })),
    }))),
  };
  return next;
}

function probeOrderFor(platform = 'custom') {
  if (platform === 'shopify') return ['shopify', 'woocommerce', 'wordpress', 'bigcommerce'];
  if (platform === 'woocommerce') return ['woocommerce', 'wordpress', 'shopify', 'bigcommerce'];
  if (platform === 'bigcommerce') return ['bigcommerce', 'shopify', 'woocommerce'];
  return ['woocommerce', 'shopify', 'wordpress', 'bigcommerce'];
}

async function probeWooStoreApi(origin) {
  const rows = [];
  const paths = ['/wp-json/wc/store/v1/products', '/wp-json/wc/store/products'];
  for (const path of paths) {
    for (let page = 1; page <= 8 && rows.length < MAX_PRODUCTS; page += 1) {
      const woo = await fetchText(`${origin}${path}?per_page=100&page=${page}`);
      if (!woo.ok) break;
      try {
        const parsed = JSON.parse(woo.text);
        if (!Array.isArray(parsed) || !parsed.length) break;
        rows.push(...parsed);
        if (parsed.length < 100) break;
      } catch {
        break;
      }
    }
    if (rows.length) return rows.slice(0, MAX_PRODUCTS);
  }
  return [];
}

async function probeShopifyProducts(origin) {
  const rows = [];
  for (let page = 1; page <= 8 && rows.length < MAX_PRODUCTS; page += 1) {
    const shopify = await fetchText(`${origin}/products.json?limit=250&page=${page}`);
    if (!shopify.ok) break;
    try {
      const payload = JSON.parse(shopify.text);
      const products = Array.isArray(payload?.products) ? payload.products : [];
      if (!products.length) break;
      rows.push(...products);
      if (products.length < 250) break;
    } catch {
      break;
    }
  }
  return rows.slice(0, MAX_PRODUCTS);
}

async function probeWpRestProducts(origin) {
  const wp = await fetchText(`${origin}/wp-json/wp/v2/product?per_page=100&_embed=1`);
  if (!wp.ok) return [];
  try {
    const rows = JSON.parse(wp.text);
    return Array.isArray(rows) ? rows.slice(0, MAX_PRODUCTS) : [];
  } catch {
    return [];
  }
}

async function probeBigCommerceProducts(origin) {
  const storefront = await fetchText(`${origin}/api/storefront/catalog/products?limit=50`);
  if (!storefront.ok) return [];
  try {
    const rows = JSON.parse(storefront.text);
    return Array.isArray(rows) ? rows.slice(0, MAX_PRODUCTS) : [];
  } catch {
    return [];
  }
}

export function mapBigCommerceProducts(rows = [], { layout = 'normal' } = {}) {
  return catalogFromRawProducts((Array.isArray(rows) ? rows : []).map((row) => ({
    title: compact(row?.name || row?.title),
    description: stripHtml(row?.description || ''),
    price: compact(row?.price || row?.calculated_price || ''),
    imageUrl: compact(row?.primary_image?.url_standard || row?.images?.[0]?.url_standard || ''),
    category: compact(row?.categories?.[0]?.name || ''),
  })), layout);
}

async function finishCatalog(catalog, { userId, onProgress, found, source, layout, pages = 1, platform = '' }) {
  onProgress?.({ step: 'downloading_images', message: 'Laster produktbilder…', found, pages });
  const withImages = await downloadProductImages(userId, catalog, (info) => {
    onProgress?.({
      step: 'downloading_images',
      message: `Laster produktbilder (${info.downloaded})…`,
      found,
      pages,
    });
  });
  return { catalog: withImages, source, layout, platform, found, pages };
}

export async function scrapePublicProductUrl(rawUrl, {
  userId,
  industry = '',
  layoutHint = '',
  onProgress,
} = {}) {
  const start = await assertPublicHttpUrl(rawUrl);
  const layoutGuess = detectLayoutFromEvidence(`${start.href} ${start.pathname}`, industry);
  const layout = layoutHint || layoutGuess.layout || 'normal';
  onProgress?.({ step: 'detecting_platform', message: 'Sjekker nettstedet…', pages: 0, found: 0 });

  const origin = start.origin;
  const home = await fetchText(start.href);
  const detected = detectStorePlatform({ html: home.ok ? home.text : '', url: start.href });
  onProgress?.({
    step: 'detecting_platform',
    message: detected.platform === 'custom'
      ? 'Ingen kjent butikkplattform — leser synlige produkter.'
      : `Fant ${detected.platform}. Henter offentlig produktliste…`,
    platform: detected.platform,
  });

  for (const probe of probeOrderFor(detected.platform)) {
    if (probe === 'woocommerce') {
      const wooRows = await probeWooStoreApi(origin);
      if (wooRows.length) {
        onProgress?.({ step: 'extracting', message: `Fant ${wooRows.length} produkter i nettbutikken.`, found: wooRows.length, pages: 1 });
        return finishCatalog(mapWooStoreProducts(wooRows, { layout }), {
          userId, onProgress, found: wooRows.length, source: 'woocommerce-store-api', layout, platform: 'woocommerce',
        });
      }
    }
    if (probe === 'shopify') {
      const shopifyRows = await probeShopifyProducts(origin);
      if (shopifyRows.length) {
        onProgress?.({ step: 'extracting', message: `Fant ${shopifyRows.length} produkter i butikkatalogen.`, found: shopifyRows.length, pages: 1 });
        return finishCatalog(mapShopifyProductsJson({ products: shopifyRows }, { layout }), {
          userId, onProgress, found: shopifyRows.length, source: 'shopify-public-json', layout, platform: 'shopify',
        });
      }
    }
    if (probe === 'wordpress') {
      const wpRows = await probeWpRestProducts(origin);
      const catalog = mapWpRestProducts(wpRows, { layout });
      const count = (catalog.categories || []).reduce((sum, category) => sum + (category.products || []).length, 0);
      if (count) {
        onProgress?.({ step: 'extracting', message: `Fant ${count} produkter i sidekatalogen.`, found: count, pages: 1 });
        return finishCatalog(catalog, {
          userId, onProgress, found: count, source: 'wordpress-rest', layout, platform: detected.platform,
        });
      }
    }
    if (probe === 'bigcommerce') {
      const bcRows = await probeBigCommerceProducts(origin);
      const catalog = mapBigCommerceProducts(bcRows, { layout });
      const count = (catalog.categories || []).reduce((sum, category) => sum + (category.products || []).length, 0);
      if (count) {
        onProgress?.({ step: 'extracting', message: `Fant ${count} produkter i butikkatalogen.`, found: count, pages: 1 });
        return finishCatalog(catalog, {
          userId, onProgress, found: count, source: 'bigcommerce-storefront', layout, platform: 'bigcommerce',
        });
      }
    }
  }

  const queue = [start.href];
  const seen = new Set();
  const rawProducts = [];
  let pages = 0;

  const seed = await fetchText(`${origin}/sitemap.xml`);
  if (seed.ok) {
    const locs = extractSitemapLocs(seed.text, start).filter((loc) => isLikelyProductHref(loc));
    for (const loc of locs.slice(0, MAX_PAGES)) {
      if (!queue.includes(loc)) queue.push(loc);
    }
  }

  while (queue.length && pages < MAX_PAGES && rawProducts.length < MAX_PRODUCTS) {
    const href = queue.shift();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const page = href === start.href && home.ok ? home : await fetchText(href);
    pages += 1;
    if (!page.ok) continue;
    const found = collectHtmlProducts(page.text).map((product) => ({
      ...product,
      imageUrl: product.imageUrl && !/^https?:\/\//i.test(product.imageUrl)
        ? new URL(product.imageUrl, href).href
        : product.imageUrl,
    }));
    for (const product of found) {
      if (rawProducts.length >= MAX_PRODUCTS) break;
      rawProducts.push(product);
    }
    const unique = dedupeProducts(rawProducts);
    rawProducts.length = 0;
    rawProducts.push(...unique);
    onProgress?.({
      step: 'crawling',
      message: `Leser side ${pages} · ${rawProducts.length} produkter så langt`,
      pages,
      found: rawProducts.length,
      platform: detected.platform,
    });
    for (const link of extractSameOriginLinks(page.text, start)) {
      if (isLikelyProductHref(link) && !seen.has(link) && queue.length < MAX_PAGES * 3) {
        queue.push(link);
      }
    }
  }

  if (!rawProducts.length) {
    throw Object.assign(new Error('Fant ingen produkter på denne siden. Prøv en direkte produkt- eller meny-URL, eller last opp en fil.'), {
      status: 422,
      code: 'no-products',
    });
  }

  onProgress?.({
    step: 'structuring',
    message: `Strukturerer ${rawProducts.length} produkter…`,
    pages,
    found: rawProducts.length,
  });
  return finishCatalog(catalogFromRawProducts(rawProducts, layout), {
    userId,
    onProgress,
    found: rawProducts.length,
    source: 'public-crawl',
    layout,
    pages,
    platform: detected.platform,
  });
}

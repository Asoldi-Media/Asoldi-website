/**
 * Universal public product scrape. Detect the store platform from HTML/URL,
 * then use that platform's public catalog if it exists (Woo Store API,
 * Shopify /products.json, WP REST, BigCommerce storefront). Otherwise run a
 * full-site audit: sitemap + pricing/plan/service URLs, JSON-LD Offer/Service,
 * cards, priced lines, and — when the HTML is a JS shell — same-origin bundles
 * that hold tier/price objects. Never key on a client name or one site's markup.
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
const MAX_JS_FILES = 16;
const MAX_JS_BYTES = 450_000;
const PRODUCT_HREF =
  /(?:product|produkt|products|produkter|shop|butikk|meny|menu|collection|kategori|category|rett|dish|pris|price|pricing|tier|pakke|plan|tjenest|service|tilbud|offer|abonnement|subscription|package)/i;
const IGNORE_HREF =
  /\/(?:login|admin|superadmin|ansatt|sales|developer|kunde|cart|checkout|account|wp-admin|privacy|personvern|vilkar|cookie|informasjonskaps|terms)(?:\/|$|\?)/i;
const GUESSED_CATALOG_PATHS = [
  '/pricing', '/priser', '/prices', '/prisliste', '/prisListe',
  '/plans', '/pakker', '/pakke', '/packages', '/tilbud',
  '/tjenester', '/services', '/meny', '/menu', '/shop', '/butikk',
  '/products', '/produkter', '/nettside', '/abonnement',
];

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

export function isIgnoredHref(href = '') {
  return IGNORE_HREF.test(String(href || ''));
}

export function isLikelyProductHref(href = '') {
  const value = String(href || '');
  if (!value || isIgnoredHref(value)) return false;
  return PRODUCT_HREF.test(value);
}

export function looksLikeJsShell(html = '') {
  const markup = String(html || '');
  const body = (markup.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || markup;
  const visible = stripHtml(body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  const hasMount = /id=["'](?:root|app|__next)["']/i.test(markup);
  const hasModule = /<script[^>]+type=["']module["']/i.test(markup)
    || /<(?:script|link)[^>]+(?:src|href)=["'][^"']*\/assets\/[^"']+\.js/i.test(markup);
  return (hasMount || hasModule) && visible.length < 800;
}

export function looksLikeMoney(value = '') {
  const text = compact(value);
  if (!text || text.length > 48) return false;
  if (/etter avtale|on request|contact us|quote|på forespørsel|tilbud/i.test(text) && !/\d/.test(text)) return true;
  return /\d/.test(text) && /(?:kr|nok|usd|eur|\$|€|,-|\/mnd|\/mo|\/år|\/year|per (?:måned|month)|mva)/i.test(text);
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
    const types = type.split(/[\s,]+/).map((entry) => compact(entry)).filter(Boolean);
    const nextCategory = compact(node.name) && /menusection|itemlist/i.test(type)
      ? compact(node.name)
      : category;
    const isCatalogType = types.some((entry) => /^(Product|MenuItem|Dish|Food|Service|Offer|AggregateOffer)$/i.test(entry));
    if (isCatalogType && !/menusection|menuitemlist|professionalservice|localbusiness/i.test(type)) {
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const title = compact(node.name || node.itemOffered?.name);
      const price = offerPriceOf(node) || compact(node.price || node.lowPrice || '');
      if (title && (price || types.some((entry) => /^(Product|MenuItem|Dish|Food)$/i.test(entry)))) {
        products.push({
          title,
          description: stripHtml(node.description || node.itemOffered?.description),
          price,
          comparePrice: compact(offer?.highPrice || node.highPrice || ''),
          imageUrl: imageUrlOf(node) || imageUrlOf(node.itemOffered || {}),
          category: compact(node.category || nextCategory || node.brand?.name || ''),
        });
      }
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

export function extractSameOriginAssetUrls(html = '', baseUrl) {
  const base = typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl;
  const hrefs = [
    ...String(html || '').matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.js[^"']*)["']/gi),
  ].map((row) => row[1]);
  const out = [];
  const seen = new Set();
  for (const href of hrefs) {
    try {
      const resolved = new URL(href, base);
      if (!sameOrigin(resolved, base)) continue;
      resolved.hash = '';
      if (seen.has(resolved.href)) continue;
      seen.add(resolved.href);
      out.push(resolved.href);
    } catch {
      // skip
    }
  }
  return out;
}

export function extractJsImportUrls(jsText = '', baseUrl) {
  const base = typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl;
  const refs = [
    ...String(jsText || '').matchAll(/(?:import\s*\(\s*["']([^"']+\.js)["']|from\s*["']([^"']+\.js)["'])/g),
    ...String(jsText || '').matchAll(/["']([^"']*assets\/[A-Za-z0-9._-]+\.js)["']/g),
  ].map((row) => row[1] || row[2]);
  const out = [];
  const seen = new Set();
  for (const href of refs) {
    try {
      const normalized = /^(?:\.\/|\.\.\/|\/|https?:)/i.test(href) ? href : `/${href}`;
      const resolved = new URL(normalized, base);
      if (!sameOrigin(resolved, base)) continue;
      resolved.hash = '';
      if (seen.has(resolved.href)) continue;
      seen.add(resolved.href);
      out.push(resolved.href);
    } catch {
      // skip
    }
  }
  return out;
}

function isVendorJs(url = '') {
  return /(?:^|\/)(?:react-vendor|router|icons|motion|vendor|chunk-vendors)[^/]*\.js(?:\?|$)/i.test(url)
    || /(?:email-editor|emailapi|calendly|gtag|analytics|sentry|firebase)[^/]*\.js(?:\?|$)/i.test(url);
}

export function scoreJsAsset(url = '') {
  const path = String(url || '').toLowerCase();
  if (isVendorJs(path)) return -100;
  if (/(?:^|\/)(?:admin|sales|login|kunde|client|workspace|developer|ansatt)[^/]*\.js/i.test(path)) return -20;
  if (/(pricing|priser|pris|tier|pakke|plan|product|produkt|menu|meny|package|service|tjenest|offer|deal|home)/i.test(path)) {
    return 10;
  }
  return 1;
}

function decodeJsString(value = '') {
  return String(value || '').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function pickQuotedField(block = '', keys = []) {
  for (const key of keys) {
    const match = String(block).match(new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
    if (match) return compact(decodeJsString(match[1]));
  }
  return '';
}

function pickNumberField(block = '', keys = []) {
  for (const key of keys) {
    const match = String(block).match(new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`));
    if (match) return Number(match[1]);
  }
  return null;
}

function pickStringArray(block = '', keys = []) {
  for (const key of keys) {
    const match = String(block).match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]{0,2500})\\]`, 'i'));
    if (!match) continue;
    const values = [...match[1].matchAll(/"((?:\\.|[^"\\]){2,120})"/g)]
      .map((row) => compact(decodeJsString(row[1])))
      .filter((entry) => entry && !/^(true|false|null|undefined)$/i.test(entry));
    if (values.length) return values;
  }
  return [];
}

function isHumanOfferName(name = '') {
  const text = compact(name);
  if (!text || text.length < 2 || text.length > 80) return false;
  if (/^(div|span|button|section|img|link|nav|main|header|footer|true|false|includes:)$/i.test(text)) return false;
  if (/^(https?:|\/)/.test(text)) return false;
  if (/click here|book (now|a )|logg inn|sign in|cookie|privacy/i.test(text)) return false;
  return /[A-Za-zÆØÅæøå]/.test(text);
}

function closeObjectLiteral(text = '', start = 0, maxLen = 6000) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < text.length && i - start <= maxLen + 80; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

export function extractPricedRecordsFromSource(text = '') {
  const source = String(text || '');
  const products = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    const preview = source.slice(i, i + 500);
    if (!/(?:name|title|shortName|offerName)\s*:/.test(preview)) continue;
    if (!/(?:price|normalPrice|prodPrice|monthlyPrice|monthlyExMva|amount)\s*:/.test(preview)) continue;
    if (/\b(?:className|jsx|children)\b/.test(preview) && !/\b(?:normalPrice|monthlyExMva|includedFeatures)\b/.test(preview)) {
      continue;
    }
    const block = closeObjectLiteral(source, i);
    if (!block || block.length < 40) continue;
    i += Math.min(block.length, 40) - 1;
    const rawName = pickQuotedField(block, ['name', 'title', 'offerName']);
    const shortName = pickQuotedField(block, ['shortName']);
    const title = shortName && /^tier\s*\d/i.test(rawName) ? shortName : (rawName || shortName);
    if (!isHumanOfferName(title)) continue;
    const priceText = pickQuotedField(block, ['price', 'normalPrice', 'prodPrice', 'monthlyPrice', 'amount']);
    const monthly = pickNumberField(block, ['monthlyExMva', 'monthlyPrice', 'priceExMva']);
    let price = priceText;
    if (!price && monthly != null && monthly > 0) {
      const grouped = String(Math.round(monthly)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      price = /monthly/i.test(block) ? `${grouped},-/mnd` : `${grouped} kr`;
    }
    if (!looksLikeMoney(price) && !(monthly != null && monthly > 0)) continue;
    const included = pickStringArray(block, ['includedFeatures', 'features', 'includes', 'planFeatures']);
    products.push({
      title,
      description: pickQuotedField(block, ['description', 'desc']),
      price,
      imageUrl: pickQuotedField(block, ['imageUrl', 'image', 'src']),
      category: pickQuotedField(block, ['category', 'product_type']),
      included,
      contactInsteadOfPrice: Boolean(priceText && /etter avtale|on request|på forespørsel/i.test(priceText) && !/\d/.test(priceText)),
    });
  }
  return dedupeProducts(products);
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
    || (block.match(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+[.,]?\d*)\s*(?:,-|-)?\s*(?:kr)?\s*\/\s*(?:mnd|mo|år|year)/i) || [])[0]
    || (block.match(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+[.,]?\d*)\s*(?:kr|,-)/i) || [])[0]
    || (block.match(/amount[^>]*>([\s\S]*?)<\/(?:span|bdi)/i) || [])[1]
  );
}

function includedFromBlock(block = '') {
  return [...String(block || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((row) => stripHtml(row[1]))
    .filter((entry) => entry && entry.length >= 3 && entry.length <= 140);
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
      included: includedFromBlock(block),
    };
  }).filter((row) => row.title && row.title.length >= 2 && row.title.length <= 120);
}

export function extractPricingCards(html = '') {
  const cards = [...String(html || '').matchAll(
    /<(article|li|div|section)([^>]*class=["'][^"']*(?:pric(?:e|ing)|tier|pakke|package|plan-card)[^"']*["'][^>]*)>([\s\S]{0,5000}?)<\/\1>/gi
  )];
  return cards.map((card) => {
    const block = card[3] || '';
    return {
      title: stripHtml(titleFromBlock(block)),
      description: stripHtml((block.match(/<(?:p|span)[^>]*class=["'][^"']*(?:desc|excerpt|summary)[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]),
      price: stripHtml(priceFromBlock(block)),
      imageUrl: imageFromBlock(block),
      included: includedFromBlock(block),
    };
  }).filter((row) => row.title && row.title.length >= 2 && row.title.length <= 120 && (row.price || row.included.length));
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
    ...extractPricingCards(html),
  ];
  if (merged.length < 3) merged.push(...extractPricedMenuItems(html));
  return dedupeProducts(merged);
}

function productScore(row = {}) {
  return (Array.isArray(row.included) ? row.included.length : 0)
    + (compact(row.description) ? 1 : 0)
    + (compact(row.price) ? 1 : 0);
}

export function dedupeProducts(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const title = compact(row.title || row.name).toLowerCase();
    if (!title) continue;
    const priceNum = String(row.price || '').replace(/[^\d]/g, '');
    const key = `${title}|${priceNum}`;
    const prev = byKey.get(key);
    if (!prev || productScore(row) > productScore(prev)) byKey.set(key, row);
  }
  return [...byKey.values()];
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

function inferLayoutFromProducts(products = [], industry = '', fallback = 'normal') {
  const hay = (Array.isArray(products) ? products : []).map((row) => (
    `${row.title || ''} ${row.price || ''} ${(row.included || []).join(' ')} ${row.description || ''}`
  )).join(' ');
  const guess = detectLayoutFromEvidence(hay, industry);
  if (guess.layout) return guess.layout;
  const monthly = products.filter((row) => /\/mnd|\/mo|per måned|per month/i.test(row.price || '')).length;
  const rich = products.filter((row) => (row.included || []).length >= 3).length;
  if (monthly >= 2 || rich >= 2) return 'tiers';
  return fallback;
}

function seedCatalogUrls(origin, startHref) {
  const urls = [startHref];
  for (const path of GUESSED_CATALOG_PATHS) {
    try {
      const href = new URL(path, origin).href;
      if (!urls.includes(href)) urls.push(href);
    } catch {
      // skip
    }
  }
  return urls;
}

export async function auditSiteScripts(html, pageUrl, { onProgress } = {}) {
  const start = typeof pageUrl === 'string' ? new URL(pageUrl) : pageUrl;
  const seen = new Set();
  const products = [];
  const toFetch = extractSameOriginAssetUrls(html, start)
    .map((url) => ({ url, score: scoreJsAsset(url) }))
    .filter((row) => row.score > -50);
  toFetch.sort((a, b) => b.score - a.score);

  let fetched = 0;
  while (toFetch.length && fetched < MAX_JS_FILES && products.length < MAX_PRODUCTS) {
    toFetch.sort((a, b) => b.score - a.score);
    const next = toFetch.shift();
    if (!next?.url || seen.has(next.url)) continue;
    const uniqueSoFar = dedupeProducts(products).length;
    if (uniqueSoFar >= 6 && next.score < 8) continue;
    seen.add(next.url);
    const file = await fetchText(next.url);
    fetched += 1;
    if (!file.ok || !file.text || file.text.length > MAX_JS_BYTES) continue;
    products.push(...extractPricedRecordsFromSource(file.text));
    for (const ref of extractJsImportUrls(file.text, next.url)) {
      if (seen.has(ref) || isVendorJs(ref)) continue;
      toFetch.push({ url: ref, score: scoreJsAsset(ref) });
    }
    onProgress?.({
      step: 'auditing_scripts',
      message: `Leser nettstedets filer (${fetched})…`,
      pages: fetched,
      found: dedupeProducts(products).length,
    });
  }
  return dedupeProducts(products);
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
  let layout = layoutHint || layoutGuess.layout || 'normal';
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

  const queue = seedCatalogUrls(origin, start.href);
  const seen = new Set();
  const rawProducts = [];
  let pages = 0;
  let auditedScripts = false;
  const homeHtml = home.ok ? home.text : '';
  const shell = home.ok && looksLikeJsShell(homeHtml);

  const seed = await fetchText(`${origin}/sitemap.xml`);
  if (seed.ok) {
    const locs = extractSitemapLocs(seed.text, start).filter((loc) => isLikelyProductHref(loc));
    for (const loc of locs.slice(0, MAX_PAGES)) {
      if (!queue.includes(loc)) queue.push(loc);
    }
  }

  if (shell) {
    onProgress?.({
      step: 'auditing_scripts',
      message: 'Siden er bygd som en app — leser priser og pakker fra hele nettstedet…',
      pages: 0,
      found: 0,
      platform: detected.platform,
    });
    rawProducts.push(...await auditSiteScripts(homeHtml, start, { onProgress }));
    auditedScripts = true;
  }

  const pageBudget = shell && rawProducts.length >= 3 ? 1 : MAX_PAGES;
  while (queue.length && pages < pageBudget && rawProducts.length < MAX_PRODUCTS) {
    const href = queue.shift();
    if (!href || seen.has(href) || isIgnoredHref(href)) continue;
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
    if (looksLikeJsShell(page.text) && !auditedScripts) {
      rawProducts.push(...await auditSiteScripts(page.text, start, { onProgress }));
      auditedScripts = true;
      const afterAudit = dedupeProducts(rawProducts);
      rawProducts.length = 0;
      rawProducts.push(...afterAudit);
    }
    for (const link of extractSameOriginLinks(page.text, start)) {
      if (isLikelyProductHref(link) && !seen.has(link) && queue.length < MAX_PAGES * 3) {
        queue.push(link);
      }
    }
  }

  if (!rawProducts.length && !auditedScripts && home.ok) {
    onProgress?.({
      step: 'auditing_scripts',
      message: 'Finner få synlige priser i HTML — leser nettstedets filer…',
      pages,
      found: 0,
    });
    rawProducts.push(...await auditSiteScripts(homeHtml, start, { onProgress }));
    auditedScripts = true;
  }

  if (!rawProducts.length) {
    throw Object.assign(new Error('Fant ingen produkter på denne siden. Prøv en direkte produkt- eller meny-URL, eller last opp en fil.'), {
      status: 422,
      code: 'no-products',
    });
  }

  if (!layoutHint) {
    layout = inferLayoutFromProducts(rawProducts, industry, layout);
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
    source: auditedScripts ? 'site-audit' : 'public-crawl',
    layout,
    pages,
    platform: detected.platform,
  });
}

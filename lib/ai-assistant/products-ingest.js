import { extname, join } from 'path';
import { writeFile, rm } from 'fs/promises';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import AdmZip from 'adm-zip';
import { deepseekChatJson } from '../deepseek.js';
import { extractTextFromOdt } from '../odt-text.js';
import {
  PRODUCT_IMPORT_CAP,
  PRODUCT_LAYOUT_RULES,
  capCatalogsToProductLimit,
  countCatalogProducts,
  normalizeProductCatalogs,
} from '../client-product-catalog.js';
import { detectLayoutFromEvidence } from './layout-detect.js';
import { rankOfferingPages, scrapePublicProductUrl } from './products-scrape.js';
import {
  buildDeterministicImportFromTexts,
  reconcileDeterministicWithAi,
} from './products-import-deterministic.js';
import { extractSiteUrlsFromText, looksLikeTypedProductList, shouldIngestSources } from './site-urls.js';
import { isDocumentSource, isMediaAssetFileName, isMediaAssetSource, sniffSourceKind } from './source-kind.js';

export { extractSiteUrlsFromText, looksLikeTypedProductList, shouldIngestSources, isMediaAssetFileName, isMediaAssetSource, sniffSourceKind };

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
export const MEDIA_ASSET_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);
export const PRODUCT_IMPORT_LIMIT = PRODUCT_IMPORT_CAP;
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml']);
const PER_FILE_CHARS = 14_000;
const COMBINED_CHARS = 110_000;
const WEBSITE_CONTEXT_CHARS = 100_000;
function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function extractUrlsFromText(text = '') {
  return extractSiteUrlsFromText(text);
}

export function isProductsIngestFileName(fileName = '') {
  const ext = extname(String(fileName || '')).toLowerCase();
  return MEDIA_ASSET_EXT.has(ext) || TEXT_EXT.has(ext) || ['.xlsx', '.xls', '.pdf', '.docx', '.odt'].includes(ext);
}

function extractDocxText(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) return '';
  return compact(entry.getData().toString('utf8').replace(/<[^>]+>/g, ' '));
}

function pdfExtractScriptPath() {
  const candidates = [
    join(process.cwd(), 'scripts', 'extract-pdf-text.mjs'),
    join(process.cwd(), '..', 'website-maker', 'scripts', 'extract-pdf-text.mjs'),
    'C:\\Asoldi\\asoldi code\\website-maker\\scripts\\extract-pdf-text.mjs',
  ];
  return candidates.find((entry) => existsSync(entry)) || '';
}

async function extractPdfTextViaSubprocess(buffer) {
  const scriptPath = pdfExtractScriptPath();
  if (!scriptPath) return '';
  const tmpPath = join(tmpdir(), `asoldi-pdf-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`);
  await writeFile(tmpPath, Buffer.from(buffer));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, tmpPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const chunks = [];
      const errChunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => errChunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString('utf8'));
          return;
        }
        reject(new Error(Buffer.concat(errChunks).toString('utf8').trim() || `PDF extract exited ${code}`));
      });
    });
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

function extractPdfTextRough(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer || '');
  const chunks = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)) {
    const text = match[0].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
    if (/[A-Za-zÆØÅæøå0-9]/.test(text)) chunks.push(text);
  }
  return compact(chunks.join(' ')).slice(0, PER_FILE_CHARS);
}

async function extractSpreadsheetText(buffer) {
  const xlsx = await import('xlsx');
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheets = [];
  for (const name of workbook.SheetNames.slice(0, 8)) {
    const csv = xlsx.utils.sheet_to_csv(workbook.Sheets[name]);
    if (compact(csv)) sheets.push(`Ark ${name}:\n${csv}`);
  }
  return sheets.join('\n\n').slice(0, PER_FILE_CHARS);
}

async function extractImageWithGemini(buffer, mimeType) {
  const apiKey = compact(process.env.GEMINI_API_KEY);
  if (!apiKey) return '';
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { text: 'Extract every product/dish/plan: name, price, description, category, allergens, included bullets. Plain text, one item per line.' },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: Buffer.from(buffer).toString('base64') } },
      ],
    }],
  });
  return compact(response?.text || response?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '');
}

function countPricedRecords(text = '') {
  return String(text || '')
    .split(/\n/)
    .filter((line) => /\d/.test(line) && /(?:kr|,-|nok|usd|eur|gbp|\/mnd)/i.test(line))
    .length;
}

function shouldSkipAiStructure({ deterministic = {}, structuredCatalogs = [], texts = [] } = {}) {
  const structuredCount = countCatalogProducts([
    ...(deterministic.catalogs || []),
    ...structuredCatalogs,
  ]);
  const priced = texts.reduce((sum, entry) => sum + countPricedRecords(entry.text), 0);
  return structuredCount >= 30 || priced >= 60 || structuredCount >= PRODUCT_IMPORT_CAP;
}

export async function extractIngestText(file = {}) {
  const name = file.originalName || file.name || file.fileName || 'fil';
  const ext = extname(name).toLowerCase();
  const buffer = file.buffer;
  const kind = sniffSourceKind(file);
  if (!buffer) return { fileName: name, text: compact(file.text || ''), kind };
  if (kind === 'image') {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.avif' ? 'image/avif' : 'image/jpeg';
    return { fileName: name, text: await extractImageWithGemini(buffer, mime), kind: 'image' };
  }
  if (kind === 'video' || VIDEO_EXT.has(ext)) return { fileName: name, text: '', kind: 'video' };
  if (kind === 'spreadsheet' || ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    if (ext === '.csv' || ext === '.tsv') {
      return { fileName: name, text: buffer.toString('utf8').slice(0, PER_FILE_CHARS), kind: 'spreadsheet' };
    }
    return { fileName: name, text: await extractSpreadsheetText(buffer), kind: 'spreadsheet' };
  }
  if (ext === '.odt') return { fileName: name, text: extractTextFromOdt(buffer), kind: 'document' };
  if (ext === '.docx') return { fileName: name, text: extractDocxText(buffer), kind: 'document' };
  if (TEXT_EXT.has(ext)) return { fileName: name, text: buffer.toString('utf8').slice(0, PER_FILE_CHARS), kind: 'document' };
  if (ext === '.pdf' || kind === 'document') {
    try {
      const parsed = compact(await extractPdfTextViaSubprocess(buffer));
      if (parsed.length >= 40) return { fileName: name, text: parsed.slice(0, PER_FILE_CHARS), kind: 'document' };
    } catch {
      // fall through to the in-process scanner
    }
    if (ext === '.odt') return { fileName: name, text: extractTextFromOdt(buffer), kind: 'document' };
    return { fileName: name, text: extractPdfTextRough(buffer), kind: 'document' };
  }
  return { fileName: name, text: compact(file.text || ''), kind };
}

function makerInstructions({ businessName = '', industry = '', fileNames = [], extraNotes = '' } = {}) {
  return [
    'You extract every distinct offering this business sells or lists: goods, dishes, services, packages, plans, or price-list rows.',
    'A website source is the page text itself. Read it as one business and capture the offerings, up to 50 lines when the source has that many. Do not stop after a sample.',
    'Use every source together. Do not split one business into several catalogs.',
    'Choose categories from the groups the source already uses. If it has no groups, use only as many groups as the items naturally form.',
    'An attribute (diet, size, allergen, colour, "alternativ") stays on the product. It is not a category.',
    'Choose the layout from the items: meny for dishes or a food menu, tiers for packages that list what is included, otherwise normal. Do not ask the user.',
    'Keep each description to one sentence so a long list still fits.',
    'Return JSON: {"catalogs":[{"layout":"normal|meny|tiers","label":"","categories":[{"name":"","products":[{"title":"","price":"","comparePrice":"","description":"","subtitle":"","allergens":"","included":[],"extraOptions":[{"name":"","price":""}],"contactInsteadOfPrice":false,"imageUrl":""}]}]}]}',
    'Layouts:',
    PRODUCT_LAYOUT_RULES,
    'TABLE / COLUMN RULES:',
    "- Source may include '=== TABLE N ===' rows with cells separated by ' | '.",
    '- Two prices on one row: first price → price, second → comparePrice.',
    "- Fix truncated prices like '125 k' to '125 kr'.",
    '- Allergen sheets attach allergens to the matching product. They are not a second store.',
    '- If a catalog already exists, file new items into those groups when they fit. Add a category only for a new family of offerings.',
    '- One price plus a list of contents = one product with included[].',
    '- The same item in two sizes = two products.',
    'Keep the source language. Never invent prices or items.',
    businessName ? `Business name: ${businessName}` : '',
    fileNames.length ? `Source names: ${fileNames.join(' | ')}` : '',
    extraNotes ? `Client notes: ${extraNotes}` : '',
  ].filter(Boolean).join('\n');
}

function existingHierarchyNotes(catalogs = []) {
  const lines = [];
  for (const catalog of catalogs || []) {
    for (const category of catalog.categories || []) {
      const titles = (category.products || [])
        .map((product) => compact(product.title || product.name))
        .filter(Boolean)
        .slice(0, 8);
      lines.push(`- ${catalog.label || catalog.layout} / ${category.name}${titles.length ? `: ${titles.join(', ')}` : ''}`);
    }
  }
  if (!lines.length) return '';
  return `Existing catalog — reuse these groups when the new items fit:\n${lines.join('\n')}`;
}

export function formatWebsiteCorpus({ url = '', catalog = null, pageTexts = [] } = {}) {
  const lines = [];
  for (const category of catalog?.categories || []) {
    for (const product of category.products || []) {
      if (lines.length >= 80) break;
      const title = compact(product.title || product.name);
      if (!title) continue;
      lines.push([category.name, title, product.price, product.description].filter(Boolean).join(' | '));
    }
  }
  let body = lines.length
    ? `Linjer som allerede er sett (bruk dem, og fyll inn det sideteksten har i tillegg):\n${lines.join('\n')}`
    : '';
  for (const page of rankOfferingPages(pageTexts)) {
    const chunk = `\n\n=== Side: ${page.url || url} ===\n${page.text || ''}`;
    if (body.length >= WEBSITE_CONTEXT_CHARS) break;
    body += chunk.slice(0, WEBSITE_CONTEXT_CHARS - body.length);
  }
  return `Nettsted ${url}\nLes hele konteksten. Hent tilbudene og velg kategori ut fra dataene.\n${body}`.trim();
}

function isStructuredStoreSource(source = '') {
  return /shopify|woocommerce|wordpress-rest|bigcommerce/i.test(String(source || ''));
}

export async function structureProductsFromText({
  texts = [],
  industry = '',
  layoutHint = '',
  businessName = '',
  extraNotes = '',
  existingCatalogs = [],
  structuredCatalogs = [],
} = {}) {
  const usable = texts.filter((entry) => compact(entry.text).length >= 8);
  const combined = usable
    .map((entry) => `=== File: ${entry.fileName || 'tekst'} ===\n${compact(entry.text)}`)
    .join('\n\n')
    .slice(0, COMBINED_CHARS);
  if (!compact(combined) && !structuredCatalogs.length) {
    throw Object.assign(new Error('Fant ikke nok produktdata i kildene.'), { status: 422 });
  }

  const guess = detectLayoutFromEvidence(combined, industry);
  const preferAi = usable.some((entry) => entry.preferAi);
  const layout = layoutHint || (preferAi ? null : guess.layout) || null;
  const deterministic = buildDeterministicImportFromTexts(usable);
  const skipAi = !preferAi && shouldSkipAiStructure({ deterministic, structuredCatalogs, texts: usable });
  let aiCatalogs = [];
  if (!skipAi && compact(combined)) {
    try {
      const parsed = await deepseekChatJson({
        temperature: 0.1,
        maxTokens: 8192,
        timeoutMs: 180_000,
        system: `${makerInstructions({
          businessName,
          industry,
          fileNames: usable.map((entry) => entry.fileName),
          extraNotes: [extraNotes, existingHierarchyNotes(existingCatalogs)].filter(Boolean).join('\n'),
        })}\n${layoutHint ? `Eksisterende layout som kan beholdes: ${layoutHint}.` : 'Velg layout ut fra innholdet, ikke ut fra bransjenavnet.'}`,
        user: combined,
      });
      aiCatalogs = normalizeProductCatalogs(parsed?.catalogs || parsed?.productCatalogs, {
        keepEmptyProducts: false,
        extraHay: `${industry} ${combined.slice(0, 400)}`,
      });
    } catch {
      aiCatalogs = [];
    }
  }

  const reconciled = reconcileDeterministicWithAi({
    deterministic: {
      ...deterministic,
      catalogs: [...(deterministic.catalogs || []), ...structuredCatalogs],
    },
    aiCatalogs,
    preferAi,
  });
  const catalogs = normalizeProductCatalogs(reconciled, {
    keepEmptyProducts: false,
    extraHay: `${industry} ${combined.slice(0, 400)}`,
  });
  const capped = capCatalogsToProductLimit(catalogs, PRODUCT_IMPORT_CAP);
  return {
    catalogs: capped.catalogs,
    layout: capped.catalogs[0]?.layout || layout,
    needsLayoutQuestion: !layout && guess.confidence === 'none' && !capped.catalogs.length,
    sources: usable.map((entry) => entry.fileName),
    truncated: capped.truncated,
    dropped: capped.dropped,
    usedAi: !skipAi && aiCatalogs.length > 0,
  };
}

export async function ingestProductSources({
  files = [],
  text = '',
  urls = [],
  industry = '',
  layoutHint = '',
  businessName = '',
  userId = '',
  existingCatalogs = [],
  onProgress,
} = {}) {
  const extracted = [];
  const structuredCatalogs = [];
  for (const file of files) {
    const kind = sniffSourceKind(file);
    const label = file.originalName || file.name || 'fil';
    if (isDocumentSource(file)) {
      onProgress?.({ step: 'reading', message: `Leser dokumentet ${label}…` });
    } else if (isMediaAssetSource(file)) {
      onProgress?.({ step: 'reading', message: `Ser på media ${label}…` });
    } else {
      onProgress?.({ step: 'reading', message: `Leser ${label}…` });
    }
    if (kind === 'image' || kind === 'video') {
      extracted.push(await extractIngestText(file));
      continue;
    }
    extracted.push(await extractIngestText(file));
  }
  if (compact(text)) extracted.push({ fileName: 'notater', text, kind: 'document' });

  const discovered = [...urls, ...extractUrlsFromText(text)];
  const uniqueUrls = [...new Set(discovered)];
  for (const url of uniqueUrls) {
    onProgress?.({ step: 'scrape', message: `Leser hele ${url}…` });
    try {
      const scraped = await scrapePublicProductUrl(url, { userId, industry, layoutHint });
      const storeCatalog = isStructuredStoreSource(scraped.source);
      if (scraped.catalog && storeCatalog) structuredCatalogs.push(scraped.catalog);
      extracted.push({
        fileName: url,
        kind: 'website',
        preferAi: !storeCatalog,
        text: formatWebsiteCorpus({
          url,
          catalog: storeCatalog ? null : scraped.catalog,
          pageTexts: scraped.pageTexts || [],
        }),
      });
    } catch (error) {
      extracted.push({ fileName: url, kind: 'document', text: `URL kunne ikke leses (${error?.message || 'ukjent feil'}): ${url}` });
    }
  }

  const usable = extracted.filter((entry) => compact(entry.text).length >= 8);
  if (!usable.length && !structuredCatalogs.length) {
    return {
      catalogs: [],
      layout: layoutHint || null,
      needsLayoutQuestion: false,
      sources: extracted.map((entry) => entry.fileName),
      truncated: false,
      dropped: 0,
    };
  }

  onProgress?.({ step: 'structuring', message: 'Setter sammen alle kilder til én produktkatalog…' });
  return structureProductsFromText({
    texts: extracted,
    industry,
    layoutHint,
    businessName,
    extraNotes: text,
    existingCatalogs,
    structuredCatalogs,
  });
}

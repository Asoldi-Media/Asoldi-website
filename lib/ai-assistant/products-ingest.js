import { extname, join } from 'path';
import { writeFile, rm } from 'fs/promises';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import AdmZip from 'adm-zip';
import { deepseekChatJson } from '../deepseek.js';
import { extractTextFromOdt } from '../odt-text.js';
import {
  PRODUCT_LAYOUT_RULES,
  normalizeProductCatalogs,
} from '../client-product-catalog.js';
import { detectLayoutFromEvidence } from './layout-detect.js';
import { scrapePublicProductUrl } from './products-scrape.js';
import {
  buildDeterministicImportFromTexts,
  reconcileDeterministicWithAi,
} from './products-import-deterministic.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic']);
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml']);
const PER_FILE_CHARS = 14_000;
const COMBINED_CHARS = 80_000;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function extractUrlsFromText(text = '') {
  const seen = new Set();
  const urls = [];
  for (const match of String(text || '').matchAll(URL_RE)) {
    const url = match[0].replace(/[),.;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function isProductsIngestFileName(fileName = '') {
  const ext = extname(String(fileName || '')).toLowerCase();
  return IMAGE_EXT.has(ext) || TEXT_EXT.has(ext) || ['.xlsx', '.xls', '.pdf', '.docx', '.odt'].includes(ext);
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

export async function extractIngestText(file = {}) {
  const name = file.originalName || file.name || file.fileName || 'fil';
  const ext = extname(name).toLowerCase();
  const buffer = file.buffer;
  if (!buffer) return { fileName: name, text: compact(file.text || '') };
  if (ext === '.odt') return { fileName: name, text: extractTextFromOdt(buffer) };
  if (TEXT_EXT.has(ext)) return { fileName: name, text: buffer.toString('utf8').slice(0, PER_FILE_CHARS) };
  if (ext === '.docx') return { fileName: name, text: extractDocxText(buffer) };
  if (ext === '.pdf') {
    try {
      const parsed = compact(await extractPdfTextViaSubprocess(buffer));
      if (parsed.length >= 40) {
        const withBreaks = parsed
          .replace(/(?<![Ss]om)\s+(Alternativ\s*\d+)/g, '\n$1\n')
          .replace(/\s+((?:I\s+)?[Tt]illegg[^\n:]{0,48}:?)/g, '\n$1\n')
          .replace(/\s+(Kr\s*[:.]\s*\d+)/gi, '\n$1')
          .replace(/(\d+\s*,-)\s+(?=[A-ZÆØÅ])/g, '$1\n')
          .replace(/\s+(Du kan )/gi, '\n$1');
        return { fileName: name, text: withBreaks.slice(0, PER_FILE_CHARS) };
      }
    } catch {
      // fall through to the in-process scanner
    }
    return { fileName: name, text: extractPdfTextRough(buffer) };
  }
  if (ext === '.xlsx' || ext === '.xls') return { fileName: name, text: await extractSpreadsheetText(buffer) };
  if (IMAGE_EXT.has(ext)) {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { fileName: name, text: await extractImageWithGemini(buffer, mime) };
  }
  return { fileName: name, text: compact(file.text || '') };
}

function makerInstructions({ businessName = '', industry = '', fileNames = [], extraNotes = '' } = {}) {
  return [
    'You extract EVERY sellable product/menu/price-list item into a nested catalog.',
    'Completeness is mandatory: do not skip items, sizes, package alternatives, or priced extras.',
    'Use ALL sources together as one evidence set (files + website scrape + typed notes). Do not treat them as separate catalogs unless they clearly are different businesses.',
    'Return JSON: {"catalogs":[{"layout":"normal|meny|tiers","label":"","categories":[{"name":"","products":[{"title":"","price":"","comparePrice":"","description":"","subtitle":"","allergens":"","included":[],"extraOptions":[{"name":"","price":""}],"contactInsteadOfPrice":false,"imageUrl":""}]}]}]}',
    'Layouts:',
    PRODUCT_LAYOUT_RULES,
    'TABLE / COLUMN RULES:',
    "- Source may include '=== TABLE N ===' rows with cells separated by ' | '.",
    '- Dual-price tables (dine-in | takeaway, café | ta med, etc.): first price → price, second → comparePrice.',
    "- Fix truncated prices like '125 k' to '125 kr'.",
    'ALLERGEN FILES:',
    '- Sheets titled allergen/allergi are allergen info, NOT a separate product store.',
    '- Put allergens onto the matching product in the main catalog.',
    '- If an allergen line has no matching item, create that product and set allergens.',
    'PACKAGES:',
    '- A list of items + one package price = ONE meny product with included[] items.',
    '- Priced extras after an extras/tillegg header are separate products.',
    '- Same item at two sizes = two products (size in subtitle or name).',
    'Keep the source language. Never invent prices or items.',
    businessName ? `Business name: ${businessName}` : '',
    industry ? `Industry: ${industry}` : '',
    fileNames.length ? `Source names: ${fileNames.join(' | ')}` : '',
    extraNotes ? `Client notes: ${extraNotes}` : '',
  ].filter(Boolean).join('\n');
}

export async function structureProductsFromText({
  texts = [],
  industry = '',
  layoutHint = '',
  businessName = '',
  extraNotes = '',
} = {}) {
  const usable = texts.filter((entry) => compact(entry.text).length >= 8);
  const combined = usable
    .map((entry) => `=== File: ${entry.fileName || 'tekst'} ===\n${compact(entry.text)}`)
    .join('\n\n')
    .slice(0, COMBINED_CHARS);
  if (!compact(combined)) {
    throw Object.assign(new Error('Fant ikke nok produktdata i kildene.'), { status: 422 });
  }

  const guess = detectLayoutFromEvidence(combined, industry);
  const layout = layoutHint || guess.layout || null;
  const deterministic = buildDeterministicImportFromTexts(usable);
  let aiCatalogs = [];
  try {
    const parsed = await deepseekChatJson({
      temperature: 0.1,
      maxTokens: 8192,
      timeoutMs: 180_000,
      system: `${makerInstructions({
        businessName,
        industry,
        fileNames: usable.map((entry) => entry.fileName),
        extraNotes,
      })}\n${layout ? `Foretrukket layout: ${layout}.` : ''}`,
      user: combined,
    });
    aiCatalogs = normalizeProductCatalogs(parsed?.catalogs || parsed?.productCatalogs, {
      keepEmptyProducts: false,
      extraHay: `${industry} ${combined.slice(0, 400)}`,
    });
  } catch {
    aiCatalogs = [];
  }

  const reconciled = reconcileDeterministicWithAi({
    deterministic,
    aiCatalogs,
  });
  const catalogs = normalizeProductCatalogs(reconciled, {
    keepEmptyProducts: false,
    extraHay: `${industry} ${combined.slice(0, 400)}`,
  });
  return {
    catalogs,
    layout: catalogs[0]?.layout || layout,
    needsLayoutQuestion: !layout && guess.confidence === 'none' && !catalogs.length,
    sources: usable.map((entry) => entry.fileName),
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
  onProgress,
} = {}) {
  const extracted = [];
  for (const file of files) {
    onProgress?.({ step: 'reading', message: `Leser ${file.originalName || file.name || 'fil'}…` });
    extracted.push(await extractIngestText(file));
  }
  if (compact(text)) extracted.push({ fileName: 'notater', text });

  const discovered = [...urls, ...extractUrlsFromText(text)];
  const uniqueUrls = [...new Set(discovered)];
  for (const url of uniqueUrls) {
    onProgress?.({ step: 'scrape', message: `Henter produkter fra ${url}…` });
    try {
      const scraped = await scrapePublicProductUrl(url, { userId, industry, layoutHint });
      const lines = (scraped.catalog?.categories || []).flatMap((category) => (
        (category.products || []).map((product) => [
          category.name,
          product.title || product.name,
          product.price,
          product.comparePrice,
          product.description,
          product.allergens,
          (product.included || []).join('; '),
          product.imageUrl,
        ].filter(Boolean).join(' | '))
      ));
      extracted.push({
        fileName: url,
        text: `Website scrape ${url}\n${lines.join('\n')}`,
      });
    } catch (error) {
      extracted.push({ fileName: url, text: `URL kunne ikke leses (${error?.message || 'ukjent feil'}): ${url}` });
    }
  }

  onProgress?.({ step: 'structuring', message: 'Setter sammen alle kilder til én produktkatalog…' });
  return structureProductsFromText({
    texts: extracted,
    industry,
    layoutHint,
    businessName,
    extraNotes: text,
  });
}

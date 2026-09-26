import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractIngestText, structureProductsFromText } from '../lib/ai-assistant/products-ingest.js';
import { buildDeterministicImportFromTexts, reconcileDeterministicWithAi } from '../lib/ai-assistant/products-import-deterministic.js';
import { scrapePublicProductUrl } from '../lib/ai-assistant/products-scrape.js';
import { makerBundleToClientDataBank } from '../lib/maker-bundle-to-bank.js';
import { summarizeCatalogs } from '../lib/client-product-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const makerRoot = path.resolve(here, '..', '..', 'website-maker');
const files = [
  'Allergi-meny 1.odt',
  'Allergi-meny 2.odt',
  'Meny_Cafe-21.odt',
  'Prisliste Kaker.odt',
  'Catering tapas-22.odt',
  'Catering-koldtbord-24.pdf',
].map((name) => path.join(makerRoot, name));

function norm(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenCatalogs(catalogs = []) {
  return (catalogs || []).flatMap((catalog) =>
    (catalog.categories || []).flatMap((category) =>
      (category.products || []).map((product) => ({
        catalog: catalog.label || catalog.layout,
        category: category.name,
        title: product.title || product.name,
        price: product.price,
        comparePrice: product.comparePrice,
        allergens: product.allergens,
        included: product.included || [],
      }))
    )
  );
}

function loadGold() {
  const raw = JSON.parse(fs.readFileSync(path.join(makerRoot, '.generated-runs', 'client-bundles.json'), 'utf8'));
  const clients = Array.isArray(raw) ? raw : raw.clients || [];
  const bundle = clients.find((entry) => entry.id === 'a7c9b676-3f62-430e-8cf2-491d226e9eee');
  if (!bundle) throw new Error('Byneset bundle not found');
  return bundle;
}

async function main() {
  const mode = process.argv[2] || 'all';
  const gold = loadGold();
  const goldProducts = flattenCatalogs(gold.productCatalogs);
  const goldNames = new Set(goldProducts.map((row) => norm(row.title)).filter(Boolean));

  if (mode === 'gold' || mode === 'all') {
    const summary = summarizeCatalogs(gold.productCatalogs);
    console.log('GOLD', {
      categories: summary.categories.map((row) => `${row.name}:${row.productCount}`),
      products: summary.productCount,
      withAllergens: goldProducts.filter((row) => row.allergens).length,
      withCompare: goldProducts.filter((row) => row.comparePrice).length,
      withIncluded: goldProducts.filter((row) => row.included.length).length,
    });
  }

  const extracted = [];
  if (mode === 'extract' || mode === 'deterministic' || mode === 'ingest' || mode === 'all') {
    for (const filePath of files) {
      const buffer = fs.readFileSync(filePath);
      const row = await extractIngestText({
        originalName: path.basename(filePath),
        buffer,
      });
      extracted.push(row);
      console.log('FILE', row.fileName, 'chars', (row.text || '').length);
    }
  }

  if (mode === 'bank' || mode === 'all') {
    const bank = makerBundleToClientDataBank(gold, {});
    console.log('BANK', {
      company: bank.businessCard.companyName,
      email: bank.generalInfo.companyEmail,
      industry: bank.businessCard.industry,
      products: summarizeCatalogs(bank.productCatalogs).productCount,
      v2: Boolean(bank.websiteCreatorQuestions.businessWhat && bank.websiteCreatorQuestions.reviews),
    });
  }

  if (mode === 'deterministic') {
    const catalogs = reconcileDeterministicWithAi({
      deterministic: buildDeterministicImportFromTexts(extracted),
      aiCatalogs: [],
    });
    const got = flattenCatalogs(catalogs);
    const gotNames = new Set(got.map((row) => norm(row.title)).filter(Boolean));
    const missing = [...goldNames].filter((name) => ![...gotNames].some((gotName) => gotName.includes(name) || name.includes(gotName)));
    const extra = [...gotNames].filter((name) => ![...goldNames].some((goldName) => goldName.includes(name) || name.includes(goldName)));
    console.log('DETERMINISTIC', {
      gold: goldNames.size,
      got: gotNames.size,
      missing: missing.slice(0, 50),
      extra: extra.slice(0, 50),
      categories: summarizeCatalogs(catalogs).categories.map((row) => `${row.name}:${row.productCount}`),
    });
    fs.writeFileSync(
      path.join(here, 'client-assistant-accuracy-last.json'),
      JSON.stringify({ gold: goldProducts, got, missing, extra, catalogs }, null, 2)
    );
  }

  if (mode === 'ingest' || mode === 'all') {
    const structured = await structureProductsFromText({
      texts: extracted,
      industry: 'restaurant',
      businessName: 'Byneset Bydelskafe',
      extraNotes: '',
    });
    const got = flattenCatalogs(structured.catalogs);
    const gotNames = new Set(got.map((row) => norm(row.title)).filter(Boolean));
    const missing = [...goldNames].filter((name) => ![...gotNames].some((gotName) => gotName.includes(name) || name.includes(gotName)));
    const extra = [...gotNames].filter((name) => ![...goldNames].some((goldName) => goldName.includes(name) || name.includes(goldName)));
    console.log('MATCH', {
      gold: goldNames.size,
      got: gotNames.size,
      missing: missing.slice(0, 40),
      extra: extra.slice(0, 40),
      categories: summarizeCatalogs(structured.catalogs).categories.map((row) => `${row.name}:${row.productCount}`),
    });
    fs.writeFileSync(
      path.join(here, 'client-assistant-accuracy-last.json'),
      JSON.stringify({ gold: goldProducts, got, missing, extra, catalogs: structured.catalogs }, null, 2)
    );
  }

  if (mode === 'topspin' || mode === 'all') {
    const scraped = await scrapePublicProductUrl('https://topspin.no', { industry: 'retail' });
    const products = flattenCatalogs(scraped.catalog ? [scraped.catalog] : scraped.catalogs || []);
    console.log('TOPSPIN', {
      layout: scraped.catalog?.layout || scraped.layout,
      products: products.length,
      sample: products.slice(0, 12).map((row) => `${row.category} | ${row.title} | ${row.price}`),
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

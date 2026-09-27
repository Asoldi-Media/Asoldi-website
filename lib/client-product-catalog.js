// Web-suite product catalogs for the client portal (Kundedata + AI assistant).
// Browser-safe — no node: imports.
import { placeIncomingCatalogs } from './ai-assistant/catalog-place.js';

export const PRODUCT_IMPORT_CAP = 200;

export const PRODUCT_LAYOUTS = [
  {
    id: 'meny',
    label: 'Meny',
    hint: 'Anbefalt for restauranter og kafeer',
  },
  {
    id: 'tiers',
    label: 'Tiers',
    hint: 'Anbefalt for tjenestebaserte bedrifter med flere nivåer',
  },
  {
    id: 'normal',
    label: 'Normal',
    hint: 'Anbefalt for 90% av hverdagslige bedrifter',
  },
];

export const PRODUCT_LAYOUT_RULES = [
  'meny: food & drink menus (café, restaurant, catering, tapas, koldtbord, allergy-enriched dishes).',
  'tiers: tech products or other non-food services sold as pricing plans/packages with many inclusions (Basic/Pro/Enterprise).',
  'normal: everything else (cakes, retail SKUs, simple non-menu price lists).',
  'Never put food/catering menus in tiers. Never put SaaS/service plans in meny.',
].join('\n');

const LAYOUT_IDS = new Set(PRODUCT_LAYOUTS.map((entry) => entry.id));

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function newId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function layoutLabel(layout = '') {
  const id = String(layout || '').trim().toLowerCase();
  return PRODUCT_LAYOUTS.find((entry) => entry.id === id)?.label || 'Normal';
}

export function isProductLayout(value = '') {
  return LAYOUT_IDS.has(String(value || '').trim().toLowerCase());
}

export function defaultCategoryName(layout = 'normal') {
  if (layout === 'meny') return 'Meny';
  if (layout === 'tiers') return 'Pakker';
  return 'Produkter';
}

function normalizeExtraOptions(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row) => ({
      name: compact(row?.name || ''),
      price: compact(row?.price || ''),
    }))
    .filter((row) => row.name || row.price);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => compact(entry)).filter(Boolean);
}

export function coerceCatalogLayout(catalog = {}, extraHay = '') {
  const input = catalog && typeof catalog === 'object' ? catalog : {};
  const layoutRaw = compact(input.layout).toLowerCase();
  const explicit = LAYOUT_IDS.has(layoutRaw);
  const layout = explicit ? layoutRaw : 'normal';
  if (explicit) {
    return {
      ...input,
      layout,
      label: compact(input.label) || layoutLabel(layout),
    };
  }
  const hay = `${input.label || ''} ${(input.categories || []).map((c) => c.name || c.categoryName || '').join(' ')} ${extraHay}`.toLowerCase();
  const foodCue =
    /\b(meny|menu|tapas|koldtbord|catering|café|cafe|kafe|restaurant|bakeri|bakery|bar|drikke|smørbrød|smorbrod|salat|allergi|dessert|frokost|lunsj|middag)\b/i.test(hay);
  const tierCue =
    /\b(saas|software|abonnement|subscription|enterprise|startup|basic|pro plan|pricing plan|webhosting|hosting plan|pakkeplan)\b/i.test(hay);

  let nextLayout = layout;
  if (foodCue) nextLayout = 'meny';
  else if (tierCue) nextLayout = 'tiers';

  return {
    ...input,
    layout: nextLayout,
    label: compact(input.label) || layoutLabel(nextLayout),
  };
}

export function normalizeProductItem(row = {}, { keepEmpty = false } = {}) {
  const input = row && typeof row === 'object' ? row : {};
  const title = compact(input.title || input.name || '');
  const item = {
    id: compact(input.id) || newId('prod'),
    title,
    name: title,
    price: compact(input.price || ''),
    description: compact(input.description || input.desc || ''),
    subtitle: compact(input.subtitle || ''),
    comparePrice: compact(input.comparePrice || input.comparisonPrice || ''),
    contactInsteadOfPrice: Boolean(input.contactInsteadOfPrice),
    imageUrl: compact(input.imageUrl || input.image || ''),
    image: compact(input.imageUrl || input.image || ''),
    allergens: compact(input.allergens || ''),
    included: normalizeStringList(input.included).filter((entry) => entry !== 'true' && entry !== 'false'),
    extraTexts: normalizeStringList(input.extraTexts),
    extraOptions: normalizeExtraOptions(input.extraOptions),
  };
  if (
    !keepEmpty
    && !item.title
    && !item.price
    && !item.description
    && !item.subtitle
    && !item.allergens
    && !item.included.length
    && !item.extraTexts.length
    && !item.extraOptions.length
    && !item.imageUrl
  ) {
    return null;
  }
  return item;
}

export function normalizeProductCategory(row = {}, { keepEmptyProducts = false } = {}) {
  const input = row && typeof row === 'object' ? row : {};
  const source = Array.isArray(input.products)
    ? input.products
    : (Array.isArray(input.items) ? input.items : []);
  const products = source
    .map((product) => normalizeProductItem(product, { keepEmpty: keepEmptyProducts }))
    .filter(Boolean);
  return {
    id: compact(input.id) || newId('cat'),
    name: compact(input.name || input.categoryName) || 'Kategori',
    products,
  };
}

export function normalizeProductCatalog(row = {}, { keepEmptyProducts = false } = {}) {
  const input = coerceCatalogLayout(row && typeof row === 'object' ? row : {});
  const layout = isProductLayout(input.layout) ? String(input.layout).toLowerCase() : 'normal';
  const categories = (Array.isArray(input.categories) ? input.categories : [])
    .map((category) => normalizeProductCategory(category, { keepEmptyProducts }))
    .filter((category) => category.name || category.products.length || keepEmptyProducts);
  return {
    id: compact(input.id) || newId('catalog'),
    layout,
    label: compact(input.label) || layoutLabel(layout),
    categories,
  };
}

export function catalogsToLegacyProducts(catalogs = []) {
  const list = Array.isArray(catalogs) ? catalogs : [];
  return list.flatMap((catalog, catalogIndex) => (
    (Array.isArray(catalog?.categories) ? catalog.categories : []).map((category, categoryIndex) => ({
      id: compact(category?.id) || `prod-cat-${catalogIndex + 1}-${categoryIndex + 1}`,
      categoryName: compact(category?.name || category?.categoryName),
      items: (Array.isArray(category?.products) ? category.products : []).map((product, itemIndex) => ({
        id: compact(product?.id) || `prod-item-${catalogIndex + 1}-${categoryIndex + 1}-${itemIndex + 1}`,
        title: compact(product?.title || product?.name),
        description: compact(product?.description),
        price: compact(product?.price),
        contactInsteadOfPrice: Boolean(product?.contactInsteadOfPrice),
        imageUrl: compact(product?.imageUrl || product?.image),
        included: true,
      })).filter((item) => item.title || item.description || item.price || item.imageUrl),
    }))
  )).filter((category) => category.categoryName || category.items.length);
}

export function legacyProductsToCatalogs(products = [], { layout = 'normal' } = {}) {
  const source = Array.isArray(products) ? products : [];
  const categories = source.map((category) => {
    const items = Array.isArray(category?.items)
      ? category.items
      : (Array.isArray(category?.products) ? category.products : []);
    return {
      id: category?.id,
      name: category?.categoryName || category?.name,
      products: items.map((item) => ({
        ...item,
        title: item?.title || item?.name,
        imageUrl: item?.imageUrl || item?.image,
        included: Array.isArray(item?.included) ? item.included : [],
      })),
    };
  }).filter((category) => category.name || (category.products && category.products.length));
  if (!categories.length) return [];
  return [
    normalizeProductCatalog({
      layout,
      label: layoutLabel(layout),
      categories,
    }, { keepEmptyProducts: true }),
  ];
}

export function normalizeProductCatalogs(value, { legacyProducts = [], keepEmptyProducts = false, extraHay = '' } = {}) {
  const rawCatalogs = Array.isArray(value) ? value : [];
  const catalogs = rawCatalogs
    .map((entry) => normalizeProductCatalog(coerceCatalogLayout(entry, extraHay), { keepEmptyProducts }))
    .filter((catalog) => catalog.categories.length > 0 || keepEmptyProducts);

  if (catalogs.length) return catalogs;
  return legacyProductsToCatalogs(legacyProducts);
}

export function buildEmptyProductItem() {
  return {
    id: newId('prod'),
    title: '',
    name: '',
    price: '',
    description: '',
    subtitle: '',
    comparePrice: '',
    contactInsteadOfPrice: false,
    imageUrl: '',
    image: '',
    allergens: '',
    included: [],
    extraTexts: [],
    extraOptions: [],
  };
}

export function buildEmptyCategory(name = 'Ny kategori') {
  return {
    id: newId('cat'),
    name: String(name || 'Ny kategori'),
    products: [],
  };
}

export function buildEmptyCatalog(layout = 'normal', { withStarterCategory = true } = {}) {
  const normalizedLayout = isProductLayout(layout) ? String(layout).toLowerCase() : 'normal';
  return {
    id: newId('catalog'),
    layout: normalizedLayout,
    label: layoutLabel(normalizedLayout),
    categories: withStarterCategory ? [buildEmptyCategory(defaultCategoryName(normalizedLayout))] : [],
  };
}

export function resolvePortalCatalogs({ productCatalogs, products, extraHay = '', keepEmptyProducts = true } = {}) {
  const catalogs = normalizeProductCatalogs(productCatalogs, {
    legacyProducts: products,
    keepEmptyProducts,
    extraHay,
  });
  return {
    productCatalogs: catalogs,
    products: catalogsToLegacyProducts(catalogs),
  };
}

export function summarizeCatalogs(catalogs = []) {
  const list = normalizeProductCatalogs(catalogs, { keepEmptyProducts: true });
  const catalog = list[0] || null;
  const categories = list.flatMap((entry) => (
    (entry?.categories || []).map((category) => ({
      id: category.id,
      name: list.length > 1 && entry.label && entry.label !== category.name
        ? `${entry.label} · ${category.name}`
        : category.name,
      productCount: Array.isArray(category.products) ? category.products.length : 0,
    }))
  ));
  const layoutLabels = [...new Set(list.map((entry) => entry.label || layoutLabel(entry.layout)).filter(Boolean))];
  return {
    layout: catalog?.layout || null,
    layoutLabel: layoutLabels.join(' / '),
    catalogCount: list.length,
    categoryCount: categories.length,
    productCount: categories.reduce((sum, category) => sum + category.productCount, 0),
    categories,
  };
}

export function countCatalogProducts(catalogs = []) {
  return summarizeCatalogs(catalogs).productCount;
}

export function capCatalogsToProductLimit(catalogs = [], limit = PRODUCT_IMPORT_CAP) {
  const source = normalizeProductCatalogs(catalogs, { keepEmptyProducts: true });
  const total = countCatalogProducts(source);
  if (total <= limit) {
    return { catalogs: source, kept: total, dropped: 0, truncated: false };
  }
  let left = limit;
  const out = [];
  for (const catalog of source) {
    if (left <= 0) break;
    const categories = [];
    for (const category of catalog.categories || []) {
      if (left <= 0) break;
      const products = (category.products || []).slice(0, left);
      left -= products.length;
      if (products.length) categories.push({ ...category, products });
    }
    if (categories.length) out.push({ ...catalog, categories });
  }
  return {
    catalogs: normalizeProductCatalogs(out, { keepEmptyProducts: true }),
    kept: limit,
    dropped: total - limit,
    truncated: true,
  };
}

export function mergeImportedCatalogs(existingCatalogs = [], importedCatalogs = []) {
  const existing = normalizeProductCatalogs(existingCatalogs, { keepEmptyProducts: true });
  const incoming = normalizeProductCatalogs(importedCatalogs, { keepEmptyProducts: true });
  return normalizeProductCatalogs(placeIncomingCatalogs(existing, incoming), { keepEmptyProducts: true });
}

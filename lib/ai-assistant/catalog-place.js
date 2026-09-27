/**
 * Place products from every new source against the shop hierarchy.
 *
 * Shop groups come from website scrape headings and document section
 * headings. File/sheet titles are sources, not aisles. A later label
 * joins an existing group when the names share the same leftover tokens
 * after wrapper/source-kind words are removed — not via a client-specific map.
 */

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function nameKey(value = '') {
  return compact(value)
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9æøåäöüéèê\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WRAPPER_TOKENS = new Set([
  'meny', 'menu', 'liste', 'list', 'katalog', 'catalog', 'sheet',
  'dokument', 'document', 'fil', 'file', 'page', 'side', 'del', 'part',
]);

const SOURCE_KIND_TOKENS = new Set([
  'allergi', 'allergy', 'allergen', 'allergener', 'dietary', 'diet',
  'nutrition', 'naering', 'næring', 'prisliste', 'inventory', 'import',
]);

function rawTokens(name = '') {
  return nameKey(name).split(' ').filter(Boolean);
}

export function tokensOf(name = '') {
  return rawTokens(name).filter((token) => (
    !WRAPPER_TOKENS.has(token)
    && !SOURCE_KIND_TOKENS.has(token)
    && !/^\d+$/.test(token)
  ));
}

export function corePhrase(name = '') {
  return tokensOf(name).join(' ');
}

export function looksLikeFileName(name = '') {
  const raw = compact(name);
  if (/\.(pdf|odt|ods|docx|doc|xlsx|xls|csv|txt)$/i.test(raw)) return true;
  const tokens = rawTokens(name);
  return tokens.length >= 2 && tokens.length <= 5 && tokens.some((token) => /^\d{1,4}$/.test(token));
}

function isModifierOnly(name = '') {
  const t = compact(name);
  if (!t) return false;
  if (/alternativ\s*\d+|varianter?|options?/i.test(t) && tokensOf(t).length <= 1) return true;
  return /^(gluten|laktose|melke|sukker|n[øo]tte)?[\s-]*(fritt?|free|fri)$/i.test(t)
    || /^(vegetar\w*|vegan\w*|glutenfritt?|laktosefritt?)$/i.test(t);
}

export function isDietOrVariantLabel(name = '') {
  const t = compact(name);
  if (!t) return false;
  if (tokensOf(t).length >= 1 && !isModifierOnly(t) && !SOURCE_KIND_TOKENS.has(nameKey(t))) {
    if (/^(meny|menu|kaker|drikke|catering|tapas|salater|smørbrød|smorbrod)$/i.test(t)) return false;
  }
  return isModifierOnly(t)
    || /gluten|laktose|melkefri|sukkerfri|n[øo]ttefri|vegetar|vegan|allerg|uten\s+(gluten|melk|laktose|sukker|n[øo]tt)|alternativ\s*\d+|varianter?|options?|fri\s+for|gluten[\s-]?fritt?/i.test(t);
}

function isGenericContainerLabel(name = '') {
  const t = nameKey(name);
  return !t || WRAPPER_TOKENS.has(t) || ['produkter', 'products', 'pakker', 'tiers', 'normal'].includes(t);
}

export function isUsableHeading(name = '') {
  const core = corePhrase(name);
  if (!core || looksLikeFileName(name) || isModifierOnly(name)) return false;
  if (WRAPPER_TOKENS.has(core) || SOURCE_KIND_TOKENS.has(core)) return false;
  if (/\d+[.,]?\d*\s*(kr|,-|nok|usd|eur)/i.test(name)) return false;
  return rawTokens(core).length <= 6;
}

function titleCasePhrase(phrase = '') {
  return compact(phrase).split(' ').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function similarScore(a = '', b = '') {
  const left = corePhrase(a) || nameKey(a);
  const right = corePhrase(b) || nameKey(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const A = new Set(left.split(' '));
  const B = new Set(right.split(' '));
  const inter = [...A].filter((token) => B.has(token));
  if (!inter.length) return 0;
  const union = new Set([...A, ...B]);
  const jaccard = inter.length / union.size;
  const subset = [...A].every((token) => B.has(token)) || [...B].every((token) => A.has(token));
  const phrase = left.includes(right) || right.includes(left);
  return Math.max(jaccard, subset ? 0.84 : 0, phrase ? 0.8 : 0);
}

export function similarHeading(name = '', headings = []) {
  let best = null;
  for (const heading of headings || []) {
    const headingName = heading?.name || heading;
    const score = similarScore(name, headingName);
    const weight = heading?.origin === 'website' ? 0.04 : 0;
    const total = score + weight;
    if (!best || total > best.score) best = { name: headingName, score: total, origin: heading?.origin || '' };
  }
  return best && best.score >= 0.5 ? best : null;
}

function inferOrigin(catalog = {}) {
  if (catalog.origin) return catalog.origin;
  if (/website|scrape|crawl|audit|woocommerce|shopify|wordpress|bigcommerce/i.test(catalog.source || '')) {
    return 'website';
  }
  if (catalog.sourceName || catalog.fileName) return 'document';
  if (catalog.layout === 'tiers') return 'website';
  return 'unknown';
}

function headingRank(entry = {}) {
  const name = compact(entry.name);
  const core = corePhrase(name);
  let rank = 0;
  if (entry.origin === 'website') rank += 10;
  if (core && nameKey(name) === core) rank += 5;
  rank -= name.length / 100;
  return rank;
}

export function harvestHeadings(catalogs = []) {
  const byCore = new Map();
  for (const catalog of catalogs || []) {
    const origin = inferOrigin(catalog);
    for (const category of catalog.categories || []) {
      const name = compact(category.name);
      if (!isUsableHeading(name) || looksLikeFileName(name)) continue;
      const key = corePhrase(name) || nameKey(name);
      if (!key) continue;
      const next = { name, origin, weight: origin === 'website' ? 3 : 2 };
      const current = byCore.get(key);
      if (!current || headingRank(next) > headingRank(current)) byCore.set(key, next);
    }
  }
  return [...byCore.values()];
}

export function isSourceDocumentLabel(name = '', headings = []) {
  const raw = compact(name);
  if (!raw) return false;
  if (looksLikeFileName(raw)) return true;
  const core = corePhrase(raw);
  if (!core) return true;
  if (headings.length && similarHeading(raw, headings)) return false;
  return SOURCE_KIND_TOKENS.has(core) || (SOURCE_KIND_TOKENS.has(rawTokens(raw)[0] || '') && !isUsableHeading(core));
}

function isCatalogLabelASource(catalog, headings = []) {
  if (!catalog || isPlanCatalog(catalog)) return false;
  const label = compact(catalog.label);
  if (!label || isGenericContainerLabel(label)) return false;
  if (looksLikeFileName(label) || catalog.sourceName && nameKey(stemName(catalog.sourceName)) === nameKey(label)) {
    return true;
  }
  const sections = (catalog.categories || []).map((category) => compact(category.name)).filter(Boolean);
  const labelIsSection = sections.some((name) => nameKey(name) === nameKey(label) || similarScore(name, label) >= 0.84);
  if (labelIsSection) return false;
  if (similarHeading(label, headings)) return false;
  if (inferOrigin(catalog) === 'website') return false;
  return !isUsableHeading(label) || isSourceDocumentLabel(label, headings) || (sections.length > 0 && !labelIsSection);
}

function stemName(fileName = '') {
  return compact(fileName).split(/[/\\]/).pop().replace(/\.[a-z0-9]+$/i, '');
}

function roleFromKey(t = '') {
  if (!t) return '';
  if (/drikke|drink|kaffe|te\b|kakao|mineralvann|vin|øl|ol\b|cocktail|juice/.test(t)) return 'drikke';
  if (/kake|dessert|terte|konfekt|donut|iscup|mousse|ostekake/.test(t)) return 'kaker';
  if (/salat/.test(t)) return 'salater';
  if (/smørbrød|smorbrod/.test(t)) return 'smørbrød';
  if (/småret|smaret|forrett|nachos|hamburger|omelett/.test(t)) return 'småretter';
  if (/dagen/.test(t)) return 'dagens';
  if (/brød|brod|bakst|ciabatta|foccacia|focaccia/.test(t)) return 'brød';
  if (/tapas/.test(t)) return 'tapas';
  if (/koldtbord/.test(t)) return 'koldtbord';
  if (/catering/.test(t)) return 'catering';
  if (/tillegg|extra/.test(t)) return 'tillegg';
  if (/hovedrett/.test(t)) return 'hovedrett';
  if (/seo|nettbutikk|skreddersydd|\/mnd|abonnement|premium|vekst/.test(t)) return 'plans';
  if (/^(meny|menu)$/.test(t)) return 'meny';
  if (/øvrig|annet|diverse|other|uncategor/.test(t)) return 'other';
  return '';
}

export function offeringRole(name = '') {
  const core = corePhrase(name);
  const fromCore = roleFromKey(core);
  if (fromCore && fromCore !== 'diet' && fromCore !== 'meny' && fromCore !== 'other') return fromCore;
  if (isModifierOnly(name) || (isDietOrVariantLabel(name) && !fromCore)) return 'diet';
  return roleFromKey(nameKey(name));
}

export function canonicalCategoryName(name = '', headings = []) {
  const original = compact(name);
  if (!original) return '';
  const hit = similarHeading(original, headings);
  if (hit) return hit.name;
  const core = corePhrase(original);
  if (core && core !== nameKey(original) && isUsableHeading(core)) return titleCasePhrase(core);
  if (!isUsableHeading(original)) return '';
  return original;
}

export function isWeakCategoryName(name = '', headings = []) {
  if (similarHeading(name, headings)) return false;
  if (canonicalCategoryName(name, headings) && isUsableHeading(corePhrase(name) || name)) return false;
  if (isModifierOnly(name) || isSourceDocumentLabel(name, headings)) return true;
  const role = offeringRole(name);
  return role === 'diet' || role === 'meny' || role === 'other' || role === '';
}

function isFoodLayout(layout = '') {
  return layout === 'meny' || layout === 'normal';
}

function isPlanCatalog(catalog) {
  return catalog?.layout === 'tiers' || offeringRole(catalog?.label) === 'plans';
}

function cloneCatalogs(catalogs = []) {
  return (Array.isArray(catalogs) ? catalogs : []).map((catalog) => ({
    ...catalog,
    categories: (catalog.categories || []).map((category) => ({
      ...category,
      products: (category.products || []).map((product) => ({ ...product })),
    })),
  }));
}

function productTitle(product = {}) {
  return compact(product.title || product.name);
}

function findProductAnywhere(catalogs, title) {
  const key = nameKey(title);
  if (!key) return null;
  for (const catalog of catalogs) {
    for (const category of catalog.categories || []) {
      for (const product of category.products || []) {
        if (nameKey(productTitle(product)) === key) {
          return { catalog, category, product };
        }
      }
    }
  }
  return null;
}

function mergeProductFields(target, incoming) {
  if (!target || !incoming) return;
  if (!target.price && incoming.price) target.price = incoming.price;
  if (!target.comparePrice && incoming.comparePrice) target.comparePrice = incoming.comparePrice;
  if (!target.description && incoming.description) target.description = incoming.description;
  if (!target.subtitle && incoming.subtitle) target.subtitle = incoming.subtitle;
  if (!target.imageUrl && incoming.imageUrl) {
    target.imageUrl = incoming.imageUrl;
    target.image = incoming.imageUrl;
  }
  if ((!target.included || !target.included.length) && incoming.included?.length) {
    target.included = [...incoming.included];
  }
  if (incoming.allergens) {
    const parts = `${target.allergens || ''}; ${incoming.allergens}`
      .split(/\s*;\s*/)
      .map(compact)
      .filter(Boolean);
    target.allergens = [...new Set(parts)].join('; ');
  }
}

function mergeProductsInto(keeper, incoming = []) {
  for (const product of incoming || []) {
    const existing = keeper.products.find((row) => nameKey(productTitle(row)) === nameKey(productTitle(product)));
    if (existing) mergeProductFields(existing, product);
    else keeper.products.push(product);
  }
}

function findCatalog(list, layout, label) {
  const wanted = nameKey(label || layout);
  return list.find((entry) => (
    entry.layout === layout
    && nameKey(entry.label || entry.layout) === wanted
  )) || null;
}

function ensureCatalog(list, layout, label) {
  const found = findCatalog(list, layout, label)
    || (isFoodLayout(layout) ? bestFoodCatalog(list) : null);
  if (found) return found;
  const catalog = {
    layout,
    label: compact(label) || (layout === 'normal' ? 'Produkter' : layout === 'tiers' ? 'Pakker' : 'Meny'),
    origin: layout === 'tiers' ? 'website' : '',
    categories: [],
  };
  list.push(catalog);
  return catalog;
}

function ensureCategory(catalog, name, headings = []) {
  const canon = canonicalCategoryName(name, headings) || compact(name) || 'Meny';
  const wanted = nameKey(canon);
  let category = (catalog.categories || []).find((entry) => (
    nameKey(canonicalCategoryName(entry.name, headings) || entry.name) === wanted
    || similarScore(entry.name, canon) >= 0.84
  ));
  if (category) {
    const keep = similarHeading(category.name, headings)?.name || category.name;
    category.name = keep;
    return category;
  }
  category = { name: canon, products: [] };
  catalog.categories.push(category);
  return category;
}

function bestFoodCatalog(list) {
  const food = (list || []).filter((entry) => isFoodLayout(entry.layout) && !isPlanCatalog(entry));
  return food.find((entry) => inferOrigin(entry) === 'website')
    || food.find((entry) => !isCatalogLabelASource(entry, harvestHeadings(list)))
    || food.find((entry) => entry.layout === 'meny')
    || food[0]
    || null;
}

function absorbSourceNamedCatalogs(list, headings = []) {
  const keep = [];
  const lifted = [];
  for (const catalog of list) {
    if (isFoodLayout(catalog.layout) && isCatalogLabelASource(catalog, headings)) {
      for (const category of catalog.categories || []) {
        for (const product of category.products || []) {
          lifted.push({ product, categoryName: category.name });
        }
      }
    } else {
      keep.push(catalog);
    }
  }
  list.length = 0;
  list.push(...keep);
  for (const row of lifted) {
    const title = productTitle(row.product);
    if (!title) continue;
    const hit = findProductAnywhere(list, title);
    if (hit) {
      mergeProductFields(hit.product, row.product);
      continue;
    }
    const home = resolveHome({
      catalogs: list,
      product: row.product,
      preferredCatalog: bestFoodCatalog(list),
      incomingCategoryName: row.categoryName,
      headings,
    });
    home.products.push({ ...row.product, title, name: title });
  }
}

function resolveHome({ catalogs, product, preferredCatalog, incomingCategoryName, headings = [] }) {
  const food = preferredCatalog && isFoodLayout(preferredCatalog.layout)
    ? preferredCatalog
    : bestFoodCatalog(catalogs) || ensureCatalog(catalogs, preferredCatalog?.layout || 'meny', 'Meny');

  const heading = similarHeading(incomingCategoryName, headings)
    || similarHeading(incomingCategoryName, (food.categories || []).map((category) => ({ name: category.name })));
  if (heading) return ensureCategory(food, heading.name, headings);

  const hit = findProductAnywhere(catalogs, productTitle(product));
  if (hit && isFoodLayout(hit.catalog.layout)) return hit.category;

  const canon = canonicalCategoryName(incomingCategoryName, headings);
  if (canon && isUsableHeading(canon) && !isWeakCategoryName(incomingCategoryName, headings)) {
    return ensureCategory(food, canon, headings);
  }

  const existingStrong = (food.categories || []).find((category) => !isWeakCategoryName(category.name, headings));
  if (existingStrong && isWeakCategoryName(incomingCategoryName, headings)) return existingStrong;

  const catchAll = (food.categories || []).find((category) => nameKey(category.name) === 'meny')
    || (food.categories || []).find((category) => isWeakCategoryName(category.name, headings));
  if (catchAll) return catchAll;
  return ensureCategory(food, 'Meny', headings);
}

function refileAndClean(catalogs, headings = []) {
  absorbSourceNamedCatalogs(catalogs, headings);
  for (const catalog of catalogs) {
    if (!isFoodLayout(catalog.layout)) continue;
    if (isCatalogLabelASource(catalog, headings)) catalog.label = catalog.layout === 'normal' ? 'Produkter' : 'Meny';

    const strong = (catalog.categories || []).filter((category) => !isWeakCategoryName(category.name, headings));
    const weak = (catalog.categories || []).filter((category) => isWeakCategoryName(category.name, headings));
    if (!strong.length) {
      const products = [];
      const seen = new Set();
      for (const category of catalog.categories || []) {
        for (const product of category.products || []) {
          const key = nameKey(productTitle(product));
          if (!key || seen.has(key)) {
            if (key && seen.has(key)) {
              const existing = products.find((row) => nameKey(productTitle(row)) === key);
              mergeProductFields(existing, product);
            }
            continue;
          }
          seen.add(key);
          products.push(product);
        }
      }
      catalog.categories = products.length ? [{ name: 'Meny', products }] : [];
      continue;
    }
    for (const category of weak) {
      const keep = [];
      for (const product of category.products || []) {
        const home = resolveHome({
          catalogs,
          product,
          preferredCatalog: catalog,
          incomingCategoryName: category.name,
          headings,
        });
        if (home && home !== category) home.products.push(product);
        else keep.push(product);
      }
      category.products = keep;
    }

    const byName = new Map();
    for (const category of catalog.categories || []) {
      const canon = canonicalCategoryName(category.name, headings) || category.name || 'Meny';
      category.name = canon;
      const key = nameKey(canon);
      if (!key) continue;
      const existingKey = [...byName.keys()].find((entry) => similarScore(entry, key) >= 0.84);
      if (existingKey) mergeProductsInto(byName.get(existingKey), category.products);
      else byName.set(key, category);
    }
    catalog.categories = [...byName.values()].filter((category) => (category.products || []).length);
  }
  return catalogs.filter((catalog) => (catalog.categories || []).some((category) => (category.products || []).length));
}

export function placeIncomingCatalogs(existingCatalogs = [], incomingCatalogs = []) {
  const next = cloneCatalogs(existingCatalogs);
  const incoming = cloneCatalogs(incomingCatalogs);
  const headings = harvestHeadings([...next, ...incoming]);
  absorbSourceNamedCatalogs(next, headings);

  for (const imported of incoming) {
    const foldIntoFood = isFoodLayout(imported.layout) && (
      isCatalogLabelASource(imported, headings)
      || (imported.categories || []).every((category) => isWeakCategoryName(category.name, headings))
    );
    let catalog = foldIntoFood
      ? (bestFoodCatalog(next) || null)
      : findCatalog(next, imported.layout, imported.label);
    if (!catalog) {
      if (foldIntoFood) {
        catalog = bestFoodCatalog(next) || ensureCatalog(next, imported.layout || 'meny', 'Meny');
      } else {
        catalog = {
          layout: imported.layout,
          label: imported.label,
          origin: imported.origin || inferOrigin(imported),
          source: imported.source,
          sourceName: imported.sourceName,
          categories: [],
        };
        next.push(catalog);
      }
    }

    for (const importedCategory of imported.categories || []) {
      for (const product of importedCategory.products || []) {
        const title = productTitle(product);
        if (!title) continue;
        const hit = findProductAnywhere(next, title);
        if (hit) {
          mergeProductFields(hit.product, product);
          const dest = resolveHome({
            catalogs: next,
            product: hit.product,
            preferredCatalog: catalog && isFoodLayout(catalog.layout) ? catalog : hit.catalog,
            incomingCategoryName: importedCategory.name,
            headings,
          });
          if (dest && dest !== hit.category) {
            hit.category.products = hit.category.products.filter((row) => row !== hit.product);
            dest.products.push(hit.product);
          }
          continue;
        }
        const target = resolveHome({
          catalogs: next,
          product,
          preferredCatalog: catalog,
          incomingCategoryName: importedCategory.name,
          headings,
        });
        target.products.push({ ...product, title, name: title });
      }
    }
  }

  return refileAndClean(next, harvestHeadings([...next, ...incoming]));
}

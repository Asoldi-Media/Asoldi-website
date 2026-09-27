/**
 * Deterministic product vs category placement.
 * Diet/allergen/source-file labels are never shop groups. A later source
 * can refile items into a better existing group; it must not only append.
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

const DIET_OR_VARIANT_TOKEN = /gluten[\s-]?fritt?|laktosefritt?|laktose|melkefri|sukkerfri|n[øo]ttefri|vegetar\w*|vegan\w*|allergi([\s-]*meny)?(\s*\d+)?|uten\s+(gluten|melk|laktose|sukker|n[øo]tt)|alternativ\s*\d+|varianter?|options?|fri\s+for/gi;
const SOURCE_SHEET_TOKEN = /\b(meny|menu|prisliste|katalog|catalog|sheet|liste)\s*\d+\b/gi;

export function isDietOrVariantLabel(name = '') {
  const t = compact(name);
  if (!t) return false;
  if (/^(meny|menu|kaker|drikke|catering|tapas|salater|smørbrød|smorbrod)$/i.test(t)) return false;
  return /gluten|laktose|melkefri|sukkerfri|n[øo]ttefri|vegetar|vegan|allerg|uten\s+(gluten|melk|laktose|sukker|n[øo]tt)|alternativ\s*\d+|varianter?|options?|fri\s+for|gluten[\s-]?fritt?/i.test(t);
}

export function isSourceDocumentLabel(name = '') {
  const raw = compact(name);
  const t = nameKey(name);
  if (!t) return false;
  if (/\.(pdf|odt|ods|docx|doc|xlsx|xls|csv)$/.test(t)) return true;
  if (/\b(meny|menu|prisliste|katalog|catalog|sheet|liste)\s*\d+\b/.test(t)) return true;
  if (/\ballergi\b/.test(t)) return true;
  if (/^prisliste\b/.test(t) && !shopGroupRole(raw)) return true;
  return false;
}

export function stripNonGroupTokens(name = '') {
  return compact(
    compact(name)
      .replace(DIET_OR_VARIANT_TOKEN, ' ')
      .replace(SOURCE_SHEET_TOKEN, ' '),
  );
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

export function shopGroupRole(name = '') {
  const stripped = stripNonGroupTokens(name);
  return roleFromKey(nameKey(stripped)) || roleFromKey(nameKey(name));
}

export function offeringRole(name = '') {
  const shop = shopGroupRole(name);
  if (shop && shop !== 'diet' && shop !== 'meny' && shop !== 'other') return shop;
  if (isDietOrVariantLabel(name) || isSourceDocumentLabel(name)) return 'diet';
  return roleFromKey(nameKey(name));
}

const PRETTY_GROUP = {
  drikke: 'Drikke',
  smørbrød: 'Smørbrød',
  smorbrod: 'Smørbrød',
  småretter: 'Småretter',
  smaretter: 'Småretter',
  salater: 'Salater',
  tapas: 'Tapas',
  koldtbord: 'Koldtbord',
  catering: 'Catering',
  tillegg: 'Tillegg',
  dagens: 'Dagens',
  hovedrett: 'Hovedrett',
};

export function canonicalCategoryName(name = '') {
  const original = compact(name);
  if (!original) return '';
  const stripped = stripNonGroupTokens(original);
  const strippedKey = nameKey(stripped);
  if (strippedKey && strippedKey !== nameKey(original) && shopGroupRole(stripped)) {
    return PRETTY_GROUP[strippedKey] || stripped.replace(/^\w/u, (char) => char.toUpperCase());
  }
  if (!strippedKey && (isDietOrVariantLabel(original) || isSourceDocumentLabel(original))) return '';
  return original;
}

export function isWeakCategoryName(name = '') {
  if (canonicalCategoryName(name) && shopGroupRole(name) && shopGroupRole(name) !== 'meny') return false;
  const role = offeringRole(name);
  return role === 'diet' || role === 'meny' || role === 'other' || role === '';
}

function isFoodLayout(layout = '') {
  return layout === 'meny' || layout === 'normal';
}

function isPlanCatalog(catalog) {
  return catalog?.layout === 'tiers' || offeringRole(catalog?.label) === 'plans';
}

function isSourceNamedCatalog(catalog) {
  if (!catalog || isPlanCatalog(catalog) || !isFoodLayout(catalog.layout)) return false;
  return isSourceDocumentLabel(catalog.label);
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
  const safeLabel = isSourceDocumentLabel(label) ? (layout === 'normal' ? 'Produkter' : 'Meny') : label;
  const found = findCatalog(list, layout, safeLabel)
    || (isFoodLayout(layout) ? bestFoodCatalog(list) : null);
  if (found) return found;
  const catalog = {
    layout,
    label: compact(safeLabel) || (layout === 'normal' ? 'Produkter' : layout === 'tiers' ? 'Pakker' : 'Meny'),
    categories: [],
  };
  list.push(catalog);
  return catalog;
}

function findCategoryByRole(catalog, role) {
  if (!role || role === 'diet' || role === 'other' || role === 'meny') return null;
  return (catalog.categories || []).find((category) => offeringRole(category.name) === role) || null;
}

function ensureCategory(catalog, name) {
  const canon = canonicalCategoryName(name) || compact(name) || 'Meny';
  const wanted = nameKey(canon);
  let category = (catalog.categories || []).find((entry) => (
    nameKey(canonicalCategoryName(entry.name) || entry.name) === wanted
  ));
  if (category) {
    if (canonicalCategoryName(category.name)) category.name = canonicalCategoryName(category.name);
    return category;
  }
  category = { name: canon, products: [] };
  catalog.categories.push(category);
  return category;
}

function bestFoodCatalog(list) {
  const food = (list || []).filter((entry) => isFoodLayout(entry.layout) && !isPlanCatalog(entry));
  return food.find((entry) => !isSourceDocumentLabel(entry.label) && nameKey(entry.label) !== 'meny')
    || food.find((entry) => !isSourceDocumentLabel(entry.label))
    || food.find((entry) => entry.layout === 'meny')
    || food[0]
    || null;
}

function absorbSourceNamedCatalogs(list) {
  const keep = [];
  const lifted = [];
  for (const catalog of list) {
    if (isSourceNamedCatalog(catalog)) {
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
    });
    home.products.push({ ...row.product, title, name: title });
  }
}

function resolveHome({ catalogs, product, preferredCatalog, incomingCategoryName }) {
  const incomingRole = offeringRole(incomingCategoryName);
  const productRole = offeringRole(productTitle(product));
  const role = incomingRole && incomingRole !== 'diet' && incomingRole !== 'meny' && incomingRole !== 'other'
    ? incomingRole
    : productRole;

  if (preferredCatalog && isFoodLayout(preferredCatalog.layout) && role && role !== 'diet' && role !== 'other' && role !== 'meny') {
    const byRole = findCategoryByRole(preferredCatalog, role);
    if (byRole) return byRole;
  }

  for (const catalog of catalogs) {
    if (!isFoodLayout(catalog.layout)) continue;
    if (role && role !== 'diet' && role !== 'other' && role !== 'meny') {
      const byRole = findCategoryByRole(catalog, role);
      if (byRole) return byRole;
    }
  }

  const food = preferredCatalog && isFoodLayout(preferredCatalog.layout)
    ? preferredCatalog
    : bestFoodCatalog(catalogs) || ensureCatalog(catalogs, preferredCatalog?.layout || 'meny', preferredCatalog?.label || 'Meny');

  if (role && role !== 'diet' && role !== 'other' && role !== 'meny' && (incomingRole === role || shopGroupRole(incomingCategoryName) === role)) {
    return ensureCategory(food, incomingCategoryName);
  }

  const existingStrong = (food.categories || []).find((category) => !isWeakCategoryName(category.name));
  if (existingStrong && (incomingRole === 'diet' || incomingRole === 'meny' || incomingRole === 'other' || !incomingRole)) {
    return existingStrong;
  }

  const catchAll = (food.categories || []).find((category) => nameKey(category.name) === 'meny')
    || (food.categories || []).find((category) => isWeakCategoryName(category.name));
  if (catchAll) return catchAll;
  return ensureCategory(food, 'Meny');
}

function refileAndClean(catalogs) {
  absorbSourceNamedCatalogs(catalogs);
  for (const catalog of catalogs) {
    if (!isFoodLayout(catalog.layout)) continue;
    if (isSourceDocumentLabel(catalog.label)) catalog.label = catalog.layout === 'normal' ? 'Produkter' : 'Meny';

    const strong = (catalog.categories || []).filter((category) => !isWeakCategoryName(category.name));
    const weak = (catalog.categories || []).filter((category) => isWeakCategoryName(category.name));
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
        const role = offeringRole(productTitle(product));
        const home = strong.find((entry) => offeringRole(entry.name) === role);
        if (home) home.products.push(product);
        else keep.push(product);
      }
      category.products = keep;
      if (isDietOrVariantLabel(category.name) || isSourceDocumentLabel(category.name)) {
        category.name = canonicalCategoryName(category.name) || 'Meny';
      }
    }

    const byName = new Map();
    for (const category of catalog.categories || []) {
      const canon = canonicalCategoryName(category.name) || category.name || 'Meny';
      category.name = canon;
      const key = nameKey(canon);
      if (!key) continue;
      if (byName.has(key)) mergeProductsInto(byName.get(key), category.products);
      else byName.set(key, category);
    }
    catalog.categories = [...byName.values()].filter((category) => (category.products || []).length);
  }
  return catalogs.filter((catalog) => (catalog.categories || []).some((category) => (category.products || []).length));
}

export function placeIncomingCatalogs(existingCatalogs = [], incomingCatalogs = []) {
  const next = cloneCatalogs(existingCatalogs);
  const incoming = cloneCatalogs(incomingCatalogs);
  absorbSourceNamedCatalogs(next);

  for (const imported of incoming) {
    const incomingIsOnlyWeak = (imported.categories || []).every((category) => isWeakCategoryName(category.name) || isDietOrVariantLabel(category.name));
    const foldIntoFood = isFoodLayout(imported.layout) && (isSourceDocumentLabel(imported.label) || incomingIsOnlyWeak);
    let catalog = foldIntoFood
      ? (bestFoodCatalog(next) || null)
      : findCatalog(next, imported.layout, imported.label);
    if (!catalog) {
      if (foldIntoFood || incomingIsOnlyWeak) {
        catalog = bestFoodCatalog(next) || ensureCatalog(next, imported.layout || 'meny', 'Meny');
      } else {
        catalog = {
          layout: imported.layout,
          label: isSourceDocumentLabel(imported.label) ? 'Meny' : imported.label,
          categories: (imported.categories || [])
            .filter((category) => canonicalCategoryName(category.name) || !isDietOrVariantLabel(category.name))
            .map((category) => ({
              ...category,
              name: canonicalCategoryName(category.name) || category.name,
              products: [],
            })),
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
          const incomingRole = offeringRole(importedCategory.name);
          if (incomingRole && incomingRole !== 'diet' && incomingRole !== 'meny' && incomingRole !== 'other') {
            const destCatalog = catalog && isFoodLayout(catalog.layout) ? catalog : hit.catalog;
            const dest = findCategoryByRole(destCatalog, incomingRole)
              || ensureCategory(destCatalog, importedCategory.name);
            if (dest !== hit.category) {
              hit.category.products = hit.category.products.filter((row) => row !== hit.product);
              dest.products.push(hit.product);
            }
          }
          continue;
        }
        const home = isDietOrVariantLabel(importedCategory.name) || isWeakCategoryName(importedCategory.name)
          ? resolveHome({
            catalogs: next,
            product,
            preferredCatalog: catalog,
            incomingCategoryName: importedCategory.name,
          })
          : (catalog && (
            (catalog.categories || []).find((entry) => (
              nameKey(canonicalCategoryName(entry.name) || entry.name)
              === nameKey(canonicalCategoryName(importedCategory.name) || importedCategory.name)
            ))
            || findCategoryByRole(catalog, offeringRole(importedCategory.name))
            || ensureCategory(catalog, importedCategory.name)
          ));
        const target = home || resolveHome({
          catalogs: next,
          product,
          preferredCatalog: catalog,
          incomingCategoryName: importedCategory.name,
        });
        target.products.push({ ...product, title, name: title });
      }
    }
  }

  return refileAndClean(next);
}

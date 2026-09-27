/**
 * Deterministic product vs category placement.
 * Diet/allergen/variant labels are never categories. A later source can
 * refile items into a better existing group; it must not only append buckets.
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

export function isDietOrVariantLabel(name = '') {
  const t = compact(name);
  if (!t) return false;
  if (/^(meny|menu|kaker|drikke|catering|tapas|salater|smørbrød|smorbrod)$/i.test(t)) return false;
  return /gluten|laktose|melkefri|sukkerfri|n[øo]ttefri|vegetar|vegan|allerg|uten\s+(gluten|melk|laktose|sukker|n[øo]tt)|alternativ\s*\d+|varianter?|options?|fri\s+for|gluten[\s-]?fritt?/i.test(t);
}

export function offeringRole(name = '') {
  const t = nameKey(name);
  if (!t) return '';
  if (isDietOrVariantLabel(name)) return 'diet';
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

export function isWeakCategoryName(name = '') {
  const role = offeringRole(name);
  return role === 'diet' || role === 'meny' || role === 'other' || role === '';
}

function isFoodLayout(layout = '') {
  return layout === 'meny' || layout === 'normal';
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

function findCatalog(list, layout, label) {
  const wanted = nameKey(label || layout);
  return list.find((entry) => (
    entry.layout === layout
    && nameKey(entry.label || entry.layout) === wanted
  )) || null;
}

function ensureCatalog(list, layout, label) {
  const found = findCatalog(list, layout, label);
  if (found) return found;
  const catalog = {
    layout,
    label: compact(label) || (layout === 'normal' ? 'Produkter' : layout === 'tiers' ? 'Pakker' : 'Meny'),
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
  const wanted = nameKey(name);
  let category = (catalog.categories || []).find((entry) => nameKey(entry.name) === wanted);
  if (category) return category;
  category = { name: compact(name) || 'Meny', products: [] };
  catalog.categories.push(category);
  return category;
}

function bestFoodCatalog(list) {
  return list.find((entry) => entry.layout === 'meny')
    || list.find((entry) => entry.layout === 'normal' && offeringRole(entry.label) !== 'plans')
    || null;
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

  if (role && role !== 'diet' && role !== 'other' && role !== 'meny' && incomingRole === role) {
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
  for (const catalog of catalogs) {
    if (!isFoodLayout(catalog.layout)) continue;
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
      if (isDietOrVariantLabel(category.name)) category.name = 'Meny';
    }

    const byRole = new Map();
    const leftover = [];
    for (const category of catalog.categories || []) {
      const role = offeringRole(category.name);
      if (!role || role === 'diet' || role === 'meny' || role === 'other') {
        leftover.push(category);
        continue;
      }
      if (byRole.has(role)) {
        const keeper = byRole.get(role);
        for (const product of category.products || []) {
          if (!keeper.products.some((row) => nameKey(productTitle(row)) === nameKey(productTitle(product)))) {
            keeper.products.push(product);
          } else {
            const existing = keeper.products.find((row) => nameKey(productTitle(row)) === nameKey(productTitle(product)));
            mergeProductFields(existing, product);
          }
        }
      } else {
        byRole.set(role, category);
      }
    }
    catalog.categories = [...byRole.values(), ...leftover].filter((category) => (category.products || []).length);
  }
  return catalogs.filter((catalog) => (catalog.categories || []).some((category) => (category.products || []).length));
}

export function placeIncomingCatalogs(existingCatalogs = [], incomingCatalogs = []) {
  const next = cloneCatalogs(existingCatalogs);
  const incoming = cloneCatalogs(incomingCatalogs);

  for (const imported of incoming) {
    const incomingIsOnlyWeak = (imported.categories || []).every((category) => isWeakCategoryName(category.name) || isDietOrVariantLabel(category.name));
    let catalog = findCatalog(next, imported.layout, imported.label);
    if (!catalog) {
      if (incomingIsOnlyWeak) {
        catalog = bestFoodCatalog(next) || ensureCatalog(next, imported.layout || 'meny', imported.label || 'Meny');
      } else {
        catalog = {
          layout: imported.layout,
          label: imported.label,
          categories: (imported.categories || [])
            .filter((category) => !isDietOrVariantLabel(category.name))
            .map((category) => ({ ...category, products: [] })),
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
            (catalog.categories || []).find((entry) => nameKey(entry.name) === nameKey(importedCategory.name))
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

/**
 * Scores Kundedata completeness for the developer project document.
 * Read-only. Domain is not a dot.
 */

import { CLIENT_DATA_POINTS } from './client-data-points.js';

const DEFAULT_COLORS = {
  primary: '#ff5b00',
  secondary: '#111827',
  accent: '#f9f9f8',
};

const DEFAULT_OPENING_DAYS = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

const LANGUAGE_PLACEHOLDER = 'norsk (norge)';
const REVIEW_TARGET = 5;

function sanitize(value = '') {
  return String(value ?? '').trim();
}

function getPath(root, path = '') {
  const parts = String(path || '').split('.').filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function makerRun(maker = {}) {
  if (maker?.failed) return {};
  const run = maker?.run && typeof maker.run === 'object' ? maker.run : maker;
  return run && typeof run === 'object' ? run : {};
}

function makerAnswers(maker = {}) {
  const run = makerRun(maker);
  return run.answers && typeof run.answers === 'object' ? run.answers : {};
}

function makerQuickFill(maker = {}) {
  const run = makerRun(maker);
  const answers = makerAnswers(maker);
  const fromRun = run.quickFillLinks && typeof run.quickFillLinks === 'object' ? run.quickFillLinks : {};
  const fromAnswers = answers.quickFillLinks && typeof answers.quickFillLinks === 'object' ? answers.quickFillLinks : {};
  return { ...fromAnswers, ...fromRun };
}

function resolveText(token, ctx) {
  const key = sanitize(token);
  if (key.startsWith('bank.')) return getPath(ctx.bank, key.slice(5));
  if (key.startsWith('client.')) return getPath(ctx.client, key.slice(7));
  if (key.startsWith('maker.quickFill.')) return makerQuickFill(ctx.maker)[key.slice('maker.quickFill.'.length)];
  if (key.startsWith('maker.')) return makerAnswers(ctx.maker)[key.slice(6)];
  return undefined;
}

function textFilled(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry)).filter(Boolean).length > 0;
  return Boolean(sanitize(value));
}

function anyText(point, ctx) {
  return (point.texts || []).some((token) => textFilled(resolveText(token, ctx)));
}

function listValues(point, ctx) {
  const raw = resolveText(point.list, ctx);
  const fromList = Array.isArray(raw) ? raw : [];
  const links = fromList
    .map((entry) => {
      if (typeof entry === 'string') return sanitize(entry);
      return sanitize(entry?.url || entry?.href || entry?.name);
    })
    .filter(Boolean);
  if (links.length) return links;
  return anyText(point, ctx) ? ['1'] : [];
}

function mediaList(bank, bucket) {
  const list = bank?.media?.[bucket];
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => {
    if (typeof entry === 'string') return Boolean(sanitize(entry));
    return Boolean(sanitize(entry?.url || entry?.src || entry?.path || entry?.fileName));
  });
}

function makerUploadCount(maker, fields = []) {
  const uploads = makerRun(maker).uploads;
  if (!uploads || typeof uploads !== 'object') return 0;
  let count = 0;
  for (const field of fields) {
    const list = uploads[field];
    if (Array.isArray(list)) count += list.filter(Boolean).length;
    else if (list) count += 1;
  }
  return count;
}

function openingHoursFilled(bank = {}) {
  if (sanitize(bank?.openingHours?.googleBusinessSyncUrl)) return true;
  const days = Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : [];
  if (!days.length) return false;
  if (days.length !== DEFAULT_OPENING_DAYS.length) return true;
  const isDefault = DEFAULT_OPENING_DAYS.every((expected, index) => {
    const row = days[index] || {};
    return sanitize(row.day) === expected.day
      && sanitize(row.opensAt) === expected.opensAt
      && sanitize(row.closesAt) === expected.closesAt
      && Boolean(row.closed) === expected.closed;
  });
  return !isDefault;
}

function makerHoursFilled(maker = {}) {
  const answers = makerAnswers(maker);
  return ['openingHoursMon', 'openingHoursTue', 'openingHoursWed', 'openingHoursThu', 'openingHoursFri', 'openingHoursSat', 'openingHoursSun']
    .some((key) => sanitize(answers[key]));
}

function colorFilled(point, ctx) {
  const stored = sanitize(ctx.bank?.brandIdentity?.colors?.[point.color]).toLowerCase();
  const fallback = DEFAULT_COLORS[point.color];
  if (stored && stored !== fallback) return true;
  const makerValue = sanitize(resolveText((point.texts || [])[0], ctx)).toLowerCase();
  return Boolean(makerValue && makerValue !== fallback);
}

function languageFilled(point, ctx) {
  return (point.texts || []).some((token) => {
    const value = sanitize(resolveText(token, ctx)).toLowerCase();
    return Boolean(value) && value !== LANGUAGE_PLACEHOLDER;
  });
}

function logoFilled(ctx) {
  if (sanitize(ctx.bank?.brandIdentity?.logos?.normal)) return true;
  if (mediaList(ctx.bank, 'logos').length) return true;
  return makerUploadCount(ctx.maker, ['logo']) > 0;
}

function faviconFilled(ctx) {
  if (sanitize(ctx.bank?.brandIdentity?.logos?.favicon)) return true;
  return makerUploadCount(ctx.maker, ['favicon']) > 0;
}

function catalogsOf(bank = {}, maker = {}) {
  const bankCatalogs = Array.isArray(bank.productCatalogs) ? bank.productCatalogs : [];
  if (bankCatalogs.length) return bankCatalogs;
  const run = makerRun(maker);
  const makerCatalogs = run.productCatalogs || run.answers?.productCatalogs;
  return Array.isArray(makerCatalogs) ? makerCatalogs : [];
}

function legacyCategories(bank = {}) {
  return Array.isArray(bank.products) ? bank.products : [];
}

function flattenProducts(bank = {}, maker = {}) {
  const out = [];
  for (const catalog of catalogsOf(bank, maker)) {
    for (const category of catalog?.categories || []) {
      for (const product of category?.products || []) out.push(product);
    }
  }
  if (out.length) return out;
  for (const category of legacyCategories(bank)) {
    for (const item of category?.items || []) out.push(item);
  }
  const run = makerRun(maker);
  const makerProducts = Array.isArray(run.products) ? run.products : [];
  for (const category of makerProducts) {
    for (const item of category?.items || category?.products || []) out.push(item);
  }
  return out;
}

function categoriesOf(bank = {}, maker = {}) {
  const out = [];
  for (const catalog of catalogsOf(bank, maker)) {
    for (const category of catalog?.categories || []) out.push(category);
  }
  if (out.length) return out;
  return legacyCategories(bank);
}

function productHas(product, field) {
  const row = product && typeof product === 'object' ? product : {};
  if (field === 'name') return Boolean(sanitize(row.title || row.name));
  if (field === 'price') return Boolean(sanitize(row.price));
  if (field === 'comparePrice') return Boolean(sanitize(row.comparePrice));
  if (field === 'contactInstead') return Boolean(row.contactInsteadOfPrice);
  if (field === 'subtitle') return Boolean(sanitize(row.subtitle));
  if (field === 'description') return Boolean(sanitize(row.description || row.desc));
  if (field === 'allergens') return Boolean(sanitize(row.allergens));
  if (field === 'included') return Array.isArray(row.included) ? row.included.some((entry) => sanitize(entry)) : Boolean(row.included);
  if (field === 'extraOptions') return Array.isArray(row.extraOptions) && row.extraOptions.some((entry) => sanitize(entry?.name || entry));
  if (field === 'extraTexts') return Array.isArray(row.extraTexts) && row.extraTexts.some((entry) => sanitize(entry));
  if (field === 'image') return Boolean(sanitize(row.imageUrl || row.image));
  return false;
}

function collectionMark(items, hasField) {
  if (!items.length) return { mark: 'red', detail: 'Ingen registrert' };
  const filled = items.filter(hasField).length;
  if (filled === items.length) return { mark: 'green', detail: `${filled} av ${items.length}` };
  if (filled === 0) return { mark: 'orange', detail: `0 av ${items.length}` };
  return { mark: 'orange', detail: `${filled} av ${items.length}` };
}

function reviewChunks(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitize(typeof entry === 'string' ? entry : (entry?.text || entry?.review || entry?.comment)))
      .filter((text) => text.length >= 8);
  }
  const raw = sanitize(value);
  if (!raw) return [];
  const lines = raw.split(/\n+/).map(sanitize).filter((text) => text.length >= 12);
  if (lines.length > 1) return lines;
  return [raw];
}

function reviewCount(ctx) {
  const chunks = [
    ...reviewChunks(ctx.bank?.websiteCreatorQuestions?.reviews),
    ...reviewChunks(makerAnswers(ctx.maker).reviews),
    ...reviewChunks(makerRun(ctx.maker).reviews),
  ];
  const seen = new Set(chunks.map((text) => text.toLowerCase().replace(/\s+/g, ' ')));
  return seen.size;
}

function binary(filled, detail = '') {
  return filled
    ? { mark: 'green', detail: detail || 'Utfylt' }
    : { mark: 'red', detail: detail || 'Mangler' };
}

function scorePoint(point, ctx) {
  if (point.kind === 'text' || point.kind === 'links' || point.kind === 'list') {
    if (point.kind === 'text') return binary(anyText(point, ctx));
    return binary(listValues(point, ctx).length > 0);
  }
  if (point.kind === 'language') return binary(languageFilled(point, ctx));
  if (point.kind === 'color') return binary(colorFilled(point, ctx));
  if (point.kind === 'hours') return binary(openingHoursFilled(ctx.bank) || makerHoursFilled(ctx.maker));
  if (point.kind === 'logo') return binary(logoFilled(ctx));
  if (point.kind === 'favicon') return binary(faviconFilled(ctx));
  if (point.kind === 'media') {
    const count = mediaList(ctx.bank, point.bucket).length + makerUploadCount(ctx.maker, point.makerFields || []);
    return binary(count > 0, count ? `${count} filer` : 'Mangler');
  }
  if (point.kind === 'reviews') {
    const count = reviewCount(ctx);
    if (count <= 0) return { mark: 'red', detail: `0 av ${REVIEW_TARGET}` };
    if (count < REVIEW_TARGET) return { mark: 'orange', detail: `${count} av ${REVIEW_TARGET}` };
    return { mark: 'green', detail: `${count} av ${REVIEW_TARGET}` };
  }
  if (point.kind === 'catalog-layout') {
    const catalogs = catalogsOf(ctx.bank, ctx.maker);
    return binary(catalogs.some((catalog) => sanitize(catalog?.layout)));
  }
  if (point.kind === 'category-name') {
    const categories = categoriesOf(ctx.bank, ctx.maker);
    const products = flattenProducts(ctx.bank, ctx.maker);
    if (!categories.length && !products.length) return { mark: 'red', detail: 'Ingen registrert' };
    return collectionMark(categories.length ? categories : products, (row) => Boolean(sanitize(row?.name || row?.categoryName || row?.title)));
  }
  if (point.kind === 'product') {
    return collectionMark(flattenProducts(ctx.bank, ctx.maker), (product) => productHas(product, point.field));
  }
  if (point.kind === 'staff') {
    const staff = Array.isArray(ctx.bank?.staff) ? ctx.bank.staff : [];
    return collectionMark(staff, (person) => Boolean(sanitize(person?.[point.field])));
  }
  if (point.kind === 'partner-category') {
    const categories = Array.isArray(ctx.bank?.affiliations) ? ctx.bank.affiliations : [];
    return collectionMark(categories, (row) => Boolean(sanitize(row?.categoryName)));
  }
  if (point.kind === 'partner-item') {
    const items = (Array.isArray(ctx.bank?.affiliations) ? ctx.bank.affiliations : [])
      .flatMap((category) => (Array.isArray(category?.items) ? category.items : []));
    return collectionMark(items, (item) => Boolean(sanitize(item?.title) && sanitize(item?.description) && sanitize(item?.imageUrl)));
  }
  return { mark: 'red', detail: 'Mangler' };
}

export function scoreClientMaterials({ client = {}, bank = {}, maker = {} } = {}) {
  const ctx = { client, bank, maker };
  return CLIENT_DATA_POINTS.map((point) => {
    const scored = scorePoint(point, ctx);
    return {
      id: point.id,
      group: point.group,
      label: point.label,
      mark: scored.mark,
      detail: scored.detail,
    };
  });
}

export function summarizeMaterialDots(dots = []) {
  const rows = Array.isArray(dots) ? dots : [];
  return {
    total: rows.length,
    filled: rows.filter((row) => row.mark === 'green').length,
    partial: rows.filter((row) => row.mark === 'orange').length,
    missing: rows.filter((row) => row.mark === 'red').length,
  };
}

export function developerDomainCard({ bank = {}, maker = {} } = {}) {
  const setup = bank?.domainSetup && typeof bank.domainSetup === 'object' ? bank.domainSetup : {};
  const hostname = sanitize(setup.domain)
    || sanitize(bank?.websiteCreatorQuestions?.websiteDomain)
    || sanitize(makerRun(maker)?.metadata?.productionDomain)
    || sanitize(makerAnswers(maker).websiteDomain);
  let statusLabel = '';
  if (setup.helpBuy || setup.helpNameservers || sanitize(setup.requestSentAt)) statusLabel = 'Hjelp forespurt';
  else if (setup.nameserversConfirmed) statusLabel = 'Navnservere bekreftet';
  else if (setup.ownership === 'buy') statusLabel = 'Må kjøpe';
  else if (setup.ownership === 'owned') statusLabel = 'Eier domenet';
  return {
    hostname,
    statusLabel,
    present: Boolean(hostname),
  };
}

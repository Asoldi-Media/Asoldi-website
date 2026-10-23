/**
 * Narrow brief a client CMS may read for its own service posts.
 * No other clients, no email, no phone, no prices, no media URLs.
 */
import {
  expandServices,
  SERVICE_CATALOG,
  SERVICE_EXCLUSIVE_FEATURES,
  servicesForTier,
  TIER_IDS,
} from '../packages/suite/core/delivery/vocab.js';

export const LOCAL_BLOG_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'LOCAL_BLOG_TOKEN',
  'LOCAL_BLOG_ENABLED=1',
];

export const LOCAL_BLOG_MONTHLY_QUOTA = 10;

function text(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 280) {
  const clean = text(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function pushService(out, seen, name, description) {
  const title = clip(name, 120);
  if (!title || out.length >= 24) return;
  const key = title.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: title, description: clip(description, 280) });
}

function walkCategories(categories, out, seen) {
  const rows = Array.isArray(categories) ? categories : [];
  for (const category of rows) {
    const items = Array.isArray(category?.items)
      ? category.items
      : (Array.isArray(category?.products) ? category.products : []);
    for (const item of items) {
      pushService(out, seen, item?.title || item?.name, item?.description || item?.subtitle || '');
    }
  }
}

export function collectLocalBlogServices(bank = {}) {
  const out = [];
  const seen = new Set();
  const catalogs = Array.isArray(bank.productCatalogs) ? bank.productCatalogs : [];
  for (const catalog of catalogs) walkCategories(catalog?.categories, out, seen);
  walkCategories(bank.products, out, seen);
  return out;
}

export function formatLocalBlogHours(openingHours = {}) {
  const status = text(openingHours?.status);
  if (status === 'not-relevant') return '';
  if (status === 'always') return 'Always open';
  if (status !== 'set') return '';
  const days = Array.isArray(openingHours.days) ? openingHours.days : [];
  const lines = days
    .map((day) => {
      const name = text(day?.day || day?.name);
      if (!name) return '';
      if (day?.closed) return `${name}: closed`;
      const opens = text(day?.opensAt || day?.open);
      const closes = text(day?.closesAt || day?.close);
      if (!opens && !closes) return '';
      return `${name}: ${opens}${closes ? `–${closes}` : ''}`;
    })
    .filter(Boolean);
  return lines.join('; ');
}

export function safeContactPath(value = '') {
  const path = text(value);
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 200) return '';
  if (/[\s"'<>]/.test(path)) return '';
  return path;
}

export function salesClientForSite(site, clients = []) {
  const key = text(site?.site_key);
  const id = text(site?.id);
  const rows = Array.isArray(clients) ? clients : [];
  return rows.find((row) => {
    const hubSite = row?.hubSite && typeof row.hubSite === 'object' ? row.hubSite : {};
    const siteKey = text(hubSite.siteKey || hubSite.site_key);
    const siteId = text(hubSite.id);
    return (key && siteKey === key) || (id && siteId && siteId === id);
  }) || null;
}

// Automatic posts are the WS6 feature `blog.localPosts`, which only the `seo` service (tier 2+)
// entitles (owner decision Q19). The legacy `features.blog` flag means the client-written blog,
// which every tier has once WS8.1 derives flags from services, so it cannot gate automatic posts
// alone.
const AUTO_POST_SERVICES = SERVICE_EXCLUSIVE_FEATURES['blog.localPosts'];

/**
 * The delivery services a hub site has. `planSource.services` (WS8.4) wins when it lists any.
 * Otherwise the tier's services; a custom plan (flags picked by hand) counts a service when every
 * legacy flag it maps to is on (`seo` -> `analytics`). An unknown plan reads as tier 1.
 */
export function siteServices(site = {}) {
  const listed = site?.planSource?.services;
  if (Array.isArray(listed) && listed.length) return expandServices(listed);
  const plan = text(site?.websitePlan);
  if (plan === 'custom') {
    const features = site?.features && typeof site.features === 'object' ? site.features : {};
    return SERVICE_CATALOG
      .filter((service) => service.legacyFlags.length && service.legacyFlags.every((flag) => features[flag] === true))
      .map((service) => service.id);
  }
  return servicesForTier(TIER_IDS.includes(plan) && plan !== 'custom' ? plan : 'tier-1-standard');
}

/** Automatic local posts: the blog flag is on and the site has a service that entitles them. */
export function localBlogAutoPostsEnabled(site = {}) {
  if (site?.features?.blog !== true) return false;
  return siteServices(site).some((id) => AUTO_POST_SERVICES.includes(id));
}

export function buildLocalBlogBrief({ site = {}, profile = null, salesClient = null } = {}) {
  const bank = profile?.clientDataBank && typeof profile.clientDataBank === 'object'
    ? profile.clientDataBank
    : {};
  const questions = bank.websiteCreatorQuestions && typeof bank.websiteCreatorQuestions === 'object'
    ? bank.websiteCreatorQuestions
    : {};
  const businessName = clip(
    bank.generalInfo?.companyName
      || bank.businessCard?.companyName
      || profile?.businessName
      || salesClient?.businessName
      || site?.name,
    160,
  );
  const narrative = [
    questions.businessWhat,
    questions.differentiator,
    questions.businessStory,
  ].map((part) => clip(part, 700)).filter(Boolean).join('\n');
  const industry = clip(bank.businessCard?.industry, 120);
  const whatTheyDo = [narrative, industry && `Industry: ${industry}`].filter(Boolean).join('\n');
  const town = clip(questions.town, 80);
  const country = clip(questions.country, 80);
  const address = clip(
    bank.generalInfo?.companyAddress || salesClient?.businessAddress,
    200,
  );
  const services = collectLocalBlogServices(bank);
  const language = clip(bank.generalInfo?.websiteLanguage, 80) || 'Norsk (Norge)';
  return {
    // The CMS local-blog job skips when this is false. It means "automatic posts allowed".
    blogEnabled: localBlogAutoPostsEnabled(site),
    monthlyQuota: LOCAL_BLOG_MONTHLY_QUOTA,
    businessName,
    whatTheyDo,
    services,
    address,
    serviceArea: [town, country].filter(Boolean).join(', '),
    places: town ? [town] : [],
    language,
    hours: formatLocalBlogHours(bank.openingHours),
    contactPath: safeContactPath(questions.mainCtaUrl),
    hasSubject: services.length > 0 || narrative.length >= 40,
  };
}

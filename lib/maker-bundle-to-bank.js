import { resolvePortalCatalogs } from './client-product-catalog.js';

function countCatalogProducts(catalogs = []) {
  return (Array.isArray(catalogs) ? catalogs : []).reduce(
    (sum, catalog) => sum + (catalog.categories || []).reduce((inner, category) => inner + (category.products || []).length, 0),
    0
  );
}

function text(value = '') {
  return String(value ?? '').trim();
}

function splitLines(value = '') {
  return text(value)
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseHour(value = '') {
  const raw = text(value);
  if (!raw || /stengt|closed/i.test(raw)) return { opensAt: '08:00', closesAt: '16:00', closed: true };
  const match = raw.match(/(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/);
  if (!match) return { opensAt: raw, closesAt: '', closed: false };
  return {
    opensAt: match[1].replace('.', ':'),
    closesAt: match[2].replace('.', ':'),
    closed: false,
  };
}

const DAY_KEYS = [
  ['openingHoursMon', 'Mandag'],
  ['openingHoursTue', 'Tirsdag'],
  ['openingHoursWed', 'Onsdag'],
  ['openingHoursThu', 'Torsdag'],
  ['openingHoursFri', 'Fredag'],
  ['openingHoursSat', 'Lørdag'],
  ['openingHoursSun', 'Søndag'],
];

export function makerBundleToClientDataBank(bundle = {}, fallback = {}) {
  const data = bundle?.data && typeof bundle.data === 'object' ? bundle.data : (bundle || {});
  const catalogs = resolvePortalCatalogs({
    productCatalogs: bundle.productCatalogs || data.productCatalogs,
    products: bundle.products || data.products,
    extraHay: `${data.industry || ''} ${data.businessName || ''}`,
    keepEmptyProducts: true,
  });

  const days = DAY_KEYS.map(([key, day]) => ({
    day,
    ...parseHour(data[key]),
  }));

  return {
    businessCard: {
      companyName: text(data.businessName || bundle.name || fallback.businessCard?.companyName),
      industry: text(data.industry || fallback.businessCard?.industry),
      websiteGoal: text(data.businessWhat || fallback.businessCard?.websiteGoal),
    },
    generalInfo: {
      companyName: text(data.businessName || fallback.generalInfo?.companyName),
      companyAddress: text(data.address || fallback.generalInfo?.companyAddress),
      websiteLanguage: text(data.websiteLanguage || fallback.generalInfo?.websiteLanguage) || 'Norsk (Norge)',
      companyPhone: text(data.phone || fallback.generalInfo?.companyPhone),
      companyEmail: text(data.email || fallback.generalInfo?.companyEmail).toLowerCase(),
      socialMediaLinks: splitLines(data.relevantLinks).filter((url) => /instagram|facebook|linkedin/i.test(url)),
      extraLinks: splitLines(data.relevantLinks).map((url) => ({ name: '', url })),
    },
    brandIdentity: {
      orgNumber: text(fallback.brandIdentity?.orgNumber),
      colors: {
        primary: text(data.primaryHex) || fallback.brandIdentity?.colors?.primary || '#FF5B00',
        secondary: text(data.secondaryHex) || fallback.brandIdentity?.colors?.secondary || '#111827',
        accent: text(data.accentHex) || fallback.brandIdentity?.colors?.accent || '#F9F9F8',
      },
      logos: fallback.brandIdentity?.logos || { normal: '', favicon: '' },
    },
    openingHours: {
      googleBusinessSyncUrl: text(data.googleBusinessProfile || bundle.quickFillLinks?.googleBusinessProfile),
      days,
    },
    affiliations: Array.isArray(fallback.affiliations) ? fallback.affiliations : [],
    productCatalogs: countCatalogProducts(catalogs.productCatalogs) >= countCatalogProducts(fallback.productCatalogs)
      ? (catalogs.productCatalogs.length ? catalogs.productCatalogs : (fallback.productCatalogs || []))
      : (fallback.productCatalogs || []),
    products: countCatalogProducts(catalogs.productCatalogs) >= countCatalogProducts(fallback.productCatalogs)
      ? (catalogs.products.length ? catalogs.products : (fallback.products || []))
      : (fallback.products || []),
    media: {
      mainHeroImages: fallback.media?.mainHeroImages || [],
      galleryImages: fallback.media?.galleryImages || [],
      logos: fallback.media?.logos || [],
      icons: fallback.media?.icons || [],
      uncategorized: fallback.media?.uncategorized || [],
      teamImages: fallback.media?.teamImages || [],
      aboutImages: fallback.media?.aboutImages || [],
      locationImages: fallback.media?.locationImages || [],
      illustrationImages: fallback.media?.illustrationImages || [],
      offeringImages: fallback.media?.offeringImages || [],
      briefs: Array.isArray(bundle.mediaBriefs)
        ? bundle.mediaBriefs
        : (fallback.media?.briefs || []),
    },
    websiteCreatorQuestions: {
      targetAudience: text(data.targetAudience) || text(fallback.websiteCreatorQuestions?.targetAudience),
      keyMessage: text(data.differentiator) || text(fallback.websiteCreatorQuestions?.keyMessage),
      toneOfVoice: text(data.toneOfVoice) || text(fallback.websiteCreatorQuestions?.toneOfVoice),
      primaryAction: text(data.wantedPages) || text(fallback.websiteCreatorQuestions?.primaryAction),
      importantKeywords: splitLines(data.customSections).length
        ? splitLines(data.customSections)
        : (fallback.websiteCreatorQuestions?.importantKeywords || []),
      competitorLinks: splitLines(data.relevantLinks).length
        ? splitLines(data.relevantLinks)
        : (fallback.websiteCreatorQuestions?.competitorLinks || []),
      businessWhat: text(data.businessWhat) || text(fallback.websiteCreatorQuestions?.businessWhat),
      businessStory: text(data.businessStory) || text(fallback.websiteCreatorQuestions?.businessStory),
      differentiator: text(data.differentiator) || text(fallback.websiteCreatorQuestions?.differentiator),
      reviews: text(data.reviews) || text(fallback.websiteCreatorQuestions?.reviews),
      extraContext: text(data.extraContext) || text(fallback.websiteCreatorQuestions?.extraContext),
      wantedPages: text(data.wantedPages) || text(fallback.websiteCreatorQuestions?.wantedPages),
      customSections: text(data.customSections) || text(fallback.websiteCreatorQuestions?.customSections),
      websiteDomain: text(data.websiteDomain) || text(fallback.websiteCreatorQuestions?.websiteDomain),
      town: text(data.town) || text(fallback.websiteCreatorQuestions?.town),
      country: text(data.country) || text(fallback.websiteCreatorQuestions?.country),
      relevantLinks: text(data.relevantLinks) || text(fallback.websiteCreatorQuestions?.relevantLinks),
    },
    makerLink: {
      ...(fallback.makerLink || {}),
      bundleId: text(bundle.id) || text(fallback.makerLink?.bundleId),
      bundleName: text(bundle.name || data.businessName) || text(fallback.makerLink?.bundleName),
      email: text(data.email || fallback.makerLink?.email).toLowerCase(),
      businessId: text(fallback.makerLink?.businessId),
      syncedAt: new Date().toISOString(),
    },
  };
}

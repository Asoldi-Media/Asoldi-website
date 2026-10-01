import {
  PRODUCT_LAYOUTS,
  buildEmptyCatalog,
  resolvePortalCatalogs,
} from '../../../../lib/client-product-catalog.js';

type PortalCatalogInput = {
  productCatalogs?: unknown;
  products?: unknown;
  extraHay?: string;
  keepEmptyProducts?: boolean;
};

export function resolveClientCatalogs(input: PortalCatalogInput): {
  productCatalogs: ProductCatalog[];
  products: ProductCategory[];
} {
  const resolved = resolvePortalCatalogs(input);
  return {
    productCatalogs: (resolved.productCatalogs || []) as ProductCatalog[],
    products: (resolved.products || []) as ProductCategory[],
  };
}

export type SettingsSection = 'kundedata' | 'fakturering' | 'konto';
export type DataTab = 'bedrifts_kort' | 'produkter' | 'media' | 'generell' | 'v2';

export type OpeningDay = {
  day: string;
  opensAt: string;
  closesAt: string;
  closed: boolean;
};

export type LinkItem = {
  name: string;
  url: string;
};

export type AffiliationItem = {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
};

export type AffiliationCategory = {
  id: string;
  categoryName: string;
  items: AffiliationItem[];
};

export type ExtraOption = {
  name: string;
  price: string;
};

export type CatalogProduct = {
  id: string;
  title: string;
  name: string;
  description: string;
  price: string;
  subtitle: string;
  comparePrice: string;
  contactInsteadOfPrice: boolean;
  imageUrl: string;
  image: string;
  allergens: string;
  included: string[];
  extraTexts: string[];
  extraOptions: ExtraOption[];
};

export type CatalogCategory = {
  id: string;
  name: string;
  products: CatalogProduct[];
};

export type ProductCatalog = {
  id: string;
  layout: 'normal' | 'meny' | 'tiers';
  label: string;
  categories: CatalogCategory[];
};

export type ProductItem = {
  id: string;
  title: string;
  description: string;
  price: string;
  contactInsteadOfPrice: boolean;
  imageUrl: string;
  included: boolean;
};

export type ProductCategory = {
  id: string;
  categoryName: string;
  items: ProductItem[];
};

export type MediaBucketKey = Exclude<keyof ClientDataBank['media'], 'briefs'>;

export type ClientDataBank = {
  businessCard: {
    companyName: string;
    industry: string;
    websiteGoal: string;
  };
  generalInfo: {
    companyName: string;
    companyAddress: string;
    websiteLanguage: string;
    companyPhone: string;
    companyEmail: string;
    socialMediaLinks: string[];
    extraLinks: LinkItem[];
  };
  brandIdentity: {
    orgNumber: string;
    colors: {
      primary: string;
      secondary: string;
      accent: string;
    };
    logos: {
      normal: string;
      favicon: string;
    };
  };
  openingHours: {
    googleBusinessSyncUrl: string;
    days: OpeningDay[];
  };
  affiliations: AffiliationCategory[];
  productCatalogs: ProductCatalog[];
  products: ProductCategory[];
  media: {
    mainHeroImages: string[];
    galleryImages: string[];
    logos: string[];
    icons: string[];
    uncategorized: string[];
    teamImages: string[];
    aboutImages: string[];
    locationImages: string[];
    illustrationImages: string[];
    offeringImages: string[];
    briefs: Array<Record<string, unknown>>;
  };
  websiteCreatorQuestions: {
    targetAudience: string;
    keyMessage: string;
    toneOfVoice: string;
    primaryAction: string;
    importantKeywords: string[];
    competitorLinks: string[];
    businessWhat: string;
    businessStory: string;
    differentiator: string;
    reviews: string;
    extraContext: string;
    wantedPages: string;
    customSections: string;
    websiteDomain: string;
    town: string;
    country: string;
    relevantLinks: string;
    mainCtaText: string;
    mainCtaUrl: string;
  };
  makerLink?: {
    bundleId?: string;
    bundleName?: string;
    email?: string;
    salesClientId?: string;
    runId?: string;
    publicPreviewUrl?: string;
    tunnelUrl?: string;
    syncedAt?: string;
  };
};

export const DEFAULT_DAYS: OpeningDay[] = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

export const LANGUAGE_OPTIONS = [
  'Norsk (Norge)',
  'Svenska (Sverige)',
  'Dansk (Danmark)',
  'English (US)',
  'English (UK)',
  'English (Canada)',
  'English (Australia)',
  'Deutsch (Deutschland)',
  'Français (France)',
  'Español (España)',
  'Español (Mexico)',
  'Italiano (Italia)',
  'Nederlands (Nederland)',
  'Polski (Polska)',
  'Português (Brasil)',
  'Português (Portugal)',
];

export const MEDIA_BUCKETS: Array<{ key: MediaBucketKey; label: string }> = [
  { key: 'mainHeroImages', label: 'Hovedbilde' },
  { key: 'aboutImages', label: 'Om oss' },
  { key: 'teamImages', label: 'Ansatte' },
  { key: 'locationImages', label: 'Lokasjon' },
  { key: 'logos', label: 'Logo' },
  { key: 'icons', label: 'Ikoner' },
  { key: 'illustrationImages', label: 'Illustrasjoner' },
  { key: 'offeringImages', label: 'Tjenester / meny' },
  { key: 'galleryImages', label: 'Bildegalleri' },
  { key: 'uncategorized', label: 'Annet' },
];

export { PRODUCT_LAYOUTS };

export function randomId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

export function normalizeHex(value: string, fallback: string) {
  const upper = String(value || '').trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(upper)) return upper;
  const fallbackUpper = String(fallback || '').trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(fallbackUpper) ? fallbackUpper : '#FF5B00';
}

export function clientMediaSrc(url: string, token = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('/client-media/') && token) {
    return `${value}${value.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }
  return value;
}

export function sectionPath(section: SettingsSection, hash = '') {
  if (section === 'fakturering') return '/kunde/innstillinger/fakturering';
  if (section === 'konto') return '/kunde/innstillinger/konto';
  return `/kunde/innstillinger${hash}`;
}

export function dataTabFromHash(hash: string): DataTab {
  const value = String(hash || '').replace(/^#/, '');
  if (value === 'produkter') return 'produkter';
  if (value === 'media') return 'media';
  if (value === 'generell' || value === 'generell-info') return 'generell';
  if (value === 'v2' || value === 'nettsidebygger') return 'v2';
  return 'bedrifts_kort';
}

export function hashForDataTab(tab: DataTab) {
  if (tab === 'produkter') return '#produkter';
  if (tab === 'media') return '#media';
  if (tab === 'generell') return '#generell';
  if (tab === 'v2') return '#v2';
  return '';
}

export function defaultClientDataBank(profile: any): ClientDataBank {
  const businessName = String(profile?.businessName || '').trim();
  const businessEmail = String(profile?.email || '').trim();
  const businessOrg = String(profile?.businessOrgNumber || '').trim();
  return {
    businessCard: {
      companyName: businessName,
      industry: '',
      websiteGoal: '',
    },
    generalInfo: {
      companyName: businessName,
      companyAddress: '',
      websiteLanguage: 'Norsk (Norge)',
      companyPhone: '',
      companyEmail: businessEmail,
      socialMediaLinks: [''],
      extraLinks: [{ name: '', url: '' }],
    },
    brandIdentity: {
      orgNumber: businessOrg,
      colors: {
        primary: '#FF5B00',
        secondary: '#111827',
        accent: '#F9F9F8',
      },
      logos: {
        normal: '',
        favicon: '',
      },
    },
    openingHours: {
      googleBusinessSyncUrl: '',
      days: DEFAULT_DAYS,
    },
    affiliations: [],
    productCatalogs: [],
    products: [],
    media: {
      mainHeroImages: [],
      galleryImages: [],
      logos: [],
      icons: [],
      uncategorized: [],
      teamImages: [],
      aboutImages: [],
      locationImages: [],
      illustrationImages: [],
      offeringImages: [],
      briefs: [],
    },
    websiteCreatorQuestions: {
      targetAudience: '',
      keyMessage: '',
      toneOfVoice: '',
      primaryAction: '',
      importantKeywords: [],
      competitorLinks: [],
      businessWhat: '',
      businessStory: '',
      differentiator: '',
      reviews: '',
      extraContext: '',
      wantedPages: '',
      customSections: '',
      websiteDomain: '',
      town: '',
      country: '',
      relevantLinks: '',
      mainCtaText: '',
      mainCtaUrl: '',
    },
    makerLink: {
      bundleId: '',
      bundleName: '',
      email: '',
      salesClientId: '',
      runId: '',
      publicPreviewUrl: '',
      tunnelUrl: '',
      syncedAt: '',
    },
  };
}

function ensureList(values: any, fallback: string[] = [], keepOneEmpty = false) {
  const source = Array.isArray(values) ? values : fallback;
  const normalized = source.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (normalized.length) return normalized;
  return keepOneEmpty ? [''] : [];
}

export function ensureClientDataBank(input: any, profile: any): ClientDataBank {
  const base = defaultClientDataBank(profile);
  const bank = input && typeof input === 'object' ? input : {};
  const openingDaysSource = Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : [];
  const openingDays = DEFAULT_DAYS.map((day, idx) => {
    const row = openingDaysSource[idx] || openingDaysSource.find((candidate: any) => String(candidate?.day || '').toLowerCase() === day.day.toLowerCase()) || {};
    return {
      day: String(row.day || day.day),
      opensAt: String(row.opensAt || row.open || day.opensAt),
      closesAt: String(row.closesAt || row.close || day.closesAt),
      closed: Boolean(row.closed ?? day.closed),
    };
  });

  const affiliations: AffiliationCategory[] = Array.isArray(bank?.affiliations)
    ? bank.affiliations.map((category: any, categoryIndex: number) => ({
      id: String(category?.id || randomId(`aff-cat-${categoryIndex + 1}`)),
      categoryName: String(category?.categoryName || category?.name || '').trim(),
      items: Array.isArray(category?.items)
        ? category.items.map((item: any, itemIndex: number) => ({
          id: String(item?.id || randomId(`aff-item-${itemIndex + 1}`)),
          title: String(item?.title || '').trim(),
          description: String(item?.description || item?.desc || '').trim(),
          imageUrl: String(item?.imageUrl || item?.image || '').trim(),
        }))
        : [],
    }))
    : [];

  const resolved = resolveClientCatalogs({
    productCatalogs: bank?.productCatalogs,
    products: bank?.products,
    extraHay: String(bank?.businessCard?.industry || ''),
    keepEmptyProducts: true,
  });
  const productCatalogs = resolved.productCatalogs;
  const products = resolved.products

  return {
    businessCard: {
      companyName: String(bank?.businessCard?.companyName || bank?.generalInfo?.companyName || base.businessCard.companyName).trim(),
      industry: String(bank?.businessCard?.industry || base.businessCard.industry).trim(),
      websiteGoal: String(bank?.businessCard?.websiteGoal || bank?.businessCard?.goal || base.businessCard.websiteGoal).trim(),
    },
    generalInfo: {
      companyName: String(bank?.generalInfo?.companyName || bank?.businessCard?.companyName || base.generalInfo.companyName).trim(),
      companyAddress: String(bank?.generalInfo?.companyAddress || bank?.generalInfo?.address || base.generalInfo.companyAddress).trim(),
      websiteLanguage: String(bank?.generalInfo?.websiteLanguage || bank?.generalInfo?.language || base.generalInfo.websiteLanguage).trim(),
      companyPhone: String(bank?.generalInfo?.companyPhone || bank?.generalInfo?.phone || base.generalInfo.companyPhone).trim(),
      companyEmail: String(bank?.generalInfo?.companyEmail || bank?.generalInfo?.email || base.generalInfo.companyEmail).trim(),
      socialMediaLinks: ensureList(
        bank?.generalInfo?.socialMediaLinks || bank?.generalInfo?.socialLinks,
        base.generalInfo.socialMediaLinks,
        true
      ),
      extraLinks: Array.isArray(bank?.generalInfo?.extraLinks) && bank.generalInfo.extraLinks.length
        ? bank.generalInfo.extraLinks.map((entry: any) => ({
          name: String(entry?.name || '').trim(),
          url: String(entry?.url || '').trim(),
        }))
        : base.generalInfo.extraLinks,
    },
    brandIdentity: {
      orgNumber: String(bank?.brandIdentity?.orgNumber || bank?.brandIdentity?.organizationNumber || base.brandIdentity.orgNumber).trim(),
      colors: {
        primary: normalizeHex(String(bank?.brandIdentity?.colors?.primary || ''), base.brandIdentity.colors.primary),
        secondary: normalizeHex(String(bank?.brandIdentity?.colors?.secondary || ''), base.brandIdentity.colors.secondary),
        accent: normalizeHex(String(bank?.brandIdentity?.colors?.accent || ''), base.brandIdentity.colors.accent),
      },
      logos: {
        normal: String(bank?.brandIdentity?.logos?.normal || '').trim(),
        favicon: String(bank?.brandIdentity?.logos?.favicon || '').trim(),
      },
    },
    openingHours: {
      googleBusinessSyncUrl: String(bank?.openingHours?.googleBusinessSyncUrl || bank?.openingHours?.syncLink || '').trim(),
      days: openingDays,
    },
    affiliations,
    productCatalogs,
    products,
    media: {
      mainHeroImages: ensureList(bank?.media?.mainHeroImages, []),
      galleryImages: ensureList(bank?.media?.galleryImages, []),
      logos: ensureList(bank?.media?.logos, []),
      icons: ensureList(bank?.media?.icons, []),
      uncategorized: ensureList(bank?.media?.uncategorized, []),
      teamImages: ensureList(bank?.media?.teamImages, []),
      aboutImages: ensureList(bank?.media?.aboutImages, []),
      locationImages: ensureList(bank?.media?.locationImages, []),
      illustrationImages: ensureList(bank?.media?.illustrationImages, []),
      offeringImages: ensureList(bank?.media?.offeringImages, []),
      briefs: Array.isArray(bank?.media?.briefs) ? bank.media.briefs : [],
    },
    websiteCreatorQuestions: {
      targetAudience: String(bank?.websiteCreatorQuestions?.targetAudience || '').trim(),
      keyMessage: String(bank?.websiteCreatorQuestions?.keyMessage || '').trim(),
      toneOfVoice: String(bank?.websiteCreatorQuestions?.toneOfVoice || '').trim(),
      primaryAction: String(bank?.websiteCreatorQuestions?.primaryAction || bank?.websiteCreatorQuestions?.mainCtaText || '').trim(),
      importantKeywords: ensureList(bank?.websiteCreatorQuestions?.importantKeywords, []),
      competitorLinks: ensureList(bank?.websiteCreatorQuestions?.competitorLinks, []),
      businessWhat: String(bank?.websiteCreatorQuestions?.businessWhat || '').trim(),
      businessStory: String(bank?.websiteCreatorQuestions?.businessStory || '').trim(),
      differentiator: String(bank?.websiteCreatorQuestions?.differentiator || '').trim(),
      reviews: String(bank?.websiteCreatorQuestions?.reviews || '').trim(),
      extraContext: String(bank?.websiteCreatorQuestions?.extraContext || '').trim(),
      wantedPages: String(bank?.websiteCreatorQuestions?.wantedPages || '').trim(),
      customSections: String(bank?.websiteCreatorQuestions?.customSections || '').trim(),
      websiteDomain: String(bank?.websiteCreatorQuestions?.websiteDomain || '').trim(),
      town: String(bank?.websiteCreatorQuestions?.town || '').trim(),
      country: String(bank?.websiteCreatorQuestions?.country || '').trim(),
      relevantLinks: String(bank?.websiteCreatorQuestions?.relevantLinks || '').trim(),
      mainCtaText: String(bank?.websiteCreatorQuestions?.mainCtaText || bank?.websiteCreatorQuestions?.primaryAction || '').trim(),
      mainCtaUrl: String(bank?.websiteCreatorQuestions?.mainCtaUrl || '').trim(),
    },
    makerLink: {
      bundleId: String(bank?.makerLink?.bundleId || '').trim(),
      bundleName: String(bank?.makerLink?.bundleName || '').trim(),
      email: String(bank?.makerLink?.email || '').trim(),
      salesClientId: String(bank?.makerLink?.salesClientId || '').trim(),
      runId: String(bank?.makerLink?.runId || '').trim(),
      publicPreviewUrl: String(bank?.makerLink?.publicPreviewUrl || '').trim(),
      tunnelUrl: String(bank?.makerLink?.tunnelUrl || '').trim(),
      syncedAt: String(bank?.makerLink?.syncedAt || '').trim(),
    },
  };
}

export function emptyCatalogFallback(layout: ProductCatalog['layout'] = 'normal') {
  return buildEmptyCatalog(layout, { withStarterCategory: false }) as ProductCatalog;
}

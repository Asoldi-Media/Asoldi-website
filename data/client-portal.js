import { readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';
import { resolvePortalCatalogs } from '../lib/client-product-catalog.js';
import * as clientBusinesses from './client-businesses.js';

const CLIENT_PROFILES_PATH = getDataFilePath('client-portal-profiles.json');
const CLIENT_STATE_PATH = getDataFilePath('client-portal-state.json');

function ensureDataDir() {
  ensurePersistentDataDir();
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const lowered = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  ensureDataDir();
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDataDir();
  writeDataJson(filePath, payload);
}

function readProfiles() {
  const parsed = readJson(CLIENT_PROFILES_PATH, []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeProfiles(items) {
  writeJson(CLIENT_PROFILES_PATH, items);
}

function readStateMap() {
  const parsed = readJson(CLIENT_STATE_PATH, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeStateMap(map) {
  writeJson(CLIENT_STATE_PATH, map);
}

function defaultCustomPlan() {
  return {
    id: 'custom-nettside-plan',
    name: 'Din nettside plan',
    title: 'Din nettside plan',
    subtitle: 'Skreddersydd forslag',
    monthlyPrice: 999,
    summary: 'Skreddersydd onboarding-plan satt opp av Asoldi-teamet.',
    features: ['Nettsideutvikling', 'Hosting', 'Opprettelse', 'Domene', 'Email'],
    highlighted: true,
  };
}

function defaultLegalAcknowledgement() {
  return {
    termsAccepted: false,
    privacyAccepted: false,
    bindingAccepted: false,
    bindingMonths: 0,
    planId: '',
    planName: '',
    acceptedAt: '',
  };
}

function normalizeLegalAcknowledgement(input = {}, fallback = {}) {
  const base = {
    ...defaultLegalAcknowledgement(),
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
  };
  const src = input && typeof input === 'object' ? input : {};
  const months = Number.parseInt(String(src.bindingMonths ?? base.bindingMonths ?? 0), 10);
  return {
    termsAccepted: toBoolean(src.termsAccepted, base.termsAccepted),
    privacyAccepted: toBoolean(src.privacyAccepted, base.privacyAccepted),
    bindingAccepted: toBoolean(src.bindingAccepted, base.bindingAccepted),
    bindingMonths: Number.isFinite(months) && months > 0 ? months : 0,
    planId: sanitizeText(src.planId || base.planId),
    planName: sanitizeText(src.planName || base.planName),
    acceptedAt: sanitizeText(src.acceptedAt || base.acceptedAt),
  };
}

function defaultAppliedPromotionCode() {
  return {
    code: '',
    promotionCodeId: '',
    couponId: '',
    label: '',
    percentOff: 0,
    amountOff: 0,
    currency: '',
    discountAmount: 0,
    totalAmount: 0,
    planId: '',
    planName: '',
    appliedAt: '',
  };
}

function normalizeAppliedPromotionCode(input = {}, fallback = {}) {
  const base = {
    ...defaultAppliedPromotionCode(),
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
  };
  const src = input && typeof input === 'object' ? input : {};
  const asFiniteNumber = (value, fallbackValue = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallbackValue;
  };
  return {
    code: sanitizeText(src.code || base.code).toUpperCase(),
    promotionCodeId: sanitizeText(src.promotionCodeId || base.promotionCodeId),
    couponId: sanitizeText(src.couponId || base.couponId),
    label: sanitizeText(src.label || base.label),
    percentOff: asFiniteNumber(src.percentOff, asFiniteNumber(base.percentOff, 0)),
    amountOff: asFiniteNumber(src.amountOff, asFiniteNumber(base.amountOff, 0)),
    currency: sanitizeText(src.currency || base.currency),
    discountAmount: asFiniteNumber(src.discountAmount, asFiniteNumber(base.discountAmount, 0)),
    totalAmount: asFiniteNumber(src.totalAmount, asFiniteNumber(base.totalAmount, 0)),
    planId: sanitizeText(src.planId || base.planId),
    planName: sanitizeText(src.planName || base.planName),
    appliedAt: sanitizeText(src.appliedAt || base.appliedAt),
  };
}

function defaultWebsiteBuilder() {
  return {
    existingWebsiteCode: '',
    selectedPlanId: 'tier-1-standard',
    selectedPlanName: 'Tier 1: Standard',
    selectedPlanPrice: '999,-/mnd',
    selectedPlanType: 'standard',
    lastCheckoutStartedAt: '',
    legalAcknowledgement: defaultLegalAcknowledgement(),
    appliedPromotionCode: defaultAppliedPromotionCode(),
  };
}

function defaultPayment() {
  return {
    // none | processing | active | past_due | canceled | invoice_requested
    status: 'none',
    method: '', // card | faktura
    planId: '',
    planName: '',
    amount: 0, // numeric monthly amount captured at purchase (0 = unknown)
    currency: 'nok',
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    stripeSessionId: '',
    paidAt: '',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '',
    cancelAt: '',
    canceledAt: '',
    updatedAt: '',
    invoiceRequest: null, // faktura: { orgNumber, businessName, invoiceEmail, requestedAt }
  };
}

function normalizePayment(input = {}) {
  const base = defaultPayment();
  const src = input && typeof input === 'object' ? input : {};
  const amountNum = typeof src.amount === 'number'
    ? src.amount
    : Number.parseInt(String(src.amount ?? '').replace(/[^\d]/g, ''), 10);
  const ir = src.invoiceRequest && typeof src.invoiceRequest === 'object'
    ? {
        orgNumber: sanitizeText(src.invoiceRequest.orgNumber),
        businessName: sanitizeText(src.invoiceRequest.businessName),
        invoiceEmail: sanitizeText(src.invoiceRequest.invoiceEmail).toLowerCase(),
        requestedAt: sanitizeText(src.invoiceRequest.requestedAt),
      }
    : null;
  return {
    ...base,
    status: sanitizeText(src.status) || base.status,
    method: sanitizeText(src.method),
    planId: sanitizeText(src.planId),
    planName: sanitizeText(src.planName),
    amount: Number.isFinite(amountNum) ? amountNum : 0,
    currency: sanitizeText(src.currency) || base.currency,
    stripeCustomerId: sanitizeText(src.stripeCustomerId),
    stripeSubscriptionId: sanitizeText(src.stripeSubscriptionId),
    stripeSessionId: sanitizeText(src.stripeSessionId),
    paidAt: sanitizeText(src.paidAt),
    cancelAtPeriodEnd: toBoolean(src.cancelAtPeriodEnd, base.cancelAtPeriodEnd),
    currentPeriodEnd: sanitizeText(src.currentPeriodEnd),
    cancelAt: sanitizeText(src.cancelAt),
    canceledAt: sanitizeText(src.canceledAt),
    updatedAt: sanitizeText(src.updatedAt),
    invoiceRequest: ir,
  };
}

const DEFAULT_OPENING_DAYS = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

function normalizeHexColor(value = '', fallback = '') {
  const candidate = sanitizeText(value).toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(candidate)) return candidate;
  const fallbackCandidate = sanitizeText(fallback).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(fallbackCandidate) ? fallbackCandidate : '';
}

function normalizeTextList(input, fallback = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
  return source.map((entry) => sanitizeText(entry)).filter(Boolean);
}

function normalizeNameUrlLinks(input, fallback = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
  const normalized = source
    .map((entry) => ({
      name: sanitizeText(entry?.name),
      url: sanitizeText(entry?.url),
    }))
    .filter((entry) => entry.name || entry.url);
  return normalized.length ? normalized : [{ name: '', url: '' }];
}

function normalizeMediaList(input, fallback = []) {
  return normalizeTextList(input, fallback);
}

function normalizeOpeningHoursDays(input, fallback = DEFAULT_OPENING_DAYS) {
  const source = Array.isArray(input) ? input : [];
  const fallbackDays = Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_OPENING_DAYS;
  return fallbackDays.map((fallbackDay, idx) => {
    const sourceByIndex = source[idx];
    const sourceByName = source.find((entry) => (
      sanitizeText(entry?.day || entry?.name).toLowerCase()
      === sanitizeText(fallbackDay.day || fallbackDay.name).toLowerCase()
    ));
    const row = (sourceByIndex && typeof sourceByIndex === 'object')
      ? sourceByIndex
      : (sourceByName && typeof sourceByName === 'object' ? sourceByName : {});
    return {
      day: sanitizeText(row.day || row.name || fallbackDay.day || fallbackDay.name),
      opensAt: sanitizeText(row.opensAt || row.open || fallbackDay.opensAt || fallbackDay.open),
      closesAt: sanitizeText(row.closesAt || row.close || fallbackDay.closesAt || fallbackDay.close),
      closed: toBoolean(row.closed, Boolean(fallbackDay.closed)),
    };
  });
}

function normalizeAffiliations(input, fallback = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
  return source.map((category, categoryIndex) => {
    const itemsSource = Array.isArray(category?.items) ? category.items : [];
    const items = itemsSource.map((item, itemIndex) => ({
      id: sanitizeText(item?.id) || `aff-item-${categoryIndex + 1}-${itemIndex + 1}`,
      title: sanitizeText(item?.title),
      description: sanitizeText(item?.description || item?.desc),
      imageUrl: sanitizeText(item?.imageUrl || item?.image),
    })).filter((item) => item.title || item.description || item.imageUrl);
    return {
      id: sanitizeText(category?.id) || `aff-cat-${categoryIndex + 1}`,
      categoryName: sanitizeText(category?.categoryName || category?.name),
      items,
    };
  }).filter((category) => category.categoryName || category.items.length);
}

function normalizeProducts(input, fallback = []) {
  const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
  return source.map((category, categoryIndex) => {
    const itemsSource = Array.isArray(category?.items)
      ? category.items
      : (Array.isArray(category?.products) ? category.products : []);
    const items = itemsSource.map((item, itemIndex) => ({
      id: sanitizeText(item?.id) || `prod-item-${categoryIndex + 1}-${itemIndex + 1}`,
      title: sanitizeText(item?.title),
      description: sanitizeText(item?.description || item?.desc),
      price: sanitizeText(item?.price),
      contactInsteadOfPrice: toBoolean(item?.contactInsteadOfPrice, false),
      imageUrl: sanitizeText(item?.imageUrl || item?.image),
      included: toBoolean(item?.included ?? item?.isSelected, true),
    })).filter((item) => item.title || item.description || item.price || item.imageUrl);
    return {
      id: sanitizeText(category?.id) || `prod-cat-${categoryIndex + 1}`,
      categoryName: sanitizeText(category?.categoryName || category?.name),
      items,
    };
  }).filter((category) => category.categoryName || category.items.length);
}

function defaultClientDataBank(seed = {}) {
  const businessName = sanitizeText(seed.businessName || seed.companyName);
  const businessOrgNumber = sanitizeText(seed.businessOrgNumber || seed.organizationNumber);
  const email = sanitizeText(seed.email).toLowerCase();
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
      companyEmail: email,
      socialMediaLinks: [],
      extraLinks: [{ name: '', url: '' }],
    },
    brandIdentity: {
      orgNumber: businessOrgNumber,
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
      days: DEFAULT_OPENING_DAYS.map((row) => ({ ...row })),
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
    },
    makerLink: {
      bundleId: '',
      bundleName: '',
      email: '',
      salesClientId: '',
      runId: '',
      publicPreviewUrl: '',
      tunnelUrl: '',
      businessId: '',
      syncedAt: '',
    },
  };
}

function normalizeClientDataBank(input = {}, fallback = {}) {
  const base = {
    ...defaultClientDataBank(),
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
  };
  const src = input && typeof input === 'object' ? input : {};

  const businessCard = {
    companyName: sanitizeText(src.businessCard?.companyName || base.businessCard.companyName),
    industry: sanitizeText(src.businessCard?.industry || base.businessCard.industry),
    websiteGoal: sanitizeText(src.businessCard?.websiteGoal || src.businessCard?.goal || base.businessCard.websiteGoal),
  };

  const generalInfo = {
    companyName: sanitizeText(src.generalInfo?.companyName || businessCard.companyName || base.generalInfo.companyName),
    companyAddress: sanitizeText(src.generalInfo?.companyAddress || src.generalInfo?.address || base.generalInfo.companyAddress),
    websiteLanguage: sanitizeText(src.generalInfo?.websiteLanguage || src.generalInfo?.language || base.generalInfo.websiteLanguage) || 'Norsk (Norge)',
    companyPhone: sanitizeText(src.generalInfo?.companyPhone || src.generalInfo?.phone || base.generalInfo.companyPhone),
    companyEmail: sanitizeText(src.generalInfo?.companyEmail || src.generalInfo?.email || base.generalInfo.companyEmail).toLowerCase(),
    socialMediaLinks: normalizeTextList(src.generalInfo?.socialMediaLinks || src.generalInfo?.socialLinks, base.generalInfo.socialMediaLinks),
    extraLinks: normalizeNameUrlLinks(src.generalInfo?.extraLinks, base.generalInfo.extraLinks),
  };

  const brandIdentity = {
    orgNumber: sanitizeText(src.brandIdentity?.orgNumber || src.brandIdentity?.organizationNumber || base.brandIdentity.orgNumber),
    colors: {
      primary: normalizeHexColor(src.brandIdentity?.colors?.primary, base.brandIdentity.colors.primary),
      secondary: normalizeHexColor(src.brandIdentity?.colors?.secondary, base.brandIdentity.colors.secondary),
      accent: normalizeHexColor(src.brandIdentity?.colors?.accent, base.brandIdentity.colors.accent),
    },
    logos: {
      normal: sanitizeText(src.brandIdentity?.logos?.normal || base.brandIdentity.logos.normal),
      favicon: sanitizeText(src.brandIdentity?.logos?.favicon || base.brandIdentity.logos.favicon),
    },
  };

  const openingHours = {
    googleBusinessSyncUrl: sanitizeText(
      src.openingHours?.googleBusinessSyncUrl
      || src.openingHours?.syncLink
      || base.openingHours.googleBusinessSyncUrl
    ),
    days: normalizeOpeningHoursDays(src.openingHours?.days, base.openingHours.days),
  };

  const media = {
    mainHeroImages: normalizeMediaList(src.media?.mainHeroImages || src.media?.heroImages, base.media.mainHeroImages),
    galleryImages: normalizeMediaList(src.media?.galleryImages, base.media.galleryImages),
    logos: normalizeMediaList(src.media?.logos, base.media.logos),
    icons: normalizeMediaList(src.media?.icons, base.media.icons),
    uncategorized: normalizeMediaList(src.media?.uncategorized, base.media.uncategorized),
    teamImages: normalizeMediaList(src.media?.teamImages || src.media?.employeeImages, base.media.teamImages || []),
    aboutImages: normalizeMediaList(src.media?.aboutImages, base.media.aboutImages || []),
    locationImages: normalizeMediaList(src.media?.locationImages, base.media.locationImages || []),
    illustrationImages: normalizeMediaList(src.media?.illustrationImages, base.media.illustrationImages || []),
    offeringImages: normalizeMediaList(src.media?.offeringImages || src.media?.menuImages, base.media.offeringImages || []),
    briefs: Array.isArray(src.media?.briefs) ? src.media.briefs.filter((row) => row && typeof row === "object") : (base.media.briefs || []),
  };

  const websiteCreatorQuestions = {
    targetAudience: sanitizeText(src.websiteCreatorQuestions?.targetAudience || base.websiteCreatorQuestions.targetAudience),
    keyMessage: sanitizeText(src.websiteCreatorQuestions?.keyMessage || base.websiteCreatorQuestions.keyMessage),
    toneOfVoice: sanitizeText(src.websiteCreatorQuestions?.toneOfVoice || base.websiteCreatorQuestions.toneOfVoice),
    primaryAction: sanitizeText(src.websiteCreatorQuestions?.primaryAction || base.websiteCreatorQuestions.primaryAction),
    importantKeywords: normalizeTextList(src.websiteCreatorQuestions?.importantKeywords, base.websiteCreatorQuestions.importantKeywords),
    competitorLinks: normalizeTextList(src.websiteCreatorQuestions?.competitorLinks, base.websiteCreatorQuestions.competitorLinks),
    businessWhat: sanitizeText(src.websiteCreatorQuestions?.businessWhat || base.websiteCreatorQuestions.businessWhat),
    businessStory: sanitizeText(src.websiteCreatorQuestions?.businessStory || base.websiteCreatorQuestions.businessStory),
    differentiator: sanitizeText(src.websiteCreatorQuestions?.differentiator || base.websiteCreatorQuestions.differentiator),
    reviews: sanitizeText(src.websiteCreatorQuestions?.reviews || base.websiteCreatorQuestions.reviews),
    extraContext: sanitizeText(src.websiteCreatorQuestions?.extraContext || base.websiteCreatorQuestions.extraContext),
    wantedPages: sanitizeText(src.websiteCreatorQuestions?.wantedPages || base.websiteCreatorQuestions.wantedPages),
    customSections: sanitizeText(src.websiteCreatorQuestions?.customSections || base.websiteCreatorQuestions.customSections),
    websiteDomain: sanitizeText(src.websiteCreatorQuestions?.websiteDomain || base.websiteCreatorQuestions.websiteDomain),
    town: sanitizeText(src.websiteCreatorQuestions?.town || base.websiteCreatorQuestions.town),
    country: sanitizeText(src.websiteCreatorQuestions?.country || base.websiteCreatorQuestions.country),
    relevantLinks: sanitizeText(src.websiteCreatorQuestions?.relevantLinks || base.websiteCreatorQuestions.relevantLinks),
  };

  const makerLink = {
    bundleId: sanitizeText(src.makerLink?.bundleId || base.makerLink?.bundleId),
    bundleName: sanitizeText(src.makerLink?.bundleName || base.makerLink?.bundleName),
    email: sanitizeText(src.makerLink?.email || base.makerLink?.email).toLowerCase(),
    salesClientId: sanitizeText(src.makerLink?.salesClientId || base.makerLink?.salesClientId),
    runId: sanitizeText(src.makerLink?.runId || base.makerLink?.runId),
    publicPreviewUrl: sanitizeText(src.makerLink?.publicPreviewUrl || base.makerLink?.publicPreviewUrl),
    tunnelUrl: sanitizeText(src.makerLink?.tunnelUrl || base.makerLink?.tunnelUrl),
    businessId: sanitizeText(src.makerLink?.businessId || base.makerLink?.businessId),
    syncedAt: sanitizeText(src.makerLink?.syncedAt || base.makerLink?.syncedAt),
  };

  const resolvedCatalogs = resolvePortalCatalogs({
    productCatalogs: src.productCatalogs || base.productCatalogs,
    products: src.products || base.products,
    extraHay: businessCard.industry,
    keepEmptyProducts: true,
  });

  return {
    businessCard,
    generalInfo,
    brandIdentity,
    openingHours,
    affiliations: normalizeAffiliations(src.affiliations, base.affiliations),
    productCatalogs: resolvedCatalogs.productCatalogs,
    products: resolvedCatalogs.products.length
      ? resolvedCatalogs.products
      : normalizeProducts(src.products, base.products),
    media,
    websiteCreatorQuestions,
    makerLink,
  };
}

function normalizeCustomPlan(input = {}) {
  const base = defaultCustomPlan();
  const monthlyPriceRaw = input.monthlyPrice ?? base.monthlyPrice;
  const monthlyPrice = typeof monthlyPriceRaw === 'number'
    ? monthlyPriceRaw
    : Number.parseInt(String(monthlyPriceRaw).replace(/[^\d]/g, ''), 10) || base.monthlyPrice;
  const name = sanitizeText(input.name || input.title || base.name);
  return {
    ...base,
    ...input,
    id: sanitizeText(input.id || base.id),
    name,
    title: sanitizeText(input.title || name || base.title),
    subtitle: sanitizeText(input.subtitle || base.subtitle),
    monthlyPrice,
    summary: sanitizeText(input.summary || base.summary),
    features: Array.isArray(input.features) && input.features.length ? input.features.map((item) => sanitizeText(item)).filter(Boolean) : base.features,
    highlighted: toBoolean(input.highlighted, true),
  };
}

function normalizeWebsiteBuilder(input = {}) {
  const base = defaultWebsiteBuilder();
  const fallbackLegal = normalizeLegalAcknowledgement(base.legalAcknowledgement || {});
  const legalAcknowledgement = normalizeLegalAcknowledgement(input.legalAcknowledgement, fallbackLegal);
  const fallbackPromotionCode = normalizeAppliedPromotionCode(base.appliedPromotionCode || {});
  const appliedPromotionCode = normalizeAppliedPromotionCode(input.appliedPromotionCode, fallbackPromotionCode);
  return {
    ...base,
    ...input,
    existingWebsiteCode: sanitizeText(input.existingWebsiteCode || base.existingWebsiteCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
    selectedPlanId: sanitizeText(input.selectedPlanId || base.selectedPlanId),
    selectedPlanName: sanitizeText(input.selectedPlanName || base.selectedPlanName),
    selectedPlanPrice: sanitizeText(input.selectedPlanPrice || base.selectedPlanPrice),
    selectedPlanType: sanitizeText(input.selectedPlanType || base.selectedPlanType),
    lastCheckoutStartedAt: sanitizeText(input.lastCheckoutStartedAt || base.lastCheckoutStartedAt),
    legalAcknowledgement,
    appliedPromotionCode,
  };
}

function normalizeProfile(input = {}) {
  const createdAt = sanitizeText(input.createdAt) || nowIso();
  const name = sanitizeText(input.name || input.fullName);
  const source = sanitizeText(input.discoveryChannel || input.source);
  const onboarding = toBoolean(input.onboardingCompleted ?? input.onboardingComplete, false);
  const fallbackClientDataBank = defaultClientDataBank({
    businessName: input.businessName,
    businessOrgNumber: input.businessOrgNumber || input.organizationNumber,
    email: input.email,
  });
  const clientDataBank = normalizeClientDataBank(input.clientDataBank, fallbackClientDataBank);
  const normalizedBusinessName = sanitizeText(
    input.businessName
    || clientDataBank.generalInfo.companyName
    || clientDataBank.businessCard.companyName
  );
  const normalizedBusinessOrgNumber = sanitizeText(
    input.businessOrgNumber
    || input.organizationNumber
    || clientDataBank.brandIdentity.orgNumber
  );
  return {
    businessId: sanitizeText(input.businessId || input.userId),
    ownerUserId: sanitizeText(input.ownerUserId || input.userId),
    userId: sanitizeText(input.ownerUserId || input.userId),
    email: sanitizeText(input.email).toLowerCase(),
    name,
    fullName: name,
    businessName: normalizedBusinessName,
    businessOrgNumber: normalizedBusinessOrgNumber,
    position: sanitizeText(input.position),
    discoveryChannel: source,
    source,
    onboardingCompleted: onboarding,
    onboardingComplete: onboarding,
    customWebsitePlan: normalizeCustomPlan(input.customWebsitePlan),
    websiteBuilder: normalizeWebsiteBuilder(input.websiteBuilder),
    payment: normalizePayment(input.payment),
    clientDataBank,
    createdAt,
    updatedAt: sanitizeText(input.updatedAt) || createdAt,
  };
}

function profileToPortalState(profile = {}) {
  const custom = normalizeCustomPlan(profile.customWebsitePlan || {});
  const builder = normalizeWebsiteBuilder(profile.websiteBuilder || {});
  return {
    selectedMarketingElement: 'website',
    selectedWebsitePlanId: builder.selectedPlanId || 'tier-1-standard',
    selectedWebsitePlanName: builder.selectedPlanName || 'Tier 1: Standard',
    customWebsitePlan: {
      id: custom.id,
      name: custom.name,
      monthlyPrice: custom.monthlyPrice,
      summary: custom.summary,
      features: custom.features,
    },
    todos: defaultTodoList(builder.selectedPlanName, builder.existingWebsiteCode),
    websiteCode: builder.existingWebsiteCode || '',
    updatedAt: nowIso(),
  };
}

function defaultTodoList(selectedPlanName = '', existingCode = '') {
  return [
    {
      id: 'setup-website',
      title: 'Steg 1: Sett opp nettsiden din',
      description: 'Inkluderer SEO-optimalisering, kontaktskjema, hosting og vedlikehold.',
      actionLabel: 'Start',
      actionPath: '/kunde/ai-assistant',
      completed: false,
    },
    {
      id: 'website-plan',
      title: selectedPlanName ? `Valgt plan: ${selectedPlanName}` : 'Velg nettsideplan',
      description: selectedPlanName
        ? 'Du kan oppdatere eller bytte plan i checkout.'
        : 'Velg riktig plan for å fortsette.',
      actionLabel: selectedPlanName ? 'Se plan' : 'Velg plan',
      actionPath: '/kunde/tjenester/nettside/planer',
      completed: false,
    },
    {
      id: 'website-code',
      title: existingCode ? `Eksisterende nettsidekode: ${existingCode}` : 'Har du allerede en nettside? Legg inn kode',
      description: existingCode
        ? 'Koden er lagret og brukes ved kobling av eksisterende nettsted.'
        : 'Bruk 4-sifret kode for å koble eksisterende nettsted.',
      actionLabel: existingCode ? 'Oppdater' : 'Legg inn',
      actionPath: '/kunde/tjenester/nettside/start',
      completed: false,
    },
  ];
}

function syncPortalStateFromProfile(userId, profile, patch = {}) {
  const target = sanitizeText(userId);
  if (!target) return;
  const map = readStateMap();
  const base = profileToPortalState(profile);
  const current = map[target] && typeof map[target] === 'object' ? map[target] : base;
  map[target] = {
    ...base,
    ...current,
    ...patch,
    customWebsitePlan: {
      ...base.customWebsitePlan,
      ...(current.customWebsitePlan || {}),
      ...((patch.customWebsitePlan && typeof patch.customWebsitePlan === 'object') ? patch.customWebsitePlan : {}),
    },
    todos: Array.isArray(patch.todos)
      ? patch.todos
      : Array.isArray(current.todos) && current.todos.length
      ? current.todos
      : base.todos,
    updatedAt: nowIso(),
  };
  writeStateMap(map);
}

function mergeProfilePatch(current, patch = {}) {
  const nextName = sanitizeText(patch.name || patch.fullName || current.name);
  const nextSource = sanitizeText(patch.discoveryChannel || patch.source || current.discoveryChannel);
  const onboarding = toBoolean(
    patch.onboardingCompleted ?? patch.onboardingComplete,
    current.onboardingCompleted,
  );
  return normalizeProfile({
    ...current,
    ...patch,
    name: nextName,
    fullName: nextName,
    discoveryChannel: nextSource,
    source: nextSource,
    onboardingCompleted: onboarding,
    onboardingComplete: onboarding,
    customWebsitePlan: {
      ...(current.customWebsitePlan || {}),
      ...((patch.customWebsitePlan && typeof patch.customWebsitePlan === 'object') ? patch.customWebsitePlan : {}),
    },
    websiteBuilder: {
      ...(current.websiteBuilder || {}),
      ...((patch.websiteBuilder && typeof patch.websiteBuilder === 'object') ? patch.websiteBuilder : {}),
    },
    payment: {
      ...(current.payment || {}),
      ...((patch.payment && typeof patch.payment === 'object') ? patch.payment : {}),
    },
    clientDataBank: normalizeClientDataBank(
      (patch.clientDataBank && typeof patch.clientDataBank === 'object')
        ? patch.clientDataBank
        : (current.clientDataBank || {}),
      current.clientDataBank || defaultClientDataBank(current),
    ),
    updatedAt: nowIso(),
  });
}

export function listClientProfiles() {
  return readProfiles().map(normalizeProfile).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getClientProfileByBusinessId(businessId) {
  const target = sanitizeText(businessId);
  if (!target) return null;
  return listClientProfiles().find((entry) => sanitizeText(entry.businessId || entry.userId) === target) || null;
}

export function getClientProfileByUserId(userId) {
  const target = sanitizeText(userId);
  if (!target) return null;
  const activeId = clientBusinesses.getActiveBusinessId(target);
  if (activeId) {
    const active = getClientProfileByBusinessId(activeId);
    if (active) return active;
  }
  const owned = listClientProfiles().filter((entry) => sanitizeText(entry.ownerUserId || entry.userId) === target);
  if (owned.length === 1) return owned[0];
  return owned.find((entry) => sanitizeText(entry.businessId || entry.userId) === target) || owned[0] || null;
}

export function getClientProfile(userId) {
  return getClientProfileByUserId(userId);
}

export function upsertClientProfile(userId, patch = {}, options = {}) {
  const ownerId = sanitizeText(options.ownerUserId || patch.ownerUserId || userId);
  const businessId = sanitizeText(options.businessId || patch.businessId || clientBusinesses.getActiveBusinessId(ownerId) || userId);
  if (!businessId) return null;
  const syncPortalState = options.syncPortalState !== false;
  const state = readProfiles().map(normalizeProfile);
  const index = state.findIndex((entry) => sanitizeText(entry.businessId || entry.userId) === businessId);
  const now = nowIso();

  if (index === -1) {
    const created = normalizeProfile({
      userId: ownerId,
      ownerUserId: ownerId,
      businessId,
      ...patch,
      createdAt: now,
      updatedAt: now,
    });
    state.push(created);
    writeProfiles(state);
    if (syncPortalState) syncPortalStateFromProfile(businessId, created);
    return created;
  }

  const merged = mergeProfilePatch(state[index], { ...patch, businessId, ownerUserId: ownerId || state[index].ownerUserId });
  state[index] = merged;
  writeProfiles(state);
  if (syncPortalState) {
    syncPortalStateFromProfile(businessId, merged, {
      selectedWebsitePlanId: merged.websiteBuilder.selectedPlanId,
      selectedWebsitePlanName: merged.websiteBuilder.selectedPlanName,
      websiteCode: merged.websiteBuilder.existingWebsiteCode,
      customWebsitePlan: {
        id: merged.customWebsitePlan.id,
        name: merged.customWebsitePlan.name,
        monthlyPrice: merged.customWebsitePlan.monthlyPrice,
        summary: merged.customWebsitePlan.summary,
        features: merged.customWebsitePlan.features,
      },
      todos: defaultTodoList(merged.websiteBuilder.selectedPlanName, merged.websiteBuilder.existingWebsiteCode),
    });
  }
  return merged;
}

export function ensureClientProfileForUser(user) {
  if (!user?.id) return null;
  clientBusinesses.acceptPendingInvitesForUser({
    userId: user.id,
    email: sanitizeText(user.username).toLowerCase(),
  });
  const existing = getClientProfileByUserId(user.id);
  if (existing) {
    if (sanitizeText(existing.ownerUserId || existing.userId) === sanitizeText(user.id)) {
      clientBusinesses.ensureOwnerMembership({
        userId: user.id,
        email: existing.email || user.username,
        businessId: existing.businessId || existing.userId,
      });
    }
    return existing;
  }
  const created = upsertClientProfile(user.id, {
    email: sanitizeText(user.username).toLowerCase(),
    onboardingCompleted: false,
    businessId: user.id,
    ownerUserId: user.id,
  }, { businessId: user.id, ownerUserId: user.id });
  clientBusinesses.ensureOwnerMembership({
    userId: user.id,
    email: user.username,
    businessId: user.id,
  });
  return created;
}

export function createBusinessForUser(user, { name = '' } = {}) {
  if (!user?.id) return null;
  const businessId = `biz_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const profile = upsertClientProfile(user.id, {
    email: sanitizeText(user.username).toLowerCase(),
    name: sanitizeText(user.name),
    businessName: sanitizeText(name) || 'Ny bedrift',
    onboardingCompleted: false,
    businessId,
    ownerUserId: user.id,
  }, { businessId, ownerUserId: user.id });
  clientBusinesses.ensureOwnerMembership({
    userId: user.id,
    email: user.username,
    businessId,
  });
  clientBusinesses.setActiveBusinessId(user.id, businessId);
  return profile;
}

function businessRow(profile, membership) {
  return {
    id: membership?.businessId || profile?.businessId || profile?.userId || '',
    name: profile?.businessName || profile?.clientDataBank?.businessCard?.companyName || profile?.email || 'Bedrift',
    role: membership?.role || 'owner',
    status: membership?.status || 'active',
    email: profile?.email || membership?.email || '',
  };
}

export function listBusinessesForUser(userId) {
  const target = sanitizeText(userId);
  const memberships = clientBusinesses.getActiveMembershipsForUser(target);
  const seen = new Set();
  const rows = [];
  for (const membership of memberships) {
    if (seen.has(membership.businessId)) continue;
    seen.add(membership.businessId);
    rows.push(businessRow(getClientProfileByBusinessId(membership.businessId), membership));
  }
  if (rows.length) return rows.filter((row) => row.id);
  return listClientProfiles()
    .filter((entry) => sanitizeText(entry.ownerUserId || entry.userId) === target)
    .map((profile) => businessRow(profile, clientBusinesses.getMembership(target, profile.businessId)))
    .filter((row) => row.id);
}

export function presentClientSession(user) {
  if (!user?.id) return null;
  const profile = ensureClientProfileForUser(user);
  const businesses = listBusinessesForUser(user.id);
  const activeBusinessId = sanitizeText(
    clientBusinesses.getActiveBusinessId(user.id) || profile?.businessId || businesses[0]?.id
  );
  const membership = clientBusinesses.getMembership(user.id, activeBusinessId);
  return {
    user: {
      id: user.id,
      email: sanitizeText(user.username).toLowerCase(),
      role: 'client',
    },
    profile,
    businesses,
    activeBusinessId,
    membership: membership ? clientBusinesses.publicMembership(membership) : null,
  };
}

export function requireBusinessAccess(userId, businessId, { manage = false, transfer = false } = {}) {
  const membership = clientBusinesses.getMembership(userId, businessId);
  if (!membership || membership.status !== 'active') {
    return { ok: false, status: 403, message: 'Du har ikke tilgang til denne bedriften.' };
  }
  if (transfer && !clientBusinesses.canTransferOwnership(membership.role)) {
    return { ok: false, status: 403, message: 'Bare eier kan overføre bedriften.' };
  }
  if (manage && !clientBusinesses.canManageMembers(membership.role)) {
    return { ok: false, status: 403, message: 'Bare eier eller admin kan administrere medlemmer.' };
  }
  return { ok: true, membership };
}

export function updateOwnedLoginEmails(userId, email) {
  const ownerId = sanitizeText(userId);
  const next = sanitizeText(email).toLowerCase();
  if (!ownerId || !next) return [];
  clientBusinesses.updateMembershipEmailsForUser(ownerId, next);
  return listClientProfiles()
    .filter((entry) => sanitizeText(entry.ownerUserId || entry.userId) === ownerId)
    .map((entry) => upsertClientProfile(ownerId, { email: next }, {
      businessId: entry.businessId,
      ownerUserId: ownerId,
      syncPortalState: false,
    }));
}

export function setBusinessOwner(businessId, ownerUserId, email = '') {
  const profile = getClientProfileByBusinessId(businessId);
  if (!profile) return null;
  return upsertClientProfile(ownerUserId, {
    ownerUserId,
    email: sanitizeText(email).toLowerCase() || profile.email,
  }, { businessId, ownerUserId, syncPortalState: false });
}

export function switchBusinessForUser(userId, businessId) {
  const next = clientBusinesses.setActiveBusinessId(userId, businessId);
  if (!next) return null;
  return getClientProfileByBusinessId(next);
}

export function setClientOnboarding(userId, data = {}) {
  return upsertClientProfile(userId, {
    name: sanitizeText(data.name || data.fullName),
    businessName: sanitizeText(data.businessName),
    businessOrgNumber: sanitizeText(data.businessOrgNumber || data.organizationNumber),
    position: sanitizeText(data.position),
    discoveryChannel: sanitizeText(data.discoveryChannel || data.source),
    onboardingCompleted: true,
  });
}

export function setClientExistingWebsiteCode(userId, code) {
  const nextCode = sanitizeText(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return upsertClientProfile(userId, {
    websiteBuilder: {
      existingWebsiteCode: nextCode,
    },
  });
}

export function setClientSelectedWebsitePlan(userId, plan = {}) {
  const websiteBuilderPatch = {
    selectedPlanId: sanitizeText(plan.id),
    selectedPlanName: sanitizeText(plan.name),
    selectedPlanPrice: sanitizeText(plan.price),
    selectedPlanType: sanitizeText(plan.type || 'standard'),
    lastCheckoutStartedAt: nowIso(),
  };
  if (plan.legalAcknowledgement && typeof plan.legalAcknowledgement === 'object') {
    websiteBuilderPatch.legalAcknowledgement = plan.legalAcknowledgement;
  }
  return upsertClientProfile(userId, {
    websiteBuilder: websiteBuilderPatch,
  });
}

export function setClientPayment(userId, patch = {}) {
  const next = { ...patch, updatedAt: nowIso() };
  return upsertClientProfile(userId, { payment: next }, { syncPortalState: false });
}

export function setClientDataBank(userId, patch = {}, options = {}) {
  const businessId = sanitizeText(options.businessId || clientBusinesses.getActiveBusinessId(userId) || userId);
  return upsertClientProfile(userId, { clientDataBank: patch, businessId }, { syncPortalState: false, businessId });
}

export function setClientAppliedPromotionCode(userId, promotionCode = null) {
  const nextPromotion = promotionCode && typeof promotionCode === 'object'
    ? promotionCode
    : defaultAppliedPromotionCode();
  return upsertClientProfile(userId, {
    websiteBuilder: {
      appliedPromotionCode: nextPromotion,
    },
  });
}

export function getClientProfileByStripeCustomerId(customerId) {
  const target = sanitizeText(customerId);
  if (!target) return null;
  return listClientProfiles().find((entry) => entry.payment && entry.payment.stripeCustomerId === target) || null;
}

export function getClientDashboardData(profile) {
  const normalized = normalizeProfile(profile || {});
  const businessName = sanitizeText(normalized.businessName) || 'bedriften din';
  return {
    todoList: [
      {
        id: 'setup-website',
        title: 'Sett opp din nettside',
        description: 'Kom i gang med nettsiden din – velg plan, design og innhold.',
        actionLabel: 'Start her',
        route: '/kunde/ai-assistant',
      },
    ],
    marketingElements: [
      {
        key: 'website',
        label: 'Nettside',
        status: 'Running',
        health: ['Domene koblet', 'E-post koblet', 'Malware Protected', 'SSL', 'CDN'],
        createdAt: normalized.createdAt || nowIso(),
      },
    ],
    performance: {
      uniqueViews: 10000,
      bounceRate: 9.76,
      bounceDeltaPct: 10,
      purchases: 900,
      clicks: 7000,
      monthLabel: '1 mnd',
    },
    greetingName: sanitizeText(normalized.name) || businessName,
  };
}

export function getClientPortalState(userId) {
  const target = sanitizeText(userId);
  if (!target) return profileToPortalState({});
  const profile = getClientProfileByUserId(target) || normalizeProfile({ userId: target });
  const map = readStateMap();
  const saved = map[target];
  const base = profileToPortalState(profile);
  if (!saved || typeof saved !== 'object') {
    map[target] = base;
    writeStateMap(map);
    return base;
  }
  return {
    ...base,
    ...saved,
    customWebsitePlan: {
      ...base.customWebsitePlan,
      ...(saved.customWebsitePlan || {}),
    },
    todos: Array.isArray(saved.todos) && saved.todos.length
      ? saved.todos
      : base.todos,
  };
}

export function updateClientPortalState(userId, patch = {}) {
  const target = sanitizeText(userId);
  if (!target) return null;
  const map = readStateMap();
  const current = getClientPortalState(target);
  const next = {
    ...current,
    ...patch,
    customWebsitePlan: {
      ...current.customWebsitePlan,
      ...(patch.customWebsitePlan || {}),
    },
    updatedAt: nowIso(),
  };
  if (!Array.isArray(next.todos) || !next.todos.length) {
    next.todos = defaultTodoList(next.selectedWebsitePlanName, next.websiteCode);
  }
  map[target] = next;
  writeStateMap(map);

  // Keep core profile fields in sync so legacy routes still behave.
  const existingProfile = getClientProfileByUserId(target) || normalizeProfile({ userId: target });
  upsertClientProfile(target, {
    websiteBuilder: {
      ...existingProfile.websiteBuilder,
      selectedPlanId: sanitizeText(next.selectedWebsitePlanId || existingProfile.websiteBuilder.selectedPlanId),
      selectedPlanName: sanitizeText(next.selectedWebsitePlanName || existingProfile.websiteBuilder.selectedPlanName),
      existingWebsiteCode: sanitizeText(next.websiteCode || existingProfile.websiteBuilder.existingWebsiteCode),
    },
    customWebsitePlan: {
      ...existingProfile.customWebsitePlan,
      ...next.customWebsitePlan,
    },
  }, { syncPortalState: false });
  return next;
}

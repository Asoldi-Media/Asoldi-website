import { analyticsLevelFromFlags, ANALYTICS_LEVEL_NONE } from './website-tiers.js';
import { rangeFromPreset, summarizeTrafficEvents } from './analytics-traffic.js';
import {
  analyticsGoalsFromBank,
  summarizeCta,
  summarizeEcommerceFunnel,
} from './analytics-insights.js';
import {
  getMapsRankingRecord,
  saveMapsRankingSnapshot,
  markMapsRankingError,
  getGoogleBusinessConnection,
  publicGbpStatus,
  readTrafficEvents,
  appendTrafficEvents,
  getCommerceSnapshot,
  saveCommerceSnapshot,
} from '../data/client-analytics.js';
import { getAllSites, getSiteByKey, getSiteByDomain } from '../data/hub.js';
import * as clientPortal from '../data/client-portal.js';
import {
  buildMapsSubject,
  mapsRankingIntervalMs,
  runMapsRankingForSubject,
  buildMapsKeywords,
} from './maps-ranking.js';
import { fetchGoogleBusinessInsights, isGoogleBusinessConfigured } from './google-business.js';
import { isDataForSeoMapsConfigured, mapsSpendSummary } from './dataforseo-maps.js';

function compact(value = '') {
  return String(value ?? '').trim();
}

function hostOf(value = '') {
  return compact(value).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
}

export function planIdForProfile(profile = {}, hubSite = null) {
  return compact(
    hubSite?.websitePlan
    || profile?.payment?.planId
    || profile?.websiteBuilder?.selectedPlanId
  );
}

export function analyticsAccessFor(profile = {}, hubSite = null) {
  const planId = planIdForProfile(profile, hubSite);
  const level = analyticsLevelFromFlags({
    planId,
    features: hubSite?.features || {},
  });
  return {
    level,
    planId,
    allowed: level !== ANALYTICS_LEVEL_NONE,
    ecommerce: level === 'advanced',
  };
}

export function findHubSiteForProfile(profile = {}) {
  const bank = profile?.clientDataBank || {};
  const domain = hostOf(
    bank.generalInfo?.websiteUrl
    || bank.websiteCreatorQuestions?.websiteDomain
  );
  if (domain) {
    const byDomain = getSiteByDomain(domain);
    if (byDomain) return byDomain;
  }
  const salesId = compact(bank.makerLink?.salesClientId);
  if (salesId) {
    const match = getAllSites().find((site) => compact(site.id) === salesId || compact(site.cms?.githubRepo).includes(salesId));
    if (match) return match;
  }
  const name = compact(profile.businessName || bank.generalInfo?.companyName || bank.businessCard?.companyName).toLowerCase();
  if (name) {
    const match = getAllSites().find((site) => compact(site.name).toLowerCase() === name);
    if (match) return match;
  }
  return null;
}

export function findProfileForSiteKey(siteKey) {
  const site = getSiteByKey(siteKey);
  if (!site) return { site: null, profile: null };
  const domain = hostOf(site.domain);
  const list = clientPortal.listClientProfiles();
  const match = list.find((profile) => {
    const bank = profile?.clientDataBank || {};
    return hostOf(bank.generalInfo?.websiteUrl || bank.websiteCreatorQuestions?.websiteDomain) === domain
      || compact(profile.businessName).toLowerCase() === compact(site.name).toLowerCase();
  });
  return { site, profile: match || null };
}

function listingFromRecord(record) {
  const snapshots = Array.isArray(record?.snapshots) ? record.snapshots : [];
  const latest = snapshots.filter((row) => row?.ok).at(-1) || null;
  const previous = snapshots.filter((row) => row?.ok).at(-2) || null;
  return { snapshots, latest, previous };
}

function mapsHistory(snapshots = []) {
  return snapshots.filter((row) => row?.ok).map((row) => ({
    ranAt: row.ranAt,
    avgPosition: row.summary?.avgPosition || null,
    bestPosition: row.summary?.bestPosition || null,
    rating: row.summary?.rating || 0,
    reviews: row.summary?.reviews || 0,
    found: row.summary?.found || 0,
  }));
}

export async function ensureMapsRanking(profile, hubSite, { force = false, fetchImpl } = {}) {
  const subject = buildMapsSubject(profile, hubSite || {});
  const id = subject.businessId || subject.siteKey;
  if (!id) return { ok: false, error: 'Mangler bedrift.' };
  const intervalMs = mapsRankingIntervalMs();
  const record = getMapsRankingRecord(id);
  const last = Date.parse(record?.lastRunAt || '');
  if (!force && Number.isFinite(last) && Date.now() - last < intervalMs) {
    return record;
  }
  if (!isDataForSeoMapsConfigured()) {
    markMapsRankingError(id, 'DATAFORSEO_AUTH er ikke satt på huben.');
    return getMapsRankingRecord(id);
  }
  try {
    const snapshot = await runMapsRankingForSubject(subject, { fetchImpl });
    snapshot.businessId = subject.businessId;
    snapshot.siteKey = subject.siteKey;
    return saveMapsRankingSnapshot(id, snapshot, { intervalMs });
  } catch (error) {
    markMapsRankingError(id, error.message || String(error));
    return getMapsRankingRecord(id);
  }
}

export async function buildAnalyticsDashboard({
  profile,
  hubSite,
  range = '30d',
  from = '',
  to = '',
  includeMapsRun = false,
} = {}) {
  const site = hubSite || findHubSiteForProfile(profile || {});
  const access = analyticsAccessFor(profile || {}, site);
  const window = rangeFromPreset(range, from, to);
  if (!access.allowed) {
    return {
      access,
      range: { preset: window.preset, from: window.from.toISOString(), to: window.to.toISOString() },
    };
  }

  const subject = buildMapsSubject(profile || {}, site || {});
  const id = subject.businessId || subject.siteKey;
  if (includeMapsRun) {
    await ensureMapsRanking(profile, site);
  }
  const mapsRecord = id ? getMapsRankingRecord(id) : null;
  const { latest, previous, snapshots } = listingFromRecord(mapsRecord);

  let gbp = publicGbpStatus(getGoogleBusinessConnection(subject.businessId));
  let gbpInsights = null;
  if (gbp.connected && subject.businessId) {
    try {
      const fetched = await fetchGoogleBusinessInsights(subject.businessId, { from: window.from, to: window.to });
      gbp = { ...gbp, needsLocation: fetched.needsLocation === true };
      gbpInsights = fetched.metrics;
    } catch (error) {
      gbp = { ...gbp, lastError: error.message || 'Kunne ikke hente Google Business-innsikt.' };
    }
  }

  const siteKey = compact(site?.site_key || subject.siteKey);
  const trafficEvents = siteKey ? readTrafficEvents(siteKey, window.from.getTime(), window.to.getTime()) : [];
  const traffic = summarizeTrafficEvents(trafficEvents, window);
  const goals = analyticsGoalsFromBank(profile?.clientDataBank || {});
  const cta = summarizeCta(trafficEvents, goals.ctaPath, {
    from: window.from,
    to: window.to,
    visits: traffic.visits,
  });
  const commerceSnap = siteKey ? getCommerceSnapshot(siteKey) : null;
  const purchaseStubs = Array.from({ length: Number(commerceSnap?.orders) || 0 }, () => ({ status: 'new' }));
  const liveFunnel = summarizeEcommerceFunnel(trafficEvents, purchaseStubs, window);
  const commerce = access.ecommerce
    ? {
      available: true,
      source: commerceSnap ? 'cms-orders' : 'traffic-funnel',
      orders: Number(commerceSnap?.orders) || 0,
      cancelled: Number(commerceSnap?.cancelled) || 0,
      revenue: Number(commerceSnap?.revenue) || 0,
      aov: Number(commerceSnap?.aov) || 0,
      unitsSold: Number(commerceSnap?.unitsSold) || 0,
      itemsPerOrder: Number(commerceSnap?.itemsPerOrder) || 0,
      conversionRate: Number(commerceSnap?.conversionRate) || 0,
      customers: Number(commerceSnap?.customers) || 0,
      returningCustomers: Number(commerceSnap?.returningCustomers) || 0,
      newCustomers: Number(commerceSnap?.newCustomers) || 0,
      returningRate: Number(commerceSnap?.returningRate) || 0,
      topProducts: Array.isArray(commerceSnap?.topProducts) ? commerceSnap.topProducts : [],
      series: Array.isArray(commerceSnap?.series) ? commerceSnap.series : [],
      funnel: Array.isArray(commerceSnap?.funnel) && commerceSnap.funnel.length ? commerceSnap.funnel : liveFunnel.stages,
      abandonment: commerceSnap?.abandonment || liveFunnel.abandonment,
      savedAt: commerceSnap?.savedAt || '',
      range: commerceSnap?.range || null,
    }
    : null;

  return {
    access,
    range: { preset: window.preset, from: window.from.toISOString(), to: window.to.toISOString() },
    subject: {
      name: subject.name,
      address: subject.address,
      town: subject.town,
      website: subject.website,
      placeId: subject.placeId,
      mapsUrl: subject.mapsUrl,
      keywords: buildMapsKeywords(subject),
    },
    goals: {
      ...goals,
      label: goals.mainCtaText,
    },
    provider: {
      maps: isDataForSeoMapsConfigured() ? 'dataforseo-google-maps-serp' : '',
      gbpConfigured: isGoogleBusinessConfigured(),
      spend: mapsSpendSummary(),
    },
    traffic,
    cta,
    maps: {
      lastRunAt: mapsRecord?.lastRunAt || '',
      nextRunAt: mapsRecord?.nextRunAt || '',
      lastError: mapsRecord?.lastError || '',
      intervalDays: Math.round(mapsRankingIntervalMs() / 86400000),
      summary: latest?.summary || null,
      previousSummary: previous?.summary || null,
      queries: latest?.queries || [],
      history: mapsHistory(snapshots),
    },
    gbp: {
      ...gbp,
      insights: gbpInsights,
    },
    ecommerce: commerce,
  };
}

export function ingestHubTraffic(siteKey, events) {
  return appendTrafficEvents(siteKey, events);
}

export function ingestHubCommerce(siteKey, payload) {
  return saveCommerceSnapshot(siteKey, payload);
}

export { findHubSiteForProfile as resolveHubSite };

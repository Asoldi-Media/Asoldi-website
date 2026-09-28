import { fetchGoogleMapsSerp, locationCoordinate } from './dataforseo-maps.js';
import { phrasesFromKeywordPlan } from './analytics-insights.js';

const INTERVAL_DAYS_DEFAULT = 14;
const MAX_KEYWORDS = 3;

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function digits(value = '') {
  return compact(value).replace(/\D+/g, '');
}

function tokens(value = '') {
  return compact(value)
    .toLowerCase()
    .replace(/[^a-z0-9æøåäöüéèêà\s-]/gi, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 1);
}

function hostOf(url = '') {
  const raw = compact(url).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  return raw;
}

export function mapsRankingIntervalMs(env = process.env) {
  const days = Number(env.MAPS_RANKING_INTERVAL_DAYS);
  const n = Number.isFinite(days) && days >= 1 ? days : INTERVAL_DAYS_DEFAULT;
  return n * 24 * 60 * 60 * 1000;
}

export function buildMapsKeywords(subject = {}) {
  const fromPlan = phrasesFromKeywordPlan(subject.keywordPlan, MAX_KEYWORDS);
  const listed = Array.isArray(subject.keywords)
    ? subject.keywords.map(compact).filter(Boolean)
    : compact(subject.keywords)
      .split(/[,\n]/)
      .map(compact)
      .filter(Boolean);
  const town = compact(subject.town);
  const industry = compact(subject.industry);
  const extras = [];
  if (fromPlan.length) extras.push(...fromPlan);
  else if (listed.length) extras.push(...listed);
  else if (industry && town) extras.push(`${industry} ${town}`);
  else if (industry) extras.push(industry);
  const name = compact(subject.name);
  if (!extras.length && name && town) extras.push(`${name} ${town}`);
  if (!extras.length && name) extras.push(name);
  const seen = new Set();
  const out = [];
  for (const row of extras) {
    const key = row.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export function scoreMapsItem(item = {}, subject = {}) {
  if (!item || item.type === 'maps_paid_item') return 0;
  let score = 0;
  const placeId = compact(subject.placeId);
  if (placeId && compact(item.place_id) === placeId) score += 100;
  const title = compact(item.title || item.original_title);
  const name = compact(subject.name);
  if (name && title) {
    const a = title.toLowerCase();
    const b = name.toLowerCase();
    if (a === b) score += 50;
    else if (a.includes(b) || b.includes(a)) score += 36;
    else {
      const nameTokens = tokens(name);
      const hit = nameTokens.filter((tok) => a.includes(tok)).length;
      if (nameTokens.length && hit / nameTokens.length >= 0.6) score += 22;
    }
  }
  const itemHost = hostOf(item.domain || item.url || item.website);
  const subjectHost = hostOf(subject.website);
  if (itemHost && subjectHost && (itemHost === subjectHost || itemHost.endsWith(`.${subjectHost}`) || subjectHost.endsWith(`.${itemHost}`))) {
    score += 32;
  }
  const phoneA = digits(item.phone);
  const phoneB = digits(subject.phone);
  if (phoneA.length >= 8 && phoneB.length >= 8 && (phoneA.endsWith(phoneB.slice(-8)) || phoneB.endsWith(phoneA.slice(-8)))) {
    score += 24;
  }
  const addrA = tokens(item.address || item.snippet);
  const addrB = tokens(subject.address);
  if (addrA.length && addrB.length) {
    const overlap = addrB.filter((tok) => addrA.includes(tok)).length;
    if (overlap >= 2) score += 16;
    else if (overlap === 1) score += 6;
  }
  return score;
}

export function pickBusinessFromMapsItems(items = [], subject = {}) {
  const rows = Array.isArray(items) ? items.filter((item) => item && item.type !== 'maps_paid_item') : [];
  let best = null;
  let bestScore = 0;
  rows.forEach((item, index) => {
    const score = scoreMapsItem(item, subject);
    if (score > bestScore) {
      bestScore = score;
      best = { item, score, index };
    }
  });
  if (!best || bestScore < 28) {
    return {
      found: false,
      score: bestScore,
      position: null,
      item: null,
      competitors: summarizeCompetitors(rows.slice(0, 8), subject),
    };
  }
  const position = Number(best.item.rank_absolute || best.item.rank_group || best.index + 1) || best.index + 1;
  return {
    found: true,
    score: bestScore,
    position,
    item: best.item,
    competitors: summarizeCompetitors(rows.slice(0, 8), subject, best.item),
  };
}

function summarizeCompetitors(items, subject, self) {
  const selfId = compact(self?.place_id);
  return items
    .filter((item) => compact(item.place_id) !== selfId)
    .slice(0, 6)
    .map((item, index) => ({
      position: Number(item.rank_absolute || item.rank_group || index + 1) || index + 1,
      title: compact(item.title),
      address: compact(item.address),
      rating: Number(item.rating?.value) || 0,
      reviews: Number(item.rating?.votes_count) || 0,
      category: compact(item.category),
      domain: compact(item.domain),
      placeId: compact(item.place_id),
    }));
}

export function mapsItemSnapshot(item = {}, extra = {}) {
  const rating = item?.rating && typeof item.rating === 'object' ? item.rating : {};
  return {
    position: extra.position || Number(item.rank_absolute || item.rank_group) || null,
    title: compact(item.title),
    address: compact(item.address),
    category: compact(item.category),
    additionalCategories: Array.isArray(item.additional_categories) ? item.additional_categories.map(compact).filter(Boolean) : [],
    rating: Number(rating.value) || 0,
    reviews: Number(rating.votes_count) || 0,
    ratingDistribution: rating.rating_distribution && typeof rating.rating_distribution === 'object'
      ? rating.rating_distribution
      : null,
    phone: compact(item.phone),
    domain: compact(item.domain),
    url: compact(item.url),
    placeId: compact(item.place_id),
    cid: compact(item.cid),
    claimed: item.is_claimed === true,
    latitude: Number(item.latitude) || null,
    longitude: Number(item.longitude) || null,
    mainImage: compact(item.main_image),
    totalPhotos: Number(item.total_photos) || 0,
    priceLevel: compact(item.price_level),
    currentStatus: compact(item.work_hours?.current_status),
    localJustifications: Array.isArray(item.local_justifications)
      ? item.local_justifications.map((row) => ({
        type: compact(row?.type),
        text: compact(row?.text),
      })).filter((row) => row.text)
      : [],
    score: extra.score || 0,
  };
}

export async function geocodeAddress(address, { fetchImpl = fetch } = {}) {
  const q = compact(address);
  if (!q) return null;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AsoldiAnalytics/1.0 (https://asoldi.com)',
    },
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  const lat = Number(row?.lat);
  const lng = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, displayName: compact(row?.display_name) };
}

export function buildMapsSubject(profile = {}, hubSite = {}) {
  const bank = profile?.clientDataBank && typeof profile.clientDataBank === 'object' ? profile.clientDataBank : {};
  const info = bank.generalInfo || {};
  const card = bank.businessCard || {};
  const questions = bank.websiteCreatorQuestions || {};
  const name = compact(
    info.googlePlaceName
    || info.companyName
    || card.companyName
    || profile.businessName
    || hubSite.name
  );
  const address = compact(info.companyAddress);
  const town = compact(questions.town);
  const country = compact(questions.country) || 'Norway';
  return {
    businessId: compact(profile.businessId || profile.userId),
    siteKey: compact(hubSite.site_key),
    name,
    industry: compact(card.industry),
    address,
    town,
    country,
    phone: compact(info.companyPhone),
    website: compact(info.websiteUrl || questions.websiteDomain || hubSite.domain),
    placeId: compact(info.googlePlaceId),
    mapsUrl: compact(info.googleMapsUrl || bank.openingHours?.googleBusinessSyncUrl),
    keywords: questions.importantKeywords,
    keywordPlan: bank.seo?.keywordPlan || null,
    language: compact(info.websiteLanguage) || 'Norsk (Norge)',
    mainCtaText: compact(questions.mainCtaText || questions.primaryAction),
    mainCtaUrl: compact(questions.mainCtaUrl),
  };
}

export async function runMapsRankingForSubject(subject, {
  geocode,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const keywords = buildMapsKeywords(subject);
  if (!keywords.length) {
    return { ok: false, error: 'Mangler søkeord og bedriftsnavn for Google Maps-rangering.' };
  }
  let coordinate = '';
  let geo = geocode || null;
  if (!geo && subject.address) {
    geo = await geocodeAddress(subject.address, { fetchImpl });
  }
  if (geo) coordinate = locationCoordinate(geo);
  const locationName = !coordinate && subject.town
    ? [subject.town, subject.country || 'Norway'].filter(Boolean).join(',')
    : '';
  if (!coordinate && !locationName) {
    return { ok: false, error: 'Legg inn bedriftsadressen i kundekortet for lokal Maps-rangering.' };
  }

  const queries = [];
  for (const keyword of keywords) {
    const serp = await fetchGoogleMapsSerp({
      keyword,
      location_coordinate: coordinate,
      location_name: coordinate ? '' : locationName,
      language_code: /norsk|nb|no/i.test(subject.language || '') ? 'no' : 'en',
      se_domain: /norsk|nb|no|norway/i.test(`${subject.language} ${subject.country}`) ? 'google.no' : 'google.com',
      device: 'mobile',
    }, { env, fetchImpl });
    const match = pickBusinessFromMapsItems(serp.items, subject);
    queries.push({
      keyword,
      found: match.found,
      position: match.position,
      score: match.score,
      checkUrl: serp.checkUrl,
      cached: Boolean(serp.cached),
      costUsd: serp.cached ? 0 : serp.costUsd,
      datetime: serp.datetime,
      listing: match.found ? mapsItemSnapshot(match.item, { position: match.position, score: match.score }) : null,
      competitors: match.competitors,
      pack: (serp.items || []).filter((item) => item?.type !== 'maps_paid_item').slice(0, 10).map((item, index) => ({
        position: Number(item.rank_absolute || item.rank_group || index + 1) || index + 1,
        title: compact(item.title),
        address: compact(item.address),
        rating: Number(item.rating?.value) || 0,
        reviews: Number(item.rating?.votes_count) || 0,
        isSelf: match.found && compact(item.place_id) === compact(match.item?.place_id),
      })),
    });
  }

  const found = queries.filter((row) => row.found);
  const avgPosition = found.length
    ? found.reduce((sum, row) => sum + Number(row.position || 0), 0) / found.length
    : null;
  const listing = found[0]?.listing || null;

  return {
    ok: true,
    ranAt: new Date().toISOString(),
    provider: 'dataforseo-google-maps-serp',
    subject: {
      name: subject.name,
      address: subject.address,
      town: subject.town,
      placeId: subject.placeId,
      website: subject.website,
    },
    geocode: geo || null,
    keywords,
    queries,
    summary: {
      found: found.length,
      missing: queries.length - found.length,
      avgPosition,
      bestPosition: found.length ? Math.min(...found.map((row) => Number(row.position) || 99)) : null,
      rating: listing?.rating || 0,
      reviews: listing?.reviews || 0,
      claimed: listing?.claimed === true,
      category: listing?.category || '',
    },
  };
}

import { google } from 'googleapis';
import { getGoogleBusinessConnection, saveGoogleBusinessConnection } from '../data/client-analytics.js';
import {
  GOOGLE_BUSINESS_OAUTH_EVENT,
  renderGoogleBusinessOAuthResultHtml,
} from './google-business-oauth-ui.js';

const GBP_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/business.manage',
];

function compact(value = '') {
  return String(value ?? '').trim();
}

function getConfig() {
  const clientId = compact(process.env.CLIENT_GOOGLE_CLIENT_ID) || compact(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = compact(process.env.CLIENT_GOOGLE_CLIENT_SECRET) || compact(process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  const redirectUri = compact(process.env.CLIENT_GOOGLE_BUSINESS_REDIRECT_URI)
    || compact(process.env.GOOGLE_BUSINESS_REDIRECT_URI);
  const appUrl = compact(process.env.APP_URL);
  return { clientId, clientSecret, redirectUri, appUrl };
}

export function isGoogleBusinessConfigured() {
  const { clientId, clientSecret } = getConfig();
  return Boolean(clientId && clientSecret);
}

export function resolveGoogleBusinessRedirectUri(req) {
  const { redirectUri, appUrl } = getConfig();
  if (redirectUri) return redirectUri;
  const base = appUrl || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/client/google-business/callback`;
}

function createOAuthClient(redirectUri) {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Google Business Profile is not configured.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createGoogleBusinessAuthUrl(state, redirectUri) {
  const oauthClient = createOAuthClient(redirectUri);
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: GBP_SCOPES,
    state: compact(state),
  });
}

async function profileFromClient(oauthClient) {
  const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
  const { data } = await oauth2.userinfo.get();
  return {
    googleEmail: compact(data?.email).toLowerCase(),
    googleName: compact(data?.name),
  };
}

export async function exchangeGoogleBusinessCode(code, redirectUri, businessId) {
  const oauthClient = createOAuthClient(redirectUri);
  const { tokens } = await oauthClient.getToken(compact(code));
  if (!tokens?.access_token) throw new Error('Google ga ikke tilbake et tilgangstoken.');
  oauthClient.setCredentials(tokens);
  const profile = await profileFromClient(oauthClient);
  let locations = [];
  let listError = '';
  try {
    locations = await listBusinessLocations(oauthClient);
  } catch (error) {
    listError = compact(error?.message) || 'Kunne ikke hente Google-bedriftslokasjoner.';
  }
  const selected = locations.length === 1 ? locations[0] : null;
  const saved = saveGoogleBusinessConnection(businessId, {
    refreshToken: tokens.refresh_token || getGoogleBusinessConnection(businessId)?.refreshToken || '',
    accessToken: tokens.access_token,
    expiryDate: tokens.expiry_date || '',
    googleEmail: profile.googleEmail,
    googleName: profile.googleName,
    accountName: selected?.accountName || '',
    locationName: selected?.name || '',
    locationTitle: selected?.title || '',
    placeId: selected?.placeId || '',
    locations,
    connectedAt: new Date().toISOString(),
    lastError: listError || (locations.length ? '' : 'Ingen Google-bedriftslokasjoner ble funnet på kontoen.'),
  });
  return saved;
}

async function authorizedClient(businessId, req) {
  const row = getGoogleBusinessConnection(businessId);
  if (!row?.refreshToken && !row?.accessToken) {
    throw new Error('Google Business Profile er ikke koblet til.');
  }
  const redirectUri = req
    ? resolveGoogleBusinessRedirectUri(req)
    : (compact(process.env.CLIENT_GOOGLE_BUSINESS_REDIRECT_URI)
      || compact(process.env.GOOGLE_BUSINESS_REDIRECT_URI)
      || `${compact(process.env.APP_URL).replace(/\/$/, '')}/api/client/google-business/callback`);
  const oauthClient = createOAuthClient(redirectUri);
  oauthClient.setCredentials({
    refresh_token: row.refreshToken,
    access_token: row.accessToken,
    expiry_date: row.expiryDate,
  });
  oauthClient.on('tokens', (tokens) => {
    if (!tokens) return;
    saveGoogleBusinessConnection(businessId, {
      accessToken: tokens.access_token || row.accessToken,
      refreshToken: tokens.refresh_token || row.refreshToken,
      expiryDate: tokens.expiry_date || row.expiryDate,
    });
  });
  await oauthClient.getAccessToken();
  return oauthClient;
}

async function googleJson(oauthClient, url) {
  const tokenRes = await oauthClient.getAccessToken();
  const token = tokenRes?.token || oauthClient.credentials?.access_token;
  if (!token) throw new Error('Mangler Google-tilgangstoken.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `Google HTTP ${response.status}`);
  }
  return json;
}

async function listBusinessLocations(oauthClient) {
  const out = [];
  const accountsJson = await googleJson(oauthClient, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20');
  const accounts = Array.isArray(accountsJson?.accounts) ? accountsJson.accounts : [];
  for (const account of accounts) {
    const accountName = compact(account.name);
    if (!accountName) continue;
    const locUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=50`;
    const locJson = await googleJson(oauthClient, locUrl);
    const locations = Array.isArray(locJson?.locations) ? locJson.locations : [];
    for (const location of locations) {
      out.push({
        name: compact(location.name),
        title: compact(location.title),
        accountName,
        placeId: compact(location.metadata?.placeId),
        address: compact(
          [
            location.storefrontAddress?.addressLines?.[0],
            location.storefrontAddress?.postalCode,
            location.storefrontAddress?.locality,
          ].filter(Boolean).join(', ')
        ),
      });
    }
  }
  return out;
}

export async function selectGoogleBusinessLocation(businessId, locationName) {
  const row = getGoogleBusinessConnection(businessId);
  if (!row) throw new Error('Koble til Google Business Profile først.');
  const match = (row.locations || []).find((item) => item.name === locationName);
  if (!match) throw new Error('Fant ikke valgt lokasjon.');
  return saveGoogleBusinessConnection(businessId, {
    locationName: match.name,
    locationTitle: match.title,
    accountName: match.accountName,
    placeId: match.placeId,
    lastError: '',
  });
}

function metricSum(timeSeries = []) {
  let total = 0;
  const points = [];
  for (const series of timeSeries) {
    const rows = Array.isArray(series?.datedValues) ? series.datedValues : [];
    for (const row of rows) {
      const value = Number(row.value) || 0;
      total += value;
      points.push({
        date: compact(row.date?.year && row.date?.month && row.date?.day
          ? `${row.date.year}-${String(row.date.month).padStart(2, '0')}-${String(row.date.day).padStart(2, '0')}`
          : ''),
        value,
      });
    }
  }
  return { total, points };
}

export async function fetchGoogleBusinessInsights(businessId, { from, to } = {}) {
  const row = getGoogleBusinessConnection(businessId);
  if (!row?.locationName) {
    return { connected: Boolean(row?.refreshToken), needsLocation: true, metrics: null };
  }
  const oauthClient = await authorizedClient(businessId);
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  const loc = compact(row.locationName).match(/locations\/[^/]+$/)?.[0] || compact(row.locationName);
  const rangeQs = [
    `dailyRange.startDate.year=${start.getUTCFullYear()}`,
    `dailyRange.startDate.month=${start.getUTCMonth() + 1}`,
    `dailyRange.startDate.day=${start.getUTCDate()}`,
    `dailyRange.endDate.year=${end.getUTCFullYear()}`,
    `dailyRange.endDate.month=${end.getUTCMonth() + 1}`,
    `dailyRange.endDate.day=${end.getUTCDate()}`,
  ].join('&');
  const names = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'WEBSITE_CLICKS',
    'CALL_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
    'BUSINESS_CONVERSATIONS',
  ];
  const metrics = {};
  for (const dailyMetric of names) {
    try {
      const url = `https://businessprofileperformance.googleapis.com/v1/${loc}:getDailyMetricsTimeSeries?dailyMetric=${dailyMetric}&${rangeQs}`;
      const json = await googleJson(oauthClient, url);
      metrics[dailyMetric] = metricSum(json?.timeSeries ? [json.timeSeries] : []);
    } catch {
      metrics[dailyMetric] = { total: 0, points: [] };
    }
  }
  const mapsViews = (metrics.BUSINESS_IMPRESSIONS_DESKTOP_MAPS?.total || 0)
    + (metrics.BUSINESS_IMPRESSIONS_MOBILE_MAPS?.total || 0);
  const searchViews = (metrics.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH?.total || 0)
    + (metrics.BUSINESS_IMPRESSIONS_MOBILE_SEARCH?.total || 0);
  const insights = {
    mapsViews,
    searchViews,
    websiteClicks: metrics.WEBSITE_CLICKS?.total || 0,
    callClicks: metrics.CALL_CLICKS?.total || 0,
    directionRequests: metrics.BUSINESS_DIRECTION_REQUESTS?.total || 0,
    conversations: metrics.BUSINESS_CONVERSATIONS?.total || 0,
    series: {
      maps: mergeSeries(metrics.BUSINESS_IMPRESSIONS_DESKTOP_MAPS?.points, metrics.BUSINESS_IMPRESSIONS_MOBILE_MAPS?.points),
      search: mergeSeries(metrics.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH?.points, metrics.BUSINESS_IMPRESSIONS_MOBILE_SEARCH?.points),
      website: metrics.WEBSITE_CLICKS?.points || [],
    },
  };
  saveGoogleBusinessConnection(businessId, { lastInsightsAt: new Date().toISOString(), lastError: '', insightsCache: insights });
  return { connected: true, needsLocation: false, metrics: insights };
}

function mergeSeries(a = [], b = []) {
  const map = new Map();
  for (const row of [...a, ...b]) {
    if (!row?.date) continue;
    map.set(row.date, (map.get(row.date) || 0) + (Number(row.value) || 0));
  }
  return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, value]) => ({ date, value }));
}

export { GOOGLE_BUSINESS_OAUTH_EVENT, renderGoogleBusinessOAuthResultHtml };

import { clientMeetingAtIso, getActiveNextAction } from './sales-next-actions.js';
import { resolveWebsiteDue } from './website-due.js';
import { normalizeDeveloperGoals } from './developer-goals.js';

export const DEVELOPMENT_KEYS = [
  'hostingerEnvironmentSetup',
  'githubRepoPushed',
  'v1Ferdig',
  'nettsideFerdig',
];

export const DEVELOPMENT_STEP_LABELS = {
  hostingerEnvironmentSetup: 'Hostinger environment sat opp',
  githubRepoPushed: 'GitHub repo pushed',
  v1Ferdig: 'Få tilbakemelding',
  nettsideFerdig: 'Nettside ferdig',
};

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function emptyDevelopment() {
  return {
    hostingerEnvironmentSetup: false,
    githubRepoPushed: false,
    v1Ferdig: false,
    nettsideFerdig: false,
  };
}

export function normalizeDevelopment(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    hostingerEnvironmentSetup: Boolean(input.hostingerEnvironmentSetup),
    githubRepoPushed: Boolean(input.githubRepoPushed),
    v1Ferdig: Boolean(input.v1Ferdig),
    nettsideFerdig: Boolean(input.nettsideFerdig),
  };
}

export function normalizeDeliveryPhase(value, fallback = 'client') {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'development' || raw === 'client') return raw;
  return fallback === 'development' ? 'development' : 'client';
}

export function formatDevelopmentStepLabel(key = '') {
  return DEVELOPMENT_STEP_LABELS[key] || key;
}

export function isBynesetSite(site = {}) {
  const hay = `${site.name || ''} ${site.domain || ''}`.toLowerCase();
  return hay.includes('byneset');
}

function normalizeDomain(value = '') {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0];
}

export function siteMatchesSalesClient(site, client) {
  if (!site || !client) return false;
  const siteKey = sanitizeText(site.site_key);
  const clientKey = sanitizeText(client.hubSite?.siteKey);
  if (siteKey && clientKey && siteKey === clientKey) return true;
  const siteId = sanitizeText(site.id);
  const clientSiteId = sanitizeText(client.hubSite?.id);
  if (siteId && clientSiteId && siteId === clientSiteId) return true;
  const siteDomain = normalizeDomain(site.domain);
  const clientDomain = normalizeDomain(client.websiteDomain || client.hubSite?.domain);
  if (siteDomain && clientDomain && siteDomain === clientDomain) return true;
  const siteName = sanitizeText(site.name).toLowerCase();
  const clientName = sanitizeText(client.businessName).toLowerCase();
  if (siteName && clientName && siteName === clientName) return true;
  return false;
}

export function findLinkedSalesClient(site, salesClients = []) {
  return salesClients.find((client) => siteMatchesSalesClient(site, client)) || null;
}

export function isPreviewSalesClient(client) {
  if (!client || client.product === 'ssu') return false;
  if (client.status !== 'active') return false;
  if (client.development?.nettsideFerdig) return false;
  if (client.progression?.contractSigned) return false;
  return true;
}

export function isDevelopmentSalesClient(client) {
  if (!client || client.product === 'ssu') return false;
  if (client.status === 'not-sold') return false;
  if (!client.progression?.contractSigned) return false;
  if (client.development?.nettsideFerdig) return false;
  return true;
}

export function isDeveloperBoardClient(client) {
  return isPreviewSalesClient(client) || isDevelopmentSalesClient(client);
}

export function isSsuBoardClient(client) {
  if (!client || String(client.product || '').trim().toLowerCase() !== 'ssu') return false;
  if (client.status === 'not-sold') return false;
  return true;
}

/**
 * Existing hub sites stay on Clients unless they are Byneset, already marked
 * development, or finished (nettside ferdig). New got-client / go-live writes
 * set deliveryPhase=development explicitly so they never land on Clients.
 */
export function resolveSiteDeliveryPhase(site, salesClients = []) {
  const linked = findLinkedSalesClient(site, salesClients);
  const finished = Boolean(site?.development?.nettsideFerdig || linked?.development?.nettsideFerdig);
  if (finished) return 'client';
  if (isBynesetSite(site)) return 'development';
  if (site?.deliveryPhase === 'development' || site?.deliveryPhase === 'client') {
    return site.deliveryPhase;
  }
  return 'client';
}

export function isLiveHubClient(site, salesClients = []) {
  return resolveSiteDeliveryPhase(site, salesClients) !== 'development';
}

export const DEVELOPMENT_BOARD_STORAGE_KEY = 'asoldi-development-board';

export function persistDevelopmentBoard(board = '') {
  const next = board === 'preview' || board === 'deployment' ? board : '';
  if (!next || typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(DEVELOPMENT_BOARD_STORAGE_KEY, next);
  } catch {
    // Ignore storage issues.
  }
}

export function readStoredDevelopmentBoard(fallback = 'preview') {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return fallback === 'deployment' ? 'deployment' : 'preview';
    }
    const raw = window.localStorage.getItem(DEVELOPMENT_BOARD_STORAGE_KEY);
    if (raw === 'preview' || raw === 'deployment') return raw;
  } catch {
    // Ignore storage issues.
  }
  return fallback === 'deployment' ? 'deployment' : 'preview';
}

export function previewTimelineAt(client = null) {
  if (!client) return '';
  if (normalizeDeveloperGoals(client.developerGoals).readyForPreview) return '';
  return sanitizeText(clientMeetingAtIso(client));
}

function toDevelopmentItem({ client = null, site = null, board = 'deployment' } = {}) {
  const development = normalizeDevelopment({
    ...(site?.development || {}),
    ...(client?.development || {}),
  });
  const salesId = sanitizeText(client?.id);
  const siteId = sanitizeText(site?.id);
  const nextAction = client ? getActiveNextAction(client) : null;
  const meetingAt = client ? sanitizeText(clientMeetingAtIso(client)) : '';
  const websiteDue = resolveWebsiteDue({
    contractSigned: Boolean(client?.progression?.contractSigned),
    contractSignedAt: client?.contractSignedAt,
    dueOverride: client?.websiteDueOverride || site?.websiteDueOverride,
    weeks: client?.websiteDeliveryWeeks,
    workDays: client?.websiteDeliveryWorkDays,
  });
  const previewAt = previewTimelineAt(client);
  const rankAt = board === 'preview' ? previewAt : (websiteDue.dueAt || '');
  return {
    id: salesId ? `sales:${salesId}` : `site:${siteId}`,
    salesClientId: salesId,
    siteId,
    businessName: sanitizeText(client?.businessName || site?.name) || 'Unnamed',
    contactPerson: sanitizeText(client?.contactPerson),
    contactEmail: sanitizeText(client?.contactEmail),
    contactPhone: sanitizeText(client?.contactPhone),
    meetingPlace: sanitizeText(client?.meetingPlace),
    industry: sanitizeText(client?.industry),
    product: String(client?.product || '').trim().toLowerCase() === 'ssu' ? 'ssu' : 'asoldi',
    createdAt: sanitizeText(client?.createdAt || site?.createdAt),
    websiteDomain: sanitizeText(client?.websiteDomain || site?.domain),
    notes: sanitizeText(client?.notes),
    meetingAt,
    nextActionAt: sanitizeText(nextAction?.dueAt),
    nextActionName: sanitizeText(nextAction?.name),
    rankAt,
    websiteDue,
    workshop: client?.workshop || null,
    workshopHeldAt: sanitizeText(client?.workshop?.heldAt),
    workshopSummary: client?.workshop?.summary || null,
    iterationLog: Array.isArray(client?.workshop?.iterationLog) ? client.workshop.iterationLog : [],
    iterationMeeting: client?.workshop?.iterationMeeting || null,
    hasIterationMeeting: Boolean(
      sanitizeText(client?.workshop?.iterationMeeting?.sentAt)
      || sanitizeText(client?.workshop?.iterationMeeting?.firefliesMeetingId)
      || sanitizeText(client?.workshop?.iterationMeeting?.dueAt)
      || (Array.isArray(client?.meetings) && client.meetings.some((row) => sanitizeText(row?.purpose) === 'iteration'))
    ),
    iterationTranscript: (() => {
      const meetings = Array.isArray(client?.meetings) ? client.meetings : [];
      const slotId = sanitizeText(client?.workshop?.iterationMeeting?.firefliesMeetingId);
      const tagged = meetings.find((row) => sanitizeText(row?.purpose) === 'iteration');
      const row = meetings.find((entry) => sanitizeText(entry?.meetingId) === slotId) || tagged;
      return sanitizeText(row?.summary);
    })(),
    developerQa: client?.developerQa || { textOk: false, mediaOk: false, responsiveOk: false },
    developerGoals: normalizeDeveloperGoals(client?.developerGoals),
    offerTierId: sanitizeText(client?.offerTierId),
    offerCustom: Boolean(client?.offerCustom),
    portalUserId: sanitizeText(client?.portalUserId),
    makerRun: client?.makerRun || null,
    developerOwnerId: sanitizeText(client?.developerOwnerId),
    developerHandoff: client?.developerHandoff || null,
    publicPreviewUrl: sanitizeText(client?.websiteImport?.publicUrl)
      || (sanitizeText(client?.websiteImport?.publicPreviewPublishedAt) && salesId
        ? `/sales-preview/${encodeURIComponent(salesId)}/`
        : ''),
    websiteImport: client?.websiteImport || null,
    hubSite: client?.hubSite || (site
      ? {
          siteKey: sanitizeText(site.site_key),
          domain: sanitizeText(site.domain),
          id: sanitizeText(site.id),
          createdAt: sanitizeText(site.createdAt),
        }
      : null),
    siteKey: sanitizeText(site?.site_key || client?.hubSite?.siteKey),
    development,
  };
}

export function parseDevelopmentItemId(id = '') {
  const raw = sanitizeText(id);
  if (raw.startsWith('sales:')) return { kind: 'sales', id: raw.slice(6) };
  if (raw.startsWith('site:')) return { kind: 'site', id: raw.slice(5) };
  return { kind: '', id: raw };
}

function rankMs(item = {}) {
  const ms = new Date(item?.rankAt || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Ranked by each item's rankAt (preview = booked meeting, deployment = website due).
export function sortDevelopmentItemsByTime(items = []) {
  return [...items].sort((a, b) => {
    const aMs = rankMs(a);
    const bMs = rankMs(b);
    if (aMs != null && bMs != null && aMs !== bMs) return aMs - bMs;
    if (aMs != null && bMs == null) return -1;
    if (aMs == null && bMs != null) return 1;
    return String(a.businessName).localeCompare(String(b.businessName), 'nb');
  });
}

export function buildPreviewItems(salesClients = [], sites = []) {
  return sortDevelopmentItemsByTime(
    salesClients
      .filter((client) => isPreviewSalesClient(client))
      .map((client) => {
        const site = sites.find((entry) => siteMatchesSalesClient(entry, client)) || null;
        return toDevelopmentItem({ client, site, board: 'preview' });
      })
  );
}

export function buildSsuBoardItems(salesClients = [], sites = []) {
  return sortDevelopmentItemsByTime(
    salesClients
      .filter((client) => isSsuBoardClient(client))
      .map((client) => {
        const site = sites.find((entry) => siteMatchesSalesClient(entry, client)) || null;
        const signed = Boolean(client?.progression?.contractSigned);
        return toDevelopmentItem({ client, site, board: signed ? 'deployment' : 'preview' });
      })
  );
}

export function buildDevelopmentItems(salesClients = [], sites = []) {
  const items = [];
  const usedSiteIds = new Set();

  for (const client of salesClients) {
    if (!isDevelopmentSalesClient(client)) continue;
    const site = sites.find((entry) => siteMatchesSalesClient(entry, client)) || null;
    if (site?.id) usedSiteIds.add(String(site.id));
    items.push(toDevelopmentItem({ client, site, board: 'deployment' }));
  }

  for (const site of sites) {
    if (usedSiteIds.has(String(site.id))) continue;
    if (resolveSiteDeliveryPhase(site, salesClients) !== 'development') continue;
    items.push(toDevelopmentItem({
      client: findLinkedSalesClient(site, salesClients),
      site,
      board: 'deployment',
    }));
  }

  return sortDevelopmentItemsByTime(items);
}

export function buildDeveloperBoardItems(salesClients = [], sites = []) {
  const items = [];
  const usedSiteIds = new Set();
  const usedSalesIds = new Set();

  for (const client of salesClients) {
    if (!isDeveloperBoardClient(client)) continue;
    const site = sites.find((entry) => siteMatchesSalesClient(entry, client)) || null;
    if (site?.id) usedSiteIds.add(String(site.id));
    usedSalesIds.add(String(client.id));
    items.push(toDevelopmentItem({
      client,
      site,
      board: isDevelopmentSalesClient(client) ? 'deployment' : 'preview',
    }));
  }

  for (const site of sites) {
    if (usedSiteIds.has(String(site.id))) continue;
    if (resolveSiteDeliveryPhase(site, salesClients) !== 'development') continue;
    const client = findLinkedSalesClient(site, salesClients);
    if (client && usedSalesIds.has(String(client.id))) continue;
    items.push(toDevelopmentItem({
      client,
      site,
      board: 'deployment',
    }));
  }

  return sortDevelopmentItemsByTime(items);
}

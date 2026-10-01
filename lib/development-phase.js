import { getActiveNextAction } from './sales-next-actions.js';

export const DEVELOPMENT_KEYS = [
  'hostingerEnvironmentSetup',
  'githubRepoPushed',
  'v1Ferdig',
  'nettsideFerdig',
];

export const DEVELOPMENT_STEP_LABELS = {
  hostingerEnvironmentSetup: 'Hostinger environment sat opp',
  githubRepoPushed: 'GitHub repo pushed',
  v1Ferdig: 'V1 ferdig',
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

function toDevelopmentItem({ client = null, site = null } = {}) {
  const development = normalizeDevelopment({
    ...(site?.development || {}),
    ...(client?.development || {}),
  });
  const salesId = sanitizeText(client?.id);
  const siteId = sanitizeText(site?.id);
  // Timing used by the Development board to rank cards like Sales does (next action
  // first, else the agreed meeting time) instead of alphabetically.
  const nextAction = client ? getActiveNextAction(client) : null;
  const meetingAt = client?.agreedTime ? sanitizeText(client?.meetingAt) : '';
  const rankAt = sanitizeText(nextAction?.dueAt) || meetingAt;
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
    websiteDomain: sanitizeText(client?.websiteDomain || site?.domain),
    notes: sanitizeText(client?.notes),
    meetingAt,
    nextActionAt: sanitizeText(nextAction?.dueAt),
    nextActionName: sanitizeText(nextAction?.name),
    rankAt,
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
    portalUserId: sanitizeText(client?.portalUserId),
    makerRun: client?.makerRun || null,
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

// Time-ranked: items with a next action / meeting time first (soonest first), then the
// rest alphabetically. The board applies the Sales 48-hour window on top of this.
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
        return toDevelopmentItem({ client, site });
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
    items.push(toDevelopmentItem({ client, site }));
  }

  for (const site of sites) {
    if (usedSiteIds.has(String(site.id))) continue;
    if (resolveSiteDeliveryPhase(site, salesClients) !== 'development') continue;
    items.push(toDevelopmentItem({
      client: findLinkedSalesClient(site, salesClients),
      site,
    }));
  }

  return sortDevelopmentItemsByTime(items);
}

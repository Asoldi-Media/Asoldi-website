/**
 * Inputs of one client's brief, read from the hub stores. Optional parts come from modules a build
 * may not contain; each is imported only when its file exists, and a missing or failing module only
 * leaves its part empty:
 *   lib/transcript-archive.js  readArchivedTranscripts(clientId) (else the stored Fireflies meetings)
 *   lib/media-manifest.js      the client's media manifest
 *   lib/delivery-gate.js       a gate snapshot (else client.delivery.gate)
 *   lib/seo-ops/record.js      agreed keywords (else client.seoRecord)
 *   lib/cms-setup.js           the Maker CMS setup (else a minimal one from the hub site)
 *   lib/feature-availability.js  whether a promised feature is built
 * Every call can pass `deps` to replace any reader (tests and the eval script do).
 * The input hash covers everything the brief is built from, so an unchanged hash means an
 * unchanged brief.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashOf, isPlainObject, sha256, text } from './text.js';
import { normalizePurpose, promptFor } from './extract.js';

const optionalCache = new Map();

/** The module at `relative` (from lib/delivery-brief/), or null when the build has no such file. */
export async function optionalModule(relative, { log = console } = {}) {
  if (optionalCache.has(relative)) return optionalCache.get(relative);
  const url = new URL(relative, import.meta.url);
  let mod = null;
  if (existsSync(fileURLToPath(url))) {
    try {
      mod = await import(url.href);
    } catch (error) {
      log?.warn?.(`[delivery-brief] optional module ${relative} failed to load: ${error?.code || error?.message || 'error'}`);
      mod = null;
    }
  }
  optionalCache.set(relative, mod);
  return mod;
}

export function resetOptionalModulesForTests() {
  optionalCache.clear();
}

function firstFunction(mod, names) {
  for (const name of names) if (typeof mod?.[name] === 'function') return mod[name];
  return null;
}

async function safely(fn, fallback) {
  try {
    const value = await fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- meetings and transcripts

function meetingRows(client) {
  return (Array.isArray(client?.meetings) ? client.meetings : [])
    .filter((row) => isPlainObject(row) && text(row.meetingId) && !text(row.meetingId).toLowerCase().startsWith('live:'));
}

function purposeOf(row) {
  const purpose = text(row?.purpose).toLowerCase();
  if (['sales', 'demo', 'workshop', 'iteration'].includes(purpose)) return purpose;
  return 'sales';
}

/**
 * [{ meetingId, purpose, startedAt, title, transcript, sha256, chars }] for the client's linked
 * meetings that have a transcript, oldest first.
 */
export async function readClientTranscripts(client, { deps = {}, log } = {}) {
  const clientId = text(client?.id);
  const rows = meetingRows(client);
  const byId = new Map();
  let archived = [];
  if (typeof deps.readArchivedTranscripts === 'function') {
    archived = await safely(() => deps.readArchivedTranscripts(clientId), []);
  } else {
    const mod = await optionalModule('../transcript-archive.js', { log });
    const read = firstFunction(mod, ['readArchivedTranscripts']);
    if (read) archived = await safely(() => read(clientId), []);
  }
  for (const entry of Array.isArray(archived) ? archived : []) {
    const transcript = String(entry?.transcript ?? '');
    const meetingId = text(entry?.meetingId);
    if (!meetingId || !transcript.trim()) continue;
    const row = rows.find((item) => text(item.meetingId) === meetingId);
    byId.set(meetingId, {
      meetingId,
      purpose: normalizePurpose(entry.purpose || purposeOf(row)),
      startedAt: text(entry.startedAt || row?.startedAt),
      title: text(entry.title || row?.title, 200),
      transcript,
    });
  }
  let readStored = deps.readStoredMeeting;
  if (typeof readStored !== 'function') {
    const mod = await import('../fireflies-webhook.js');
    readStored = mod.readStoredFirefliesMeeting;
  }
  for (const row of rows) {
    const meetingId = text(row.meetingId);
    if (byId.has(meetingId)) continue;
    const stored = await safely(() => readStored(meetingId), null);
    const transcript = String(stored?.transcript ?? '');
    if (!transcript.trim()) continue;
    byId.set(meetingId, {
      meetingId,
      purpose: purposeOf(row),
      startedAt: text(row.startedAt || stored?.startedAt),
      title: text(row.title || stored?.title, 200),
      transcript,
    });
  }
  return [...byId.values()]
    .map((meeting) => ({ ...meeting, sha256: sha256(meeting.transcript), chars: meeting.transcript.length }))
    .sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0) || a.meetingId.localeCompare(b.meetingId));
}

/** The transcript with this sha256 among the client's meetings, or null. */
export async function findClientTranscript(client, sha, { deps = {}, log } = {}) {
  const wanted = text(sha).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) return null;
  if (typeof deps.readTranscriptBySha !== 'function') {
    const mod = await optionalModule('../transcript-archive.js', { log });
    const read = firstFunction(mod, ['readTranscriptBySha']);
    if (read) {
      const found = await safely(() => read(text(client?.id), wanted), null);
      if (found && String(found.transcript ?? '').trim()) {
        return { meetingId: text(found.meetingId), purpose: normalizePurpose(found.purpose), startedAt: text(found.startedAt), sha256: wanted, transcript: String(found.transcript) };
      }
    }
  } else {
    const found = await safely(() => deps.readTranscriptBySha(text(client?.id), wanted), null);
    if (found && String(found.transcript ?? '').trim()) return { ...found, sha256: wanted };
  }
  const meetings = await readClientTranscripts(client, { deps, log });
  return meetings.find((meeting) => meeting.sha256 === wanted) || null;
}

// ---------------------------------------------------------------- hub records

function hostOf(value) {
  return text(value).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
}

/** The hub site linked to a sales client: by hubSite.id, then site key, then domain (as the delivery backfill links them). */
export function hubSiteForClient(client, sites) {
  const link = isPlainObject(client?.hubSite) ? client.hubSite : {};
  const list = Array.isArray(sites) ? sites : [];
  if (text(link.id)) {
    const byId = list.find((site) => text(site?.id) === text(link.id));
    if (byId) return byId;
  }
  if (text(link.siteKey)) {
    const byKey = list.find((site) => text(site?.site_key) === text(link.siteKey));
    if (byKey) return byKey;
  }
  const domain = hostOf(link.domain);
  return domain ? list.find((site) => hostOf(site?.domain) === domain) || null : null;
}

/** The portal profile linked to a sales client: portal business, portal user, then the website builder link. */
export function profileForClient(client, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const businessId = text(client?.portalBusinessId);
  const userId = text(client?.portalUserId);
  return list.find((profile) => businessId && text(profile?.businessId) === businessId)
    || list.find((profile) => userId && text(profile?.userId) === userId)
    || list.find((profile) => text(profile?.websiteBuilder?.salesClientId) === text(client?.id))
    || null;
}

async function defaultOffer(clientId) {
  const mod = await import('../../data/sales-offers.js');
  const offer = mod.getOfferForClient(clientId);
  return offer ? { offer, offerHash: mod.offerContentHash(offer) } : { offer: null, offerHash: '' };
}

async function defaultSites() {
  const mod = await import('../../data/hub.js');
  return mod.getAllSites();
}

async function defaultProfiles() {
  const mod = await import('../../data/client-portal.js');
  return mod.listClientProfiles();
}

function bankPart(bank) {
  const source = isPlainObject(bank) ? bank : {};
  return {
    businessCard: source.businessCard || null,
    generalInfo: source.generalInfo || null,
    brandIdentity: source.brandIdentity ? { orgNumber: source.brandIdentity.orgNumber || '' } : null,
    websiteCreatorQuestions: source.websiteCreatorQuestions || null,
    productCatalogs: Array.isArray(source.productCatalogs) ? source.productCatalogs : [],
    openingHours: source.openingHours || null,
  };
}

function projectDocumentOf(client) {
  const doc = client?.workshop?.projectDocument;
  return isPlainObject(doc) ? doc : null;
}

function changeRequestsOf(client) {
  const list = Array.isArray(client?.changeRequests) ? client.changeRequests : Array.isArray(client?.ext?.changeRequests) ? client.ext.changeRequests : [];
  return list.filter(isPlainObject).slice(0, 100).map((row) => ({
    id: text(row.id, 80),
    type: text(row.type, 40),
    title: text(row.title, 200),
    status: text(row.status, 40),
  }));
}

function gateOf(client, snapshot) {
  const gate = isPlainObject(snapshot) ? snapshot : isPlainObject(client?.delivery?.gate) ? client.delivery.gate : null;
  if (!gate) return null;
  const lines = Array.isArray(gate.lines) ? gate.lines : [];
  return {
    devComplete: gate.devComplete === true,
    missingDev: (Array.isArray(gate.missingDev) ? gate.missingDev : lines.filter((line) => line?.audience === 'dev' && line?.status !== 'have').map((line) => line?.id))
      .map((id) => text(id, 80))
      .filter(Boolean)
      .slice(0, 40),
    inputHash: text(gate.inputHash, 100),
    lines: lines.slice(0, 40).map((line) => (isPlainObject(line)
      ? { id: text(line.id, 80), status: text(line.status, 40), ...(line.audience ? { audience: text(line.audience, 20) } : {}) }
      : text(line, 120))),
  };
}

function seoFrom(client, keywords) {
  const list = Array.isArray(keywords) ? keywords : Array.isArray(client?.seoRecord?.agreedKeywords) ? client.seoRecord.agreedKeywords : [];
  return {
    agreedKeywords: list.filter(isPlainObject).slice(0, 100).map((row) => ({
      keyword: text(row.keyword, 120),
      status: text(row.status, 40),
      source: text(row.source, 40),
      ...(row.quote ? { quote: text(row.quote, 400) } : {}),
    })).filter((row) => row.keyword),
    revision: text(client?.seoRecord?.revision ?? client?.seoRecord?.rev ?? '', 40),
  };
}

function minimalCmsSetup(hubSite, client) {
  if (!hubSite) return null;
  const approvedAt = text(client?.delivery?.events?.approval?.at);
  return {
    siteId: text(hubSite.id, 80),
    productionDomain: text(hubSite.domain, 253).toLowerCase(),
    seller: { legalName: text(client?.legalName || ''), orgNumber: text(client?.orgNumber || '') },
    approval: { clientApprovedAt: approvedAt },
  };
}

/** A CMS setup without credentials: site keys and tokens never go into a brief. */
function withoutSecrets(setup) {
  if (!isPlainObject(setup)) return null;
  const out = {};
  for (const [key, value] of Object.entries(setup)) {
    if (/key|token|secret|password|credential/i.test(key)) continue;
    out[key] = isPlainObject(value) ? withoutSecrets(value) : value;
  }
  return out;
}

function mediaItems(list) {
  return (Array.isArray(list) ? list : []).filter(isPlainObject).slice(0, 500).map((item) => ({
    id: text(item.id, 120),
    bucket: text(item.bucket, 60),
    fileName: text(item.fileName, 200),
    mime: text(item.mime, 80),
    bytes: Math.max(0, Math.round(Number(item.bytes) || 0)),
    sha256: text(item.sha256, 64),
    url: text(item.url, 2000).replace(/\?.*$/, ''),
    source: text(item.source, 120),
    rightsConfirmed: item.rightsConfirmed === true,
    credit: text(item.credit, 200),
    ...(item.productId ? { productId: text(item.productId, 120) } : {}),
  })).filter((item) => item.id);
}

/**
 * Everything the brief is built from. Returns
 * { clientId, meetings, sitePlan, offer, offerHash, profile, bank, hubSite, projectDocument, gate,
 *   media, seo, cmsSetup, changeRequests, featureKeys, availabilityOf, promptHash, parts, inputHash }.
 */
export async function gatherBriefSources(client, { deps = {}, log = console } = {}) {
  const clientId = text(client?.id);
  const meetings = await readClientTranscripts(client, { deps, log });

  const { activeSitePlan } = await import('../site-plan-model.js');
  const sitePlan = activeSitePlan(client);

  const offerInfo = typeof deps.offer === 'function' ? await safely(() => deps.offer(clientId), { offer: null, offerHash: '' }) : await safely(() => defaultOffer(clientId), { offer: null, offerHash: '' });
  const sites = typeof deps.sites === 'function' ? await safely(() => deps.sites(), []) : await safely(defaultSites, []);
  const profiles = typeof deps.profiles === 'function' ? await safely(() => deps.profiles(), []) : await safely(defaultProfiles, []);
  const hubSite = hubSiteForClient(client, sites);
  const profile = profileForClient(client, profiles);
  const bank = bankPart(profile?.clientDataBank);

  // Optional modules.
  let gateSnapshot = null;
  if (typeof deps.gate === 'function') gateSnapshot = await safely(() => deps.gate(client), null);
  else {
    const mod = await optionalModule('../delivery-gate.js', { log });
    const read = firstFunction(mod, ['readStoredGate', 'gateSnapshotForClient']);
    if (read) gateSnapshot = await safely(() => read(client), null);
  }
  let manifest = [];
  if (typeof deps.mediaManifest === 'function') manifest = await safely(() => deps.mediaManifest(client), []);
  else {
    const mod = await optionalModule('../media-manifest.js', { log });
    const build = firstFunction(mod, ['buildMediaManifest', 'mediaManifestForClient', 'readMediaManifest']);
    if (build) {
      const value = await safely(() => build(client, { sign: false }), []);
      manifest = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.manifest) ? value.manifest : [];
    }
  }
  let keywords = null;
  if (typeof deps.agreedKeywords === 'function') keywords = await safely(() => deps.agreedKeywords(client), null);
  else {
    const mod = await optionalModule('../seo-ops/record.js', { log });
    const read = firstFunction(mod, ['agreedKeywordsFor']);
    if (read) {
      const value = await safely(() => read(client), null);
      keywords = Array.isArray(value) ? value : Array.isArray(value?.keywords) ? value.keywords : null;
    }
  }
  let cmsSetup = null;
  if (typeof deps.cmsSetup === 'function') cmsSetup = await safely(() => deps.cmsSetup(client, { hubSite }), null);
  else {
    const mod = await optionalModule('../cms-setup.js', { log });
    const build = firstFunction(mod, ['buildMakerCmsSetup']);
    if (build) cmsSetup = await safely(() => build(client), null);
  }
  cmsSetup = withoutSecrets(cmsSetup) || minimalCmsSetup(hubSite, client);

  let availabilityOf = typeof deps.availabilityOf === 'function' ? deps.availabilityOf : null;
  if (!availabilityOf && !deps.noFeatureAvailability) {
    const mod = await optionalModule('../feature-availability.js', { log });
    availabilityOf = firstFunction(mod, ['featureAvailability', 'availabilityOf']);
  }
  let featureKeys = Array.isArray(deps.featureKeys) ? deps.featureKeys : null;
  if (!featureKeys) {
    const mod = await safely(() => import('../cms-features.js'), null);
    featureKeys = (mod?.FEATURE_NODES || []).map((node) => text(node?.key)).filter(Boolean);
  }

  const projectDocument = projectDocumentOf(client);
  const changeRequests = changeRequestsOf(client);
  const gate = gateOf(client, gateSnapshot);
  const seo = seoFrom(client, keywords);
  const media = mediaItems(manifest);
  const promptHash = sha256(canonicalJson(['sales', 'demo', 'workshop', 'iteration'].map((purpose) => promptFor(purpose, { featureKeys }).promptHash)));

  const parts = {
    meetings: meetings.map((meeting) => ({ meetingId: meeting.meetingId, purpose: meeting.purpose, sha256: meeting.sha256 })),
    plan: sitePlan ? hashOf({ tierId: sitePlan.tierId, services: sitePlan.services, pages: sitePlan.pages, billing: sitePlan.billing, signedAt: sitePlan.signedAt, catalogType: sitePlan.catalogType, languages: sitePlan.languages }) : '',
    offer: offerInfo.offerHash || '',
    bank: hashOf(bank),
    client: hashOf({
      brandName: client?.brandName || '',
      businessName: client?.businessName || '',
      legalName: client?.legalName || '',
      orgNumber: client?.orgNumber || '',
      language: client?.language || '',
      stage: client?.delivery?.stage || '',
      websiteDueOverride: client?.websiteDueOverride || '',
    }),
    hubSite: hubSite ? hashOf({ id: hubSite.id, domain: hubSite.domain }) : '',
    projectDocument: projectDocument ? hashOf(projectDocument.todos || []) : '',
    gate: gate ? hashOf(gate) : '',
    media: hashOf(media.map((item) => [item.id, item.sha256, item.rightsConfirmed])),
    seo: hashOf(seo),
    cmsSetup: hashOf(cmsSetup),
    changeRequests: hashOf(changeRequests),
    promptHash,
  };
  return {
    clientId,
    meetings,
    sitePlan,
    offer: offerInfo.offer,
    offerHash: offerInfo.offerHash || '',
    profile,
    bank,
    hubSite,
    projectDocument,
    gate,
    media,
    seo,
    cmsSetup,
    changeRequests,
    featureKeys,
    availabilityOf,
    promptHash,
    parts,
    inputHash: hashOf(parts),
  };
}

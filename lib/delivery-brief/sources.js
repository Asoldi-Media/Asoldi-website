/**
 * Inputs of one client's brief, read from the hub stores. Optional parts come from modules a build
 * may not contain; each is imported only when its file exists, and a missing or failing module only
 * leaves its part empty. The calls follow those modules' own signatures:
 *   lib/transcript-archive.js  readArchivedTranscripts(clientId) and readTranscriptBySha(clientId, sha)
 *                              (else the stored Fireflies meetings)
 *   lib/media-manifest.js      buildMediaManifest(clientId, { client, dataDir }) → { items: [{ id, source,
 *                              bucket, name, mime, bytes, sha256, rightsConfirmed, url }] }, called only
 *                              while lib/privacy-settings.js signedMediaEnabled() is on (building the
 *                              manifest writes its id index)
 *   lib/delivery-gate.js       a gate snapshot (else client.delivery.gate)
 *   lib/seo-ops/record.js      readSeoRecord(clientId).agreedKeywords [{ phrase, status, source }], else
 *                              agreedKeywordsFor(clientId) (approved phrases), else client.seoRecord
 *   lib/cms-setup.js           the Maker CMS setup (else a minimal one from the hub site)
 *   lib/feature-availability.js  whether a promised feature is built
 * Every call can pass `deps` to replace any reader (tests and the eval script do), and
 * `deps.modules[<path above, relative to this folder>]` to stand in for one of the optional modules.
 *
 * Live captions are never a transcript: a meeting whose stored Fireflies copy is still live or partial
 * (storedMeetingIsPartial) is left out until the final copy arrives, from the archive as well. Once the
 * stored copy is final, it wins over an archived copy of the same meeting with other text (the archive
 * may still hold the captions it copied at link time, without their live flags, until its next sync).
 *
 * The input hash covers everything the brief shows from these inputs (hashed through the same views
 * the assembler uses), so an unchanged hash means an unchanged brief apart from reviews, which
 * re-assemble on their own.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashOf, isPlainObject, sha256, text } from './text.js';
import { normalizePurpose, promptFor } from './extract.js';
import { offerView, sitePlanView } from './assemble.js';

const optionalCache = new Map();
const mediaMemo = new Map();

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
  mediaMemo.clear();
}

/** An optional module: the stand-in from deps.modules when one is given, else the build's file (or null). */
export async function moduleFor(relative, deps = {}, log = console) {
  if (isPlainObject(deps?.modules) && Object.prototype.hasOwnProperty.call(deps.modules, relative)) return deps.modules[relative] || null;
  return optionalModule(relative, { log });
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

/** True for a copy that is flagged live or partial (it may be live captions, not a final transcript). */
function flaggedPartial(entry) {
  return entry?.isLive === true || entry?.partial === true;
}

/**
 * The stored-meeting reader and the live-caption check (deps.readStoredMeeting / deps.isPartialMeeting
 * replace them). The check is the hub's own storedMeetingIsPartial; it is false for a copy with neither
 * flag, so the Fireflies module is loaded for it only when a stored copy carries one.
 */
async function storedMeetingReaders(deps) {
  let readStored = typeof deps.readStoredMeeting === 'function' ? deps.readStoredMeeting : null;
  if (!readStored) readStored = (await import('../fireflies-webhook.js')).readStoredFirefliesMeeting;
  const given = typeof deps.isPartialMeeting === 'function' ? deps.isPartialMeeting : null;
  const isPartial = async (stored) => {
    if (given) return given(stored) === true;
    if (!flaggedPartial(stored)) return false;
    const mod = await import('../fireflies-webhook.js');
    return typeof mod.storedMeetingIsPartial === 'function' ? mod.storedMeetingIsPartial(stored) === true : true;
  };
  return { readStored, isPartial };
}

/**
 * [{ meetingId, purpose, startedAt, title, transcript, sha256, chars }] for the client's linked
 * meetings that have a final transcript, oldest first. A meeting whose stored copy is still live
 * captions (or partial without a final summary) is left out, also when the archive has a copy. When the
 * stored copy is final and its text differs from the archived copy's, the stored copy is used.
 */
export async function readClientTranscripts(client, { deps = {}, log } = {}) {
  const clientId = text(client?.id);
  const rows = meetingRows(client);
  const byId = new Map();
  let archived = [];
  if (typeof deps.readArchivedTranscripts === 'function') {
    archived = await safely(() => deps.readArchivedTranscripts(clientId), []);
  } else {
    const mod = await moduleFor('../transcript-archive.js', deps, log);
    const read = firstFunction(mod, ['readArchivedTranscripts']);
    if (read) archived = await safely(() => read(clientId), []);
  }
  const { readStored, isPartial } = await storedMeetingReaders(deps);
  const storedById = new Map();
  const storedOf = async (meetingId) => {
    if (!storedById.has(meetingId)) storedById.set(meetingId, await safely(() => readStored(meetingId), null));
    return storedById.get(meetingId);
  };
  const live = async (meetingId) => {
    const stored = await storedOf(meetingId);
    if (!stored) return false;
    return (await safely(() => isPartial(stored), false)) === true;
  };
  for (const entry of Array.isArray(archived) ? archived : []) {
    const transcript = String(entry?.transcript ?? '');
    const meetingId = text(entry?.meetingId);
    if (!meetingId || !transcript.trim() || flaggedPartial(entry)) continue;
    if (meetingId.toLowerCase().startsWith('live:') || (await live(meetingId))) continue;
    const row = rows.find((item) => text(item.meetingId) === meetingId);
    // Not live (checked above): a stored copy with other text is the final one and replaces the archived copy.
    const stored = await storedOf(meetingId);
    const storedText = String(stored?.transcript ?? '');
    const final = storedText.trim() && sha256(storedText) !== sha256(transcript) ? storedText : transcript;
    byId.set(meetingId, {
      meetingId,
      purpose: normalizePurpose(entry.purpose || purposeOf(row)),
      startedAt: text(entry.startedAt || row?.startedAt || stored?.startedAt),
      title: text(entry.title || row?.title || stored?.title, 200),
      transcript: final,
    });
  }
  for (const row of rows) {
    const meetingId = text(row.meetingId);
    if (byId.has(meetingId)) continue;
    const stored = await storedOf(meetingId);
    const transcript = String(stored?.transcript ?? '');
    if (!transcript.trim() || (await live(meetingId))) continue;
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

/**
 * The transcript with this sha256 among the client's meetings, or null. A copy that is live captions
 * (flagged, or its meeting's stored copy is still partial) is never served, nor an archived copy whose
 * meeting now has a final stored copy with other text (that copy is the meeting's transcript).
 */
export async function findClientTranscript(client, sha, { deps = {}, log } = {}) {
  const wanted = text(sha).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) return null;
  let found = null;
  if (typeof deps.readTranscriptBySha === 'function') {
    found = await safely(() => deps.readTranscriptBySha(text(client?.id), wanted), null);
  } else {
    const mod = await moduleFor('../transcript-archive.js', deps, log);
    const read = firstFunction(mod, ['readTranscriptBySha']);
    if (read) found = await safely(() => read(text(client?.id), wanted), null);
  }
  if (found && String(found.transcript ?? '').trim() && !flaggedPartial(found)) {
    const meetingId = text(found.meetingId);
    const { readStored, isPartial } = await storedMeetingReaders(deps);
    const stored = meetingId ? await safely(() => readStored(meetingId), null) : null;
    const partial = stored ? (await safely(() => isPartial(stored), false)) === true : false;
    const storedText = String(stored?.transcript ?? '');
    const superseded = Boolean(storedText.trim()) && sha256(storedText) !== wanted;
    if (!partial && !superseded) {
      return { meetingId, purpose: normalizePurpose(found.purpose), startedAt: text(found.startedAt), sha256: wanted, transcript: String(found.transcript) };
    }
    return null;
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

export async function loadHubSites() {
  const mod = await import('../../data/hub.js');
  return mod.getAllSites();
}

export async function loadClientProfiles() {
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

/** The keyword statuses the brief carries: agreed and blocked, as the SEO record's Maker view has them (not proposals). */
export const BRIEF_KEYWORD_STATUSES = Object.freeze(['approved', 'blocked']);

/** Agreed keyword rows: { keyword } or the SEO record's { phrase }, with status and source; approved and blocked rows only. */
function seoFrom(client, keywords) {
  const fromRecord = Array.isArray(keywords);
  const list = fromRecord ? keywords : Array.isArray(client?.seoRecord?.agreedKeywords) ? client.seoRecord.agreedKeywords : [];
  return {
    agreedKeywords: list.filter((row) => isPlainObject(row) && BRIEF_KEYWORD_STATUSES.includes(text(row.status))).slice(0, 100).map((row) => ({
      keyword: text(row.keyword || row.phrase, 120),
      status: text(row.status, 40),
      source: text(row.source, 40),
      ...(typeof row.quote === 'string' && row.quote.trim() ? { quote: text(row.quote, 400) } : {}),
    })).filter((row) => row.keyword),
    revision: fromRecord ? '' : text(client?.seoRecord?.revision ?? client?.seoRecord?.rev ?? '', 40),
  };
}

/**
 * The client's agreed keywords from the SEO record module: the rows of readSeoRecord(clientId)
 * ({ phrase, status, source }; seoFrom keeps the approved and blocked ones), else the approved phrases
 * of agreedKeywordsFor(clientId). null when the build has neither or the client has no record (the
 * sales card's seoRecord is used then).
 */
async function readAgreedKeywords(client, { deps, log }) {
  if (typeof deps.agreedKeywords === 'function') return safely(() => deps.agreedKeywords(client), null);
  const mod = await moduleFor('../seo-ops/record.js', deps, log);
  const clientId = text(client?.id);
  if (!mod || !clientId) return null;
  if (typeof mod.readSeoRecord === 'function') {
    const record = await safely(() => mod.readSeoRecord(clientId), null);
    if (isPlainObject(record)) return Array.isArray(record.agreedKeywords) ? record.agreedKeywords : [];
    if (typeof mod.agreedKeywordsFor !== 'function') return null;
  }
  if (typeof mod.agreedKeywordsFor === 'function') {
    const phrases = await safely(() => mod.agreedKeywordsFor(clientId), null);
    if (!Array.isArray(phrases) || !phrases.length) return null;
    return phrases
      .map((phrase) => (typeof phrase === 'string' ? { keyword: phrase, status: 'approved', source: 'seo-record' } : phrase))
      .filter(isPlainObject);
  }
  return null;
}

/**
 * The client's media rows from the build's media manifest. The manifest signs URLs and writes its id
 * index, so it is built only while the media switch (signedMediaEnabled) is on; otherwise the brief
 * lists no media. deps.mediaCacheMs keeps one build per client for that long (the loop passes it, so a
 * tick does not hash every file of every client again).
 */
async function readMediaManifest(client, { deps, log }) {
  if (typeof deps.mediaManifest === 'function') return safely(() => deps.mediaManifest(client), []);
  const mod = await moduleFor('../media-manifest.js', deps, log);
  if (typeof mod?.buildMediaManifest !== 'function') return [];
  const privacy = await moduleFor('../privacy-settings.js', deps, log);
  if (typeof privacy?.signedMediaEnabled !== 'function') return [];
  const settings = isPlainObject(deps.settings) ? deps.settings : undefined;
  if ((await safely(() => privacy.signedMediaEnabled(settings), false)) !== true) return [];
  const clientId = text(client?.id);
  if (!clientId) return [];
  const memoMs = Math.max(0, Number(deps.mediaCacheMs) || 0);
  const memoKey = `${deps.dataDir || ''}\u0001${clientId}`;
  const nowMs = Date.now();
  if (memoMs && mediaMemo.has(memoKey) && nowMs - mediaMemo.get(memoKey).at < memoMs) return mediaMemo.get(memoKey).items;
  const value = await safely(() => mod.buildMediaManifest(clientId, { client, ...(deps.dataDir ? { dataDir: deps.dataDir } : {}) }), null);
  const items = Array.isArray(value?.items) ? value.items : [];
  if (memoMs) mediaMemo.set(memoKey, { at: nowMs, items });
  return items;
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

// Credential field names. A bare `key` (a feature's id), `keywords` or `primaryKey` is not one; a key
// named for what it opens (apiKey, siteKey, secret_key, x-api-key, privateKey, ...) is.
const SECRET_WORD_RE = /token|secret|password|passwd|credential|authorization|bearer/;
const SECRET_KEY_NAME_RE = /(?:^|_)(?:api|site|secret|private|access|client|signing|encryption|hmac|license|licence|master|service|auth|webhook)_?keys?$/;
const SECRET_SHORT_RE = /(?:^|_)(?:pass|pwd)$/;

/** True for a field name that holds a credential (camelCase, snake_case and kebab-case alike). */
export function isSecretFieldName(name) {
  const words = String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/-/g, '_');
  return SECRET_WORD_RE.test(words) || SECRET_KEY_NAME_RE.test(words) || SECRET_SHORT_RE.test(words);
}

/** A value without credentials, at every depth (objects inside lists too). */
function scrubbed(value) {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key)) continue;
    out[key] = scrubbed(child);
  }
  return out;
}

/** A CMS setup without credentials: site keys and tokens never go into a brief. */
export function withoutSecrets(setup) {
  return isPlainObject(setup) ? scrubbed(setup) : null;
}

/**
 * Media rows as the brief shows them; the manifest's `name` is the file name, and URL signatures are
 * left out. rightsConfirmed is true or false as the client answered, and absent while unanswered.
 */
function mediaItems(list) {
  return (Array.isArray(list) ? list : []).filter(isPlainObject).slice(0, 500).map((item) => ({
    id: text(item.id, 120),
    bucket: text(item.bucket, 60),
    fileName: text(item.fileName || item.name, 200),
    mime: text(item.mime, 80),
    bytes: Math.max(0, Math.round(Number(item.bytes) || 0)),
    sha256: text(item.sha256, 64),
    url: text(item.url, 2000).replace(/\?.*$/, ''),
    source: text(item.source, 120),
    ...(typeof item.rightsConfirmed === 'boolean' ? { rightsConfirmed: item.rightsConfirmed } : {}),
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
  const sites = typeof deps.sites === 'function' ? await safely(() => deps.sites(), []) : await safely(loadHubSites, []);
  const profiles = typeof deps.profiles === 'function' ? await safely(() => deps.profiles(), []) : await safely(loadClientProfiles, []);
  const hubSite = hubSiteForClient(client, sites);
  const profile = profileForClient(client, profiles);
  const bank = bankPart(profile?.clientDataBank);

  // Optional modules.
  let gateSnapshot = null;
  if (typeof deps.gate === 'function') gateSnapshot = await safely(() => deps.gate(client), null);
  else {
    const mod = await moduleFor('../delivery-gate.js', deps, log);
    const read = firstFunction(mod, ['readStoredGate', 'gateSnapshotForClient']);
    if (read) gateSnapshot = await safely(() => read(client), null);
  }
  const manifest = await readMediaManifest(client, { deps, log });
  const keywords = await readAgreedKeywords(client, { deps, log });
  let cmsSetup = null;
  if (typeof deps.cmsSetup === 'function') cmsSetup = await safely(() => deps.cmsSetup(client, { hubSite }), null);
  else {
    const mod = await moduleFor('../cms-setup.js', deps, log);
    const build = firstFunction(mod, ['buildMakerCmsSetup']);
    if (build) cmsSetup = await safely(() => build(client), null);
  }
  cmsSetup = withoutSecrets(cmsSetup) || minimalCmsSetup(hubSite, client);

  let availabilityOf = typeof deps.availabilityOf === 'function' ? deps.availabilityOf : null;
  if (!availabilityOf && !deps.noFeatureAvailability) {
    const mod = await moduleFor('../feature-availability.js', deps, log);
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

  // Every part hashes what the brief shows from it (the same projections assemble.js uses), so a
  // change to anything visible in the brief changes the input hash.
  const featureState = typeof availabilityOf === 'function'
    ? featureKeys.map((key) => {
      try {
        return [key, text(availabilityOf(key), 20)];
      } catch {
        return [key, ''];
      }
    })
    : [];
  const parts = {
    meetings: meetings.map((meeting) => ({ meetingId: meeting.meetingId, purpose: meeting.purpose, sha256: meeting.sha256 })),
    plan: sitePlan ? hashOf({ view: sitePlanView(sitePlan), offerId: text(sitePlan.offerId) }) : '',
    offer: offerInfo.offer || offerInfo.offerHash ? hashOf({ content: offerInfo.offerHash || '', view: offerView(offerInfo.offer, sitePlan) }) : '',
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
    media: hashOf(media),
    seo: hashOf(seo),
    cmsSetup: hashOf(cmsSetup),
    changeRequests: hashOf(changeRequests),
    features: featureState.length ? hashOf(featureState) : '',
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

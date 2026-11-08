import * as clientPortal from '../../data/client-portal.js';
import { getAutomationSettings } from '../../data/automation-settings.js';
import { getOfferForClient } from '../../data/sales-offers.js';
import { getSalesClientById, getSalesClients } from '../../data/sales.js';
import { appendDeliveryAudit } from '../delivery-audit.js';
import { pageKindsForClient } from '../page-kind-requirements.js';
import { expandServices } from '../../packages/suite/core/delivery/vocab.js';
import { agreedKeywordsFor, proposeAgreedKeywords } from '../seo-ops/record.js';
import { activeSitePlan } from '../site-plan-model.js';
import { spineModeForClient } from '../spine-mode.js';
import { PRODUCT_IMPORT_CAP, capCatalogsToProductLimit, mergeImportedCatalogs, summarizeCatalogs } from '../client-product-catalog.js';
import { applyMakerBundleToPortal } from '../maker-bundle-sync.js';
import { runProductAssistantTurn, buildOpeningState, extractFirstUrl } from './chat.js';
import { applyNoteToBank, interpretLooseNote, noteHasChanges } from './gather.js';
import {
  INTAKE_STEPS,
  PLAN_STEPS,
  awaitingMore,
  businessLabel,
  chapterHasContent,
  doneMessage,
  hasAffiliations,
  hasListedTeam,
  isAffirmativeOnly,
  isDecline,
  isNoMore,
  isPlanSkip,
  mediaFileCount,
  moreQuestion,
  navigationTarget,
  nextIntakeStep,
  parseAffiliationsAnswer,
  parseAreaAnswer,
  parseBookingAnswer,
  parseKeywordAnswer,
  parseOpeningHoursAnswer,
  parseShopAnswer,
  parseStaffAnswer,
  planStepComplete,
  planStepsFor,
  planSubStep,
  promptFor,
  questionFor,
  shopPartNamed,
  sideWrite,
  websiteHost,
  withIntakeFlag,
} from './intake.js';
import { createAssistantJob, getAssistantJob, publicJobView, updateAssistantJob } from './jobs.js';
import { ingestProductSources, shouldIngestSources } from './products-ingest.js';
import { isMediaAssetSource, partitionAssistantFiles, sniffSourceKind } from './source-kind.js';
import { appendMediaToBank, saveClientUploadBuffer } from '../client-media-store.js';
import { expandContainerFiles } from './unpack-files.js';
import {
  briefFromTranscript,
  placementFromTranscript,
  transcribeClientMedia,
  transcriptContextFromBank,
  withMediaBrief,
} from './media-transcript.js';

function bankOf(userId) {
  return clientPortal.getClientProfileByUserId(userId)?.clientDataBank || {};
}

/**
 * The sales client of a portal user (the Maker link on the profile, else the sales client connected to
 * this portal user), or ''. Only for the ledger rows of the assistant's AI calls.
 */
export function salesClientIdOf(userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  try {
    const linked = String(clientPortal.getClientProfileByUserId(id)?.makerLink?.salesClientId || '').trim();
    if (linked) return linked;
    return String(getSalesClients().find((client) => String(client?.portalUserId || '').trim() === id)?.id || '');
  } catch {
    return '';
  }
}

function persistCatalogs(userId, catalogs) {
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  const incoming = capCatalogsToProductLimit(catalogs, PRODUCT_IMPORT_CAP);
  const merged = mergeImportedCatalogs(current.productCatalogs || [], incoming.catalogs);
  const profile = clientPortal.setClientDataBank(userId, {
    ...current,
    productCatalogs: merged,
  }, { businessId: profileNow?.businessId });
  return {
    profile,
    catalogs: profile?.clientDataBank?.productCatalogs || merged,
    truncated: incoming.truncated,
    dropped: incoming.dropped,
  };
}

function makerCandidateUrls(profile) {
  const raw = [
    profile?.clientDataBank?.makerLink?.tunnelUrl,
    globalThis.__asoldiMakerTunnelUrl,
    process.env.WEBSITE_MAKER_BASE_URL,
    process.env.WEBSITE_MAKER_URL,
    process.env.WEBSITE_MAKER_LOCAL_URL,
    'http://localhost:3000',
  ];
  const seen = new Set();
  const urls = [];
  for (const value of raw) {
    const url = String(value || '').trim().replace(/\/$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function pullMakerBundleForProfile(profile) {
  const queries = [];
  const bundleId = String(profile?.clientDataBank?.makerLink?.bundleId || '').trim();
  const email = String(profile?.email || profile?.clientDataBank?.generalInfo?.companyEmail || profile?.clientDataBank?.makerLink?.email || '').trim().toLowerCase();
  if (bundleId) queries.push(`id=${encodeURIComponent(bundleId)}`);
  if (email) queries.push(`email=${encodeURIComponent(email)}`);
  if (!queries.length) return null;
  for (const base of makerCandidateUrls(profile)) {
    for (const query of queries) {
      try {
        const response = await fetch(`${base}/api/client-bundles?${query}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => ({}));
        if (payload.client) return payload.client;
      } catch {
        // try next Maker URL (local, LAN, or public tunnel)
      }
    }
  }
  return null;
}

function firstProductNames(catalogs = [], limit = 5) {
  const names = [];
  for (const catalog of catalogs || []) {
    for (const category of catalog.categories || []) {
      for (const product of category.products || []) {
        const title = String(product.title || product.name || '').replace(/\s+/g, ' ').trim();
        if (!title || names.includes(title)) continue;
        names.push(title);
        if (names.length >= limit) return names;
      }
    }
  }
  return names;
}

function uniqueUrls(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function roleForFile(file, buckets = {}) {
  const name = String(file.originalName || file.name || file.fileName || '');
  if (buckets[name]) return buckets[name];
  const lower = name.toLowerCase();
  const hit = Object.keys(buckets).find((key) => String(key).toLowerCase() === lower);
  if (hit) return buckets[hit];
  const values = Object.values(buckets);
  if (values.length === 1) return values[0];
  return {};
}

/**
 * Files one upload with its Gemini brief. A bucket the client named wins; a `weak` role
 * (file-name guess) only applies when there is no brief.
 */
export function placeMediaInBank(bank, { url, transcript = null, role = {} } = {}) {
  const named = role.bucket && role.bucket !== 'uncategorized' && !(role.weak && transcript);
  const fromBrief = transcript ? placementFromTranscript(transcript) : { bucket: role.bucket || 'uncategorized', isLogo: Boolean(role.isLogo), favicon: false };
  const bucket = named ? role.bucket : fromBrief.bucket;
  const isLogo = named ? Boolean(role.isLogo) || role.bucket === 'logos' : fromBrief.isLogo;
  let next = appendMediaToBank(bank, { url, bucket, isLogo });
  if (fromBrief.favicon && !named && !next?.brandIdentity?.logos?.favicon) {
    next = { ...next, brandIdentity: { ...(next.brandIdentity || {}), logos: { ...(next.brandIdentity?.logos || {}), favicon: url } } };
  }
  if (transcript) next = withMediaBrief(next, briefFromTranscript(transcript, { url }));
  return { bank: next, bucket, isLogo };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

export async function persistMediaFiles(userId, files = [], { buckets = {}, text = '', prefix = 'assistant', transcribe = transcribeClientMedia } = {}) {
  let map = { ...(buckets && typeof buckets === 'object' ? buckets : {}) };
  const salesClientId = salesClientIdOf(userId);
  if (text) {
    const note = await interpretLooseNote(text, bankOf(userId), { salesClientId });
    for (const row of note?.mediaFiles || []) {
      if (!row.fileName) continue;
      map[row.fileName] = { bucket: row.bucket, isLogo: row.isLogo };
    }
  }
  const media = files
    .map((file) => ({ file, name: file.originalName || file.name || 'media' }))
    .filter(({ file, name }) => file.buffer && isMediaAssetSource({ ...file, fileName: name }));
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  if (!media.length) return { urls: [], placed: [], productFiles: [], profile: profileNow };
  const context = transcriptContextFromBank(bankOf(userId));
  const transcripts = await mapLimit(media, 3, ({ file, name }) => transcribe({ buffer: file.buffer, fileName: name, context, salesClientId }).catch(() => null));
  const urls = [];
  const placed = [];
  const productFiles = [];
  let current = bankOf(userId);
  for (const [index, { file, name }] of media.entries()) {
    const saved = await saveClientUploadBuffer(userId, {
      buffer: file.buffer,
      originalName: name,
      prefix: prefix || 'assistant',
    });
    urls.push(saved.url);
    const transcript = transcripts[index];
    const result = placeMediaInBank(current, { url: saved.url, transcript, role: roleForFile({ originalName: name }, map) });
    current = result.bank;
    placed.push({ fileName: name, url: saved.url, bucket: result.bucket, isLogo: result.isLogo, transcribed: Boolean(transcript), productInfo: Boolean(transcript?.productInfo) });
    if (transcript?.productInfo) productFiles.push(file);
  }
  const profile = clientPortal.setClientDataBank(userId, current, { businessId: profileNow?.businessId });
  return { urls, placed, productFiles, profile };
}

/**
 * Brief for a file the client uploaded in Kundedata → Media. The page places the url itself
 * (it saves the whole bank), so this stores only the brief + extracted products and returns them.
 */
export async function categorizeClientUpload(userId, { url, buffer, originalName = '', mimeType = '', transcribe = transcribeClientMedia } = {}) {
  const transcript = await transcribe({ buffer, fileName: originalName, context: transcriptContextFromBank(bankOf(userId)), salesClientId: salesClientIdOf(userId) });
  if (!transcript) return null;
  const brief = briefFromTranscript(transcript, { url });
  patchClientBank(userId, withMediaBrief(bankOf(userId), brief));
  let productCatalogs = null;
  if (transcript.productInfo) {
    productCatalogs = (await ingestSourcesIntoBank(userId, { files: [{ originalName, name: originalName, buffer, mimeType }] })).catalogs;
  }
  return { brief, placement: placementFromTranscript(transcript), productCatalogs };
}

export async function ingestSourcesIntoBank(userId, { files = [], text = '' } = {}) {
  const bank = bankOf(userId);
  const result = await ingestProductSources({
    files,
    text,
    industry: bank?.businessCard?.industry || '',
    layoutHint: summarizeCatalogs(bank.productCatalogs || []).layout || '',
    businessName: bank?.businessCard?.companyName || '',
    existingCatalogs: bank.productCatalogs || [],
    salesClientId: salesClientIdOf(userId),
  });
  return persistCatalogs(userId, result.catalogs);
}

function formatIngestDoneMessage({
  catalogs = [],
  mediaCount = 0,
  documentCount = 0,
  truncated = false,
  dropped = 0,
} = {}) {
  const summary = summarizeCatalogs(catalogs);
  const names = firstProductNames(catalogs);
  const sample = names.length ? ` Blant annet ${names.join(', ')}.` : '';
  const capBit = truncated
    ? ` Jeg stoppet på ${PRODUCT_IMPORT_CAP} produkter${dropped ? ` (hoppet over ${dropped})` : ''}. Større kataloger lastes inn uten AI.`
    : '';
  const mediaBit = mediaCount
    ? ` ${mediaCount === 1 ? '1 bilde/video er lagt i mediabiblioteket.' : `${mediaCount} bilder/video er lagt i mediabiblioteket.`}`
    : '';
  if (!summary.productCount && mediaCount && !documentCount) {
    return `Jeg har lagt inn ${mediaCount === 1 ? 'bildet/videoen' : `${mediaCount} mediafiler`} i biblioteket.`;
  }
  if (!summary.productCount) {
    return 'Jeg fant ingen produkter i det du sendte. Last opp et dokument, eller skriv listen her.';
  }
  const catWord = summary.categoryCount === 1 ? 'kategori' : 'kategorier';
  return `Ferdig. Jeg har lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}${mediaBit}${capBit}`;
}

function startingIngestMessage({ files = [] } = {}) {
  const parts = partitionAssistantFiles(files);
  if (parts.documents.length && parts.media.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst, og lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} separat.`;
  }
  if (parts.documents.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst — ikke som bilde — og bygger katalogen.`;
  }
  if (parts.media.length) {
    return `Jeg lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} og sjekker om det også er en synlig prisliste der.`;
  }
  if (files.length) {
    return 'Jeg leser filene og det du skrev, og bygger én produktkatalog.';
  }
  return 'Jeg leser teksten og legger produktene inn i katalogen.';
}

function catalogFingerprint(catalogs = []) {
  return summarizeCatalogs(catalogs).categories
    .map((category) => `${category.name}:${category.productCount}`)
    .join('|');
}

function reconcileStoredCatalogs(userId, profile) {
  const current = profile?.clientDataBank?.productCatalogs || [];
  if (!current.length) return profile;
  const cleaned = mergeImportedCatalogs(current, []);
  if (catalogFingerprint(current) === catalogFingerprint(cleaned)) return profile;
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, {
    ...(profile?.clientDataBank || {}),
    productCatalogs: cleaned,
  }, { businessId: profileNow?.businessId || profile?.businessId }) || profile;
}

const intakeStepNotes = new Map();
const AREA_SCOPES = ['local', 'regional', 'niche-b2b', '', 'unknown'];

function withIntakeSteps(payload, ctx) {
  if (!ctx?.steps?.length || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return { ...payload, intakeSteps: [...INTAKE_STEPS, ...ctx.steps] };
}

function allowedIntakeSteps(ctx) {
  return ctx?.steps?.length ? [...INTAKE_STEPS, ...ctx.steps] : INTAKE_STEPS;
}

/**
 * Plan steps for one portal user, or null when the assistant should stay on the six base steps.
 * The switch is read before anything else. Shadow and paused note the steps once and show nothing new.
 * @param {string} userId
 * @param {{ settings?: object, dataDir?: string }} [options]
 */
export async function planIntakeContext(userId, { settings, dataDir } = {}) {
  const resolved = settings || getAutomationSettings({ dataDir });
  if (resolved?.intake?.tierSteps?.enabled !== true) return null;
  const salesClientId = salesClientIdOf(userId);
  if (!salesClientId) return null;
  const client = getSalesClientById(salesClientId);
  if (!client) return null;
  let mode = 'off';
  try {
    mode = spineModeForClient('intake.tierSteps', client, { settings: resolved, dataDir });
  } catch {
    mode = 'off';
  }
  if (mode === 'off') return null;
  const plan = activeSitePlan(client);
  if (!plan) return null;
  const profile = clientPortal.getClientProfileByUserId(userId) || {};
  const bank = profile.clientDataBank || {};
  let offer = null;
  try {
    offer = getOfferForClient(client.id);
  } catch {
    offer = null;
  }
  const pageKinds = pageKindsForClient({ materials: client.makerRun?.materials, offer, bank }).list.map((row) => row.kind);
  const steps = planStepsFor({ services: expandServices(plan.services), pageKinds });
  if (!steps.length) return null;
  if (mode === 'shadow' || mode === 'paused') {
    const joined = steps.join(',');
    if (intakeStepNotes.get(client.id) !== joined) {
      intakeStepNotes.set(client.id, joined);
      appendDeliveryAudit({ kind: 'intake-steps', clientId: client.id, mode, steps }, { dataDir });
    }
    return null;
  }
  if (mode !== 'auto') return null;
  const offerName = offer?.client?.businessName || offer?.partyName || '';
  let approvedKeywords = 0;
  try {
    approvedKeywords = agreedKeywordsFor(client.id).length;
  } catch {
    approvedKeywords = 0;
  }
  const scope = String(client.seo?.scope || '').trim().toLowerCase();
  return {
    steps,
    clientId: client.id,
    brandName: client.brandName || profile.businessName || bank.businessCard?.companyName || client.businessName || '',
    seller: {
      orgNumber: bank.brandIdentity?.orgNumber || client.orgNumber || client.organizationNumber || '',
      legalName: client.legalName || offerName || '',
    },
    city: bank.websiteCreatorQuestions?.town || profile.onboarding?.city || profile.onboarding?.town || client.city || '',
    needsArea: AREA_SCOPES.includes(scope),
    approvedKeywords,
    websiteUrl: bank.generalInfo?.websiteUrl || '',
  };
}

export async function getAssistantState(userId, ctx) {
  const context = ctx === undefined ? await planIntakeContext(userId) : ctx;
  let profile = clientPortal.getClientProfileByUserId(userId);
  const bundle = await pullMakerBundleForProfile(profile);
  if (bundle) {
    const applied = applyMakerBundleToPortal({
      portalUserId: userId,
      email: profile?.email,
      businessId: profile?.businessId,
      bundle,
    });
    if (applied.ok) profile = applied.profile;
  }
  profile = reconcileStoredCatalogs(userId, profile);
  return withIntakeSteps({
    profile,
    ...buildOpeningState(profile || {}, context),
    summary: summarizeCatalogs(profile?.clientDataBank?.productCatalogs || []),
    makerLinked: Boolean(profile?.clientDataBank?.makerLink?.bundleId),
  }, context);
}

export function getJobForUser(jobId, userId) {
  const job = getAssistantJob(jobId, userId);
  if (!job) return null;
  const profile = clientPortal.getClientProfileByUserId(userId);
  return {
    ...publicJobView(job),
    profile,
    catalogs: job.catalogs || (job.catalog ? [job.catalog] : []),
    summary: summarizeCatalogs(job.catalogs || (job.catalog ? [job.catalog] : profile?.clientDataBank?.productCatalogs || [])),
  };
}

async function runUnifiedIngestJob(jobId, userId, { files = [], text = '' } = {}) {
  updateAssistantJob(jobId, { status: 'running', progress: { step: 'starting', message: 'Leser alle kilder sammen…' } });
  try {
    const bank = bankOf(userId);
    const split = partitionAssistantFiles(files);
    if (split.media.length) {
      updateAssistantJob(jobId, { progress: { step: 'media', message: 'Lagrer bilder og video…' } });
    }
    const mediaSaved = await persistMediaFiles(userId, split.media, { text });
    const unread = new Set(mediaSaved.placed.filter((row) => !row.transcribed).map((row) => row.fileName));
    const result = await ingestProductSources({
      files: [
        ...split.documents,
        ...mediaSaved.productFiles,
        ...split.media.filter((file) => unread.has(file.originalName || file.name || 'media')),
      ],
      text,
      industry: bank?.businessCard?.industry || '',
      layoutHint: summarizeCatalogs(bank.productCatalogs || []).layout || '',
      businessName: bank?.businessCard?.companyName || '',
      existingCatalogs: bank.productCatalogs || [],
      onProgress: (progress) => updateAssistantJob(jobId, { progress }),
      salesClientId: salesClientIdOf(userId),
    });
    const saved = persistCatalogs(userId, result.catalogs);
    const summary = summarizeCatalogs(saved.catalogs);
    let assistantMessage = formatIngestDoneMessage({
      catalogs: saved.catalogs,
      mediaCount: mediaSaved.urls.length,
      documentCount: split.documents.length,
      truncated: Boolean(saved.truncated || result.truncated),
      dropped: Number(saved.dropped || result.dropped || 0),
    });
    let currentStep = 'products';
    if (mediaSaved.urls.length) saveIntakeFlag(userId, 'media', 'more');
    if (summary.productCount) {
      const profile = saveIntakeFlag(userId, 'products', 'more');
      const name = businessLabel(profile?.clientDataBank || {}, profile);
      const follow = moreQuestion('products', name);
      if (follow && !assistantMessage.includes(follow)) assistantMessage = `${assistantMessage}\n\n${follow}`;
      currentStep = 'products';
    }
    updateAssistantJob(jobId, {
      status: 'done',
      catalog: saved.catalogs[0] || null,
      catalogs: saved.catalogs,
      assistantMessage,
      redirectTo: '',
      currentStep,
      nextAction: 'wait',
      progress: {
        step: 'done',
        message: assistantMessage,
        found: summary.productCount,
      },
    });
  } catch (error) {
    updateAssistantJob(jobId, {
      status: 'failed',
      error: error?.message || 'Klarte ikke å lese kildene.',
    });
  }
}

function saveIntakeFlag(userId, step, status) {
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  let next = withIntakeFlag(current, step, status);
  if (status === 'done' || status === 'skipped') {
    next = {
      ...next,
      assistantIntake: { ...(next.assistantIntake || {}), focus: '' },
    };
  }
  return clientPortal.setClientDataBank(userId, next, {
    businessId: profileNow?.businessId,
  });
}

function setAssistantFocus(userId, step, ctx = null) {
  const current = bankOf(userId);
  const focus = allowedIntakeSteps(ctx).includes(step) ? step : '';
  return patchClientBank(userId, {
    ...current,
    assistantIntake: { ...(current.assistantIntake || {}), focus },
  });
}

function patchClientBank(userId, nextBank) {
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, nextBank, { businessId: profileNow?.businessId });
}

function replyAfter(userId, profile, prefix = '', { revisit = false, ctx = null } = {}) {
  const bank = profile?.clientDataBank || bankOf(userId);
  const name = businessLabel(bank, profile);
  const step = ctx ? nextIntakeStep(bank, ctx) : nextIntakeStep(bank);
  const follow = ctx ? promptFor(step, name, bank, { revisit, ctx }) : promptFor(step, name, bank, { revisit });
  return {
    assistantMessage: [prefix, follow].filter(Boolean).join('\n\n'),
    nextAction: step === 'done' ? 'done' : 'wait',
    redirectTo: '',
    currentStep: step,
    composer: step === 'hours' ? 'hours' : '',
    profile,
    summary: summarizeCatalogs(bank.productCatalogs || []),
  };
}

function openChapter(userId, step, ctx = null) {
  const profile = setAssistantFocus(userId, step, ctx);
  const bank = profile?.clientDataBank || {};
  return replyAfter(userId, profile, '', { revisit: chapterHasContent(bank, step), ctx });
}

function chatEnvelope(state, extra = {}, ctx = null) {
  const bank = state.profile?.clientDataBank || {};
  const currentStep = extra.currentStep || (ctx ? nextIntakeStep(bank, ctx) : nextIntakeStep(bank));
  return {
    profile: state.profile,
    summary: state.summary,
    ...extra,
    currentStep,
    composer: extra.composer ?? (currentStep === 'hours' ? 'hours' : ''),
  };
}

function beginIngest(userId, state, { files = [], text = '', layout = '' } = {}) {
  const job = createAssistantJob(userId, 'ingest');
  setTimeout(() => {
    void runUnifiedIngestJob(job.id, userId, { files, text });
  }, 10);
  return {
    assistantMessage: startingIngestMessage({ files, text }),
    nextAction: 'ingest',
    jobId: job.id,
    layout,
    profile: state.profile,
    summary: state.summary,
  };
}

function commitSideWrite(userId, diverted, ctx = null) {
  const current = bankOf(userId);
  if (diverted.kind === 'hours') {
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      openingHours: {
        ...(current.openingHours || {}),
        status: diverted.parsed.status,
        days: diverted.parsed.days,
      },
    }, 'hours', 'done'));
    const prefix = diverted.parsed.status === 'always'
      ? 'Jeg satte dere som åpne hele tiden.'
      : diverted.parsed.status === 'not-relevant'
        ? 'Jeg merket åpningstider som ikke relevant.'
        : 'Åpningstidene er lagret.';
    return replyAfter(userId, profile, prefix, { ctx });
  }
  if (diverted.kind === 'staff') {
    const staff = [...(current.staff || [])];
    for (const person of diverted.parsed.people) {
      staff.push({
        id: '',
        title: person.title,
        name: person.name,
        phone: person.phone,
        email: person.email,
        imageUrl: '',
      });
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, staff }, 'staff', 'more'));
    const count = diverted.parsed.people.length;
    return replyAfter(userId, profile, count === 1 ? 'Personen er med.' : `${count} personer er med.`, { ctx });
  }
  if (diverted.kind === 'affiliations') {
    const affiliations = [...(current.affiliations || [])];
    for (const category of diverted.parsed.categories) {
      const hit = affiliations.find((row) => String(row.categoryName || '').toLowerCase() === category.categoryName.toLowerCase());
      if (hit) hit.items = [...(hit.items || []), ...category.items];
      else affiliations.push(category);
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, affiliations }, 'affiliations', 'more'));
    return replyAfter(userId, profile, 'Partnerne er med.', { ctx });
  }
  return null;
}

async function tryLoose(userId, text, ctx = null) {
  const bank = bankOf(userId);
  const note = await interpretLooseNote(text, bank, { salesClientId: salesClientIdOf(userId) });
  if (!note) return null;
  const next = applyNoteToBank(bank, note);
  let flagged = next;
  if (note.hoursText && next.openingHours?.status) flagged = withIntakeFlag(flagged, 'hours', 'done');
  if (note.people.length) flagged = withIntakeFlag(flagged, 'staff', 'more');
  if (note.partners.length) flagged = withIntakeFlag(flagged, 'affiliations', 'more');
  if (note.chapter) {
    flagged = {
      ...flagged,
      assistantIntake: { ...(flagged.assistantIntake || {}), focus: note.chapter },
    };
  }
  const changed = noteHasChanges({ ...note, chapter: '', productText: '', mediaFiles: [] });
  const profile = changed || note.chapter ? patchClientBank(userId, flagged) : null;
  if (note.productText) {
    const state = await getAssistantState(userId, ctx);
    const started = beginIngest(userId, { ...state, profile: profile || state.profile }, { text: note.productText });
    return {
      ...started,
      assistantMessage: [note.reply, started.assistantMessage].filter(Boolean).join('\n\n'),
      profile: profile || started.profile,
    };
  }
  if (!profile) return null;
  const revisit = Boolean(note.chapter && chapterHasContent(profile.clientDataBank || {}, note.chapter));
  return replyAfter(userId, profile, note.reply, { revisit, ctx });
}

async function orLoose(userId, text, fallback, ctx = null) {
  const loose = await tryLoose(userId, text, ctx);
  return loose || fallback;
}

async function handleAssistantChatTurn(userId, { text = '', messages = [], files: rawFiles = [], focusStep = '' } = {}, ctx = null) {
  const files = expandContainerFiles(rawFiles);
  const state = await getAssistantState(userId, ctx);
  const industry = state.industry || '';
  const layout = state.layout || '';
  const bank = state.profile?.clientDataBank || {};
  const step = ctx ? nextIntakeStep(bank, ctx) : nextIntakeStep(bank);
  const name = businessLabel(bank, state.profile);
  const trimmed = String(text || '').trim();
  const pricedLine = /\d+\s*(?:kr|,-|nok)\b/i.test(trimmed);
  const parts = partitionAssistantFiles(files);
  const asked = allowedIntakeSteps(ctx).includes(String(focusStep || '')) ? String(focusStep) : '';

  if (asked && !trimmed && !files.length) {
    return openChapter(userId, asked, ctx);
  }

  if (parts.documents.length) {
    return beginIngest(userId, state, { files, text: trimmed, layout });
  }

  const destination = !files.length ? navigationTarget(trimmed) : '';
  if (destination) return openChapter(userId, destination, ctx);

  const diverted = !files.length && !PLAN_STEPS.includes(step) ? sideWrite(trimmed, step) : null;
  if (diverted) {
    const saved = commitSideWrite(userId, diverted, ctx);
    if (saved) return saved;
  }

  if (step === 'done') {
    const loose = trimmed ? await tryLoose(userId, trimmed, ctx) : null;
    if (loose) return loose;
    return chatEnvelope(state, {
      assistantMessage: trimmed
        ? 'Jeg la ikke inn det som en endring. Skriv det konkret, for eksempel åpningstider eller en ansatt, eller velg et steg.'
        : doneMessage(name),
      nextAction: 'done',
      redirectTo: '',
      currentStep: 'done',
    }, ctx);
  }

  if (step !== 'products') {
    return handleIntakeAnswer(userId, state, { step, name, text: trimmed, files, ctx });
  }

  if (isNoMore(trimmed) && !files.length) {
    const hasProducts = summarizeCatalogs(bank.productCatalogs || []).productCount > 0;
    return replyAfter(userId, saveIntakeFlag(userId, 'products', hasProducts ? 'done' : 'skipped'), '', { ctx });
  }

  if (awaitingMore(bank, 'products') && isAffirmativeOnly(trimmed) && !files.length) {
    return chatEnvelope(state, {
      assistantMessage: 'Send det neste dokumentet, eller si at det er alt.',
      nextAction: 'wait',
      currentStep: 'products',
    }, ctx);
  }

  const siteHost = websiteHost(ctx?.websiteUrl);
  if (isAffirmativeOnly(trimmed) && !files.length && ctx?.steps?.includes('shop') && siteHost && summarizeCatalogs(bank.productCatalogs || []).productCount === 0) {
    return replyAfter(
      userId,
      saveIntakeFlag(userId, 'products', 'done'),
      `Produktene hentes fra ${siteHost} når nettsiden bygges.`,
      { ctx },
    );
  }

  if (shouldIngestSources({ files, text }) || pricedLine) {
    return beginIngest(userId, state, { files, text: trimmed, layout });
  }

  if (/åpning|ansatt|adresse|logo|farge|historie|partner|åpent|døgn|tone|målgruppe/i.test(trimmed)) {
    const loose = await tryLoose(userId, trimmed, ctx);
    if (loose) return loose;
  }

  const turn = await runProductAssistantTurn({
    messages: messages.length ? messages : [{ role: 'user', text }],
    industry,
    layout,
    summary: state.summary,
    salesClientId: salesClientIdOf(userId),
  });

  if (turn.nextAction === 'manual') {
    return { ...turn, profile: state.profile, catalogs: state.profile?.clientDataBank?.productCatalogs || [], summary: state.summary };
  }

  if (turn.nextAction === 'set_layout' && turn.layout) {
    const current = bankOf(userId);
    const catalogs = (current.productCatalogs || []).map((catalog, index) => (
      index === 0 ? { ...catalog, layout: turn.layout, label: turn.layout } : catalog
    ));
    const saved = persistCatalogs(userId, catalogs);
    return { ...turn, catalogs: saved.catalogs, profile: saved.profile, summary: summarizeCatalogs(saved.catalogs) };
  }

  if (turn.nextAction === 'ingest_text' && text) {
    return {
      ...beginIngest(userId, state, { files, text: trimmed, layout }),
      assistantMessage: turn.assistantMessage || startingIngestMessage({ files, text: trimmed }),
    };
  }

  return {
    ...turn,
    profile: state.profile,
    catalogs: state.profile?.clientDataBank?.productCatalogs || [],
    summary: state.summary,
    currentStep: 'products',
  };
}

export async function handleAssistantChat(userId, input = {}) {
  const ctx = await planIntakeContext(userId);
  return withIntakeSteps(await handleAssistantChatTurn(userId, input, ctx), ctx);
}

function shopShape(bank) {
  const current = bank?.shopSetup && typeof bank.shopSetup === 'object' ? bank.shopSetup : {};
  return {
    shipping: current.shipping || '',
    returns: current.returns || '',
    sellerVat: current.sellerVat || null,
    bookingServices: Array.isArray(current.bookingServices) ? [...current.bookingServices] : [],
  };
}

function appendKeywords(existing, phrases) {
  const list = [];
  const seen = new Set();
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(phrases || [])]) {
    const phrase = String(entry?.phrase ?? entry ?? '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const key = phrase.toLocaleLowerCase('nb-NO');
    if (seen.has(key)) continue;
    seen.add(key);
    if (list.length >= 10) break;
    list.push(phrase);
  }
  return list;
}

function finishPlan(userId, step, next, ctx, prefix) {
  patchClientBank(userId, next);
  const profile = planStepComplete(step, next, ctx)
    ? saveIntakeFlag(userId, step, 'done')
    : clientPortal.getClientProfileByUserId(userId);
  return replyAfter(userId, profile, prefix, { ctx });
}

function clearPlanVisit(userId) {
  const current = bankOf(userId);
  const intake = { ...(current.assistantIntake || {}), focus: '', revisitPart: '' };
  return patchClientBank(userId, { ...current, assistantIntake: intake });
}

function rememberShopPart(userId, bank, part) {
  return patchClientBank(userId, {
    ...bank,
    assistantIntake: { ...(bank.assistantIntake || {}), focus: 'shop', revisitPart: part },
  });
}

/** A finished plan step: "det er alt" or a bare nei ends the visit and leaves the stored answer. */
function planVisitEnded(text) {
  if (isPlanSkip(text)) return true;
  if (isDecline(text)) return false;
  return isNoMore(text);
}

async function handlePlanStep(userId, state, { step, name, text, ctx }) {
  const bank = bankOf(userId);
  const complete = planStepComplete(step, bank, ctx);
  if (complete && planVisitEnded(text)) return replyAfter(userId, clearPlanVisit(userId), '', { ctx });
  if (complete && step === 'shop') {
    const pending = ['shipping', 'returns', 'seller'].includes(bank.assistantIntake?.revisitPart) ? bank.assistantIntake.revisitPart : '';
    if (!pending) {
      const named = shopPartNamed(text);
      if (!named) {
        return chatEnvelope(state, {
          assistantMessage: 'Hva vil du endre: frakt, retur eller selger?',
          nextAction: 'wait',
          currentStep: 'shop',
        }, ctx);
      }
      const profile = rememberShopPart(userId, bank, named);
      const asked = promptFor(step, name, {
        ...bank,
        shopSetup: {
          ...shopShape(bank),
          ...(named === 'shipping' ? { shipping: '' } : {}),
          ...(named === 'returns' ? { returns: '' } : {}),
          ...(named === 'seller' ? { sellerVat: null } : {}),
        },
      }, { ctx: named === 'seller' ? { ...ctx, seller: {} } : ctx });
      return chatEnvelope({ ...state, profile }, {
        assistantMessage: asked,
        nextAction: 'wait',
        currentStep: 'shop',
      }, ctx);
    }
    const parsed = parseShopAnswer(text, pending);
    if (parsed.action !== 'save') {
      return chatEnvelope(state, {
        assistantMessage: `Jeg fikk ikke med meg det. ${promptFor(step, name, bank, { ctx })}`,
        nextAction: 'wait',
        currentStep: 'shop',
      }, ctx);
    }
    const shop = shopShape(bank);
    let next = { ...bank, shopSetup: shop };
    if (pending === 'shipping' || pending === 'returns') shop[pending] = parsed.value;
    if (pending === 'seller' && parsed.value && typeof parsed.value === 'object') {
      const prev = shop.sellerVat || { legalName: '', orgNumber: '', vatRegistered: null };
      shop.sellerVat = {
        legalName: parsed.value.legalName || prev.legalName || '',
        orgNumber: parsed.value.orgNumber || prev.orgNumber || '',
        vatRegistered: parsed.value.vatRegistered === null || parsed.value.vatRegistered === undefined
          ? prev.vatRegistered
          : parsed.value.vatRegistered,
      };
    }
    next = {
      ...next,
      shopSetup: shop,
      assistantIntake: { ...(bank.assistantIntake || {}), focus: 'shop', revisitPart: '', shop: 'done' },
    };
    const prefix = pending === 'shipping' ? 'Frakten er lagret.' : pending === 'returns' ? 'Returvilkårene er lagret.' : 'Selgeropplysningene er lagret.';
    return replyAfter(userId, patchClientBank(userId, next), prefix, { ctx });
  }
  const sub = planSubStep(step, bank, ctx);
  if (!complete && isPlanSkip(text)) return replyAfter(userId, saveIntakeFlag(userId, step, 'skipped'), '', { ctx });
  const again = (extra = '') => chatEnvelope(state, {
    assistantMessage: [extra, `Jeg fikk ikke med meg det. ${promptFor(step, name, bank, { ctx })}`].filter(Boolean).join(' '),
    nextAction: 'wait',
    currentStep: step,
  }, ctx);

  if (step === 'shop') {
    const parsed = parseShopAnswer(text, sub);
    if (parsed.action === 'skip') return replyAfter(userId, saveIntakeFlag(userId, step, 'skipped'), '', { ctx });
    if (parsed.action !== 'save') return again();
    const shop = shopShape(bank);
    let next = { ...bank, shopSetup: shop };
    if (sub === 'shipping' || sub === 'returns') shop[sub] = parsed.value;
    if (sub === 'seller' && parsed.value && typeof parsed.value === 'object') {
      const prev = shop.sellerVat || { legalName: '', orgNumber: '', vatRegistered: null };
      shop.sellerVat = {
        legalName: parsed.value.legalName || prev.legalName || '',
        orgNumber: parsed.value.orgNumber || prev.orgNumber || '',
        vatRegistered: parsed.value.vatRegistered === null || parsed.value.vatRegistered === undefined
          ? prev.vatRegistered
          : parsed.value.vatRegistered,
      };
      if (parsed.value.orgNumber && !String(bank.brandIdentity?.orgNumber || '').trim()) {
        next = {
          ...next,
          brandIdentity: { ...(bank.brandIdentity || {}), orgNumber: parsed.value.orgNumber },
        };
      }
    }
    next = { ...next, shopSetup: shop };
    const prefix = sub === 'shipping' ? 'Frakten er lagret.' : sub === 'returns' ? 'Returvilkårene er lagret.' : 'Selgeropplysningene er lagret.';
    return finishPlan(userId, step, next, ctx, prefix);
  }

  if (step === 'keywords' && sub === 'area') {
    const parsed = parseAreaAnswer(text);
    if (parsed.action === 'skip') return replyAfter(userId, saveIntakeFlag(userId, step, 'skipped'), '', { ctx });
    if (parsed.action !== 'save') return again();
    return finishPlan(userId, step, {
      ...bank,
      websiteCreatorQuestions: { ...(bank.websiteCreatorQuestions || {}), town: parsed.value },
    }, ctx, 'Området er lagret.');
  }

  if (step === 'keywords') {
    const parsed = parseKeywordAnswer(text);
    const dropped = parsed.dropped?.length ? `${parsed.dropped.join(', ')} kan ikke brukes som søkeord.` : '';
    if (parsed.action === 'skip') return replyAfter(userId, saveIntakeFlag(userId, step, 'skipped'), '', { ctx });
    if (parsed.action !== 'save') return again(dropped);
    try {
      await proposeAgreedKeywords(ctx?.clientId, parsed.phrases, {
        source: 'client',
        by: 'client',
        brandName: ctx?.brandName || '',
      });
    } catch (error) {
      console.warn('[assistant] søkeordforslag ble ikke lagret:', error?.message || error);
    }
    return finishPlan(userId, step, {
      ...bank,
      websiteCreatorQuestions: {
        ...(bank.websiteCreatorQuestions || {}),
        importantKeywords: appendKeywords(bank.websiteCreatorQuestions?.importantKeywords, parsed.phrases),
      },
    }, ctx, ['Søkeordene er lagret.', dropped].filter(Boolean).join(' '));
  }

  if (step === 'booking') {
    const parsed = parseBookingAnswer(text);
    if (parsed.action === 'skip') return replyAfter(userId, saveIntakeFlag(userId, step, 'skipped'), '', { ctx });
    if (parsed.action !== 'save') return again();
    const shop = shopShape(bank);
    shop.bookingServices = [...shop.bookingServices, ...parsed.services].slice(0, 30);
    const prefix = parsed.services.length === 1 ? 'Tjenesten er lagret.' : 'Tjenestene er lagret.';
    return finishPlan(userId, step, { ...bank, shopSetup: shop }, ctx, prefix);
  }

  return replyAfter(userId, state.profile, '', { ctx });
}

async function handleIntakeAnswer(userId, state, { step, name, text, files, ctx = null }) {
  if (step === 'shop' || step === 'keywords' || step === 'booking') {
    return handlePlanStep(userId, state, { step, name, text, ctx });
  }
  const parts = partitionAssistantFiles(files);
  const images = parts.media.filter((file) => sniffSourceKind(file) === 'image');

  if (step === 'media') {
    if (isNoMore(text) && !parts.media.length) {
      const hasMedia = mediaFileCount(bankOf(userId)) > 0;
      return replyAfter(userId, saveIntakeFlag(userId, 'media', hasMedia ? 'done' : 'skipped'), '', { ctx });
    }
    if (isAffirmativeOnly(text) && !parts.media.length) {
      return chatEnvelope(state, {
        assistantMessage: awaitingMore(bankOf(userId), 'media')
          ? 'Last opp de neste, eller si at det er nok.'
          : questionFor('media', name),
        nextAction: 'wait',
        currentStep: 'media',
      }, ctx);
    }
    if ((parts.documents.length || files.length) && !parts.media.length) {
      return chatEnvelope(state, {
        assistantMessage: 'Mediabiblioteket tar bilder og video. Tekstfiler hører ikke hjemme der. Last opp bilde eller video, eller si at dere hopper over.',
        nextAction: 'wait',
        currentStep: 'media',
      }, ctx);
    }
    if (parts.media.length) {
      const saved = await persistMediaFiles(userId, parts.media, { text });
      const count = saved.urls.length;
      let productBit = '';
      if (saved.productFiles.length) {
        const added = await ingestSourcesIntoBank(userId, { files: saved.productFiles });
        const total = summarizeCatalogs(added.catalogs).productCount;
        if (total) productBit = ` Jeg så en meny eller prisliste og la produktene inn i produktkatalogen (${total} produkter totalt).`;
      }
      const profile = saveIntakeFlag(userId, 'media', count ? 'more' : 'skipped');
      const prefix = count
        ? `${count === 1 ? 'Bildet eller videoen er med.' : `${count} filer er med.`}${productBit}`
        : 'Jeg fikk ikke lagret filene som media.';
      return replyAfter(userId, profile, prefix, { ctx });
    }
    return chatEnvelope(state, {
      assistantMessage: questionFor('media', name),
      nextAction: 'wait',
      currentStep: 'media',
    }, ctx);
  }

  if (step === 'logo') {
    if (isDecline(text) && !images.length) {
      return replyAfter(userId, saveIntakeFlag(userId, 'logo', 'skipped'), '', { ctx });
    }
    if (!images.length) {
      return chatEnvelope(state, {
        assistantMessage: 'Last opp selve logobildet (png, jpg eller svg). En tekstfil kan ikke brukes som logo.',
        nextAction: 'wait',
        currentStep: 'logo',
      }, ctx);
    }
    const file = images[0];
    const saved = await saveClientUploadBuffer(userId, {
      buffer: file.buffer,
      originalName: file.originalName || file.name || 'logo',
      prefix: 'logo',
    });
    const current = bankOf(userId);
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      brandIdentity: {
        ...(current.brandIdentity || {}),
        logos: {
          ...(current.brandIdentity?.logos || {}),
          normal: saved.url,
        },
      },
      media: {
        ...(current.media || {}),
        logos: uniqueUrls([...(current.media?.logos || []), saved.url]),
      },
    }, 'logo', 'done'));
    return replyAfter(userId, profile, 'Logoen er lagt på vanlig logoplass.', { ctx });
  }

  if (step === 'staff') {
    if (isNoMore(text) && !files.length) {
      const hasTeam = hasListedTeam(bankOf(userId));
      return replyAfter(userId, saveIntakeFlag(userId, 'staff', hasTeam ? 'done' : 'skipped'), '', { ctx });
    }
    const parsed = parseStaffAnswer(text);
    if (parsed.action === 'skip') {
      return replyAfter(userId, saveIntakeFlag(userId, 'staff', hasListedTeam(bankOf(userId)) ? 'done' : 'skipped'), '', { ctx });
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('staffDetails', name),
        nextAction: 'wait',
        currentStep: 'staff',
      }, ctx);
    }
    if (parsed.action !== 'save') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Skriv én person per linje: navn, tittel, telefon, e-post. Eller si at det ikke er aktuelt.',
        nextAction: 'wait',
        currentStep: 'staff',
      }, ctx), ctx);
    }
    const current = bankOf(userId);
    const staff = [...(current.staff || [])];
    for (const person of parsed.people) {
      staff.push({
        id: '',
        title: person.title,
        name: person.name,
        phone: person.phone,
        email: person.email,
        imageUrl: '',
      });
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, staff }, 'staff', 'more'));
    const count = parsed.people.length;
    return replyAfter(userId, profile, count === 1 ? 'Personen er med.' : `${count} personer er med.`, { ctx });
  }

  if (step === 'hours') {
    const parsed = parseOpeningHoursAnswer(text);
    if (parsed.action === 'unclear') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Fyll ut feltene under, eller skriv fritt i chatten. Si åpningstidene fra mandag til søndag, at dere er åpne hele tiden, eller at det ikke er relevant.',
        nextAction: 'wait',
        currentStep: 'hours',
      }, ctx), ctx);
    }
    const current = bankOf(userId);
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      openingHours: {
        ...(current.openingHours || {}),
        status: parsed.status,
        days: parsed.days,
      },
    }, 'hours', 'done'));
    const prefix = parsed.status === 'always'
      ? 'Jeg satte dere som åpne hele tiden.'
      : parsed.status === 'not-relevant'
        ? 'Jeg merket åpningstider som ikke relevant.'
        : 'Åpningstidene er lagret.';
    return replyAfter(userId, profile, prefix, { ctx });
  }

  if (step === 'affiliations') {
    if (isNoMore(text)) {
      const hasPartners = hasAffiliations(bankOf(userId));
      return replyAfter(userId, saveIntakeFlag(userId, 'affiliations', hasPartners ? 'done' : 'skipped'), '', { ctx });
    }
    const parsed = parseAffiliationsAnswer(text);
    if (parsed.action === 'skip') {
      return replyAfter(userId, saveIntakeFlag(userId, 'affiliations', hasAffiliations(bankOf(userId)) ? 'done' : 'skipped'), '', { ctx });
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('affiliationDetails', name),
        nextAction: 'wait',
        currentStep: 'affiliations',
      }, ctx);
    }
    if (parsed.action !== 'save') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Skriv partnerne, gjerne med gruppenavn foran. For eksempel «Sponsorer: Navn, Navn».',
        nextAction: 'wait',
        currentStep: 'affiliations',
      }, ctx), ctx);
    }
    const current = bankOf(userId);
    const affiliations = [...(current.affiliations || [])];
    for (const category of parsed.categories) {
      const hit = affiliations.find((row) => String(row.categoryName || '').toLowerCase() === category.categoryName.toLowerCase());
      if (hit) hit.items = [...(hit.items || []), ...category.items];
      else affiliations.push(category);
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, affiliations }, 'affiliations', 'more'));
    return replyAfter(userId, profile, 'Partnerne er med.', { ctx });
  }

  return replyAfter(userId, state.profile, '', { ctx });
}

export async function importProductFiles(userId, { files = [], text = '' } = {}) {
  const ingested = await ingestProductSources({
    files: expandContainerFiles(files),
    text,
    industry: (await getAssistantState(userId)).industry,
    salesClientId: salesClientIdOf(userId),
  });
  const saved = persistCatalogs(userId, ingested.catalogs);
  return {
    catalogs: saved.catalogs,
    profile: saved.profile,
    summary: summarizeCatalogs(saved.catalogs),
    layout: ingested.layout,
  };
}

export { extractFirstUrl };

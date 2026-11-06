import { readFileSync, writeFileSync, existsSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';
import { DEVELOPMENT_KEYS, normalizeDevelopment } from '../lib/development-phase.js';
import { normalizeStoredWebsiteEmail } from '../lib/sales-website-email.js';
import {
  appendActionNote,
  applyNextActionMutation,
  applyOfferSentFromDelivery,
  applyProgressionChange,
  applyMeetingHeldOrphanReset,
  assignmentStampForOwnerChange,
  ensureContractCheckupAction,
  clientIsSalesWin,
  decorateNextActions,
  NY_ASSIGNMENT_BACKFILL_KEY,
  planNyAssignmentBackfill,
  getSalesGoalKeys,
  inferMeetingHeld,
  MEETING_TIME_BACKFILL_TARGETS,
  normalizeMeetingAtSource,
  normalizeSecondaryInterest,
  clientMeetingAtIso,
  sameMeetingInstant,
  salesProgressBlockedReason as nextActionProgressBlockedReason,
} from '../lib/sales-next-actions.js';
import { calendarDurationForMode } from '../lib/sales-meeting-duration.js';
import { filterCustomOtherLinks } from '../lib/sales-client-links.js';
import { normalizeExtraFacts, persistClientBrief } from '../lib/sales-kundekort.js';
import { persistPreviewDocument } from '../lib/booker-preview-document.js';
import { normalizeWorkshopAction, offerStartDateFromWorkshopDueAt } from '../lib/workshop-action.js';
import { getWorkshopRecord, markProjectTodoDone, persistWorkshopRecord } from '../lib/workshop-record.js';
import { collectRecordedMeetLinks, firefliesMeetLinksDiffer } from '../lib/fireflies-client-match.js';
import { mergeRecordingState, normalizeRecordingState } from '../lib/fireflies-recording-state.js';
import { talkCoversPlaceholder } from '../lib/fireflies-slots.js';
import { planConfirmedMeetBackfill } from '../lib/sales-calendar-owner.js';
import { clampClientActionsToDueDate, ensureFeedbackAction, ensureInformasjonAction } from '../lib/workshop-desk-actions.js';
import { mergeMakerRunPatch, normalizeDeveloperQa } from '../lib/developer-card.js';
import { canonicalDeveloperOwnerId, normalizeDeveloperHandoff, applyAdminDeveloperOwnerSeed, shouldSeedExistingDeveloperOwners } from '../lib/developer-assignment.js';
import { normalizeDeveloperGoals } from '../lib/developer-goals.js';
import { normalizeDueDate } from '../lib/website-due.js';
import { normalizeOfferSentContent } from './sales-offers.js';
import {
  carryFutureKeys,
  FUTURE_CLIENT_KEYS,
  FUTURE_HUBSITE_KEYS,
  FUTURE_MAKERRUN_KEYS,
  FUTURE_MAKERRUN_STEP_KEYS,
  WRITER_ONLY_MAKERRUN_KEYS,
  withoutKeys,
} from './normalize-ext.js';
import { normalizeRunAiSpend } from '../lib/ai-spend.js';
import { normalizeSitePlan, withPlanHistory } from '../lib/site-plan-model.js';
import {
  deliveryEmailStampPatch,
  mergeDelivery,
  normalizeDelivery,
  planStageWrite,
} from '../lib/delivery-state.js';
import { normalizeMakerAutopilot, normalizeMakerMaterials, normalizePreviewPush } from '../lib/maker-events.js';
import { appendDeliveryAudit } from '../lib/delivery-audit.js';
import { appendStampedSalesNote } from '../lib/sales-card-log.js';

// Client keys only their own writers set (setSalesSitePlan, setSalesDelivery and friends):
// updateSalesClient and patchSalesClientsById never take them from an update, so no request body
// that reaches those functions can write a plan or a delivery state.
export const OWNED_CLIENT_KEYS = Object.freeze(['sitePlan', 'delivery']);
// makerRun keys only setSalesMakerRunOwned writes (Maker delivery events, WS8.28).
export const OWNED_MAKERRUN_KEYS = Object.freeze(['materials', 'autopilot', 'previewPush']);

function withoutOwnedKeys(updates = {}, keys = OWNED_CLIENT_KEYS) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {};
  const out = { ...updates };
  for (const key of keys) delete out[key];
  if (out.makerRun && typeof out.makerRun === 'object' && !Array.isArray(out.makerRun)) {
    const makerRun = { ...out.makerRun };
    for (const key of OWNED_MAKERRUN_KEYS) delete makerRun[key];
    out.makerRun = makerRun;
  }
  return out;
}

/**
 * Sets an owned key from its normalizer (call it after carryFutureKeys). null clears the key; a
 * stored value the normalizer cannot read stays as it is, so a later batch's shape survives.
 */
function applyOwned(target, raw, key, normalize) {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) return;
  if (raw[key] === null) {
    delete target[key];
    return;
  }
  const value = normalize(raw[key]);
  target[key] = value || raw[key];
}

function persistWorkshopAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasAny = String(raw.name || '').trim()
    || String(raw.format || '').trim()
    || String(raw.dueAt || '').trim()
    || String(raw.calendarEventId || '').trim();
  if (!hasAny) return null;
  return normalizeWorkshopAction(raw);
}

const SALES_PATH = getDataFilePath('sales-clients.json');
const DEVELOPER_OWNER_SEED_PATH = getDataFilePath('developer-owner-seed.json');

const PROGRESSION_KEYS = [
  'meetingHeld',
  'step0AgreeMeetingTime',
  'offerSent',
  'checkIn1',
  'checkIn2',
  'contractSigned',
  'paymentReceived',
  'domainConnected',
  'live',
];
const SALES_STATUSES = ['active', 'not-sold', 'secondary'];
const SALES_PRODUCTS = ['asoldi', 'ssu'];
const MAX_SALES_NOTES_LENGTH = 8000;
/** Known MyPhoner SSU list id(s). Extra ids can be added via MYPHONER_SSU_LIST_IDS. */
const DEFAULT_SSU_LIST_IDS = ['210172'];

function ensureDataDir() {
  ensurePersistentDataDir();
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

export function sanitizeSalesNotes(value = '') {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_SALES_NOTES_LENGTH);
}

function normalizeContactEmailError(raw = null, contactEmail = '') {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : (raw ? { message: String(raw) } : null);
  const message = sanitizeText(source?.message).slice(0, 200);
  if (!message) return null;
  const to = sanitizeText(source?.to).toLowerCase();
  const email = sanitizeText(contactEmail).toLowerCase();
  if (to && email && to !== email) return null;
  return {
    message,
    at: sanitizeText(source?.at),
    to: to || email,
  };
}

function normalizeWebsiteDomain(value = '') {
  return sanitizeText(value);
}

function normalizeSalesStatus(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (SALES_STATUSES.includes(raw)) return raw;
  return 'active';
}

function normalizeSalesProduct(value = '', { allowEmpty = false } = {}) {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'website' || raw === 'asoldi-website' || raw === 'nettside') return 'asoldi';
  if (SALES_PRODUCTS.includes(raw)) return raw;
  if (allowEmpty) return '';
  return 'asoldi';
}

export { normalizeSalesProduct };

function getConfiguredSsuListIds() {
  const fromEnv = String(process.env.MYPHONER_SSU_LIST_IDS || '')
    .split(/[,;\s]+/)
    .map((entry) => sanitizeText(entry))
    .filter(Boolean);
  return new Set([...DEFAULT_SSU_LIST_IDS, ...fromEnv]);
}

/**
 * Resolve sales product bracket from MyPhoner list metadata.
 * SSU winners land in their own bracket (no website Maker / domain / live flow).
 */
export function resolveSalesProductFromMyphoner({ listId = '', listName = '', product = '' } = {}) {
  const explicit = normalizeSalesProduct(product, { allowEmpty: true });
  if (explicit) return explicit;
  const id = sanitizeText(listId);
  const name = sanitizeText(listName);
  if (id && getConfiguredSsuListIds().has(id)) return 'ssu';
  if (/^ssu$/i.test(name) || /\bssu\b/i.test(name)) return 'ssu';
  return 'asoldi';
}

export function isSsuSalesProduct(product = '') {
  return normalizeSalesProduct(product) === 'ssu';
}

export function getProgressionKeysForProduct(product = '') {
  return getSalesGoalKeys(product);
}

function normalizeMeetingMode(value) {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'online') return 'online';
  if (raw === 'in-person' || raw === 'in_person' || raw === 'inperson' || raw === 'physical') return 'in-person';
  return 'online';
}

function durationForMode(mode) {
  return calendarDurationForMode(mode);
}

function readSalesFile() {
  ensureDataDir();
  if (!existsSync(SALES_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SALES_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let salesRevision = 0;

export function salesDataRevision() {
  return salesRevision;
}

/** Call after sales-clients.json was replaced outside writeSalesFile (snapshot restore). */
export function noteSalesStoreReplaced() {
  salesRevision += 1;
  return salesRevision;
}

function writeSalesFile(list) {
  salesRevision += 1;
  ensureDataDir();
  writeDataJson(SALES_PATH, list);
}

function emptyReminders() {
  return {
    thankYouSentAt: '',
    reminder3dAt: '',
    reminder3dSentAt: '',
    reminder24hAt: '',
    reminder24hSentAt: '',
    reminder1hAt: '',
    reminder1hSentAt: '',
    skipDueToShortNotice: false,
  };
}

function normalizeProgression(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const meetingHeld = inferMeetingHeld(input);
  return {
    meetingHeld,
    // Alias kept so older clients/tools reading step 0 still see the result-based goal.
    step0AgreeMeetingTime: meetingHeld,
    offerSent: Boolean(input.offerSent),
    checkIn1: Boolean(input.checkIn1),
    checkIn2: Boolean(input.checkIn2),
    contractSigned: Boolean(input.contractSigned),
    paymentReceived: Boolean(input.paymentReceived),
    domainConnected: Boolean(input.domainConnected),
    live: Boolean(input.live),
  };
}

function normalizeWebsiteImport(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    importedAt: sanitizeText(input.importedAt),
    publishedAt: sanitizeText(input.publishedAt),
    sourceRunId: sanitizeText(input.sourceRunId),
    sourceStep: sanitizeText(input.sourceStep),
    sourceBaseUrl: sanitizeText(input.sourceBaseUrl),
    siteFolder: sanitizeText(input.siteFolder),
    importRoot: sanitizeText(input.importRoot),
    previewUrl: sanitizeText(input.previewUrl),
    previewSlug: sanitizeText(input.previewSlug),
    publicUrl: sanitizeText(input.publicUrl),
    publicPreviewPublishedAt: sanitizeText(input.publicPreviewPublishedAt),
  };
}

function normalizeMakerRunSteps(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return carryFutureKeys({
    '1': sanitizeText(input['1']) || 'idle',
    '1.5': sanitizeText(input['1.5']) || 'idle',
    '2': sanitizeText(input['2']) || 'idle',
    '3': sanitizeText(input['3']) || 'idle',
  }, input, FUTURE_MAKERRUN_STEP_KEYS);
}

function normalizeMakerStep2Substeps(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    'generate-text': sanitizeText(input['generate-text']) || 'idle',
    'inject-media': sanitizeText(input['inject-media']) || 'idle',
    'layout-colors-style': sanitizeText(input['layout-colors-style']) || 'idle',
    'maps-embed-sync': sanitizeText(input['maps-embed-sync']) || 'idle',
  };
}

function normalizeMakerRun(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const runId = sanitizeText(input.runId);
  const base = {
    runId,
    dashboardUrl: sanitizeText(input.dashboardUrl),
    previewUrl: sanitizeText(input.previewUrl),
    latestReadyStep: sanitizeText(input.latestReadyStep),
    latestStepStatus: sanitizeText(input.latestStepStatus),
    intakeStatus: sanitizeText(input.intakeStatus),
    templateSetId: sanitizeText(input.templateSetId),
    exportPath: sanitizeText(input.exportPath),
    statusUpdatedAt: sanitizeText(input.statusUpdatedAt),
    fieldsSyncedAt: sanitizeText(input.fieldsSyncedAt),
    industry: sanitizeText(input.industry),
    createdAt: sanitizeText(input.createdAt),
    clientBundleId: sanitizeText(input.clientBundleId),
    quickFillCompletedAt: sanitizeText(input.quickFillCompletedAt),
    mediaGatherCompletedAt: sanitizeText(input.mediaGatherCompletedAt),
  };
  // WS0.19 owns aiSpend (the Maker's run.ai.spend callback); only setSalesMakerRunAiSpend writes it.
  // It belongs to one run: after a relink to another run it is dropped (ai/maker-spend.json keeps it).
  const aiSpend = input.aiSpend ? normalizeRunAiSpend(input.aiSpend, { runId }) : null;
  if (aiSpend && runId && aiSpend.runId === runId) base.aiSpend = aiSpend;
  if (!runId) return withOwnedMakerRunKeys(carryFutureKeys(base, input, FUTURE_MAKERRUN_KEYS), input);
  return withOwnedMakerRunKeys(carryFutureKeys({
    ...base,
    steps: normalizeMakerRunSteps(input.steps),
    step2Substeps: normalizeMakerStep2Substeps(input.step2Substeps),
    language: {
      confirmed: Boolean(input.language?.confirmed),
      code: sanitizeText(input.language?.code),
    },
    cms: sanitizeText(input.cms),
    customSite: {
      exists: Boolean(input.customSite?.exists),
      previewPath: sanitizeText(input.customSite?.previewPath),
    },
    productionDomain: sanitizeText(input.productionDomain),
    websiteDomain: sanitizeText(input.websiteDomain),
  }, input, FUTURE_MAKERRUN_KEYS), input);
}

// WS8.28 owns materials and autopilot; previewPush has its shape here for WS8.17.
function withOwnedMakerRunKeys(out, input) {
  applyOwned(out, input, 'materials', normalizeMakerMaterials);
  applyOwned(out, input, 'autopilot', normalizeMakerAutopilot);
  applyOwned(out, input, 'previewPush', normalizePreviewPush);
  return out;
}

function normalizeHubSite(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return carryFutureKeys({
    siteKey: sanitizeText(input.siteKey || input.site_key),
    domain: sanitizeText(input.domain),
    id: sanitizeText(input.id),
    createdAt: sanitizeText(input.createdAt),
    liveUrl: sanitizeText(input.liveUrl),
  }, input, FUTURE_HUBSITE_KEYS);
}

function normalizeArchive(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    archivedAt: sanitizeText(input.archivedAt),
    reason: sanitizeText(input.reason),
  };
}

function normalizeCalendar(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    eventId: sanitizeText(input.eventId),
    htmlLink: sanitizeText(input.htmlLink),
    meetLink: sanitizeText(input.meetLink),
    confirmedMeetLink: sanitizeText(input.confirmedMeetLink),
    calendarId: sanitizeText(input.calendarId),
    accountKey: sanitizeText(input.accountKey),
    googleEmail: sanitizeText(input.googleEmail),
    organizerEmail: sanitizeText(input.organizerEmail),
    creatorEmail: sanitizeText(input.creatorEmail),
    meetHostVerifiedEmail: sanitizeText(input.meetHostVerifiedEmail).toLowerCase(),
    iCalUID: sanitizeText(input.iCalUID),
    syncedAt: sanitizeText(input.syncedAt),
    guestInvitedAt: sanitizeText(input.guestInvitedAt),
    firefliesInvitedAt: sanitizeText(input.firefliesInvitedAt),
    firefliesLiveJoinedAt: sanitizeText(input.firefliesLiveJoinedAt),
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
    firefliesLiveJoinedMeetLink: sanitizeText(input.firefliesLiveJoinedMeetLink),
    inviteSequence: Number.isFinite(Number(input.inviteSequence)) && Number(input.inviteSequence) > 0
      ? Math.trunc(Number(input.inviteSequence))
      : 0,
  };
}

function normalizeReminders(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    thankYouSentAt: sanitizeText(input.thankYouSentAt),
    reminder24hAt: sanitizeText(input.reminder24hAt),
    reminder24hSentAt: sanitizeText(input.reminder24hSentAt),
    reminder3dAt: sanitizeText(input.reminder3dAt),
    reminder3dSentAt: sanitizeText(input.reminder3dSentAt),
    reminder1hAt: sanitizeText(input.reminder1hAt),
    reminder1hSentAt: sanitizeText(input.reminder1hSentAt),
    skipDueToShortNotice: Boolean(input.skipDueToShortNotice),
  };
}

function normalizeMeetingQuotePackage(value = {}, fallback = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const selected = Array.isArray(input.selected)
    ? input.selected.map((entry) => sanitizeText(entry)).filter(Boolean)
    : (Array.isArray(fallback.selected) ? fallback.selected : []);
  const oneTimeAddOns = Array.isArray(input.oneTimeAddOns)
    ? input.oneTimeAddOns.map((entry) => sanitizeText(entry)).filter(Boolean)
    : [];
  const pages = Number(input.pages);
  const fallbackPages = Number(fallback.pages);
  const pkg = {
    tierId: sanitizeText(input.tierId) || sanitizeText(fallback.tierId) || 'starter',
    customMode: Boolean(input.customMode),
    oneTime: Boolean(input.oneTime),
    pages: Number.isFinite(pages) && pages >= 1
      ? Math.round(pages)
      : (Number.isFinite(fallbackPages) && fallbackPages >= 1 ? Math.round(fallbackPages) : 5),
    selected,
    oneTimeAddOns,
  };
  // WS8.3: the rep picked the tier (not the starter default). Stored only when true, so existing
  // quotes keep their shape; the plan resolver trusts a quote's tier only with this flag.
  if (input.tierExplicit === true) pkg.tierExplicit = true;
  return pkg;
}

function normalizeMeetingQuote(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const pkg = normalizeMeetingQuotePackage(input);
  const altQuote = input.altQuote && typeof input.altQuote === 'object'
    ? normalizeMeetingQuotePackage(input.altQuote, pkg)
    : null;
  const active = Number(input.activeOfferIndex);
  return {
    ...pkg,
    customSections: sanitizeText(input.customSections).slice(0, MAX_SALES_NOTES_LENGTH),
    startDate: sanitizeText(input.startDate),
    projectStartMode: ['date', 'open', 'undecided'].includes(sanitizeText(input.projectStartMode))
      ? sanitizeText(input.projectStartMode)
      : '',
    projectStartDate: /^\d{4}-\d{2}-\d{2}$/.test(sanitizeText(input.projectStartDate))
      && sanitizeText(input.projectStartMode) === 'date'
      ? sanitizeText(input.projectStartDate)
      : '',
    productNotes: sanitizeText(input.productNotes).slice(0, MAX_SALES_NOTES_LENGTH),
    productGoal: sanitizeText(input.productGoal).slice(0, MAX_SALES_NOTES_LENGTH),
    identity: sanitizeText(input.identity).slice(0, MAX_SALES_NOTES_LENGTH),
    altQuote,
    activeOfferIndex: altQuote && active === 1 ? 1 : 0,
  };
}

function parseSalesBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  return false;
}

function normalizeSalesDetails(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const details = {
    instagramUrl: sanitizeText(input.instagramUrl),
    facebookUrl: sanitizeText(input.facebookUrl),
    proffUrl: sanitizeText(input.proffUrl),
    otherLinks: sanitizeText(input.otherLinks),
    googleBusinessProfile: sanitizeText(input.googleBusinessProfile),
    extraFacts: normalizeExtraFacts(input.extraFacts),
    emailCustomNeed: sanitizeText(input.emailCustomNeed),
    meetingQuote: normalizeMeetingQuote(input.meetingQuote),
    editEmailBeforeSend: parseSalesBoolean(input.editEmailBeforeSend),
  };
  delete details.workshopAction;
  details.otherLinks = filterCustomOtherLinks(details.otherLinks, details);
  return details;
}

function normalizeMyphoner(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const leadIds = Array.isArray(input.leadIds)
    ? input.leadIds.map((entry) => sanitizeText(entry)).filter(Boolean)
    : [];
  const primaryLeadId = sanitizeText(input.leadId);
  if (primaryLeadId && !leadIds.includes(primaryLeadId)) leadIds.unshift(primaryLeadId);
  return {
    leadId: primaryLeadId,
    leadIds,
    listId: sanitizeText(input.listId),
    listName: sanitizeText(input.listName),
    leadResourceUrl: sanitizeText(input.leadResourceUrl),
    winnerCategory: sanitizeText(input.winnerCategory),
    winnerComment: sanitizeText(input.winnerComment),
    lastWinnerWebhookAt: sanitizeText(input.lastWinnerWebhookAt),
    lastRecordingWebhookAt: sanitizeText(input.lastRecordingWebhookAt),
    latestEventAt: sanitizeText(input.latestEventAt),
    latestCallId: sanitizeText(input.latestCallId),
    latestCallStartedAt: sanitizeText(input.latestCallStartedAt),
    latestCallDurationSeconds: Number.isFinite(Number(input.latestCallDurationSeconds))
      ? Number(input.latestCallDurationSeconds)
      : 0,
    latestCallUserEmail: sanitizeText(input.latestCallUserEmail),
    bookedByEmail: sanitizeText(input.bookedByEmail) || sanitizeText(input.latestCallUserEmail),
    bookedByName: sanitizeText(input.bookedByName),
    bookedAt: sanitizeText(input.bookedAt) || sanitizeText(input.lastWinnerWebhookAt),
    latestCallDestinationNumber: sanitizeText(input.latestCallDestinationNumber),
    latestRecordingUrl: sanitizeText(input.latestRecordingUrl),
    latestRecordingSyncReason: sanitizeText(input.latestRecordingSyncReason),
  };
}

const MAX_CLIENT_MEETINGS = 200;

/** Fireflies meetings linked to this client (compact refs; the full transcript lives in fireflies-meetings.json). */
function normalizeMeetings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const meetingId = sanitizeText(raw?.meetingId);
    if (!meetingId || seen.has(meetingId)) continue;
    seen.add(meetingId);
    out.push({
      meetingId,
      title: sanitizeText(raw.title) || 'Fireflies-møte',
      when: sanitizeText(raw.when),
      startedAt: sanitizeText(raw.startedAt),
      durationMinutes: raw.durationMinutes === '' || raw.durationMinutes == null ? '' : Number(raw.durationMinutes) || '',
      meetLink: sanitizeText(raw.meetLink),
      transcriptUrl: sanitizeText(raw.transcriptUrl),
      videoUrl: sanitizeText(raw.videoUrl),
      confidence: ['high', 'medium', 'low', 'manual'].includes(sanitizeText(raw.confidence)) ? sanitizeText(raw.confidence) : 'manual',
      score: Number(raw.score) || 0,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map((item) => sanitizeText(item)).filter(Boolean).slice(0, 6) : [],
      summary: sanitizeText(raw.summary).slice(0, 2000),
      actionItems: Array.isArray(raw.actionItems) ? raw.actionItems.map((item) => sanitizeText(item)).filter(Boolean).slice(0, 20) : [],
      hasTranscript: Boolean(raw.hasTranscript),
      // Sentences in the stored transcript: picks the copy with the most talk when one meeting has two.
      sentenceCount: raw.sentenceCount === '' || raw.sentenceCount == null || !Number.isFinite(Number(raw.sentenceCount))
        ? ''
        : Math.max(0, Math.round(Number(raw.sentenceCount))),
      liveJoinedAt: sanitizeText(raw.liveJoinedAt),
      source: sanitizeText(raw.source),
      linkedAt: sanitizeText(raw.linkedAt) || nowIso(),
      linkedBy: sanitizeText(raw.linkedBy) || 'auto',
      forSalesMeeting: Boolean(raw.forSalesMeeting),
      purpose: ['sales', 'workshop', 'iteration'].includes(sanitizeText(raw.purpose))
        ? sanitizeText(raw.purpose)
        : '',
      // A person picked the purpose (POST …/meetings/:meetingId/purpose): automatic passes keep it.
      purposePickedBy: sanitizeText(raw.purposePickedBy),
      purposePickedAt: sanitizeText(raw.purposePickedAt),
      // Which booked slot this row belongs to (lib/fireflies-recording-state.js slotKeyFor).
      slotKey: sanitizeText(raw.slotKey),
      // Recording state of a live-join placeholder (null on ordinary transcript rows).
      recording: normalizeRecordingState(raw.recording),
    });
  }
  return out
    .sort((a, b) => new Date(b.startedAt || b.linkedAt).getTime() - new Date(a.startedAt || a.linkedAt).getTime())
    .slice(0, MAX_CLIENT_MEETINGS);
}

/** Norwegian org numbers are 9 digits; keep only digits so "934 327 497" and "934327497" compare equal. */
export function sanitizeOrgNumber(value = '') {
  const digits = sanitizeText(value).replace(/\D+/g, '');
  return digits.length === 9 ? digits : '';
}

export function formatOrgNumber(value = '') {
  const digits = sanitizeOrgNumber(value);
  return digits ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : '';
}

function normalizeSentContractFingerprint(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const byteLength = Math.max(0, Math.round(Number(raw.byteLength) || 0));
  const sha256 = sanitizeText(raw.sha256).slice(0, 64);
  if (!byteLength && !sha256) return null;
  return {
    byteLength,
    pageCount: Math.max(0, Math.round(Number(raw.pageCount) || 0)),
    imageCount: Math.max(0, Math.round(Number(raw.imageCount) || 0)),
    eofCount: Math.max(0, Math.round(Number(raw.eofCount) || 0)),
    sha256,
    fileName: sanitizeText(raw.fileName).slice(0, 180),
    sentAt: sanitizeText(raw.sentAt),
    source: 'sent',
  };
}

const SALES_MISSED_KINDS = ['noShow', 'skipped', 'auto'];

/** Checklist steps that have no next-action row of their own. */
function normalizeSalesPlaybook(raw) {
  const iso = (value) => {
    const textValue = sanitizeText(value);
    return Number.isFinite(Date.parse(textValue)) ? textValue : '';
  };
  const missedKind = SALES_MISSED_KINDS.includes(sanitizeText(raw?.missedKind)) ? sanitizeText(raw?.missedKind) : '';
  return {
    readUpAt: iso(raw?.readUpAt),
    missedKind,
    missedAt: iso(raw?.missedAt),
    missedMeetingAt: iso(raw?.missedMeetingAt),
    missedCalledAt: iso(raw?.missedCalledAt),
    // Last voided meeting time (client cancelled, no new time). MyPhoner may not restore it.
    cancelledMeetingAt: iso(raw?.cancelledMeetingAt),
    cancelledAt: iso(raw?.cancelledAt),
  };
}

function normalizeSalesClient(raw = {}) {
  const meetingMode = normalizeMeetingMode(raw.meetingMode);
  const agreedTime = Boolean(raw.agreedTime);
  const meetingAt = agreedTime ? sanitizeText(raw.meetingAt) : '';
  const createdAt = sanitizeText(raw.createdAt) || nowIso();
  const updatedAt = sanitizeText(raw.updatedAt) || createdAt;
  const status = normalizeSalesStatus(raw.status);
  const archive = normalizeArchive(raw.archive);
  const myphoner = normalizeMyphoner(raw.myphoner);
  const product = resolveSalesProductFromMyphoner({
    product: raw.product,
    listId: myphoner.listId,
    listName: myphoner.listName,
  });
  const progression = normalizeProgression(raw.progression);
  const reset = applyMeetingHeldOrphanReset({
    progression,
    nextActions: Array.isArray(raw.nextActions) ? raw.nextActions : [],
    salesMigrations: raw.salesMigrations,
  });
  const nextProgression = { ...reset.progression };
  if (product === 'ssu') {
    nextProgression.domainConnected = false;
    nextProgression.live = false;
  }

  const client = {
    id: sanitizeText(raw.id) || makeId(),
    ownerId: sanitizeText(raw.ownerId),
    developerOwnerId: canonicalDeveloperOwnerId(raw.developerOwnerId),
    developerHandoff: normalizeDeveloperHandoff(raw.developerHandoff),
    product,
    businessName: sanitizeText(raw.businessName),
    contactPerson: sanitizeText(raw.contactPerson),
    contactEmail: sanitizeText(raw.contactEmail),
    contactEmailError: normalizeContactEmailError(raw.contactEmailError, raw.contactEmail),
    websiteEmail: normalizeStoredWebsiteEmail(raw.websiteEmail, raw.contactEmail),
    clientEmail: sanitizeText(raw.clientEmail).toLowerCase(),
    portalUserId: sanitizeText(raw.portalUserId),
    portalBusinessId: sanitizeText(raw.portalBusinessId),
    portalConnectedAt: sanitizeText(raw.portalConnectedAt),
    portalTierId: sanitizeText(raw.portalTierId),
    contactPhone: sanitizeText(raw.contactPhone),
    meetingPlace: sanitizeText(raw.meetingPlace),
    // Contract parties block (offer/contract flow): org number + registered business address.
    orgNumber: sanitizeOrgNumber(raw.orgNumber),
    businessAddress: sanitizeText(raw.businessAddress),
    industry: sanitizeText(raw.industry),
    meetingMode,
    meetingDurationMinutes: durationForMode(meetingMode),
    agreedTime,
    meetingAt,
    meetingAtSource: agreedTime && meetingAt ? normalizeMeetingAtSource(raw.meetingAtSource) : '',
    assignedToRepAt: sanitizeText(raw.assignedToRepAt),
    websiteDomain: product === 'ssu' ? '' : normalizeWebsiteDomain(raw.websiteDomain),
    notes: sanitizeSalesNotes(raw.notes),
    details: normalizeSalesDetails(raw.details),
    clientBrief: persistClientBrief(raw.clientBrief),
    previewDocument: persistPreviewDocument(raw.previewDocument),
    salesPlaybook: normalizeSalesPlaybook(raw.salesPlaybook),
    myphoner,
    progression: nextProgression,
    salesMigrations: reset.salesMigrations,
    nextActions: reset.nextActions,
    workshopAction: persistWorkshopAction(raw.workshopAction),
    workshop: persistWorkshopRecord(raw.workshop),
    developerQa: normalizeDeveloperQa(raw.developerQa),
    developerGoals: normalizeDeveloperGoals(raw.developerGoals),
    contractSignedAt: nextProgression.contractSigned ? sanitizeText(raw.contractSignedAt) : '',
    contractSentAt: sanitizeText(raw.contractSentAt),
    offerSentContent: normalizeOfferSentContent(raw.offerSentContent),
    offerLetterApprovedAt: sanitizeText(raw.offerLetterApprovedAt),
    offerLetterFilledAt: sanitizeText(raw.offerLetterFilledAt),
    sentContractFingerprint: normalizeSentContractFingerprint(raw.sentContractFingerprint),
    websiteDueOverride: normalizeDueDate(raw.websiteDueOverride),
    websiteDeliveryWeeks: Math.max(0, Math.round(Number(raw.websiteDeliveryWeeks) || 0)),
    development: product === 'ssu' ? normalizeDevelopment() : normalizeDevelopment(raw.development),
    reminders: normalizeReminders(raw.reminders || emptyReminders()),
    calendar: normalizeCalendar(raw.calendar),
    recordedMeetLinks: collectRecordedMeetLinks(raw),
    meetings: normalizeMeetings(raw.meetings),
    lockedOfferMeetingId: sanitizeText(raw.lockedOfferMeetingId),
    websiteImport: product === 'ssu' ? normalizeWebsiteImport() : normalizeWebsiteImport(raw.websiteImport),
    makerRun: product === 'ssu' ? normalizeMakerRun() : normalizeMakerRun(raw.makerRun),
    hubSite: product === 'ssu' ? normalizeHubSite() : normalizeHubSite(raw.hubSite),
    status,
    secondaryInterest: status === 'secondary' ? normalizeSecondaryInterest(raw.secondaryInterest) : '',
    archive: status === 'not-sold' || status === 'secondary' ? archive : normalizeArchive(),
    createdAt,
    updatedAt,
  };
  // WS8.56: stored only when true, so existing records keep their shape.
  if (raw.isTest === true) client.isTest = true;
  // WS8.44: keys a later batch writes survive this code; WS8.3 / WS8.9 own sitePlan and delivery.
  carryFutureKeys(client, raw, FUTURE_CLIENT_KEYS);
  applyOwned(client, raw, 'sitePlan', normalizeSitePlan);
  applyOwned(client, raw, 'delivery', normalizeDelivery);
  if (client.isTest !== true) delete client.isTest;
  const inboxPatch = planConfirmedMeetBackfill(client);
  if (inboxPatch) client.calendar = { ...client.calendar, ...inboxPatch };
  client.nextActions = decorateNextActions(client);
  return client;
}

function readState() {
  const previous = readSalesFile();
  const list = previous.map(normalizeSalesClient);
  const needsOrphanWrite = previous.some((raw) => !raw?.salesMigrations?.meetingHeldOrphansV1);
  const needsFollowUpWrite = previous.some((raw, index) => {
    if (!clientIsSalesWin(list[index])) return false;
    const stored = Array.isArray(raw?.nextActions) ? raw.nextActions : [];
    return !stored.some((action) => action?.presetKey === 'oppfolging1mnd');
  });
  const needsInboxMeetWrite = previous.some((raw, index) => {
    const before = raw?.calendar || {};
    const after = list[index]?.calendar || {};
    return firefliesMeetLinksDiffer(before.confirmedMeetLink, after.confirmedMeetLink)
      || firefliesMeetLinksDiffer(before.meetLink, after.meetLink);
  });
  if (previous.length && (needsOrphanWrite || needsFollowUpWrite || needsInboxMeetWrite)) {
    writeSalesFile(list);
  }
  return list;
}

function writeState(items) {
  writeSalesFile(items.map(normalizeSalesClient));
}

function readDeveloperOwnerSeedMeta() {
  if (!existsSync(DEVELOPER_OWNER_SEED_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(DEVELOPER_OWNER_SEED_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function seedExistingDeveloperOwnersToAdmin() {
  const meta = readDeveloperOwnerSeedMeta();
  if (!shouldSeedExistingDeveloperOwners(meta)) {
    return { seeded: false, assignedCount: 0 };
  }
  const list = readState();
  const applied = applyAdminDeveloperOwnerSeed(list);
  if (applied.assignedCount) writeState(applied.clients);
  writeDataJson(DEVELOPER_OWNER_SEED_PATH, {
    existingAssignedToAdminAt: applied.seededAt,
    assignedCount: applied.assignedCount,
  });
  return { seeded: true, assignedCount: applied.assignedCount };
}

/** While Admin is the only developer, new website clients do not sit unassigned. */
export function assignOpenDeveloperClientsToAdmin() {
  const list = readState();
  const applied = applyAdminDeveloperOwnerSeed(list);
  if (!applied.assignedCount) return { assignedCount: 0 };
  writeState(applied.clients);
  return { assignedCount: applied.assignedCount };
}

export function deriveReminderSchedule({ agreedTime, meetingAt }, nowMs = Date.now()) {
  const empty = {
    reminder3dAt: '',
    reminder24hAt: '',
    reminder1hAt: '',
    skipDueToShortNotice: false,
  };
  if (!agreedTime || !meetingAt) return empty;
  const meetingMs = new Date(meetingAt).getTime();
  if (!Number.isFinite(meetingMs)) {
    return { ...empty, skipDueToShortNotice: true };
  }
  const diffMs = meetingMs - nowMs;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const threeDayMs = 3 * dayMs;
  return {
    reminder3dAt: diffMs > threeDayMs ? new Date(meetingMs - threeDayMs).toISOString() : '',
    reminder24hAt: diffMs > dayMs ? new Date(meetingMs - dayMs).toISOString() : '',
    reminder1hAt: diffMs > hourMs ? new Date(meetingMs - hourMs).toISOString() : '',
    skipDueToShortNotice: diffMs <= hourMs,
  };
}

/** True when this reminder should go out now: due time has passed, it is unsent, and the meeting has not started. */
export function salesReminderIsDue(atIso, sentAt, { nowMs = Date.now(), meetingAt = '' } = {}) {
  if (sentAt) return false;
  const at = atIso ? new Date(atIso).getTime() : 0;
  if (!at || nowMs < at) return false;
  const meetingMs = meetingAt ? new Date(meetingAt).getTime() : 0;
  if (Number.isFinite(meetingMs) && meetingMs > 0 && meetingMs <= nowMs) return false;
  return true;
}

export function shouldRescheduleSalesReminders(previousClient, nextClient) {
  if (!nextClient) return false;
  if (!previousClient) return true;
  return sanitizeText(previousClient.meetingAt) !== sanitizeText(nextClient.meetingAt)
    || Boolean(previousClient.agreedTime) !== Boolean(nextClient.agreedTime);
}

const REMINDER_CATCHUP_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/** 24h/1h still send if calendar sync wiped the due stamp, as long as confirmation was far enough before the meeting. */
export function salesReminderCatchUpIsDue(kind, client = {}, nowMs = Date.now()) {
  const windowMs = REMINDER_CATCHUP_MS[kind];
  if (!windowMs) return false;
  const sentAt = kind === '24h'
    ? sanitizeText(client?.reminders?.reminder24hSentAt)
    : sanitizeText(client?.reminders?.reminder1hSentAt);
  if (sentAt) return false;
  const meetingMs = new Date(client?.meetingAt).getTime();
  if (!Number.isFinite(meetingMs) || meetingMs <= nowMs) return false;
  const thankYouMs = new Date(client?.reminders?.thankYouSentAt).getTime();
  if (!Number.isFinite(thankYouMs) || meetingMs - thankYouMs <= windowMs) return false;
  return nowMs >= meetingMs - windowMs;
}

/** 'status' when the card is off the active list, 'stage' from Tilbud on (meeting held, offer sent, signed), else ''. */
export function salesMeetingStageBlockedReason(client = {}) {
  if ((sanitizeText(client?.status) || 'active') !== 'active') return 'status';
  const progression = client?.progression || {};
  if (progression.meetingHeld || progression.offerSent || progression.contractSigned) return 'stage';
  return '';
}

/** Why the automatic meeting reminders must stay silent for this card ('' = they may go out). Owner checks live in server.js. */
export function salesReminderBlockedReason(client = {}, nowMs = Date.now()) {
  if (!client) return 'no-client';
  const stage = salesMeetingStageBlockedReason(client);
  if (stage) return stage;
  if (!sanitizeText(client.reminders?.thankYouSentAt)) return 'not-confirmed';
  if (!client.agreedTime || !sanitizeText(client.meetingAt)) return 'no-meeting';
  const meetingMs = new Date(client.meetingAt).getTime();
  if (!Number.isFinite(meetingMs) || meetingMs <= nowMs) return 'meeting-passed';
  const playbook = client.salesPlaybook || {};
  const marked = playbook.missedKind === 'noShow' || playbook.missedKind === 'skipped';
  if (marked && sameMeetingInstant(playbook.missedMeetingAt, client.meetingAt)) return 'missed';
  return '';
}

const REMINDER_OFFSET_MS = {
  reminder3dAt: 3 * 24 * 60 * 60 * 1000,
  reminder24hAt: 24 * 60 * 60 * 1000,
  reminder1hAt: 60 * 60 * 1000,
};
const REMINDER_STAMP_TOLERANCE_MS = 60 * 1000;

/** True when a stored reminder*At belongs to another meeting time (meetingAt moved without rescheduleSalesReminders). */
export function salesReminderStampsStale(client = {}) {
  const reminders = client?.reminders || {};
  const meetingMs = client?.agreedTime ? new Date(client?.meetingAt).getTime() : Number.NaN;
  return Object.entries(REMINDER_OFFSET_MS).some(([key, offsetMs]) => {
    const at = sanitizeText(reminders[key]);
    if (!at) return false;
    const atMs = new Date(at).getTime();
    if (!Number.isFinite(meetingMs) || !Number.isFinite(atMs)) return true;
    return Math.abs(meetingMs - offsetMs - atMs) > REMINDER_STAMP_TOLERANCE_MS;
  });
}

export function getSalesClients() {
  return readState().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getSalesClientById(id) {
  return readState().find((entry) => entry.id === id) || null;
}

export function getSalesClientByMyphonerLeadId(leadId) {
  const target = sanitizeText(leadId);
  if (!target) return null;
  return (
    readState().find((entry) => {
      if (sanitizeText(entry.myphoner?.leadId) === target) return true;
      if (!Array.isArray(entry.myphoner?.leadIds)) return false;
      return entry.myphoner.leadIds.some((candidate) => sanitizeText(candidate) === target);
    }) || null
  );
}

export function createSalesClient(rawInput = {}) {
  const input = withoutOwnedKeys(rawInput);
  const state = readState();
  const now = nowIso();
  const client = normalizeSalesClient({
    ...input,
    ...(sanitizeText(input.assignedToRepAt) ? {} : assignmentStampForOwnerChange('', input.ownerId, now)),
    id: input.id || makeId(),
    createdAt: now,
    updatedAt: now,
    reminders: input.reminders || emptyReminders(),
  });
  state.push(client);
  writeState(state);
  return client;
}

/** Generic client update. sitePlan and delivery are never taken from `updates` (OWNED_CLIENT_KEYS). */
export function updateSalesClient(id, updates = {}) {
  return updateSalesClientInternal(id, withoutOwnedKeys(updates));
}

function updateSalesClientInternal(id, updates = {}) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const current = state[index];
  const mergedDetails = updates.details && typeof updates.details === 'object'
    ? { ...(current.details || {}), ...updates.details }
    : current.details;
  const ownerStamp = Object.prototype.hasOwnProperty.call(updates, 'ownerId')
    ? assignmentStampForOwnerChange(current.ownerId, updates.ownerId)
    : {};
  const next = normalizeSalesClient({
    ...current,
    ...updates,
    ...ownerStamp,
    details: mergedDetails,
    progression: updates.progression
      ? { ...current.progression, ...updates.progression }
      : current.progression,
    nextActions: Object.prototype.hasOwnProperty.call(updates, 'nextActions')
      ? updates.nextActions
      : current.nextActions,
    workshopAction: Object.prototype.hasOwnProperty.call(updates, 'workshopAction')
      ? updates.workshopAction
      : current.workshopAction,
    workshop: Object.prototype.hasOwnProperty.call(updates, 'workshop')
      ? updates.workshop
      : current.workshop,
    developerQa: Object.prototype.hasOwnProperty.call(updates, 'developerQa')
      ? { ...(current.developerQa || {}), ...(updates.developerQa || {}) }
      : current.developerQa,
    developerGoals: Object.prototype.hasOwnProperty.call(updates, 'developerGoals')
      ? { ...(current.developerGoals || {}), ...(updates.developerGoals || {}) }
      : current.developerGoals,
    salesMigrations: Object.prototype.hasOwnProperty.call(updates, 'salesMigrations')
      ? { ...(current.salesMigrations || {}), ...(updates.salesMigrations || {}) }
      : current.salesMigrations,
    development: updates.development
      ? { ...current.development, ...updates.development }
      : current.development,
    calendar: updates.calendar
      ? { ...current.calendar, ...updates.calendar }
      : current.calendar,
    websiteImport: updates.websiteImport
      ? { ...current.websiteImport, ...updates.websiteImport }
      : current.websiteImport,
    // Writer-only keys (makerRun.aiSpend) keep their stored value here; their own writer sets them.
    makerRun: updates.makerRun
      ? { ...current.makerRun, ...withoutKeys(updates.makerRun, WRITER_ONLY_MAKERRUN_KEYS) }
      : current.makerRun,
    hubSite: updates.hubSite
      ? { ...current.hubSite, ...updates.hubSite }
      : current.hubSite,
    archive: updates.archive
      ? { ...current.archive, ...updates.archive }
      : current.archive,
    reminders: updates.reminders
      ? { ...current.reminders, ...updates.reminders }
      : current.reminders,
    myphoner: updates.myphoner
      ? { ...(current.myphoner || {}), ...updates.myphoner }
      : current.myphoner,
    updatedAt: nowIso(),
  });
  state[index] = next;
  writeState(state);
  return next;
}

/** Stamp or clear the card error when a send to contactEmail fails or succeeds. Not the inbox bot. */
export function noteSalesContactEmailSend({ to = '', ok = false, error = '' } = {}) {
  const rawTo = Array.isArray(to) ? to[0] : String(to || '').split(',')[0];
  const address = sanitizeText(rawTo).replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
  if (!/@/.test(address)) return 0;
  let n = 0;
  for (const client of getSalesClients()) {
    if (sanitizeText(client.contactEmail).toLowerCase() !== address) continue;
    if (ok) {
      if (client.contactEmailError) {
        updateSalesClient(client.id, { contactEmailError: null });
        n += 1;
      }
      continue;
    }
    updateSalesClient(client.id, {
      contactEmailError: {
        message: sanitizeText(error).slice(0, 200) || 'E-post kom ikke fram',
        at: nowIso(),
        to: address,
      },
    });
    n += 1;
  }
  return n;
}

/** One write for many client patches. Myphoner and migration objects are merged. */
export function patchSalesClientsById(entries = []) {
  const byId = new Map();
  for (const entry of entries) {
    const id = sanitizeText(entry?.id);
    if (!id || !entry?.patch || typeof entry.patch !== 'object') continue;
    byId.set(id, withoutOwnedKeys(entry.patch));
  }
  if (!byId.size) return { total: 0, updated: 0 };
  const state = readState();
  let updated = 0;
  const next = state.map((client) => {
    const patch = byId.get(client.id);
    if (!patch) return client;
    updated += 1;
    const ownerStamp = Object.prototype.hasOwnProperty.call(patch, 'ownerId')
      ? assignmentStampForOwnerChange(client.ownerId, patch.ownerId)
      : {};
    return normalizeSalesClient({
      ...client,
      ...patch,
      ...ownerStamp,
      myphoner: patch.myphoner ? { ...(client.myphoner || {}), ...patch.myphoner } : client.myphoner,
      salesMigrations: patch.salesMigrations
        ? { ...(client.salesMigrations || {}), ...patch.salesMigrations }
        : client.salesMigrations,
      updatedAt: Object.prototype.hasOwnProperty.call(patch, 'updatedAt') ? patch.updatedAt : client.updatedAt,
    });
  });
  if (updated) writeState(next);
  return { total: state.length, updated };
}

/** After listen: restamp recent assignments. Sidecar flag so boot never rewrites the whole sales file. */
export function applyNyAssignmentBackfillOnce(nowMs = Date.now()) {
  const flagPath = getDataFilePath(`${NY_ASSIGNMENT_BACKFILL_KEY}.json`);
  if (existsSync(flagPath)) {
    try {
      const parsed = JSON.parse(readFileSync(flagPath, 'utf8'));
      if (parsed?.done) return { skipped: true, updated: 0 };
    } catch {
      // Flag unreadable — run once more.
    }
  }
  const nowIso = new Date(nowMs).toISOString();
  const patches = [];
  for (const client of readState()) {
    const id = sanitizeText(client?.id);
    const patch = planNyAssignmentBackfill(client, nowMs);
    if (!id || !patch?.assignedToRepAt) continue;
    patches.push({ id, patch: { assignedToRepAt: patch.assignedToRepAt } });
  }
  const result = patches.length ? patchSalesClientsById(patches) : { updated: 0 };
  writeFileSync(flagPath, JSON.stringify({
    done: true,
    at: nowIso,
    updated: Number(result.updated || 0),
  }, null, 2));
  return { skipped: false, updated: Number(result.updated || 0) };
}

export function deleteSalesClient(id) {
  const state = readState();
  const next = state.filter((entry) => entry.id !== id);
  if (next.length === state.length) return false;
  writeState(next);
  return true;
}

/** Attach (or replace) a Fireflies meeting reference on a client. A meeting belongs to one client at a time. */
export function linkMeetingToSalesClient(clientId, meetingRef = {}) {
  const meetingId = sanitizeText(meetingRef?.meetingId);
  if (!meetingId) return null;
  const state = readState();
  const index = state.findIndex((entry) => entry.id === sanitizeText(clientId));
  if (index === -1) return null;
  let changed = false;
  for (let i = 0; i < state.length; i += 1) {
    if (i === index) continue;
    const before = state[i].meetings.length;
    state[i].meetings = state[i].meetings.filter((entry) => entry.meetingId !== meetingId);
    if (state[i].meetings.length !== before) changed = true;
  }
  const current = state[index];
  const rest = current.meetings.filter((entry) => entry.meetingId !== meetingId);
  state[index] = normalizeSalesClient({ ...current, meetings: [meetingRef, ...rest], updatedAt: nowIso() });
  writeState(state);
  return state[index];
}

/**
 * Merge a patch into one client.meetings row on fresh data. `patch.recording` is merged into the
 * row's current recording state, not replaced (null clears it). Returns the updated client, or null
 * when the client or the row does not exist.
 */
export function patchSalesClientMeeting(clientId, meetingId, patch = {}) {
  const id = sanitizeText(meetingId);
  if (!id || !patch || typeof patch !== 'object') return null;
  const state = readState();
  const index = state.findIndex((entry) => entry.id === sanitizeText(clientId));
  if (index === -1) return null;
  const current = state[index];
  const rowIndex = current.meetings.findIndex((entry) => entry.meetingId === id);
  if (rowIndex === -1) return null;
  const row = current.meetings[rowIndex];
  const { recording, ...rest } = patch;
  const nextRow = {
    ...row,
    ...rest,
    meetingId: id,
    recording: recording === undefined
      ? row.recording
      : (recording === null ? null : mergeRecordingState(row.recording, recording)),
  };
  const meetings = current.meetings.slice();
  meetings[rowIndex] = nextRow;
  state[index] = normalizeSalesClient({ ...current, meetings, updatedAt: nowIso() });
  writeState(state);
  return state[index];
}

/**
 * Merge field patches into client.meetings rows of any clients in one write
 * ([{ clientId, meetingId, patch }]; a `recording` in a patch is ignored here). Rows that are gone are
 * skipped. Returns how many rows changed.
 */
export function patchSalesMeetingRows(entries = []) {
  const byClient = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const clientId = sanitizeText(entry?.clientId);
    const meetingId = sanitizeText(entry?.meetingId);
    if (!clientId || !meetingId || !entry.patch || typeof entry.patch !== 'object') continue;
    if (!byClient.has(clientId)) byClient.set(clientId, new Map());
    byClient.get(clientId).set(meetingId, entry.patch);
  }
  if (!byClient.size) return 0;
  const state = readState();
  let changed = 0;
  for (let i = 0; i < state.length; i += 1) {
    const patches = byClient.get(state[i].id);
    if (!patches) continue;
    let touched = false;
    const meetings = state[i].meetings.map((row) => {
      const patch = patches.get(row.meetingId);
      if (!patch) return row;
      const { recording, meetingId, ...rest } = patch;
      touched = true;
      changed += 1;
      return { ...row, ...rest };
    });
    if (touched) state[i] = normalizeSalesClient({ ...state[i], meetings, updatedAt: nowIso() });
  }
  if (changed) writeState(state);
  return changed;
}

export function unlinkMeetingFromSalesClient(clientId, meetingId) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === sanitizeText(clientId));
  if (index === -1) return null;
  const current = state[index];
  const next = current.meetings.filter((entry) => entry.meetingId !== sanitizeText(meetingId));
  if (next.length === current.meetings.length) return current;
  state[index] = normalizeSalesClient({ ...current, meetings: next, updatedAt: nowIso() });
  writeState(state);
  return state[index];
}

export function findSalesClientByMeetingId(meetingId) {
  const target = sanitizeText(meetingId);
  if (!target) return null;
  return readState().find((entry) => entry.meetings.some((meeting) => meeting.meetingId === target)) || null;
}

export function setSalesWorkshopAction(id, workshopAction, extras = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const nextAction = persistWorkshopAction(workshopAction);
  const startDate = offerStartDateFromWorkshopDueAt(nextAction?.dueAt || '');
  const quote = current.details?.meetingQuote && typeof current.details.meetingQuote === 'object'
    ? current.details.meetingQuote
    : {};
  const updates = {
    workshopAction: nextAction,
    details: {
      ...(current.details || {}),
      meetingQuote: { ...quote, startDate },
    },
  };
  if (Object.prototype.hasOwnProperty.call(extras, 'workshop')) {
    updates.workshop = persistWorkshopRecord(extras.workshop);
  }
  return updateSalesClient(id, updates);
}

export function setSalesWorkshop(id, workshop) {
  const current = getSalesClientById(id);
  if (!current) return null;
  return updateSalesClient(id, {
    workshop: persistWorkshopRecord(workshop),
  });
}

export function setSalesNotes(id, notes, meetingQuote) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const updates = {};
  if (notes !== undefined && notes !== null) updates.notes = sanitizeSalesNotes(notes);
  if (meetingQuote && typeof meetingQuote === 'object') {
    updates.details = {
      meetingQuote: { ...(current.details?.meetingQuote || {}), ...meetingQuote },
    };
  }
  if (!Object.keys(updates).length) return current;
  return updateSalesClient(id, updates);
}

export function appendSalesNote(id, text, at = nowIso()) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const notes = appendStampedSalesNote(current.notes, text, at);
  if (notes === sanitizeSalesNotes(current.notes)) return current;
  return updateSalesClient(id, { notes });
}

/** readUp = Les deg opp. noShow / skip move the client to Venter møtebekreftelse; missedCall = Ring for ny møtetid. */
export const SALES_PLAYBOOK_STEPS = ['readUp', 'noShow', 'skip', 'missedCall'];

function playbookStepError(message) {
  const error = new Error(message);
  error.code = 'PLAYBOOK_STEP';
  return error;
}

export function setSalesPlaybookStep(id, step, done) {
  const current = getSalesClientById(id);
  if (!current) return null;
  if (!SALES_PLAYBOOK_STEPS.includes(step)) throw playbookStepError('Ukjent steg.');
  const previous = current.salesPlaybook || {};
  if (step === 'readUp') {
    return updateSalesClient(id, {
      salesPlaybook: { ...previous, readUpAt: done ? (previous.readUpAt || nowIso()) : '' },
    });
  }
  const meetingAt = clientMeetingAtIso(current);
  const forThisMeeting = Boolean(previous.missedMeetingAt) && sameMeetingInstant(previous.missedMeetingAt, meetingAt);
  const cleared = { missedKind: '', missedAt: '', missedMeetingAt: '', missedCalledAt: '' };
  if (step === 'missedCall') {
    if (!meetingAt) throw playbookStepError('Kunden har ingen møtetid.');
    const kept = forThisMeeting ? previous : { ...previous, ...cleared, missedKind: 'auto', missedMeetingAt: meetingAt };
    return updateSalesClient(id, {
      salesPlaybook: { ...kept, missedCalledAt: done ? nowIso() : '' },
    });
  }
  if (!done) return updateSalesClient(id, { salesPlaybook: { ...previous, ...cleared } });
  if (current.progression?.meetingHeld || current.progression?.offerSent) {
    throw playbookStepError('Møtet er allerede markert som holdt.');
  }
  if (!meetingAt) throw playbookStepError('Kunden har ingen møtetid.');
  return updateSalesClient(id, {
    salesPlaybook: {
      ...previous,
      missedKind: step === 'noShow' ? 'noShow' : 'skipped',
      missedAt: nowIso(),
      missedMeetingAt: meetingAt,
      missedCalledAt: '',
    },
  });
}

export function salesProgressBlockedReason(client, key, options = {}) {
  return nextActionProgressBlockedReason(client, key, options);
}

export function markOfferDelivered(id) {
  const current = getSalesClientById(id);
  if (!current || current.progression?.offerSent) return current;
  const applied = applyOfferSentFromDelivery(current);
  if (applied.error) {
    const error = new Error(applied.error);
    error.code = 'PROGRESSION_BLOCKED';
    throw error;
  }
  const held = Boolean(applied.progression?.meetingHeld);
  const lockId = held
    ? (heldOfferLock(current) || pickLockedOfferMeetingId(current))
    : '';
  return updateSalesClient(id, {
    progression: applied.progression,
    nextActions: applied.nextActions,
    lockedOfferMeetingId: lockId,
  });
}

/** Any tilbud/contract send: stamp contractSentAt, then check Møte + Tilbud. */
export function markOfferSentOnDelivery(id, sentAt = '', extra = {}) {
  recordContractSent(id, sentAt, extra);
  return markOfferDelivered(id);
}

export function recordContractSent(id, sentAt = '', extra = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const contractSentAt = sanitizeText(current.contractSentAt) || sanitizeText(sentAt) || new Date().toISOString();
  const offerSentContent = normalizeOfferSentContent(extra.sentContent) || current.offerSentContent;
  const offerLetterFilledAt = extra.letterFilled
    ? (sanitizeText(current.offerLetterFilledAt) || new Date().toISOString())
    : current.offerLetterFilledAt;
  const stamped = { ...current, contractSentAt, offerSentContent, offerLetterFilledAt };
  const nextActions = stamped.progression?.offerSent
    ? ensureContractCheckupAction(stamped.nextActions, stamped)
    : stamped.nextActions;
  return updateSalesClient(id, { contractSentAt, offerSentContent, offerLetterFilledAt, nextActions });
}

export function markOfferLetterApprovedOnClient(id, approvedAt = '') {
  const current = getSalesClientById(id);
  if (!current) return null;
  const offerLetterApprovedAt = sanitizeText(current.offerLetterApprovedAt)
    || sanitizeText(approvedAt)
    || new Date().toISOString();
  return updateSalesClient(id, {
    offerSentContent: 'full',
    offerLetterApprovedAt,
    offerLetterFilledAt: sanitizeText(current.offerLetterFilledAt) || offerLetterApprovedAt,
  });
}

/** Byte size / page / hash of the PDF we actually emailed, so inbound copies can be compared. */
export function recordSentContractFingerprint(id, fingerprint = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const next = normalizeSentContractFingerprint({
    ...fingerprint,
    sentAt: sanitizeText(fingerprint?.sentAt) || nowIso(),
  });
  if (!next) return current;
  return updateSalesClient(id, { sentContractFingerprint: next });
}

export function setSalesProgress(id, key, value, { fastTrack = false } = {}) {
  const mapped = key === 'step0AgreeMeetingTime' ? 'meetingHeld' : key;
  if (!PROGRESSION_KEYS.includes(key) && mapped !== 'meetingHeld') return null;
  const current = getSalesClientById(id);
  if (!current) return null;
  const productGoals = getSalesGoalKeys(current.product);
  const leftoverKeys = ['checkIn1', 'checkIn2', 'domainConnected', 'live', 'step0AgreeMeetingTime'];
  if (!productGoals.includes(mapped) && !leftoverKeys.includes(mapped)) {
    return current;
  }
  if (isSsuSalesProduct(current.product) && (mapped === 'domainConnected' || mapped === 'live')) {
    return current;
  }
  const applied = applyProgressionChange(current, mapped, value, { fastTrack });
  if (applied.error) {
    const error = new Error(applied.error);
    error.code = 'PROGRESSION_BLOCKED';
    throw error;
  }
  const held = Boolean(applied.progression?.meetingHeld);
  const lockId = held
    ? (heldOfferLock(current) || pickLockedOfferMeetingId(current))
    : '';
  const turningOn = mapped === 'contractSigned' && Boolean(value) && !current.progression?.contractSigned;
  const turningOff = mapped === 'contractSigned' && !value;
  let next = {
    ...current,
    progression: applied.progression,
    nextActions: applied.nextActions,
    lockedOfferMeetingId: lockId,
    ...(turningOn ? { contractSignedAt: new Date().toISOString() } : {}),
    ...(turningOff ? { contractSignedAt: '' } : {}),
  };
  if (turningOn) next = ensureInformasjonAction(next);
  next = clampClientActionsToDueDate(next);
  return updateSalesClient(id, {
    progression: next.progression,
    nextActions: next.nextActions,
    lockedOfferMeetingId: lockId,
    contractSignedAt: next.contractSignedAt,
    workshop: next.workshop,
    workshopAction: next.workshopAction,
  });
}

export function setClientWebsiteDue(id, dueOverride = '') {
  const current = getSalesClientById(id);
  if (!current) return null;
  const next = clampClientActionsToDueDate({
    ...current,
    websiteDueOverride: normalizeDueDate(dueOverride),
  });
  return updateSalesClient(id, {
    websiteDueOverride: next.websiteDueOverride,
    workshop: next.workshop,
    workshopAction: next.workshopAction,
  });
}

export function liveJoinMeetingId(clientId, meetingAt = '') {
  const when = Date.parse(meetingAt);
  return `live:${sanitizeText(clientId)}:${Number.isFinite(when) ? when : 'open'}`;
}

function talkOfRow(row = {}) {
  const counted = row.sentenceCount === '' || row.sentenceCount == null ? NaN : Number(row.sentenceCount);
  return {
    sentences: Number.isFinite(counted) ? counted : (row.hasTranscript ? 1 : 0),
    minutes: Number(row.durationMinutes) || 0,
    known: Number.isFinite(counted),
  };
}

/**
 * The offer lock while it names a real recording with talk on the card: a placeholder, a recording that
 * left, or a silent one (a fragment from before the client came) is no lock, and a fragment of a few
 * sentences (a "hallo?") holds only until a recording with real talk is the one to pick.
 */
function heldOfferLock(client = {}) {
  const lock = sanitizeText(client.lockedOfferMeetingId);
  if (!lock || lock.toLowerCase().startsWith('live:')) return '';
  const meetings = Array.isArray(client.meetings) ? client.meetings : [];
  const row = meetings.find((item) => item?.meetingId === lock);
  if (!row || !(talkOfRow(row).sentences > 0)) return '';
  if (talkCoversPlaceholder(talkOfRow(row))) return lock;
  const best = meetings.find((item) => item?.meetingId === pickLockedOfferMeetingId(client));
  return best && best !== row && talkCoversPlaceholder(talkOfRow(best)) ? '' : lock;
}

/**
 * The recording the offer is locked to once "Møtet hatt" is ticked: of the sales meeting's recordings
 * with talk, the one a person picked as the sales meeting first, then one with more than a fragment of
 * talk (lib/fireflies-slots.js talkCoversPlaceholder), then the booked slot's, then the most talk; else
 * the first other recording with talk that is not a workshop or iteration. Never a live-join placeholder
 * or a recording without talk: '' until one is linked, which re-points it.
 * `talkOf(row)` → { sentences, minutes, known }; server code reads the stored copy.
 */
export function pickLockedOfferMeetingId(client = {}, { talkOf = talkOfRow } = {}) {
  const meetings = (Array.isArray(client.meetings) ? client.meetings : [])
    .filter((item) => sanitizeText(item?.meetingId) && !sanitizeText(item.meetingId).toLowerCase().startsWith('live:'));
  const meetingMs = client.agreedTime ? Date.parse(client.meetingAt || '') : NaN;
  const salesKey = Number.isFinite(meetingMs) ? `sales:${meetingMs}` : '';
  const onSlot = (item) => Boolean(salesKey) && sanitizeText(item.slotKey) === salesKey;
  const sentencesOf = (item) => Number((talkOf(item) || {}).sentences) || 0;
  const rank = (item) => {
    const picked = Boolean(sanitizeText(item.purposePickedAt)) && item.purpose === 'sales';
    const covers = talkCoversPlaceholder(talkOf(item) || {});
    return [picked ? 1 : 0, covers ? 1 : 0, onSlot(item) ? 1 : 0, sentencesOf(item), Number((talkOf(item) || {}).minutes) || 0];
  };
  const sales = meetings
    .filter((item) => (item.forSalesMeeting || item.purpose === 'sales' || onSlot(item)) && sentencesOf(item) > 0)
    .map((item) => ({ item, rank: rank(item) }))
    .sort((a, b) => b.rank.reduce((diff, value, i) => diff || value - a.rank[i], 0))[0]?.item;
  if (sales) return sanitizeText(sales.meetingId);
  const other = meetings.find((item) => sentencesOf(item) > 0 && item.purpose !== 'workshop' && item.purpose !== 'iteration');
  return sanitizeText(other?.meetingId);
}

export function setSalesNextAction(id, patch = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const applied = applyNextActionMutation(current, patch);
  if (applied.error) {
    const error = new Error(applied.error);
    error.code = 'NEXT_ACTION_INVALID';
    throw error;
  }
  const updates = { nextActions: applied.nextActions };
  if (applied.progression) updates.progression = applied.progression;
  if (Object.prototype.hasOwnProperty.call(applied, 'meetingAt')) {
    updates.meetingAt = applied.meetingAt;
    updates.agreedTime = Boolean(applied.agreedTime);
    if (applied.meetingAt) {
      updates.meetingAtSource = sanitizeText(applied.meetingAtSource) || 'sales';
    }
  }
  if (applied.meetingMode) updates.meetingMode = applied.meetingMode;
  return updateSalesClient(id, updates);
}

export function setSalesDevelopment(id, key, value) {
  if (!DEVELOPMENT_KEYS.includes(key)) return null;
  const current = getSalesClientById(id);
  if (!current || isSsuSalesProduct(current.product)) return null;
  const turningOn = key === 'v1Ferdig' && Boolean(value) && !current.development?.v1Ferdig;
  let next = {
    ...current,
    development: {
      ...(current.development || {}),
      [key]: Boolean(value),
    },
  };
  if (turningOn) next = ensureFeedbackAction(next);
  next = clampClientActionsToDueDate(next);
  return updateSalesClient(id, {
    development: {
      [key]: Boolean(value),
    },
    workshop: next.workshop,
    workshopAction: next.workshopAction,
  });
}

/** Stamp product brackets from MyPhoner list metadata for existing rows. */
export function backfillSalesClientProducts({ forceFromList = true } = {}) {
  const state = readState();
  let updated = 0;
  const next = state.map((client) => {
    const fromList = resolveSalesProductFromMyphoner({
      listId: client.myphoner?.listId,
      listName: client.myphoner?.listName,
    });
    const previous = normalizeSalesProduct(client.product);
    const product = forceFromList
      ? fromList
      : previous || fromList;
    if (product === previous && client.product === product) return client;
    updated += 1;
    return normalizeSalesClient({
      ...client,
      product,
      updatedAt: nowIso(),
    });
  });
  writeState(next);
  return {
    total: next.length,
    updated,
    ssu: next.filter((entry) => entry.product === 'ssu').length,
    asoldi: next.filter((entry) => entry.product === 'asoldi').length,
  };
}

export function backfillSmsRemindersToMeeting() {
  const state = readState();
  let updated = 0;
  const next = state.map((client) => {
    if (normalizeSalesStatus(client.status) === 'not-sold') return client;
    if (!client.agreedTime || !client.meetingAt) return client;
    if (client.progression?.meetingHeld || clientIsSalesWin(client)) return client;
    const nextActions = decorateNextActions(client);
    const before = (Array.isArray(client.nextActions) ? client.nextActions : [])
      .find((action) => action.presetKey === 'sms1h' && !action.doneAt);
    const after = nextActions.find((action) => action.presetKey === 'sms1h' && !action.doneAt);
    if (
      after
      && before
      && sanitizeText(before.dueAt) === sanitizeText(after.dueAt)
      && (before.relativeToMeetingHours ?? null) === (after.relativeToMeetingHours ?? null)
    ) {
      return client;
    }
    if (!after) return client;
    updated += 1;
    return normalizeSalesClient({
      ...client,
      nextActions,
      updatedAt: nowIso(),
    });
  });
  if (updated) writeState(next);
  return { scanned: state.length, updated };
}

export function previewNamedMeetingTimeBackfills() {
  const clients = getSalesClients();
  const details = [];
  for (const target of MEETING_TIME_BACKFILL_TARGETS) {
    const matches = clients.filter((client) => (
      target.match(client) && normalizeSalesStatus(client.status) !== 'not-sold'
    ));
    if (!matches.length) {
      details.push({
        target: target.id,
        label: target.label,
        status: 'unmatched',
        meetingAt: target.meetingAt,
      });
      continue;
    }
    for (const client of matches) {
      const alreadySame = Boolean(client.agreedTime)
        && sameMeetingInstant(client.meetingAt, target.meetingAt);
      details.push({
        target: target.id,
        label: target.label,
        status: alreadySame ? 'already-set' : 'would-update',
        clientId: client.id,
        businessName: client.businessName,
        contactPerson: client.contactPerson,
        fromMeetingAt: client.meetingAt,
        toMeetingAt: target.meetingAt,
        ownerId: client.ownerId,
      });
    }
  }
  return { details, patched: 0 };
}

export function applyNamedMeetingTimeBackfills() {
  const clients = getSalesClients();
  const details = [];
  const patches = [];
  for (const target of MEETING_TIME_BACKFILL_TARGETS) {
    const matches = clients.filter((client) => (
      target.match(client) && normalizeSalesStatus(client.status) !== 'not-sold'
    ));
    if (!matches.length) {
      details.push({
        target: target.id,
        label: target.label,
        status: 'unmatched',
        meetingAt: target.meetingAt,
      });
      continue;
    }
    for (const client of matches) {
      const alreadySame = Boolean(client.agreedTime)
        && sameMeetingInstant(client.meetingAt, target.meetingAt);
      const nextActions = decorateNextActions({
        ...client,
        agreedTime: true,
        meetingAt: target.meetingAt,
      });
      patches.push({
        id: client.id,
        patch: {
          agreedTime: true,
          meetingAt: target.meetingAt,
          nextActions,
        },
      });
      details.push({
        target: target.id,
        label: target.label,
        status: alreadySame ? 'already-set' : 'updated',
        clientId: client.id,
        businessName: client.businessName,
        contactPerson: client.contactPerson,
        fromMeetingAt: client.meetingAt,
        toMeetingAt: target.meetingAt,
        ownerId: client.ownerId,
      });
    }
  }
  const result = patchSalesClientsById(patches);
  return { details, patched: result.updated };
}

export function setSalesCalendar(id, calendarPatch = {}) {
  return updateSalesClient(id, { calendar: calendarPatch });
}

export function setSalesWebsiteImport(id, importPatch = {}) {
  return updateSalesClient(id, { websiteImport: importPatch });
}

/** WS8.56: mark or unmark a sales client as a test client (Superadmin). */
export function setSalesTestFlag(id, isTest) {
  return updateSalesClient(id, { isTest: isTest === true });
}

export function setSalesMakerRun(id, makerPatch = {}) {
  const current = getSalesClientById(id);
  return updateSalesClient(id, { makerRun: mergeMakerRunPatch(current?.makerRun || {}, makerPatch) });
}

/**
 * WS8.28: writes the makerRun keys the Maker's delivery events own (materials, autopilot,
 * previewPush), normalized. Only the authenticated callback handler calls this.
 */
export function setSalesMakerRunOwned(id, ownedPatch = {}) {
  const patch = {};
  for (const key of OWNED_MAKERRUN_KEYS) {
    if (ownedPatch && Object.prototype.hasOwnProperty.call(ownedPatch, key)) patch[key] = ownedPatch[key];
  }
  if (!Object.keys(patch).length) return getSalesClientById(id);
  return updateSalesClientInternal(id, { makerRun: patch });
}

/**
 * WS8.3: stores client.sitePlan (normalized) with a history entry when the tier, services, billing
 * or status change. Returns the client, or null when the client or the plan is not valid.
 */
export function setSalesSitePlan(id, plan, { by = '', reason = '', now = nowIso() } = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const next = withPlanHistory(plan, current.sitePlan, { at: now, by, reason });
  if (!next) return null;
  if (JSON.stringify(normalizeSitePlan(current.sitePlan)) === JSON.stringify(next)) return current;
  const updated = updateSalesClientInternal(id, { sitePlan: next });
  appendDeliveryAudit({ at: now, kind: 'site-plan', clientId: id, by, reason, to: next.tierId, status: next.status });
  return updated;
}

/**
 * WS8.9: merges a delivery patch (events and emails shallow, every other key replaces) and
 * writes only when something changed. Returns the client.
 */
export function setSalesDelivery(id, patch = {}, { by = '', reason = '' } = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const next = mergeDelivery(current.delivery, patch);
  if (current.delivery && JSON.stringify(normalizeDelivery(current.delivery)) === JSON.stringify(next)) return current;
  const updated = updateSalesClientInternal(id, { delivery: next });
  if (by || reason) appendDeliveryAudit({ kind: 'delivery', clientId: id, by, reason, keys: Object.keys(patch || {}) });
  return updated;
}

/**
 * WS8.9: one email stamp in delivery.emails and its legacy mirror in workshop.deskEmails, in one
 * write, so the two never diverge. `key` is a delivery email key or `dataReminders`.
 */
export function stampDeliveryEmail(id, key, at = nowIso(), { by = '' } = {}) {
  return stampDeliveryEmails(id, { [key]: at }, { by });
}

/**
 * Several stamps in one write ({ key: at }). `backfilled` records the keys in
 * delivery.emails.backfilled (the backfill stamps clients already past those emails).
 */
export function stampDeliveryEmails(id, stamps = {}, { by = '', backfilled = false } = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const keys = Object.keys(stamps || {});
  if (!keys.length) return current;
  let delivery = normalizeDelivery(current.delivery);
  const deskEmails = {};
  for (const key of keys) {
    const patch = deliveryEmailStampPatch({ ...current, delivery }, key, stamps[key]);
    delivery = mergeDelivery(delivery, { emails: patch.emails });
    Object.assign(deskEmails, patch.deskEmails);
  }
  if (backfilled) {
    delivery = mergeDelivery(delivery, { emails: { backfilled: [...new Set([...delivery.emails.backfilled, ...keys])] } });
  }
  const updates = { delivery };
  if (Object.keys(deskEmails).length) {
    const workshop = current.workshop && typeof current.workshop === 'object' ? current.workshop : {};
    updates.workshop = { ...workshop, deskEmails: { ...(workshop.deskEmails || {}), ...deskEmails } };
  }
  const updated = updateSalesClientInternal(id, updates);
  appendDeliveryAudit({ kind: 'email-stamp', clientId: id, by, keys, backfilled });
  return updated;
}

/**
 * WS8.9: derives the client's stage and stores it (with one history entry) only when it changed.
 * Idempotent. Returns { client, changed, derived, change }.
 */
export function syncSalesDeliveryStage(id, { by = '', reason = '', now = Date.now(), jobs } = {}) {
  const current = getSalesClientById(id);
  if (!current) return { client: null, changed: false, derived: null };
  const plan = planStageWrite(current, { now, by, reason, jobs });
  if (!plan.changed) return { client: current, changed: false, derived: plan.derived };
  const client = updateSalesClientInternal(id, { delivery: plan.delivery });
  appendDeliveryAudit({ kind: 'stage', clientId: id, by, reason, from: plan.change.from, to: plan.change.to, overlay: plan.change.overlay });
  return { client, changed: true, derived: plan.derived, change: plan.change };
}

/**
 * WS0.19: the only writer of makerRun.aiSpend (the Maker's run.ai.spend callback, after its token and
 * linked-run checks). Stores the run's spend snapshot when it belongs to the linked run and is not older
 * than the stored one. The snapshot's own `at` is required, so a delayed retry is never taken for the
 * newest; at the same `at`, a snapshot with fewer calls is the older one. Returns { client, stored, reason }.
 */
export function setSalesMakerRunAiSpend(id, aiSpend = {}) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === id);
  if (index === -1) return { client: null, stored: false, reason: 'not-found' };
  const current = state[index];
  const runId = sanitizeText(current.makerRun?.runId);
  if (!Number.isFinite(Date.parse(sanitizeText(aiSpend?.at)))) return { client: current, stored: false, reason: 'missing-at' };
  const next = normalizeRunAiSpend(aiSpend, { runId, receivedAt: nowIso() });
  if (!next) return { client: current, stored: false, reason: 'invalid' };
  if (!runId || next.runId !== runId) return { client: current, stored: false, reason: 'not-linked-run' };
  const previous = current.makerRun?.aiSpend;
  if (previous?.runId === runId && previous.at && next.at) {
    const fewerCallsAtSameTime = previous.at === next.at && Number.isInteger(previous.calls) && (!Number.isInteger(next.calls) || next.calls < previous.calls);
    if (previous.at > next.at || fewerCallsAtSameTime) return { client: current, stored: false, reason: 'older' };
  }
  const updated = normalizeSalesClient({
    ...current,
    makerRun: { ...current.makerRun, aiSpend: next },
    updatedAt: nowIso(),
  });
  state[index] = updated;
  writeState(state);
  return { client: updated, stored: true, reason: '' };
}

/** Replace makerRun instead of merging, so a client can be unlinked for a new run. */
export function replaceSalesMakerRun(id, makerRun = {}) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const current = state[index];
  const next = normalizeSalesClient({
    ...current,
    makerRun: makerRun && typeof makerRun === 'object' ? withoutKeys(makerRun, WRITER_ONLY_MAKERRUN_KEYS) : {},
    updatedAt: nowIso(),
  });
  state[index] = next;
  writeState(state);
  return next;
}

/** Replace websiteImport instead of merging, so a preview link can be moved or cleared. */
export function replaceSalesWebsiteImport(id, websiteImport = {}) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const current = state[index];
  const next = normalizeSalesClient({
    ...current,
    websiteImport: websiteImport && typeof websiteImport === 'object' ? websiteImport : {},
    updatedAt: nowIso(),
  });
  state[index] = next;
  writeState(state);
  return next;
}

export function setSalesDeveloperQa(id, qaPatch = {}) {
  return updateSalesClient(id, { developerQa: qaPatch });
}

export function setSalesPreviewDocument(id, previewDocument) {
  return updateSalesClient(id, { previewDocument: persistPreviewDocument(previewDocument) });
}

export function setSalesProjectTodoDone(id, todoId, done) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const record = getWorkshopRecord(current);
  const nextDoc = markProjectTodoDone(record.projectDocument, todoId, done);
  if (!nextDoc) return current;
  return updateSalesClient(id, {
    workshop: persistWorkshopRecord({
      ...record,
      projectDocument: nextDoc,
    }),
  });
}

export function setSalesDeveloperGoals(id, goalsPatch = {}) {
  return updateSalesClient(id, { developerGoals: goalsPatch });
}

export function setSalesStatus(id, status, archivePatch = {}) {
  const normalizedStatus = normalizeSalesStatus(status);
  if (normalizedStatus === 'secondary') {
    return updateSalesClient(id, {
      status: 'secondary',
      secondaryInterest: normalizeSecondaryInterest(archivePatch.interest || archivePatch.secondaryInterest),
      archive: {
        archivedAt: sanitizeText(archivePatch.archivedAt) || nowIso(),
        reason: sanitizeText(archivePatch.reason),
      },
    });
  }
  if (normalizedStatus === 'not-sold') {
    return updateSalesClient(id, {
      status: 'not-sold',
      secondaryInterest: '',
      archive: {
        archivedAt: sanitizeText(archivePatch.archivedAt) || nowIso(),
        reason: sanitizeText(archivePatch.reason),
      },
    });
  }
  return updateSalesClient(id, {
    status: normalizedStatus,
    secondaryInterest: '',
    archive: {
      archivedAt: '',
      reason: '',
    },
  });
}

/**
 * New 3d/24h/1h stamps from meetingAt, sent stamps cleared. `keepSent24h`: when the meeting is now inside
 * 24 hours, a 24h mail that already went out stays counted, so the catch-up never sends a second "om 24 timer".
 */
export function rescheduleSalesReminders(id, nowMs = Date.now(), { keepSent24h = false } = {}) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const schedule = deriveReminderSchedule(current, nowMs);
  const kept24h = keepSent24h && !schedule.reminder24hAt ? sanitizeText(current.reminders?.reminder24hSentAt) : '';
  return updateSalesClient(id, {
    reminders: {
      reminder3dAt: schedule.reminder3dAt,
      reminder24hAt: schedule.reminder24hAt,
      reminder1hAt: schedule.reminder1hAt,
      reminder3dSentAt: '',
      reminder24hSentAt: kept24h,
      reminder1hSentAt: '',
      skipDueToShortNotice: schedule.skipDueToShortNotice,
    },
  });
}

export function markSalesReminderSent(id, key, at = nowIso()) {
  const patch = {};
  if (key === 'thankYou') patch.thankYouSentAt = at;
  if (key === '3d') patch.reminder3dSentAt = at;
  if (key === '24h') patch.reminder24hSentAt = at;
  if (key === '1h') patch.reminder1hSentAt = at;
  if (!Object.keys(patch).length) return null;
  return updateSalesClient(id, { reminders: patch });
}

export function applySilentOwnerPatches(entries = []) {
  const now = nowIso();
  const patches = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = sanitizeText(entry?.id);
    const ownerId = sanitizeText(entry?.ownerId || entry?.patch?.ownerId);
    if (!id || !ownerId) continue;
    patches.push({ id, patch: { ownerId, updatedAt: now } });
  }
  return patchSalesClientsById(patches);
}

/** Every calendar.* field blank: the card no longer points at a Google event. */
function emptyMeetingCalendar() {
  return {
    eventId: '',
    htmlLink: '',
    meetLink: '',
    confirmedMeetLink: '',
    calendarId: '',
    accountKey: '',
    googleEmail: '',
    organizerEmail: '',
    creatorEmail: '',
    meetHostVerifiedEmail: '',
    iCalUID: '',
    syncedAt: '',
    guestInvitedAt: '',
    firefliesInvitedAt: '',
    firefliesLiveJoinedAt: '',
    firefliesLiveJoinAttemptAt: '',
    firefliesLiveJoinError: '',
    firefliesLiveJoinedMeetLink: '',
    inviteSequence: 0,
  };
}

export function clearSalesMeetingScheduling(id) {
  return updateSalesClient(id, {
    reminders: {
      reminder3dAt: '',
      reminder24hAt: '',
      reminder1hAt: '',
      reminder3dSentAt: '',
      reminder24hSentAt: '',
      reminder1hSentAt: '',
      skipDueToShortNotice: false,
    },
    calendar: emptyMeetingCalendar(),
  });
}

/** Rep tasks pinned to the meeting clock. They close when the meeting is voided. */
const VOID_CLOSES_PRESETS = new Set(['sms24h', 'call2h', 'meetingBooked']);

/** Rows whose time is read as the meeting time (clientMeetingAtIso). */
const MEETING_TIME_PRESETS = new Set(['meeting', 'meetingBooked']);

/** A ticked Møte / Møtet booket row at the cancelled time keeps no time, so nothing reads it as the meeting. */
function voidedDoneAction(action, cancelledMeetingAt) {
  if (!cancelledMeetingAt || !MEETING_TIME_PRESETS.has(action?.presetKey)) return action;
  return sameMeetingInstant(action.dueAt, cancelledMeetingAt) ? { ...action, dueAt: '' } : action;
}

/** One action row after a void: the meeting row loses its time, follower tasks close, the SMS reminder goes. */
function voidedMeetingAction(action, { note, stamp, cancelledMeetingAt }) {
  if (action?.doneAt) return voidedDoneAction(action, cancelledMeetingAt);
  if (action?.presetKey === 'meeting') {
    return {
      ...action,
      dueAt: '',
      relativeToMeetingHours: null,
      sticky: false,
      stickyAnchorId: '',
      stickyOffsetMs: null,
      note: appendActionNote(action.note, note),
    };
  }
  if (action?.presetKey === 'sms1h') return null;
  if (VOID_CLOSES_PRESETS.has(action?.presetKey)) {
    return { ...action, dueAt: action.presetKey === 'meetingBooked' ? '' : action.dueAt, doneAt: stamp };
  }
  return action;
}

/**
 * Client cancelled and gave no new time: no meetingAt, no reminder (thank-you included, so the next booking
 * re-confirms), no calendar link, and the open meeting row keeps no time. Stores the cancelled time so
 * MyPhoner cannot bring it back. The Google event is the caller's job. Null (nothing written) when the card
 * is missing, past the meeting stage (Tilbud, Venter signering, Solgt) or not active.
 */
export function voidSalesMeetingTime(id, { note = '', nowMs = Date.now() } = {}) {
  const current = getSalesClientById(id);
  if (!current || salesMeetingStageBlockedReason(current)) return null;
  const stamp = new Date(nowMs).toISOString();
  const previousPlaybook = current.salesPlaybook || {};
  const cancelledMeetingAt = clientMeetingAtIso(current) || sanitizeText(previousPlaybook.cancelledMeetingAt);
  const nextActions = (current.nextActions || [])
    .map((action) => voidedMeetingAction(action, { note, stamp, cancelledMeetingAt }))
    .filter(Boolean);
  return updateSalesClient(id, {
    agreedTime: false,
    meetingAt: '',
    meetingAtSource: '',
    nextActions,
    reminders: emptyReminders(),
    calendar: emptyMeetingCalendar(),
    salesPlaybook: {
      ...previousPlaybook,
      cancelledMeetingAt,
      cancelledAt: stamp,
    },
  });
}

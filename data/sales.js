import { readFileSync, existsSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';
import { DEVELOPMENT_KEYS, normalizeDevelopment } from '../lib/development-phase.js';
import { normalizeStoredWebsiteEmail } from '../lib/sales-website-email.js';
import {
  applyNextActionMutation,
  applyProgressionChange,
  applyMeetingHeldOrphanReset,
  clientIsSalesWin,
  decorateNextActions,
  getSalesGoalKeys,
  inferMeetingHeld,
  MEETING_TIME_BACKFILL_TARGETS,
  normalizeMeetingAtSource,
  sameMeetingInstant,
  salesProgressBlockedReason as nextActionProgressBlockedReason,
} from '../lib/sales-next-actions.js';
import { calendarDurationForMode } from '../lib/sales-meeting-duration.js';

const SALES_PATH = getDataFilePath('sales-clients.json');

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

function writeSalesFile(list) {
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

function normalizeMakerRun(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    runId: sanitizeText(input.runId),
    dashboardUrl: sanitizeText(input.dashboardUrl),
    previewUrl: sanitizeText(input.previewUrl),
    latestReadyStep: sanitizeText(input.latestReadyStep),
    latestStepStatus: sanitizeText(input.latestStepStatus),
    intakeStatus: sanitizeText(input.intakeStatus),
    exportPath: sanitizeText(input.exportPath),
    statusUpdatedAt: sanitizeText(input.statusUpdatedAt),
    fieldsSyncedAt: sanitizeText(input.fieldsSyncedAt),
    industry: sanitizeText(input.industry),
    createdAt: sanitizeText(input.createdAt),
  };
}

function normalizeHubSite(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    siteKey: sanitizeText(input.siteKey || input.site_key),
    domain: sanitizeText(input.domain),
    id: sanitizeText(input.id),
    createdAt: sanitizeText(input.createdAt),
    liveUrl: sanitizeText(input.liveUrl),
  };
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
    calendarId: sanitizeText(input.calendarId),
    accountKey: sanitizeText(input.accountKey),
    syncedAt: sanitizeText(input.syncedAt),
    guestInvitedAt: sanitizeText(input.guestInvitedAt),
    firefliesInvitedAt: sanitizeText(input.firefliesInvitedAt),
    firefliesLiveJoinedAt: sanitizeText(input.firefliesLiveJoinedAt),
    firefliesLiveJoinAttemptAt: sanitizeText(input.firefliesLiveJoinAttemptAt),
    firefliesLiveJoinError: sanitizeText(input.firefliesLiveJoinError),
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

function normalizeMeetingQuote(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const selected = Array.isArray(input.selected)
    ? input.selected.map((entry) => sanitizeText(entry)).filter(Boolean)
    : [];
  const oneTimeAddOns = Array.isArray(input.oneTimeAddOns)
    ? input.oneTimeAddOns.map((entry) => sanitizeText(entry)).filter(Boolean)
    : [];
  const pages = Number(input.pages);
  return {
    tierId: sanitizeText(input.tierId) || 'starter',
    customMode: Boolean(input.customMode),
    oneTime: Boolean(input.oneTime),
    pages: Number.isFinite(pages) && pages >= 1 ? Math.round(pages) : 5,
    selected,
    oneTimeAddOns,
    customSections: sanitizeText(input.customSections).slice(0, MAX_SALES_NOTES_LENGTH),
    startDate: sanitizeText(input.startDate),
    productNotes: sanitizeText(input.productNotes).slice(0, MAX_SALES_NOTES_LENGTH),
    productGoal: sanitizeText(input.productGoal).slice(0, MAX_SALES_NOTES_LENGTH),
    identity: sanitizeText(input.identity).slice(0, MAX_SALES_NOTES_LENGTH),
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
  return {
    instagramUrl: sanitizeText(input.instagramUrl),
    facebookUrl: sanitizeText(input.facebookUrl),
    proffUrl: sanitizeText(input.proffUrl),
    otherLinks: sanitizeText(input.otherLinks),
    googleBusinessProfile: sanitizeText(input.googleBusinessProfile),
    emailCustomNeed: sanitizeText(input.emailCustomNeed),
    meetingQuote: normalizeMeetingQuote(input.meetingQuote),
    editEmailBeforeSend: parseSalesBoolean(input.editEmailBeforeSend),
  };
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

const MAX_CLIENT_MEETINGS = 12;

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
      liveJoinedAt: sanitizeText(raw.liveJoinedAt),
      source: sanitizeText(raw.source),
      linkedAt: sanitizeText(raw.linkedAt) || nowIso(),
      linkedBy: sanitizeText(raw.linkedBy) || 'auto',
      forSalesMeeting: Boolean(raw.forSalesMeeting),
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
    product,
    businessName: sanitizeText(raw.businessName),
    contactPerson: sanitizeText(raw.contactPerson),
    contactEmail: sanitizeText(raw.contactEmail),
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
    myphoner,
    progression: nextProgression,
    salesMigrations: reset.salesMigrations,
    nextActions: reset.nextActions,
    development: product === 'ssu' ? normalizeDevelopment() : normalizeDevelopment(raw.development),
    reminders: normalizeReminders(raw.reminders || emptyReminders()),
    calendar: normalizeCalendar(raw.calendar),
    meetings: normalizeMeetings(raw.meetings),
    lockedOfferMeetingId: sanitizeText(raw.lockedOfferMeetingId),
    websiteImport: product === 'ssu' ? normalizeWebsiteImport() : normalizeWebsiteImport(raw.websiteImport),
    makerRun: product === 'ssu' ? normalizeMakerRun() : normalizeMakerRun(raw.makerRun),
    hubSite: product === 'ssu' ? normalizeHubSite() : normalizeHubSite(raw.hubSite),
    status,
    archive: status === 'not-sold' || status === 'secondary' ? archive : normalizeArchive(),
    createdAt,
    updatedAt,
  };
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
  if (previous.length && (needsOrphanWrite || needsFollowUpWrite)) {
    writeSalesFile(list);
  }
  return list;
}

function writeState(items) {
  writeSalesFile(items.map(normalizeSalesClient));
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

export function createSalesClient(input = {}) {
  const state = readState();
  const now = nowIso();
  const client = normalizeSalesClient({
    ...input,
    id: input.id || makeId(),
    createdAt: now,
    updatedAt: now,
    reminders: input.reminders || emptyReminders(),
  });
  state.push(client);
  writeState(state);
  return client;
}

export function updateSalesClient(id, updates = {}) {
  const state = readState();
  const index = state.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const current = state[index];
  const mergedDetails = updates.details && typeof updates.details === 'object'
    ? { ...(current.details || {}), ...updates.details }
    : current.details;
  const next = normalizeSalesClient({
    ...current,
    ...updates,
    details: mergedDetails,
    progression: updates.progression
      ? { ...current.progression, ...updates.progression }
      : current.progression,
    nextActions: Object.prototype.hasOwnProperty.call(updates, 'nextActions')
      ? updates.nextActions
      : current.nextActions,
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
    makerRun: updates.makerRun
      ? { ...current.makerRun, ...updates.makerRun }
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

/** One write for many client patches. Myphoner and migration objects are merged. */
export function patchSalesClientsById(entries = []) {
  const byId = new Map();
  for (const entry of entries) {
    const id = sanitizeText(entry?.id);
    if (!id || !entry?.patch || typeof entry.patch !== 'object') continue;
    byId.set(id, entry.patch);
  }
  if (!byId.size) return { total: 0, updated: 0 };
  const state = readState();
  let updated = 0;
  const next = state.map((client) => {
    const patch = byId.get(client.id);
    if (!patch) return client;
    updated += 1;
    return normalizeSalesClient({
      ...client,
      ...patch,
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

export function salesProgressBlockedReason(client, key, options = {}) {
  return nextActionProgressBlockedReason(client, key, options);
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
    ? (sanitizeText(current.lockedOfferMeetingId) || pickLockedOfferMeetingId(current))
    : '';
  return updateSalesClient(id, {
    progression: applied.progression,
    nextActions: applied.nextActions,
    lockedOfferMeetingId: lockId,
  });
}

export function liveJoinMeetingId(clientId, meetingAt = '') {
  const when = Date.parse(meetingAt);
  return `live:${sanitizeText(clientId)}:${Number.isFinite(when) ? when : 'open'}`;
}

function pickLockedOfferMeetingId(client = {}) {
  const meetings = Array.isArray(client.meetings) ? client.meetings : [];
  const salesMeeting = meetings.find((item) => item?.forSalesMeeting);
  return sanitizeText(salesMeeting?.meetingId || meetings[0]?.meetingId);
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
  return updateSalesClient(id, updates);
}

export function setSalesDevelopment(id, key, value) {
  if (!DEVELOPMENT_KEYS.includes(key)) return null;
  const current = getSalesClientById(id);
  if (!current || isSsuSalesProduct(current.product)) return null;
  return updateSalesClient(id, {
    development: {
      [key]: Boolean(value),
    },
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
      && Number(before.relativeToMeetingHours) === 24
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

export function setSalesMakerRun(id, makerPatch = {}) {
  return updateSalesClient(id, { makerRun: makerPatch });
}

export function setSalesStatus(id, status, archivePatch = {}) {
  const normalizedStatus = normalizeSalesStatus(status);
  if (normalizedStatus === 'not-sold' || normalizedStatus === 'secondary') {
    return updateSalesClient(id, {
      status: normalizedStatus,
      archive: {
        archivedAt: sanitizeText(archivePatch.archivedAt) || nowIso(),
        reason: sanitizeText(archivePatch.reason),
      },
    });
  }
  return updateSalesClient(id, {
    status: normalizedStatus,
    archive: {
      archivedAt: '',
      reason: '',
    },
  });
}

export function rescheduleSalesReminders(id, nowMs = Date.now()) {
  const current = getSalesClientById(id);
  if (!current) return null;
  const schedule = deriveReminderSchedule(current, nowMs);
  return updateSalesClient(id, {
    reminders: {
      reminder3dAt: schedule.reminder3dAt,
      reminder24hAt: schedule.reminder24hAt,
      reminder1hAt: schedule.reminder1hAt,
      reminder3dSentAt: '',
      reminder24hSentAt: '',
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
    calendar: {
      eventId: '',
      htmlLink: '',
      meetLink: '',
      calendarId: '',
      accountKey: '',
      syncedAt: '',
      guestInvitedAt: '',
      firefliesInvitedAt: '',
      firefliesLiveJoinedAt: '',
      firefliesLiveJoinAttemptAt: '',
      firefliesLiveJoinError: '',
      inviteSequence: 0,
    },
  });
}

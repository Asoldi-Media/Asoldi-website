import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';
import { CUSTOM_TIER_ID, tierById } from '../lib/website-tiers.js';
import { normalizeDueDate } from '../lib/website-due.js';

/**
 * Offer (tilbud) drafts: the offer email + product blocks + contract summary for one sales client.
 *
 * Lifecycle: draft -> (review-requested -> verified) -> sent
 *  - Tier 1-3 offers without "kjør via admin først" go draft -> sent directly.
 *  - Custom tier, or when the rep asks for review, must pass through admin verification.
 */

const OFFERS_PATH = getDataFilePath('sales-offers.json');

export const OFFER_STATUSES = ['draft', 'review-requested', 'verified', 'sent'];
const MAX_HISTORY = 60;
const MAX_HTML_LENGTH = 600_000;
const MAX_INTENT_TEXT = 2000;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function sanitizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => sanitizeText(item)).filter(Boolean);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOffersFile() {
  ensurePersistentDataDir();
  if (!existsSync(OFFERS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(OFFERS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let offersRevision = 0;

export function offersDataRevision() {
  return offersRevision;
}

function writeOffersFile(list) {
  offersRevision += 1;
  ensurePersistentDataDir();
  writeDataJson(OFFERS_PATH, list);
}

export function normalizeOfferStatus(value = '') {
  const status = sanitizeText(value);
  return OFFER_STATUSES.includes(status) ? status : 'draft';
}

export function normalizeOfferTierId(value = '') {
  const id = sanitizeText(value);
  if (!id) return '';
  if (id === CUSTOM_TIER_ID) return CUSTOM_TIER_ID;
  return tierById(id) ? id : '';
}

export function normalizeOfferProduct(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const kind = sanitizeText(source.kind) === 'tier' ? 'tier' : 'custom';
  const tierId = kind === 'tier' ? normalizeOfferTierId(source.tierId) : '';
  const pages = Math.max(0, Math.round(toNumber(source.pages, 0)));
  return {
    id: sanitizeText(source.id) || `prod-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    tierId,
    name: sanitizeText(source.name).slice(0, 160),
    pages,
    includes: sanitizeList(source.includes).slice(0, 40),
    note: sanitizeText(source.note).slice(0, 1200),
    priceExMva: Math.max(0, Math.round(toNumber(source.priceExMva, 0))),
    deliveryWeeks: Math.max(0, Math.round(toNumber(source.deliveryWeeks, 0))),
  };
}

export function normalizeOfferProducts(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeOfferProduct).filter((item) => item.name || item.priceExMva || item.includes.length);
}

export function normalizeContractSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const products = normalizeOfferProducts(raw.products);
  const monthlyExMva = Math.max(0, Math.round(toNumber(raw.monthlyExMva, products.reduce((sum, item) => sum + item.priceExMva, 0))));
  return {
    title: sanitizeText(raw.title).slice(0, 160),
    products,
    monthlyExMva,
    deliveryWeeks: Math.max(0, Math.round(toNumber(raw.deliveryWeeks, 0))),
    extraTerms: sanitizeList(raw.extraTerms).slice(0, 20),
    scopeSummary: sanitizeText(raw.scopeSummary).slice(0, 2000),
  };
}

const PARTY_KEYS = ['businessName', 'orgNumber', 'address', 'contactPerson', 'contactEmail'];

/** Empty string means "use the client card". Org is stored as digits only. */
export function normalizeOfferParty(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const party = {};
  for (const key of PARTY_KEYS) {
    const value = sanitizeText(source[key]);
    party[key] = key === 'orgNumber' ? value.replace(/\D+/g, '').slice(0, 9) : value.slice(0, 300);
  }
  return party;
}

function normalizeEmail(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    subject: sanitizeText(source.subject).slice(0, 300),
    preheader: sanitizeText(source.preheader).slice(0, 300),
    html: String(source.html || '').slice(0, MAX_HTML_LENGTH),
  };
}

function normalizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => ({
      at: sanitizeText(entry?.at) || nowIso(),
      by: sanitizeText(entry?.by),
      action: sanitizeText(entry?.action),
      note: sanitizeText(entry?.note).slice(0, 600),
    }))
    .filter((entry) => entry.action)
    .slice(-MAX_HISTORY);
}

export function normalizeClientIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wants = sanitizeList(raw.wants).slice(0, 8);
  const uncertainties = sanitizeList(raw.uncertainties).slice(0, 8);
  const headline = sanitizeText(raw.headline).slice(0, 280);
  if (!headline && !wants.length && !sanitizeText(raw.plan) && !sanitizeText(raw.notes)) return null;
  return {
    headline,
    wants,
    plan: sanitizeText(raw.plan).slice(0, MAX_INTENT_TEXT),
    notes: sanitizeText(raw.notes).slice(0, MAX_INTENT_TEXT),
    goal: sanitizeText(raw.goal).slice(0, MAX_INTENT_TEXT),
    identity: sanitizeText(raw.identity).slice(0, MAX_INTENT_TEXT),
    customSections: sanitizeText(raw.customSections).slice(0, MAX_INTENT_TEXT),
    uncertainties,
    source: sanitizeText(raw.source) === 'ai' ? 'ai' : 'fallback',
    sourceHash: sanitizeText(raw.sourceHash).slice(0, 64),
    generatedAt: sanitizeText(raw.generatedAt),
  };
}

/** Reps must not change email, price or contract once the offer is with admin or verified. */
export function offerContentIsLocked(offer = {}) {
  const status = normalizeOfferStatus(offer?.status);
  return status === 'review-requested' || status === 'verified' || status === 'sent';
}

export function normalizeSalesOffer(raw = {}) {
  const createdAt = sanitizeText(raw.createdAt) || nowIso();
  const contract = raw.contract && typeof raw.contract === 'object' ? raw.contract : {};
  return {
    id: sanitizeText(raw.id) || makeId(),
    salesClientId: sanitizeText(raw.salesClientId),
    ownerId: sanitizeText(raw.ownerId),
    createdBy: sanitizeText(raw.createdBy),
    status: normalizeOfferStatus(raw.status),
    reviewRequested: Boolean(raw.reviewRequested),
    tierId: normalizeOfferTierId(raw.tierId),
    /** Rep absorbed the VAT: listed prices are what the client pays incl. 25 % MVA (default: MVA added on top). */
    mvaIncluded: Boolean(raw.mvaIncluded),
    email: normalizeEmail(raw.email),
    /** Per-offer replacements for the contract block. Empty fields fall back to the client card. */
    party: normalizeOfferParty(raw.party),
    products: normalizeOfferProducts(raw.products),
    /** Content hash at the moment the rep approved the full preview; must match on send. */
    previewHash: sanitizeText(raw.previewHash),
    previewedAt: sanitizeText(raw.previewedAt),
    contract: {
      summary: normalizeContractSummary(contract.summary),
      generatedAt: sanitizeText(contract.generatedAt),
      pdfPath: sanitizeText(contract.pdfPath),
    },
    meetingId: sanitizeText(raw.meetingId),
    meetingSource: sanitizeText(raw.meetingSource) === 'manual' ? 'manual' : '',
    adminNote: sanitizeText(raw.adminNote).slice(0, 2000),
    clientIntent: normalizeClientIntent(raw.clientIntent),
    history: normalizeHistory(raw.history),
    reviewRequestedAt: sanitizeText(raw.reviewRequestedAt),
    verifiedAt: sanitizeText(raw.verifiedAt),
    verifiedBy: sanitizeText(raw.verifiedBy),
    sentAt: sanitizeText(raw.sentAt),
    sentTo: sanitizeText(raw.sentTo),
    sentBy: sanitizeText(raw.sentBy),
    /** `contract` = in-meeting send (PDF / portal agreement, no transcript letter). `full` = the offer e-mail. */
    sentContent: normalizeOfferSentContent(raw.sentContent),
    delivery: normalizeOfferDelivery(raw.delivery),
    dueDate: normalizeDueDate(raw.dueDate),
    createdAt,
    updatedAt: sanitizeText(raw.updatedAt) || createdAt,
  };
}

function readAll() {
  return readOffersFile().map(normalizeSalesOffer);
}

function byUpdatedDesc(a, b) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function listSalesOffers({ ownerId = '', status = '', salesClientId = '' } = {}) {
  const owner = sanitizeText(ownerId);
  const wanted = sanitizeText(status);
  const clientId = sanitizeText(salesClientId);
  return readAll()
    .filter((offer) => (!owner || offer.ownerId === owner))
    .filter((offer) => (!wanted || offer.status === wanted))
    .filter((offer) => (!clientId || offer.salesClientId === clientId))
    .sort(byUpdatedDesc);
}

export function getSalesOfferById(id) {
  const target = sanitizeText(id);
  if (!target) return null;
  return readAll().find((offer) => offer.id === target) || null;
}

/** The offer a rep is currently working on for this client: the newest one (sent offers stay visible). */
export function latestOffersByClient() {
  const map = new Map();
  for (const offer of readAll()) {
    const id = offer.salesClientId;
    if (!id) continue;
    const prev = map.get(id);
    if (!prev || String(offer.updatedAt) > String(prev.updatedAt)) map.set(id, offer);
  }
  return map;
}

export function getOfferForClient(salesClientId) {
  const target = sanitizeText(salesClientId);
  if (!target) return null;
  return readAll().filter((offer) => offer.salesClientId === target).sort(byUpdatedDesc)[0] || null;
}

export function countOffersByStatus() {
  const counts = Object.fromEntries(OFFER_STATUSES.map((status) => [status, 0]));
  for (const offer of readAll()) counts[offer.status] = (counts[offer.status] || 0) + 1;
  return counts;
}

function appendHistory(offer, entry) {
  const next = [...(offer.history || []), { at: nowIso(), ...entry }];
  return next.slice(-MAX_HISTORY);
}

export function createSalesOffer(input = {}, { actor = '' } = {}) {
  const list = readAll();
  const offer = normalizeSalesOffer({
    ...input,
    id: makeId(),
    status: 'draft',
    history: [{ at: nowIso(), by: sanitizeText(actor), action: 'created' }],
    createdBy: sanitizeText(input.createdBy || actor),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  list.push(offer);
  writeOffersFile(list);
  return offer;
}

export function updateSalesOffer(id, patch = {}, { actor = '', action = 'updated', note = '' } = {}) {
  const list = readAll();
  const index = list.findIndex((offer) => offer.id === sanitizeText(id));
  if (index === -1) return null;
  const current = list[index];
  const merged = normalizeSalesOffer({
    ...current,
    ...patch,
    email: patch.email ? { ...current.email, ...patch.email } : current.email,
    party: patch.party ? { ...current.party, ...patch.party } : current.party,
    contract: patch.contract ? { ...current.contract, ...patch.contract } : current.contract,
    id: current.id,
    salesClientId: current.salesClientId,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    history: action ? appendHistory(current, { by: sanitizeText(actor), action, note }) : current.history,
    updatedAt: nowIso(),
  });
  list[index] = merged;
  writeOffersFile(list);
  return merged;
}

/**
 * Sales-side autosave. Reuses the client's current offer unless it was already sent,
 * in which case a fresh draft is started so the sent record stays intact.
 */
export function upsertClientOfferDraft(salesClientId, patch = {}, { actor = '', ownerId = '' } = {}) {
  const current = getOfferForClient(salesClientId);
  if (current && current.status !== 'sent') {
    // Content is locked for the rep while admin reviews or after verification.
    if (offerContentIsLocked(current) && current.status !== 'sent' && !patch.__allowVerifiedEdit) {
      return current;
    }
    const { __allowVerifiedEdit, ...rest } = patch;
    return updateSalesOffer(current.id, rest, { actor, action: '' });
  }
  const { __allowVerifiedEdit, ...rest } = patch;
  return createSalesOffer({ ...rest, salesClientId, ownerId: ownerId || rest.ownerId }, { actor });
}

export function requestOfferReview(id, { actor = '', note = '' } = {}) {
  return updateSalesOffer(id, {
    status: 'review-requested',
    reviewRequested: true,
    reviewRequestedAt: nowIso(),
  }, { actor, action: 'review-requested', note });
}

export function verifySalesOffer(id, { actor = '', adminNote = '' } = {}) {
  return updateSalesOffer(id, {
    status: 'verified',
    verifiedAt: nowIso(),
    verifiedBy: sanitizeText(actor),
    adminNote: sanitizeText(adminNote),
  }, { actor, action: 'verified', note: adminNote });
}

/**
 * Unlock a verified offer. Default puts it back in the admin queue (`review-requested`) so the admin can keep
 * editing; `toDraft` hands it back to the sales rep as an editable draft instead.
 */
export function reopenSalesOffer(id, { actor = '', note = '', toDraft = false } = {}) {
  return updateSalesOffer(id, {
    status: toDraft ? 'draft' : 'review-requested',
    verifiedAt: '',
    verifiedBy: '',
  }, { actor, action: toDraft ? 'returned-to-sales' : 'reopened', note });
}

export function normalizeOfferDelivery(value = '') {
  const channel = sanitizeText(value).toLowerCase();
  if (channel === 'portal' || channel === 'both') return channel;
  return 'email';
}

/** Empty stays empty so older sent offers are not relabeled. */
export function normalizeOfferSentContent(value = '') {
  const raw = sanitizeText(value).toLowerCase();
  if (raw === 'contract' || raw === 'full') return raw;
  return '';
}

/** Email, asoldi.com, or both. A missing choice stays email-only. */
export function normalizeOfferChannels(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const channels = [];
  const raw = Array.isArray(source.channels) ? source.channels : [];
  for (const item of raw) {
    const value = sanitizeText(item).toLowerCase();
    if ((value === 'email' || value === 'portal') && !channels.includes(value)) channels.push(value);
  }
  if (channels.length) return channels;
  const delivery = sanitizeText(source.delivery).toLowerCase();
  if (delivery === 'both') return ['email', 'portal'];
  if (delivery === 'portal') return ['portal'];
  return ['email'];
}

export function markSalesOfferSent(id, { actor = '', to = '', pdfPath = '', delivery = 'email', sentContent = '' } = {}) {
  const current = getSalesOfferById(id);
  if (!current) return null;
  const channel = normalizeOfferDelivery(delivery);
  const content = normalizeOfferSentContent(sentContent);
  return updateSalesOffer(id, {
    status: 'sent',
    sentAt: nowIso(),
    sentTo: sanitizeText(to),
    sentBy: sanitizeText(actor),
    delivery: channel,
    sentContent: content,
    contract: { ...current.contract, pdfPath: sanitizeText(pdfPath) || current.contract.pdfPath },
  }, { actor, action: 'sent', note: `${channel}${content ? `:${content}` : ''}:${sanitizeText(to)}` });
}

export function deleteSalesOffer(id) {
  const list = readAll();
  const next = list.filter((offer) => offer.id !== sanitizeText(id));
  if (next.length === list.length) return false;
  writeOffersFile(next);
  return true;
}

/** Whether this offer must be verified by an admin before a rep may send it. */
export function offerNeedsVerification(offer = {}) {
  return offer.tierId === CUSTOM_TIER_ID || Boolean(offer.reviewRequested);
}

function partyOverrides(raw = {}) {
  const party = normalizeOfferParty(raw);
  return Object.fromEntries(PARTY_KEYS.filter((key) => party[key]).map((key) => [key, party[key]]));
}

/**
 * Fingerprint of everything the client will actually receive. The rep must approve a full preview of
 * exactly this content before sending; any later edit changes the hash and invalidates the approval.
 */
export function offerContentHash(offer = {}, { includeParty = true } = {}) {
  const payload = {
    subject: sanitizeText(offer?.email?.subject),
    preheader: sanitizeText(offer?.email?.preheader),
    html: String(offer?.email?.html || ''),
    products: normalizeOfferProducts(offer?.products),
    mvaIncluded: Boolean(offer?.mvaIncluded),
    tierId: sanitizeText(offer?.tierId),
    summary: offer?.contract?.summary || null,
  };
  if (includeParty) payload.party = partyOverrides(offer?.party);
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

export function offerPreviewIsCurrent(offer = {}) {
  if (!offer?.previewHash) return false;
  if (offer.previewHash === offerContentHash(offer)) return true;
  // Approvals stored before party was part of the fingerprint still count
  // when this offer has no contract-block overrides.
  return offer.previewHash === offerContentHash(offer, { includeParty: false })
    && Object.keys(partyOverrides(offer?.party)).length === 0;
}

export function markOfferPreviewed(id, { actor = '' } = {}) {
  const current = getSalesOfferById(id);
  if (!current) return null;
  return updateSalesOffer(id, {
    previewHash: offerContentHash(current),
    previewedAt: nowIso(),
  }, { actor, action: 'previewed' });
}

export function offerCanBeSentBySales(offer = {}) {
  if (!offer || offer.status === 'sent') return false;
  if (offerNeedsVerification(offer)) return offer.status === 'verified';
  return true;
}

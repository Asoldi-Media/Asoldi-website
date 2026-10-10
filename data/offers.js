import { readFileSync, existsSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';

const OFFERS_PATH = getDataFilePath('client-offers.json');

// Website codes ("nettsidekode") are 2 uppercase letters + 2 digits, e.g. "QK74".
// Ambiguous characters (I, O, 0, 1) are excluded so codes are easy to read/share.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_DIGITS = '23456789';

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

export function normalizeCode(value = '') {
  return sanitizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function readOffersFile() {
  ensureDataDir();
  if (!existsSync(OFFERS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(OFFERS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOffersFile(list) {
  ensureDataDir();
  writeDataJson(OFFERS_PATH, list);
}

function normalizeAcceptance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const acceptedAt = sanitizeText(raw.acceptedAt);
  if (!acceptedAt) return null;
  const screen = raw.screen && typeof raw.screen === 'object' ? raw.screen : {};
  return {
    acceptedAt,
    chosenOfferIndex: raw.chosenOfferIndex === 0 || raw.chosenOfferIndex === 1 ? raw.chosenOfferIndex : null,
    userId: sanitizeText(raw.userId),
    email: sanitizeText(raw.email).toLowerCase(),
    ip: sanitizeText(raw.ip).slice(0, 80),
    userAgent: sanitizeText(raw.userAgent).slice(0, 500),
    language: sanitizeText(raw.language).slice(0, 40),
    timezone: sanitizeText(raw.timezone).slice(0, 80),
    platform: sanitizeText(raw.platform).slice(0, 80),
    screen: {
      width: Number(screen.width) || 0,
      height: Number(screen.height) || 0,
    },
  };
}

function normalizeOffer(raw = {}) {
  const createdAt = sanitizeText(raw.createdAt) || nowIso();
  return {
    id: sanitizeText(raw.id) || makeId(),
    code: normalizeCode(raw.code),
    ownerId: sanitizeText(raw.ownerId),
    salesClientId: sanitizeText(raw.salesClientId),
    planId: sanitizeText(raw.planId) || 'tier-1-standard',
    planName: sanitizeText(raw.planName),
    price: sanitizeText(raw.price),
    note: sanitizeText(raw.note),
    businessName: sanitizeText(raw.businessName),
    previewUrl: sanitizeText(raw.previewUrl),
    targetUserId: sanitizeText(raw.targetUserId),
    targetEmail: sanitizeText(raw.targetEmail).toLowerCase(),
    businessId: sanitizeText(raw.businessId),
    salesOfferId: sanitizeText(raw.salesOfferId),
    letterHtml: String(raw.letterHtml || '').slice(0, 600_000),
    contractHtml: String(raw.contractHtml || '').slice(0, 600_000),
    acceptance: normalizeAcceptance(raw.acceptance),
    claimed: Boolean(raw.claimed),
    claimedAt: sanitizeText(raw.claimedAt),
    createdAt,
    updatedAt: sanitizeText(raw.updatedAt) || createdAt,
  };
}

export function listOffers() {
  return readOffersFile()
    .map(normalizeOffer)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getOfferById(id) {
  const target = sanitizeText(id);
  if (!target) return null;
  return listOffers().find((entry) => entry.id === target) || null;
}

export function getOfferByCode(code) {
  const target = normalizeCode(code);
  if (target.length !== 4) return null;
  return listOffers().find((entry) => entry.code === target) || null;
}

export function getActiveOfferForUser({
  userId = '',
  email = '',
  businessId = '',
  membershipBusinessIds = [],
} = {}) {
  const uid = sanitizeText(userId);
  const mail = sanitizeText(email).toLowerCase();
  const biz = sanitizeText(businessId);
  const extra = (Array.isArray(membershipBusinessIds) ? membershipBusinessIds : [])
    .map((id) => sanitizeText(id))
    .filter(Boolean);
  if (!uid && !mail && !biz && !extra.length) return null;
  const list = listOffers();
  if (biz) {
    const hit = list.find((entry) => entry.businessId === biz);
    if (hit) return hit;
  }
  if (extra.length) {
    const hit = list.find((entry) => extra.includes(entry.businessId));
    if (hit) return hit;
  }
  const allowed = new Set([biz, ...extra].filter(Boolean));
  const allowedOrUnbound = (entry) => !entry.businessId || allowed.has(entry.businessId);
  if (uid) {
    const hit = list.find((entry) => entry.targetUserId === uid && allowedOrUnbound(entry));
    if (hit) return hit;
  }
  if (mail) {
    return list.find((entry) => entry.targetEmail === mail && allowedOrUnbound(entry)) || null;
  }
  return null;
}

function codeExists(code, list = listOffers()) {
  const target = normalizeCode(code);
  return list.some((entry) => entry.code === target);
}

export function generateUniqueCode() {
  const list = listOffers();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code =
      CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)] +
      CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)] +
      CODE_DIGITS[Math.floor(Math.random() * CODE_DIGITS.length)] +
      CODE_DIGITS[Math.floor(Math.random() * CODE_DIGITS.length)];
    if (!codeExists(code, list)) return code;
  }
  // Extremely unlikely fallback.
  return `${CODE_LETTERS[0]}${CODE_LETTERS[1]}${String(Date.now()).slice(-2)}`;
}

export function createOffer(input = {}) {
  const state = readOffersFile().map(normalizeOffer);
  const requestedCode = normalizeCode(input.code);
  const code = requestedCode.length === 4 && !codeExists(requestedCode, state) ? requestedCode : generateUniqueCode();
  const offer = normalizeOffer({
    ...input,
    id: makeId(),
    code,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  state.push(offer);
  writeOffersFile(state);
  return offer;
}

export function updateOffer(id, updates = {}) {
  const state = readOffersFile().map(normalizeOffer);
  const index = state.findIndex((entry) => entry.id === sanitizeText(id));
  if (index === -1) return null;
  const next = normalizeOffer({
    ...state[index],
    ...updates,
    id: state[index].id,
    code: state[index].code,
    createdAt: state[index].createdAt,
    updatedAt: nowIso(),
  });
  state[index] = next;
  writeOffersFile(state);
  return next;
}

export function updatePreviewUrlForSalesClient(salesClientId, previewUrl) {
  const clientId = sanitizeText(salesClientId);
  const nextPreview = sanitizeText(previewUrl);
  if (!clientId || !nextPreview) return 0;
  const state = readOffersFile().map(normalizeOffer);
  let updated = 0;
  const next = state.map((entry) => {
    if (sanitizeText(entry.salesClientId) !== clientId) return entry;
    if (sanitizeText(entry.previewUrl) === nextPreview) return entry;
    updated += 1;
    return normalizeOffer({
      ...entry,
      previewUrl: nextPreview,
      updatedAt: nowIso(),
    });
  });
  if (updated) writeOffersFile(next);
  return updated;
}

export function deleteOffer(id) {
  const state = readOffersFile().map(normalizeOffer);
  const next = state.filter((entry) => entry.id !== sanitizeText(id));
  if (next.length === state.length) return false;
  writeOffersFile(next);
  return true;
}

export function getActiveOfferForSalesClient(salesClientId) {
  const clientId = sanitizeText(salesClientId);
  if (!clientId) return null;
  return listOffers().find((entry) => entry.salesClientId === clientId) || null;
}

export function findPortalOfferForSales({ salesOfferId = '', salesClientId = '' } = {}) {
  const offerId = sanitizeText(salesOfferId);
  const clientId = sanitizeText(salesClientId);
  const list = listOffers();
  if (offerId) {
    const byOffer = list.find((entry) => entry.salesOfferId === offerId);
    if (byOffer) return byOffer;
  }
  if (!clientId) return null;
  return list.find((entry) => entry.salesClientId === clientId && entry.salesOfferId) || null;
}

export function upsertPortalOffer(input = {}) {
  const salesOfferId = sanitizeText(input.salesOfferId);
  const existing = findPortalOfferForSales({
    salesOfferId,
    salesClientId: input.salesClientId,
  });
  if (!existing) return createOffer(input);
  return updateOffer(existing.id, {
    ...input,
    acceptance: existing.acceptance,
    claimed: existing.claimed,
    claimedAt: existing.claimedAt,
  });
}

export function recordOfferAcceptance(id, evidence = {}) {
  const current = getOfferById(id);
  if (!current) return null;
  if (current.acceptance?.acceptedAt) return current;
  return updateOffer(id, {
    acceptance: {
      acceptedAt: nowIso(),
      userId: evidence.userId,
      email: evidence.email,
      ip: evidence.ip,
      userAgent: evidence.userAgent,
      language: evidence.language,
      timezone: evidence.timezone,
      platform: evidence.platform,
      screen: evidence.screen,
      chosenOfferIndex: evidence.chosenOfferIndex === 0 || evidence.chosenOfferIndex === 1
        ? evidence.chosenOfferIndex
        : null,
    },
    targetUserId: sanitizeText(evidence.userId) || current.targetUserId,
    targetEmail: sanitizeText(evidence.email).toLowerCase() || current.targetEmail,
    claimed: true,
    claimedAt: current.claimedAt || nowIso(),
  });
}

export function claimOffer(id, { userId = '', email = '', businessId = '' } = {}) {
  return updateOffer(id, {
    targetUserId: sanitizeText(userId),
    targetEmail: sanitizeText(email).toLowerCase(),
    businessId: sanitizeText(businessId),
    claimed: true,
    claimedAt: nowIso(),
  });
}

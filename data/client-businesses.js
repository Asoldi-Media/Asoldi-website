import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';

const STORE_PATH = getDataFilePath('client-businesses.json');
const ROLES = ['owner', 'admin', 'collaborator'];

function nowIso() {
  return new Date().toISOString();
}

function text(value = '') {
  return String(value ?? '').trim();
}

function emailOf(value = '') {
  return text(value).toLowerCase();
}

function makeId(prefix = 'mem') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function emptyStore() {
  return { memberships: [], userState: {}, updatedAt: nowIso() };
}

function readStore() {
  ensurePersistentDataDir();
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return {
      memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
      userState: parsed.userState && typeof parsed.userState === 'object' ? parsed.userState : {},
      updatedAt: text(parsed.updatedAt) || nowIso(),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  ensurePersistentDataDir();
  writeDataJson(STORE_PATH, { ...store, updatedAt: nowIso() });
}

export function isBusinessRole(role = '') {
  return ROLES.includes(text(role).toLowerCase());
}

export function normalizeMembership(input = {}) {
  const role = text(input.role).toLowerCase();
  const status = text(input.status).toLowerCase();
  return {
    id: text(input.id) || makeId('mem'),
    businessId: text(input.businessId),
    userId: text(input.userId),
    email: emailOf(input.email),
    role: isBusinessRole(role) ? role : 'collaborator',
    status: ['pending', 'active', 'revoked'].includes(status) ? status : 'pending',
    invitedBy: text(input.invitedBy),
    invitedAt: text(input.invitedAt) || nowIso(),
    acceptedAt: text(input.acceptedAt),
    revokedAt: text(input.revokedAt),
  };
}

export function canManageMembers(role = '') {
  return role === 'owner' || role === 'admin';
}

export function canTransferOwnership(role = '') {
  return role === 'owner';
}

export function canManageBilling(role = '') {
  return role === 'owner' || role === 'admin';
}

export function listMemberships() {
  return readStore().memberships.map(normalizeMembership);
}

export function getMembershipsForUser(userId) {
  const target = text(userId);
  if (!target) return [];
  return listMemberships().filter((row) => row.userId === target && row.status !== 'revoked');
}

export function getActiveMembershipsForUser(userId) {
  return getMembershipsForUser(userId).filter((row) => row.status === 'active');
}

export function getMembershipsForBusiness(businessId) {
  const target = text(businessId);
  if (!target) return [];
  return listMemberships().filter((row) => row.businessId === target && row.status !== 'revoked');
}

export function getMembership(userId, businessId) {
  return getMembershipsForBusiness(businessId).find((row) => row.userId === text(userId)) || null;
}

export function getActiveBusinessId(userId) {
  const target = text(userId);
  if (!target) return '';
  const store = readStore();
  const saved = text(store.userState?.[target]?.activeBusinessId);
  const active = getActiveMembershipsForUser(target);
  if (saved && active.some((row) => row.businessId === saved)) return saved;
  return active[0]?.businessId || '';
}

export function setActiveBusinessId(userId, businessId) {
  const target = text(userId);
  const nextId = text(businessId);
  if (!target || !nextId) return '';
  if (!getMembership(target, nextId) || getMembership(target, nextId).status !== 'active') return '';
  const store = readStore();
  store.userState[target] = { ...(store.userState[target] || {}), activeBusinessId: nextId, updatedAt: nowIso() };
  writeStore(store);
  return nextId;
}

export function ensureOwnerMembership({ userId = '', email = '', businessId = '' } = {}) {
  const ownerId = text(userId);
  const bizId = text(businessId) || ownerId;
  if (!ownerId || !bizId) return null;
  const store = readStore();
  const existing = store.memberships
    .map(normalizeMembership)
    .find((row) => row.businessId === bizId && row.userId === ownerId && row.status !== 'revoked');
  if (existing) {
    if (existing.role !== 'owner' || existing.status !== 'active') {
      const index = store.memberships.findIndex((row) => row.id === existing.id);
      store.memberships[index] = normalizeMembership({
        ...existing,
        role: 'owner',
        status: 'active',
        email: emailOf(email) || existing.email,
        acceptedAt: existing.acceptedAt || nowIso(),
      });
      writeStore(store);
      return normalizeMembership(store.memberships[index]);
    }
    if (!getActiveBusinessId(ownerId)) setActiveBusinessId(ownerId, bizId);
    return existing;
  }
  const created = normalizeMembership({
    businessId: bizId,
    userId: ownerId,
    email: emailOf(email),
    role: 'owner',
    status: 'active',
    acceptedAt: nowIso(),
  });
  store.memberships.push(created);
  writeStore(store);
  if (!getActiveBusinessId(ownerId)) setActiveBusinessId(ownerId, bizId);
  return created;
}

export function inviteMember({ businessId = '', email = '', role = 'collaborator', invitedBy = '', userId = '' } = {}) {
  const bizId = text(businessId);
  const mail = emailOf(email);
  const existingUserId = text(userId);
  const nextRole = text(role).toLowerCase() === 'admin' ? 'admin' : 'collaborator';
  if (!bizId || !mail) return { ok: false, status: 400, message: 'E-post og bedrift kreves.' };
  if (nextRole === 'owner') return { ok: false, status: 400, message: 'Eier overføres separat, ikke via invitasjon.' };
  const store = readStore();
  const current = store.memberships.map(normalizeMembership);
  const duplicate = current.find((row) => (
    row.businessId === bizId
    && row.status !== 'revoked'
    && (row.email === mail || (existingUserId && row.userId === existingUserId))
  ));
  if (duplicate) {
    if (duplicate.status === 'active') {
      return { ok: false, status: 409, message: 'Denne personen er allerede med i bedriften.' };
    }
    return { ok: true, membership: duplicate, alreadyPending: true };
  }
  const created = normalizeMembership({
    businessId: bizId,
    email: mail,
    userId: existingUserId,
    role: nextRole,
    status: existingUserId ? 'active' : 'pending',
    invitedBy: text(invitedBy),
    acceptedAt: existingUserId ? nowIso() : '',
  });
  store.memberships.push(created);
  writeStore(store);
  if (existingUserId && !getActiveBusinessId(existingUserId)) setActiveBusinessId(existingUserId, bizId);
  return { ok: true, membership: created };
}

export function acceptPendingInvitesForUser({ userId = '', email = '' } = {}) {
  const ownerId = text(userId);
  const mail = emailOf(email);
  if (!ownerId || !mail) return [];
  const store = readStore();
  const accepted = [];
  store.memberships = store.memberships.map((raw) => {
    const row = normalizeMembership(raw);
    if (row.status !== 'pending' || row.email !== mail) return raw;
    const next = normalizeMembership({
      ...row,
      userId: ownerId,
      status: 'active',
      acceptedAt: nowIso(),
    });
    accepted.push(next);
    return next;
  });
  if (accepted.length) {
    writeStore(store);
    if (!getActiveBusinessId(ownerId)) setActiveBusinessId(ownerId, accepted[0].businessId);
  }
  return accepted;
}

export function revokeMembership({ businessId = '', membershipId = '', actorUserId = '' } = {}) {
  const store = readStore();
  const index = store.memberships.findIndex((row) => text(row.id) === text(membershipId) && text(row.businessId) === text(businessId));
  if (index === -1) return { ok: false, status: 404, message: 'Fant ikke medlemmet.' };
  const current = normalizeMembership(store.memberships[index]);
  if (current.role === 'owner') return { ok: false, status: 400, message: 'Eier kan ikke fjernes. Overfør eierskap først.' };
  if (current.userId && current.userId === text(actorUserId) && current.role === 'owner') {
    return { ok: false, status: 400, message: 'Eier kan ikke fjerne seg selv.' };
  }
  store.memberships[index] = normalizeMembership({ ...current, status: 'revoked', revokedAt: nowIso() });
  writeStore(store);
  return { ok: true, membership: store.memberships[index] };
}

export function leaveBusiness({ businessId = '', userId = '' } = {}) {
  const membership = getMembership(userId, businessId);
  if (!membership) return { ok: false, status: 404, message: 'Du er ikke med i denne bedriften.' };
  if (membership.role === 'owner') {
    return { ok: false, status: 400, message: 'Eier må overføre bedriften før hen kan forlate den.' };
  }
  return revokeMembership({ businessId, membershipId: membership.id, actorUserId: userId });
}

export function transferOwnership({ businessId = '', toUserId = '', actorUserId = '' } = {}) {
  const bizId = text(businessId);
  const nextOwnerId = text(toUserId);
  const actor = getMembership(actorUserId, bizId);
  if (!actor || actor.role !== 'owner' || actor.status !== 'active') {
    return { ok: false, status: 403, message: 'Bare eier kan overføre bedriften.' };
  }
  const next = getMembership(nextOwnerId, bizId);
  if (!next || next.status !== 'active') {
    return { ok: false, status: 400, message: 'Ny eier må allerede være aktiv i bedriften.' };
  }
  const store = readStore();
  store.memberships = store.memberships.map((raw) => {
    const row = normalizeMembership(raw);
    if (row.businessId !== bizId || row.status === 'revoked') return raw;
    if (row.userId === text(actorUserId) && row.role === 'owner') {
      return normalizeMembership({ ...row, role: 'admin' });
    }
    if (row.userId === nextOwnerId) {
      return normalizeMembership({ ...row, role: 'owner' });
    }
    return raw;
  });
  writeStore(store);
  return { ok: true, businessId: bizId, ownerUserId: nextOwnerId };
}

export function staffReassignOwner({ businessId = '', toUserId = '', email = '' } = {}) {
  const bizId = text(businessId);
  const nextOwnerId = text(toUserId);
  if (!bizId || !nextOwnerId) return { ok: false, status: 400, message: 'Bedrift og bruker kreves.' };
  ensureOwnerMembership({ userId: nextOwnerId, email, businessId: bizId });
  const store = readStore();
  store.memberships = store.memberships.map((raw) => {
    const row = normalizeMembership(raw);
    if (row.businessId !== bizId || row.status === 'revoked') return raw;
    if (row.userId === nextOwnerId) return normalizeMembership({ ...row, role: 'owner', status: 'active', email: emailOf(email) || row.email, acceptedAt: row.acceptedAt || nowIso() });
    if (row.role === 'owner') return normalizeMembership({ ...row, role: 'admin' });
    return raw;
  });
  writeStore(store);
  setActiveBusinessId(nextOwnerId, bizId);
  return { ok: true, businessId: bizId, ownerUserId: nextOwnerId };
}

export function updateMembershipEmailsForUser(userId, email) {
  const ownerId = text(userId);
  const mail = emailOf(email);
  if (!ownerId || !mail) return 0;
  const store = readStore();
  let changed = 0;
  store.memberships = store.memberships.map((raw) => {
    const row = normalizeMembership(raw);
    if (row.userId !== ownerId || row.email === mail) return raw;
    changed += 1;
    return normalizeMembership({ ...row, email: mail });
  });
  if (changed) writeStore(store);
  return changed;
}

export function publicMembership(row = {}) {
  const membership = normalizeMembership(row);
  return {
    id: membership.id,
    businessId: membership.businessId,
    userId: membership.userId,
    email: membership.email,
    role: membership.role,
    status: membership.status,
    invitedAt: membership.invitedAt,
    acceptedAt: membership.acceptedAt,
  };
}

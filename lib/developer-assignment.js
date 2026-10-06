function text(value = '') {
  return String(value ?? '').trim();
}

export const ADMIN_DEVELOPER_OWNER_ID = 'admin';

export function isAdminDeveloperOwnerId(value = '') {
  const id = text(value);
  return id === ADMIN_DEVELOPER_OWNER_ID || id.startsWith('admin:');
}

export function adminDeveloperOption() {
  return {
    accountKey: ADMIN_DEVELOPER_OWNER_ID,
    username: 'Admin',
    name: 'Admin',
  };
}

export function sameDeveloperOwner(left = '', right = '') {
  const a = text(left);
  const b = text(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return isAdminDeveloperOwnerId(a) && isAdminDeveloperOwnerId(b);
}

export function canonicalDeveloperOwnerId(value = '') {
  const id = text(value);
  if (!id) return '';
  return isAdminDeveloperOwnerId(id) ? ADMIN_DEVELOPER_OWNER_ID : id;
}

export function developerOwnerDisplayName(ownerId = '', developers = []) {
  if (isAdminDeveloperOwnerId(ownerId)) return 'Admin';
  const key = text(ownerId);
  const match = (Array.isArray(developers) ? developers : []).find((owner) => text(owner?.accountKey) === key);
  return text(match?.name) || text(match?.username) || (key ? 'Tildelt' : '');
}

export function emptyDeveloperHandoff() {
  return {
    status: '',
    fromOwnerId: '',
    toOwnerId: '',
    runId: '',
    requestedAt: '',
    uploadedAt: '',
    fileName: '',
  };
}

export function normalizeDeveloperHandoff(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const status = text(input.status);
  return {
    status: status === 'waiting-upload' || status === 'ready' ? status : '',
    fromOwnerId: text(input.fromOwnerId),
    toOwnerId: text(input.toOwnerId),
    runId: text(input.runId),
    requestedAt: text(input.requestedAt),
    uploadedAt: text(input.uploadedAt),
    fileName: text(input.fileName),
  };
}

export function developerAccountKey(user = {}) {
  const role = text(user.role).toLowerCase();
  if (user.isAdmin || role === 'admin' || isAdminDeveloperOwnerId(user.accountKey)) {
    return ADMIN_DEVELOPER_OWNER_ID;
  }
  const explicit = text(user.accountKey);
  if (explicit) return explicit;
  if (role === 'developer') {
    const userId = text(user.userId || user.id);
    return userId ? `developer:${userId}` : '';
  }
  return '';
}

export function developmentItemVisible(caller = {}, item = {}) {
  if (!caller) return false;
  if (caller.isAdmin || text(caller.role).toLowerCase() === 'admin') return true;
  const key = developerAccountKey(caller);
  if (!key) return false;
  if (sameDeveloperOwner(item.developerOwnerId, key)) return true;
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  return handoff.status === 'waiting-upload' && sameDeveloperOwner(handoff.fromOwnerId, key);
}

export function canWorkDevelopmentClient(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status === 'waiting-upload' || handoff.status === 'ready') return false;
  const ownerId = text(item.developerOwnerId);
  if (!ownerId) return false;
  const callerKey = developerAccountKey(caller);
  return sameDeveloperOwner(callerKey, ownerId);
}

/** Klar for preview and the other goal chips are board status, not Maker work. */
export function canToggleDeveloperGoals(caller = {}, item = {}) {
  return developmentItemVisible(caller, item);
}

export function canUploadDeveloperHandoff(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status !== 'waiting-upload') return false;
  return sameDeveloperOwner(developerAccountKey(caller), handoff.fromOwnerId);
}

export function canAcceptDeveloperHandoff(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status !== 'ready') return false;
  return sameDeveloperOwner(developerAccountKey(caller), item.developerOwnerId);
}

export function shouldSeedExistingDeveloperOwners(seed = null) {
  return !text(seed?.existingAssignedToAdminAt);
}

export function applyAdminDeveloperOwnerSeed(clients = [], { now = '' } = {}) {
  const seededAt = text(now) || new Date().toISOString();
  let assignedCount = 0;
  const next = (Array.isArray(clients) ? clients : []).map((client) => {
    const row = client && typeof client === 'object' ? client : {};
    if (text(row.product).toLowerCase() === 'ssu') return row;
    const current = text(row.developerOwnerId);
    if (!current) {
      assignedCount += 1;
      return { ...row, developerOwnerId: ADMIN_DEVELOPER_OWNER_ID };
    }
    if (isAdminDeveloperOwnerId(current) && current !== ADMIN_DEVELOPER_OWNER_ID) {
      assignedCount += 1;
      return { ...row, developerOwnerId: ADMIN_DEVELOPER_OWNER_ID };
    }
    return row;
  });
  return { clients: next, assignedCount, seededAt };
}

export function planDeveloperReassign({ client = {}, nextOwnerId = '', now = '' } = {}) {
  const next = canonicalDeveloperOwnerId(nextOwnerId);
  const current = canonicalDeveloperOwnerId(client.developerOwnerId);
  if (!next || next === current) {
    return { changed: false, developerOwnerId: current, developerHandoff: normalizeDeveloperHandoff(client.developerHandoff) };
  }
  const runId = text(client.makerRun?.runId);
  if (!current || !runId) {
    return { changed: true, developerOwnerId: next, developerHandoff: emptyDeveloperHandoff() };
  }
  return {
    changed: true,
    developerOwnerId: next,
    developerHandoff: {
      status: 'waiting-upload',
      fromOwnerId: current,
      toOwnerId: next,
      runId,
      requestedAt: text(now),
      uploadedAt: '',
      fileName: '',
    },
  };
}

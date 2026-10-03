function text(value = '') {
  return String(value ?? '').trim();
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
  const explicit = text(user.accountKey);
  if (explicit) return explicit;
  const role = text(user.role).toLowerCase();
  if (user.isAdmin || role === 'admin') {
    return `admin:${text(user.username) || 'admin'}`;
  }
  if (role === 'developer') {
    const userId = text(user.userId || user.id);
    return userId ? `developer:${userId}` : '';
  }
  return text(user.accountKey);
}

export function developmentItemVisible(caller = {}, item = {}) {
  if (!caller) return false;
  if (caller.isAdmin || text(caller.role).toLowerCase() === 'admin') return true;
  const key = developerAccountKey(caller);
  if (!key) return false;
  if (text(item.developerOwnerId) === key) return true;
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  return handoff.status === 'waiting-upload' && handoff.fromOwnerId === key;
}

export function canWorkDevelopmentClient(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status === 'waiting-upload' || handoff.status === 'ready') return false;
  const ownerId = text(item.developerOwnerId);
  if (!ownerId) return false;
  return developerAccountKey(caller) === ownerId;
}

export function canUploadDeveloperHandoff(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status !== 'waiting-upload') return false;
  return developerAccountKey(caller) === handoff.fromOwnerId;
}

export function canAcceptDeveloperHandoff(caller = {}, item = {}) {
  const handoff = normalizeDeveloperHandoff(item.developerHandoff);
  if (handoff.status !== 'ready') return false;
  return developerAccountKey(caller) === text(item.developerOwnerId);
}

export function planDeveloperReassign({ client = {}, nextOwnerId = '', now = '' } = {}) {
  const next = text(nextOwnerId);
  const current = text(client.developerOwnerId);
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

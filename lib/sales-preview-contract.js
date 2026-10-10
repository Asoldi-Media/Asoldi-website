import * as store from '../data/store.js';
import * as clientPortal from '../data/client-portal.js';

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

const acceptHits = new Map();

export function allowPreviewAcceptAttempt(key, { windowMs = 15 * 60 * 1000, max = 8 } = {}) {
  const id = sanitizeText(key);
  if (!id) return false;
  const now = Date.now();
  const next = (acceptHits.get(id) || []).filter((stamp) => now - stamp < windowMs);
  if (next.length >= max) {
    acceptHits.set(id, next);
    return false;
  }
  next.push(now);
  acceptHits.set(id, next);
  return true;
}

export function presentPreviewContract({
  offer = null,
  name = '',
  email = '',
  contractHtml = '',
  alternatives = [],
} = {}) {
  const person = sanitizeText(name);
  const mail = sanitizeText(email).toLowerCase();
  const acceptedAt = sanitizeText(offer?.acceptance?.acceptedAt);
  if (!offer) {
    return {
      status: 'idle',
      name: person,
      email: mail,
      contractHtml: '',
      alternatives: [],
      acceptedAt: '',
    };
  }
  if (acceptedAt) {
    return {
      status: 'signed',
      name: person,
      email: mail,
      contractHtml: '',
      alternatives: [],
      acceptedAt,
    };
  }
  return {
    status: 'ready',
    name: person,
    email: mail,
    contractHtml: String(contractHtml || ''),
    alternatives: Array.isArray(alternatives) ? alternatives : [],
    acceptedAt: '',
  };
}

export async function ensurePreviewSigner({ email, password, name = '' } = {}) {
  const mail = sanitizeText(email).toLowerCase();
  const pass = String(password || '');
  const person = sanitizeText(name);
  if (!mail) return { ok: false, status: 400, message: 'Mangler e-post på tilbudet.' };
  if (pass.length < 8) {
    return { ok: false, status: 400, message: 'Passord må være minst 8 tegn.' };
  }
  const existing = await store.getUserByUsername(mail);
  if (!existing) {
    const created = await store.createUser(mail, pass, 'client', person ? { name: person } : {});
    if (!created.ok) {
      return { ok: false, status: 400, message: created.error || 'Kunne ikke opprette konto.' };
    }
    const user = await store.getUserById(created.user.id);
    clientPortal.ensureClientProfileForUser(user);
    if (person) clientPortal.upsertClientProfile(user.id, { name: person, email: mail });
    return { ok: true, user };
  }
  if (existing.role !== 'client') {
    return { ok: false, status: 409, message: 'E-posten er allerede registrert for en annen brukertype.' };
  }
  const verified = await store.verifyClient(mail, pass);
  if (!verified.ok) {
    return { ok: false, status: 401, message: 'Ugyldig e-post eller passord.' };
  }
  const user = await store.getUserById(verified.user.id);
  clientPortal.ensureClientProfileForUser(user);
  if (person) clientPortal.upsertClientProfile(user.id, { name: person });
  return { ok: true, user };
}

/**
 * Which mailbox owns the hub's Fireflies API key (shown on the health card, used by the alerts).
 *
 * Inviting fred@ makes the event ORGANIZER's own Fireflies join. On an event another rep hosts that is the
 * rep's personal Fireflies: a second notetaker in the lobby whose recording lands in an account the hub key
 * cannot read; on the key owner's own event it is a second notetaker from the same account. So fred@ goes on
 * no event, and the hub's live join (lib/fireflies-live-sessions.js) is the one recorder.
 *
 * The owner comes from a read-only `user { email }` query, asked at most once per 6 hours. Until it has
 * answered (and in tests) damian@asoldi.com is assumed.
 */

export const FIREFLIES_KEY_OWNER_FALLBACK = 'damian@asoldi.com';
export const FIREFLIES_KEY_OWNER_TTL_MS = 6 * 60 * 60 * 1000;

const state = { email: '', askedAtMs: 0 };

function emailOf(value = '') {
  const email = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function firefliesKeyOwnerEmail() {
  return state.email || FIREFLIES_KEY_OWNER_FALLBACK;
}

/**
 * fred@ goes on no event, not even the key owner's: an invited fred@ makes the host's own Fireflies join
 * beside the hub's live join, and two notetakers in one room leave a silent fragment (or, on a rep's event,
 * a recording in an account the hub key cannot read). The live join sends the one notetaker everywhere.
 */
export function firefliesNotetakerAllowedForOrganizer() {
  return false;
}

/**
 * Ask Fireflies who owns the key, at most once per FIREFLIES_KEY_OWNER_TTL_MS whatever the answer.
 * `fetchOwnerEmail()` resolves to the e-mail (lib/fireflies-webhook.js fetchFirefliesKeyOwnerEmail).
 * Never throws; a failed or empty answer keeps the last known owner (or the fallback).
 */
export async function refreshFirefliesKeyOwnerEmail({ fetchOwnerEmail, nowMs = Date.now(), force = false } = {}) {
  if (typeof fetchOwnerEmail !== 'function') return firefliesKeyOwnerEmail();
  if (!force && state.askedAtMs && nowMs - state.askedAtMs < FIREFLIES_KEY_OWNER_TTL_MS) return firefliesKeyOwnerEmail();
  state.askedAtMs = nowMs;
  try {
    const email = emailOf(await fetchOwnerEmail());
    if (email) state.email = email;
  } catch {
    // Keep the last known owner; the next try is after the TTL.
  }
  return firefliesKeyOwnerEmail();
}

export function resetFirefliesKeyOwnerForTests() {
  state.email = '';
  state.askedAtMs = 0;
}

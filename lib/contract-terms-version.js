/**
 * Which duration-terms version an offer's contract renders with.
 * `client` is the sales client. Returns 1 or DURATION_TERMS_VERSION.
 */
import { DURATION_TERMS_VERSION } from './offer-contract-copy.js';

function text(value) {
  return String(value ?? '').trim();
}

function timeMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

const UNSIGNED = Object.freeze({ signed: false, at: '' });

/** { signed, at } for the contract this offer shows. `at` is an ISO time, or '' when it was not recorded. */
export function contractSignatureForOffer(offer, client) {
  if (offer?.status !== 'sent' || client?.progression?.contractSigned !== true) return UNSIGNED;
  const offerClientId = text(offer?.salesClientId);
  const clientId = text(client?.id);
  if (offerClientId && clientId && offerClientId !== clientId) return UNSIGNED;

  const signedAtMs = timeMs(client?.contractSignedAt);
  const sentAtMs = timeMs(offer?.sentAt);
  if (sentAtMs !== null && signedAtMs !== null && sentAtMs > signedAtMs) {
    const offerId = offer?.id;
    if (text(offerId) === '' || client?.sitePlan?.offerId !== offerId) return UNSIGNED;
    let latestMs = null;
    const history = Array.isArray(client?.sitePlan?.history) ? client.sitePlan.history : [];
    for (const entry of history) {
      if (!String(entry?.reason ?? '').startsWith('offer-upgrade')) continue;
      const atMs = timeMs(entry?.at);
      if (atMs === null || atMs < sentAtMs) continue;
      if (latestMs === null || atMs > latestMs) latestMs = atMs;
    }
    return { signed: true, at: iso(latestMs === null ? sentAtMs : latestMs) };
  }
  return { signed: true, at: signedAtMs === null ? '' : iso(signedAtMs) };
}

export function durationTermsVersionForOffer(offer, client, { cutoverMs } = {}) {
  const signature = contractSignatureForOffer(offer, client);
  if (!signature.signed) return DURATION_TERMS_VERSION;
  const t = timeMs(signature.at);
  if (t === null) return 1;
  if (!Number.isFinite(cutoverMs)) return DURATION_TERMS_VERSION;
  return t < cutoverMs ? 1 : DURATION_TERMS_VERSION;
}

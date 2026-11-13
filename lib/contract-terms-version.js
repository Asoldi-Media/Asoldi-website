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

function signatureCandidates(client) {
  return [
    timeMs(client?.contractSignedAt),
    timeMs(client?.ext?.contractSigning?.earlierSignedAt),
  ].filter((ms) => ms !== null);
}

function earliest(times) {
  let best = null;
  for (const ms of times) {
    if (best === null || ms < best) best = ms;
  }
  return best;
}

/** { signed, at } for the contract this offer shows. `at` is an ISO time, or '' when it was not recorded. */
export function contractSignatureForOffer(offer, client) {
  if (offer?.status !== 'sent' || client?.progression?.contractSigned !== true) return UNSIGNED;
  const offerClientId = text(offer?.salesClientId);
  const clientId = text(client?.id);
  if (offerClientId && clientId && offerClientId !== clientId) return UNSIGNED;

  const candidates = signatureCandidates(client);
  const sentAtMs = timeMs(offer?.sentAt);
  if (sentAtMs === null) {
    const at = earliest(candidates);
    return { signed: true, at: at === null ? '' : iso(at) };
  }
  const atOrAfter = candidates.filter((ms) => ms >= sentAtMs);
  if (atOrAfter.length) return { signed: true, at: iso(earliest(atOrAfter)) };
  if (candidates.length) {
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
  return { signed: true, at: '' };
}

export function durationTermsVersionForOffer(offer, client, { cutoverMs } = {}) {
  const signature = contractSignatureForOffer(offer, client);
  if (!signature.signed) return DURATION_TERMS_VERSION;
  const sentAtMs = timeMs(offer?.sentAt);
  // An offer sent at or after the cut-over never showed the old sentence.
  if (Number.isFinite(cutoverMs) && sentAtMs !== null && sentAtMs >= cutoverMs) return DURATION_TERMS_VERSION;
  const t = timeMs(signature.at);
  if (t === null) return 1;
  if (!Number.isFinite(cutoverMs)) return DURATION_TERMS_VERSION;
  return t < cutoverMs ? 1 : DURATION_TERMS_VERSION;
}

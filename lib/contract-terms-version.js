/**
 * Which duration-terms version an offer's contract renders with.
 * `client` is the sales client. A signed offer uses the stamp on the signature
 * that applies; a signature with no stamp renders version 1. An unsigned offer
 * renders the current version. Nothing here reads the clock or a file.
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

function earliest(times) {
  let best = null;
  for (const ms of times) {
    if (best === null || ms < best) best = ms;
  }
  return best;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A whole number of at least 1. A newer build's version renders as the version this build knows. */
function versionOrNull(version) {
  if (!Number.isInteger(version) || version < 1) return null;
  return version > DURATION_TERMS_VERSION ? DURATION_TERMS_VERSION : version;
}

function currentTermsVersion(client) {
  const stamp = client?.ext?.contractTerms?.signed;
  if (!isPlain(stamp)) return null;
  // The earlier build can clear the tick and set it again; the stored time then no longer matches.
  if (text(stamp.signedAt) !== text(client?.contractSignedAt)) return null;
  return versionOrNull(stamp.version);
}

function earlierTermsVersion(client) {
  return versionOrNull(client?.ext?.contractTerms?.earlierVersion);
}

function planTermsVersion(offer, client) {
  const plan = client?.ext?.contractTerms?.plan;
  if (!isPlain(plan) || plan.offerId !== offer?.id) return null;
  return versionOrNull(plan.version);
}

/**
 * The signature this offer shows, plus which one it is: `current`, `earlier` or `plan`.
 * `at` follows the same rules as `contractSignatureForOffer`.
 */
function chooseSignature(offer, client) {
  if (offer?.status !== 'sent' || client?.progression?.contractSigned !== true) {
    return { signed: false, at: '', kind: '' };
  }
  const offerClientId = text(offer?.salesClientId);
  const clientId = text(client?.id);
  if (offerClientId && clientId && offerClientId !== clientId) {
    return { signed: false, at: '', kind: '' };
  }

  const currentMs = timeMs(client?.contractSignedAt);
  const earlierMs = timeMs(client?.ext?.contractSigning?.earlierSignedAt);
  const candidates = [currentMs, earlierMs].filter((ms) => ms !== null);
  const sentAtMs = timeMs(offer?.sentAt);
  // Equal times are the current signature: the clock alone cannot tell the builds apart.
  const kindOf = (ms) => {
    if (currentMs !== null && currentMs === ms) return 'current';
    if (earlierMs !== null && earlierMs === ms) return 'earlier';
    return 'current';
  };

  if (sentAtMs === null) {
    const at = earliest(candidates);
    if (at === null) return { signed: true, at: '', kind: 'current' };
    return { signed: true, at: iso(at), kind: kindOf(at) };
  }
  const atOrAfter = candidates.filter((ms) => ms >= sentAtMs);
  if (atOrAfter.length) {
    const at = earliest(atOrAfter);
    return { signed: true, at: iso(at), kind: kindOf(at) };
  }
  if (candidates.length) {
    const offerId = offer?.id;
    if (text(offerId) === '' || client?.sitePlan?.offerId !== offerId) {
      return { signed: false, at: '', kind: '' };
    }
    let latestMs = null;
    const history = Array.isArray(client?.sitePlan?.history) ? client.sitePlan.history : [];
    for (const entry of history) {
      if (!String(entry?.reason ?? '').startsWith('offer-upgrade')) continue;
      const atMs = timeMs(entry?.at);
      if (atMs === null || atMs < sentAtMs) continue;
      if (latestMs === null || atMs > latestMs) latestMs = atMs;
    }
    return { signed: true, at: iso(latestMs === null ? sentAtMs : latestMs), kind: 'plan' };
  }
  return { signed: true, at: '', kind: 'current' };
}

/** { signed, at } for the contract this offer shows. `at` is an ISO time, or '' when it was not recorded. */
export function contractSignatureForOffer(offer, client) {
  const chosen = chooseSignature(offer, client);
  if (!chosen.signed) return UNSIGNED;
  return { signed: true, at: chosen.at };
}

export function durationTermsVersionForOffer(offer, client) {
  const chosen = chooseSignature(offer, client);
  if (!chosen.signed) return DURATION_TERMS_VERSION;
  const version = chosen.kind === 'earlier'
    ? earlierTermsVersion(client)
    : chosen.kind === 'plan'
      ? planTermsVersion(offer, client)
      : currentTermsVersion(client);
  return version === null ? 1 : version;
}

function writtenAt(now) {
  const raw = text(now);
  return Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : new Date().toISOString();
}

function termsEmpty(terms) {
  return !terms || !Object.keys(terms).length;
}

/**
 * `ext` for a client write, or `baseExt` unchanged when this write does not sign, unsign or take
 * an offer into the site plan. `recordEarlier` is true only for the single-client write, which is
 * the one that keeps `ext.contractSigning.earlierSignedAt`. Never throws on bad stored data.
 */
export function contractTermsExtOnWrite(current, merged, baseExt, { now, recordEarlier = false } = {}) {
  const turningOn = current?.progression?.contractSigned !== true && merged?.progression?.contractSigned === true;
  const turningOff = current?.progression?.contractSigned === true && merged?.progression?.contractSigned !== true;
  const nextOfferId = merged?.sitePlan?.offerId;
  const planChanged = typeof nextOfferId === 'string'
    && nextOfferId.trim() !== ''
    && nextOfferId !== current?.sitePlan?.offerId;
  if (!turningOn && !turningOff && !planChanged) return baseExt;

  const fromBase = isPlain(baseExt);
  const fromMerged = isPlain(merged?.ext);
  const source = fromBase ? baseExt : (fromMerged ? merged.ext : {});
  const ext = { ...source };
  const terms = isPlain(ext.contractTerms) ? { ...ext.contractTerms } : {};

  if (turningOn) {
    terms.signed = {
      version: DURATION_TERMS_VERSION,
      signedAt: text(merged?.contractSignedAt),
      at: writtenAt(now),
    };
  }

  if (turningOff) {
    delete terms.signed;
    if (recordEarlier) {
      const currentMs = Date.parse(String(current?.contractSignedAt ?? ''));
      if (Number.isFinite(currentMs)) {
        const previousMs = Date.parse(String(merged?.ext?.contractSigning?.earlierSignedAt ?? ''));
        const keepsEarlier = Number.isFinite(previousMs) && previousMs < currentMs;
        if (!keepsEarlier) {
          const stamp = current?.ext?.contractTerms?.signed;
          const valid = isPlain(stamp)
            && text(stamp.signedAt) === text(current?.contractSignedAt)
            && Number.isInteger(stamp.version)
            && stamp.version >= 1;
          if (valid) terms.earlierVersion = stamp.version;
          else delete terms.earlierVersion;
        }
      }
    }
  }

  if (planChanged) {
    terms.plan = {
      offerId: nextOfferId,
      version: DURATION_TERMS_VERSION,
      at: writtenAt(now),
    };
  }

  if (termsEmpty(terms)) delete ext.contractTerms;
  else ext.contractTerms = terms;
  if (!Object.keys(ext).length) return (fromBase || fromMerged) ? ext : baseExt;
  return ext;
}

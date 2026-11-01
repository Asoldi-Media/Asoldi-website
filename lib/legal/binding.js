/**
 * Which catalog version binds an offer or a client.
 *
 * - An offer sent while the legal switch was on carries ext.legal.catalogVersion and dpaVersion
 *   (stampOfferLegalVersions in data/sales-offers.js), plus the tier snapshot and agreed keywords
 *   it was sent with; its contract renders that version with that scope, whatever the switch is
 *   now, so the contract shown or stored at signing is the one that was sent.
 * - An unsent offer renders the current version while the switch is on, and the legacy text
 *   while it is off.
 * - An offer sent before the switch (no stamp) keeps the legacy static texts.
 * - When a client's contract is signed and the client's latest sent offer carries a stamp, the
 *   client gets the snapshot { catalogVersion, dpaVersion } under client.ext.legal (data/sales.js,
 *   for every writer that turns progression.contractSigned on). A stamp exists only when the switch
 *   was on at send, so a hub that never turned the switch on writes nothing.
 * - A signed client without that snapshot stays on the legacy texts.
 * - An already signed client moves to a newer version only when a terms notice recorded under
 *   ext.legal.notice (lib/legal/terms-update.js termsNoticePatch) reaches its effectiveFrom date,
 *   or when the signing step records the accepted offer itself with legalSnapshotPatch(client,
 *   acceptedOffer). A progression write on a client that is already signed records nothing.
 *
 * With the switch off, unsent offers render the legacy text and nothing new is stamped (the switch
 * works as a kill switch for new contracts); offers stamped earlier keep their version.
 */
import { CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { dpaVersionForCatalog, isKnownCatalogVersion } from './archive.js';
import { tierSnapshot } from './plan.js';
import { legalCatalogEnabled } from './switch.js';
import { LEGAL_URLS } from '../legal-urls.js';

export const LEGACY = Object.freeze({ mode: 'legacy' });

function clean(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stampOf(offer) {
  const legal = isPlainObject(offer?.ext?.legal) ? offer.ext.legal : null;
  const version = Number(legal?.catalogVersion);
  return Number.isInteger(version) && version >= 1 ? version : 0;
}

/** True when an offer was sent with a legal stamp (only possible while the switch was on). */
export function offerHasLegalStamp(offer) {
  return stampOf(offer) > 0;
}

/**
 * A legal page's URL for one catalog version ('legacy' for the static text). The page then shows
 * exactly that version's text, also after a newer version is published.
 */
export function versionedLegalUrl(doc, version) {
  const base = LEGAL_URLS[doc] || LEGAL_URLS.vilkar;
  if (version === 'legacy') return `${base}?versjon=legacy`;
  const number = Number(version);
  return Number.isInteger(number) && number >= 1 ? `${base}?versjon=${number}` : base;
}

/**
 * { mode: 'legacy' } or { mode: 'catalog', catalogVersion, dpaVersion, tiers? } for one offer's
 * contract. `tiers` is the tier snapshot of a stamped offer (lib/legal/plan.js). The stamp decides
 * for a stamped offer; the switch decides only for offers without one.
 */
export function legalSourceForOffer(offer, { settings = null, enabled = null } = {}) {
  if (!offer) return LEGACY;
  const stamped = stampOf(offer);
  if (stamped && isKnownCatalogVersion(stamped)) {
    const tiers = isPlainObject(offer.ext.legal.tiers) ? offer.ext.legal.tiers : null;
    return {
      mode: 'catalog',
      catalogVersion: stamped,
      dpaVersion: clean(offer.dpaVersion) || dpaVersionForCatalog(stamped, DPA_VERSION),
      ...(tiers ? { tiers } : {}),
    };
  }
  if (clean(offer.status) === 'sent') return LEGACY;
  const on = enabled === null ? legalCatalogEnabled({ settings }) : Boolean(enabled);
  if (!on) return LEGACY;
  return { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION };
}

// The agreed keywords of a client as contract text. lib/routes/legal-routes.js sets it at boot
// (lib/legal/contract.js agreedKeywordsTextForClient); without it nothing is recorded at send.
let agreedKeywordsResolver = null;

export function setAgreedKeywordsResolver(resolver) {
  agreedKeywordsResolver = typeof resolver === 'function' ? resolver : null;
}

function agreedKeywordsAtSend(offer) {
  if (!agreedKeywordsResolver) return null;
  try {
    return clean(agreedKeywordsResolver(clean(offer?.salesClientId)));
  } catch {
    return null;
  }
}

/**
 * The stamps an offer gets at send while the switch is on: { dpaVersion, catalogVersion, tiers,
 * agreedKeywordsText? }. `tiers` freezes what each tier contained, and agreedKeywordsText the
 * client's agreed keywords, so the signed contract's scope does not change afterwards.
 */
export function offerSendStamp(offer = null) {
  const stamp = { dpaVersion: DPA_VERSION, catalogVersion: CATALOG_VERSION, tiers: tierSnapshot() };
  const keywords = offer ? agreedKeywordsAtSend(offer) : null;
  if (keywords !== null) stamp.agreedKeywordsText = keywords;
  return stamp;
}

/** The agreed keywords text a stamped offer was sent with, or undefined (use the current text). */
export function stampedAgreedKeywordsText(offer) {
  if (!stampOf(offer)) return undefined;
  const value = offer.ext.legal.agreedKeywordsText;
  return typeof value === 'string' ? value : undefined;
}

function noticeOf(snapshot) {
  const notice = isPlainObject(snapshot?.notice) ? snapshot.notice : null;
  const version = Number(notice?.catalogVersion);
  const at = Date.parse(clean(notice?.effectiveFrom));
  if (!Number.isInteger(version) || version < 1 || !Number.isFinite(at)) return null;
  return { catalogVersion: version, dpaVersion: clean(notice.dpaVersion), effectiveFrom: clean(notice.effectiveFrom), at };
}

/**
 * The version a client is bound to:
 *   { mode: 'catalog', catalogVersion, dpaVersion, boundAt, offerId, source } from the signing
 *     snapshot, or from a terms notice that has taken effect (source 'signing' or 'notice');
 *   { mode: 'legacy' } for a signed client with neither;
 *   { mode: 'unsigned', catalogVersion } (the current version applies to the next contract).
 * A notice that has not taken effect yet comes back as `pendingNotice` { catalogVersion, effectiveFrom }.
 */
export function legalBindingForClient(client, { now = new Date() } = {}) {
  const snapshot = isPlainObject(client?.ext?.legal) ? client.ext.legal : null;
  const version = Number(snapshot?.catalogVersion);
  const signed = Number.isInteger(version) && version >= 1;
  let binding;
  if (signed) {
    binding = {
      mode: 'catalog',
      catalogVersion: version,
      dpaVersion: clean(snapshot.dpaVersion),
      boundAt: clean(snapshot.boundAt),
      offerId: clean(snapshot.offerId),
      source: 'signing',
    };
  } else if (client?.progression?.contractSigned === true) {
    binding = LEGACY;
  } else {
    return { mode: 'unsigned', catalogVersion: CATALOG_VERSION };
  }
  const notice = noticeOf(snapshot);
  if (!notice || (signed && notice.catalogVersion <= version) || !isKnownCatalogVersion(notice.catalogVersion)) return binding;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (notice.at > nowMs) return { ...binding, pendingNotice: { catalogVersion: notice.catalogVersion, effectiveFrom: notice.effectiveFrom } };
  return {
    mode: 'catalog',
    catalogVersion: notice.catalogVersion,
    dpaVersion: notice.dpaVersion || dpaVersionForCatalog(notice.catalogVersion, DPA_VERSION),
    boundAt: notice.effectiveFrom,
    offerId: signed ? clean(snapshot.offerId) : '',
    source: 'notice',
  };
}

/**
 * The client update that records the legal snapshot when a contract is signed, or null. Only for
 * an offer that was sent with a stamp (which exists only when the switch was on at send), whatever
 * the switch is now, so a stamped contract signed while the switch is off still binds its version.
 * Keeps every other ext key. Signing the same offer again changes nothing.
 *
 * data/sales.js calls it with the client's latest sent offer when progression.contractSigned turns
 * on. A signing step that knows which offer was accepted (for example an upgrade by a client who
 * is already signed) calls it with that offer and writes the patch; that moves the client to the
 * offer's version.
 */
export function legalSnapshotPatch(client, offer, { now = new Date() } = {}) {
  if (!client || !offer) return null;
  const stamped = stampOf(offer);
  if (!stamped) return null;
  const ext = isPlainObject(client.ext) ? client.ext : {};
  const current = isPlainObject(ext.legal) ? ext.legal : {};
  const dpaVersion = clean(offer.dpaVersion);
  if (Number(current.catalogVersion) === stamped && clean(current.offerId) === clean(offer.id) && clean(current.dpaVersion) === dpaVersion) return null;
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    ext: {
      ...ext,
      legal: {
        ...current,
        catalogVersion: stamped,
        dpaVersion,
        boundAt: at,
        offerId: clean(offer.id),
        source: 'signing',
      },
    },
  };
}

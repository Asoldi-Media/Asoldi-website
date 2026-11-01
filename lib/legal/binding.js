/**
 * Which catalog version binds an offer or a client.
 *
 * - An offer sent while the legal switch was on carries ext.legal.catalogVersion and dpaVersion
 *   (stampOfferLegalVersions in data/sales-offers.js); its contract renders that version.
 * - An unsent offer renders the current version while the switch is on.
 * - An offer sent before the switch (no stamp) keeps the legacy static texts.
 * - Signing an offer with a stamp records { catalogVersion, dpaVersion } under client.ext.legal.
 *   A signed client without that snapshot stays on the legacy texts. A client moves to a newer
 *   version only by signing again; lib/legal/terms-update.js lists who is on an older version.
 *
 * With the switch off everything is legacy and nothing is written.
 */
import { CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { dpaVersionForCatalog, isKnownCatalogVersion } from './archive.js';
import { legalCatalogEnabled } from './switch.js';

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

/** { mode: 'legacy' } or { mode: 'catalog', catalogVersion, dpaVersion } for one offer's contract. */
export function legalSourceForOffer(offer, { settings = null, enabled = null } = {}) {
  const on = enabled === null ? legalCatalogEnabled({ settings }) : Boolean(enabled);
  if (!on || !offer) return LEGACY;
  const stamped = stampOf(offer);
  if (stamped && isKnownCatalogVersion(stamped)) {
    return { mode: 'catalog', catalogVersion: stamped, dpaVersion: clean(offer.dpaVersion) || dpaVersionForCatalog(stamped, DPA_VERSION) };
  }
  if (clean(offer.status) === 'sent') return LEGACY;
  return { mode: 'catalog', catalogVersion: CATALOG_VERSION, dpaVersion: DPA_VERSION };
}

/** The stamps an offer gets at send while the switch is on: { dpaVersion, catalogVersion }. */
export function offerSendStamp() {
  return { dpaVersion: DPA_VERSION, catalogVersion: CATALOG_VERSION };
}

/**
 * The version a client is bound to:
 *   { mode: 'catalog', catalogVersion, dpaVersion, boundAt, offerId } from the signing snapshot;
 *   { mode: 'legacy' } for a signed client without a snapshot;
 *   { mode: 'unsigned', catalogVersion } (the current version applies to the next contract).
 */
export function legalBindingForClient(client) {
  const snapshot = isPlainObject(client?.ext?.legal) ? client.ext.legal : null;
  const version = Number(snapshot?.catalogVersion);
  if (Number.isInteger(version) && version >= 1) {
    return {
      mode: 'catalog',
      catalogVersion: version,
      dpaVersion: clean(snapshot.dpaVersion),
      boundAt: clean(snapshot.boundAt),
      offerId: clean(snapshot.offerId),
    };
  }
  if (client?.progression?.contractSigned === true) return LEGACY;
  return { mode: 'unsigned', catalogVersion: CATALOG_VERSION };
}

/**
 * The client update that records the legal snapshot when a contract is signed, or null. Only
 * while the switch is on, and only for an offer that was sent with a stamp. Keeps every other ext
 * key. Signing the same offer again changes nothing.
 */
export function legalSnapshotPatch(client, offer, { settings = null, enabled = null, now = new Date() } = {}) {
  const on = enabled === null ? legalCatalogEnabled({ settings }) : Boolean(enabled);
  if (!on || !client || !offer) return null;
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

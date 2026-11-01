/**
 * Data processing agreement (DPA) versions and signing.
 *
 * - DPA_VERSION is stamped on an offer when it is sent (data/sales-offers.js
 *   stampOfferLegalVersions), while the legal switch is on. Signing such an offer accepts that
 *   version together with the contract.
 * - A client can also sign the current version in the portal (POST /api/client/dpa/sign), which
 *   writes client.ext.dpa = { version, signedAt, catalogVersion, ... }. Signing again with the
 *   same version changes nothing.
 * - Every service agreement signed without a stamped offer (the legacy contract) incorporates the
 *   DPA as published on the signing date. Such a client has a DPA in force ('accepted-legacy'),
 *   with no recorded version; the portal offers to sign the current version, without saying the
 *   DPA is missing.
 * - dpaStatus(client) tells the portal whether the client has a DPA in force and whether it is the
 *   current version. dpaMissingAtSigning(offer) is the delivery gate's rule at signing: an accepted
 *   offer without a stamped DPA version gets the developer-only 'dpa-missing' line.
 *
 * Data lives only under client.ext (a key every hub version keeps). The signing step may also
 * record the offer's version as client.ext.dpa.offerVersion; this module keeps that field.
 */
import { CATALOG_VERSION, DPA_VERSION } from './catalog.js';
import { legalCatalogEnabled } from './switch.js';

export { DPA_VERSION };

export const DPA_STATUSES = Object.freeze(['disabled', 'not-required', 'signed', 'accepted-with-contract', 'outdated', 'accepted-legacy', 'missing']);

function clean(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A signed client that buys a website (not the SSU product) needs a DPA. */
export function clientNeedsDpa(client) {
  if (!client || client.progression?.contractSigned !== true) return false;
  return clean(client.product).toLowerCase() !== 'ssu';
}

/**
 * {status, enabled, required, missing, current, version, signedAt, offerVersion, upToDate}.
 *   disabled: the legal switch is off (nothing is required and nothing is shown);
 *   not-required: no signed website contract;
 *   signed: the current version was signed in the portal;
 *   accepted-with-contract: the signed offer carried the current version;
 *   outdated: an older version was signed or accepted; it stays in force (missing is false);
 *   accepted-legacy: the service agreement was signed without a stamped offer, and the legacy
 *     contract incorporates the DPA as published on the signing date (missing is false);
 *   missing: a signed website client bound to a catalog version with no DPA version recorded.
 * `upToDate` is true only for the current version; the portal offers to sign it otherwise.
 */
export function dpaStatus(client, { settings = null, enabled = null } = {}) {
  const on = enabled === null ? legalCatalogEnabled({ settings }) : Boolean(enabled);
  const ext = isPlainObject(client?.ext) ? client.ext : {};
  const dpa = isPlainObject(ext.dpa) ? ext.dpa : {};
  const legal = isPlainObject(ext.legal) ? ext.legal : {};
  const version = clean(dpa.version);
  const offerVersion = clean(dpa.offerVersion) || clean(legal.dpaVersion);
  const base = {
    enabled: on,
    current: DPA_VERSION,
    version,
    signedAt: clean(dpa.signedAt),
    offerVersion,
  };
  if (!on) return { ...base, status: 'disabled', required: false, missing: false, upToDate: false };
  const required = clientNeedsDpa(client);
  if (version === DPA_VERSION) return { ...base, status: 'signed', required, missing: false, upToDate: true };
  if (offerVersion === DPA_VERSION) return { ...base, status: 'accepted-with-contract', required, missing: false, upToDate: true };
  if (!required) return { ...base, status: 'not-required', required: false, missing: false, upToDate: false };
  if (version || offerVersion) return { ...base, status: 'outdated', required, missing: false, upToDate: false };
  const boundToCatalog = Number.isInteger(Number(legal.catalogVersion)) && Number(legal.catalogVersion) >= 1;
  if (!boundToCatalog) return { ...base, status: 'accepted-legacy', required, missing: false, upToDate: false };
  return { ...base, status: 'missing', required, missing: true, upToDate: false };
}

/**
 * The delivery gate's rule at signing: true when the legal switch is on and the accepted offer (or
 * the chosen alternative of a dual offer) carries no DPA version, so the DPA was not shown with
 * the contract. The gate then adds its developer-only 'dpa-missing' line and asks for a separate
 * signature; a client who already signed the current version in the portal needs nothing.
 */
export function dpaMissingAtSigning(offer, { alternativeIndex = null, client = null, settings = null, enabled = null } = {}) {
  const on = enabled === null ? legalCatalogEnabled({ settings }) : Boolean(enabled);
  if (!on || !offer) return false;
  if (client && clean(client?.ext?.dpa?.version) === DPA_VERSION) return false;
  const alternatives = Array.isArray(offer.alternatives) ? offer.alternatives : [];
  const chosen = alternativeIndex === 0 || alternativeIndex === 1 ? alternatives[alternativeIndex] : null;
  return !clean(chosen?.dpaVersion) && !clean(offer.dpaVersion);
}

/**
 * The client update that records a portal DPA signature of the current version, or null when
 * the current version is already signed (signing is idempotent). Keeps every other ext key and
 * every other field of ext.dpa (for example offerVersion). `catalogVersion` names the catalog
 * version whose published DPA text was signed.
 */
export function dpaSignPatch(client, { now = new Date(), userId = '', ip = '', userAgent = '' } = {}) {
  const ext = isPlainObject(client?.ext) ? client.ext : {};
  const dpa = isPlainObject(ext.dpa) ? ext.dpa : {};
  if (clean(dpa.version) === DPA_VERSION && clean(dpa.signedAt)) return null;
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const history = Array.isArray(dpa.history) ? dpa.history.slice(-9) : [];
  if (clean(dpa.version)) history.push({ version: clean(dpa.version), signedAt: clean(dpa.signedAt) });
  return {
    ext: {
      ...ext,
      dpa: {
        ...dpa,
        version: DPA_VERSION,
        catalogVersion: CATALOG_VERSION,
        signedAt: at,
        source: 'portal',
        userId: clean(userId).slice(0, 120),
        ip: clean(ip).slice(0, 80),
        userAgent: clean(userAgent).slice(0, 300),
        ...(history.length ? { history } : {}),
      },
    },
  };
}

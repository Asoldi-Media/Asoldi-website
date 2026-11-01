/**
 * Data processing agreement (DPA) versions and signing.
 *
 * - DPA_VERSION is stamped on an offer when it is sent (data/sales-offers.js
 *   stampOfferLegalVersions), while the legal switch is on. Signing such an offer accepts that
 *   version together with the contract.
 * - A client can also sign the current version in the portal (POST /api/client/dpa/sign), which
 *   writes client.ext.dpa = { version, signedAt, ... }. Signing again with the same version
 *   changes nothing.
 * - dpaStatus(client) tells the gate and the portal whether the client has a DPA in force.
 *
 * Data lives only under client.ext (a key every hub version keeps). The signing step may also
 * record the offer's version as client.ext.dpa.offerVersion; this module keeps that field.
 */
import { DPA_VERSION } from './catalog.js';
import { legalCatalogEnabled } from './switch.js';

export { DPA_VERSION };

export const DPA_STATUSES = Object.freeze(['disabled', 'not-required', 'signed', 'accepted-with-contract', 'outdated', 'missing']);

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
 *   disabled: the legal switch is off (nothing is required and the gate shows no line);
 *   not-required: no signed website contract;
 *   signed: the current version was signed in the portal;
 *   accepted-with-contract: the signed offer carried the current version;
 *   outdated: only an older version was signed or accepted;
 *   missing: a signed website client with no DPA (the gate's dpa-missing line).
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
  if (version || offerVersion) return { ...base, status: 'outdated', required, missing: true, upToDate: false };
  return { ...base, status: 'missing', required, missing: true, upToDate: false };
}

/**
 * The client update that records a portal DPA signature of the current version, or null when
 * the current version is already signed (signing is idempotent). Keeps every other ext key and
 * every other field of ext.dpa (for example offerVersion).
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

/**
 * Sales copy from the clause catalog for the offer letter's product lines ("Hva er inkludert").
 * While the legal switch is off, catalogOfferIncludes() returns null and callers keep the static
 * tier lines from lib/website-tiers.js.
 */
import { CATALOG, CATALOG_VERSION } from './catalog.js';
import { archivedVersions, catalogForVersion } from './archive.js';
import { offerHasLegalStamp } from './binding.js';
import { offerLetterIncludes } from './render.js';
import { legalCatalogEnabled } from './switch.js';
import { WEBSITE_TIERS } from '../website-tiers.js';

/**
 * The catalog's offer-letter lines for a tier while the switch is on, else null. The lines are the
 * published text of the current version, so they never depend on stored settings.
 */
export function catalogOfferIncludes(tierId, { settings = null } = {}) {
  if (!legalCatalogEnabled({ settings })) return null;
  const lines = offerLetterIncludes(tierId);
  return lines.length ? lines : null;
}

/**
 * Whether catalog offer-letter lines count as tier lines when a plan is derived from an offer's
 * text: while the switch is on, or for an offer sent with a legal stamp. With the switch off and
 * no stamp, plan derivation is the same as before the catalog existed.
 */
export function catalogTierLinesApply(offer = null, { settings = null } = {}) {
  if (offer && offerHasLegalStamp(offer)) return true;
  return legalCatalogEnabled({ settings });
}

let lineCache = null;

/** tierId -> Set of every offer-letter line any catalog version (current or archived) gives that tier. */
function catalogLinesByTier() {
  if (lineCache) return lineCache;
  const catalogs = [CATALOG];
  for (const version of archivedVersions()) {
    if (version === CATALOG_VERSION) continue;
    const catalog = catalogForVersion(version);
    if (catalog) catalogs.push(catalog);
  }
  lineCache = new Map();
  for (const tier of WEBSITE_TIERS) {
    const lines = new Set();
    for (const catalog of catalogs) for (const line of offerLetterIncludes(tier.id, { catalog })) lines.add(line);
    lineCache.set(tier.id, lines);
  }
  return lineCache;
}

/** True when `line` is an offer-letter line the catalog gives tier `tierId` (any version). */
export function isCatalogTierLine(line, tierId) {
  return Boolean(catalogLinesByTier().get(String(tierId || ''))?.has(String(line || '').trim()));
}

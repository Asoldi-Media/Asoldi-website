/**
 * Sales copy from the clause catalog for the offer letter's product lines ("Hva er inkludert").
 * While the legal switch is off, catalogOfferIncludes() returns null and callers keep the static
 * tier lines from lib/website-tiers.js.
 */
import { CATALOG, CATALOG_VERSION } from './catalog.js';
import { archivedVersions, catalogForVersion } from './archive.js';
import { offerLetterIncludes } from './render.js';
import { legalCatalogEnabled } from './switch.js';
import { WEBSITE_TIERS } from '../website-tiers.js';

/** The catalog's offer-letter lines for a tier while the switch is on, else null. */
export function catalogOfferIncludes(tierId, { settings = null } = {}) {
  if (!legalCatalogEnabled({ settings })) return null;
  const lines = offerLetterIncludes(tierId, { settings });
  return lines.length ? lines : null;
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

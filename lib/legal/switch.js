/**
 * The legal texts switch: automation setting legal.catalogTexts.enabled (default false).
 *
 * While it is off, the legal pages, contract copy, offer letters, sales copy and portal plan cards
 * are the static texts they were before the clause catalog, offers get no version stamps, plans
 * derived from offer text are unchanged, the portal DPA card stays hidden and every legal route
 * answers 404. Signing records a legal snapshot only for an offer stamped while the switch was on,
 * so a hub that never turned it on writes nothing new.
 *
 * Turning it off after an on-period keeps what was sent: an offer stamped while it was on keeps
 * rendering its stamped version, and the numbered versions of the three legal pages its contract
 * links stay readable (lib/routes/legal-routes.js). New contracts are the static texts again.
 */
import { getAutomationSettings } from '../../data/automation-settings.js';

export const LEGAL_SWITCH_PATH = 'legal.catalogTexts.enabled';

/** True only when legal.catalogTexts.enabled is true in the given (or stored) settings. */
export function legalCatalogEnabled({ settings = null } = {}) {
  let resolved = settings;
  if (!resolved) {
    try {
      resolved = getAutomationSettings();
    } catch {
      return false;
    }
  }
  return resolved?.legal?.catalogTexts?.enabled === true;
}

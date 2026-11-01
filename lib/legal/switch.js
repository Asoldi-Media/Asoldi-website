/**
 * The legal texts switch: automation setting legal.catalogTexts.enabled (default false).
 *
 * While it is off, the legal pages, contract copy, offer letters and sales copy are the static
 * texts they were before the clause catalog, offers get no version stamps, signing records no
 * legal snapshot, the portal DPA card stays hidden and every legal route answers 404.
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

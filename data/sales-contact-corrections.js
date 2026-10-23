/**
 * Contact corrections for sales leads (matched by business name or phone, applied at
 * boot by applyConfiguredSalesContactCorrections in server.js).
 *
 * The list holds client contact data (names, phone numbers, e-mail, addresses), and this
 * repo is public, so it lives on the hub data disk, not in Git:
 *   <dataDir>/sales-contact-corrections.json  →  [ { businessName, aliases?, contactPerson?,
 *     contactEmail?, contactPhone?, meetingMode?, meetingAtHint?, meetingPlace?, notes?,
 *     createIfMissing?, force*? }, … ]   (or { "corrections": [ … ] })
 * A missing or unreadable file means no corrections.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from './storage-path.js';

export const SALES_CONTACT_CORRECTIONS_FILE = 'sales-contact-corrections.json';

export function loadSalesContactCorrections(dataDir = getPersistentDataDir()) {
  const file = join(dataDir, SALES_CONTACT_CORRECTIONS_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.corrections;
    return Array.isArray(list) ? list.filter((row) => row && typeof row === 'object' && row.businessName) : [];
  } catch (error) {
    console.warn(`[sales] ${SALES_CONTACT_CORRECTIONS_FILE} is not valid JSON: ${error?.message || error}`);
    return [];
  }
}

export const SALES_CONTACT_CORRECTIONS = loadSalesContactCorrections();

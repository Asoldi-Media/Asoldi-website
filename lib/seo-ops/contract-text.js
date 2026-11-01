/**
 * The contract line for a client's agreed keywords, from its SEO record (lib/seo-ops/record.js).
 * Pure: no Node imports and no I/O, so the same text can be shown in the admin UI, frozen at signing
 * and printed in the contract.
 *
 *   agreedKeywordsContractText(record) -> 'Avtalte søkeord: a, b, c' | null
 *
 * Only approved keywords count, in the order they were approved, at most three. A record without
 * approved keywords gives null, so a contract without agreed keywords has no such line at all.
 */
import { MAX_APPROVED_AGREED_KEYWORDS } from './agreed-limits.js';
import { isRegulatedPhrase, normalizeSeoPhrase, seoPhraseKey } from './phrase-filters.js';

export const AGREED_KEYWORDS_CONTRACT_LABEL = 'Avtalte søkeord';

/** Approved agreed keywords of a record, in approval order (regulated phrases are never listed). */
export function approvedAgreedPhrases(record) {
  const rows = Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (row?.status !== 'approved') continue;
    const phrase = normalizeSeoPhrase(row.phrase);
    const key = seoPhraseKey(phrase);
    if (!phrase || seen.has(key) || isRegulatedPhrase(phrase)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= MAX_APPROVED_AGREED_KEYWORDS) break;
  }
  return out;
}

export function agreedKeywordsContractText(record) {
  const phrases = approvedAgreedPhrases(record);
  if (!phrases.length) return null;
  return `${AGREED_KEYWORDS_CONTRACT_LABEL}: ${phrases.join(', ')}`;
}

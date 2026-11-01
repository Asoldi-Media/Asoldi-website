/**
 * How keyword consumers (Maps ranking, analytics goals) read an SEO record. Pure: the record is
 * passed in (lib/seo-ops/record.js reads it), so lib/analytics-insights.js stays free of I/O.
 *
 * A record guides consumers only once a developer has approved or blocked a keyword. Until then a
 * consumer's output is exactly what it was without a record. Once it does, phrases come in this
 * order: approved agreed keywords, then the page map's primaries, then the caller's own (legacy)
 * phrases. Blocked phrases and prescription-only substances never pass. Phrases with the business's
 * own name (isBrandPhrase, a heuristic) are left out of the page-map and legacy phrases only: an
 * approved keyword always passes, so the consumers track exactly the keywords the contract line
 * (lib/seo-ops/contract-text.js) lists.
 */
import { isBrandPhrase, isRegulatedPhrase, normalizeSeoPhrase, seoPhraseKey } from './phrase-filters.js';

export function recordGuidesConsumers(record) {
  const rows = Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : [];
  return rows.some((row) => row?.status === 'approved' || row?.status === 'blocked');
}

function pageMapOf(record) {
  if (Array.isArray(record?.pageMap)) return record.pageMap;
  if (Array.isArray(record?.planSummary?.pageMap)) return record.planSummary.pageMap;
  return [];
}

function approvedPhrases(record) {
  const rows = Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : [];
  return rows.filter((row) => row?.status === 'approved').map((row) => normalizeSeoPhrase(row.phrase)).filter(Boolean);
}

function pageMapPrimaries(record) {
  return pageMapOf(record)
    .filter((row) => row && row.indexable !== false)
    .map((row) => normalizeSeoPhrase(row.primary))
    .filter(Boolean);
}

/** Approved agreed keywords, then indexable page-map primaries, in that order (unfiltered). */
export function recordPhrases(record) {
  return [...approvedPhrases(record), ...pageMapPrimaries(record)];
}

/**
 * keep(phrase) for a record: false for blocked phrases and prescription-only substances, and, with
 * `brand: true` (default), for the business's own name and the plan's brand searches.
 */
export function recordPhraseFilter(record, { brandName = '', brand = true } = {}) {
  const blocked = new Set(
    (Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : [])
      .filter((row) => row?.status === 'blocked')
      .map((row) => seoPhraseKey(row.phrase)),
  );
  const brandPhrases = Array.isArray(record?.planSummary?.brand) ? record.planSummary.brand : [];
  return (phrase) => {
    const clean = normalizeSeoPhrase(phrase);
    if (!clean) return false;
    if (blocked.has(seoPhraseKey(clean))) return false;
    if (isRegulatedPhrase(clean)) return false;
    if (brand && isBrandPhrase(clean, brandName, brandPhrases)) return false;
    return true;
  };
}

/**
 * Record phrases first, then `legacy` (strings), filtered and de-duplicated (case-insensitive), at
 * most `limit`. Phrases keep the spelling of their first occurrence. Approved keywords skip the
 * brand heuristic (a developer chose them); every other phrase goes through it.
 */
export function phrasesWithRecord(record, legacy = [], { limit = 5, brandName = '' } = {}) {
  const keepApproved = recordPhraseFilter(record, { brand: false });
  const keep = recordPhraseFilter(record, { brandName });
  const seen = new Set();
  const out = [];
  const rows = [
    ...approvedPhrases(record).map((phrase) => [phrase, keepApproved]),
    ...[...pageMapPrimaries(record), ...legacy].map((phrase) => [phrase, keep]),
  ];
  for (const [raw, filter] of rows) {
    const phrase = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    if (!filter(phrase)) continue;
    out.push(phrase);
    if (out.length >= limit) break;
  }
  return out;
}

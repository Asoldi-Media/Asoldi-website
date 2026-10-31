/**
 * How keyword consumers (Maps ranking, analytics goals) read an SEO record. Pure: the record is
 * passed in (lib/seo-ops/record.js reads it), so lib/analytics-insights.js stays free of I/O.
 *
 * A record guides consumers only once a developer has approved or blocked a keyword. Until then a
 * consumer's output is exactly what it was without a record. Once it does, phrases come in this
 * order: approved agreed keywords, then the page map's primaries, then the caller's own (legacy)
 * phrases; blocked phrases, prescription-only substances and the business's own name never pass.
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

/** Approved agreed keywords, then indexable page-map primaries, in that order (unfiltered). */
export function recordPhrases(record) {
  const rows = Array.isArray(record?.agreedKeywords) ? record.agreedKeywords : [];
  const approved = rows.filter((row) => row?.status === 'approved').map((row) => normalizeSeoPhrase(row.phrase));
  const primaries = pageMapOf(record)
    .filter((row) => row && row.indexable !== false)
    .map((row) => normalizeSeoPhrase(row.primary));
  return [...approved, ...primaries].filter(Boolean);
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
 * most `limit`. Phrases keep the spelling of their first occurrence.
 */
export function phrasesWithRecord(record, legacy = [], { limit = 5, brandName = '' } = {}) {
  const keep = recordPhraseFilter(record, { brandName });
  const seen = new Set();
  const out = [];
  for (const raw of [...recordPhrases(record), ...legacy]) {
    const phrase = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    if (!keep(phrase)) continue;
    out.push(phrase);
    if (out.length >= limit) break;
  }
  return out;
}

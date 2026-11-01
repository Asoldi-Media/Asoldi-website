/**
 * Phrase checks shared by the SEO record (lib/seo-ops/record.js) and the hub code that reads keywords
 * from it (Maps ranking, analytics goals). Pure: no Node imports, so the admin UI can use it too.
 *
 *  - normalizeSeoPhrase: one line, single spaces, NFC, at most 80 characters.
 *  - seoPhraseKey: the case-folded form two phrases are compared by.
 *  - isRegulatedPhrase: the phrase names a substance that is a prescription-only medicine in Norway.
 *    Advertising those to the public is not allowed, so such a phrase is never stored as an agreed
 *    keyword and never used as a tracked keyword, whatever its status.
 *  - isBrandPhrase: the phrase carries the business's own name (or is one the Maker marked as a brand
 *    search). A heuristic: it flags rows in the admin UI and keeps own-name phrases out of the
 *    keywords a consumer picks by itself, but never overrides a developer's approval.
 *  - isExactBrandPhrase: the phrase is exactly a listed brand search or the business name without its
 *    legal form. Approving one needs an explicit confirmation (lib/seo-ops/record.js).
 */

export const SEO_PHRASE_MAX_CHARS = 80;
export const SEO_PHRASE_MAX_WORDS = 6;
/** Listed terms at least this long also match inside a word; shorter ones only at its start. */
export const REGULATED_INFIX_MIN_CHARS = 8;

/**
 * Prescription-only substances (generic and common product names) that come up in client trades
 * such as supplements, clinics and pharmacies. A phrase is regulated when one of its words starts
 * with a listed term, or, for a term of REGULATED_INFIX_MIN_CHARS letters or more, contains it
 * anywhere (Norwegian compounds such as "melatonintabletter"). Shorter terms match only at the start
 * of a word, so ordinary words that happen to contain one ("specialist") are not caught. The list
 * only grows; a term is removed only when its classification changes.
 */
export const REGULATED_SUBSTANCE_TERMS = Object.freeze([
  'melatonin',
  'sildenafil',
  'tadalafil',
  'vardenafil',
  'viagra',
  'cialis',
  'finasterid',
  'finasteride',
  'propecia',
  'semaglutid',
  'semaglutide',
  'liraglutid',
  'liraglutide',
  'tirzepatid',
  'tirzepatide',
  'ozempic',
  'wegovy',
  'mounjaro',
  'saxenda',
  'botox',
  'botulinum',
  'botulinumtoksin',
  'isotretinoin',
  'tretinoin',
  'modafinil',
  'tramadol',
  'kodein',
  'codeine',
  'oksykodon',
  'oxycodone',
  'diazepam',
  'zopiklon',
  'zopiclone',
  'zolpidem',
]);

// Legal-form and filler words that say nothing about which business a name belongs to.
const NAME_FILLER = new Set(['as', 'asa', 'ans', 'da', 'enk', 'nuf', 'sa', 'ba', 'ltd', 'inc', 'og', 'and', 'the', 'av', 'i']);

function text(value) {
  return String(value ?? '');
}

export function normalizeSeoPhrase(value) {
  return text(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEO_PHRASE_MAX_CHARS)
    .trim();
}

export function seoPhraseKey(value) {
  return normalizeSeoPhrase(value).toLocaleLowerCase('nb-NO');
}

/** Lower-case word tokens (letters and digits, Nordic letters included). */
export function seoPhraseTokens(value) {
  return seoPhraseKey(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function seoPhraseWordCount(value) {
  const phrase = normalizeSeoPhrase(value);
  return phrase ? phrase.split(' ').length : 0;
}

/** The listed term a phrase names, or ''. */
export function regulatedTermIn(value, terms = REGULATED_SUBSTANCE_TERMS) {
  const tokens = seoPhraseTokens(value);
  for (const term of terms) {
    for (const token of tokens) {
      if (token.startsWith(term) || (term.length >= REGULATED_INFIX_MIN_CHARS && token.includes(term))) return term;
    }
  }
  return '';
}

export function isRegulatedPhrase(value, terms = REGULATED_SUBSTANCE_TERMS) {
  return Boolean(regulatedTermIn(value, terms));
}

/** Tokens of a business name that identify it (3+ characters, no legal forms or fillers). */
export function brandTokens(name) {
  return seoPhraseTokens(name).filter((token) => token.length > 2 && !NAME_FILLER.has(token));
}

/**
 * True when the phrase is one of the listed brand phrases, or when it carries the business name:
 * at least two of the name's tokens (one for a one-token name) and at least 60 % of them.
 */
function listedBrandPhrase(key, brandPhrases) {
  for (const phrase of Array.isArray(brandPhrases) ? brandPhrases : []) {
    if (seoPhraseKey(typeof phrase === 'string' ? phrase : phrase?.phrase || phrase?.keyword) === key) return true;
  }
  return false;
}

export function isBrandPhrase(value, brandName = '', brandPhrases = []) {
  const key = seoPhraseKey(value);
  if (!key) return false;
  if (listedBrandPhrase(key, brandPhrases)) return true;
  const nameTokens = brandTokens(brandName);
  if (!nameTokens.length) return false;
  const words = new Set(seoPhraseTokens(value));
  const hits = nameTokens.filter((token) => words.has(token)).length;
  return hits >= Math.min(2, nameTokens.length) && hits / nameTokens.length >= 0.6;
}

/**
 * True when the phrase is one of the listed brand phrases, or the business name itself: the same
 * identifying words in the same order once legal forms and fillers are left out ("Eksempel Bad AS"
 * and "eksempel bad"). "bad eksempel" is not; isBrandPhrase still flags it.
 */
export function isExactBrandPhrase(value, brandName = '', brandPhrases = []) {
  const key = seoPhraseKey(value);
  if (!key) return false;
  if (listedBrandPhrase(key, brandPhrases)) return true;
  const nameTokens = brandTokens(brandName);
  if (!nameTokens.length) return false;
  return brandTokens(value).join(' ') === nameTokens.join(' ');
}

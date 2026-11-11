// lib/seo-keywords/claims/check.js
// -----------------------------------------------------------------------------
// Regulated-content checks for keyword plans and drafted text.
//
//   findRegulatedTerms(text, {healthContext})   deterministic hits: substance | disease
//   screenKeywords(keywords, {allowDisease, industry})
//        substance term            -> block, always
//        disease / treat wording   -> block in a health or supplement industry, or when the
//                                     keyword names a nutrient or a regulated substance
//   checkClaims(text, {industry, productFacts, extract})
//        substance term            -> reject, always
//        disease wording           -> reject when the industry, a nutrient/substance, or an
//                                     extracted statement makes the whole text a health context
//        health/benefit statement  -> accepted only when it matches one authorised claim's wording
//                                     and nutrient, is not negated, and the facts meet the condition
//        extractor failure         -> reject (fail closed), including text that is not in the draft
//   checkPlanCompliance(plan, {industry})       keyword plan sign-off rule
//
// No decision keys on a template; the only inputs are the text, the industry words and the facts.
// -----------------------------------------------------------------------------
import { loadClaimsData } from "./data.js";

function compact(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Lowercase, drop punctuation, collapse spaces (keeps letters and digits of any script). */
export function normalizeClaimText(value = "") {
  return compact(
    String(value ?? "")
      .normalize("NFKC")
      .replace(/\p{Cf}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
  );
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const reCache = new Map();
function boundaryRe(term, wholeWord) {
  const n = normalizeClaimText(term);
  const key = `${wholeWord ? "w" : "s"}\n${n}`;
  let re = reCache.get(key);
  if (!re) {
    const body = escapeRe(n);
    // Word start. Whole-word terms also require the end, so "kols" does not hit "kolsås".
    re = new RegExp(wholeWord ? `(?:^| )${body}(?: |$)` : `(?:^| )${body}`, "u");
    reCache.set(key, re);
  }
  return re;
}

let termCache = null;
function compiledTerms() {
  if (termCache) return termCache;
  const data = loadClaimsData();
  const whole = new Set();
  for (const file of [data.diseasesNb, data.diseasesEn]) {
    for (const t of file.wholeWord || []) whole.add(normalizeClaimText(t));
  }
  const list = [];
  for (const s of data.substances.substances || []) {
    for (const t of s.terms || []) list.push({ kind: "substance", id: s.id, term: t, re: boundaryRe(t, false) });
  }
  const push = (kind, term) => {
    const n = normalizeClaimText(term);
    // Short disease/treat words are whole words. Longer ones stay prefixes so inflections count.
    // A term listed in data as wholeWord is a whole word at any length.
    list.push({ kind, id: term, term, re: boundaryRe(term, n.length <= 5 || whole.has(n)) });
  };
  for (const file of [data.diseasesNb, data.diseasesEn]) {
    for (const t of file.diseases || []) push("disease", t);
    for (const t of file.treatWording || []) push("treat", t);
  }
  termCache = list;
  return list;
}

/**
 * Deterministic term hits. Substances always count; disease names and treat/cure wording count only
 * when `healthContext` is true (the caller knows the industry or that a health statement is present).
 * @returns {{kind:string, id:string, term:string}[]}
 */
export function findRegulatedTerms(text = "", { healthContext = false } = {}) {
  const n = normalizeClaimText(text);
  if (!n) return [];
  const hits = [];
  for (const t of compiledTerms()) {
    if (t.kind !== "substance" && !healthContext) continue;
    if (t.re.test(n)) hits.push({ kind: t.kind === "treat" ? "disease" : t.kind, id: t.id, term: t.term });
  }
  return hits;
}

const INDUSTRY_STEMS = {
  supplement: ["kosttilskudd", "kosthold", "supplement", "vitamin", "mineral", "sportsernæring", "nutrition", "protein", "naturmedisin", "helsekost"],
  health: ["helse", "lege", "klinikk", "terapi", "fysio", "kiropraktor", "tannlege", "psykolog", "health", "clinic", "medical", "therapy", "wellness", "apotek", "pharmacy"],
  finance: ["finans", "lån", "forsikring", "bank", "investering", "regnskap", "megler", "finance", "loan", "insurance", "invest", "broker", "credit"],
};

/** Which regulated industry groups an industry text belongs to ([] when none). */
export function regulatedIndustryGroups(industry = "") {
  const n = normalizeClaimText(industry);
  if (!n) return [];
  return Object.entries(INDUSTRY_STEMS)
    .filter(([, stems]) => stems.some((s) => n.includes(normalizeClaimText(s))))
    .map(([group]) => group);
}

export function isRegulatedIndustry(industry = "") {
  return regulatedIndustryGroups(industry).length > 0;
}

function isHealthContext(industry) {
  const groups = regulatedIndustryGroups(industry);
  return groups.includes("supplement") || groups.includes("health");
}

function mentionsNutrient(text) {
  const n = normalizeClaimText(text);
  if (!n) return false;
  for (const claim of loadClaimsData().euClaims.claims || []) {
    for (const term of claim.nutrientTerms || []) {
      if (term && boundaryRe(term, false).test(n)) return true;
    }
  }
  return false;
}

/** Disease and treat wording counts for a health/supplement industry, or when the text names a nutrient or substance. */
function diseaseContext(text, industry = "") {
  return isHealthContext(industry) || mentionsNutrient(text) || findRegulatedTerms(text, { healthContext: false }).length > 0;
}

/**
 * Splits keyword strings. A regulated substance always blocks. Disease and treat wording blocks when
 * `diseaseContext` is true, unless `allowDisease` (the plan carries both compliance sign-offs).
 */
export function screenKeywords(keywords = [], { allowDisease = false, industry = "" } = {}) {
  const kept = [];
  const blocked = [];
  for (const kw of keywords || []) {
    const text = typeof kw === "string" ? kw : kw?.keyword;
    const hits = findRegulatedTerms(text, { healthContext: diseaseContext(text, industry) }).filter((h) => !(allowDisease && h.kind === "disease"));
    if (hits.length) blocked.push({ keyword: text, hits });
    else kept.push(kw);
  }
  return { kept, blocked };
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Closeness of two texts after normalization: 0 (different) .. 1 (equal). */
export function wordingSimilarity(a, b) {
  const x = normalizeClaimText(a);
  const y = normalizeClaimText(b);
  const max = Math.max(x.length, y.length);
  if (!max) return 0;
  return 1 - editDistance(x, y) / max;
}

export const CLAIM_MATCH_THRESHOLD = 0.85;

function factNumber(facts, ...keys) {
  for (const k of keys) {
    const v = Number(facts?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

const KNOWN_CONDITION_KEYS = new Set(["minDailyDoseG", "minDailyDoseMg", "minDailyDoseMcg", "minPerServingMg"]);

/** Does `productFacts` meet an authorised claim's condition of use? An unknown key fails closed. */
export function conditionsMet(claim, productFacts = {}) {
  const c = claim?.conditions || {};
  const unmet = [];
  for (const key of Object.keys(c)) {
    if (!KNOWN_CONDITION_KEYS.has(key)) unmet.push(`unknown condition ${key}`);
  }
  const need = (limit, label, ...keys) => {
    if (limit == null) return;
    const v = factNumber(productFacts, ...keys);
    if (v == null || v < limit) unmet.push(label);
  };
  need(c.minDailyDoseG, `daily dose of at least ${c.minDailyDoseG} g`, "dailyDoseG", "dailyDoseGrams");
  need(c.minDailyDoseMg, `daily dose of at least ${c.minDailyDoseMg} mg`, "dailyDoseMg");
  need(c.minDailyDoseMcg, `daily dose of at least ${c.minDailyDoseMcg} mcg`, "dailyDoseMcg");
  need(c.minPerServingMg, `at least ${c.minPerServingMg} mg per serving`, "perServingMg");
  return { ok: unmet.length === 0, unmet };
}

// A negation anywhere in the statement rejects the match. Whole words, so "normal" is not "no".
const NEGATION_RE = /(?:^| )(?:never|without|ingen|ikke|uten|not|no)(?: |$)/u;

function namesOwnNutrient(text, claim) {
  return (claim?.nutrientTerms || []).some((term) => term && boundaryRe(term, false).test(text));
}

function wordTokens(text) {
  return normalizeClaimText(text).split(" ").filter(Boolean);
}

/** Same word, or the same word with an inflection ending of up to three letters. */
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
}

/**
 * Word by word: every word of the register wording appears in the statement, and the statement adds
 * no word beyond the nutrient name. So a changed direction, level or kind (reduces / increases,
 * high / low, physical / mental) is never "close enough".
 */
function wordsMatch(statement, wording, claim) {
  const have = wordTokens(statement);
  const want = wordTokens(wording);
  if (!have.length || !want.length) return false;
  const nutrientWords = new Set((claim?.nutrientTerms || []).flatMap(wordTokens));
  if (!want.every((w) => have.some((h) => sameWord(h, w)))) return false;
  return have.every((h) => want.some((w) => sameWord(h, w)) || nutrientWords.has(h));
}

/** The best authorised claim for a statement, or null below the threshold. */
export function matchAuthorisedClaim(statement) {
  const text = normalizeClaimText(statement);
  if (!text || NEGATION_RE.test(text)) return null;
  const claims = loadClaimsData().euClaims.claims || [];
  let best = null;
  for (const claim of claims) {
    if (!namesOwnNutrient(text, claim)) continue;
    const namesOther = claims.some((other) => other !== claim && namesOwnNutrient(text, other));
    if (namesOther) continue;
    for (const lang of ["nb", "en"]) {
      if (!wordsMatch(statement, claim[lang], claim)) continue;
      const score = wordingSimilarity(statement, claim[lang]);
      if (!best || score > best.score) best = { claim, lang, score };
    }
  }
  return best && best.score >= CLAIM_MATCH_THRESHOLD ? best : null;
}

export const CLAIMS_EXTRACT_TASK = "seo.claims-extract";

const EXTRACT_SYSTEM = [
  "You list every health or benefit statement in a text written for a business website.",
  "A health or benefit statement says a product, ingredient or service affects the body, health, performance, sleep, mood or a disease.",
  'Answer JSON only: {"claims":[{"text":"the statement copied exactly from the text"}]}. Use {"claims":[]} when there is none.',
].join(" ");

function answerTruncated(out) {
  const fields = [out?.stopReason, out?.stop_reason, out?.finish_reason, out?.finishReason, out?.usage?.stopReason, out?.usage?.finish_reason, out?.usage?.finishReason];
  return fields.some((value) => {
    const s = String(value || "").toLowerCase();
    return s === "max_tokens" || s === "length";
  });
}

/** JSON.parse only. A ```json fence may wrap the object. No salvage of a broken answer. */
function strictJson(text) {
  let raw = String(text ?? "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("claims extractor answer was not a JSON object");
  return parsed;
}

async function hubClaimsDeps() {
  const { getHubLlm } = await import("../../llm/index.js");
  const llm = getHubLlm();
  return {
    pipelineAvailable: (task) => Boolean(llm.configuredFor?.(task)),
    pipelineJson: async ({ task, system, user }) => {
      const out = await llm.json({ task, system, user });
      return { text: out?.text ?? "", provider: out?.provider || "", stopReason: out?.stopReason || "" };
    },
  };
}

/**
 * The default extractor: one call through the LLM facade.
 * `deps` injects `{pipelineAvailable, pipelineJson}` in tests. Throws when no provider can answer,
 * the answer is truncated, or the text is not strict JSON.
 * shortcut: live pipelineJson drops stopReason (caller-json rewrites max_tokens to end_turn), so a
 * live truncated answer is rejected only when the result still carries stopReason or finish_reason.
 */
export async function defaultExtract(text, deps) {
  const { pipelineAvailable, pipelineJson } = deps || (await hubClaimsDeps());
  if (!pipelineAvailable?.(CLAIMS_EXTRACT_TASK)) throw new Error("no provider for the claims extractor");
  const out = await pipelineJson({ task: CLAIMS_EXTRACT_TASK, temperature: 0, system: EXTRACT_SYSTEM, user: String(text) });
  if (!compact(out?.provider) || answerTruncated(out)) throw new Error("claims extractor returned no provider or a truncated answer");
  return strictJson(out?.text);
}

function normalizeExtract(raw) {
  const list = Array.isArray(raw) ? raw : raw?.claims;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const t = compact(typeof item === "string" ? item : item?.text);
    if (!t) return null; // a malformed row is not "no claim"
    out.push(t);
  }
  return out;
}

/**
 * @param {string} text
 * @param {{industry?:string, productFacts?:object, extract?:(text:string)=>Promise<any>}} opts
 * @returns {Promise<{ok:boolean, reasons:{code:string, detail:string}[], claims:object[]}>}
 */
export async function checkClaims(text, { industry = "", productFacts = {}, extract = defaultExtract } = {}) {
  const reasons = [];
  const claims = [];
  const body = String(text ?? "");
  const addTerm = (h) => {
    if (reasons.some((r) => r.detail === h.term)) return;
    reasons.push({ code: h.kind === "substance" ? "regulated-substance" : "disease-claim", detail: h.term });
  };

  for (const h of findRegulatedTerms(body, { healthContext: false })) addTerm(h);

  let extracted = null;
  try {
    extracted = normalizeExtract(await extract(body));
  } catch {
    extracted = null;
  }
  if (extracted === null) {
    reasons.push({ code: "extractor-error", detail: "the claims extractor failed or answered badly; the text is rejected" });
    return { ok: false, reasons, claims };
  }

  // A statement, a nutrient, a substance, or a health/supplement industry makes the whole draft a health context.
  const healthContext = diseaseContext(body, industry) || extracted.length > 0;
  if (healthContext) {
    for (const h of findRegulatedTerms(body, { healthContext: true })) addTerm(h);
  }

  const draftNorm = normalizeClaimText(body);
  for (const statement of extracted) {
    if (!draftNorm.includes(normalizeClaimText(statement))) {
      reasons.push({ code: "extractor-error", detail: "an extracted statement is not in the draft" });
      return { ok: false, reasons, claims };
    }
  }

  for (const statement of extracted) {
    const match = matchAuthorisedClaim(statement);
    if (!match) {
      claims.push({ statement, status: "unauthorised" });
      reasons.push({ code: "unauthorised-claim", detail: statement });
      continue;
    }
    const cond = conditionsMet(match.claim, productFacts);
    claims.push({ statement, status: cond.ok ? "authorised" : "condition-unmet", claimId: match.claim.id });
    if (!cond.ok) reasons.push({ code: "condition-unmet", detail: `${match.claim.id}: needs ${cond.unmet.join(", ")}` });
  }
  return { ok: reasons.length === 0, reasons, claims };
}

/** A recorded sign-off needs a name and an ISO date-time that is not in the future. */
function validSignoff(s) {
  if (!s || !compact(s.name)) return false;
  const at = String(s.at ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * Keyword plan rule. A regulated substance anywhere in the plan always fails. Disease terms and
 * regulated industries need two recorded sign-offs: Asoldi compliance and the client.
 * plan.compliance = { asoldi: {name, at}, client: {name, at} }
 */
export function checkPlanCompliance(plan, { industry = "" } = {}) {
  const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  const word = (x) => (typeof x === "string" ? x : x?.keyword);
  const words = [
    ...list(plan?.seeds).map(word),
    ...["primary", "secondary", "local", "questions", "brand"].flatMap((k) => list(plan?.[k]).map(word)),
    ...Object.values(plan?.byRole && typeof plan.byRole === "object" ? plan.byRole : {}).flatMap(list).map(word),
  ].filter((w) => typeof w === "string" && w);
  const hits = words.flatMap((w) => findRegulatedTerms(w, { healthContext: diseaseContext(w, industry) }));
  const reasons = hits.filter((h) => h.kind === "substance").map((h) => ({ code: "regulated-substance", detail: h.term }));
  const needsSignoff = isRegulatedIndustry(industry) || hits.some((h) => h.kind === "disease");
  const c = plan?.compliance || {};
  const signed = validSignoff(c.asoldi) && validSignoff(c.client);
  if (needsSignoff && !signed) reasons.push({ code: "compliance-signoff-missing", detail: "needs Asoldi compliance and client sign-offs with name and time" });
  return { ok: reasons.length === 0, needsSignoff, signed, reasons };
}

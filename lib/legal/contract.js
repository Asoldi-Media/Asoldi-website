/**
 * Contract text from the clause catalog, for lib/offer-contract-pdf.js. Used only when an offer's
 * legal source is the catalog (lib/legal/binding.js legalSourceForOffer); the legacy contract
 * copy (lib/offer-contract-copy.js) is used otherwise.
 *
 * What changes in catalog mode:
 *   - Section 1 lists the plan's contract lines (contractLinesForPlan, group 'scope');
 *   - Section 3 (contract period and cancellation) holds the 'term' lines;
 *   - Section 4 names the catalog and DPA versions the agreement incorporates;
 *   - Section 5 explains the plan's services with the terms clauses;
 *   - Section 11 adds the 'legal' lines (material from the client, AI, DPA version).
 * Everything else (parties, prices, payment, delivery guarantee, liability, law) is unchanged.
 */
import { LEGAL_URLS } from '../legal-urls.js';
import { catalogForVersion } from './archive.js';
import { contractLinesForPlan, planForContract, serviceMeaningsForPlan } from './render.js';

let seoRecord = null;
let seoContractText = null;
try {
  seoRecord = await import('../seo-ops/record.js');
} catch {
  seoRecord = null;
}
try {
  seoContractText = await import('../seo-ops/contract-text.js');
} catch {
  seoContractText = null;
}

/**
 * The client's agreed keywords as contract text, when the SEO record and its contract-text module
 * exist (agreedKeywordsFor(clientId) and agreedKeywordsContractText(record)); '' otherwise.
 */
export function agreedKeywordsTextForClient(clientId) {
  const toText = seoContractText?.agreedKeywordsContractText;
  const lookup = seoRecord?.agreedKeywordsFor;
  if (typeof toText !== 'function' || typeof lookup !== 'function' || !clientId) return '';
  try {
    let record = lookup(clientId);
    if (!record || typeof record.then === 'function') return '';
    if (Array.isArray(record)) record = { agreedKeywords: record };
    return String(toText(record) || '').trim();
  } catch {
    return '';
  }
}

function isCatalog(legal) {
  return legal?.mode === 'catalog' && Number(legal.catalogVersion) >= 1;
}

function catalogOf(legal) {
  return catalogForVersion(legal.catalogVersion);
}

function linesFor(legal, plan, { language = 'nb', agreedKeywordsText = '' } = {}) {
  const catalog = catalogOf(legal);
  if (!catalog) return [];
  return contractLinesForPlan(plan, {
    language,
    catalog,
    params: { dpaVersion: legal.dpaVersion || '' },
    agreedKeywordsText,
  });
}

/** Scope blocks [{lead, bullets}] for Section 1 in catalog mode. */
export function catalogScopeBlocks({ legal, plan, language = 'nb', agreedKeywordsText = '' } = {}) {
  if (!isCatalog(legal)) return [];
  return linesFor(legal, plan, { language, agreedKeywordsText })
    .filter((block) => block.group === 'scope')
    .map((block) => ({ lead: `${block.title}:`, bullets: [...block.lines] }));
}

/**
 * The contract copy with the catalog's Section 3, 4, 5 and 11 texts. `t` is the legacy copy for
 * the language; labels and the other sections are kept.
 */
export function catalogContractCopy(t, { legal, plan, language = 'nb' } = {}) {
  if (!isCatalog(legal)) return t;
  const blocks = linesFor(legal, plan, { language });
  const term = blocks.filter((block) => block.group === 'term').flatMap((block) => block.lines);
  const legalLines = blocks.filter((block) => block.group === 'legal').flatMap((block) => block.lines);
  const en = language === 'en';
  const version = Number(legal.catalogVersion);
  const dpa = legal.dpaVersion || '';
  const introLegal = en
    ? `The published Terms (${LEGAL_URLS.vilkar}, version ${version}), Privacy Policy (${LEGAL_URLS.personvern}) and Data Processing Agreement (${LEGAL_URLS.databehandleravtale}, version ${dpa}) form part of this Agreement in the versions named here.`
    : `De publiserte vilkårene (${LEGAL_URLS.vilkar}, versjon ${version}), personvernerklæringen (${LEGAL_URLS.personvern}) og databehandleravtalen (${LEGAL_URLS.databehandleravtale}, versjon ${dpa}) utgjør en del av Avtalen i versjonene som er nevnt her.`;
  const s4Bullets = en
    ? [
      `The Terms, version ${version}, are published at ${LEGAL_URLS.vilkar}. A client bound to this version keeps it until notified in writing of a new version.`,
      `Privacy information is published at ${LEGAL_URLS.personvern}.`,
      `The Data Processing Agreement, version ${dpa}, with its appendix on sub-processors is published at ${LEGAL_URLS.databehandleravtale}.`,
      t.s4.bullets[t.s4.bullets.length - 1],
    ]
    : [
      `Vilkårene, versjon ${version}, er publisert på ${LEGAL_URLS.vilkar}. Kunden er bundet av denne versjonen til kunden har fått skriftlig varsel om en ny versjon.`,
      `Personverninformasjon er publisert på ${LEGAL_URLS.personvern}.`,
      `Databehandleravtalen, versjon ${dpa}, med vedlegg om underleverandører er publisert på ${LEGAL_URLS.databehandleravtale}.`,
      t.s4.bullets[t.s4.bullets.length - 1],
    ];
  return {
    ...t,
    introLegal,
    durationTerms: term.length ? term : t.durationTerms,
    s4: { ...t.s4, bullets: s4Bullets },
    s11: { ...t.s11, numbered: [...t.s11.numbered, ...legalLines] },
    legal: { catalogVersion: version, dpaVersion: dpa },
  };
}

/** Section 5 topics in catalog mode: the plan's services explained with the terms clauses (Norwegian). */
export function catalogServiceTopics({ legal, plan, language = 'nb', fallback = [] } = {}) {
  if (!isCatalog(legal) || language === 'en') return fallback;
  const catalog = catalogOf(legal);
  if (!catalog) return fallback;
  const topics = serviceMeaningsForPlan(plan, { catalog, params: { dpaVersion: legal.dpaVersion || '' } });
  return topics.length ? topics : fallback;
}

/** The plan a contract scope describes: a tier with the offer's billing, or the offer's own plan. */
export function contractPlanFor({ tierId = '', plan = null, billing = '' } = {}) {
  const base = plan && typeof plan === 'object' ? { ...plan } : { tierId };
  if (!base.tierId && tierId) base.tierId = tierId;
  if (billing && !base.billing) base.billing = billing;
  return planForContract(base);
}

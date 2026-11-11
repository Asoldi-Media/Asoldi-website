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
import { archivedContractWording, catalogForVersion, publishedParamsForVersion } from './archive.js';
import { versionedLegalUrl } from './binding.js';
import { contractLinesForPlan, planForContract, serviceMeaningsForPlan } from './render.js';

// Optional modules, loaded without blocking this module's evaluation (a top-level await on a module
// that imports the data layer could otherwise never settle).
let seoRecord = null;
let seoContractText = null;
export const seoModulesReady = Promise.all([
  import('../seo-ops/record.js').then((mod) => { seoRecord = mod; }, () => { seoRecord = null; }),
  import('../seo-ops/contract-text.js').then((mod) => { seoContractText = mod; }, () => { seoContractText = null; }),
]);

/**
 * The client's agreed keywords as contract text, when the SEO record and its contract-text module
 * exist (agreedKeywordsFor(clientId) and agreedKeywordsContractText(record)); '' otherwise. A sent
 * offer keeps the text it was sent with (ext.legal.agreedKeywordsText, lib/legal/binding.js).
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

/**
 * The values a bound version's texts are filled with: the ones it was published with (its
 * archive's published.params), never today's code defaults or stored settings.
 */
function versionParams(legal) {
  return { ...(publishedParamsForVersion(legal.catalogVersion) || {}), dpaVersion: legal.dpaVersion || '' };
}

function linesFor(legal, plan, { language = 'nb', agreedKeywordsText = '' } = {}) {
  const catalog = catalogOf(legal);
  if (!catalog) return [];
  return contractLinesForPlan(plan, {
    language,
    catalog,
    params: versionParams(legal),
    agreedKeywordsText,
    tiers: legal.tiers || null,
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
export function catalogContractCopy(t, { legal, plan, language = 'nb', catalogCurrent } = {}) {
  if (!isCatalog(legal)) return t;
  const blocks = linesFor(legal, plan, { language });
  const term = blocks.filter((block) => block.group === 'term').flatMap((block) => block.lines);
  const legalLines = blocks.filter((block) => block.group === 'legal').flatMap((block) => block.lines);
  const en = language === 'en';
  const version = Number(legal.catalogVersion);
  const dpa = legal.dpaVersion || '';
  // An older bound version keeps the introduction and Section 4 it was published with.
  // The current version is rendered here, so a wording change fails the archive check.
  // `catalogCurrent` is only for a test that pretends a later catalog exists.
  const archived = archivedContractWording(version, language, catalogCurrent);
  // Versioned links: the page shows the text of exactly this version, also after a newer one is published.
  const terms = versionedLegalUrl('vilkar', version);
  const dpaUrl = versionedLegalUrl('databehandleravtale', version);
  const introLegal = archived?.introLegal || (en
    ? `The published Terms (${terms}, version ${version}), Privacy Policy (${LEGAL_URLS.personvern}) and Data Processing Agreement (${dpaUrl}, version ${dpa}) form part of this Agreement in the versions named here.`
    : `De publiserte vilkårene (${terms}, versjon ${version}), personvernerklæringen (${LEGAL_URLS.personvern}) og databehandleravtalen (${dpaUrl}, versjon ${dpa}) utgjør en del av Avtalen i versjonene som er nevnt her.`);
  const s4Bullets = archived?.section4 || (en
    ? [
      `The Terms, version ${version}, are published at ${terms}. This version applies to the Client until a new version applies after written notice at least 30 days in advance.`,
      `Privacy information is published at ${LEGAL_URLS.personvern}.`,
      `The Data Processing Agreement, version ${dpa}, with its appendix on sub-processors is published at ${dpaUrl}.`,
      t.s4.bullets[t.s4.bullets.length - 1],
    ]
    : [
      `Vilkårene, versjon ${version}, er publisert på ${terms}. Denne versjonen gjelder for kunden til en ny versjon gjelder etter skriftlig varsel minst 30 dager i forveien.`,
      `Personverninformasjon er publisert på ${LEGAL_URLS.personvern}.`,
      `Databehandleravtalen, versjon ${dpa}, med vedlegg om underleverandører er publisert på ${dpaUrl}.`,
      t.s4.bullets[t.s4.bullets.length - 1],
    ]);
  return {
    ...t,
    introLegal,
    durationTerms: term.length ? term : t.durationTerms,
    s4: { ...t.s4, bullets: s4Bullets },
    s11: { ...t.s11, numbered: [...t.s11.numbered, ...legalLines] },
    legal: { catalogVersion: version, dpaVersion: dpa },
  };
}

/**
 * Section 5 topics in catalog mode: the plan's services explained with the catalog's texts, in the
 * contract's language (English uses the clauses' English texts), so Section 5 never contradicts
 * Section 1.
 */
export function catalogServiceTopics({ legal, plan, language = 'nb', fallback = [] } = {}) {
  if (!isCatalog(legal)) return fallback;
  const catalog = catalogOf(legal);
  if (!catalog) return fallback;
  // Catalog mode never fills Section 5 from the static meanings, even when the plan has no services.
  return serviceMeaningsForPlan(plan, { language, catalog, params: versionParams(legal), tiers: legal.tiers || null });
}

/**
 * The plan a contract scope describes: a tier with the offer's billing, or the offer's own plan.
 * `tiers` is a sent offer's tier snapshot (legal.tiers), so its scope does not follow later
 * changes to what a tier contains.
 */
export function contractPlanFor({ tierId = '', plan = null, billing = '', tiers = null } = {}) {
  const base = plan && typeof plan === 'object' ? { ...plan } : { tierId };
  if (!base.tierId && tierId) base.tierId = tierId;
  if (billing && !base.billing) base.billing = billing;
  return planForContract(base, { tiers });
}

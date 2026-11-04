/**
 * Renders the legal clause catalog into documents and lines:
 *   - renderDocument('vilkar' | 'personvern' | 'databehandleravtale'): structured documents
 *     { doc, title, description, path, catalogVersion, dpaVersion, date, sections[] }, where a
 *     section is { id, title, blocks: [{type:'p'|'h3', text} | {type:'list', items[]}] };
 *   - renderDpaAppendixMarkdown(): the appendix as Markdown (docs/databehandleravtale-appendix.md);
 *   - contractLinesForPlan(sitePlan): the contract lines for one plan;
 *   - salesCopyForTier(tierId) and offerLetterIncludes(tierId): the sales page's "what's included"
 *     and the offer letter's product lines.
 *
 * Pure: every input (catalog, register, settings, retention text) can be passed in; the defaults
 * are the current catalog, the register and the code defaults.
 */
import {
  CATALOG,
  CATALOG_DATE,
  CATALOG_VERSION,
  DPA_VERSION,
  fillText,
  legalParams,
} from './catalog.js';
import {
  HOSTS_REGISTER,
  llmProviderRows,
  llmProviderSentence,
  registryRetentionText,
  retentionRows,
  subprocessorList,
} from './subprocessors.js';
import {
  TIER_MATRIX,
  expandServices,
  servicesForTier,
} from '../../packages/suite/core/delivery/vocab.js';
import { planForContract } from './plan.js';
import { WEBSITE_TIERS, deliveryLabel, formatKr, pagesLabel } from '../website-tiers.js';

export const LEGAL_DOC_IDS = Object.freeze(['vilkar', 'personvern', 'databehandleravtale']);

export const LEGAL_DOC_META = Object.freeze({
  vilkar: {
    title: 'Vilkår for bruk',
    description: 'Vilkårene for tjenestene Asoldi Markedsføring leverer til næringsdrivende kunder, og for bruk av asoldi.com og kundeportalen.',
    path: '/vilkar',
  },
  personvern: {
    title: 'Personvernerklæring',
    description: 'Hvordan Asoldi Markedsføring behandler personopplysninger, hvilke leverandører som får dem, og hvor lenge de lagres.',
    path: '/personvern',
  },
  databehandleravtale: {
    title: 'Databehandleravtale',
    description: 'Avtale etter personvernforordningen artikkel 28 mellom kunden som behandlingsansvarlig og Asoldi som databehandler, med vedlegg om underleverandører.',
    path: '/databehandleravtale',
  },
});

const TERMS_SECTIONS = [
  ['about', 'Om vilkårene'],
  ['account', 'Bruk av nettstedet og kontoen'],
  ['services', 'Tjenestene'],
  ['tiers', 'Nivåer'],
  ['addons', 'Engangstillegg'],
  ['billing', 'Engangskjøp'],
  ['term', 'Avtaleperiode'],
  ['cancellation', 'Når avtalen avsluttes'],
  ['payment', 'Betaling'],
  ['customer', 'Kundens ansvar og materiale'],
  ['delivery', 'Levering, drift og support'],
  ['ai', 'Bruk av AI'],
  ['privacy', 'Personvern og databehandleravtale'],
  ['consumer', 'Kundens vilkår overfor forbrukere'],
  ['liability', 'Ansvar og referanser'],
  ['law', 'Lovvalg og endringer'],
];

const PRIVACY_SECTIONS = [
  ['intro', 'Innledning'],
  ['collected', 'Opplysninger vi behandler'],
  ['purposes', 'Formål og rettslig grunnlag'],
  ['ai', 'Bruk av AI'],
  ['recipients', 'Leverandører og mottakere'],
  ['retention', 'Lagringstid'],
  ['rights', 'Dine rettigheter, sikkerhet og endringer'],
];

const DPA_SECTIONS = [
  ['purpose', 'Formål, roller og instruks'],
  ['processing', 'Behandlingen'],
  ['subprocessors', 'Underleverandører'],
  ['ai', 'Bruk av AI'],
  ['security', 'Sikkerhet, taushetsplikt og bistand'],
  ['end', 'Sletting, revisjon og varighet'],
  ['appendix', 'Vedlegg: underleverandører og AI-behandling'],
];

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function p(text) {
  return { type: 'p', text };
}

function h3(text) {
  return { type: 'h3', text };
}

function list(items) {
  return { type: 'list', items: items.filter(Boolean) };
}

function textsOf(clause, field, language, params) {
  const source = language === 'en' && clause.en?.[field] ? clause.en[field] : clause.nb?.[field];
  return asList(source).map((text) => fillText(text, params));
}

function titleOf(clause, language) {
  return (language === 'en' && clause.en?.title) || clause.nb?.title || clause.id;
}

/**
 * Blocks for the clauses of one section: one clause renders its paragraphs; several get a heading
 * each, except a clause whose title is the section's own title.
 */
function clauseBlocks(clauses, params, { field = 'terms', headings = null, sectionTitle = '' } = {}) {
  const withHeadings = headings ?? clauses.length > 1;
  const blocks = [];
  for (const clause of clauses) {
    const texts = textsOf(clause, field, 'nb', params);
    if (!texts.length) continue;
    if (withHeadings && clause.nb.title !== sectionTitle) blocks.push(h3(clause.nb.title));
    for (const text of texts) blocks.push(p(text));
  }
  return blocks;
}

function sectionsFrom(spec, catalog, doc, params, extra = {}) {
  const sections = [];
  let number = 0;
  for (const [id, title] of spec) {
    const clauses = catalog.filter((clause) => clause.docs.includes(doc) && clause.section === id);
    const blocks = typeof extra[id] === 'function'
      ? extra[id](clauses)
      : clauseBlocks(clauses, params, { headings: id === 'services' || id === 'addons' ? true : null, sectionTitle: title });
    if (!blocks.length) continue;
    number += 1;
    sections.push({ id, title: `${number}. ${title}`, blocks });
  }
  return sections;
}

function docParams(params, settings) {
  return legalParams(settings, { dpaVersion: DPA_VERSION, ...(params || {}) });
}

function header(doc, { catalogVersion, dpaVersion, date }) {
  const meta = LEGAL_DOC_META[doc];
  return {
    doc,
    title: meta.title,
    description: meta.description,
    path: meta.path,
    catalogVersion,
    dpaVersion,
    date,
  };
}

function tierBlocks(catalog, params) {
  const blocks = [];
  for (const tier of WEBSITE_TIERS) {
    const services = expandServices(servicesForTier(tier.id));
    const titles = serviceClausesFor(catalog, services).map((clause) => clause.nb.title);
    const label = String(tier.name || '').split(': ')[1] || tier.shortName;
    blocks.push(h3(`Nivå ${tier.tierNumber} – ${label} (${formatKr(tier.monthlyExMva)} eks. mva per måned)`));
    blocks.push(list([
      `Inntil ${TIER_MATRIX[tier.id]?.pages || tier.pages} hovedsider.`,
      `Inneholder: ${titles.join(', ')}.`,
      `${deliveryLabel(tier.deliveryWeeks)}. Hvis ingen egen oppstartstid er avtalt, starter fristen ved signert avtale.`,
    ]));
  }
  blocks.push(h3('Skreddersydd'));
  blocks.push(p('Omfang, pris og leveringstid avtales i tjenesteavtalen. Tjenestene ovenfor kan inngå helt eller delvis, med betydningen som står her.'));
  return blocks;
}

function processorLine(entry) {
  const where = entry.transfer ? `${entry.region}, overføringsgrunnlag: ${entry.transfer}` : entry.region;
  const data = entry.personalData && entry.dataCategories.length ? ` Opplysninger: ${entry.dataCategories.join(', ')}.` : '';
  return `${entry.name} (${entry.entity}, ${where}): ${entry.role}.${data}`;
}

function recipientsBlocks(scope, register) {
  const entries = subprocessorList({ scope, register });
  const withData = entries.filter((entry) => entry.personalData && entry.id !== 'thirdPartyContent');
  const content = entries.filter((entry) => entry.id === 'thirdPartyContent');
  const withoutData = entries.filter((entry) => !entry.personalData);
  const listed = new Set(entries.map((entry) => entry.id));
  const forClients = subprocessorList({ scope: 'client', register }).filter((entry) => entry.personalData && !listed.has(entry.id));
  const blocks = [];
  blocks.push(p('Vi selger aldri personopplysninger. Disse leverandørene behandler opplysninger på våre vegne, og vi har databehandleravtale med hver av dem:'));
  blocks.push(list(withData.map(processorLine)));
  if (forClients.length) {
    blocks.push(h3('Når vi behandler opplysninger for kunder'));
    blocks.push(p('Når Asoldi lager, drifter og vedlikeholder nettsider for kunder, behandler vi opplysninger på kundens vegne etter databehandleravtalen. Da bruker vi i tillegg disse leverandørene. Alle underleverandørene står i vedlegget til databehandleravtalen.'));
    blocks.push(list(forClients.map(processorLine)));
  }
  if (content.length) {
    blocks.push(h3('Innhold fra andre nettsteder'));
    blocks.push(p(content.map((entry) => `${entry.role}. Det gjelder ${entry.entity}.`).join(' ')));
  }
  if (withoutData.length) {
    blocks.push(h3('Leverandører som ikke får personopplysninger'));
    blocks.push(list(withoutData.map((entry) => `${entry.name} (${entry.entity}, ${entry.region}): ${entry.role}.`)));
  }
  return blocks;
}

function aiBlocks(catalog, params, register, policy) {
  const clause = catalog.find((entry) => entry.id === 'general.ai');
  const blocks = clause ? clauseBlocks([clause], params, { headings: false }) : [];
  blocks.push(p('AI-leverandørene og hvilke data hver av dem kan få:'));
  blocks.push(list(llmProviderRows({ policy, register }).map(llmProviderSentence)));
  return blocks;
}

function appendixBlocks(register, policy) {
  const entries = subprocessorList({ scope: 'client', register });
  const withData = entries.filter((entry) => entry.personalData);
  const withoutData = entries.filter((entry) => !entry.personalData);
  return [
    p(`Vedlegget hører til databehandleravtalen versjon ${DPA_VERSION}. Det lister underleverandørene Asoldi bruker når Asoldi behandler personopplysninger på kundens vegne.`),
    h3('Underleverandører'),
    list(withData.map(processorLine)),
    h3('AI-behandling'),
    list(llmProviderRows({ policy, register }).map(llmProviderSentence)),
    ...(withoutData.length
      ? [h3('Leverandører som ikke får personopplysninger'), list(withoutData.map((entry) => `${entry.name} (${entry.entity}, ${entry.region}): ${entry.role}.`))]
      : []),
  ];
}

/** The text as one sentence: a full stop added unless it already ends with one. */
function sentence(value) {
  const textValue = String(value ?? '').trim();
  return /[.!?]$/.test(textValue) ? textValue : `${textValue}.`;
}

/**
 * One legal document. Options: catalog (default: the current one), register, policy, settings
 * (the retention.*, pricing.* and lifecycle.* values; code defaults when absent), retentionText
 * (null: settings only; default: the personal-data registry's when present), and the version
 * labels to print.
 */
export function renderDocument(doc, {
  catalog = CATALOG,
  register = HOSTS_REGISTER,
  policy,
  settings = null,
  retentionText = registryRetentionText(),
  params = null,
  catalogVersion = CATALOG_VERSION,
  dpaVersion = DPA_VERSION,
  date = CATALOG_DATE,
} = {}) {
  if (!LEGAL_DOC_IDS.includes(doc)) throw new Error(`Unknown legal document: ${doc}`);
  const values = docParams(params, settings);
  const head = header(doc, { catalogVersion, dpaVersion, date });
  if (doc === 'vilkar') {
    return { ...head, sections: sectionsFrom(TERMS_SECTIONS, catalog, 'terms', values, { tiers: () => tierBlocks(catalog, values) }) };
  }
  if (doc === 'personvern') {
    return {
      ...head,
      sections: sectionsFrom(PRIVACY_SECTIONS, catalog, 'privacy', values, {
        ai: () => aiBlocks(catalog, values, register, policy),
        recipients: () => recipientsBlocks('asoldi', register),
        retention: () => [
          p('Vi lagrer opplysningene så lenge det trengs for formålet, og lenger bare når loven krever det:'),
          list(retentionRows({ settings, retentionText }).map((row) => `${row.label}: ${sentence(row.text)}`)),
          p('Opplysninger vi behandler på vegne av en kunde, slettes etter databehandleravtalen.'),
        ],
      }),
    };
  }
  return {
    ...head,
    sections: sectionsFrom(DPA_SECTIONS, catalog, 'dpa', values, {
      ai: () => aiBlocks(catalog, values, register, policy),
      appendix: () => appendixBlocks(register, policy),
    }),
  };
}

/** Plain text of a rendered document (titles, paragraphs and list items, one per line). */
export function documentPlainText(rendered) {
  const lines = [rendered.title];
  for (const section of asList(rendered.sections)) {
    lines.push(section.title);
    for (const block of asList(section.blocks)) {
      if (block.type === 'list') lines.push(...block.items);
      else lines.push(block.text);
    }
  }
  return lines.join('\n');
}

/** The DPA appendix as Markdown: the content of docs/databehandleravtale-appendix.md. */
export function renderDpaAppendixMarkdown(options = {}) {
  const rendered = renderDocument('databehandleravtale', { ...options, retentionText: null });
  const appendix = rendered.sections.find((section) => section.id === 'appendix');
  const out = [
    '# Databehandleravtale: vedlegg om underleverandører og AI-behandling',
    '',
    `Versjon ${rendered.dpaVersion} (vilkårskatalog versjon ${rendered.catalogVersion}, ${rendered.date}).`,
    '',
    'Generert av `node scripts/legal-render.mjs --write` fra `lib/legal/hosts-register.json` og AI-reglene i',
    '`packages/suite/harness/asoldi/llm.js`. Ikke rediger for hånd; `--check` feiler når filen er utdatert.',
    '',
  ];
  for (const block of appendix?.blocks || []) {
    if (block.type === 'h3') out.push(`## ${block.text}`, '');
    else if (block.type === 'list') out.push(...block.items.map((item) => `- ${item}`), '');
    else out.push(block.text, '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------- plans, contract lines and sales copy

/** { tierId, services, oneTimeAddOns, billing, pages } from a site plan, offer plan or tier id (lib/legal/plan.js). */
export { planForContract };

function serviceClausesFor(catalog, services) {
  return catalog.filter((clause) => clause.kind === 'service' && clause.covers.services.some((id) => services.includes(id)));
}

function addOnClausesFor(catalog, addOns) {
  return catalog.filter((clause) => clause.kind === 'addon' && clause.covers.addOns.some((id) => addOns.includes(id)));
}

const CONTRACT_GENERAL_ORDER = ['general.oneTimePurchase', 'general.term', 'general.cancellation', 'general.usageRights', 'general.ai', 'general.dpa'];

/**
 * The contract lines for one plan, as blocks { clauseId, group, title, lines }:
 *   group 'scope': the services and one-time add-ons in the plan;
 *   group 'term': billing, contract period and what happens when the agreement ends;
 *   group 'legal': material from the client, AI and the data processing agreement.
 * `agreedKeywordsText` (the record's agreed keywords as contract text) is added to the SEO block.
 * `tiers` is a sent offer's tier snapshot (lib/legal/plan.js tierSnapshot).
 */
export function contractLinesForPlan(sitePlan, {
  language = 'nb',
  catalog = CATALOG,
  settings = null,
  params = null,
  agreedKeywordsText = '',
  tiers = null,
} = {}) {
  const plan = planForContract(sitePlan, { tiers });
  const lang = language === 'en' ? 'en' : 'nb';
  const values = legalParams(settings, { dpaVersion: DPA_VERSION, pages: plan.pages, ...(params || {}) });
  const blocks = [];
  const push = (clause, group) => {
    const lines = textsOf(clause, 'contract', lang, values);
    if (clause.id === 'service.seo' && String(agreedKeywordsText || '').trim()) lines.push(String(agreedKeywordsText).trim());
    if (lines.length) blocks.push({ clauseId: clause.id, group, title: titleOf(clause, lang), lines });
  };
  for (const clause of serviceClausesFor(catalog, plan.services)) if (clause.docs.includes('contract')) push(clause, 'scope');
  for (const clause of addOnClausesFor(catalog, plan.oneTimeAddOns)) if (clause.docs.includes('contract')) push(clause, 'scope');
  for (const id of CONTRACT_GENERAL_ORDER) {
    const clause = catalog.find((entry) => entry.id === id);
    if (!clause || !clause.docs.includes('contract')) continue;
    if (clause.covers.billing.length && !clause.covers.billing.includes(plan.billing)) continue;
    push(clause, id === 'general.usageRights' || id === 'general.ai' || id === 'general.dpa' ? 'legal' : 'term');
  }
  return blocks;
}

/**
 * The terms texts (service meanings) for the services and add-ons in a plan, as {title, text}
 * topics. In English a clause uses its English terms text, or its English contract lines when it
 * has no English terms text, so an English contract never mixes in another text.
 */
export function serviceMeaningsForPlan(sitePlan, { language = 'nb', catalog = CATALOG, settings = null, params = null, tiers = null } = {}) {
  const plan = planForContract(sitePlan, { tiers });
  const lang = language === 'en' ? 'en' : 'nb';
  const values = legalParams(settings, { dpaVersion: DPA_VERSION, pages: plan.pages, ...(params || {}) });
  const clauses = [...serviceClausesFor(catalog, plan.services), ...addOnClausesFor(catalog, plan.oneTimeAddOns)];
  return clauses.map((clause) => {
    if (lang === 'en' && !asList(clause.en?.terms).length) {
      return { title: titleOf(clause, 'en'), text: textsOf(clause, 'contract', 'en', values).map((line) => (/[.!?]$/.test(line) ? line : `${line}.`)).join(' ') };
    }
    return { title: titleOf(clause, lang), text: textsOf(clause, 'terms', lang, values).join(' ') };
  });
}

function salesLinesFor(clauses, language, values) {
  const out = [];
  for (const clause of clauses) {
    if (!clause.docs.includes('sales')) continue;
    for (const line of textsOf(clause, 'sales', language, values)) if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The sales page's "what's included" for one tier: { tierId, included, excluded }. `included`
 * starts with the page count and ends with the delivery time, like the static cards.
 */
export function salesCopyForTier(tierId, { language = 'nb', catalog = CATALOG, settings = null } = {}) {
  const tier = WEBSITE_TIERS.find((entry) => entry.id === tierId);
  if (!tier) return null;
  const lang = language === 'en' ? 'en' : 'nb';
  const values = legalParams(settings, { pages: tier.pages });
  const services = expandServices(servicesForTier(tier.id));
  const included = salesLinesFor(serviceClausesFor(catalog, services), lang, values);
  const otherServices = [...new Set(Object.values(TIER_MATRIX).flatMap((entry) => entry.services))].filter((id) => !services.includes(id));
  const excluded = salesLinesFor(serviceClausesFor(catalog, otherServices), lang, values).filter((line) => !included.includes(line));
  return {
    tierId: tier.id,
    marketingId: tier.marketingId,
    included: [included[0], pagesLabel(tier.pages), ...included.slice(1), deliveryLabel(tier.deliveryWeeks)].filter(Boolean),
    excluded,
  };
}

/** The offer letter's product lines for a tier ("Hva er inkludert"), without page count and delivery time. */
export function offerLetterIncludes(tierId, options = {}) {
  const copy = salesCopyForTier(tierId, options);
  if (!copy) return [];
  return copy.included.filter((line) => !/^Opp til \d+ hovedsider$/.test(line) && !/^Leveringstid:/.test(line));
}

/** Every sales line any tier can show, for the catalog given (used to recognise them in stored offers). */
export function allSalesLines({ catalog = CATALOG } = {}) {
  const out = new Set();
  for (const tier of WEBSITE_TIERS) {
    for (const line of offerLetterIncludes(tier.id, { catalog })) out.add(line);
  }
  return out;
}

/** The sales copy of every tier, keyed by tier id. */
export function salesCopy(options = {}) {
  return Object.fromEntries(WEBSITE_TIERS.map((tier) => [tier.id, salesCopyForTier(tier.id, options)]));
}

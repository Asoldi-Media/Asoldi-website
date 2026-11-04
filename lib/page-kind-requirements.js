// Page-kind requirement lines of the delivery gate. Pure: no I/O.
//
// A page in the site's page plan asks for its own material, on any tier and whether or not a
// sellable service brings it: a menu page needs dishes with prices, a team page needs staff, and
// so on. The page kinds come from the Maker run's page plan (makerRun.materials.pageKinds, the
// taxonomy kinds) and, before a run exists, from the page names of the offer.
//
// A waiver can carry a directive for the build: "Fjern teamsiden" waives the staff line and asks
// the developer (and the delivery brief) to remove the team page.
import { GATE_PAGE_KIND_LINES } from '../packages/suite/core/delivery/vocab.js';
import {
  bankCatalogItemCount,
  bankPictureCount,
  bankProductsWithNameAndPrice,
  bankStaff,
  bookingServicesCount,
  filled,
  isPlainObject,
  text,
} from './site-plan-requirements.js';

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function have(value, evidence, source) {
  return { have: Boolean(value), evidence: value ? evidence : '', source: value ? source : '' };
}

function missing(evidence = '') {
  return { have: false, evidence, source: '' };
}

function evaluateMenuItems(ev) {
  const priced = bankProductsWithNameAndPrice(ev.bank, { layout: 'meny' }) + bankProductsWithNameAndPrice(ev.bank, { layout: 'menu' });
  if (priced > 0) return have(true, `${priced} retter med pris`, 'bank');
  return missing('Ingen meny med priser');
}

function projectPictureCount(ev) {
  const fromBank = bankPictureCount(ev.bank, ['projectImages', 'galleryImages']);
  const uploads = isPlainObject(ev.materials?.uploads) ? ev.materials.uploads : {};
  const fromMaker = (Number(uploads.projectImages) || 0) + (Number(uploads.galleryImages) || 0);
  return Math.max(fromBank, fromMaker);
}

function evaluateProjectImages(ev) {
  const count = projectPictureCount(ev);
  const pages = Math.max(1, ev.pageKindList.filter((row) => ['portfolio', 'projects'].includes(row.kind)).length);
  if (count >= 6 || count >= 3 * pages) return have(true, `${count} prosjektbilder`, 'bank');
  return missing(`${count} av 6 prosjektbilder`);
}

function evaluateStaff(ev) {
  const staff = bankStaff(ev.bank).length;
  if (staff > 0) return have(true, `${staff} ansatte i Kundedata`, 'bank');
  if (ev.inboxFound.has('staff-name')) return have(true, 'Mottatt på e-post', 'inbox');
  return missing('Ingen ansatte registrert');
}

function evaluatePriceList(ev) {
  if (bankCatalogItemCount(ev.bank, { layout: 'tiers' }) > 0) return have(true, 'Prisliste i Kundedata', 'bank');
  const facts = isPlainObject(ev.facts) ? ev.facts : {};
  if (filled(facts.pricing?.text) || filled(facts.content?.priceText)) return have(true, 'Prisene står i briefen', 'brief');
  return missing('Ingen prisliste');
}

function evaluateBookingServices(ev) {
  if (bookingServicesCount(ev) > 0) return have(true, 'Bookbare tjenester registrert', 'bank');
  const links = listOf(ev.facts?.importantLinks);
  if (links.some((link) => /book|bestill|timebestilling/i.test(text(link?.purpose || link?.kind || link?.label)))) {
    return have(true, 'Ekstern bookinglenke i briefen', 'brief');
  }
  return missing('Ingen bookbare tjenester');
}

function evaluateBlogTopics(ev) {
  const fromBank = listOf(ev.bank?.blogTopics).filter((topic) => text(topic?.title ?? topic)).length;
  const fromFacts = listOf(ev.facts?.content?.blogTopics).filter((topic) => text(topic?.title ?? topic)).length;
  const count = Math.max(fromBank, fromFacts);
  return count >= 3 ? have(true, `${count} bloggtemaer`, 'bank') : missing(`${count} av 3 bloggtemaer`);
}

function evaluateServicesList(ev) {
  const fromFacts = listOf(ev.facts?.positioning?.services).filter(filled).length;
  if (fromFacts > 0) return have(true, `${fromFacts} tjenester i briefen`, 'brief');
  const fromBank = listOf(ev.bank?.services).filter((service) => text(service?.name ?? service)).length;
  if (fromBank > 0) return have(true, `${fromBank} tjenester i Kundedata`, 'bank');
  if (bankCatalogItemCount(ev.bank) > 0) return have(true, 'Tjenester i katalogen', 'bank');
  return missing('Ingen tjenesteliste');
}

const ROWS = [
  { id: 'menu-items', label: 'Meny med retter og priser', askText: 'Menyen med retter og priser', group: 'Innhold',
    dev: 'required', ready: 'required', askable: true, waiveOptions: ['Vi legger inn selv i CMS'], evaluate: evaluateMenuItems },
  { id: 'project-images', label: 'Bilder av prosjekter', askText: 'Bilder av prosjekter dere har gjort (gjerne seks eller flere)', group: 'Bilder',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Bruk mal-bilder foreløpig'], evaluate: evaluateProjectImages },
  { id: 'staff', label: 'Ansatte (navn, tittel, bilde)', askText: 'De ansatte som skal vises: navn, tittel og bilde', group: 'Innhold',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Fjern teamsiden'], evaluate: evaluateStaff },
  { id: 'price-list', label: 'Prisliste', askText: 'Prislisten deres', group: 'Innhold',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Pris på forespørsel'], evaluate: evaluatePriceList },
  { id: 'booking-services', label: 'Tjenester som kan bookes', askText: 'Tjenestene kundene skal kunne booke (navn, varighet og pris)', group: 'Innhold',
    dev: 'required', ready: 'required', askable: true, waiveOptions: ['Bruk ekstern bookinglenke'], evaluate: evaluateBookingServices },
  { id: 'blog-topics', label: '3 temaer til bloggen', askText: 'Tre temaer dere vil at bloggen skal skrive om', group: 'Innhold',
    dev: '', ready: 'optional', askable: true, waiveOptions: ['Vi skriver selv'], evaluate: evaluateBlogTopics },
  { id: 'services-list', label: 'Tjenestene dere tilbyr', askText: 'Tjenestene dere tilbyr', group: 'Innhold',
    dev: 'required', ready: '', askable: true, waiveOptions: [], evaluate: evaluateServicesList },
];

const KINDS_BY_LINE = new Map(GATE_PAGE_KIND_LINES.map((line) => [line.id, line.pageKinds]));

export const PAGE_KIND_REQUIREMENTS = Object.freeze(ROWS.map((row) => Object.freeze({
  ...row,
  pageKinds: Object.freeze([...(KINDS_BY_LINE.get(row.id) || [])]),
  waiveOptions: Object.freeze([...row.waiveOptions]),
})));

export const PAGE_KINDS = Object.freeze([...new Set(GATE_PAGE_KIND_LINES.flatMap((line) => line.pageKinds))]);

// Waive options that change the build. The delivery brief and the developer read these.
export const WAIVE_DIRECTIVES = Object.freeze({
  'staff|Fjern teamsiden': Object.freeze({ action: 'remove', pageKind: 'team' }),
  'booking-services|Bruk ekstern bookinglenke': Object.freeze({ action: 'external-link', pageKind: 'booking' }),
  'price-list|Pris på forespørsel': Object.freeze({ action: 'price-on-request', pageKind: 'pricing' }),
});

/** The build directive a waiver carries, or null. */
export function waiveDirective(lineId, option) {
  const directive = WAIVE_DIRECTIVES[`${text(lineId)}|${text(option)}`];
  return directive ? { ...directive, lineId: text(lineId), option: text(option) } : null;
}

// Page names (offer lines, wanted pages, routes) that name a page kind. Norwegian and English,
// matched as whole words after folding to lower case. Order matters: the first match wins.
const LABEL_KINDS = [
  ['blog-index', /\b(blogg?|nyheter|artikler|news|articles)\b/],
  ['menu', /\b(meny|menyen|menu|matmeny|lunsjmeny|drikkemeny)\b/],
  ['booking', /\b(booking|book\s+time|bestill\s+time|timebestilling|appointment|appointments|reservasjon|reservation)\b/],
  ['pricing', /\b(priser|prisliste|pricing|prices|price\s+list)\b/],
  ['team', /\b(team|teamet|ansatte|staff|our\s+people|medarbeidere)\b/],
  ['portfolio', /\b(portef[oø]lje|portfolio|prosjekter|projects|referanser|case\s+studies|cases)\b/],
  ['services', /\b(tjenester|tjeneste|services|service|behandlinger|treatments)\b/],
];

// Names that look like a kind but are not one (a customer-service page is not a services page).
const NOT_A_KIND = /\b(customer\s+service|kundeservice|terms\s+of\s+service)\b/;

/** The page kind a page name or route names, or ''. `/om-oss/team` and "Teamet" both give `team`. */
export function pageKindFromLabel(label) {
  const folded = text(label, 200).toLowerCase().replace(/[/_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!folded || NOT_A_KIND.test(folded)) return '';
  for (const [kind, pattern] of LABEL_KINDS) if (pattern.test(folded)) return kind;
  return '';
}

function offerPageLabels(offer) {
  if (!isPlainObject(offer)) return [];
  const labels = [];
  const fromPlan = (plan) => (isPlainObject(plan) ? [...listOf(plan.pageNames), ...listOf(plan.pages).filter((entry) => typeof entry === 'string')] : []);
  labels.push(...fromPlan(offer.plan), ...listOf(offer.pageNames));
  for (const alternative of listOf(offer.alternatives)) {
    labels.push(...fromPlan(alternative?.plan));
    for (const product of listOf(alternative?.products)) labels.push(...listOf(product?.includes));
  }
  for (const product of listOf(offer.products)) labels.push(...listOf(product?.includes));
  return labels.map((label) => text(label, 200)).filter(Boolean);
}

/**
 * The page kinds of a client's site: the Maker run's page plan when it reported one, otherwise the
 * page names of the offer, otherwise the wanted pages in Kundedata. Returns
 * { source, list: [{ route, kind }] } with only the kinds the gate knows.
 */
export function pageKindsForClient({ materials = null, offer = null, bank = null } = {}) {
  const fromRun = listOf(materials?.pageKinds)
    .map((row) => ({ route: text(row?.route, 300), kind: text(row?.kind, 41).toLowerCase() }))
    .filter((row) => row.kind);
  if (fromRun.length) return { source: 'maker-run', list: fromRun.filter((row) => PAGE_KINDS.includes(row.kind)) };
  const fromOffer = offerPageLabels(offer).map((label) => ({ route: '', kind: pageKindFromLabel(label) })).filter((row) => row.kind);
  if (fromOffer.length) return { source: 'offer', list: fromOffer };
  const wanted = text(bank?.websiteCreatorQuestions?.wantedPages, 2000);
  const fromWanted = wanted.split(/[,;\n]+/).map((label) => ({ route: '', kind: pageKindFromLabel(label) })).filter((row) => row.kind);
  if (fromWanted.length) return { source: 'wanted-pages', list: fromWanted };
  return { source: '', list: [] };
}

/** The page-kind rows that apply to a list of page kinds. */
export function pageKindRequirementsFor(list = []) {
  const kinds = new Set(listOf(list).map((row) => text(row?.kind ?? row).toLowerCase()));
  return PAGE_KIND_REQUIREMENTS.filter((row) => row.pageKinds.some((kind) => kinds.has(kind)));
}

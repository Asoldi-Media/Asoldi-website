// Service requirement table of the delivery gate, as data plus evaluators. Pure: no I/O.
//
// Each row is one gate line a sold service asks for. `dev` must be met before development
// starts, `ready` before the production publish. A row whose dev column is not `required` is a
// ready line (it is asked for, but it never blocks development). The evaluators read one prepared
// evidence object (`ev`, built by lib/delivery-gate.js) and return { have, evidence, source }.
//
// Rules that hold for every row:
// - The default portal colours, the default opening hours and the default website language of a new
//   Kundedata bank are never evidence of anything.
// - A waiver or an assistant skip is applied by the gate, not here: a row only says whether the
//   client's material is there.
import { GATE_SERVICE_LINES } from '../packages/suite/core/delivery/vocab.js';

export const GATE_GROUPS = Object.freeze(['Merke', 'Innhold', 'Kontakt', 'Bilder', 'Nettbutikk', 'Synlighet']);

// Bank buckets that hold pictures of the business (logos, icons and briefs are not such pictures).
const PICTURE_BUCKETS = Object.freeze([
  'mainHeroImages', 'galleryImages', 'uncategorized', 'teamImages', 'aboutImages',
  'locationImages', 'illustrationImages', 'offeringImages', 'projectImages',
]);

const DEFAULT_COLORS = Object.freeze(['#ff5b00', '#111827', '#f9f9f8']);
const DEFAULT_OPENING_DAYS = Object.freeze([
  ['Mandag', '08:00', '16:00', false],
  ['Tirsdag', '08:00', '16:00', false],
  ['Onsdag', '08:00', '16:00', false],
  ['Torsdag', '08:00', '16:00', false],
  ['Fredag', '08:00', '16:00', false],
  ['Lørdag', '10:00', '14:00', true],
  ['Søndag', '10:00', '14:00', true],
]);
const OFFICE_SCOPES_WITH_AREA = Object.freeze(['local', 'regional', 'niche-b2b', '', 'unknown']);

export function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A filled value: a non-empty string, a non-empty list of filled values, or a redacted placeholder object. */
export function filled(value) {
  if (Array.isArray(value)) return value.some(filled);
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  return Boolean(text(value));
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function mediaEntryFilled(entry) {
  if (typeof entry === 'string') return Boolean(text(entry));
  return Boolean(text(entry?.url || entry?.src || entry?.path || entry?.fileName || entry?.id));
}

/** Pictures in the Kundedata media library (every bucket except logos, icons and briefs). */
export function bankPictureCount(bank = {}, buckets = PICTURE_BUCKETS) {
  const media = isPlainObject(bank?.media) ? bank.media : {};
  let count = 0;
  for (const bucket of buckets) count += listOf(media[bucket]).filter(mediaEntryFilled).length;
  return count;
}

/** True when the bank's brand colours are still the portal defaults (never evidence of a brand). */
export function bankColorsAreDefault(bank = {}) {
  const colors = isPlainObject(bank?.brandIdentity?.colors) ? bank.brandIdentity.colors : {};
  const values = ['primary', 'secondary', 'accent'].map((key) => text(colors[key]).toLowerCase()).filter(Boolean);
  return values.every((value) => DEFAULT_COLORS.includes(value));
}

export function bankLogoPresent(bank = {}) {
  if (text(bank?.brandIdentity?.logos?.normal)) return true;
  return listOf(bank?.media?.logos).some(mediaEntryFilled);
}

/** Opening hours that differ from the portal's default week, or a Google sync link. */
export function bankOpeningHoursFilled(bank = {}) {
  if (text(bank?.openingHours?.googleBusinessSyncUrl)) return true;
  const days = listOf(bank?.openingHours?.days);
  if (!days.length) return false;
  if (days.length !== DEFAULT_OPENING_DAYS.length) return true;
  return !DEFAULT_OPENING_DAYS.every(([day, opens, closes, closed], index) => {
    const row = days[index] || {};
    return text(row.day) === day && text(row.opensAt) === opens && text(row.closesAt) === closes && Boolean(row.closed) === closed;
  });
}

function catalogsOf(bank = {}) {
  return listOf(bank?.productCatalogs);
}

/** Every product row in the bank: catalog products first, then the legacy product categories. */
export function bankProducts(bank = {}) {
  const out = [];
  for (const catalog of catalogsOf(bank)) {
    for (const category of listOf(catalog?.categories)) {
      for (const product of listOf(category?.products)) out.push({ product, layout: text(catalog?.layout).toLowerCase() });
    }
  }
  if (out.length) return out;
  for (const category of listOf(bank?.products)) {
    for (const item of listOf(category?.items || category?.products)) out.push({ product: item, layout: '' });
  }
  return out;
}

function productHasNameAndPrice(product = {}) {
  return Boolean(text(product?.title || product?.name)) && (Boolean(text(product?.price)) || product?.contactInsteadOfPrice === true);
}

export function bankProductsWithNameAndPrice(bank = {}, { layout = '' } = {}) {
  return bankProducts(bank).filter((row) => (!layout || row.layout === layout) && productHasNameAndPrice(row.product)).length;
}

export function bankCatalogItemCount(bank = {}, { layout = '' } = {}) {
  return bankProducts(bank).filter((row) => (!layout || row.layout === layout) && text(row.product?.title || row.product?.name)).length;
}

export function bankStaff(bank = {}) {
  return listOf(bank?.staff).filter((person) => text(person?.name));
}

function shopSetup(ev) {
  return isPlainObject(ev.bank?.shopSetup) ? ev.bank.shopSetup : {};
}

function factsShop(ev) {
  return isPlainObject(ev.facts?.shop) ? ev.facts.shop : {};
}

function answer(ev, key) {
  return ev.answers?.[key];
}

function have(value, evidence, source) {
  return { have: Boolean(value), evidence: value ? evidence : '', source: value ? source : '' };
}

function missing(evidence = '') {
  return { have: false, evidence, source: '' };
}

// ---------------------------------------------------------------- evaluators

function evaluateWorkshop(ev) {
  if (text(ev.workshop?.heldAt)) return have(true, 'Workshop registrert som holdt', 'workshop.heldAt');
  const notes = listOf(ev.workshop?.notes).filter((note) => text(note?.kind || 'workshop') === 'workshop');
  if (notes.length) return have(true, 'Workshopnotat lagret', 'workshop.notes');
  return missing('Workshopen er ikke registrert');
}

function evaluateLogo(ev) {
  if (bankLogoPresent(ev.bank)) return have(true, 'Logo i Kundedata', 'bank');
  if (ev.materials?.logo?.present === true) return have(true, 'Logo i Maker', 'maker');
  if (ev.inboxFound.has('logo')) return have(true, 'Logo mottatt på e-post', 'inbox');
  const need = ev.needs.find((item) => text(item?.id) === 'logo');
  if (need && ['have', 'image', 'present'].includes(text(need.status).toLowerCase())) return have(true, 'Logo funnet av Maker', 'maker-needs');
  if (ev.facts?.logo?.status === 'present') return have(true, 'Logo i briefen', 'brief');
  return missing(ev.wordmarkAvailable ? 'Ingen logofil; tekstlogo er mulig' : 'Ingen logo i Kundedata eller Maker');
}

function evaluateBusinessWhat(ev) {
  if (filled(ev.bank?.websiteCreatorQuestions?.businessWhat)) return have(true, 'Beskrivelse i Kundedata', 'bank');
  if (filled(answer(ev, 'businessWhat'))) return have(true, 'Beskrivelse i Maker', 'maker');
  if (ev.inboxFound.has('business-what')) return have(true, 'Mottatt på e-post', 'inbox');
  const positioning = isPlainObject(ev.facts?.positioning) ? ev.facts.positioning : {};
  if (filled(positioning.businessWhat) && filled(positioning.audience)) return have(true, 'Beskrivelse og målgruppe i briefen', 'brief');
  return missing('Mangler kort beskrivelse av bedriften');
}

/** Phone, email and visit address separately (Kundedata, the Maker answers, the sales card and the brief). */
export function contactParts(ev) {
  const general = isPlainObject(ev.bank?.generalInfo) ? ev.bank.generalInfo : {};
  const contact = isPlainObject(ev.facts?.contact) ? ev.facts.contact : {};
  const phone = filled(general.companyPhone) || filled(answer(ev, 'phone')) || filled(ev.client?.contactPhone)
    || filled(contact.phone) || ev.inboxFound.has('phone');
  const email = filled(general.companyEmail) || filled(answer(ev, 'email')) || filled(ev.client?.clientEmail)
    || filled(ev.client?.contactEmail) || filled(contact.email) || ev.inboxFound.has('company-email');
  const address = filled(general.companyAddress) || filled(answer(ev, 'address')) || filled(contact.address)
    || ev.inboxFound.has('address');
  return { phone, email, address, onlineOnly: contact.onlineOnly === true };
}

function evaluateContact(ev) {
  const parts = contactParts(ev);
  if (parts.phone && parts.email && parts.address) return have(true, 'Telefon, e-post og adresse finnes', 'bank');
  if (parts.onlineOnly && (parts.phone || parts.email)) return have(true, 'Kun e-post/nett (fra briefen)', 'brief');
  const lacking = [
    parts.phone ? '' : 'telefon',
    parts.email ? '' : 'e-post',
    parts.address ? '' : 'adresse',
  ].filter(Boolean);
  return missing(`Mangler ${lacking.join(', ')}`);
}

/** Visit address known and the business is not online-only (then opening hours apply). */
function hasVisitAddress(ev) {
  const parts = contactParts(ev);
  return parts.address && !parts.onlineOnly;
}

function openPlaceholderSlots(ev) {
  const item = ev.needs.find((need) => text(need?.id) === 'media.placeholders');
  if (!item || ['have', 'done', 'ok'].includes(text(item.status).toLowerCase())) return [];
  return listOf(item.slots);
}

function evaluateHeroMedia(ev) {
  const pictures = bankPictureCount(ev.bank);
  if (pictures >= 3) return have(true, `${pictures} bilder i Kundedata`, 'bank');
  const uploads = Number(ev.materials?.uploadsTotal) || 0;
  if (uploads >= 3 && !openPlaceholderSlots(ev).length) return have(true, `${uploads} opplastinger i Maker`, 'maker');
  const media = [...ev.inboxFound].some((id) => ['hero', 'about-images', 'location-images', 'gallery', 'uncategorized-media', 'offering-images', 'team-images'].includes(id));
  if (media && pictures + uploads >= 1) return have(true, 'Bilder mottatt på e-post', 'inbox');
  const slots = openPlaceholderSlots(ev).length;
  return missing(slots ? `${slots} eksempelbilder står fortsatt på siden` : `${Math.max(pictures, uploads)} av 3 bilder`);
}

function evaluateOpeningHours(ev) {
  if (bankOpeningHoursFilled(ev.bank)) return have(true, 'Åpningstider i Kundedata', 'bank');
  if (['openingHoursMon', 'openingHoursTue', 'openingHoursWed', 'openingHoursThu', 'openingHoursFri', 'openingHoursSat', 'openingHoursSun']
    .some((key) => filled(answer(ev, key)))) return have(true, 'Åpningstider i Maker', 'maker');
  if (ev.inboxFound.has('opening-hours')) return have(true, 'Mottatt på e-post', 'inbox');
  if (filled(ev.facts?.contact?.openingHours)) return have(true, 'Åpningstider i briefen', 'brief');
  return missing('Ingen åpningstider');
}

function evaluateDomain(ev) {
  const setup = isPlainObject(ev.bank?.domainSetup) ? ev.bank.domainSetup : {};
  if (text(setup.domain)) return have(true, 'Domene i Kundedata', 'bank');
  if (text(ev.bank?.websiteCreatorQuestions?.websiteDomain)) return have(true, 'Domene i Kundedata', 'bank');
  if (text(ev.materials?.domain)) return have(true, 'Domene i Maker', 'maker');
  if (text(answer(ev, 'websiteDomain'))) return have(true, 'Domene i Maker', 'maker');
  if (ev.inboxFound.has('domain')) return have(true, 'Mottatt på e-post', 'inbox');
  return missing('Ingen domene valgt');
}

function evaluateClientApproval(ev) {
  const approval = isPlainObject(ev.delivery?.events?.approval) ? ev.delivery.events.approval : {};
  const preview = isPlainObject(ev.delivery?.events?.previewReady) ? ev.delivery.events.previewReady : {};
  const ok = Boolean(text(approval.at) && text(approval.previewHash) && text(approval.previewHash) === text(preview.previewHash));
  if (ok) return have(true, 'Godkjent for siste forhåndsvisning', 'delivery.events.approval');
  return missing(text(approval.at) ? 'Godkjenningen gjelder en eldre forhåndsvisning' : 'Ikke godkjent ennå');
}

function evaluateKeywords(ev) {
  if (ev.agreedKeywords > 0) return have(true, `${ev.agreedKeywords} godkjente søkeord`, 'seo');
  const bankKeywords = listOf(ev.bank?.websiteCreatorQuestions?.importantKeywords).filter((entry) => text(entry?.phrase ?? entry)).length;
  if (bankKeywords > 0) return have(true, `${bankKeywords} søkeord i Kundedata`, 'bank');
  if (filled(answer(ev, 'importantKeywords'))) return have(true, 'Søkeord i Maker', 'maker');
  if (ev.inboxFound.has('keywords')) return have(true, 'Mottatt på e-post', 'inbox');
  return missing('Ingen søkeord');
}

function serviceAreaApplies(ev) {
  return OFFICE_SCOPES_WITH_AREA.includes(text(ev.seoScope).toLowerCase());
}

function evaluateServiceArea(ev) {
  if (filled(ev.facts?.contact?.town)) return have(true, 'Område i briefen', 'brief');
  if (filled(ev.bank?.websiteCreatorQuestions?.town)) return have(true, 'Område i Kundedata', 'bank');
  if (filled(answer(ev, 'town'))) return have(true, 'Område i Maker', 'maker');
  if (filled(ev.onboardingCity)) return have(true, 'By fra onboarding', 'onboarding');
  if (ev.inboxFound.has('town')) return have(true, 'Mottatt på e-post', 'inbox');
  return missing('Ingen by eller område');
}

function evaluateGoogleBusiness(ev) {
  const general = isPlainObject(ev.bank?.generalInfo) ? ev.bank.generalInfo : {};
  const found = filled(general.googleMapsUrl) || filled(ev.bank?.openingHours?.googleBusinessSyncUrl)
    || filled(ev.client?.details?.googleBusinessProfile) || filled(answer(ev, 'googleBusinessProfile'))
    || ev.inboxFound.has('google-business');
  return found ? have(true, 'Google-profil registrert', 'bank') : missing('Ingen Google-profil');
}

function evaluateProducts(ev) {
  const products = bankProductsWithNameAndPrice(ev.bank);
  if (products > 0) return have(true, `${products} produkter med navn og pris`, 'bank');
  if ((Number(ev.materials?.products) || 0) > 0) return have(true, `${ev.materials.products} produkter i Maker`, 'maker');
  if (ev.inboxFound.has('product-name')) return have(true, 'Produkter mottatt på e-post', 'inbox');
  return missing('Ingen produkter med navn og pris');
}

function evaluateSeller(ev) {
  const orgNumber = filled(ev.bank?.brandIdentity?.orgNumber) || filled(ev.client?.orgNumber)
    || filled(ev.client?.organizationNumber) || filled(ev.facts?.identity?.orgNumber) || ev.inboxFound.has('org-number');
  const legalName = filled(ev.facts?.identity?.legalName) || filled(ev.client?.legalName) || filled(ev.offerPartyName);
  if (orgNumber && legalName) return have(true, 'Org.nr og juridisk navn finnes', 'bank');
  return missing(orgNumber ? 'Mangler juridisk navn' : 'Mangler org.nr');
}

function evaluateShipping(ev) {
  const found = filled(shopSetup(ev).shipping) || filled(factsShop(ev).shipping);
  return found ? have(true, 'Frakt beskrevet', 'bank') : missing('Ingen fraktvalg');
}

function evaluateReturns(ev) {
  const found = filled(shopSetup(ev).returns) || filled(factsShop(ev).returns);
  return found ? have(true, 'Returvilkår beskrevet', 'bank') : missing('Ingen returvilkår');
}

/**
 * The shop can take payment: the stored connection is `ready` by the same rule as the client CMS
 * payment status (lib/shop-payments.js getSiteShopStatus): Stripe once charges are enabled, PayPal
 * once a payee is set and payments are receivable (or the payee is an email). A connection that
 * was only started does not count.
 */
function evaluatePayment(ev) {
  const shop = ev.shopConnections || {};
  if (shop.stripe?.ready === true) return have(true, 'Stripe kan ta imot betaling', 'shop-connections');
  if (shop.paypal?.ready === true) return have(true, 'PayPal kan ta imot betaling', 'shop-connections');
  if (shop.stripe?.connected || shop.paypal?.connected) return missing('Betaling er koblet, men kan ikke ta imot betaling ennå');
  return missing('Ingen betaling koblet');
}

function evaluateCatalogItems(ev) {
  const items = bankCatalogItemCount(ev.bank);
  if (items > 0) return have(true, `${items} varer i katalogen`, 'bank');
  if ((Number(ev.materials?.productCatalogs) || 0) > 0 && (Number(ev.materials?.products) || 0) > 0) return have(true, 'Katalog i Maker', 'maker');
  return missing('Ingen katalog med varer');
}

export function bookingServicesCount(ev) {
  return listOf(shopSetup(ev).bookingServices).filter((entry) => text(entry?.name ?? entry)).length
    + listOf(factsShop(ev).bookingServices).filter((entry) => text(entry?.name ?? entry)).length;
}

function evaluateBookingServices(ev) {
  const count = bookingServicesCount(ev);
  return count > 0 ? have(true, `${count} tjenester kan bookes`, 'bank') : missing('Ingen bookbare tjenester');
}

function evaluateLanguages(ev) {
  const languages = listOf(ev.plan?.languages);
  return languages.length >= 2 ? have(true, `${languages.length} språk i planen`, 'sitePlan') : missing('Kun ett språk i planen');
}

// ---------------------------------------------------------------- the table

const ROWS = [
  { id: 'workshop', label: 'Workshop gjennomført', askText: '', group: 'Innhold', dev: 'required', ready: '', askable: false,
    waiveOptions: ['Holdt uten opptak (notat)'], evaluate: evaluateWorkshop },
  { id: 'logo', label: 'Logo (fil)', askText: 'Logoen deres (helst SVG eller PNG)', group: 'Merke', dev: 'required', ready: '', askable: true,
    waiveOptions: ['Bruk tekstlogo'], evaluate: evaluateLogo },
  { id: 'business-what', label: 'Kort om hva dere gjør og for hvem', askText: 'Kort om hva dere gjør og hvem kundene deres er', group: 'Innhold',
    dev: 'required', ready: '', askable: true, waiveOptions: [], evaluate: evaluateBusinessWhat },
  { id: 'contact', label: 'Telefon, e-post og adresse', askText: 'Telefon, e-post og adresse som skal stå på nettsiden', group: 'Kontakt',
    dev: 'required', ready: '', askable: true, waiveOptions: ['Kun e-post/nett'], evaluate: evaluateContact },
  { id: 'hero-media', label: 'Bilder til forsiden og undersider', askText: 'Bilder til forsiden og undersidene (gjerne tre eller flere)', group: 'Bilder',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Bruk innhentede/mal-bilder', 'Tekstbasert design'], evaluate: evaluateHeroMedia },
  { id: 'opening-hours', label: 'Åpningstider', askText: 'Åpningstidene deres', group: 'Kontakt', dev: 'optional', ready: 'optional', askable: true,
    waiveOptions: ['Ingen faste'], applies: hasVisitAddress, evaluate: evaluateOpeningHours },
  { id: 'domain', label: 'Domene', askText: 'Domenet nettsiden skal ligge på (eller om dere vil ha hjelp til å kjøpe ett)', group: 'Synlighet',
    dev: '', ready: 'required', askable: true, waiveOptions: ['Midlertidig domene'], evaluate: evaluateDomain },
  { id: 'client-approval', label: 'Godkjenning av nettsiden', askText: '', group: 'Innhold', dev: '', ready: 'required', askable: false,
    waiveOptions: ['Muntlig godkjent'], evaluate: evaluateClientApproval },
  { id: 'keywords', label: '1–3 søkeord', askText: '1–3 søkeord kundene deres bruker når de leter etter det dere tilbyr', group: 'Synlighet',
    dev: 'required', ready: '', askable: true, waiveOptions: ['Foreslå for oss'], evaluate: evaluateKeywords },
  { id: 'service-area', label: 'Område/by', askText: 'Hvilket område eller hvilken by dere vil bli funnet i', group: 'Synlighet',
    dev: 'required', ready: '', askable: true, waiveOptions: ['Hele landet'], applies: serviceAreaApplies, evaluate: evaluateServiceArea },
  { id: 'google-business', label: 'Google Business-profil', askText: 'Lenke til Google Business-profilen deres, hvis dere har en', group: 'Synlighet',
    dev: 'optional', ready: 'optional', askable: true, waiveOptions: ['Har ikke'], evaluate: evaluateGoogleBusiness },
  { id: 'products', label: 'Produkter: navn, pris og bilde (eller lenke/fil)', askText: 'Produktene: navn, pris og bilde (eller en lenke eller fil med alt)', group: 'Nettbutikk',
    dev: 'required', ready: 'required', askable: true, waiveOptions: ['Kunden legger inn selv i CMS'], evaluate: evaluateProducts },
  { id: 'seller', label: 'Juridisk navn, org.nr og MVA-status', askText: 'Juridisk navn, organisasjonsnummer og om dere er MVA-registrert', group: 'Nettbutikk',
    dev: 'required', ready: 'required', askable: true, waiveOptions: [], evaluate: evaluateSeller },
  { id: 'shipping', label: 'Frakt: metoder og priser', askText: 'Hvordan dere sender varer, og hva frakten koster', group: 'Nettbutikk',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Kun henting'], evaluate: evaluateShipping },
  { id: 'returns', label: 'Retur og angrerett', askText: 'Returvilkår og angrerett', group: 'Nettbutikk',
    dev: 'optional', ready: 'required', askable: true, waiveOptions: ['Standard 14 dagers angrerett'], evaluate: evaluateReturns },
  { id: 'payment', label: 'Betaling koblet (Stripe/PayPal)', askText: '', group: 'Nettbutikk', dev: '', ready: 'required', askable: false,
    waiveOptions: [], evaluate: evaluatePayment },
  { id: 'catalog-items', label: 'Meny/katalog med priser', askText: 'Menyen eller katalogen deres med priser', group: 'Nettbutikk',
    dev: 'required', ready: 'required', askable: true, waiveOptions: [], evaluate: evaluateCatalogItems },
  { id: 'booking-services', label: 'Tjenester som kan bookes', askText: 'Tjenestene kundene skal kunne booke (navn, varighet og pris)', group: 'Innhold',
    dev: 'required', ready: 'required', askable: true, waiveOptions: [], evaluate: evaluateBookingServices },
  { id: 'languages', label: 'Språk utover norsk', askText: 'Hvilke språk nettsiden skal ha i tillegg til norsk', group: 'Innhold',
    dev: 'required', ready: '', askable: true, waiveOptions: ['Kun norsk foreløpig'], evaluate: evaluateLanguages },
];

const SERVICES_BY_LINE = new Map(GATE_SERVICE_LINES.map((line) => [line.id, line.services]));

export const SERVICE_REQUIREMENTS = Object.freeze(ROWS.map((row) => Object.freeze({
  ...row,
  services: Object.freeze([...(SERVICES_BY_LINE.get(row.id) || [])]),
  waiveOptions: Object.freeze([...row.waiveOptions]),
})));

/** The gate column a row belongs to: `dev` when development needs it, else `ready`. */
export function requirementGate(row) {
  if (row.dev === 'required') return 'dev';
  if (row.ready) return 'ready';
  return 'dev';
}

/** The level of a row in its own column. */
export function requirementLevel(row) {
  const gate = requirementGate(row);
  return (gate === 'dev' ? row.dev : row.ready) === 'required' ? 'required' : 'optional';
}

/** The service rows that apply to a plan's services (and to the evidence, for conditional rows). */
export function serviceRequirementsFor(services = [], ev = null) {
  const sold = new Set(services);
  return SERVICE_REQUIREMENTS.filter((row) => row.services.some((service) => sold.has(service))
    && (typeof row.applies !== 'function' || !ev || row.applies(ev)));
}

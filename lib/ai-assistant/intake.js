/**
 * Client data intake. Ask only for a missing bucket, in order:
 * products → media → logo → staff → hours → partners.
 * When a signed plan is in play, shop, keywords and booking follow those six.
 * Wording shifts a little per business so it does not feel like a form.
 */
import {
  isRegulatedPhrase,
  normalizeSeoPhrase,
  seoPhraseKey,
  seoPhraseWordCount,
} from '../seo-ops/phrase-filters.js';

export const SETTINGS_PATH = '/kunde/innstillinger';
export const SIGNER_STAFF_ID = 'ansatt-signer';

export const INTAKE_STEPS = ['products', 'media', 'logo', 'staff', 'hours', 'affiliations'];

/** Extra steps a signed plan can add, in the order they are asked. */
export const PLAN_STEPS = Object.freeze(['shop', 'keywords', 'booking']);

export const STEP_LABELS = {
  products: 'Produkter',
  media: 'Media',
  logo: 'Logo',
  staff: 'Ansatte',
  hours: 'Åpningstider',
  affiliations: 'Partnere',
  shop: 'Butikk',
  keywords: 'Søkeord',
  booking: 'Timebestilling',
  done: 'Ferdig',
};

/**
 * Which plan steps apply. `services` are expanded service ids.
 * @param {{ services?: string[], pageKinds?: string[] }} [input]
 * @returns {string[]}
 */
export function planStepsFor({ services = [], pageKinds = [] } = {}) {
  const sold = new Set(services);
  const kinds = new Set(pageKinds);
  const steps = [];
  if (sold.has('ecom')) steps.push('shop');
  if (sold.has('seo')) steps.push('keywords');
  if (sold.has('booking') || kinds.has('booking')) steps.push('booking');
  return steps;
}

const WEEK = [
  { day: 'Mandag', keys: ['mandag', 'man', 'monday', 'mon'] },
  { day: 'Tirsdag', keys: ['tirsdag', 'tir', 'tuesday', 'tue'] },
  { day: 'Onsdag', keys: ['onsdag', 'ons', 'wednesday', 'wed'] },
  { day: 'Torsdag', keys: ['torsdag', 'tor', 'thursday', 'thu'] },
  { day: 'Fredag', keys: ['fredag', 'fre', 'friday', 'fri'] },
  { day: 'Lørdag', keys: ['lordag', 'lor', 'saturday', 'sat'] },
  { day: 'Søndag', keys: ['sondag', 'son', 'sunday', 'sun'] },
];

const DEFAULT_HOURS = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

const QUESTIONS = {
  products: [
    () => 'Har dere produkter, tjenester eller en meny jeg kan legge inn? Last opp et dokument, eller skriv listen her.',
    (name) => `La oss starte med det dere tilbyr${name ? ` hos ${name}` : ''}. Last opp en prisliste, eller skriv det rett her.`,
    (name) => `Først vil jeg samle tilbudene deres${name ? ` — ${name}` : ''}. PDF, Word, Excel eller en kort liste fungerer.`,
  ],
  media: [
    (name) => `Hvilke bilder eller videoer skal vi bruke${name ? ` for ${name}` : ''}? Slipp filene her. Tekstfiler legges ikke i mediabiblioteket.`,
    (name) => `Har dere bilder eller video som skal ligge i biblioteket${name ? ` til ${name}` : ''}? Last dem opp her.`,
    (name) => `Send bildene og videoene dere vil at vi skal bruke. Jeg legger dem rett i mediabiblioteket.`,
  ],
  logo: [
    (name) => `Kan du laste opp logoen${name ? ` til ${name}` : ''}? Den går til logofeltet.`,
    (name) => `Har dere en logofil? Last den opp, så legger jeg den på vanlig logoplass.`,
    (name) => `Hvis logoen ikke ligger inne ennå, send bildefilen her.`,
  ],
  staff: [
    (name) => `Lyst til å vise informasjon om ansatte${name ? ` hos ${name}` : ''} på siden? I så fall trenger jeg tittel, navn, nummer og e-post.`,
    (name) => `Skal teamet vises på nettsiden? Skriv navn, stilling, telefon og e-post for hver person, eller si ifra hvis det ikke er aktuelt.`,
    (name) => `Vil dere ha ansatte på siden? Én person per linje: navn, tittel, telefon, e-post.`,
  ],
  staffDetails: [
    () => 'Skriv én person per linje: navn, tittel, telefon, e-post.',
    () => 'Fint. Gi meg navn, stilling, nummer og e-post. Flere personer kan stå på hver sin linje.',
  ],
  hours: [
    (name) => `Når er dere åpne${name ? ` hos ${name}` : ''}? Fyll ut feltene under, eller skriv fritt i chatten. Mandag til søndag, åpent hele tiden, eller ikke relevant.`,
    () => 'Hva er åpningstidene? Bruk feltene under, eller skriv i chatten. Mandag til søndag, åpent hele tiden, eller ikke relevant.',
    () => 'Fortell når dere har åpent. Feltene under er enklest, og chatten under virker også. 24/7 og «ikke relevant» er fine svar.',
  ],
  affiliations: [
    (name) => name
      ? `Har ${name} noen partnere dere jobber med, som skal med på nettsiden?`
      : 'Har dere noen partnere dere jobber med, som skal med på nettsiden?',
    (name) => `Noen samarbeidspartnere vi skal vise${name ? ` for ${name}` : ''}? Skriv navnene, og si fra om de hører i ulike grupper.`,
    () => 'Skal vi ta med partnere eller affiliasjoner? List dem opp, så sorterer jeg dem.',
  ],
  affiliationDetails: [
    () => 'Skriv partnerne. Hvis de hører i ulike grupper, sett gruppenavn foran, for eksempel «Sponsorer: …».',
    () => 'Nevn hvem dere vil ha med, gjerne gruppert hvis det er flere typer.',
  ],
  'shop:shipping': [
    () => 'Hvordan sender dere varer, og hva koster frakten? Betaling (Stripe eller PayPal) kobles senere i nettsidens admin, så det trenger vi ikke nå.',
    (name) => `Hvordan sender ${name ? name : 'dere'} varene, og hva koster frakten? Stripe eller PayPal kobles senere i nettsidens admin.`,
    () => 'Fortell fraktmåte og fraktpris. Betaling kobles senere i admin (Stripe eller PayPal), så si ingenting om betaling nå.',
  ],
  'shop:returns': [
    () => 'Hva er returvilkårene og angreretten? «Standard 14 dagers angrerett» er et fint svar.',
    () => 'Skriv returvilkår og angrerett. Standard 14 dagers angrerett er helt greit.',
    () => 'Hvordan fungerer retur hos dere? Du kan svare standard 14 dagers angrerett.',
  ],
  'shop:seller': [
    () => 'Hva er det juridiske navnet, organisasjonsnummeret, og er dere MVA-registrert?',
    (name) => `Jeg trenger juridisk navn, organisasjonsnummer og om ${name ? name : 'dere'} er MVA-registrert.`,
    () => 'Oppgi juridisk navn og organisasjonsnummer, og si om dere er MVA-registrert.',
  ],
  'keywords:keywords': [
    () => 'Hvilke 1–3 søkeord bruker kundene når de leter etter det dere tilbyr? Ett per linje, eller med komma.',
    (name) => `Skriv 1–3 søkeord kundene bruker når de leter etter ${name ? name : 'dere'}. Ett per linje eller skilt med komma.`,
    () => 'Gi meg 1–3 søkeord, ett per linje eller med komma.',
  ],
  'keywords:area': [
    () => 'Hvilken by eller hvilket område vil dere bli funnet i?',
    (name) => `Hvor vil ${name ? name : 'dere'} bli funnet? Skriv by eller område.`,
    () => 'Hvilket sted eller område skal siden gjelde?',
  ],
  'booking:services': [
    () => 'Hvilke tjenester skal kundene kunne bestille? Én per linje: navn, varighet, pris.',
    (name) => `Skriv tjenestene som kan bookes${name ? ` hos ${name}` : ''}, én per linje med navn, varighet og pris.`,
    () => 'List det kundene skal kunne bestille. Én linje per tjeneste: navn, varighet, pris.',
  ],
};

const SITE_PRODUCT_QUESTIONS = [
  (_name, host) => `Produktene kan hentes fra ${host} når nettsiden bygges. Svar ja, eller last opp en liste.`,
  (name, host) => `Vi kan ta produktene fra ${host} når siden bygges${name ? ` for ${name}` : ''}. Svar ja, eller send en liste.`,
  (_name, host) => `Skal vi hente produktene fra ${host} når nettsiden bygges? Svar ja, eller last opp listen.`,
];

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function fold(value = '') {
  return compact(value)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a');
}

function hashSeed(seed = '') {
  let hash = 0;
  const text = String(seed || 'asoldi');
  for (let i = 0; i < text.length; i += 1) hash = (hash + text.charCodeAt(i) * (i + 1)) % 997;
  return hash;
}

export function variant(seed, options = []) {
  if (!options.length) return '';
  return options[hashSeed(seed) % options.length];
}

export function businessLabel(bank = {}, profile = {}) {
  return compact(
    bank?.businessCard?.companyName
    || bank?.generalInfo?.companyName
    || profile?.businessName
    || '',
  );
}

export function personFirstName(profile = {}) {
  const raw = compact(profile?.name || profile?.fullName || '');
  if (!raw || raw.includes('@')) return '';
  return raw.split(' ')[0];
}

const MORE_TOPIC = {
  products: 'produktinformasjonen',
  media: 'mediabiblioteket',
  logo: 'logoen',
  staff: 'ansattinformasjonen',
  hours: 'åpningstidene',
  affiliations: 'partnerinformasjonen',
  shop: 'butikken',
  keywords: 'søkeordene',
  booking: 'timebestillingen',
};

const CHAPTER_MATCHERS = [
  ['hours', /\bapningstid(?:er|ene)?\b/],
  ['affiliations', /\b(?:partner(?:e|info|informasjonen|informasjon)?|affiliasjon(?:er)?|sponsor(?:er)?)\b/],
  ['staff', /\b(?:ansatt(?:e|info|informasjonen|informasjon)?|teamet)\b/],
  ['logo', /\blogo(?:en|fil)?\b/],
  ['media', /\b(?:mediabibliotek(?:et)?|media)\b/],
  ['products', /\bprodukt(?:er|info|informasjonen|informasjon)?\b/],
];

const NAV_FILLER = /\b(?:kan|du|dere|vi|jeg|vil|gjerne|la|oss|ga|til|bytt|vis|meg|apne|ta|hopp|legg|legge|inn|fyll|fylle|ut|skal|sett|endre|oppdater|laste|last|opp|sende|send|takk|na|en|et|den|det|vaar|vare|deres|pa|i|og|er|har|noe|mer|lyst|a)\b/g;

const CHAPTER_WORDS = new Set([
  'produkt', 'produkter', 'produktinfo', 'produktinformasjon', 'produktinformasjonen',
  'mediabibliotek', 'mediabiblioteket', 'media',
  'logo', 'logoen', 'logofil',
  'ansatt', 'ansatte', 'ansattinfo', 'ansattinformasjon', 'ansattinformasjonen', 'teamet',
  'apningstid', 'apningstider', 'apningstidene',
  'partner', 'partnere', 'partnerinfo', 'partnerinformasjon', 'partnerinformasjonen',
  'affiliasjon', 'affiliasjoner', 'sponsor', 'sponsorer',
]);

export function questionFor(step, name = '') {
  if (step === 'done') return doneMessage(name);
  const options = QUESTIONS[step];
  if (!options) return doneMessage(name);
  const picked = variant(`${name}:${step}`, options);
  return typeof picked === 'function' ? picked(name) : String(picked || '');
}

export function moreQuestion(step) {
  const topic = MORE_TOPIC[step];
  if (!topic) return '';
  return `Lyst til å legge til mer i ${topic}?`;
}

export function awaitingMore(bank = {}, step = '') {
  return compact(bank?.assistantIntake?.[step]) === 'more';
}

export function chapterHasContent(bank = {}, step = '') {
  if (step === 'products') return productCount(bank) > 0;
  if (step === 'media') return mediaFileCount(bank) > 0;
  if (step === 'logo') return hasLogo(bank);
  if (step === 'staff') return hasListedTeam(bank);
  if (step === 'hours') return hoursLookCustom(bank);
  if (step === 'affiliations') return hasAffiliations(bank);
  if (step === 'shop') {
    return Boolean(compact(bank?.shopSetup?.shipping) || compact(bank?.shopSetup?.returns)
      || compact(bank?.shopSetup?.sellerVat?.legalName) || compact(bank?.shopSetup?.sellerVat?.orgNumber));
  }
  if (step === 'keywords') return keywordPhrases(bank).length > 0 || Boolean(compact(bank?.websiteCreatorQuestions?.town));
  if (step === 'booking') return bookingServices(bank).length > 0;
  return false;
}

/** Host of a website address, or ''. */
export function websiteHost(url = '') {
  const raw = compact(url);
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.host || '';
  } catch {
    return '';
  }
}

function productSiteHost(bank, ctx) {
  if (!ctx?.steps?.includes('shop') || !ctx.websiteUrl || productCount(bank) > 0) return '';
  return websiteHost(ctx.websiteUrl);
}

function planQuestion(name, step, sub) {
  const options = QUESTIONS[`${step}:${sub}`] || [];
  const picked = variant(`${name}${step}${sub}`, options);
  return typeof picked === 'function' ? picked(name) : String(picked || '');
}

export function promptFor(step, name = '', bank = {}, { revisit = false, ctx = null } = {}) {
  if (step === 'done') return doneMessage(name);
  if (PLAN_STEPS.includes(step)) {
    const sub = planSubStep(step, bank, ctx);
    if (!sub) return moreQuestion(step) || doneMessage(name);
    return planQuestion(name, step, sub);
  }
  const hasContent = chapterHasContent(bank, step);
  if (hasContent && (revisit || awaitingMore(bank, step))) return moreQuestion(step);
  if (step === 'products') {
    const host = productSiteHost(bank, ctx);
    if (host) {
      const picked = variant(`${name}productsprefill`, SITE_PRODUCT_QUESTIONS);
      return typeof picked === 'function' ? picked(name, host) : String(picked || '');
    }
  }
  return questionFor(step, name);
}

export function doneMessage(name = '') {
  return variant(name || 'ferdig', [
    `Da har vi det vi trenger${name ? ` om ${name}` : ''}. Stegene viser det som er samlet inn. Skriv her hvis du vil endre noe, eller velg et steg.`,
    `Datainnsamlingen er ferdig${name ? ` for ${name}` : ''}. Velg et steg for å legge til mer, eller skriv det du vil oppdatere.`,
    'Det var alt jeg skulle hente inn. Skriv det du vil endre, eller velg et steg.',
  ]);
}

export function chapterHits(text = '') {
  const folded = fold(text);
  return CHAPTER_MATCHERS.filter(([, pattern]) => pattern.test(folded)).map(([step]) => step);
}

export function navigationTarget(text = '') {
  const raw = compact(text);
  if (!raw || raw.length > 140) return '';
  if (isDecline(raw) || isNoMore(raw)) return '';
  const hits = chapterHits(raw);
  if (hits.length !== 1) return '';
  const folded = fold(raw);
  if (hits[0] !== 'hours' && /\d/.test(folded)) return '';
  if (hits[0] === 'hours' && mentionsHours(folded)) {
    const parsed = parseOpeningHoursAnswer(raw);
    if (parsed.action === 'set' || parsed.action === 'always') return '';
  }
  const words = folded
    .replace(NAV_FILLER, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length || !words.every((word) => CHAPTER_WORDS.has(word))) return '';
  return hits[0];
}

function mentionsHours(folded = '') {
  return /apningstid|dogn|24\s*\/\s*7|mandag|tirsdag|onsdag|torsdag|fredag|lordag|sondag|apent/.test(folded);
}

export function sideWrite(text = '', step = '') {
  const raw = compact(text);
  if (!raw || isNoMore(raw)) return null;
  const folded = fold(raw);
  if (step !== 'hours' && mentionsHours(folded) && !isDecline(raw)) {
    const parsed = parseOpeningHoursAnswer(raw);
    if (parsed.action === 'set' || parsed.action === 'always') return { kind: 'hours', parsed };
    if (parsed.action === 'not-relevant' && /apningstid|apent|dogn/.test(folded)) return { kind: 'hours', parsed };
  }
  if (step !== 'staff' && !isDecline(raw)) {
    const parsed = parseStaffAnswer(raw);
    const named = /\bansatt|teamet\b/.test(folded);
    const rich = (parsed.people || []).some((person) => person.email || person.phone);
    if (parsed.action === 'save' && (named || ((step === 'done' || step === 'products') && rich && named))) {
      return { kind: 'staff', parsed };
    }
    if (parsed.action === 'save' && step === 'done' && rich) return { kind: 'staff', parsed };
  }
  if (step !== 'affiliations' && !/\d+\s*(?:kr|,-|nok)\b/i.test(raw)) {
    const parsed = parseAffiliationsAnswer(raw);
    if (parsed.action === 'save' && /\bpartner|sponsor|affiliasjon/.test(folded)) {
      return { kind: 'affiliations', parsed };
    }
  }
  return null;
}

export function isDecline(text = '') {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  if (/https?:/.test(t) || /\s[a-z0-9-]+\.[a-z]{2,}(?:\/|\s|$)/.test(t)) return false;
  return /^(nei|nope|ingen|hopp over|hopp|skip|ikke relevant|ikke aktuelt|ikke na|har ikke|har ingen|vi har ikke|det har vi ikke|trenger ikke|ikke noe)\b/.test(t);
}

/** A plan step skips only when the whole answer is a short skip, not a sentence that starts with one. */
export function isPlanSkip(text = '') {
  const t = fold(text).replace(/[.!]+$/g, '').trim();
  return /^(nei|ingen|hopp over|ikke relevant|har ikke|trenger ikke)(?: takk)?$/.test(t);
}

/** Which shop part a revisit names, or ''. */
export function shopPartNamed(text = '') {
  const t = fold(text);
  if (/\b(selger\w*|mva|organisasjonsnummer\w*|orgnr)\b/.test(t)) return 'seller';
  if (/\b(retur\w*|returns|angrerett\w*)\b/.test(t)) return 'returns';
  if (/\b(frakt\w*|shipping|forsendelse\w*)\b/.test(t)) return 'shipping';
  return '';
}

/** A decline written as a sentence, with nothing the client wants saved. */
function declineWithoutContent(text = '') {
  const lead = /^(?:(?:vi|jeg|det)\s+(?:har|trenger|onsker)\s+(?:ikke|ingen)\b|(?:har|trenger)\s+ikke\b)/;
  const t = fold(text).trim();
  const stripped = t.replace(/^(?:nei|nope)\b[\s,.;:!-]*/, '');
  if (stripped !== t) return !stripped || isDecline(stripped) || lead.test(stripped);
  return isDecline(t) || lead.test(t);
}

/** skip, unclear or '' for the search word, area and booking questions. */
function planGuard(text = '') {
  if (isPlanSkip(text)) return 'skip';
  if (shopNonAnswer(text)) return 'unclear';
  if (declineWithoutContent(text)) return 'skip';
  return '';
}

function shopNonAnswer(text = '') {
  const t = fold(text).replace(/[.!]+$/g, '').trim();
  if (/^(vet ikke|usikker|ikke sikker|aner ikke)(?: takk)?$/.test(t)) return true;
  if (isPlanSkip(text) || isDecline(text)) return false;
  return isNoMore(text);
}

export function isAffirmativeOnly(text = '') {
  return /^(ja|yes|jepp|gjerne|ok|okay|klart|selvsagt|absolutt)(?:\s+takk|\s+gjerne)?[.!]?\s*$/i.test(compact(text));
}

export function isNoMore(text = '') {
  if (isDecline(text)) return true;
  const t = fold(text);
  if (!t || t.length > 140) return false;
  return /^(det er alt|det var alt|det holder|ikke mer|ingen mer|ferdig|nok|det var det|det er nok|alle er med|det er de|det er dem|ikke flere|ingen flere|det er alle|bare det|kun det|det var alle)\b/.test(t);
}

function productCount(bank = {}) {
  let count = 0;
  for (const catalog of bank.productCatalogs || []) {
    for (const category of catalog.categories || []) {
      count += (category.products || []).filter((row) => compact(row?.title || row?.name)).length;
    }
  }
  return count;
}

export function mediaFileCount(bank = {}) {
  const media = bank.media || {};
  const keys = [
    'mainHeroImages', 'galleryImages', 'logos', 'icons', 'uncategorized',
    'teamImages', 'aboutImages', 'locationImages', 'illustrationImages', 'offeringImages',
  ];
  return keys.reduce((sum, key) => sum + (Array.isArray(media[key]) ? media[key].filter(Boolean).length : 0), 0);
}

export function hasLogo(bank = {}) {
  return Boolean(compact(bank?.brandIdentity?.logos?.normal) || (bank?.media?.logos || []).some(Boolean));
}

export function hasListedTeam(bank = {}) {
  return (bank.staff || []).some((row) => {
    if (compact(row?.id) === SIGNER_STAFF_ID) return false;
    return Boolean(compact(row?.name) || compact(row?.title));
  });
}

export function hoursLookCustom(bank = {}) {
  const status = compact(bank?.openingHours?.status);
  if (status === 'set' || status === 'always' || status === 'not-relevant') return true;
  const days = Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : [];
  if (days.length !== DEFAULT_HOURS.length) return false;
  return days.some((day, index) => {
    const base = DEFAULT_HOURS[index];
    return compact(day?.opensAt) !== base.opensAt
      || compact(day?.closesAt) !== base.closesAt
      || Boolean(day?.closed) !== base.closed;
  });
}

export function hasAffiliations(bank = {}) {
  return (bank.affiliations || []).some((category) => (
    (category?.items || []).some((item) => compact(item?.title) || compact(item?.description))
  ));
}

function flagged(bank, key) {
  const value = compact(bank?.assistantIntake?.[key]);
  return value === 'done' || value === 'skipped';
}

function planStepsOf(ctx) {
  if (!ctx || !Array.isArray(ctx.steps) || !ctx.steps.length) return [];
  return ctx.steps.filter((step) => PLAN_STEPS.includes(step));
}

function keywordPhrases(bank = {}) {
  const list = Array.isArray(bank?.websiteCreatorQuestions?.importantKeywords)
    ? bank.websiteCreatorQuestions.importantKeywords
    : [];
  return list.map((entry) => compact(entry?.phrase ?? entry)).filter(Boolean);
}

function bookingServices(bank = {}) {
  const list = Array.isArray(bank?.shopSetup?.bookingServices) ? bank.shopSetup.bookingServices : [];
  return list.filter((row) => compact(row?.name));
}

function knownSeller(bank = {}, ctx) {
  const org = compact(bank?.brandIdentity?.orgNumber)
    || compact(bank?.shopSetup?.sellerVat?.orgNumber)
    || compact(ctx?.seller?.orgNumber);
  const legal = compact(bank?.shopSetup?.sellerVat?.legalName) || compact(ctx?.seller?.legalName);
  return Boolean(org && legal);
}

function keywordsKnown(bank = {}, ctx) {
  return keywordPhrases(bank).length > 0 || Number(ctx?.approvedKeywords) > 0;
}

function areaKnown(bank = {}, ctx) {
  return Boolean(compact(bank?.websiteCreatorQuestions?.town) || compact(ctx?.city));
}

/** Every missing part of a plan step, in question order. */
export function planMissingParts(step, bank = {}, ctx) {
  if (step === 'shop') {
    const parts = [];
    if (!compact(bank?.shopSetup?.shipping)) parts.push('shipping');
    if (!compact(bank?.shopSetup?.returns)) parts.push('returns');
    if (!knownSeller(bank, ctx)) parts.push('seller');
    return parts;
  }
  if (step === 'keywords') {
    const parts = [];
    if (!keywordsKnown(bank, ctx)) parts.push('keywords');
    if (ctx?.needsArea && !areaKnown(bank, ctx)) parts.push('area');
    return parts;
  }
  if (step === 'booking') return bookingServices(bank).length ? [] : ['services'];
  return [];
}

/** The first missing part of a plan step, or ''. */
export function planSubStep(step, bank = {}, ctx) {
  return planMissingParts(step, bank, ctx)[0] || '';
}

/** True when a plan step has nothing left to ask. */
export function planStepComplete(step, bank = {}, ctx) {
  return PLAN_STEPS.includes(step) && planMissingParts(step, bank, ctx).length === 0;
}

export function nextIntakeStep(bank = {}, ctx) {
  const focus = compact(bank?.assistantIntake?.focus);
  const steps = planStepsOf(ctx);
  if (INTAKE_STEPS.includes(focus)) return focus;
  if (steps.includes(focus)) return focus;
  if ((awaitingMore(bank, 'products') && productCount(bank) > 0) || (!productCount(bank) && !flagged(bank, 'products'))) return 'products';
  if ((awaitingMore(bank, 'media') && mediaFileCount(bank) > 0) || (!mediaFileCount(bank) && !flagged(bank, 'media'))) return 'media';
  if (!hasLogo(bank) && !flagged(bank, 'logo')) return 'logo';
  if ((awaitingMore(bank, 'staff') && hasListedTeam(bank)) || (!hasListedTeam(bank) && !flagged(bank, 'staff'))) return 'staff';
  if (!hoursLookCustom(bank) && !flagged(bank, 'hours')) return 'hours';
  if ((awaitingMore(bank, 'affiliations') && hasAffiliations(bank)) || (!hasAffiliations(bank) && !flagged(bank, 'affiliations'))) return 'affiliations';
  for (const step of steps) {
    if (!planStepComplete(step, bank, ctx) && !flagged(bank, step)) return step;
  }
  return 'done';
}

function padTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute || '00').padStart(2, '0')}`;
}

function dayIndexesIn(clause = '') {
  const text = fold(clause);
  const found = [];
  WEEK.forEach((day, index) => {
    if (day.keys.some((key) => new RegExp(`(?:^|[^a-z])${key}(?:[^a-z]|$)`).test(text))) found.push(index);
  });
  if (found.length >= 2 && /til|-/.test(text)) {
    const start = Math.min(...found);
    const end = Math.max(...found);
    const span = [];
    for (let index = start; index <= end; index += 1) span.push(index);
    return span;
  }
  return found;
}

export function alwaysOpenDays() {
  return WEEK.map((day) => ({ day: day.day, opensAt: '00:00', closesAt: '23:59', closed: false }));
}

export function closedWeek() {
  return WEEK.map((day) => ({ day: day.day, opensAt: '', closesAt: '', closed: true }));
}

export function parseOpeningHoursAnswer(text = '') {
  const raw = compact(text);
  const folded = fold(raw);
  if (!raw) return { action: 'unclear' };
  if (/24\s*\/\s*7|dognapent|apen hele dognet|apen hele tiden|apent hele tiden|apne hele tiden|alltid apent|apent hele dogn/.test(folded)) {
    return { action: 'always', days: alwaysOpenDays(), status: 'always' };
  }
  if (isDecline(raw) || (/ikke relevant|ikke aktuelt|ingen apning|ingen faste|kun etter avtale|timebestilling/.test(folded) && !/\d{1,2}\s*[-–]\s*\d{1,2}/.test(raw))) {
    return { action: 'not-relevant', days: closedWeek(), status: 'not-relevant' };
  }
  const days = WEEK.map((day) => ({ day: day.day, opensAt: '', closesAt: '', closed: true }));
  const clauses = raw.split(/\n|[,;]|(?=\bog\b)/i).map((part) => compact(part)).filter(Boolean);
  const touched = new Set();
  for (const clause of clauses.length ? clauses : [raw]) {
    const indexes = dayIndexesIn(clause);
    const closed = /stengt|closed|lukket/i.test(clause);
    const range = clause.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|til)\s*(\d{1,2})(?:[:.](\d{2}))?/);
    const targets = indexes.length ? indexes : (range ? days.map((_, index) => index) : []);
    if (!targets.length) continue;
    for (const index of targets) {
      touched.add(index);
      if (closed && !range) {
        days[index] = { ...days[index], opensAt: '', closesAt: '', closed: true };
      } else if (range) {
        days[index] = {
          ...days[index],
          opensAt: padTime(range[1], range[2]),
          closesAt: padTime(range[3], range[4]),
          closed: false,
        };
      }
    }
  }
  if (!touched.size) return { action: 'unclear' };
  return { action: 'set', days, status: 'set', touched: [...touched].sort((a, b) => a - b) };
}

function emailIn(text = '') {
  return (String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || '';
}

function phoneIn(text = '') {
  const match = String(text).match(/(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){7,11}\d/);
  return compact(match?.[0] || '');
}

export function parseStaffAnswer(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'unclear', people: [] };
  if (isDecline(raw)) return { action: 'skip', people: [] };
  if (isAffirmativeOnly(raw)) return { action: 'details', people: [] };
  const people = [];
  for (const line of raw.split(/\n+/)) {
    const email = emailIn(line);
    const phone = phoneIn(line.replace(email, ' '));
    const rest = compact(line.replace(email, ' ').replace(phone, ' '));
    const parts = rest.split(/[,|–—]/).map((part) => compact(part)).filter(Boolean);
    const name = parts[0] || '';
    const title = parts[1] || '';
    if (!name || name.length < 2) continue;
    if (/^(ja|yes|ansatte|team)$/i.test(name) && !title && !email && !phone) continue;
    people.push({ name, title, phone, email: email.toLowerCase() });
  }
  if (!people.length) return { action: 'unclear', people: [] };
  return { action: 'save', people };
}

function splitNames(text = '') {
  return String(text || '')
    .split(/,|\/|&|\bog\b/i)
    .map((part) => compact(part))
    .filter((part) => part.length > 1 && !/^(ja|nei|partnere|partnere:|affiliasjoner)$/i.test(part));
}

export function parseAffiliationsAnswer(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'unclear', categories: [] };
  if (isDecline(raw)) return { action: 'skip', categories: [] };
  if (isAffirmativeOnly(raw)) return { action: 'details', categories: [] };
  const categories = [];
  let current = { categoryName: 'Partnere', items: [] };
  for (const line of raw.split(/\n+/)) {
    const labeled = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (labeled) {
      if (current.items.length) categories.push(current);
      current = { categoryName: compact(labeled[1]), items: splitNames(labeled[2]).map((title) => ({ title })) };
      continue;
    }
    current.items.push(...splitNames(line).map((title) => ({ title })));
  }
  if (current.items.length) categories.push(current);
  const usable = categories.filter((category) => category.items.length);
  if (!usable.length) return { action: 'unclear', categories: [] };
  return { action: 'save', categories: usable };
}

function orgNumberIn(text = '') {
  const match = String(text).match(/(?:^|\D)(\d{3})\s?(\d{3})\s?(\d{3})(?!\d)/);
  return match ? `${match[1]}${match[2]}${match[3]}` : '';
}

function vatFlag(text = '') {
  const folded = fold(text);
  if (/ikke\s+mva-registrert|ikke\s+mva|ikke\s+registrert/.test(folded)) return false;
  if (/mva-registrert|\bja\b/.test(folded)) return true;
  return null;
}

function sellerFrom(text = '') {
  const orgNumber = orgNumberIn(text);
  const vatRegistered = vatFlag(text);
  let rest = String(text);
  if (orgNumber) {
    rest = rest.replace(new RegExp(`${orgNumber.slice(0, 3)}\\s?${orgNumber.slice(3, 6)}\\s?${orgNumber.slice(6)}`), ' ');
  }
  rest = rest.replace(/ikke\s+mva-registrert|ikke\s+mva|ikke\s+registrert|mva-registrert|\bmva\b|\bja\b/gi, ' ');
  rest = compact(rest.replace(/[,.;:–\-]+/g, ' ')).replace(/^(?:nei|ingen|nope)(?:\s+|$)/i, '');
  if (rest && rest.split(' ').every((word) => /^(?:vi|jeg|er|har|og|men|ikke|nei|ingen|nope)$/i.test(word))) rest = '';
  const legalName = /[a-zæøå]/i.test(rest) ? rest.slice(0, 200) : '';
  return { orgNumber, legalName, vatRegistered };
}

/**
 * Shipping, returns or seller text from one answer.
 * @returns {{ action: 'skip' | 'save' | 'unclear', value: string | { orgNumber: string, legalName: string, vatRegistered: boolean | null } }}
 */
export function parseShopAnswer(text = '', subStep = '') {
  if (isPlanSkip(text)) return { action: 'skip', value: '' };
  if (shopNonAnswer(text)) return { action: 'unclear', value: '' };
  if (subStep === 'seller') {
    const value = sellerFrom(text);
    if (!value.orgNumber && !value.legalName && value.vatRegistered !== false) return { action: 'unclear', value };
    return { action: 'save', value };
  }
  const value = compact(text).slice(0, 600);
  if ((subStep === 'shipping' || subStep === 'returns') && value.length >= 3) return { action: 'save', value };
  return { action: 'unclear', value: '' };
}

function keywordChunks(text = '') {
  return String(text)
    .split(/\n|,|;/)
    .map((part) => part.replace(/^[\s"'“”«».,;:!?()[\]-]+|[\s"'“”«».,;:!?()[\]-]+$/g, ''))
    .map((part) => normalizeSeoPhrase(part))
    .filter(Boolean);
}

/**
 * Up to three search phrases. A prescription-only substance is listed in `dropped` and not kept.
 * @returns {{ action: 'skip' | 'save' | 'unclear', phrases: string[], dropped: string[] }}
 */
export function parseKeywordAnswer(text = '') {
  const guard = planGuard(text);
  if (guard) return { action: guard, phrases: [], dropped: [] };
  text = String(text).replace(/^\s*(?:nei|nope)\b[\s,.;:!-]*/i, '');
  if (isAffirmativeOnly(text)) return { action: 'unclear', phrases: [], dropped: [] };
  const phrases = [];
  const dropped = [];
  const seen = new Set();
  for (const phrase of keywordChunks(text)) {
    if (seoPhraseWordCount(phrase) < 1 || seoPhraseWordCount(phrase) > 6) continue;
    if (isRegulatedPhrase(phrase)) {
      dropped.push(phrase);
      continue;
    }
    const key = seoPhraseKey(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (phrases.length >= 3) continue;
    phrases.push(phrase);
  }
  if (!phrases.length) return { action: 'unclear', phrases, dropped };
  return { action: 'save', phrases, dropped };
}

/** A town or area, at most 80 characters. */
export function parseAreaAnswer(text = '') {
  const guard = planGuard(text);
  if (guard) return { action: guard, value: '' };
  if (isAffirmativeOnly(text)) return { action: 'unclear', value: '' };
  const value = compact(text).slice(0, 80);
  if (value.length < 2) return { action: 'unclear', value: '' };
  return { action: 'save', value };
}

const BOOKING_DURATION = /\b\d+(?:[.,]\d+)?\s*(?:minutter|min|timer|time|t)\b/i;
const BOOKING_PRICE = /\b(?:\d[\d\s.]*(?:[.,]\d+)?\s*(?:kr|nok)|\d[\d\s.]*(?:[.,]\d+)?\s*,-|nok\s*\d[\d\s.]*|kr\s*\d[\d\s.]*)\b/i;

function pullToken(pattern, text) {
  const match = String(text).match(pattern);
  if (!match) return { found: '', rest: compact(text) };
  return { found: compact(match[0]), rest: compact(String(text).replace(match[0], ' ')) };
}

function bookingChunk(chunk = '') {
  const text = compact(chunk);
  if (!text) return null;
  let duration = '';
  let price = '';
  const names = [];
  const fields = text.includes(',') ? text.split(',').map((part) => compact(part)).filter(Boolean) : [text];
  if (fields.length > 1) {
    for (const part of fields) {
      if (!duration && BOOKING_DURATION.test(part)) {
        duration = pullToken(BOOKING_DURATION, part).found;
        const rest = pullToken(BOOKING_DURATION, part).rest;
        if (rest) names.push(rest);
        continue;
      }
      if (!price && (BOOKING_PRICE.test(part) || /^\d+(?:[.,]\d+)?$/.test(part))) {
        price = /^\d+(?:[.,]\d+)?$/.test(part) ? part : pullToken(BOOKING_PRICE, part).found;
        const rest = pullToken(BOOKING_PRICE, part).rest.replace(/^\d+(?:[.,]\d+)?$/, '');
        if (compact(rest)) names.push(compact(rest));
        continue;
      }
      names.push(part);
    }
  } else {
    const durationPull = pullToken(BOOKING_DURATION, text);
    const pricePull = pullToken(BOOKING_PRICE, durationPull.rest);
    duration = durationPull.found;
    price = pricePull.found;
    if (pricePull.rest) names.push(pricePull.rest);
  }
  const name = compact(names.join(' ')).replace(/^[,.;:–\-]+|[,.;:–\-]+$/g, '');
  if (!name || isAffirmativeOnly(name)) return null;
  return { name: name.slice(0, 120), duration: duration.slice(0, 40), price: price.slice(0, 40) };
}

/**
 * Bookable services, one per line or separated by `;`.
 * @returns {{ action: 'skip' | 'save' | 'unclear', services: Array<{ name: string, duration: string, price: string }> }}
 */
export function parseBookingAnswer(text = '') {
  const guard = planGuard(text);
  if (guard) return { action: guard, services: [] };
  if (isAffirmativeOnly(text)) return { action: 'unclear', services: [] };
  const services = String(text)
    .split(/\n|;/)
    .map((chunk) => bookingChunk(chunk))
    .filter(Boolean);
  if (!services.length) return { action: 'unclear', services: [] };
  return { action: 'save', services };
}

const MEDIA_GROUP_LABELS = [
  ['mainHeroImages', 'Hovedbilde'],
  ['aboutImages', 'Om oss'],
  ['teamImages', 'Ansatte'],
  ['locationImages', 'Lokasjon'],
  ['logos', 'Logo'],
  ['icons', 'Ikoner'],
  ['illustrationImages', 'Illustrasjoner'],
  ['offeringImages', 'Tjenester / meny'],
  ['galleryImages', 'Bildegalleri'],
  ['uncategorized', 'Annet'],
];

function mediaGroups(bank = {}) {
  const media = bank.media || {};
  return MEDIA_GROUP_LABELS.map(([key, label]) => ({
    key,
    label,
    urls: (Array.isArray(media[key]) ? media[key] : []).map((url) => compact(url)).filter(Boolean),
  })).filter((group) => group.urls.length);
}

function listedPeople(bank = {}) {
  return (bank.staff || []).filter((row) => {
    if (compact(row?.id) === SIGNER_STAFF_ID) return false;
    return Boolean(compact(row?.name) || compact(row?.title));
  }).map((row) => ({
    name: compact(row?.name),
    title: compact(row?.title),
    imageUrl: compact(row?.imageUrl),
  }));
}

function hoursReview(bank = {}) {
  const status = compact(bank?.openingHours?.status);
  if (status === 'not-relevant') return { filled: true, summary: 'Ikke relevant', lines: ['Ikke relevant'] };
  if (status === 'always') return { filled: true, summary: 'Døgnåpent', lines: ['Døgnåpent'] };
  if (!hoursLookCustom(bank)) return { filled: false, summary: '', lines: [] };
  const lines = (Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : []).map((day) => {
    const name = compact(day?.day);
    if (!name) return '';
    if (day?.closed) return `${name}: stengt`;
    const opens = compact(day?.opensAt);
    const closes = compact(day?.closesAt);
    return closes ? `${name}: ${opens}–${closes}` : `${name}: ${opens}`;
  }).filter(Boolean);
  return { filled: true, summary: lines[0] || 'Satt', lines };
}

function partnerGroups(bank = {}) {
  return (bank.affiliations || []).map((category) => ({
    label: compact(category?.categoryName) || 'Partnere',
    items: (category?.items || []).map((item) => compact(item?.title)).filter(Boolean),
  })).filter((group) => group.items.length);
}

function planLines(step, bank = {}, ctx) {
  if (step === 'shop') {
    const lines = [];
    const shipping = compact(bank?.shopSetup?.shipping);
    const returns = compact(bank?.shopSetup?.returns);
    if (shipping) lines.push(`Frakt: ${shipping}`);
    if (returns) lines.push(`Retur: ${returns}`);
    const legal = compact(bank?.shopSetup?.sellerVat?.legalName) || compact(ctx?.seller?.legalName);
    const org = compact(bank?.shopSetup?.sellerVat?.orgNumber)
      || compact(bank?.brandIdentity?.orgNumber)
      || compact(ctx?.seller?.orgNumber);
    if (legal || org) lines.push(`Selger: ${[legal, org].filter(Boolean).join(', ')}`);
    return lines;
  }
  if (step === 'keywords') {
    const lines = [];
    const phrases = keywordPhrases(bank);
    if (phrases.length) lines.push(`Søkeord: ${phrases.join(', ')}`);
    const area = compact(bank?.websiteCreatorQuestions?.town) || compact(ctx?.city);
    if (area) lines.push(`Område: ${area}`);
    return lines;
  }
  if (step === 'booking') {
    return bookingServices(bank).map((row) => [compact(row.name), compact(row.duration), compact(row.price)].filter(Boolean).join(' – '));
  }
  return [];
}

export function intakeReview(bank = {}, ctx) {
  const groups = mediaGroups(bank);
  const mediaCount = groups.reduce((sum, group) => sum + group.urls.length, 0);
  const logo = compact(bank?.brandIdentity?.logos?.normal) || (bank?.media?.logos || []).map((url) => compact(url)).find(Boolean) || '';
  const people = listedPeople(bank);
  const hours = hoursReview(bank);
  const partners = partnerGroups(bank);
  const count = productCount(bank);
  const steps = planStepsOf(ctx);
  const current = steps.length ? nextIntakeStep(bank, ctx) : nextIntakeStep(bank);
  const rows = [
    {
      step: 'products',
      filled: count > 0,
      summary: count ? `${count} ${count === 1 ? 'produkt' : 'produkter'}` : '',
    },
    {
      step: 'media',
      filled: mediaCount > 0,
      summary: mediaCount ? `${mediaCount} ${mediaCount === 1 ? 'fil' : 'filer'}` : '',
      groups,
    },
    {
      step: 'logo',
      filled: Boolean(logo),
      summary: logo ? 'Logo lagret' : '',
      url: logo,
    },
    {
      step: 'staff',
      filled: people.length > 0,
      summary: people.length ? `${people.length} ${people.length === 1 ? 'person' : 'personer'}` : '',
      people,
    },
    {
      step: 'hours',
      filled: hours.filled,
      summary: hours.summary,
      lines: hours.lines,
    },
    {
      step: 'affiliations',
      filled: partners.some((group) => group.items.length),
      summary: partners.length
        ? `${partners.reduce((sum, group) => sum + group.items.length, 0)} partnere`
        : '',
      groups: partners,
    },
  ];
  for (const step of steps) {
    const lines = planLines(step, bank, ctx);
    rows.push({
      step,
      filled: planStepComplete(step, bank, ctx),
      summary: lines[0] || '',
      lines,
    });
  }
  return {
    current,
    steps: rows.map((row) => ({
      ...row,
      label: STEP_LABELS[row.step],
      status: row.filled
        ? 'filled'
        : (flagged(bank, row.step) ? 'skipped' : (current === row.step ? 'current' : 'waiting')),
    })),
  };
}

export function withIntakeFlag(bank = {}, key, value) {
  return {
    ...bank,
    assistantIntake: {
      ...(bank.assistantIntake || {}),
      [key]: value,
    },
  };
}

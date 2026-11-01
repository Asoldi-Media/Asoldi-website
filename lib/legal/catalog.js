/**
 * The legal clause catalog: one versioned source for Asoldi's terms (Vilkår), the privacy policy
 * (Personvern), the data processing agreement and its appendix (Databehandleravtale), the contract
 * lines per plan, the offer-letter product lines and the sales page's "what's included" copy.
 *
 * A clause is { id, version, kind, section, docs, covers, nb, en? }:
 *   - kind: 'service' (a sellable or included service), 'addon' (one-time add-on), 'general'
 *     (applies to every plan, or to one billing kind), 'privacy' or 'dpa'.
 *   - docs: where it renders: 'terms', 'contract', 'sales', 'privacy', 'dpa'.
 *   - covers: what it describes: services, features (feature registry keys; '.*' and '.**' patterns
 *     are expanded against data/cms-feature-tree.json), addOns, cancellation (effects and 'grace')
 *     and billing ('month', 'once').
 *   - nb (Norwegian, required) and en (English, contract and sales lines only): { title, terms[],
 *     contract[], sales[] }. Texts may hold {placeholders} that legalParams() fills.
 *
 * Coverage is generated: requiredCoverage() lists every service id, entitled feature key, one-time
 * add-on and cancellation effect from the shared vocabulary (SERVICE_CATALOG, TIER_MATRIX,
 * ONE_TIME_ADDON_CATALOG, CANCELLATION_*) and the feature tree, and coverageGaps() names each one
 * that has no contract clause or no terms clause. scripts/legal-catalog.test.mjs fails on a gap.
 *
 * Versioning: every change to a clause text, to the subprocessor register or to the rendered
 * documents bumps CATALOG_VERSION (and DPA_VERSION in lib/legal/dpa.js when the DPA changes);
 * node scripts/legal-render.mjs --write then archives the new version in lib/legal/archive/.
 * Signed contracts keep the version they were signed under.
 *
 * Asoldi's own terms are between businesses. Clauses about what a client's site says to its own
 * consumers (shop terms, bookings, legal pages) are marked consumerFacing and follow
 * Forbrukertilsynet's standard terms.
 *
 * Pure apart from reading the feature tree once (through lib/cms-features.js).
 */
import {
  CANCELLATION_EFFECTS,
  CANCELLATION_GRACE_DAYS,
  CHANGES_PER_MONTH,
  ONE_TIME_ADDON_IDS,
  SERVICE_CATALOG,
  SERVICE_IDS,
  TIER_MATRIX,
  canonicalFeatureKey,
} from '../../packages/suite/core/delivery/vocab.js';
import { BUNDLES, FEATURE_NODES } from '../cms-features.js';

export const CATALOG_VERSION = 1;
export const CATALOG_DATE = '2026-11-01';
// The data processing agreement's own version. It changes only when the DPA text or its appendix
// (sub-processors, AI providers) changes; offers carry it as dpaVersion (lib/legal/dpa.js).
export const DPA_VERSION = 'dpa-1';

export const LEGAL_DOCS = Object.freeze(['terms', 'contract', 'sales', 'privacy', 'dpa']);
export const CLAUSE_KINDS = Object.freeze(['service', 'addon', 'general', 'privacy', 'dpa']);

/** The cancellation item for the hosting grace period (not an effect id in the vocabulary). */
export const CANCELLATION_GRACE = 'grace';

const BOTH = ['terms', 'contract'];
const SOLD = ['terms', 'contract', 'sales'];

// ---------------------------------------------------------------- clauses

const DECLARED = [
  // ---------------------------------------------------------------- general: terms only
  {
    id: 'general.about', version: 1, kind: 'general', section: 'about', docs: ['terms'],
    nb: {
      title: 'Om vilkårene',
      terms: [
        'Disse vilkårene gjelder tjenestene Asoldi Markedsføring (drevet under foretaket CHAPANA, org.nr. 934 327 497) («Asoldi», «vi») leverer til næringsdrivende kunder, og bruk av asoldi.com og kundeportalen.',
        'Avtalen er en avtale mellom næringsdrivende. Forbrukerkjøpsloven og angrerettloven gjelder ikke mellom Asoldi og kunden.',
        'En signert tjenesteavtale viser partene, valgt omfang og pris. Den viser til disse vilkårene, personvernerklæringen og databehandleravtalen. Ved motstrid går den signerte avtalens konkrete vilkår (parter, pris, omfang, frister, ansvarstak, eierskap og avslutning) foran.',
        'Vilkårene har et versjonsnummer. Kunden er bundet av versjonen som gjaldt da tjenesteavtalen ble signert, til kunden har fått skriftlig varsel om en ny versjon. Kundeportalen viser hvilken versjon som gjelder for kunden.',
      ],
    },
  },
  {
    id: 'general.account', version: 1, kind: 'general', section: 'account', docs: ['terms'],
    nb: {
      title: 'Bruk av nettstedet og kontoen',
      terms: [
        'Kunden er ansvarlig for at opplysningene kunden gir, er riktige og oppdaterte.',
        'Kunden holder innloggingene til kundeportalen og CMS hemmelige og er ansvarlig for aktivitet på egne kontoer.',
        'Nettstedet og tjenestene skal ikke misbrukes, og kunden skal ikke forsøke å skaffe seg tilgang kunden ikke har fått.',
        'Den som inngår avtalen for en virksomhet, bekrefter å ha fullmakt til det. Uten slik fullmakt er avtalen ugyldig.',
      ],
    },
  },

  // ---------------------------------------------------------------- services
  {
    id: 'service.site', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: {
      services: ['site'],
      features: ['users', 'users.*', 'site', 'site.*', 'forms', 'forms.wizard', 'content', 'content.*', 'social', 'social.profiles', 'shop', 'shop.catalog', 'seo', 'seo.keywords', 'seo.onPage', 'seo.contentHead', 'seo.sitemap', 'integrations', 'integrations.scripts'],
    },
    nb: {
      title: 'Nettside og CMS',
      terms: [
        'Asoldi designer og utvikler nettsiden med det antallet hovedsider som er avtalt, med oppsett som fungerer på mobil, nettbrett og PC. Nettsiden har nettstedskart og kobles til kundens domene.',
        'Kunden får Asoldi CMS med egne brukere og roller, redigering av sider, mediebibliotek, egne felt og innholdstyper som Asoldi setter opp.',
        'Nettsiden har kontaktskjema som leverer meldinger til innboksen i CMS. En valgfri veiviser kan lede besøkende fram til skjemaet.',
        'Nettsiden har juridiske sider (salgsbetingelser, personvern og informasjonskapsler) og en samtykkeløsning, slik at sporing først starter når den besøkende samtykker. Kunden kan legge inn egne skript for statistikk og annonser, for eksempel Google Analytics og Meta Pixel. De kjøres bare etter samtykke.',
        'Grunnleggende søkemotortilpasning inngår: en enkel søkeordsplan, tittel og beskrivelse per side, god struktur og nettstedskart. Løpende SEO-arbeid er en egen tjeneste.',
        'Kunden kan vise produkter eller tjenester i en enkel katalog uten kasse og lenke til egne profiler i sosiale medier.',
      ],
      contract: [
        'Design og utvikling av nettsiden, inntil {pages} hovedsider, med oppsett for mobil, nettbrett og PC, nettstedskart og kobling til kundens domene',
        'Asoldi CMS med egne brukere og roller, mediebibliotek og redigering av sider og innhold',
        'Kontaktskjema, juridiske sider og samtykkeløsning for informasjonskapsler',
        'Grunnleggende søkemotortilpasning: søkeordsplan, titler, beskrivelser, struktur og nettstedskart',
      ],
      sales: ['Full nettsideutvikling', 'Asoldi CMS med egne brukere', 'Kontaktskjema og juridiske sider', 'Grunnleggende SEO og sitemap'],
    },
    en: {
      title: 'Website and CMS',
      contract: [
        'Design and development of the website, up to {pages} main pages, with a layout for mobile, tablet and desktop, a sitemap and connection to the Client\'s domain',
        'Asoldi CMS with the Client\'s own users and roles, a media library and editing of pages and content',
        'Contact form, legal pages and a cookie consent solution',
        'Basic search engine setup: keyword plan, titles, descriptions, structure and sitemap',
      ],
      sales: ['Full website development', 'Asoldi CMS with your own users', 'Contact form and legal pages', 'Basic SEO and sitemap'],
    },
  },
  {
    id: 'service.hosting', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['site'] },
    nb: {
      title: 'Hosting, domene og vedlikehold',
      terms: [
        'Asoldi drifter nettsiden og CMS på Asoldis hostingnettverk hos Hostinger så lenge abonnementet løper. Hosting inngår i månedsprisen.',
        'Kunden eier og betaler sitt eget domene. Asoldi kobler domenet til hostingen. Har kunden ikke et domene, kjøper kunden det selv hos en domeneregistrar.',
        'Vedlikehold omfatter sikkerhetsoppdateringer, sikkerhetskopier, feilretting og nye versjoner av Asoldi CMS. Planlagt vedlikehold og feil hos underleverandører kan gi korte avbrudd.',
        'Ett veiledningsmøte om bruk av CMS inngår og holdes én gang. Når nettbutikk inngår, dekker møtet også produkter, kunder og betalingsløsning.',
      ],
      contract: [
        'Hosting og drift hos Hostinger så lenge abonnementet er aktivt',
        'Domenekobling: kunden eier og betaler domenet, og Asoldi kobler det til hostingen',
        'Vedlikehold: sikkerhet, sikkerhetskopier, feilretting og nye versjoner av Asoldi CMS',
        'Ett veiledningsmøte om bruk av CMS, holdt én gang',
      ],
      sales: ['Hosting og vedlikehold', 'Koble til eget domene', 'Innledende veiledningsmøte'],
    },
    en: {
      title: 'Hosting, domain and maintenance',
      contract: [
        'Hosting and operation at Hostinger while the subscription is active',
        'Domain connection: the Client owns and pays for the domain, and Asoldi connects it to the hosting',
        'Maintenance: security, backups, bug fixes and new versions of the Asoldi CMS',
        'One guidance meeting on using the CMS, held once',
      ],
      sales: ['Hosting and maintenance', 'Connect your own domain', 'Onboarding meeting'],
    },
  },
  {
    id: 'service.changes', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['changes'], features: ['changeRequests'] },
    nb: {
      title: 'Endringer',
      terms: [
        'Kunden sender endringsønsker fra CMS. Inntil {changesPerMonth} endringer per måned inngår.',
        'Én godtatt forespørsel er én endring. Endringer i tekst, bilder og priser, og å legge til, flytte eller fjerne en seksjon, er tillatt. En ny side, en større ombygging eller ny funksjonalitet avtales særskilt.',
        'Asoldi utfører en godtatt endring innen {slaWorkDays} arbeidsdager. Asoldi teller endringene og varsler når kvoten for måneden er brukt opp. Ubrukte endringer overføres ikke til neste måned.',
        'Retting av skrivefeil og faktiske feil Asoldi har gjort, regnes ikke som en endring.',
      ],
      contract: [
        'Inntil {changesPerMonth} endringer per måned. Én godtatt forespørsel er én endring, og endringer i seksjoner er tillatt',
        'Godtatte endringer utføres innen {slaWorkDays} arbeidsdager',
      ],
      sales: ['Opptil {changesPerMonth} endringer/mnd'],
    },
    en: {
      title: 'Changes',
      contract: [
        'Up to {changesPerMonth} changes per month. One accepted request is one change, and changes to sections are allowed',
        'Accepted changes are made within {slaWorkDays} working days',
      ],
      sales: ['Up to {changesPerMonth} changes/month'],
    },
  },
  {
    id: 'service.unlimited', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['unlimited'] },
    nb: {
      title: 'Ubegrensede endringer',
      terms: [
        'Med ubegrensede endringer gjelder ingen månedlig grense for endringsforespørsler. Hver forespørsel må være rimelig i omfang. En ny side eller en større ombygging avtales fortsatt særskilt.',
      ],
      contract: ['Ubegrensede endringer: ingen månedlig grense for rimelige endringsforespørsler'],
      sales: ['Ubegrensede endringer'],
    },
    en: {
      title: 'Unlimited changes',
      contract: ['Unlimited changes: no monthly limit on reasonable change requests'],
      sales: ['Unlimited changes'],
    },
  },
  {
    id: 'service.blog', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['blog'], features: ['blog', 'blog.posts'] },
    nb: {
      title: 'Blogg',
      terms: [
        'Alle nivåer har blogg på nettsiden. Kunden skriver og publiserer egne innlegg i CMS. Innleggene vises i bloggoversikten og på egne innleggssider.',
        'Til kunden har publisert sitt første innlegg, kan bloggseksjonen være skjult.',
      ],
      contract: ['Blogg på nettsiden: kunden skriver og publiserer egne innlegg i CMS'],
      sales: ['Blogg der du publiserer egne innlegg'],
    },
    en: {
      title: 'Blog',
      contract: ['Blog on the website: the Client writes and publishes their own posts in the CMS'],
      sales: ['Blog where you publish your own posts'],
    },
  },
  {
    id: 'service.autoPosts', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['seo'], features: ['blog.autoPosts'] },
    nb: {
      title: 'Automatiske blogginnlegg',
      terms: [
        'Med SEO-tjenesten skriver Asoldi blogginnlegg om kundens tjenester og område og publiserer dem automatisk. Standard er ett innlegg i uken. Kunden kan velge fra null til tre innlegg i uken.',
        'Innleggene skrives med hjelp av AI og kontrolleres automatisk før de publiseres. I regulerte bransjer, for eksempel helse og kosttilskudd, publiseres et innlegg først når både Asoldi og kunden har godkjent det.',
        'Kunden kan redigere eller avpublisere et innlegg når som helst. Automatiske innlegg stopper når abonnementet avsluttes.',
      ],
      contract: ['Automatiske blogginnlegg om kundens tjenester og område: normalt ett i uken, og kunden kan velge fra null til tre i uken'],
      sales: ['Automatiske SEO-blogginnlegg (1 i uken, 0–3 ved ønske)'],
    },
    en: {
      title: 'Automatic blog posts',
      contract: ['Automatic blog posts about the Client\'s services and area: normally one a week, and the Client can choose from zero to three a week'],
      sales: ['Automatic SEO blog posts (1 a week, 0–3 on request)'],
    },
  },
  {
    id: 'service.seo', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: {
      services: ['seo'],
      features: ['analytics', 'analytics.level', 'seo.agreedKeywords', 'seo.reports', 'seo.reports.basic', 'seo.tracking', 'seo.tracking.**', 'seo.localPack', 'seo.backlinkTargets', 'seo.searchConsole', 'seo.liveAudit'],
    },
    nb: {
      title: 'SEO-arbeid og avtalte søkeord',
      terms: [
        'SEO-tjenesten er løpende arbeid for at nettsiden skal bli funnet i Google Søk, Google Maps og AI-assistenter. Den omfatter søkeordsoptimalisert tekst, teknisk SEO, arbeid med lokalt søk og bedriftsprofil, en månedlig SEO-sjekk av nettsiden og forslag til nettsteder som bør lenke til kunden.',
        'Asoldi og kunden avtaler søkeordene arbeidet rettes mot, normalt ett til tre. De avtalte søkeordene står i tjenesteavtalen eller i kundens SEO-oversikt i CMS. Nye eller endrede søkeord avtales skriftlig, også i CMS.',
        'Kunden får en statistikkside i CMS med rangeringer i Google Søk, Google Maps, Googles AI-oversikt og AI-assistenter, data fra Google Search Console når kunden kobler den til, og en rapport hver fjortende dag.',
        'Asoldi garanterer ikke en bestemt plassering, trafikk eller omsetning. SEO er løpende arbeid uten lovet kommersielt resultat.',
      ],
      contract: [
        'Løpende SEO-arbeid mot Google Søk, Google Maps og AI-søk: søkeordsoptimalisert tekst, teknisk SEO, lokalt søk og en månedlig SEO-sjekk',
        'Arbeid mot de avtalte søkeordene, normalt ett til tre',
        'Statistikkside i CMS med rangeringer og en rapport hver fjortende dag',
        'Asoldi garanterer ikke bestemt plassering, trafikk eller omsetning',
      ],
      sales: ['SEO for 1–3 avtalte søkeord', 'Rangering på Google, Google Maps og AI-søk', 'Analyse-dashbord og rapport hver 14. dag'],
    },
    en: {
      title: 'SEO work and agreed keywords',
      contract: [
        'Ongoing SEO work for Google Search, Google Maps and AI search: keyword-optimised copy, technical SEO, local search and a monthly SEO check',
        'Work towards the agreed keywords, normally one to three',
        'Analytics page in the CMS with rankings and a report every fourteen days',
        'Asoldi does not guarantee specific rankings, traffic or revenue',
      ],
      sales: ['SEO for 1–3 agreed keywords', 'Ranking on Google, Google Maps and AI search', 'Analytics dashboard and a report every 14 days'],
    },
  },
  {
    id: 'service.social', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['social'], features: ['reviews', 'reviews.onsite', 'reviews.google', 'social', 'social.profiles'] },
    nb: {
      title: 'Omtaler og sosiale medier',
      terms: [
        'Nettsiden kan vise omtaler fra Google og omtaler som kundens egne kunder skriver på nettsiden, og lenke til kundens profiler i sosiale medier. Asoldi publiserer ikke innlegg i kundens sosiale medier.',
        'For å hente omtaler fra Google kobler kunden sin bedriftsprofil. Asoldi lagrer ikke kundens passord til slike kontoer.',
      ],
      contract: ['Visning av Google-omtaler og omtaler på nettsiden, og lenker til kundens sosiale profiler. Asoldi publiserer ikke i sosiale medier'],
      sales: ['Anmeldelser og lenker til sosiale medier'],
    },
    en: {
      title: 'Reviews and social media',
      contract: ['Display of Google reviews and on-site reviews, and links to the Client\'s social profiles. Asoldi does not post on social media'],
      sales: ['Reviews and links to social media'],
    },
  },
  {
    id: 'service.email', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['email'], features: ['email', 'email.newsletter', 'email.doubleOptIn', 'email.campaigns', 'email.automations', 'email.automations.welcome', 'forms', 'forms.lists'] },
    nb: {
      title: 'E-postmarkedsføring',
      terms: [
        'Nettsiden kan samle e-postadresser i skjemaer og i påmelding til nyhetsbrev. Nye abonnenter bekrefter adressen sin før de får e-post (dobbel bekreftelse).',
        'Kunden kan sende kampanjer til listene sine og bruke automatiske e-poster, for eksempel velkomst-e-post til nye abonnenter. Hver e-post har en lenke for å melde seg av.',
        'E-posten sendes gjennom Asoldis e-postleverandører. Kunden er avsender og behandlingsansvarlig for listene. E-postfunksjonene er av for nettsiden til kunden har godtatt databehandleravtalen.',
      ],
      contract: [
        'Påmelding til nyhetsbrev med dobbel bekreftelse, e-postlister, kampanjer og velkomst-e-post',
        'E-post sendes gjennom Asoldis e-postleverandører og er av til databehandleravtalen er godtatt',
      ],
      sales: ['E-postlister, nyhetsbrev og velkomst-e-post'],
    },
    en: {
      title: 'Email marketing',
      contract: [
        'Newsletter sign-up with double opt-in, email lists, campaigns and a welcome email',
        'Email is sent through Asoldi\'s email providers and stays off until the data processing agreement is accepted',
      ],
      sales: ['Email lists, newsletter and welcome email'],
    },
  },
  {
    id: 'service.shopEmail', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: {
      services: ['ecom'],
      features: ['email.automations.abandonedCart', 'email.automations.winback', 'email.automations.reviewRequest', 'email.automations.backInStock', 'email.notifications', 'email.notifications.*', 'email.customDomain'],
    },
    nb: {
      title: 'E-postautomatiseringer i nettbutikken',
      terms: [
        'I nettbutikken kan CMS sende automatiske e-poster: påminnelse om forlatt handlekurv, beskjed når en vare er tilbake på lager, forespørsel om omtale etter kjøp og e-post til kunder som ikke har handlet på en stund. Kunden kan få varsler om hendelser i butikken og sende e-post fra eget domene.',
        'Påminnelse om forlatt handlekurv sendes bare til kjøpere som har krysset av for det i kassen. Påminnelsen sendes i to steg, etter én time og etter 24 timer, uten rabatt. Uten slikt samtykke ser kunden bare en maskert e-postadresse og verdien av handlekurven.',
      ],
      contract: [
        'Automatiske e-poster i nettbutikken: forlatt handlekurv (bare med kjøperens samtykke i kassen), tilbake på lager, forespørsel om omtale og e-post til tidligere kunder',
        'Varsler om hendelser i butikken og sending fra eget e-postdomene',
      ],
      sales: ['Påminnelse om forlatt handlekurv (med samtykke)'],
    },
    en: {
      title: 'Email automations in the online store',
      contract: [
        'Automatic emails in the online store: abandoned cart (only with the buyer\'s consent at checkout), back in stock, review requests and win-back emails',
        'Alerts about store events and sending from the Client\'s own email domain',
      ],
      sales: ['Abandoned cart reminders (with consent)'],
    },
  },
  {
    id: 'service.ecom', version: 1, kind: 'service', section: 'services', docs: SOLD, consumerFacing: true,
    covers: {
      services: ['ecom'],
      features: ['shop', 'shop.**', 'reviews.onsite', 'integrations.webhooks', 'integrations.apiKeys', 'integrations.metaCapi', 'experiments', 'seo.productFeed'],
    },
    nb: {
      title: 'Nettbutikk',
      terms: [
        'Nettbutikken omfatter butikkoppsett, produktsider, handlekurv og kasse, kortbetaling, PayPal og Vipps når det er tilgjengelig, rabatter, gavekort, abonnement, forhåndsbestilling, digitale produkter, frakt og fraktetiketter, bestilling fra meny, timebestilling, kundekonto («Min side») og mersalg. Funksjonene slås på etter avtale og behov.',
        'Kunden er selger overfor sine kunder og har ansvaret for varer, priser, levering, angrerett og reklamasjon. Salgsbetingelsene på kundens nettside bygger på Forbrukertilsynets standard salgsbetingelser for forbrukerkjøp av varer over Internett.',
        'Kunden kobler sin egen betalingskonto. Kortopplysninger behandles av betalingsleverandøren og lagres ikke hos Asoldi.',
        'Nettbutikken kan sende produktene til Google Shopping, koble til andre systemer med webhooks og API-nøkler, rapportere kjøp til Meta etter samtykke og kjøre splittester.',
      ],
      contract: [
        'Nettbutikk: produktsider, handlekurv, kasse og betaling til kundens egen betalingskonto',
        'Rabatter, gavekort, abonnement, frakt, timebestilling og kundekonto etter behov',
        'Salgsbetingelser basert på Forbrukertilsynets standard salgsbetingelser. Kunden er selger overfor sine kunder',
        'Produktfeed til Google Shopping, webhooks og API-nøkler',
      ],
      sales: ['Nettbutikk-funksjonalitet'],
    },
    en: {
      title: 'Online store',
      contract: [
        'Online store: product pages, cart, checkout and payment to the Client\'s own payment account',
        'Discounts, gift cards, subscriptions, shipping, bookings and customer accounts as needed',
        'Terms of sale based on the Norwegian Consumer Authority\'s standard terms. The Client is the seller to its customers',
        'Product feed for Google Shopping, webhooks and API keys',
      ],
      sales: ['Online store'],
    },
  },
  {
    id: 'service.dashboard', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['dashboard'], features: ['analytics', 'analytics.level', 'seo.reports.advanced'] },
    nb: {
      title: 'Utvidet statistikk og rapport',
      terms: ['Kunden får utvidet statistikk i CMS, også nettbutikk-tall som kjøp, konverteringsrate og gjennomsnittlig ordreverdi, og en utvidet rapport hver sjuende dag i stedet for rapporten hver fjortende dag. Rapportene leveres i CMS.'],
      contract: ['Utvidet statistikk med nettbutikk-tall og en utvidet rapport hver sjuende dag'],
      sales: ['Ukentlig avansert rapport', 'Nettbutikk-analyse (konvertering, AOV)'],
    },
    en: {
      title: 'Extended analytics and report',
      contract: ['Extended analytics with online store figures and an extended report every seven days'],
      sales: ['Weekly advanced report', 'Store analytics (conversion, AOV)'],
    },
  },
  {
    id: 'service.multilingual', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['multilingual'], features: ['i18n', 'i18n.**', 'seo.multilingual'] },
    nb: {
      title: 'Flere språk',
      terms: ['Nettsiden og nettbutikken kan vises på flere språk, med oversatt innhold, produkter og innlegg og egne søkeord per språk.'],
      contract: ['Nettside og nettbutikk på flere språk, med søkeord per språk'],
      sales: ['Flerspråklig funksjonalitet'],
    },
    en: {
      title: 'Multiple languages',
      contract: ['Website and online store in several languages, with keywords per language'],
      sales: ['Multilingual website'],
    },
  },
  {
    id: 'service.catalog', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['catalog'], features: ['shop', 'shop.catalog'] },
    nb: {
      title: 'Katalog',
      terms: ['Katalogen viser produkter, en meny eller planer på nettsiden uten kasse. Kjøp skjer utenfor nettsiden.'],
      contract: ['Katalog over produkter, meny eller planer, uten kasse'],
      sales: ['Produktkatalog uten kasse'],
    },
    en: {
      title: 'Catalogue',
      contract: ['Catalogue of products, a menu or plans, without checkout'],
      sales: ['Product catalogue without checkout'],
    },
  },
  {
    id: 'service.booking', version: 1, kind: 'service', section: 'services', docs: SOLD, consumerFacing: true,
    covers: {
      services: ['booking'],
      features: ['shop', 'shop.catalog', 'shop.checkout', 'shop.payments', 'shop.payments.stripe', 'shop.payments.vipps', 'shop.bookings', 'shop.giftcards', 'shop.accounts', 'reviews.onsite', 'email.automations.reviewRequest', 'email.notifications'],
    },
    nb: {
      title: 'Timebestilling',
      terms: [
        'Kundens kunder kan bestille og betale time på nettsiden, kjøpe gavekort og se bestillingene sine. Kunden kan be om omtale etter besøket og få varsel om nye bestillinger.',
        'Kunden er tjenesteyter overfor sine kunder. Vilkårene for bestilling bygger på Forbrukertilsynets standard salgsbetingelser og forbrukerreglene for tjenester.',
      ],
      contract: ['Timebestilling med betaling, gavekort og kundekonto. Kunden er tjenesteyter overfor sine kunder'],
      sales: ['Timebestilling på nettsiden'],
    },
    en: {
      title: 'Bookings',
      contract: ['Bookings with payment, gift cards and customer accounts. The Client is the service provider to its customers'],
      sales: ['Bookings on the website'],
    },
  },
  {
    id: 'service.backlinks', version: 1, kind: 'service', section: 'services', docs: SOLD,
    covers: { services: ['backlinks'], features: ['seo.linkNetwork'], cancellation: ['backlink-network'] },
    nb: {
      title: 'Lenkenettverk',
      terms: [
        'Nettsider som Asoldi leverer, lenker til hverandre i et lenkenettverk. Lenkene er vanlige, fulgte lenker i en partnerseksjon eller på en partnerside og i relevante blogginnlegg. Nettsidene kobles etter bransje og sted, og hver nettside har et tak på antall lenker. Lenkene legges aldri i bunnteksten på alle sider.',
        'Kundens nettside lenker til og får lenker fra andre Asoldi-kunder. Antall lenker avhenger av hvor mange kunder som passer sammen. Asoldi følger med på rangeringene og kan stoppe nettverket for alle nettsider når det trengs.',
        'Når abonnementet avsluttes, fjernes lenkene til og fra kundens nettside neste gang nettverket bygges om, og nye kunder lenker ikke til nettsiden.',
      ],
      contract: [
        'Lenkenettverk: fulgte, relevante lenker mellom Asoldi-kunder i en partnerseksjon og i blogginnlegg, med tak per nettside og aldri i bunnteksten på alle sider',
        'Lenkene til og fra nettsiden fjernes når abonnementet avsluttes',
      ],
      sales: ['Asoldi-nettverk for relevante lenker'],
    },
    en: {
      title: 'Link network',
      contract: [
        'Link network: followed, relevant links between Asoldi clients in a partner section and in blog posts, capped per site and never in a site-wide footer',
        'Links to and from the website are removed when the subscription ends',
      ],
      sales: ['Asoldi network for relevant links'],
    },
  },

  // ---------------------------------------------------------------- one-time add-ons
  {
    id: 'addon.pos', version: 1, kind: 'addon', section: 'addons', docs: SOLD,
    covers: { addOns: ['pos'], features: ['integrations.webhooks', 'integrations.apiKeys'] },
    nb: {
      title: 'Kassesystem-kobling',
      terms: [
        'Engangsarbeid som kobler nettsiden, vanligvis katalog, lager eller ordrer, til kundens eksisterende kassesystem gjennom leverandørens dokumenterte API eller offisielle integrasjon, med webhooks og API-nøkler i CMS.',
        'Asoldi selger, lisensierer, drifter eller gir ikke support på kassesystemet. Kunden må ha et kassesystem med en brukbar integrasjon og gi Asoldi nødvendig tilgang. Kunden betaler løpende avgift til kassaleverandøren. Egenutvikling og maskinvare inngår ikke.',
      ],
      contract: ['Kassesystem-kobling (engangsarbeid) gjennom leverandørens API eller offisielle integrasjon'],
      sales: ['Kassesystem-kobling (engangs)'],
    },
    en: {
      title: 'POS connection',
      contract: ['POS connection (one-time work) through the vendor\'s API or official integration'],
      sales: ['POS connection (one-time)'],
    },
  },
  {
    id: 'addon.thirdpartyhost', version: 1, kind: 'addon', section: 'addons', docs: SOLD,
    covers: { addOns: ['thirdpartyhost'] },
    nb: {
      title: 'Nettside hos en annen leverandør',
      terms: ['SEO- og endringsarbeid for en nettside som driftes hos en annen leverandør. Kunden betaler vert og domeneregistrar selv og gir Asoldi nødvendig tilgang. Tillegget gir ikke Asoldi CMS hos den andre leverandøren.'],
      contract: ['Oppsett av SEO- og endringsarbeid for kundens nettside hos en annen vert (engangsarbeid). Kunden betaler vert og domeneregistrar'],
      sales: ['Nettside hos annen vert (engangs)'],
    },
    en: {
      title: 'Website hosted elsewhere',
      contract: ['Set-up of SEO and change work for the Client\'s website at another host (one-time work). The Client pays the host and registrar'],
      sales: ['Website at another host (one-time)'],
    },
  },

  // ---------------------------------------------------------------- general: plans and billing
  {
    id: 'general.oneTimePurchase', version: 1, kind: 'general', section: 'billing', docs: BOTH,
    covers: { billing: ['once'] },
    nb: {
      title: 'Engangskjøp',
      terms: [
        'Ved engangskjøp betaler kunden én gang i stedet for månedlig. Prisen er {oneTimeMultiplier} ganger månedsprisen for valgt omfang, med en eventuell minstepris som står i tilbudet. Engangskjøp har ingen bindingstid.',
        'Ubegrensede endringer inngår i {oneTimeMonths} måneder etter levering. Deretter gjelder samme endringskvote som for månedskunder.',
        'Etter overleveringen har kunden selv ansvaret for hosting. Funksjoner som krever Asoldis hub, stopper: oppdateringer av CMS, automatiske blogginnlegg, lenkenettverket og e-post sendt gjennom Asoldi.',
      ],
      contract: [
        'Engangskjøp: {oneTimeMultiplier} ganger månedsprisen, uten bindingstid',
        'Ubegrensede endringer i {oneTimeMonths} måneder etter levering, deretter {changesPerMonth} endringer per måned',
        'Etter overleveringen har kunden selv ansvaret for hosting, og funksjoner som krever Asoldis hub, stopper',
      ],
    },
    en: {
      title: 'One-time purchase',
      contract: [
        'One-time purchase: {oneTimeMultiplier} times the monthly price, with no binding period',
        'Unlimited changes for {oneTimeMonths} months after delivery, then {changesPerMonth} changes per month',
        'After handover the Client is responsible for hosting, and functions that need Asoldi\'s hub stop',
      ],
    },
  },
  {
    id: 'general.term', version: 1, kind: 'general', section: 'term', docs: BOTH,
    covers: { billing: ['month'] },
    nb: {
      title: 'Avtaleperiode',
      terms: [
        'Månedsabonnementet har en minste bindingstid på seks (6) måneder.',
        'Oppsigelse krever 15 dagers varsel, og kunden betaler for hele oppsigelsesmåneden.',
        'Kunden kan ikke nedgradere til et lavere nivå etter at funksjonalitet fra et høyere nivå er lagt til.',
      ],
      contract: [
        'Minste bindingstid er seks (6) måneder',
        'Oppsigelse krever 15 dagers varsel, og kunden betaler for hele oppsigelsesmåneden',
        'Kunden kan ikke nedgradere til et lavere nivå etter at funksjonalitet fra et høyere nivå er lagt til',
      ],
    },
    en: {
      title: 'Contract period',
      contract: [
        'The minimum binding period is six (6) months',
        'Cancellation requires 15 days\' notice, and the Client pays for the whole month of cancellation',
        'The Client cannot downgrade to a lower tier once functionality from a higher tier has been added',
      ],
    },
  },
  {
    id: 'general.cancellation', version: 1, kind: 'general', section: 'cancellation', docs: BOTH,
    covers: { cancellation: [...CANCELLATION_EFFECTS, CANCELLATION_GRACE] },
    nb: {
      title: 'Når avtalen avsluttes',
      terms: [
        'Når abonnementet avsluttes, stopper Asoldis løpende tjenester ved utløpet av den betalte perioden: oppdateringer av CMS, automatiske blogginnlegg, medlemskap i lenkenettverket, e-post sendt gjennom Asoldi og endringsforespørsler.',
        'Nettsiden er oppe i {graceDays} dager etter at den betalte perioden er over. Deretter stopper hostingen. Asoldi sender e-post når avtalen avsluttes, sju dager før hostingen stopper og når den stopper.',
        'Kunden kan be om eksport i kundeportalen fram til hostingen stopper. Eksporten inneholder nettsiden som statiske filer, CMS-data som JSON og CSV (produkter, ordrer, kunder, innlegg, skjemaer og samtykker) og mediefiler. Asoldi leverer eksporten innen syv (7) virkedager.',
        'Kunden eier innholdet, designet og kode som er laget spesielt for kunden. Asoldi CMS og felles plattformkomponenter følger sin lisens og overføres ikke. Å flytte nettsiden til en annen leverandør er kundens ansvar. Asoldi kan hjelpe mot betaling etter prisen som til enhver tid står på asoldi.com.',
      ],
      contract: [
        'Ved oppsigelse stopper oppdateringer av CMS, automatiske blogginnlegg, lenkenettverket, e-post gjennom Asoldi og endringsforespørsler ved utløpet av den betalte perioden',
        'Nettsiden er oppe i {graceDays} dager etter den betalte perioden. Deretter stopper hostingen',
        'Kunden kan be om eksport av nettsiden, CMS-data og mediefiler i kundeportalen fram til hostingen stopper. Eksporten leveres innen syv (7) virkedager',
        'Kunden eier innholdet, designet og kode laget spesielt for kunden. Asoldi CMS følger sin lisens og overføres ikke',
      ],
    },
    en: {
      title: 'When the agreement ends',
      contract: [
        'On cancellation, CMS updates, automatic blog posts, the link network, email through Asoldi and change requests stop at the end of the paid period',
        'The website stays online for {graceDays} days after the paid period. Then hosting stops',
        'The Client can request an export of the website, CMS data and media in the client portal until hosting stops. The export is delivered within seven (7) business days',
        'The Client owns the content, the design and code made specifically for the Client. The Asoldi CMS follows its licence and is not transferred',
      ],
    },
  },
  {
    id: 'general.payment', version: 1, kind: 'general', section: 'payment', docs: ['terms'],
    nb: {
      title: 'Betaling',
      terms: [
        'Månedlige betalinger skjer den 1. i hver måned. Første måned faktureres forholdsmessig fra levering.',
        'Faktura for første måned forfaller innen 7 dager etter levering. Senere fakturaer forfaller innen 7 dager etter at de er sendt.',
        'Betaling skjer med bankoverføring eller Stripe. Det er ingen etableringsavgift. Engangstillegg faktureres én gang på første faktura etter levering.',
        'Priser er oppgitt uten merverdiavgift med mindre tilbudet sier noe annet.',
      ],
    },
  },
  {
    id: 'general.paymentDefault', version: 1, kind: 'general', section: 'payment', docs: ['terms'],
    nb: {
      title: 'Betalingsmislighold',
      terms: [
        'Er betaling ikke mottatt innen 7 dager etter forfall, sender Asoldi en påminnelse. Er betaling ikke mottatt innen 14 dager etter forfall, kan nettsiden tas midlertidig ned til betaling er mottatt, og forsinkelsesrente og gebyrer etter norsk lov påløper.',
        'Er betaling ikke mottatt innen 30 dager, kan kravet sendes til inkasso. Asoldi kan stanse tjenestene straks hvis det oppdages svindel knyttet til betaling.',
      ],
    },
  },
  {
    id: 'general.customer', version: 1, kind: 'general', section: 'customer', docs: ['terms'],
    nb: {
      title: 'Kundens ansvar',
      terms: [
        'Kunden leverer innen rimelig tid det som trengs for nettsiden: logo, bilder og video, tilgang til domenet, og tilgang til kassesystem eller eksisterende vert når det inngår.',
        'Leverer kunden ikke nødvendige opplysninger og tilganger innen rimelig tid, gjelder ikke leveringsgarantien og kompensasjonen for hostingfeil for forsinkelse som skyldes dette.',
      ],
    },
  },
  {
    id: 'general.usageRights', version: 1, kind: 'general', section: 'customer', docs: BOTH,
    nb: {
      title: 'Materiale fra kunden',
      terms: [
        'Kunden bekrefter å ha rett til å bruke tekst, bilder, video, logoer og annet materiale kunden gir Asoldi, og gir Asoldi rett til å bruke materialet for å lage og drifte nettsiden etter avtalen.',
        'Asoldi bruker ikke bilder som andre har lastet opp på Instagram, Facebook eller Google Maps. Bilder fra kundens egen nettside brukes bare når kunden har bekreftet retten til dem.',
      ],
      contract: ['Kunden har rett til å bruke materialet kunden leverer, og gir Asoldi rett til å bruke det for å lage og drifte nettsiden'],
    },
    en: {
      title: 'Material from the Client',
      contract: ['The Client has the right to use the material it supplies and gives Asoldi the right to use it to build and run the website'],
    },
  },
  {
    id: 'general.delivery', version: 1, kind: 'general', section: 'delivery', docs: ['terms'],
    nb: {
      title: 'Leveringsgaranti, hostingfeil og eierskap',
      terms: [
        'Leverer Asoldi ikke nettsiden innen tidsrammen i tjenesteavtalen, får kunden én (1) måned med tjeneste gratis.',
        'Er Asoldi over lengre tid ute av stand til å hoste nettsiden, får kunden én (1) måned med tjeneste gratis. Annet ansvar er begrenset som beskrevet under ansvar.',
        'I abonnementsperioden har kunden full rett til å bruke nettsiden. Asoldi eier hostingmiljøet, Asoldi CMS, felles plattformkomponenter og tredjepartslisenser.',
      ],
    },
  },
  {
    id: 'general.support', version: 1, kind: 'general', section: 'delivery', docs: ['terms'],
    nb: {
      title: 'Support',
      terms: ['Supporttiden er 09:00–16:00 (norsk tid) på virkedager. Vanlige henvendelser besvares innen 1–3 dager, hastesaker innen 1 dag.'],
    },
  },
  {
    id: 'general.ai', version: 1, kind: 'general', section: 'ai', docs: ['terms', 'contract', 'privacy', 'dpa'],
    nb: {
      title: 'Bruk av AI',
      terms: [
        'Asoldi bruker språkmodeller og andre AI-tjenester for å lage og forbedre tekst og innhold, lese materiale kunden sender, foreslå søkeord og transkribere og oppsummere møter.',
        'Personopplysninger og møteopptak sendes bare til AI-leverandører som er godkjent for slike data og har databehandleravtale med Asoldi. Andre leverandører får bare offentlige opplysninger, opplysninger om bedriften eller anonymiserte data.',
        'Endringer på nettsiden som er laget med AI, kontrolleres med automatiske sjekker og godkjennes av en utvikler før de publiseres. Automatiske blogginnlegg følger reglene for automatiske innlegg.',
        'Hvilke leverandører Asoldi bruker, og hvilke data hver av dem får, står i personvernerklæringen og i vedlegget til databehandleravtalen.',
      ],
      contract: ['Asoldi bruker AI-tjenester i leveransen. Personopplysninger sendes bare til leverandører som er godkjent for det, og listen står i vedlegget til databehandleravtalen'],
    },
    en: {
      title: 'Use of AI',
      contract: ['Asoldi uses AI services in the delivery. Personal data is only sent to providers approved for it, and the list is in the appendix to the data processing agreement'],
    },
  },
  {
    id: 'general.dpa', version: 1, kind: 'general', section: 'privacy', docs: BOTH,
    nb: {
      title: 'Personvern og databehandleravtale',
      terms: [
        'Kunden er behandlingsansvarlig for personopplysninger som samles inn via kundens nettside. Asoldi er databehandler og behandler slike opplysninger etter databehandleravtalen.',
        'Databehandleravtalen (versjon {dpaVersion}) med vedlegg om underleverandører gjelder for alle kunder. E-postfunksjonene på nettsiden er av til kunden har godtatt databehandleravtalen, enten ved signering av tjenesteavtalen eller i kundeportalen.',
        'Asoldis behandling av opplysninger om kunden står i personvernerklæringen.',
      ],
      contract: [
        'Databehandleravtalen versjon {dpaVersion} med vedlegg om underleverandører gjelder og godtas ved signering av denne avtalen',
        'E-postfunksjonene på nettsiden er av til databehandleravtalen er godtatt',
      ],
    },
    en: {
      title: 'Privacy and data processing agreement',
      contract: [
        'The data processing agreement version {dpaVersion} with its appendix on sub-processors applies and is accepted by signing this agreement',
        'Email functions on the website stay off until the data processing agreement is accepted',
      ],
    },
  },
  {
    id: 'general.consumer', version: 1, kind: 'general', section: 'consumer', docs: ['terms'], consumerFacing: true,
    covers: { features: ['site.legalPages'] },
    nb: {
      title: 'Kundens vilkår overfor forbrukere',
      terms: [
        'Juridiske sider på kundens nettside (salgsbetingelser, personvern og informasjonskapsler) lages med Forbrukertilsynets standard salgsbetingelser for forbrukerkjøp av varer over Internett og gjeldende lov som utgangspunkt.',
        'Kunden er ansvarlig for at opplysningene om virksomheten, prisene og vilkårene på nettsiden er riktige. Asoldis vilkår gjelder mellom Asoldi og kunden.',
      ],
    },
  },
  {
    id: 'general.liability', version: 1, kind: 'general', section: 'liability', docs: ['terms'],
    nb: {
      title: 'Ansvar',
      terms: [
        'Asoldi er ikke ansvarlig for indirekte tap eller følgetap, eller for tap av omsetning, virksomhet eller data.',
        'Asoldis samlede ansvar er begrenset til abonnementsbeløpet kunden har betalt de seks (6) siste månedene før kravet oppsto, uten merverdiavgift, med mindre ufravikelig norsk lov gir noe annet.',
      ],
    },
  },
  {
    id: 'general.portfolio', version: 1, kind: 'general', section: 'liability', docs: ['terms'],
    nb: {
      title: 'Referanser',
      terms: ['Asoldi kan vise kundens nettside i referanser og markedsføring. Kunden kan reservere seg skriftlig.'],
    },
  },
  {
    id: 'general.law', version: 1, kind: 'general', section: 'law', docs: ['terms'],
    nb: {
      title: 'Lovvalg og endringer',
      terms: [
        'Vilkårene er underlagt norsk lov. Tvister søkes løst i minnelighet, ellers ved norske domstoler.',
        'Asoldi kan endre vilkårene. En ny versjon får nytt versjonsnummer og gjelder for nye avtaler. Eksisterende kunder får skriftlig varsel minst 30 dager før en ny versjon gjelder for dem. Til da gjelder versjonen kunden signerte.',
      ],
    },
  },

  // ---------------------------------------------------------------- privacy policy (Asoldi as controller)
  {
    id: 'privacy.intro', version: 1, kind: 'privacy', section: 'intro', docs: ['privacy'],
    nb: {
      title: 'Innledning',
      terms: [
        'Denne personvernerklæringen forklarer hvordan Asoldi Markedsføring (drevet under foretaket CHAPANA, org.nr. 934 327 497) behandler personopplysninger når du besøker asoldi.com, bruker kundeportalen, snakker med oss eller inngår en avtale med oss. Asoldi er behandlingsansvarlig for denne behandlingen.',
        'Når vi behandler personopplysninger på vegne av en kunde, for eksempel opplysninger om besøkende og kjøpere på kundens nettside, gjelder databehandleravtalen.',
      ],
    },
  },
  {
    id: 'privacy.collected', version: 1, kind: 'privacy', section: 'collected', docs: ['privacy'],
    nb: {
      title: 'Opplysninger vi behandler',
      terms: [
        'Kontaktopplysninger: navn, e-postadresse, telefonnummer, rolle og bedrift, fra skjemaer, bestilling av møter, registrering, e-post og salgssamtaler.',
        'Opplysninger om bedrifter vi kontakter: bedriftsnavn, kontaktperson, telefonnummer og notater fra samtaler, fra offentlige registre og leadlister.',
        'Kunde- og prosjektopplysninger: tilbud, avtaler, fakturagrunnlag, ønsker for nettsiden og materiale kunden laster opp.',
        'Møteopptak og transkripsjoner: salgsmøter og workshoper tas opp og transkriberes når deltakerne er informert om det. Lydopptak fra salgssamtaler kan transkriberes.',
        'Kontoopplysninger: e-postadresse og passord (lagres som hash) og innlogging med Google.',
        'Tekniske opplysninger: IP-adresse, nettleser og enhet, og bruk av nettstedet etter samtykke. Se erklæringen om informasjonskapsler.',
      ],
    },
  },
  {
    id: 'privacy.google', version: 1, kind: 'privacy', section: 'collected', docs: ['privacy'],
    nb: {
      title: 'Innlogging med Google og bruk av Google-data',
      terms: [
        'Når du logger inn med Google, bruker vi Googles OAuth 2.0. Vi ber bare om navn, e-postadresse, profilbilde og konto-ID, og bruker dem til å opprette og logge inn kontoen din og til å kommunisere med deg om kontoen.',
        'Asoldi kan koble en egen Google-konto til Google Kalender for å opprette, endre og slette møter du avtaler med oss, med Google Meet-lenker. Vi leser ikke din private kalender.',
        'Asoldis bruk og overføring av informasjon fra Google API-er følger Google API Services User Data Policy, inkludert kravene til begrenset bruk (Limited Use). Vi bruker Google-data bare til funksjonene du har bedt om, selger dem ikke, bruker dem ikke til annonsering og lar ikke mennesker lese dem uten samtykke, med mindre det trengs for sikkerhet eller loven krever det.',
      ],
    },
  },
  {
    id: 'privacy.purposes', version: 1, kind: 'privacy', section: 'purposes', docs: ['privacy'],
    nb: {
      title: 'Formål og rettslig grunnlag',
      terms: [
        'Levere tjenestene, kundeportalen og kontoen: nødvendig for å oppfylle avtalen (GDPR art. 6 nr. 1 b).',
        'Kontakte bedrifter om våre tjenester, følge opp salgsmøter og forberede tilbud: berettiget interesse (art. 6 nr. 1 f).',
        'Ta opp og transkribere møter for å lage riktig tilbud og prosjektdokument: berettiget interesse, og deltakerne informeres før opptak (art. 6 nr. 1 f).',
        'Fakturere og føre regnskap: avtale og rettslig plikt (art. 6 nr. 1 b og c).',
        'Sikre og forbedre nettstedet: berettiget interesse (art. 6 nr. 1 f). Statistikk og markedsføring: samtykke (art. 6 nr. 1 a), som du kan trekke tilbake når som helst.',
      ],
    },
  },
  {
    id: 'privacy.rights', version: 1, kind: 'privacy', section: 'rights', docs: ['privacy'],
    nb: {
      title: 'Dine rettigheter',
      terms: [
        'Du har rett til innsyn, retting, sletting, begrensning, dataportabilitet og til å protestere mot behandling som bygger på berettiget interesse. Du kan trekke tilbake samtykke når som helst.',
        'Kontakt oss på kontakt@asoldi.com. Du kan klage til Datatilsynet (datatilsynet.no). Du kan koble fra Google-tilgangen i Google-kontoens app-tillatelser.',
      ],
    },
  },
  {
    id: 'privacy.security', version: 1, kind: 'privacy', section: 'rights', docs: ['privacy'],
    nb: {
      title: 'Sikkerhet',
      terms: ['Vi bruker tilgangsstyring, kryptert overføring, passord lagret som hash, sikkerhetskopier og rutiner for sikkerhetshendelser. Bare personer som trenger opplysningene for å levere tjenesten, har tilgang.'],
    },
  },
  {
    id: 'privacy.changes', version: 1, kind: 'privacy', section: 'rights', docs: ['privacy'],
    nb: {
      title: 'Endringer',
      terms: ['Vi oppdaterer erklæringen når tjenestene eller leverandørene endres. Hver versjon har et nummer og en dato.'],
    },
  },

  // ---------------------------------------------------------------- data processing agreement
  {
    id: 'dpa.purpose', version: 1, kind: 'dpa', section: 'purpose', docs: ['dpa'],
    nb: {
      title: 'Avtalens formål',
      terms: [
        'Denne databehandleravtalen regulerer Asoldi Markedsførings (CHAPANA, org.nr. 934 327 497) («databehandler») behandling av personopplysninger på vegne av kunden («behandlingsansvarlig») når Asoldi utvikler, hoster, vedlikeholder og drifter kundens nettside, CMS og tilknyttede tjenester, etter personvernforordningen artikkel 28.',
        'Avtalen gjelder sammen med tjenesteavtalen og vilkårene. Den godtas ved signering av tjenesteavtalen eller i kundeportalen.',
      ],
    },
  },
  {
    id: 'dpa.roles', version: 1, kind: 'dpa', section: 'purpose', docs: ['dpa'],
    nb: {
      title: 'Roller og instruks',
      terms: [
        'Kunden er behandlingsansvarlig for personopplysninger som samles inn via nettsiden: skjemaer, nettbutikk, timebestilling, e-postlister, omtaler og kundekontoer. Kunden har ansvar for behandlingsgrunnlag og informasjon til de registrerte.',
        'Asoldi behandler opplysningene bare etter kundens dokumenterte instruks, denne avtalen og gjeldende rett. Kunden instruerer Asoldi om å behandle opplysningene for å levere tjenestene i tjenesteavtalen. Asoldi sier fra hvis en instruks etter Asoldis vurdering bryter personvernregelverket.',
      ],
    },
  },
  {
    id: 'dpa.processing', version: 1, kind: 'dpa', section: 'processing', docs: ['dpa'],
    nb: {
      title: 'Behandlingens art, formål og varighet',
      terms: [
        'Asoldi behandler personopplysninger for å hoste og vise nettsiden, drifte skjemaer, CMS, blogg, nettbutikk, timebestilling og e-post, utføre vedlikehold, sikkerhet og sikkerhetskopiering, og levere avtalt SEO, innhold og support.',
        'Behandlingen varer så lenge tjenesteavtalen løper, og deretter så lenge det trengs for eksport, sletting eller lovpålagt oppbevaring.',
      ],
    },
  },
  {
    id: 'dpa.categories', version: 1, kind: 'dpa', section: 'processing', docs: ['dpa'],
    nb: {
      title: 'Registrerte og opplysninger',
      terms: [
        'Registrerte: besøkende på nettsiden, personer som sender skjema, melder seg på e-postlister, bestiller time eller handler i nettbutikken, og kundens ansatte med tilgang til CMS.',
        'Opplysninger: navn, kontaktopplysninger, meldinger, bestillinger og betalingsstatus (selve kortbetalingen håndteres av betalingsleverandøren), samtykker og avmeldinger, omtaler, og tekniske logger som trengs for drift og sikkerhet.',
        'Asoldi behandler ikke særlige kategorier av personopplysninger på kundens vegne uten skriftlig avtale om tilleggsvilkår.',
      ],
    },
  },
  {
    id: 'dpa.subprocessors', version: 1, kind: 'dpa', section: 'subprocessors', docs: ['dpa'],
    nb: {
      title: 'Underleverandører',
      terms: [
        'Kunden gir Asoldi generell tillatelse til å bruke underleverandørene i vedlegget. Asoldi har databehandleravtale med hver av dem, med de samme pliktene som i denne avtalen.',
        'Nye eller endrede underleverandører gir en ny versjon av vedlegget. Asoldi varsler kunden før endringen gjelder, og kunden kan protestere av saklig personverngrunn.',
        'Overføring til land utenfor EØS skjer bare med gyldig grunnlag, normalt EUs standardkontraktsvilkår.',
      ],
    },
  },
  {
    id: 'dpa.security', version: 1, kind: 'dpa', section: 'security', docs: ['dpa'],
    nb: {
      title: 'Sikkerhet, taushetsplikt og bistand',
      terms: [
        'Asoldi har tiltak tilpasset risikoen: tilgangsstyring og minst mulig tilgang, kryptert overføring, passord lagret som hash, sikkerhetskopier og rutiner for feilretting og sikkerhetshendelser.',
        'Alle som får tilgang til opplysningene, har taushetsplikt, også etter at oppdraget er avsluttet.',
        'Asoldi hjelper kunden med krav fra registrerte og med konsekvensvurderinger, så langt det er rimelig. Asoldi varsler kunden uten ugrunnet opphold om brudd på personopplysningssikkerheten som gjelder kundens opplysninger.',
      ],
    },
  },
  {
    id: 'dpa.end', version: 1, kind: 'dpa', section: 'end', docs: ['dpa'],
    nb: {
      title: 'Sletting, revisjon og varighet',
      terms: [
        'Når avtalen avsluttes, kan kunden få eksport som beskrevet i vilkårene. Asoldi sletter eller anonymiserer opplysningene innen 30 dager etter at hostingen har stoppet, med mindre loven krever lengre oppbevaring. Sikkerhetskopier fases ut i den vanlige rotasjonen.',
        'Asoldi gir kunden informasjonen som trengs for å vise at avtalen følges. Revisjon avtales på forhånd og gjennomføres uten å svekke sikkerheten for andre kunder.',
        'Hver part er ansvarlig for brudd på egne plikter. Asoldis ansvar følger ansvarsbegrensningen i vilkårene. Avtalen gjelder så lenge Asoldi behandler opplysninger for kunden.',
      ],
    },
  },
];

// ---------------------------------------------------------------- generation

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

/** Every key of the feature tree, in tree order. */
export function featureTreeKeys(nodes = FEATURE_NODES) {
  return asList(nodes).map((node) => node.key);
}

/** A feature pattern ('a', 'a.*' children, 'a.**' descendants) expanded against the tree keys. */
export function expandFeaturePattern(pattern, keys = featureTreeKeys()) {
  const raw = canonicalFeatureKey(pattern);
  if (raw.endsWith('.**')) {
    const base = raw.slice(0, -3);
    return keys.filter((key) => key.startsWith(`${base}.`));
  }
  if (raw.endsWith('.*')) {
    const base = raw.slice(0, -2);
    return keys.filter((key) => key.startsWith(`${base}.`) && !key.slice(base.length + 1).includes('.'));
  }
  return keys.includes(raw) ? [raw] : [];
}

/** Expanded coverage of one declared clause. Unknown feature patterns expand to nothing (and are reported). */
export function generateCovers(declared = {}, keys = featureTreeKeys()) {
  const covers = declared || {};
  const features = new Set();
  for (const pattern of asList(covers.features)) {
    for (const key of expandFeaturePattern(pattern, keys)) features.add(key);
  }
  return {
    services: asList(covers.services).filter((id) => SERVICE_IDS.includes(id)),
    features: keys.filter((key) => features.has(key)),
    addOns: asList(covers.addOns).filter((id) => ONE_TIME_ADDON_IDS.includes(id)),
    cancellation: [...asList(covers.cancellation)],
    billing: [...asList(covers.billing)],
  };
}

/** Patterns, service ids, add-ons and cancellation items a declared clause names that do not exist. */
export function unknownCoverage(declaredClauses = DECLARED, keys = featureTreeKeys()) {
  const out = [];
  for (const clause of declaredClauses) {
    const covers = clause.covers || {};
    for (const pattern of asList(covers.features)) {
      if (!expandFeaturePattern(pattern, keys).length) out.push(`${clause.id}: feature ${pattern}`);
    }
    for (const id of asList(covers.services)) if (!SERVICE_IDS.includes(id)) out.push(`${clause.id}: service ${id}`);
    for (const id of asList(covers.addOns)) if (!ONE_TIME_ADDON_IDS.includes(id)) out.push(`${clause.id}: add-on ${id}`);
    for (const id of asList(covers.cancellation)) {
      if (!CANCELLATION_EFFECTS.includes(id) && id !== CANCELLATION_GRACE) out.push(`${clause.id}: cancellation ${id}`);
    }
  }
  return out;
}

function buildCatalog(declaredClauses) {
  const keys = featureTreeKeys();
  return declaredClauses.map((clause) => freezeDeep({
    id: clause.id,
    version: clause.version,
    kind: clause.kind,
    section: clause.section,
    docs: [...clause.docs],
    consumerFacing: Boolean(clause.consumerFacing),
    covers: generateCovers(clause.covers, keys),
    nb: structuredClone(clause.nb),
    ...(clause.en ? { en: structuredClone(clause.en) } : {}),
  }));
}

/** The current catalog: clauses with generated coverage. */
export const CATALOG = Object.freeze(buildCatalog(DECLARED));

/** The declared clauses (what lib/legal/archive stores per version). */
export function declaredClauses() {
  return structuredClone(DECLARED);
}

/** A catalog built from archived declared clauses (feature patterns expanded against today's tree). */
export function catalogFromDeclared(declared) {
  return Object.freeze(buildCatalog(asList(declared)));
}

// ---------------------------------------------------------------- coverage

/** The feature keys some service or one-time add-on bundle entitles (closed over ancestors). */
export function entitledFeatureKeys(bundles = BUNDLES) {
  const keys = new Set();
  for (const [id, bundle] of bundles instanceof Map ? bundles : new Map()) {
    if (!SERVICE_IDS.includes(id) && !ONE_TIME_ADDON_IDS.includes(id)) continue;
    for (const key of bundle.keys || []) keys.add(key);
  }
  const order = featureTreeKeys();
  return order.filter((key) => keys.has(key));
}

/**
 * Everything the texts must cover, generated from the shared vocabulary and the feature tree:
 * every service id (catalog and tier matrix), every entitled feature key, every one-time add-on,
 * every cancellation effect plus the hosting grace period, and both billing kinds.
 */
export function requiredCoverage() {
  const services = new Set(SERVICE_CATALOG.map((service) => service.id));
  for (const tier of Object.values(TIER_MATRIX)) for (const id of tier.services) services.add(id);
  return {
    services: SERVICE_IDS.filter((id) => services.has(id)),
    features: entitledFeatureKeys(),
    addOns: [...ONE_TIME_ADDON_IDS],
    cancellation: [...CANCELLATION_EFFECTS, CANCELLATION_GRACE],
    billing: ['month', 'once'],
  };
}

/** For one document, each required item no clause rendered in that document covers. */
export function coverageGaps(doc, { catalog = CATALOG, required = requiredCoverage() } = {}) {
  const clauses = catalog.filter((clause) => clause.docs.includes(doc));
  const covered = { services: new Set(), features: new Set(), addOns: new Set(), cancellation: new Set(), billing: new Set() };
  for (const clause of clauses) {
    for (const field of Object.keys(covered)) for (const id of clause.covers[field] || []) covered[field].add(id);
  }
  const gaps = {};
  for (const [field, list] of Object.entries(required)) {
    gaps[field] = list.filter((id) => !covered[field].has(id));
  }
  return gaps;
}

export function clauseById(id, catalog = CATALOG) {
  return catalog.find((clause) => clause.id === id) || null;
}

// ---------------------------------------------------------------- parameters

/** Values the texts' {placeholders} use, from the automation settings (defaults when absent). */
export function legalParams(settings = null, extra = {}) {
  const pricing = settings?.pricing || {};
  const lifecycle = settings?.lifecycle || {};
  const changes = settings?.changeRequests || {};
  return {
    changesPerMonth: CHANGES_PER_MONTH,
    slaWorkDays: Number(changes.slaWorkDays) || 10,
    oneTimeMultiplier: Number(pricing.oneTimeMultiplier) || 9,
    oneTimeMonths: Number(pricing.oneTimeMonths) || 6,
    graceDays: Number.isFinite(Number(lifecycle.cancellationGraceDays)) && lifecycle.cancellationGraceDays !== undefined
      ? Number(lifecycle.cancellationGraceDays)
      : CANCELLATION_GRACE_DAYS,
    pages: 5,
    dpaVersion: '',
    ...extra,
  };
}

/** A text with its {placeholders} filled; unknown placeholders stay as written. */
export function fillText(text, params = {}) {
  return String(text ?? '').replace(/\{([a-zA-Z]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== '' && params[name] !== undefined ? String(params[name]) : match
  ));
}

/**
 * Signed offer contract in Norwegian (default) or English.
 * Norwegian wording matches vilkår + SERVICE_MEANINGS_NO (the catalogue that
 * already existed while the PDF/preview article stayed English-only).
 */

import { LEGAL_URLS } from './legal-urls.js';
import { SERVICE_MEANINGS_EN, SERVICE_MEANINGS_NO } from './service-meanings.js';

export function normalizeContractLanguage(value = '') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'en' || raw === 'eng' || raw === 'english') return 'en';
  return 'nb';
}

export function contractMeanings(language = 'nb') {
  return normalizeContractLanguage(language) === 'en' ? SERVICE_MEANINGS_EN : SERVICE_MEANINGS_NO;
}

const SEO_MONTHLY_NB = {
  lead: 'Månedlig SEO-arbeid som inngår i dette nivået:',
  bullets: [
    'Løpende on-page og teknisk SEO: søkeordsfokusert tekst, HTML-struktur, sitemap og domenespesifikke forbedringer',
    'Valgfrie steds- og søkeordsrelaterte blogginnlegg, inntil tre (3) per uke når kunden ønsker det (typisk for lokale tjenestebedrifter)',
    'Deltakelse i Asoldis internlenkenettverk: andre Asoldi-kundersider kan peke mot kunden og omvendt. Antall lenker varierer med kundebasen',
    'Løpende arbeid mot avtalte 1–3 søkeord i Google Søk, Google Maps og AI-søk',
  ],
};

const TIER_CONTRACT_NB = {
  1: {
    title: 'Nivå 1 – Nettsidepakke',
    lead: 'Inkluderer:',
    includes: [
      'Full nettsidedesign og utvikling (responsivt oppsett, utvikling og sidemal) for en enkel nettside uten nettbutikk, inntil fem (5) hovedsider',
      'HTML-basert nettside med sitemap',
      'Domenekobling: kunden eier domenet; Asoldi kobler det til inkludert hosting. Kunden kjøper domenet selv hvis de ikke allerede har ett',
      'Hosting og vedlikehold på Asoldis Hostinger-nettverk så lenge abonnementet er aktivt',
      'Kontaktskjema og vanlige bedriftsseksjoner (uten nettbutikk og visning av anmeldelser)',
      'Inntil fire (4) mindre innholdsendringer per måned (for eksempel priser, bilder eller tekst). Ingen tillegg eller fjerning av seksjoner',
      'Ett veiledningsmøte: hvordan bruke kunde-CMS. Møtet holdes én gang',
      'Ingen avansert funksjonalitet, SEO-program, bloggskriving eller nettbutikk',
      'Ingen analyseside i kunde-CMS og ingen rangerings- eller resultatrapportering',
    ],
    kpis: {
      lead: 'Rapportering og analyse:',
      bullets: [
        'Dette nivået inkluderer ikke analyseside i kunde-CMS.',
        'Dette nivået inkluderer ikke rangeringsrapporter, resultatsammendrag eller annen planlagt analyserapportering.',
      ],
    },
  },
  2: {
    title: 'Nivå 2 – Nettside + SEO + e-post + analyse',
    lead: 'Inkluderer alt i nivå 1, pluss:',
    includes: [
      'Inntil syv (7) hovedsider',
      'Søkeordsoptimalisert tekst på siden',
      'SEO-optimalisering for 1–3 søkeord, inkludert arbeid mot rangering i Google Søk, Google Maps og AI-søk',
      'Visning av anmeldelser og synk mot sosiale medier (kunden logger inn for å koble kontoene; Asoldi lagrer ikke disse passordene i kundens asoldi.com-profil)',
      'Innsamling og lagring av e-postlister til markedsføring',
      'Det ene veiledningsmøtet dekker også hvor e-postlistene finnes og hvordan de brukes',
      'Analyseside i Asoldi CMS med kundens egne rangeringsdata',
      'Grunrapport hver fjortende (14) dag i CMS-analysesiden (rangering og et sammendrag av perioden)',
    ],
    monthlyWork: SEO_MONTHLY_NB,
    kpis: {
      lead: 'Rapportering og KPI-er (grunrapport, hver 14. dag):',
      bullets: [
        'Kunden får analysesiden i Asoldi CMS, med egne søkeordsrangeringer og kjerne-nøkkeltall (trafikk, avvisningsrate, konvertering og tilhørende målinger)',
        'Asoldi lager en grunrapport hver fjortende (14) dag. Rapporten leveres i CMS-analysesiden og inneholder rangering og et sammendrag av perioden',
        'En separat PDF-rapport inngår ikke med mindre det er avtalt skriftlig',
        'Asoldi garanterer ikke bestemte rangeringer, trafikk- eller omsetningstall. SEO er løpende arbeid uten lovet kommersielt resultat',
      ],
    },
  },
  3: {
    title: 'Nivå 3 – Nettside + nettbutikk',
    lead: 'Inkluderer alt i nivå 2, pluss:',
    includes: [
      'Inntil ti (10) hovedsider',
      'Nettbutikkfunksjonalitet (butikkoppsett, produktsider, utsjekk, kunderegistrering)',
      'Flerspråklig funksjonalitet (nettside og butikk kan vises på flere språk)',
      'Analyseside i Asoldi CMS med kundens egne rangeringsdata og dypere nettbutikk-nøkkeltall',
      'Avansert rapport hver sjuende (7) dag i CMS-analysesiden (rangering og et dypere sammendrag enn nivå 2)',
      'Det ene veiledningsmøtet dekker også nettbutikk: legge inn produkter, legge til kunder og koble til betalingsløsning, pluss analysesiden',
    ],
    monthlyWork: SEO_MONTHLY_NB,
    kpis: {
      lead: 'Rapportering og KPI-er (avansert rapport, hver 7. dag):',
      bullets: [
        'Kunden får analysesiden i Asoldi CMS, med egne søkeordsrangeringer og dypere nøkkeltall (trafikk, avvisningsrate, konvertering, nettbutikk-målinger og tilhørende data)',
        'Asoldi lager en avansert rapport hver sjuende (7) dag. Rapporten leveres i CMS-analysesiden og inneholder rangering og et dypere sammendrag enn grunrapporten på nivå 2',
        'Nettbutikk-nøkkeltall som kjøp, konverteringsrate og gjennomsnittlig ordreverdi (AOV) inngår i samme ukentlige rapport',
        'En separat PDF-rapport inngår ikke med mindre det er avtalt skriftlig',
        'Asoldi garanterer ikke bestemte rangeringer, trafikk- eller omsetningstall. SEO er løpende arbeid uten lovet kommersielt resultat',
      ],
    },
    extraBlocks: [{
      lead: 'Månedlig nettbutikkarbeid som inngår i dette nivået:',
      bullets: [
        'Butikk, produktsider, utsjekk og kunderegistrering holdes tilgjengelig og vedlikeholdt så lenge abonnementet er aktivt',
        'Rimelige justeringer i katalog og utsjekk innenfor den månedlige endringskvoten, med mindre en større ombygging avtales særskilt',
      ],
    }],
  },
};

export function localizedTierContract(tier, language = 'nb') {
  if (!tier?.contract) return { title: '', lead: '', includes: [] };
  if (normalizeContractLanguage(language) === 'en') return tier.contract;
  return TIER_CONTRACT_NB[tier.tierNumber] || tier.contract;
}

function copyEn() {
  return {
    language: 'en',
    h1: 'SERVICE AGREEMENT',
    htmlTitle: 'Service agreement',
    htmlSub: 'Website development, hosting and maintenance',
    dateLabel: 'Date',
    between: 'Between',
    and: 'And',
    providerHeading: 'Service provider',
    clientHeading: 'Client',
    labels: {
      company: 'Company',
      org: 'Org. nr.',
      address: 'Address',
      email: 'Email',
      signatory: 'Signatory',
      provider: 'Service Provider',
      client: 'Client',
      innehaver: 'Innehaver / signatory',
    },
    introOpen: (provider, clientName) => (
      `This Service Agreement ("Agreement") is entered into between ${provider} ("Service Provider" or "Asoldi") and ${clientName} ("Client").`
    ),
    introPurposeLead: 'The purpose of this Agreement is to define the terms under which Asoldi provides website development, hosting, maintenance and digital services to the Client under the service scope described in Section 1.',
    introLegal: `The published Terms (${LEGAL_URLS.vilkar}), Privacy Policy (${LEGAL_URLS.personvern}) and Data Processing Agreement (${LEGAL_URLS.databehandleravtale}) form part of this Agreement as they stand on the signing date.`,
    scopeHeading: '1. Service scope',
    scopeHeadingPdf: '1. SERVICE SCOPE',
    selectedTier: 'The Client has selected the following service tier:',
    selectedCustom: 'The Client has selected the following custom service scope (verified offer):',
    selectedTierPlus: 'The Client has selected the following service tier with agreed additions (verified offer):',
    customTitle: 'Custom scope – Website + agreed services',
    product: 'Product',
    pagesBit: (n) => ` – up to ${n} main pages`,
    extraTermsLead: 'Additional terms for this scope:',
    dualIntro: 'The Client is offered the following alternative service scopes. The Client selects Tilbud 1 or Tilbud 2 at signing.',
    vatNote: 'All monthly prices are excluding VAT (25 % VAT is added on the invoice) unless the offer states VAT is included. The service is a running monthly subscription covering development, hosting and maintenance. One-time add-ons listed in Section 1, if any, are billed once and are not part of the monthly price.',
    vatNoteHtml: 'All monthly prices are excluding VAT unless the offer says the price includes VAT. The service is a running monthly subscription covering development, hosting and maintenance. One-time add-ons listed in Section 1, if any, are billed once and are not part of the monthly price.',
    monthlyPrice: 'Monthly price',
    monthlyPriceTotal: 'Monthly price (total)',
    exclVat: 'excl. VAT',
    inclVat: 'incl. VAT',
    billedMonthly: 'billed monthly',
    billedOnce: 'billed once',
    vatIncludedNote: 'VAT is included in the quoted price',
    oneTimeLead: 'One-time add-ons included in this agreement (billed once, not monthly):',
    paymentHeading: '2. Payment terms',
    paymentHeadingPdf: '2. PAYMENT TERMS',
    durationHeading: '3. Contract duration and cancellation',
    durationHeadingPdf: '3. CONTRACT DURATION & CANCELLATION',
    paymentTerms: [
      'Monthly payments are made on the 1st of each month.',
      'The first month is billed with pro-rated pricing, calculated as: (Monthly price ÷ days in month) × days remaining in the month after delivery.',
      'First-month invoice is due within 7 days of product delivery.',
      'All subsequent invoices are due within 7 days of issue.',
      'Accepted payment methods: Bank transfer and Stripe.',
      'There is no establishment fee for starting the monthly subscription. One-time add-ons listed in Section 1, if any, are billed once on the first invoice after delivery (excluding VAT unless the offer states VAT is included).',
      'Late payments are charged as statutory default interest and collection fees under applicable Norwegian law (forsinkelsesrente og gebyrer etter gjeldende norsk lov). Continued non-payment may result in service suspension and contract termination (see Section 13).',
    ],
    durationTerms: [
      'Minimum binding period: 6 months.',
      "Cancellation requires 15 days' notice, and the Client pays for the entire cancellation month.",
      'Clients cannot downgrade to a lower tier once higher-level functionality has been added.',
      'The Client permanently owns the website content, design and any custom code developed specifically for them. Ownership does not revert to Asoldi after cancellation or after any waiting period.',
      'Within seven (7) business days after the subscription ends, Asoldi delivers access to the website files as they stand at termination (a snapshot of the live site).',
      'If the Client wants Asoldi to install the site on a new host or domain, that work is optional and billed at the then-current hosting setup / migration fee published on asoldi.com. This Agreement does not fix that fee, because it can change.',
      'If the Client leaves the Asoldi hosting network, they keep the exported website as it is at termination, but they lose ongoing subscription services: continual website updates, the Asoldi client backlink network, CMS product updates, location-based SEO blog writing, SEO operations, support and other running services described in the Terms.',
    ],
    s4: {
      heading: '4. Incorporated legal documents',
      paragraphs: ['The following published documents form part of this Agreement:'],
      bullets: [
        `The same service meanings, monthly work, KPIs and general terms are also published at ${LEGAL_URLS.vilkar}.`,
        `Privacy information is published at ${LEGAL_URLS.personvern}.`,
        `The Data Processing Agreement (databehandleravtale) is published at ${LEGAL_URLS.databehandleravtale}.`,
        'Those pages, as they stand on the signing date of this Agreement, form part of this Agreement. The parties, price, chosen scope, service meanings in Section 5, late-payment rule, liability cap, ownership and offboarding terms in this document prevail if they conflict with the website.',
      ],
    },
    s5: {
      heading: '5. Scope of work and service meanings',
      paragraphs: [
        'Section 1 is the short list of what this Client has bought. The descriptions below say what those services mean. They apply to every standard website tier and to a custom scope that uses the same service names. A service that is not listed in Section 1 is not included.',
      ],
      after: [
        'Revisions include: text iteration, adding a section, or adding functionality. Fixing typos or correcting factual errors is not considered a revision.',
        'Redesigns or work outside the plan will incur additional costs agreed upon by both parties.',
        `The Norwegian public wording of the same catalogue is at ${LEGAL_URLS.vilkar}.`,
      ],
    },
    s6: {
      heading: '6. Delivery guarantee',
      paragraphs: ['If Asoldi fails to deliver the website within the timeframe stated in Section 1, the Client receives one (1) month of service free of charge.'],
    },
    s7: {
      heading: '7. Hosting failure',
      paragraphs: [
        'If Asoldi becomes unable to host the website for any reason for a prolonged amount of time, the Client receives one (1) month of service free of charge.',
        'Any further liability for damage arising from such a failure is limited as stated in Section 12: six (6) months of the chosen tier’s fees (excluding VAT), except where mandatory Norwegian law provides otherwise.',
      ],
    },
    s8: {
      heading: '8. Intellectual property and ownership',
      numbered: [
        'During the subscription period, the Client has full rights to use the website.',
        'The Client permanently owns the website content (including customer and form data the Client controls), the website design, and any custom code developed specifically for them. This ownership does not revert to Asoldi.',
        'Asoldi owns the hosting environment, DNS management tooling, the Asoldi CMS software, shared platform components and third-party licenses. Leaving the subscription does not transfer those platform assets.',
        'After cancellation Asoldi delivers the site files within seven (7) business days (see Section 3). The Client may hire Asoldi to install the export on a new host at the hosting setup fee published on asoldi.com.',
      ],
    },
    s9: {
      heading: '9. Support and maintenance',
      paragraphs: ['Support hours: 09:00–16:00 (CET).', 'Response times:'],
      bullets: ['Standard requests: 1–3 days', 'Urgent issues: within 1 day'],
    },
    s10: {
      heading: '10. Client responsibilities',
      paragraphs: ['The Client must provide, within a reasonable time after signing:'],
      bullets: [
        'Logo(s)',
        'Images and/or videos needed for the website',
        'Domain access so Asoldi can connect the domain to hosting',
        'Access to the Client’s POS / cash-register system (API keys, admin login or vendor contact) when POS connection is included in Section 1',
        'Access to the Client’s existing host and domain registrar when third-party hosting is included in Section 1',
        'Any other material that is necessary to build and launch the website',
      ],
      after: [
        'Optionally, the Client may also provide inspiration materials, a colour scheme and the preferred site language. These help the build but are not required for Asoldi to start.',
        'If the Client does not provide the necessary details and access in Section 10 within a reasonable time, Sections 6 and 7 do not apply: the Client is not entitled to free service or other compensation for late delivery or hosting failure caused or prolonged by that delay.',
      ],
    },
    s11: {
      heading: '11. GDPR and data processing',
      paragraphs: [
        'The Client is the data controller for personal data collected via the Client website (forms, ecommerce, email lists and similar). Asoldi is the data processor.',
        `The Data Processing Agreement at ${LEGAL_URLS.databehandleravtale} applies and describes storage locations, subprocessors, security, deletion and end-of-contract handling.`,
        `Asoldi’s own processing of the Client as Asoldi’s customer is described in ${LEGAL_URLS.personvern}.`,
      ],
      numbered: [
        'Asoldi may access Client website data only to host, maintain, secure and operate the service.',
        'The Client is responsible for GDPR compliance toward its own end customers, including privacy notices on its website.',
      ],
    },
    s12: {
      heading: '12. Limitation of liability',
      paragraphs: ['Asoldi is not liable for:'],
      bullets: ['Indirect, incidental, or consequential damages', 'Loss of revenue, business, or data'],
      after: [
        'Asoldi’s aggregate liability arising out of this Agreement is limited to the subscription fees paid by the Client for the six (6) months immediately preceding the claim (excluding VAT), except where mandatory Norwegian law provides otherwise.',
        'The person that signs confirms that they have the authority to make marketing decisions within the business this contract refers to. If not, this contract is invalid.',
      ],
    },
    s13: {
      heading: '13. Portfolio rights',
      paragraphs: ["Asoldi may display the Client's website in portfolios, advertisements, and promotional materials unless the Client opts out."],
    },
    s14: {
      heading: '14. Payment default and suspension',
      paragraphs: ['If payment is not received within 7 days of the due date, a reminder will be sent to the Client.', 'If payment is not received within 14 days of the due date:'],
      bullets: [
        'The website may be temporarily suspended (taken offline) until payment is received',
        'Statutory default interest and collection fees under applicable Norwegian law (forsinkelsesrente og gebyrer etter gjeldende norsk lov) will apply',
      ],
      after: [
        'If payment is not received within 30 days, outstanding amounts may be sent to debt collection in accordance with Norwegian law. The Client remains liable for all unpaid invoices.',
        'Asoldi reserves the right to suspend services immediately if fraudulent payment activity is detected.',
      ],
    },
    s15: {
      heading: '15. Governing law',
      paragraphs: ['This Agreement is governed by the laws of Norway.'],
    },
    signHeading: 'Contract and scope signing',
    signHeadingPdf: 'CONTRACT & SCOPE SIGNING',
    signAgree: 'By signing below, both parties agree to all terms stated in this Agreement.',
    chosenScope: 'Chosen scope:',
    chosenDual: 'Tilbud 1 or Tilbud 2.',
    acceptNote: 'The client signs this agreement in the client portal by clicking “Jeg aksepterer avtalen”.',
    dualChoiceNote: 'Choose Tilbud 1 or Tilbud 2 below, then accept the agreement in the client portal.',
    signature: 'Signature',
    forProvider: (name) => `For ${name}`,
    forClient: (name) => `For Client (${name})`,
    signatureOf: (name) => `Signature (${name})`,
    customScopeBox: 'Custom scope (Section 1)',
    feePos: 'POS / cash-register connection (kassasystem)',
    feeHost: 'Third-party host and domain connection',
    pdfTitle: (scope) => `Service Agreement – ${scope}`,
    pdfSubject: (party) => `Website service agreement for ${party}`,
    placeholders: {
      business: '[Business name]',
      org: '[Org. number]',
      address: '[Business address]',
      person: '[Contact person]',
      email: '[Email]',
    },
  };
}

function copyNb() {
  return {
    language: 'nb',
    h1: 'TJENESTEAVTALE',
    htmlTitle: 'Tjenesteavtale',
    htmlSub: 'Nettsideutvikling, hosting og vedlikehold',
    dateLabel: 'Dato',
    between: 'Mellom',
    and: 'Og',
    providerHeading: 'Tjenesteyter',
    clientHeading: 'Kunde',
    labels: {
      company: 'Foretak',
      org: 'Org.nr.',
      address: 'Adresse',
      email: 'E-post',
      signatory: 'Underskriver',
      provider: 'Tjenesteyter',
      client: 'Kunde',
      innehaver: 'Innehaver / underskriver',
    },
    introOpen: (provider, clientName) => (
      `Denne tjenesteavtalen («Avtalen») inngås mellom ${provider} («Tjenesteyter» eller «Asoldi») og ${clientName} («Kunden»).`
    ),
    introPurposeLead: 'Formålet med Avtalen er å fastsette vilkårene for at Asoldi leverer nettsideutvikling, hosting, vedlikehold og digitale tjenester til Kunden etter omfanget i punkt 1.',
    introLegal: `De publiserte vilkårene (${LEGAL_URLS.vilkar}), personvernerklæringen (${LEGAL_URLS.personvern}) og databehandleravtalen (${LEGAL_URLS.databehandleravtale}) utgjør en del av Avtalen slik de lyder på signeringsdatoen.`,
    scopeHeading: '1. Tjenesteomfang',
    scopeHeadingPdf: '1. TJENESTEOMFANG',
    selectedTier: 'Kunden har valgt følgende tjenestenivå:',
    selectedCustom: 'Kunden har valgt følgende skreddersydde omfang (verifisert tilbud):',
    selectedTierPlus: 'Kunden har valgt følgende tjenestenivå med avtalte tillegg (verifisert tilbud):',
    customTitle: 'Skreddersydd omfang – nettside og avtalte tjenester',
    product: 'Produkt',
    pagesBit: (n) => ` – inntil ${n} hovedsider`,
    extraTermsLead: 'Tilleggsvilkår for dette omfanget:',
    dualIntro: 'Kunden tilbys følgende alternative omfang. Kunden velger Tilbud 1 eller Tilbud 2 ved signering.',
    vatNote: 'Alle månedspriser er ekskl. merverdiavgift (25 % mva legges til på fakturaen) med mindre tilbudet sier at mva er inkludert. Tjenesten er et løpende månedsabonnement som dekker utvikling, hosting og vedlikehold. Engangstillegg som står i punkt 1, hvis noen, faktureres én gang og inngår ikke i månedsprisen.',
    vatNoteHtml: 'Alle månedspriser er ekskl. merverdiavgift med mindre tilbudet sier at prisen inkluderer mva. Tjenesten er et løpende månedsabonnement som dekker utvikling, hosting og vedlikehold. Engangstillegg som står i punkt 1, hvis noen, faktureres én gang og inngår ikke i månedsprisen.',
    monthlyPrice: 'Månedspris',
    monthlyPriceTotal: 'Månedspris (totalt)',
    exclVat: 'eks. mva',
    inclVat: 'inkl. mva',
    billedMonthly: 'faktureres månedlig',
    billedOnce: 'faktureres én gang',
    vatIncludedNote: 'mva er inkludert i oppgitt pris',
    oneTimeLead: 'Engangstillegg som inngår i denne avtalen (faktureres én gang, ikke månedlig):',
    paymentHeading: '2. Betalingsvilkår',
    paymentHeadingPdf: '2. BETALINGSVILKÅR',
    durationHeading: '3. Avtaleperiode og oppsigelse',
    durationHeadingPdf: '3. AVTALEPERIODE OG OPPSIGELSE',
    paymentTerms: [
      'Månedlige betalinger skjer den 1. i hver måned.',
      'Første måned faktureres forholdsmessig: (månedspris ÷ antall dager i måneden) × antall gjenværende dager etter levering.',
      'Faktura for første måned forfaller innen 7 dager etter levering av produktet.',
      'Påfølgende fakturaer forfaller innen 7 dager etter utstedelse.',
      'Godkjente betalingsmetoder: bankoverføring og Stripe.',
      'Det er ingen etableringsavgift for å starte månedsabonnementet. Engangstillegg som står i punkt 1, hvis noen, faktureres én gang på første faktura etter levering (ekskl. mva med mindre tilbudet sier at mva er inkludert).',
      'Ved forsinket betaling påløper forsinkelsesrente og gebyrer etter gjeldende norsk lov. Ved fortsatt manglende betaling kan tjenesten suspenderes og avtalen sies opp (se punkt 13).',
    ],
    durationTerms: [
      'Minste bindingstid er 6 måneder.',
      'Oppsigelse krever 15 dagers varsel, og kunden betaler for hele oppsigelsesmåneden.',
      'Kunden kan ikke nedgradere til et lavere nivå etter at funksjonalitet fra et høyere nivå er lagt til.',
      'Kunden eier varig innholdet på nettsiden, designet og eventuell kode utviklet spesifikt for kunden. Eierskapet går ikke automatisk tilbake til Asoldi etter oppsigelse eller etter en frist.',
      'Innen syv (7) virkedager etter at abonnementet er avsluttet, gir Asoldi kunden tilgang til nettsidefilene slik siden står ved opphør (et øyeblikksbilde av den levende siden).',
      'Dersom kunden ønsker at Asoldi skal sette opp siden hos en ny vert eller på et nytt domene, kan kunden engasjere oss til det. Arbeidet faktureres etter gebyret for hosting-oppsett / overføring som til enhver tid er oppgitt på asoldi.com. Beløpet skrives ikke inn her fordi det kan endres.',
      'Dersom kunden forlater Asoldis hostingnettverk, beholder kunden den eksporterte nettsiden slik den er ved opphør, men mister løpende abonnementstjenester: kontinuerlige nettsideoppdateringer, internlenkenettverket, nye CMS-oppdateringer, stedstilpasset bloggskriving for SEO, øvrig SEO-arbeid, support og andre løpende tjenester beskrevet i vilkårene.',
    ],
    s4: {
      heading: '4. Inkorporerte juridiske dokumenter',
      paragraphs: ['Følgende publiserte dokumenter utgjør en del av Avtalen:'],
      bullets: [
        `Samme tjenesteforklaringer, månedlig arbeid, KPI-er og alminnelige vilkår er også publisert på ${LEGAL_URLS.vilkar}.`,
        `Personverninformasjon er publisert på ${LEGAL_URLS.personvern}.`,
        `Databehandleravtalen er publisert på ${LEGAL_URLS.databehandleravtale}.`,
        'Disse sidene, slik de lyder på signeringsdatoen, utgjør en del av Avtalen. Parter, pris, valgt omfang, tjenesteforklaringene i punkt 5, forsinkelsesregel, ansvarstak, eierskap og avslutningsvilkår i dette dokumentet går foran ved motstrid med nettstedet.',
      ],
    },
    s5: {
      heading: '5. Arbeidsomfang og hva tjenestene betyr',
      paragraphs: [
        'Punkt 1 er den korte listen over hva denne kunden har kjøpt. Forklaringene under sier hva tjenestenavnene betyr. De gjelder alle standardnivåer og skreddersydd omfang som bruker de samme navnene. En tjeneste som ikke står i punkt 1, inngår ikke.',
      ],
      after: [
        'En revisjon omfatter: tekstendringer, tillegg av en seksjon eller tillegg av funksjonalitet. Retting av skrivefeil eller faktiske feil regnes ikke som en revisjon.',
        'Redesign eller arbeid utenfor avtalt pakke medfører ekstra kostnader som avtales mellom partene.',
        `Samme katalog er publisert på ${LEGAL_URLS.vilkar}.`,
      ],
    },
    s6: {
      heading: '6. Leveringsgaranti',
      paragraphs: ['Dersom Asoldi ikke leverer nettsiden innen tidsrammen i punkt 1, får kunden én (1) måned med tjeneste gratis.'],
    },
    s7: {
      heading: '7. Hostingfeil',
      paragraphs: [
        'Dersom Asoldi over lengre tid blir ute av stand til å hoste nettsiden, får kunden én (1) måned med tjeneste gratis.',
        'Eventuelt ytterligere ansvar for skade er begrenset som i punkt 12: seks (6) måneder av valgt nivås vederlag (ekskl. merverdiavgift), med mindre ufravikelig norsk lov gir kunden et mer omfattende krav.',
      ],
    },
    s8: {
      heading: '8. Immaterielle rettigheter og eierskap',
      numbered: [
        'I abonnementsperioden har kunden full rett til å bruke nettsiden.',
        'Kunden eier varig nettsidens innhold (inklusive data kunden selv styrer), designet og eventuell kode utviklet spesifikt for kunden. Dette eierskapet går ikke tilbake til Asoldi.',
        'Asoldi eier hostingmiljøet, verktøy for DNS-administrasjon, Asoldi CMS-programvaren, felles plattformkomponenter og tredjepartslisenser. Oppsigelse overfører ikke disse plattformressursene.',
        'Etter oppsigelse leverer Asoldi nettsidefilene innen syv (7) virkedager (se punkt 3). Kunden kan engasjere Asoldi til å sette opp eksporten hos en ny vert mot gebyret for hosting-oppsett som er oppgitt på asoldi.com.',
      ],
    },
    s9: {
      heading: '9. Support og vedlikehold',
      paragraphs: ['Supporttider: 09:00–16:00 (CET).', 'Responstid:'],
      bullets: ['Standardforespørsler: 1–3 dager', 'Hastesaker: innen 1 dag'],
    },
    s10: {
      heading: '10. Kundens ansvar',
      paragraphs: ['Kunden skal innen rimelig tid etter signering levere:'],
      bullets: [
        'Logo(er)',
        'Bilder og/eller videoer som trengs til siden',
        'Domenetilgang slik at Asoldi kan koble domenet til hosting',
        'Tilgang til kundens kassasystem (API-nøkler, admininnlogging eller leverandørkontakt) når kassasystem-oppkobling inngår i punkt 1',
        'Tilgang til eksisterende vert og domeneregistrator når tredjeparts hosting inngår i punkt 1',
        'Annet materiale som er nødvendig for å bygge og lansere siden',
      ],
      after: [
        'Kunden kan i tillegg gi inspirasjonsmateriell, fargepalett og ønsket språk på siden. Dette hjelper arbeidet, men er ikke påkrevd for at Asoldi skal starte.',
        'Dersom kunden ikke leverer nødvendige opplysninger og tilganger i punkt 10 innen rimelig tid, gjelder ikke punkt 6 og 7: kunden har da ikke krav på gratis tjeneste eller annen kompensasjon for forsinket levering eller hostingfeil som skyldes eller forlenges av den forsinkelsen.',
      ],
    },
    s11: {
      heading: '11. GDPR og databehandling',
      paragraphs: [
        'Kunden er behandlingsansvarlig for personopplysninger som samles inn via kundens nettside (skjemaer, nettbutikk, e-postlister og lignende). Asoldi er databehandler.',
        `Databehandleravtalen på ${LEGAL_URLS.databehandleravtale} gjelder og beskriver lagringssted, underleverandører, sikkerhet, sletting og håndtering ved opphør.`,
        `Asoldis egen behandling av kunden som Asoldis kunde er beskrevet i ${LEGAL_URLS.personvern}.`,
      ],
      numbered: [
        'Asoldi kan bare bruke kundens nettsidedata for å hoste, vedlikeholde, sikre og drifte tjenesten.',
        'Kunden er ansvarlig for GDPR-etterlevelse overfor sine egne sluttkunder, inkludert personvernerklæring på egen nettside.',
      ],
    },
    s12: {
      heading: '12. Ansvarsbegrensning',
      paragraphs: ['Asoldi er ikke ansvarlig for:'],
      bullets: ['Indirekte, tilfeldig eller følgeskade', 'Tap av omsetning, virksomhet eller data'],
      after: [
        'Asoldis samlede ansvar etter Avtalen er begrenset til abonnementsvederlaget kunden har betalt for de seks (6) månedene umiddelbart før kravet (ekskl. merverdiavgift), med mindre ufravikelig norsk lov gir noe annet.',
        'Den som signerer bekrefter å ha fullmakt til å ta markedsføringsbeslutninger for virksomheten Avtalen gjelder. Uten slik fullmakt er Avtalen ugyldig.',
      ],
    },
    s13: {
      heading: '13. Portfoliorettigheter',
      paragraphs: ['Asoldi kan vise kundens nettside i porteføljer, annonser og markedsmateriell med mindre kunden reserverer seg.'],
    },
    s14: {
      heading: '14. Betalingsmislighold og suspensjon',
      paragraphs: ['Hvis betaling ikke er mottatt innen 7 dager etter forfall, sendes en purring til kunden.', 'Hvis betaling ikke er mottatt innen 14 dager etter forfall:'],
      bullets: [
        'Nettsiden kan midlertidig tas ned til betaling er mottatt',
        'Forsinkelsesrente og gebyrer etter gjeldende norsk lov påløper',
      ],
      after: [
        'Hvis betaling ikke er mottatt innen 30 dager, kan utestående beløp sendes til inkasso i samsvar med norsk lov. Kunden er fortsatt ansvarlig for alle ubetalte fakturaer.',
        'Asoldi kan stanse tjenestene umiddelbart hvis det avdekkes svindel knyttet til betaling.',
      ],
    },
    s15: {
      heading: '15. Lovvalg',
      paragraphs: ['Avtalen er underlagt norsk lov.'],
    },
    signHeading: 'Signering av avtale og omfang',
    signHeadingPdf: 'SIGNERING AV AVTALE OG OMFANG',
    signAgree: 'Ved å signere nedenfor er begge parter enige i alle vilkår i Avtalen.',
    chosenScope: 'Valgt omfang:',
    chosenDual: 'Tilbud 1 eller Tilbud 2.',
    acceptNote: 'Kunden signerer Avtalen i kundeportalen ved å trykke «Jeg aksepterer avtalen».',
    dualChoiceNote: 'Velg Tilbud 1 eller Tilbud 2 under, og godta deretter Avtalen i kundeportalen.',
    signature: 'Signatur',
    forProvider: (name) => `For ${name}`,
    forClient: (name) => `For kunden (${name})`,
    signatureOf: (name) => `Signatur (${name})`,
    customScopeBox: 'Skreddersydd omfang (punkt 1)',
    feePos: 'Kassasystem-oppkobling',
    feeHost: 'Tredjeparts host og domenekobling',
    pdfTitle: (scope) => `Tjenesteavtale – ${scope}`,
    pdfSubject: (party) => `Tjenesteavtale for nettside for ${party}`,
    placeholders: {
      business: '[Bedriftsnavn]',
      org: '[Org.nr.]',
      address: '[Forretningsadresse]',
      person: '[Kontaktperson]',
      email: '[E-post]',
    },
  };
}

export function contractCopy(language = 'nb') {
  return normalizeContractLanguage(language) === 'en' ? copyEn() : copyNb();
}

export function feeTitleFor(name = '', language = 'nb') {
  const raw = String(name ?? '').trim();
  const t = contractCopy(language);
  if (/kassa|pos|cash.?register/i.test(raw)) return t.feePos;
  if (/tredjeparts host|third-party host/i.test(raw)) return t.feeHost;
  return raw;
}

// Asoldi's push on the shared fact merger: the Kundedata field schema and the Norwegian prompt text.
// Data and prompt text only; core/facts does the merging.

const HEX = '^#(?:[0-9a-f]{3}|[0-9a-f]{6})$';

/** Kundedata fields the assistant may fill from free text. append = grows per line, multi = " / " list, single = one value. */
export const KUNDEDATA_FACT_SCHEMA = {
  maxChars: 500,
  fields: {
    companyAddress: { path: ['generalInfo', 'companyAddress'], kind: 'single' },
    companyPhone: { path: ['generalInfo', 'companyPhone'], kind: 'multi', compare: 'digits' },
    companyEmail: { path: ['generalInfo', 'companyEmail'], kind: 'multi' },
    websiteUrl: { path: ['generalInfo', 'websiteUrl'], kind: 'single' },
    instagramUrl: { path: ['generalInfo', 'instagramUrl'], kind: 'single' },
    facebookUrl: { path: ['generalInfo', 'facebookUrl'], kind: 'single' },
    industry: { path: ['businessCard', 'industry'], kind: 'single' },
    websiteGoal: { path: ['businessCard', 'websiteGoal'], kind: 'append' },
    town: { path: ['websiteCreatorQuestions', 'town'], kind: 'single' },
    country: { path: ['websiteCreatorQuestions', 'country'], kind: 'single' },
    websiteLanguage: { path: ['generalInfo', 'websiteLanguage'], kind: 'single' },
    toneOfVoice: { path: ['websiteCreatorQuestions', 'toneOfVoice'], kind: 'append' },
    businessWhat: { path: ['websiteCreatorQuestions', 'businessWhat'], kind: 'append' },
    businessStory: { path: ['websiteCreatorQuestions', 'businessStory'], kind: 'append' },
    differentiator: { path: ['websiteCreatorQuestions', 'differentiator'], kind: 'append' },
    targetAudience: { path: ['websiteCreatorQuestions', 'targetAudience'], kind: 'append' },
    keyMessage: { path: ['websiteCreatorQuestions', 'keyMessage'], kind: 'append' },
    extraContext: { path: ['websiteCreatorQuestions', 'extraContext'], kind: 'append' },
    wantedPages: { path: ['websiteCreatorQuestions', 'wantedPages'], kind: 'append' },
    customSections: { path: ['websiteCreatorQuestions', 'customSections'], kind: 'append', hint: 'egne seksjoner de vil ha på siden' },
    mainCtaText: { path: ['websiteCreatorQuestions', 'mainCtaText'], kind: 'single', hint: 'teksten på hovedknappen, f.eks. «Bestill time»' },
    reviews: { path: ['websiteCreatorQuestions', 'reviews'], kind: 'append', maxChars: 3000, hint: 'kundeomtaler de limte inn, én per linje' },
    websiteDomain: { path: ['websiteCreatorQuestions', 'websiteDomain'], kind: 'single', hint: 'domenet de har eller vil ha, f.eks. bakkes.no' },
    orgNumber: { path: ['brandIdentity', 'orgNumber'], kind: 'single' },
    primaryColor: { path: ['brandIdentity', 'colors', 'primary'], kind: 'single', pattern: HEX, patternFlags: 'i' },
    secondaryColor: { path: ['brandIdentity', 'colors', 'secondary'], kind: 'single', pattern: HEX, patternFlags: 'i' },
    accentColor: { path: ['brandIdentity', 'colors', 'accent'], kind: 'single', pattern: HEX, patternFlags: 'i' },
  },
};

/** Client-platform chapters the assistant can jump to. */
export const KUNDEDATA_CHAPTERS = ['products', 'media', 'logo', 'staff', 'hours', 'affiliations'];

const MERGE_RULES = `«current» er det som allerede står i kundedata. Sammenlign med det og sett fieldActions for hvert felt du fyller:
- add (standard): ny info i tillegg til det som står der («vi tilbyr også …», en omtale til, en side til). Skriv bare det nye — vi legger det til selv.
- replace: kunden retter eller bytter ut («nytt nummer», «vi har flyttet til …», «ikke X, men Y», «endre … til …»). Skriv hele den nye verdien.
- delete: kunden ber om å fjerne noe («fjern», «vi har ikke lenger», «dropp …»). Skriv det som skal bort, eller tom streng for å tømme feltet.
Felt med én verdi (adresse, nettside, sosiale lenker, domene, farger, org.nr, bransje, by, land, språk, knappetekst): en ny verdi er replace. Telefon og e-post: et ekstra nummer er add, et nytt i stedet for det gamle er replace.
Er du usikker, bruk add — da forsvinner ingenting.
people: add for en ny person, update for endringer hos en som står i current.staff, remove når personen har sluttet eller skal fjernes.
partners: add legger til navn, replace bytter ut hele gruppen, remove fjerner navnene (hele gruppen hvis titles er tom).
hoursAction: replace når de gir hele uka, update når de bare endrer noen dager («lørdag stengt fra nå»).
removeProducts: bare produkter de sier de ikke har lenger. Nye produkter og nye priser går i productText.`;

const EMAIL_RULES = `
Dette er en e-post fra kunden (med eventuelle vedlegg som tekst). Møtetider, avlysninger, spørsmål til oss, hilsener og signaturer er IKKE kundedata. Telefon og e-post i signaturen er personens egne, ikke firmaets — bruk dem bare hvis de skriver at det er firmaets. Er det ingen fakta om bedriften eller nettsiden, svar med tomme felt.`;

/** Arguments for core buildFactPrompt (minus schema/source). */
export const ASOLDI_FACT_PROMPT = {
  labels: {
    intro: 'Du tar imot det en kunde skriver og sorterer det i kundedata. Du finner ikke på fakta, og du spør ikke om noe de ikke nevnte.',
    json: 'Svar JSON:',
    fieldName: '<feltnavn fra fields>',
  },
  shape: [
    '"reply": "én kort bekreftelse på norsk av det du faktisk la inn, eller tom streng"',
    '"chapter": "products"|"media"|"logo"|"staff"|"hours"|"affiliations"|null',
    '"hoursText": "bare hvis de oppga åpningstider, gjerne «mandag 09:00-17:00» eller «åpent hele tiden»"',
    '"hoursAction": "replace"|"update"',
    '"people": [{"name":"","title":"","phone":"","email":"","action":"add"|"update"|"remove"}]',
    '"partners": [{"categoryName":"","titles":[""],"action":"add"|"replace"|"remove"}]',
    '"productText": "bare hvis de listet nye eller endrede produkter, tjenester eller en meny"',
    '"removeProducts": ["produkter/tjenester de sier de ikke har lenger"]',
  ],
  mediaLine: '"mediaFiles": [{ "fileName": "", "bucket": "logos"|"mainHeroImages"|"aboutImages"|"teamImages"|"locationImages"|"icons"|"illustrationImages"|"offeringImages"|"galleryImages"|"uncategorized", "isLogo": false }]',
  footer: 'chapter settes bare når de ber om å bytte kapittel. mediaFiles bare når de sier hva et vedlegg er (logo, hovedbilde, ansatte, …). Farger kun som #hex. Tomme felt betyr at de ikke sa det.',
  mergeRules: MERGE_RULES,
  sourceRules: { email: EMAIL_RULES },
};

/** Default partner group name when the customer names none. */
export const ASOLDI_DEFAULT_PARTNER_GROUP = 'Partnere';

// Asoldi's push on the shared inbox pipeline: mail kinds, reply intents, the tone brief and the
// Norwegian prompt text. Data and prompt text only; routing logic lives in core/inbox and the app.

export const ASOLDI_INBOX_KINDS = ['signed_contract', 'client_elements', 'edit_request', 'workshop_time', 'other'];

export const ASOLDI_REPLY_INTENTS = [
  'sales_book',
  'sales_propose',
  'sales_cancel',
  'sales_call',
  'walk_away',
  'gather',
  'none',
];

/** What the client asks for in a meeting-stage mail; the app maps each to a reply or a card change. */
export const ASOLDI_CLIENT_REQUESTS = [
  'confirm',
  'reschedule',
  'reschedule_day',
  'cancel',
  'question',
  'call',
  'not_now',
  'not_interested',
  'info',
  'contract',
  'other',
];

export const ASOLDI_CHECKUP_FORMATS = ['sms', 'ring', 'email'];

export const ASOLDI_INBOX_BRIEF = `Asoldi er et norsk byrå som lager nettsider for lokale bedrifter. Du svarer som Alexander, kort og vanlig — som i en ekte e-post, ikke en mal.
Du svarer bare kunder som ennå ikke har hatt salgsmøtet. Møtet er et online møte der vi viser et gratis, uforpliktende utkast til ny nettside for bedriften deres. Etter møtet får de et skriftlig tilbud. Finn aldri på pris, rabatt, leveringstid eller at noe er signert, og lov ingenting om kontrakt eller tilbud.
Fakta du kan bruke: møtet og utkastet er gratis og uforpliktende. Prisen avhenger av hva bedriften trenger; den går vi gjennom på møtet, og så får de et skriftlig tilbud. Lenken til møtet står i kalenderinvitasjonen (bruk "meetLink" bare hvis den finnes). Si ALDRI hvor lenge møtet varer.
Dato: "today" er i dag. "bookedMeeting" er møtet som står nå (tom = ingen avtalt tid). Er "meetingPassed" true, har møtet vært uten at vi fikk gjennomført det — foreslå en ny tid fra "offerTimes". Nevn aldri en dag eller tid som er passert.
Klokkeslett: bruk KUN tidene i "offerTimes" eller "bookedMeeting" (ellers ingen klokkeslett). Systemet booker, flytter og avlyser selv; skriv aldri at et møte er flyttet eller booket.
Tone: rolig, vennlig og saklig, du-form, 2–4 setninger. Ingen «synd», ingen mas. Har kunden måttet gjenta seg, er en kort, rolig beklagelse fin («beklager at det ble rotete»), men ikke overdriv skyld.`;

/** JSON shape + request rules appended to the brief for the reply decision. */
export const ASOLDI_DECIDE_RULES = `Les "thread.fresh" (kundens nye tekst; "thread.thread" er bare kontekst). "request" er systemets egen tolkning — si deg uenig hvis teksten sier noe annet.
Svar JSON:
{
  "request": "confirm"|"reschedule"|"reschedule_day"|"cancel"|"question"|"call"|"not_now"|"not_interested"|"info"|"contract"|"other",
  "reply": "norsk e-posttekst eller tom",
  "subject": "kort emne eller tom",
  "checkupNote": "ALLTID: 1–2 setninger til selgeren om hva kunden vil, f.eks. «Kunden kan ikke torsdag og ba om en ny tid.» Ingen klokkeslett."
}
request:
- confirm: bekrefter, takker, «sees». reply = tom.
- reschedule: gir en ny dato OG et klokkeslett for møtet. reply = tom (systemet bekrefter selv).
- reschedule_day: vil ha en annen dag, uten klokkeslett. reply: spør hvilken av tidene i offerTimes som passer.
- cancel: kan ikke møte, men gir ingen ny tid. reply: takk for beskjed, si at det er helt i orden, og spør hvilken dag og tid som passer bedre — nevn gjerne tidene i offerTimes.
- question: et enkelt spørsmål om hva dette er, hvem vi er, pris, hvordan møtet foregår. reply: svar kort med faktaene over, og si at møtet står som avtalt (bookedMeeting) eller spør hvilken dag som passer.
- call: vil bli ringt. reply: si at vi ringer.
- not_now: vet ikke ennå / vil bli kontaktet senere. reply: helt greit, vi tar kontakt da.
- not_interested: dropper hele møtet. reply: takk for at de sier ifra, spør kort hva som gjorde at det ikke ble aktuelt, og om en kort, uforpliktende prat likevel kan passe.
- info: sender fakta, logo eller bilder uten spørsmål. reply: kort takk, eller tom.
- contract: spør om tilbud, kontrakt, signering, faktura eller betaling. reply = tom (selgeren svarer).
- other: alt annet. reply = tom.`;

export const ASOLDI_CATEGORIZE_PROMPT = `Du kategoriserer innkommende e-post til Asoldi. Finn ikke på fakta.
Svar JSON:
{
  "kind": "signed_contract"|"client_elements"|"edit_request"|"workshop_time"|"other",
  "summary": "én kort setning på norsk",
  "match": { "orgNumber": "", "businessName": "", "email": "" },
  "dueAt": "ISO-8601 i Europe/Oslo eller tom",
  "elements": [{ "fileName": "", "bucket": "logos"|"mainHeroImages"|"aboutImages"|"teamImages"|"locationImages"|"icons"|"illustrationImages"|"offeringImages"|"galleryImages"|"uncategorized", "isLogo": false }]
}
signed_contract = PDF that is our Asoldi service agreement (filename Asoldi-kontrakt, org 934327497, CHAPANA). Whether the client signed the bottom is decided later by size/vision — still kind signed_contract. client_elements = logo, bilder, meny, produkter eller annen nettside-data. workshop_time = de foreslår eller flytter workshop-tid. dueAt kun når tidspunktet er tydelig (dato + klokkeslett). edit_request = de ber om å endre nettsiden uten slike vedlegg. other = resten.
bucket kun når kind er client_elements. match fylles fra e-posten eller PDF-teksten.`;

/** Filename/text cues → Kundedata bucket when no AI is configured. First match wins. */
export const ASOLDI_BUCKET_CUES = [
  { pattern: 'logo|favicon|merke', bucket: 'logos', isLogo: true },
  { pattern: 'hero|hovedbilde|banner|cover', bucket: 'mainHeroImages' },
  { pattern: 'ansatt|team|staff|portrait', bucket: 'teamImages' },
  { pattern: 'lokasjon|location|map|butikk|fasade', bucket: 'locationImages' },
  { pattern: 'om.?oss|about', bucket: 'aboutImages' },
  { pattern: 'meny|menu|rett|tjeneste|offering', bucket: 'offeringImages' },
  { pattern: 'ikon|icon', bucket: 'icons' },
  { pattern: 'illustr', bucket: 'illustrationImages' },
  { pattern: 'galleri|gallery', bucket: 'galleryImages' },
];

/** Inbox row summaries when the subject is empty. */
export const ASOLDI_INBOX_SUMMARIES = {
  signed_contract: 'Kontrakt mottatt som PDF.',
  edit_request: 'Redigeringsforespørsel.',
  client_elements: 'Vedlegg til kundedata.',
  workshop_time: 'Foreslått workshop-tid.',
  other: 'E-post uten kjent type.',
};

/** Edit-request cue (no attachments). */
export const ASOLDI_EDIT_REQUEST_CUE = 'rediger|endre (?:nettsiden|siden|teksten)|fiks|fix the (?:site|page)|change the website';

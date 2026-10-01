/**
 * Developer workshop summary (T07). Norwegian. New function — not the offer briefing helper.
 * Never reads or writes the client data bank.
 */

import { deepseekChatJson } from './deepseek.js';
import { describeMeetingQuote } from './offer-from-quote.js';
import { htmlToPlainText } from './sales-email.js';
import { getWorkshopAction } from './workshop-action.js';
import { getWorkshopRecord, workshopMeetingHappened, WORKSHOP_SUMMARY_LANGUAGE } from './workshop-record.js';

const MAX_TRANSCRIPT_CHARS = 28_000;
const MAX_NOTE_CHARS = 6_000;
const MAX_OFFER_CHARS = 8_000;

export const WORKSHOP_SUMMARY_SECTIONS = ['intro', 'voice', 'whatTheyWant', 'functionality'];
export const NOTES_ONLY_DISCLAIMER =
  'Sammendraget er skrevet fra notater og salgsmøtet, fordi det ikke fantes et workshop-møte med transkript.';

function text(value = '') {
  return String(value ?? '').trim();
}

function clip(value = '', max = 1000) {
  const source = String(value || '');
  if (source.length <= max) return source;
  return `${source.slice(0, max)}\n[... forkortet ...]`;
}

function noteLines(notes = []) {
  return (Array.isArray(notes) ? notes : []).map((note) => {
    const names = Array.isArray(note?.files)
      ? note.files.map((file) => text(file.originalName || file.name)).filter(Boolean)
      : [];
    return [
      text(note?.at) ? `[${note.at}]` : '',
      text(note?.text),
      names.length ? `Vedlegg: ${names.join(', ')}` : '',
    ].filter(Boolean).join(' ');
  }).filter(Boolean);
}

export function collectWorkshopSummaryInputs({
  client = {},
  salesMeeting = {},
  workshopMeeting = {},
  offer = {},
} = {}) {
  const record = getWorkshopRecord(client);
  const workshopAction = getWorkshopAction(client);
  const quote = client?.details?.meetingQuote || {};
  const described = describeMeetingQuote(quote);
  const salesTranscript = text(salesMeeting.transcript || salesMeeting.summary);
  const workshopHappened = workshopMeetingHappened({ workshopAction })
    || Boolean(text(workshopMeeting.transcript));
  const workshopTranscript = workshopHappened ? text(workshopMeeting.transcript || workshopMeeting.summary) : '';
  const fromNotesOnly = !workshopTranscript;
  const offerHtml = text(offer.email?.html);
  const offerLetter = offerHtml ? htmlToPlainText(offerHtml) : '';
  const products = Array.isArray(offer.products) ? offer.products : [];
  return {
    businessName: text(client.businessName),
    industry: text(client.industry),
    salesNotes: text(client.notes),
    productNotes: text(quote.productNotes) || described.notes,
    workshopNotes: noteLines(record.notes),
    salesTranscript,
    workshopTranscript,
    fromNotesOnly,
    offerPlan: described.plan,
    offerGoal: described.goal,
    offerIdentity: described.identity,
    offerCustomSections: described.customSections,
    offerLetter: clip(offerLetter, MAX_OFFER_CHARS),
    offerProducts: products.map((row) => ({
      name: text(row.name),
      pages: Number(row.pages) || 0,
    })),
  };
}

function fallbackSection(label, pieces, extra = '') {
  const body = [...pieces, extra].map(text).filter(Boolean).join('\n\n');
  if (body) return body.slice(0, 1800);
  return `${label} er ikke beskrevet i kildene ennå.`;
}

export function fallbackWorkshopSummary(collected = {}) {
  const notes = [
    collected.salesNotes,
    collected.productNotes,
    ...(Array.isArray(collected.workshopNotes) ? collected.workshopNotes : []),
  ].map(text).filter(Boolean);
  const sales = clip(collected.salesTranscript, 1200);
  const introBits = [
    collected.fromNotesOnly ? NOTES_ONLY_DISCLAIMER : '',
    collected.businessName ? `${collected.businessName}${collected.industry ? ` (${collected.industry})` : ''}.` : '',
    notes[0] || clip(sales, 400),
  ];
  return {
    intro: fallbackSection('Intro', introBits),
    voice: fallbackSection('Voice', [collected.offerIdentity, notes[1] || notes[0], clip(sales, 500)]),
    whatTheyWant: fallbackSection('What they want', [collected.offerGoal, collected.offerCustomSections, collected.offerPlan, notes.join('\n')]),
    functionality: fallbackSection(
      'Functionality',
      [
        collected.offerCustomSections,
        collected.offerPlan,
        Array.isArray(collected.offerProducts) && collected.offerProducts.length
          ? collected.offerProducts.map((row) => [row.name, row.pages ? `${row.pages} sider` : ''].filter(Boolean).join(' · ')).join('; ')
          : '',
      ],
    ),
    generatedAt: new Date().toISOString(),
    source: 'fallback',
    fromNotesOnly: Boolean(collected.fromNotesOnly),
    language: WORKSHOP_SUMMARY_LANGUAGE,
  };
}

const SUMMARY_SYSTEM = `Du skriver et utviklersammendrag på norsk bokmål etter en Asoldi-workshop.
Dette er ikke et tilbudsbrev og ikke et møtereferat. Utvikleren skal forstå kunden.

Skriv fire felt, i denne rekkefølgen:
- intro: hvem kunden er, bransje, hvor de er, og hvordan samtalen var. Hvis kildene sier at sammendraget er fra notater og salgsmøtet, si det her.
- voice: hvordan de snakker og hvordan merkevaren skal føles (tone, formalitet, visuell stil hvis kildene nevner det).
- whatTheyWant: hva de faktisk vil ha ut av nettsiden og samarbeidet. Konkrete ønsker, ikke gjentatt intro.
- functionality: en kort beskrivelse av hva nettsiden må gjøre (booking, meny, blogg, portal, …). Ikke gjenta intro.

Regler:
- Bruk alle kildene sammen: salgstranskript, workshop-transkript hvis det finnes, manuelle workshop-notater, salgsnotater, produktnotater og tilbudet.
- Ikke finn på funksjoner, sider eller priser som ikke står i kildene.
- Ikke lagre noe i kundedatabanken, og ikke skriv filstier.
- Ikke kopier tilbudsbrevet ordrett.
- Functionality skal beskrive hva siden må gjøre, ikke hvem kunden er.

Returner JSON:
{
  "intro": "",
  "voice": "",
  "whatTheyWant": "",
  "functionality": ""
}`;

export function buildWorkshopSummaryUserPrompt(collected = {}) {
  return [
    `Kunde: ${collected.businessName || 'ukjent'}${collected.industry ? ` (${collected.industry})` : ''}`,
    collected.fromNotesOnly ? NOTES_ONLY_DISCLAIMER : 'Det finnes et workshop-transkript. Bruk det sammen med de andre kildene.',
    collected.offerPlan ? `Tilbud / pakke:\n${collected.offerPlan}` : '',
    collected.offerGoal ? `Mål med nettsiden:\n${collected.offerGoal}` : '',
    collected.offerIdentity ? `Identitet:\n${collected.offerIdentity}` : '',
    collected.offerCustomSections ? `Egne seksjoner:\n${collected.offerCustomSections}` : '',
    collected.offerProducts?.length
      ? `Produkter i tilbudet:\n${collected.offerProducts.map((row) => `- ${row.name}${row.pages ? ` (${row.pages} sider)` : ''}`).join('\n')}`
      : '',
    collected.offerLetter ? `Tilbudstekst:\n${clip(collected.offerLetter, MAX_OFFER_CHARS)}` : '',
    collected.salesNotes ? `Salgsnotater:\n${clip(collected.salesNotes, MAX_NOTE_CHARS)}` : '',
    collected.productNotes ? `Produktnotater:\n${clip(collected.productNotes, MAX_NOTE_CHARS)}` : '',
    collected.workshopNotes?.length ? `Manuelle workshop-notater (tekst + filnavn, ingen OCR):\n${collected.workshopNotes.join('\n')}` : '',
    collected.salesTranscript ? `Salgsmøte:\n${clip(collected.salesTranscript, MAX_TRANSCRIPT_CHARS)}` : '(Ingen salgstranskript.)',
    collected.workshopTranscript ? `Workshop-møte:\n${clip(collected.workshopTranscript, MAX_TRANSCRIPT_CHARS)}` : '(Ingen workshop-transkript.)',
  ].filter((line) => line !== '').join('\n\n');
}

/**
 * @returns {{ intro: string, voice: string, whatTheyWant: string, functionality: string, generatedAt: string, source: 'ai'|'fallback', fromNotesOnly: boolean, language: 'nb' }}
 */
export async function summarizeWorkshopForDeveloper({
  client = {},
  salesMeeting = {},
  workshopMeeting = {},
  offer = {},
  deps = {},
} = {}) {
  const collected = collectWorkshopSummaryInputs({ client, salesMeeting, workshopMeeting, offer });
  const fallback = fallbackWorkshopSummary(collected);
  const chat = deps.chat;
  if (typeof chat !== 'function') return fallback;
  const result = await chat({
    system: SUMMARY_SYSTEM,
    user: buildWorkshopSummaryUserPrompt(collected),
    temperature: 0.3,
    maxTokens: 1600,
  });
  const intro = text(result?.intro).slice(0, 2500);
  const voice = text(result?.voice).slice(0, 2500);
  const whatTheyWant = text(result?.whatTheyWant).slice(0, 2500);
  const functionality = text(result?.functionality).slice(0, 2500);
  if (!intro || !voice || !whatTheyWant || !functionality) {
    const error = new Error('Workshop-sammendraget manglet en av de fire seksjonene.');
    error.status = 502;
    throw error;
  }
  return {
    intro: collected.fromNotesOnly && !intro.includes('notater') ? `${NOTES_ONLY_DISCLAIMER}\n\n${intro}` : intro,
    voice,
    whatTheyWant,
    functionality,
    generatedAt: new Date().toISOString(),
    source: 'ai',
    fromNotesOnly: collected.fromNotesOnly,
    language: WORKSHOP_SUMMARY_LANGUAGE,
  };
}

export async function generateWorkshopSummaryWithDeepSeek(payload = {}) {
  return summarizeWorkshopForDeveloper({
    ...payload,
    deps: { chat: deepseekChatJson },
  });
}

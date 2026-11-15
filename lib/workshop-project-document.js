/**
 * Categorized workshop to-do list for Prosjektdokument.
 * Uses T07 collectWorkshopSummaryInputs. Never writes Kundedata.
 */

import { getAutomationSettings } from '../data/automation-settings.js';
import { deepseekChatJson } from './deepseek.js';
import { gateSwitchEnabled } from './delivery-gate.js';
import { duplicateRecordingMap } from './fireflies-slots.js';
import { collectWorkshopSummaryInputs } from './workshop-summary.js';
import {
  getWorkshopRecord,
  mergeWorkshopRecord,
  persistProjectDocument,
} from './workshop-record.js';
import {
  evaluateWorkshopTranscriptWithDeepSeek,
  persistTranscriptEval,
  shouldRetryWorkshopEval,
  workshopDurationMinutes,
} from './workshop-transcript-eval.js';

export { persistProjectDocument, persistProjectTodo, markProjectTodoDone, PROJECT_TODO_CATEGORIES } from './workshop-record.js';

function text(value = '') {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

const PROJECT_SYSTEM = `Du skriver et utvikler-prosjektdokument på norsk bokmål etter en Asoldi-workshop.
Dette er ikke et tilbudsbrev og ikke et møtereferat. Utvikleren skal bygge nettsiden fra dette.

Kilder: workshop-transkriptet er hovedkilden. Salgstranskript, notater og tilbud er støtte. Ikke finn på sider, funksjoner eller priser som ikke står i kildene. Ikke kopier småprat. Ikke skriv filstier. Ikke lagre noe i kundedatabanken.

Skriv JSON:
{
  "goalExplanation": "",
  "clientDocumentation": "",
  "todos": [{ "category": "", "title": "", "detail": "" }]
}

- goalExplanation: hva nettsiden skal oppnå for kunden. Ikke et møtereferat.
- clientDocumentation: hvem de er, stemme, begrensninger, og fakta utvikleren ikke må miste.
- todos: konkrete oppgaver. Hver har category, title, og detail (1–2 setninger: hva kunden sa, og hva utvikleren må gjøre).

category MÅ være nøyaktig én av:
- Sider og innhold
- Funksjon og flyt
- Design og merkevare
- Media og materiell
- Integrasjoner
- Åpne beslutninger
- Utenfor scope

Uavklarte valg → Åpne beslutninger. Eksplisitt «vi skal ikke bygge X» → Utenfor scope. Hopp over smalltalk.`;

const NOTE_LIMIT = 4000;
const SALES_TRANSCRIPT_LIMIT = 12_000;
const WORKSHOP_TRANSCRIPT_LIMIT = 28_000;
const PROJECT_DOCUMENT_MAX_TOKENS = 2200;
const PROJECT_DOCUMENT_UPGRADE_MAX_TOKENS = 4000;

function clipText(value, limit) {
  return String(value).slice(0, limit);
}

/** On when iteration.projectDocument is enabled and not paused. Shadow and auto both use the longer prompt. */
export function projectDocumentUpgradeOn(settings) {
  const node = settings?.iteration?.projectDocument;
  return Boolean(node && node.enabled === true && !node.paused);
}

function transcriptBody(full, map, limit, upgrade) {
  const text = String(full || '');
  if (!upgrade || text.length <= limit) return clipText(text, limit);
  return String(map || '');
}

function productLines(products) {
  if (!Array.isArray(products) || !products.length) return '';
  return products.map((row) => {
    const name = String(row?.name || '').trim();
    if (!name) return '';
    const pages = Number(row.pages) > 0 ? ` (${row.pages} sider)` : '';
    return `- ${name}${pages}`;
  }).filter(Boolean).join('\n');
}

function legacyWorkshopProjectUserPrompt(collected = {}) {
  return [
    `Kunde: ${collected.businessName || 'ukjent'}${collected.industry ? ` (${collected.industry})` : ''}`,
    collected.offerPlan ? `Tilbud / pakke:\n${collected.offerPlan}` : '',
    collected.offerGoal ? `Mål med nettsiden:\n${collected.offerGoal}` : '',
    collected.offerIdentity ? `Identitet:\n${collected.offerIdentity}` : '',
    collected.offerCustomSections ? `Egne seksjoner:\n${collected.offerCustomSections}` : '',
    collected.salesNotes ? `Salgsnotater:\n${clipText(collected.salesNotes, NOTE_LIMIT)}` : '',
    collected.productNotes ? `Produktnotater:\n${clipText(collected.productNotes, NOTE_LIMIT)}` : '',
    collected.workshopNotes?.length ? `Manuelle workshop-notater:\n${collected.workshopNotes.join('\n')}` : '',
    collected.salesTranscript ? `Salgsmøte (støtte):\n${clipText(collected.salesTranscript, SALES_TRANSCRIPT_LIMIT)}` : '',
    collected.workshopTranscript
      ? `Workshop-møte (hovedkilde):\n${clipText(collected.workshopTranscript, WORKSHOP_TRANSCRIPT_LIMIT)}`
      : '(Ingen workshop-transkript.)',
  ].filter(Boolean).join('\n\n');
}

/**
 * Developer project prompt. The second argument defaults to the short prompt: same text as before
 * this switch. With `{ upgrade: true }` the prompt also carries tier, services, offer products and
 * the offer letter, and a transcript longer than the workshop limit is replaced by its map (the
 * meeting summary) instead of a cut.
 */
export function buildWorkshopProjectUserPrompt(collected = {}, { upgrade = false } = {}) {
  if (!upgrade) return legacyWorkshopProjectUserPrompt(collected);
  const tier = String(collected.tier || '').trim();
  const services = (Array.isArray(collected.services) ? collected.services : []).map((item) => String(item || '').trim()).filter(Boolean);
  const products = productLines(collected.offerProducts);
  const letter = String(collected.offerLetter || '').trim();
  return [
    `Kunde: ${collected.businessName || 'ukjent'}${collected.industry ? ` (${collected.industry})` : ''}`,
    `Nivå: ${tier || 'ukjent'}`,
    `Oppsummering: nivå ${tier || 'ukjent'}`,
    services.length ? `Tjenester: ${services.join(', ')}` : '',
    collected.offerPlan ? `Tilbud / pakke:\n${collected.offerPlan}` : '',
    collected.offerGoal ? `Mål med nettsiden:\n${collected.offerGoal}` : '',
    collected.offerIdentity ? `Identitet:\n${collected.offerIdentity}` : '',
    collected.offerCustomSections ? `Egne seksjoner:\n${collected.offerCustomSections}` : '',
    products ? `Produkter i tilbudet:\n${products}` : '',
    letter ? `Tilbudstekst:\n${letter}` : '',
    collected.salesNotes ? `Salgsnotater:\n${clipText(collected.salesNotes, NOTE_LIMIT)}` : '',
    collected.productNotes ? `Produktnotater:\n${clipText(collected.productNotes, NOTE_LIMIT)}` : '',
    collected.workshopNotes?.length ? `Manuelle workshop-notater:\n${collected.workshopNotes.join('\n')}` : '',
    collected.salesTranscript
      ? `Salgsmøte (støtte):\n${transcriptBody(collected.salesTranscript, collected.salesMap, SALES_TRANSCRIPT_LIMIT, true)}`
      : '',
    collected.workshopTranscript
      ? `Workshop-møte (hovedkilde):\n${transcriptBody(collected.workshopTranscript, collected.workshopMap, WORKSHOP_TRANSCRIPT_LIMIT, true)}`
      : '(Ingen workshop-transkript.)',
  ].filter(Boolean).join('\n\n');
}

export function projectDocumentMaxTokens(upgrade) {
  return upgrade ? PROJECT_DOCUMENT_UPGRADE_MAX_TOKENS : PROJECT_DOCUMENT_MAX_TOKENS;
}

function fallbackProjectDocument(collected = {}, meetingId = '') {
  const bits = [
    collected.offerGoal,
    collected.offerPlan,
    collected.workshopTranscript ? String(collected.workshopTranscript).slice(0, 600) : '',
  ].map(text).filter(Boolean);
  return persistProjectDocument({
    meetingId,
    goalExplanation: bits[0] || 'Målet er ikke beskrevet i kildene ennå.',
    clientDocumentation: [collected.businessName, collected.offerIdentity, collected.salesNotes]
      .map(text).filter(Boolean).join('\n\n') || 'Klientdokumentasjon mangler.',
    todos: [],
    source: 'fallback',
  });
}

export async function generateWorkshopProjectDocument({
  client = {},
  salesMeeting = {},
  workshopMeeting = {},
  offer = {},
  meetingId = '',
  deps = {},
} = {}) {
  const collected = collectWorkshopSummaryInputs({ client, salesMeeting, workshopMeeting, offer });
  let settings = deps.settings;
  if (!settings) {
    try {
      settings = getAutomationSettings();
    } catch {
      settings = null;
    }
  }
  const upgrade = projectDocumentUpgradeOn(settings);
  if (upgrade) {
    collected.tier = text(client?.sitePlan?.tierId || client?.portalTierId);
    collected.services = Array.isArray(client?.sitePlan?.services) ? client.sitePlan.services : [];
    collected.salesMap = text(salesMeeting?.summary);
    collected.workshopMap = text(workshopMeeting?.summary);
  }
  const fallback = fallbackProjectDocument(collected, meetingId);
  const chat = deps.chat;
  if (typeof chat !== 'function') return fallback;
  const result = await chat({
    task: 'workshop.project-document',
    ctx: text(client?.id) ? { salesClientId: text(client.id) } : undefined,
    system: PROJECT_SYSTEM,
    user: buildWorkshopProjectUserPrompt(collected, { upgrade }),
    temperature: 0.2,
    maxTokens: projectDocumentMaxTokens(upgrade),
  });
  const goalExplanation = text(result?.goalExplanation).slice(0, 4000);
  const clientDocumentation = text(result?.clientDocumentation).slice(0, 8000);
  const todos = Array.isArray(result?.todos) ? result.todos : [];
  if (!goalExplanation || !clientDocumentation) {
    const error = new Error('Prosjektdokumentet manglet mål eller klientdokumentasjon.');
    error.status = 502;
    throw error;
  }
  return persistProjectDocument({
    meetingId,
    goalExplanation,
    clientDocumentation,
    todos,
    source: 'ai',
  });
}

export async function generateWorkshopProjectDocumentWithDeepSeek(payload = {}) {
  return generateWorkshopProjectDocument({
    ...payload,
    deps: { chat: deepseekChatJson },
  });
}

/**
 * One recorded meeting on the client's card: the same Fireflies id, or two copies of one meeting (a second
 * notetaker, a bot that rejoined) by lib/fireflies-slots.js duplicateRecordingMap.
 */
function sameRecordedMeetingOnCard(client = {}, firstId = '', secondId = '') {
  const first = text(firstId);
  const second = text(secondId);
  if (!first || !second) return false;
  if (first === second) return true;
  const rows = (Array.isArray(client.meetings) ? client.meetings : [])
    .filter((row) => [first, second].includes(text(row?.meetingId)));
  const primaries = duplicateRecordingMap(rows);
  return (primaries.get(first) || first) === (primaries.get(second) || second);
}

export function shouldAutoApplyWorkshopDocument(client = {}, meeting = {}) {
  const meetingId = text(meeting.meetingId || meeting.id);
  if (!meetingId) return false;
  const transcript = text(meeting.transcript || meeting.summary);
  if (!transcript) return false;
  const record = getWorkshopRecord(client);
  const existing = persistProjectDocument(record.projectDocument);
  // A document made from another copy of the same workshop is this workshop's: making it again would only
  // drop the developer's ticked to-dos.
  if (existing?.goalExplanation && sameRecordedMeetingOnCard(client, existing.meetingId, meetingId)) return false;
  const evalRow = persistTranscriptEval(record.transcriptEval);
  if (evalRow?.meetingId === meetingId && evalRow.valid === false && !shouldRetryWorkshopEval(evalRow, meeting)) {
    return false;
  }
  return true;
}

async function schedulePostWorkshopIfGateOn(client = {}, workshopMeeting = {}) {
  if (!text(client?.id) || !gateSwitchEnabled()) return null;
  try {
    const [{ schedulePostWorkshopOnHeld }, sales] = await Promise.all([
      import('./delivery-emails.js'),
      import('../data/sales.js'),
    ]);
    return schedulePostWorkshopOnHeld(client, { workshopMeeting, sales });
  } catch (error) {
    console.warn('[workshop-document] post-workshop schedule failed:', error?.message || error);
    return null;
  }
}

/**
 * @returns {{ skipped?: string, workshop?: object, eval?: object }}
 */
export async function applyWorkshopTranscriptToRecord({
  client = {},
  salesMeeting = {},
  workshopMeeting = {},
  offer = {},
  force = false,
  generateSummary,
  generateDocument = generateWorkshopProjectDocumentWithDeepSeek,
  evaluate = evaluateWorkshopTranscriptWithDeepSeek,
} = {}) {
  const record = getWorkshopRecord(client);
  const meetingId = text(workshopMeeting.meetingId || workshopMeeting.id);
  const transcript = text(workshopMeeting.transcript || workshopMeeting.summary);
  if (!force && !shouldAutoApplyWorkshopDocument(client, workshopMeeting)) {
    return { skipped: 'already-applied' };
  }
  let transcriptEval = persistTranscriptEval(record.transcriptEval);
  if (!force) {
    transcriptEval = await evaluate({
      transcript,
      durationMinutes: workshopDurationMinutes(workshopMeeting),
      businessName: client.businessName,
      meetingId,
      salesClientId: text(client?.id),
    });
    if (!transcriptEval?.valid) {
      return {
        skipped: 'invalid-transcript',
        eval: transcriptEval,
        workshop: mergeWorkshopRecord(record, { transcriptEval }),
      };
    }
  }
  const history = record.summary ? [...record.summaryHistory, record.summary] : record.summaryHistory;
  let summary = record.summary;
  if (typeof generateSummary === 'function') {
    summary = await generateSummary({
      client,
      salesMeeting,
      workshopMeeting,
      offer,
    });
  }
  const projectDocument = await generateDocument({
    client,
    salesMeeting,
    workshopMeeting,
    offer,
    meetingId,
  });
  // The first Prosjektdokument marks the workshop as held: with the gate on, that schedules the
  // post-workshop mail (two hours after the workshop ended, by default).
  if (!record.heldAt) await schedulePostWorkshopIfGateOn(client, workshopMeeting);
  return {
    eval: transcriptEval,
    workshop: mergeWorkshopRecord(record, {
      heldAt: record.heldAt || nowIso(),
      summary,
      summaryHistory: history,
      projectDocument,
      transcriptEval: transcriptEval || persistTranscriptEval({
        meetingId,
        valid: true,
        reason: force ? 'admin-regenerate' : 'valid',
        source: force ? 'hard-gate' : 'ai',
      }),
    }),
  };
}

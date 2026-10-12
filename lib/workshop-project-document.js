/**
 * Categorized workshop to-do list for Prosjektdokument.
 * Uses T07 collectWorkshopSummaryInputs. Never writes Kundedata.
 */

import { deepseekChatJson } from './deepseek.js';
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

export function buildWorkshopProjectUserPrompt(collected = {}) {
  return [
    `Kunde: ${collected.businessName || 'ukjent'}${collected.industry ? ` (${collected.industry})` : ''}`,
    collected.offerPlan ? `Tilbud / pakke:\n${collected.offerPlan}` : '',
    collected.offerGoal ? `Mål med nettsiden:\n${collected.offerGoal}` : '',
    collected.offerIdentity ? `Identitet:\n${collected.offerIdentity}` : '',
    collected.offerCustomSections ? `Egne seksjoner:\n${collected.offerCustomSections}` : '',
    collected.salesNotes ? `Salgsnotater:\n${String(collected.salesNotes).slice(0, 4000)}` : '',
    collected.productNotes ? `Produktnotater:\n${String(collected.productNotes).slice(0, 4000)}` : '',
    collected.workshopNotes?.length ? `Manuelle workshop-notater:\n${collected.workshopNotes.join('\n')}` : '',
    collected.salesTranscript ? `Salgsmøte (støtte):\n${String(collected.salesTranscript).slice(0, 12_000)}` : '',
    collected.workshopTranscript
      ? `Workshop-møte (hovedkilde):\n${String(collected.workshopTranscript).slice(0, 28_000)}`
      : '(Ingen workshop-transkript.)',
  ].filter(Boolean).join('\n\n');
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
  const fallback = fallbackProjectDocument(collected, meetingId);
  const chat = deps.chat;
  if (typeof chat !== 'function') return fallback;
  const result = await chat({
    system: PROJECT_SYSTEM,
    user: buildWorkshopProjectUserPrompt(collected),
    temperature: 0.2,
    maxTokens: 2200,
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

export function shouldAutoApplyWorkshopDocument(client = {}, meeting = {}) {
  const meetingId = text(meeting.meetingId || meeting.id);
  if (!meetingId) return false;
  const transcript = text(meeting.transcript || meeting.summary);
  if (!transcript) return false;
  const record = getWorkshopRecord(client);
  const existing = persistProjectDocument(record.projectDocument);
  if (existing?.meetingId === meetingId && existing.goalExplanation) return false;
  const evalRow = persistTranscriptEval(record.transcriptEval);
  if (evalRow?.meetingId === meetingId && evalRow.valid === false && !shouldRetryWorkshopEval(evalRow, meeting)) {
    return false;
  }
  return true;
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

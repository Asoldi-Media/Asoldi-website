import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepgramListenQuery, formatDeepgramChat, transcribePrerecordedBuffer } from '../lib/deepgram-transcribe.js';
import { buildBookerPreviewUserPrompt, persistPreviewDocument, PREVIEW_SYSTEM, shouldEnqueueBookerPreview } from '../lib/booker-preview-document.js';
import { clientRecordingUrl, prepareRecordingStream } from '../lib/sales-recording-stream.js';
import { hardGateWorkshopTranscript } from '../lib/workshop-transcript-eval.js';
import { applyWorkshopTranscriptToRecord } from '../lib/workshop-project-document.js';
import { markProjectTodoDone, persistProjectDocument } from '../lib/workshop-record.js';
import { primaryDeveloperDocument, DOCUMENT_LABELS } from '../lib/developer-card.js';
import { workshopGoalHeld } from '../lib/workshop-goal-timeline.js';

const here = dirname(fileURLToPath(import.meta.url));

test('unsigned cards open Forhåndsdokument first', () => {
  const unsigned = primaryDeveloperDocument(false);
  assert.equal(unsigned.primary, 'preview');
  assert.equal(unsigned.primaryLabel, DOCUMENT_LABELS.preview);
  assert.equal(unsigned.secondaryLabel, DOCUMENT_LABELS.project);
  const signed = primaryDeveloperDocument(true);
  assert.equal(signed.primary, 'project');
  assert.equal(signed.secondary, 'preview');
});

test('booker transcription detects the call language on Nova-3', () => {
  const query = deepgramListenQuery();
  assert.match(query, /(?:^|&)model=nova-3(?:&|$)/);
  assert.match(query, /(?:^|&)detect_language=true(?:&|$)/);
  assert.equal(query.includes('language=multi'), false);
  assert.equal(query.includes('language=no'), false);
});

test('Deepgram speaker ints become chat lines', () => {
  const chat = formatDeepgramChat({
    results: {
      utterances: [
        { speaker: 0, transcript: 'Hei, dette er bookeren.' },
        { speaker: 1, transcript: 'Ja, vi vil ha en nettside.' },
      ],
    },
  });
  assert.equal(chat, 'Taler 0: Hei, dette er bookeren.\nTaler 1: Ja, vi vil ha en nettside.');
});

test('missing Deepgram key does not throw', async () => {
  const result = await transcribePrerecordedBuffer({
    buffer: Buffer.from('not-audio'),
    config: { apiKey: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs-key');
  assert.match(result.error, /DEEPGRAM_API_KEY/);
});

test('workshop hard gate rejects empty, short, and under two minutes', () => {
  assert.equal(hardGateWorkshopTranscript({ transcript: '' }).reason, 'empty');
  assert.equal(hardGateWorkshopTranscript({
    transcript: 'Hei. Ok.',
    durationMinutes: 12,
  }).reason, 'short-text');
  assert.equal(hardGateWorkshopTranscript({
    transcript: 'Hei der. Vi tar det senere. Bare en kort prat.',
    durationMinutes: 0.3,
  }).reason, 'short-duration');
  const ok = hardGateWorkshopTranscript({
    transcript: 'Hei, dette er workshopen. Vi trenger en bookingkalender. Menyen skal vise dagens retter.',
    durationMinutes: 12,
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.sentenceCount >= 3);
});

test('invalid workshop transcript does not hold the workshop', async () => {
  const result = await applyWorkshopTranscriptToRecord({
    client: { businessName: 'Test Bakeri' },
    workshopMeeting: {
      meetingId: 'ws-short',
      transcript: 'Hei. Vi tar det senere.',
      durationMinutes: 0.3,
    },
    evaluate: async () => ({
      meetingId: 'ws-short',
      valid: false,
      reason: 'short-duration',
      durationMinutes: 0.3,
      sentenceCount: 2,
      evaluatedAt: new Date().toISOString(),
      source: 'hard-gate',
    }),
    generateDocument: async () => {
      throw new Error('should not write project document');
    },
    generateSummary: async () => {
      throw new Error('should not write summary');
    },
  });
  assert.equal(result.skipped, 'invalid-transcript');
  assert.equal(result.workshop.heldAt, '');
  assert.equal(result.workshop.projectDocument, null);
  assert.equal(result.workshop.transcriptEval.valid, false);
  assert.equal(workshopGoalHeld({ workshop: result.workshop }), false);
});

test('valid workshop transcript writes todos and holds the goal', async () => {
  const result = await applyWorkshopTranscriptToRecord({
    client: { businessName: 'Test Bakeri' },
    workshopMeeting: {
      meetingId: 'ws-ok',
      transcript: 'Hei, dette er workshopen. Vi trenger booking. Menyen skal vise retter. Logoen er hvit.',
      durationMinutes: 18,
    },
    evaluate: async () => ({
      meetingId: 'ws-ok',
      valid: true,
      reason: 'valid',
      durationMinutes: 18,
      sentenceCount: 4,
      evaluatedAt: new Date().toISOString(),
      source: 'ai',
    }),
    generateSummary: async () => ({
      intro: 'Bakeri i Oslo.',
      voice: 'Varm og lokal.',
      whatTheyWant: 'Ny nettside.',
      functionality: 'Booking og meny.',
      generatedAt: new Date().toISOString(),
      source: 'ai',
      fromNotesOnly: false,
      language: 'nb',
    }),
    generateDocument: async () => persistProjectDocument({
      meetingId: 'ws-ok',
      goalExplanation: 'Kunden skal kunne booke og se menyen.',
      clientDocumentation: 'Lokalt bakeri. Varm stemme.',
      todos: [
        { category: 'Funksjon og flyt', title: 'Booking', detail: 'De ba om timebestilling.' },
        { category: 'Ukjent', title: 'Avklare farger', detail: 'Ikke bestemt ennå.' },
      ],
    }),
  });
  assert.equal(result.skipped, undefined);
  assert.ok(result.workshop.heldAt);
  assert.equal(result.workshop.projectDocument.todos.length, 2);
  assert.equal(result.workshop.projectDocument.todos[1].category, 'Åpne beslutninger');
  assert.equal(workshopGoalHeld({ workshop: result.workshop }), true);
});

test('developer can tick a project todo without regenerating', () => {
  const doc = persistProjectDocument({
    meetingId: 'ws-ok',
    goalExplanation: 'Mål',
    clientDocumentation: 'Dok',
    todos: [{ id: 'todo-1', title: 'Booking', category: 'Funksjon og flyt', detail: 'Timebestilling.' }],
  });
  const next = markProjectTodoDone(doc, 'todo-1', true);
  assert.equal(next.todos[0].done, true);
  assert.equal(next.goalExplanation, 'Mål');
});

test('booker preview context is about the preview, not who called', () => {
  const user = buildBookerPreviewUserPrompt({
    client: { businessName: 'Stolt Leveranse AS', contactPerson: 'Hein' },
    transcriptChat: 'Taler 0: Vi mangler nettside og vil ha booking.',
  });
  assert.equal(user.includes('Stolt'), false);
  assert.equal(user.includes('Hein'), false);
  assert.match(user, /booking/);
  assert.match(PREVIEW_SYSTEM, /preview/);
  assert.match(PREVIEW_SYSTEM, /Ikke ta med hvem som ringte/);
});

test('booker preview enqueue skips a finished call', () => {
  const ready = persistPreviewDocument({
    callId: 'c1',
    recordingUrl: '/myphoner-recordings/c1.wav',
    status: 'ready',
    transcriptChat: 'Taler 0: Hei',
    summary: 'Kort',
  });
  assert.equal(shouldEnqueueBookerPreview({ myphoner: { latestCallId: 'c1' }, previewDocument: ready }, 'c1'), false);
  assert.equal(shouldEnqueueBookerPreview({ myphoner: { latestCallId: 'c1', latestRecordingUrl: '/myphoner-recordings/c1.wav' } }, 'c1'), true);
});

test('developer UI does not import Deepgram', () => {
  const brief = readFileSync(join(here, '../app/pages/developer/DeveloperClientBrief.tsx'), 'utf8');
  const card = readFileSync(join(here, '../app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  assert.equal(brief.includes('deepgram-transcribe'), false);
  assert.equal(card.includes('deepgram-transcribe'), false);
  assert.equal(brief.includes('DEVELOPER_QA_LABELS'), false);
});

test('booker recording URL prefers MyPhoner over previewDocument', () => {
  assert.equal(clientRecordingUrl(null), '');
  assert.equal(clientRecordingUrl({
    myphoner: { latestRecordingUrl: 'https://asoldi.com/myphoner-audio/a.wav' },
    previewDocument: { recordingUrl: 'https://asoldi.com/myphoner-audio/old.wav' },
  }), 'https://asoldi.com/myphoner-audio/a.wav');
  assert.equal(clientRecordingUrl({
    previewDocument: { recordingUrl: 'https://asoldi.com/myphoner-audio/b.wav' },
  }), 'https://asoldi.com/myphoner-audio/b.wav');
});

test('recording proxy refuses loops and missing URLs, allows app and CDN hosts', () => {
  assert.equal(prepareRecordingStream({ rawUrl: '' }).status, 404);
  assert.equal(prepareRecordingStream({
    rawUrl: 'https://asoldi.com/api/admin/sales/abc/recording',
  }).status, 400);
  assert.equal(prepareRecordingStream({
    rawUrl: 'https://asoldi.com/api/admin/development/sales%3Aabc/recording',
  }).status, 400);
  const app = prepareRecordingStream({
    rawUrl: 'https://asoldi.com/myphoner-audio/a.wav',
    appHost: 'asoldi.com',
  });
  assert.equal(app.ok, true);
  assert.equal(app.isAppHost, true);
  const cdn = prepareRecordingStream({
    rawUrl: 'https://cdn.example.com/calls/a.wav',
  });
  assert.equal(cdn.ok, true);
  assert.equal(cdn.isAppHost, false);
  assert.equal(cdn.isMyphonerHost, false);
});

test('both developer documents mount booker audio in Kundedata', () => {
  const kundedata = readFileSync(join(here, '../app/pages/developer/DeveloperKundedata.tsx'), 'utf8');
  const brief = readFileSync(join(here, '../app/pages/developer/DeveloperClientBrief.tsx'), 'utf8');
  const card = readFileSync(join(here, '../app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  const server = readFileSync(join(here, '../server.js'), 'utf8');
  assert.match(kundedata, /Møtebooker-opptak/);
  assert.match(kundedata, /Lytt her/);
  assert.match(brief, /latestRecordingUrl/);
  assert.match(brief, /DeveloperKundedata/);
  assert.match(card, /latestRecordingUrl=\{item\.latestRecordingUrl/);
  assert.match(server, /\/api\/admin\/development\/:id\/recording/);
  assert.match(server, /developmentAuth/);
});

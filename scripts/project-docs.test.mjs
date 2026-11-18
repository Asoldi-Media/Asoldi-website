import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepgramListenQuery, formatDeepgramChat, transcribePrerecordedBuffer } from '../lib/deepgram-transcribe.js';
import { buildBookerPreviewUserPrompt, persistPreviewDocument, PREVIEW_SYSTEM, shouldEnqueueBookerPreview } from '../lib/booker-preview-document.js';
import { clientRecordingUrl, prepareRecordingStream } from '../lib/sales-recording-stream.js';
import { hardGateWorkshopTranscript } from '../lib/workshop-transcript-eval.js';
import { applyWorkshopTranscriptToRecord, buildWorkshopProjectUserPrompt, generateWorkshopProjectDocument } from '../lib/workshop-project-document.js';
import { asoldiLlmConfig } from '../packages/suite/harness/asoldi/llm.js';
import { createRouter } from '../packages/suite/core/llm/route.js';
import { legacyRouteFor } from '../lib/llm/config.js';
import { markProjectTodoDone, persistProjectDocument } from '../lib/workshop-record.js';
import { primaryDeveloperDocument, DOCUMENT_LABELS } from '../lib/developer-card.js';
import { workshopGoalHeld } from '../lib/workshop-goal-timeline.js';
import { formatFinding } from './security/secret-scan-lib.mjs';
import { loadProfileConfig, ratchetReport } from './security/secret-scan.mjs';

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
    client: { businessName: 'Rask Leveranse AS', contactPerson: 'Hein' },
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

// This repository is public. Test names and docs describe what the code does in plain words. The two
// tests below keep the words this repo avoids out of test names and docs; identifiers, assert
// messages and fixtures are not checked. Local notes (docs/daily-logs, tmp/) are skipped.
const AVOIDED_WORDS = /\b(?:leak(?:s|ed|ing|age|y)?|forg(?:e|ed|es|ing|ery|eable)|exploit\w*|vulnerab\w*|spoof\w*)\b/i;
const repoRoot = join(here, '..');
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'tmp', '.local-data', 'fixtures-private', 'daily-logs']);
const TEST_FILE = /(?:\.test\.(?:mjs|cjs|js|ts|tsx)|^test-[\w.-]+\.(?:mjs|js))$/;
const TEST_NAME = /(?<![\w.$])(?:t\.test|test|it|describe)(?:\.(?:skip|only|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TEST_DIRS = ['scripts', 'data', 'lib', 'packages', 'app', 'src'];
const ROOT_DOCS = ['README.md', 'SECURITY.md', 'DEPLOYMENT.md', 'deployment prompt.md', 'LICENSE.md', 'CHANGELOG.md'];

function listFiles(dir, accept, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, accept, out);
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function testNamesIn(source) {
  return [...source.matchAll(TEST_NAME)].map((m) => ({ name: m[2], line: lineOf(source, m.index) }));
}

test('the wording check reads test names and tells the avoided words from look-alikes', () => {
  const names = testNamesIn("test('a', () => {});\n/x/.test('b');\nt.test(\"c\", fn);\nit.skip(`d`);\nsubmit('e');\ndescribe('f');");
  assert.deepEqual(names.map((n) => n.name), ['a', 'c', 'd', 'f']);
  assert.deepEqual(names.map((n) => n.line), [1, 3, 4, 6]);
  for (const word of ['leak', 'leaked', 'leaking', 'forged', 'forgeable', 'exploit', 'vulnerability', 'spoofed']) {
    assert.match(word, AVOIDED_WORDS);
  }
  for (const word of ['forget', 'forgot', 'forgotten', 'forgive', 'release', 'spoon', 'exploration']) {
    assert.doesNotMatch(word, AVOIDED_WORDS);
  }
});

test('test names and docs in this public repo use neutral, behaviour-describing words', () => {
  const found = [];
  const testFiles = TEST_DIRS.flatMap((dir) => listFiles(join(repoRoot, dir), (name) => TEST_FILE.test(name)));
  assert.ok(testFiles.length >= 50, `expected the test suite under ${TEST_DIRS.join(', ')}, found ${testFiles.length} files`);
  for (const file of testFiles) {
    for (const { name, line } of testNamesIn(readFileSync(file, 'utf8'))) {
      if (AVOIDED_WORDS.test(name)) found.push(`${relative(repoRoot, file)}:${line} test name: ${name}`);
    }
  }
  const docs = [
    ...listFiles(join(repoRoot, 'docs'), (name) => name.endsWith('.md')),
    ...ROOT_DOCS.map((name) => join(repoRoot, name)).filter((file) => existsSync(file)),
  ];
  assert.ok(docs.length >= 10, `expected the docs folder, found ${docs.length} files`);
  for (const file of docs) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      if (AVOIDED_WORDS.test(text)) found.push(`${relative(repoRoot, file)}:${i + 1}: ${text.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'reword these to describe the behaviour instead');
});

// Internal planning words and client personal data in tracked files only go down. The offender lists
// (scripts/security/scan-profile.json `ratchets`) hold today's counts per file: a file that is not
// listed must have none, and a listed count must not grow. A lower count passes; lower the list with
// `node scripts/security/secret-scan.mjs --tracked --ratchet --shrink`. A secret or a blocked path
// (daily logs, scratch files, data files) in a tracked file always fails.
test('tracked files: planning words and client data only go down, and no secret or blocked path is tracked', () => {
  assert.equal(loadProfileConfig(repoRoot).profile.name, 'public', 'this repo is public: scripts/security/scan-profile.json keeps the public profile');
  const report = ratchetReport(repoRoot);
  assert.deepEqual(report.hard.map(formatFinding), [], 'a secret or a blocked path is tracked');
  assert.deepEqual(Object.keys(report.lists).sort(), ['pii', 'plan'], 'both offender lists are configured');
  for (const [kind, row] of Object.entries(report.lists)) {
    assert.deepEqual(row.unlisted.map((item) => `${item.path} (${item.count})`), [], `${kind}: files with findings that ${row.file} does not list`);
    assert.deepEqual(row.grown.map((item) => `${item.path} (${item.count} > ${item.allowed})`), [], `${kind}: counts above ${row.file}`);
  }
});

const TRANSCRIPT_SLICE = /slice\(0,\s*12_000\)|slice\(0,\s*28_000\)/g;

function legacyProjectPrompt(collected = {}) {
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

test('the project prompt keeps the previous text while iteration.projectDocument is off', () => {
  const collected = {
    businessName: 'Fjordlys Keramikk AS',
    industry: 'keramikk',
    offerPlan: 'Standard',
    offerGoal: 'Selge krukker',
    offerIdentity: 'Rolige farger',
    offerCustomSections: 'Galleri',
    salesNotes: 'Notat fra salg',
    productNotes: 'Krukker og fat',
    workshopNotes: ['Ta med logo'],
    salesTranscript: 'S'.repeat(100),
    workshopTranscript: 'W'.repeat(100),
    offerProducts: [{ name: 'Krukker', pages: 3 }],
    offerLetter: 'Tilbud om krukker.',
    tier: 'tier-1-standard',
    services: ['site'],
  };
  assert.equal(buildWorkshopProjectUserPrompt(collected), legacyProjectPrompt(collected));
  assert.equal(buildWorkshopProjectUserPrompt(collected, { upgrade: false }), legacyProjectPrompt(collected));
  assert.notEqual(buildWorkshopProjectUserPrompt(collected, { upgrade: true }), legacyProjectPrompt(collected));
});

test('the upgraded project prompt names the tier and products and stops cutting the transcript', async () => {
  const sourcePath = join(repoRoot, 'lib/workshop-project-document.js');
  const source = readFileSync(sourcePath, 'utf8');
  assert.ok(source.length > 0, `source files read 1, bytes ${source.length}`);
  assert.equal((source.match(TRANSCRIPT_SLICE) || []).length, 0, `source files read 1, bytes ${source.length}`);
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-clip-'));
  const copyPath = join(dir, 'workshop-project-document.js');
  writeFileSync(copyPath, `${source}\nconst planted = ''.slice(0, 12_000);\n`);
  const copy = readFileSync(copyPath, 'utf8');
  assert.ok(copy.length > 0, `copy files read 1, bytes ${copy.length}`);
  assert.equal((copy.match(/slice\(0,\s*12_000\)/g) || []).length, 1);
  rmSync(dir, { recursive: true, force: true });

  const whole = 'A'.repeat(20_000);
  const long = 'B'.repeat(40_000);
  const map = 'KART-OPPSUMMERING';
  const collected = {
    businessName: 'Fjordlys Keramikk AS',
    tier: 'tier-1-standard',
    services: ['site'],
    offerProducts: [{ name: 'Krukker', pages: 3 }],
    offerLetter: 'Tilbud om krukker.',
    workshopTranscript: whole,
    workshopMap: map,
    salesTranscript: 'S'.repeat(100),
    salesMap: 'SALG-KART',
  };
  const upgraded = buildWorkshopProjectUserPrompt(collected, { upgrade: true });
  assert.match(upgraded, /Nivå: tier-1-standard/);
  assert.match(upgraded, /Oppsummering: nivå tier-1-standard/);
  assert.match(upgraded, /Tjenester: site/);
  assert.match(upgraded, /Krukker \(3 sider\)/);
  assert.match(upgraded, /Tilbud om krukker\./);
  assert.ok(upgraded.includes(whole), 'a 20000-character transcript is included whole');
  const over = buildWorkshopProjectUserPrompt({ ...collected, workshopTranscript: long }, { upgrade: true });
  assert.match(over, /KART-OPPSUMMERING/);
  assert.ok(over.indexOf('KART-OPPSUMMERING') < over.indexOf('B'.repeat(100)), 'the summary sits above the transcript');
  assert.ok(over.includes('B'.repeat(100)), 'the transcript is not replaced by the summary');

  const settingsOff = { iteration: { projectDocument: { enabled: false, mode: 'shadow', paused: null } } };
  const settingsOn = { iteration: { projectDocument: { enabled: true, mode: 'shadow', paused: null } } };
  const seen = [];
  const chat = async (request) => {
    seen.push(request);
    return { goalExplanation: 'Mål for nettsiden.', clientDocumentation: 'Fjordlys Keramikk AS lager krukker.', todos: [] };
  };
  await generateWorkshopProjectDocument({
    client: { id: 'client-fjordlys', businessName: 'Fjordlys Keramikk AS', sitePlan: { tierId: 'tier-1-standard', services: ['site'] } },
    workshopMeeting: { transcript: whole, summary: map },
    offer: { products: [{ name: 'Krukker', pages: 3 }], email: { html: '<p>Tilbud om krukker.</p>' } },
    deps: { settings: settingsOff, chat },
  });
  await generateWorkshopProjectDocument({
    client: { id: 'client-fjordlys', businessName: 'Fjordlys Keramikk AS', sitePlan: { tierId: 'tier-1-standard', services: ['site'] } },
    workshopMeeting: { transcript: long, summary: map },
    offer: { products: [{ name: 'Krukker', pages: 3 }], email: { html: '<p>Tilbud om krukker.</p>' } },
    deps: { settings: settingsOn, chat },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].maxTokens, 2200);
  assert.equal(seen[1].maxTokens, 4000);
  assert.ok(seen[0].user.includes(whole));
  assert.equal(seen[0].user.includes('Nivå:'), false);
  assert.match(seen[1].user, /tier-1-standard/);
  assert.match(seen[1].user, /Krukker/);
  assert.match(seen[1].user, /KART-OPPSUMMERING/);
  assert.ok(seen[1].user.indexOf('KART-OPPSUMMERING') < seen[1].user.indexOf('B'.repeat(100)));
  assert.notEqual(seen[1].user, seen[0].user);
});

function projectRoutes({ synthetic = false } = {}) {
  const config = asoldiLlmConfig('hub');
  const router = createRouter({
    tasks: config.tasks,
    routes: config.routes,
    policy: config.policy,
    legacyRoute: legacyRouteFor({}),
    env: {},
    unknownTasks: 'warn',
    stalePrices: 'warn',
  });
  const tasks = ['workshop.project-document', 'brief.iteration'];
  const profiles = ['legacy', 'prod'];
  const rows = [];
  for (const task of tasks) {
    for (const profile of profiles) {
      const resolved = router.resolveRoute(task, { profile, ...(synthetic ? { synthetic: true } : {}) }, {
        payload: 'Kunden vil ha en ny headerfarge.',
        images: 0,
      });
      rows.push({ task, profile, provider: resolved.primary.provider });
    }
  }
  return { tasks: tasks.length, profiles: profiles.length, rows };
}

test('workshop.project-document and brief.iteration do not resolve to DeepSeek', () => {
  const routed = projectRoutes();
  assert.equal(routed.tasks, 2);
  assert.equal(routed.profiles, 2);
  assert.equal(routed.rows.length, routed.tasks * routed.profiles);
  for (const row of routed.rows) assert.notEqual(row.provider, 'deepseek', `${row.task} ${row.profile}`);
  assert.throws(() => {
    const bypassed = projectRoutes({ synthetic: true });
    assert.equal(bypassed.tasks, 2);
    assert.equal(bypassed.profiles, 2);
    for (const row of bypassed.rows) assert.notEqual(row.provider, 'deepseek', `${row.task} ${row.profile}`);
  });
});

test('an over-long transcript with no summary is still in the upgraded project prompt', () => {
  const workshop = 'Kunde sier viktig. '.repeat(2100);
  assert.ok(workshop.length > 28_000);
  const prompt = buildWorkshopProjectUserPrompt({
    businessName: 'X',
    workshopTranscript: workshop,
    salesTranscript: 'Salg sier noe. '.repeat(1000),
    workshopMap: '',
    salesMap: '',
  }, { upgrade: true });
  assert.ok(prompt.includes(workshop.trim()), 'the full workshop transcript is in the prompt');
  assert.match(prompt, /Salg sier noe/);
  const withMap = buildWorkshopProjectUserPrompt({
    businessName: 'X',
    workshopTranscript: workshop,
    workshopMap: 'SAMMENDRAG-MARKØR',
  }, { upgrade: true });
  const at = withMap.indexOf('SAMMENDRAG-MARKØR');
  assert.ok(at >= 0 && at < withMap.indexOf('Kunde sier viktig'), 'summary sits above the transcript');
});

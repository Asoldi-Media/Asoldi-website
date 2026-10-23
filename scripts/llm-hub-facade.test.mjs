// Hub LLM facade (lib/llm, WS0.19) on the shared core. Every provider is a local mock: global fetch
// answers DeepSeek, Anthropic and Gemini requests from memory, and a socket spy refuses any
// non-loopback connection, so no test here can reach a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-llm-facade-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(AI_PROFILE|AI_TEST_MODE|AI_ROUTE_|HUB_SAFE_MODE|HUB_LLM_FACADE)/.test(key)) delete process.env[key];
Object.assign(process.env, {
  DEEPSEEK_API_KEY: 'test-deepseek-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GEMINI_API_KEY: 'test-gemini-key',
  CLIENT_MEDIA_VISION: '1',
  GEMINI_VISION_RPM: '60',
});
delete process.env.DEEPSEEK_MODEL;
delete process.env.ANTHROPIC_MODEL;
delete process.env.ANTHROPIC_EFFORT;
delete process.env.GEMINI_MODEL;
delete process.env.SALES_LINK_GEMINI_MODEL;
delete process.env.CLIENT_MEDIA_VISION_MODEL;

// Last line of defence: a socket to anything but loopback is refused and recorded.
const outsideSockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  outsideSockets.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTOUTSIDE' })));
  return this;
};

// ---------------------------------------------------------------- provider mocks (global fetch)
const UNIVERSAL_JSON = {
  need: 'en ny nettside',
  project: ['Avsnitt en.', 'Avsnitt to.'],
  terms: 'Vilkår.',
  benefits: 'Fordeler.',
  workshopStart: '',
  title: 'Scope',
  scopeSummary: 'Summary.',
  products: [],
  monthlyExMva: 0,
  deliveryWeeks: 4,
  extraTerms: [],
  headline: 'Kunden vil ha en enkel side.',
  wants: ['En enkel side'],
  uncertainties: [],
  intro: 'Intro.',
  voice: 'Stemme.',
  whatTheyWant: 'Ønsker.',
  functionality: 'Funksjoner.',
  goalExplanation: 'Mål.',
  clientDocumentation: 'Dokumentasjon.',
  todos: [],
  valid: true,
  reason: 'ok',
  summary: 'Sammendrag av samtalen.',
  assistantMessage: 'Last opp en prisliste.',
  nextAction: 'wait',
  layout: null,
  questions: [],
  catalogs: [],
  clientSigned: true,
  clientDateFilled: true,
  confidence: 0.9,
  notes: '',
  instagramUrl: '',
  facebookUrl: '',
  websiteUrl: '',
  googleMapsUrl: '',
};

const providerCalls = [];
const claudeScript = []; // queued Anthropic responses (objects); default end_turn with UNIVERSAL_JSON
let failDeepseek = null;
let deepseekContent = null; // a DeepSeek answer text to send instead of UNIVERSAL_JSON
const geminiFailures = []; // queued HTTP statuses: the next Gemini requests fail with them

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function anthropicReply(body) {
  const scripted = claudeScript.shift();
  return {
    id: `msg_${providerCalls.length}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: JSON.stringify(UNIVERSAL_JSON) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...(scripted || {}),
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) throw new Error('no loopback in this test');
  const rawBody = typeof init.body === 'string' ? init.body : init.body ? await new Response(init.body).text() : '';
  const body = rawBody ? JSON.parse(rawBody) : {};
  const headers = Object.fromEntries(new Headers(init.headers || input?.headers || {}));
  if (url.startsWith('https://api.deepseek.com/')) {
    providerCalls.push({ provider: 'deepseek', url, body, headers });
    if (failDeepseek) return jsonResponse({ error: { message: 'mock failure' } }, failDeepseek);
    return jsonResponse({
      model: body.model,
      choices: [{ message: { content: deepseekContent ?? JSON.stringify(UNIVERSAL_JSON) }, finish_reason: deepseekContent ? 'length' : 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 100 },
    });
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    providerCalls.push({ provider: 'claude', url, body, headers });
    return jsonResponse(anthropicReply(body));
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    providerCalls.push({ provider: 'gemini', url, body, headers });
    if (geminiFailures.length) return jsonResponse({ error: { code: geminiFailures[0], message: 'mock failure', status: 'FAILED_PRECONDITION' } }, geminiFailures.shift());
    return jsonResponse({
      candidates: [{
        content: { role: 'model', parts: [{ text: JSON.stringify({ ...UNIVERSAL_JSON, depiction: 'A cup of coffee on a table.', primaryWhy: 'Shows the product.', primarySection: 'hero' }) }] },
        finishReason: 'STOP',
        groundingMetadata: { groundingChunks: [] },
      }],
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 20 },
      modelVersion: 'gemini-2.5-flash',
    });
  }
  if (url.startsWith('https://data.brreg.no/')) return jsonResponse({}, 404);
  throw new Error(`unexpected fetch in test: ${url}`);
};

const core = await import('../packages/suite/core/llm/index.js');
const { registerHubLlm, hubLlm, aiTaskConfigured } = await import('../lib/llm-hooks.js');
const { createHubLlm } = await import('../lib/llm/index.js');
const { deepseekChatJson, DeepseekError } = await import('../lib/deepseek.js');
const offerAi = await import('../lib/offer-ai.js');
const { generateWorkshopSummaryWithDeepSeek } = await import('../lib/workshop-summary.js');
const { generateWorkshopProjectDocumentWithDeepSeek } = await import('../lib/workshop-project-document.js');
const { evaluateWorkshopTranscriptWithDeepSeek } = await import('../lib/workshop-transcript-eval.js');
const { generateBookerPreviewSummaryWithDeepSeek } = await import('../lib/booker-preview-document.js');
const { runProductAssistantTurn } = await import('../lib/ai-assistant/chat.js');
const { interpretLooseNote } = await import('../lib/ai-assistant/gather.js');
const { structureProductsFromText, extractIngestText } = await import('../lib/ai-assistant/products-ingest.js');
const { transcribeClientMedia } = await import('../lib/ai-assistant/media-transcript.js');
const { categorizeEmail } = await import('../lib/inbox-bot/categorize.js');
const { decideInboxWrite } = await import('../lib/inbox-bot/decide.js');
const { askVisionIfSigned } = await import('../lib/inbox-bot/inspect-contract.js');
const { askGeminiForLinks } = await import('../lib/sales-link-discovery.js');
const { runInfokortAgent } = await import('../lib/infokort-agent.js');
const { asoldiLlmConfig } = await import('../packages/suite/harness/asoldi/llm.js');
const sharp = (await import('sharp')).default;

const PINNED_FINGERPRINT = 'sha256:315a1b5ede91dc78db6553f472e29fc9fa535955494e0ec19fc03d7418a7bdf7';
const HUB_TASKS = Object.keys(asoldiLlmConfig('hub').tasks);
const CLIENT = { id: 'client-fixture-1', businessName: 'Fjordbakeriet AS', industry: 'bakeri', contactPerson: 'Kari', notes: 'Vil ha nettbutikk for brød.' };
const TRANSCRIPT = Array.from({ length: 14 }, (_, i) => `Speaker ${i % 2 ? 'Asoldi' : 'Kunde'}: Vi snakker om nettsiden og hva den skal vise, punkt nummer ${i + 1}.`).join('\n');
const MEETING = { id: 'meeting-1', meetingId: 'meeting-1', title: 'Salgsmøte', transcript: TRANSCRIPT, summary: 'Kunden vil ha en enkel side.', durationMinutes: 30, date: '2026-10-20T10:00:00.000Z' };

function ledgerRows(dir) {
  const ai = join(dir, 'ai');
  if (!existsSync(ai)) return [];
  return readdirSync(ai)
    .filter((name) => /^ledger-\d{4}-\d{2}\.jsonl$/.test(name))
    .flatMap((name) => readFileSync(join(ai, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

function freshDir(name) {
  return mkdtempSync(join(tmpdir(), `asoldi-llm-${name}-`));
}

function facadeAt(dir, extra = {}) {
  return createHubLlm({ dataDir: dir, env: process.env, fetch: globalThis.fetch, log: { warn() {}, log() {} }, ...extra });
}

async function tinyJpeg() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
}

async function tinyPng() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 240 } } }).png().toBuffer();
}

test.after(() => {
  registerHubLlm(null);
  rmSync(dataDir, { recursive: true, force: true });
});

test('the facade meets the frozen LLM contract (1.2.0) with its own methods', () => {
  const facade = facadeAt(freshDir('contract'));
  assert.deepEqual(core.runContractChecks({ core, facade, fingerprint: PINNED_FINGERPRINT }), []);
  assert.equal(facade.routeFor, facade.resolveRoute);
  for (const method of ['json', 'text', 'tools', 'callLlm', 'routeFor', 'resolveRoute', 'status']) assert.equal(typeof facade[method], 'function', method);
});

test('the default profile is legacy: every migrated task keeps today\'s provider, with the prod route as a shadow', async () => {
  const facade = facadeAt(freshDir('legacy-routes'));
  assert.equal(facade.profile(), 'legacy');
  const status = await facade.status();
  assert.equal(status.profileSource, 'default');
  assert.equal(status.legacyPassthrough, true);
  const byTask = Object.fromEntries(status.routes.map((row) => [row.task, row]));
  for (const task of ['offer.fill-from-transcript', 'offer.reflect-contract', 'offer.summarize-intent', 'workshop.summary', 'workshop.project-document', 'workshop.transcript-eval', 'booker.preview-document', 'assistant.chat', 'assistant.gather', 'assistant.products-ingest', 'inbox.categorize', 'inbox.decide']) {
    assert.equal(byTask[task].route, 'deepseek:deepseek-chat', task);
    assert.equal(byTask[task].source, 'legacy-passthrough', task);
  }
  for (const task of ['assistant.products-image', 'inbox.inspect-contract', 'sales-link.discover', 'assistant.media-brief']) assert.equal(byTask[task].route, 'gemini:gemini-2.5-flash', task);
  assert.equal(byTask['infokort.agent'].route, 'claude:claude-haiku-5-5:medium');
  // The shadow route is what the prod profile would do: transcripts go to Claude Haiku 5.5, never DeepSeek.
  assert.equal(byTask['offer.fill-from-transcript'].shadowRoute, 'claude:claude-haiku-5-5:low');
  for (const row of status.routes) assert.doesNotMatch(row.shadowRoute || '', /deepseek/, `${row.task} shadow route`);
});

test('legacy profile: the DeepSeek request through the facade is byte-identical to the request without it, and one ledger row is written', async () => {
  const dir = freshDir('legacy-identical');
  const args = { client: CLIENT, meeting: MEETING, meetings: [MEETING], products: [], source: 'transcript' };

  registerHubLlm(null);
  providerCalls.length = 0;
  const direct = await offerAi.fillOfferFromTranscript(args);
  const directCall = providerCalls.at(-1);

  registerHubLlm(facadeAt(dir));
  providerCalls.length = 0;
  const viaFacade = await offerAi.fillOfferFromTranscript(args);
  const facadeCall = providerCalls.at(-1);
  registerHubLlm(null);

  assert.equal(providerCalls.length, 1);
  assert.deepEqual(facadeCall.body, directCall.body, 'same model, temperature, max_tokens, response_format and prompts');
  assert.equal(facadeCall.body.model, 'deepseek-chat');
  assert.equal(facadeCall.body.temperature, 0.5);
  assert.equal(facadeCall.body.max_tokens, 1800);
  assert.deepEqual(facadeCall.body.response_format, { type: 'json_object' });
  assert.match(facadeCall.body.messages[0].content, /Svar KUN med ett gyldig JSON-objekt/);
  assert.deepEqual(viaFacade, direct, 'the offer fill output is the same');

  const rows = ledgerRows(dir);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.v, 2);
  assert.equal(row.repo, 'hub');
  assert.equal(row.task, 'offer.fill-from-transcript');
  assert.equal(row.provider, 'deepseek');
  assert.equal(row.model, 'deepseek-chat');
  assert.equal(row.profile, 'legacy');
  assert.equal(row.passthrough, true);
  assert.equal(row.status, 'ok');
  assert.equal(row.salesClientId, CLIENT.id);
  assert.equal(row.inputTokens, 900);
  assert.equal(row.cacheReadTokens, 100);
  assert.equal(row.outputTokens, 200);
  assert.ok(row.usd > 0);
  assert.equal(row.priceVerified, false, 'DeepSeek prices are not verified yet');
  assert.equal(row.shadowRoute, 'claude:claude-haiku-5-5:low');
});

test('deps.chat injection is kept: a stub chat gets the task key and no provider or ledger is involved', async () => {
  const dir = freshDir('deps-chat');
  registerHubLlm(facadeAt(dir));
  providerCalls.length = 0;
  const seen = [];
  const chat = async (args) => {
    seen.push(args);
    return UNIVERSAL_JSON;
  };
  await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING], deps: { chat } });
  await offerAi.reflectContractFromEmail({ emailHtml: '<p>Tilbud</p>', products: [], deps: { chat } });
  await offerAi.summarizeClientIntent({ client: CLIENT, meeting: MEETING, meetings: [MEETING], deps: { chat } });
  registerHubLlm(null);
  assert.deepEqual(seen.map((args) => args.task), ['offer.fill-from-transcript', 'offer.reflect-contract', 'offer.summarize-intent']);
  assert.equal(seen[0].ctx.salesClientId, CLIENT.id);
  assert.equal(providerCalls.length, 0);
  assert.equal(ledgerRows(dir).length, 0);
});

test('prod profile from the data override: offer.fill-from-transcript runs on claude-haiku-5-5 because transcripts may not reach DeepSeek', async () => {
  const dir = freshDir('prod-override');
  const facade = facadeAt(dir);
  const saved = facade.setRoutesOverride({ profile: 'prod' }, { by: 'admin:test' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(facade.profile(), 'prod');
  const override = JSON.parse(readFileSync(join(dir, 'ai-routes.override.json'), 'utf8'));
  assert.equal(override.profile, 'prod');
  assert.equal(override.updatedBy, 'admin:test');

  const route = facade.routeFor('offer.fill-from-transcript');
  assert.equal(route.profile, 'prod');
  assert.equal(route.primary.provider, 'claude');
  assert.equal(route.primary.model, 'claude-haiku-5-5');
  assert.equal(route.dataClass.effective, 'transcript');
  assert.ok(!route.chain.some((entry) => entry.provider === 'deepseek'));
  assert.ok(route.policyRedirects.some((redirect) => /deepseek/.test(redirect.from)), 'the DeepSeek fallback was removed by the data policy');

  // Even a route that names DeepSeek first is redirected for transcript data.
  const forced = facade.setRoutesOverride({ profile: 'prod', profiles: { prod: { tasks: { 'offer.fill-from-transcript': 'deepseek:deepseek-chat' } } } }, { by: 'admin:test' });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  const redirected = facade.routeFor('offer.fill-from-transcript');
  assert.equal(redirected.primary.model, 'claude-haiku-5-5');
  assert.equal(redirected.policyRedirects[0].from, 'deepseek:deepseek-chat');

  registerHubLlm(facade);
  providerCalls.length = 0;
  const filled = await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
  registerHubLlm(null);
  assert.equal(filled.need, UNIVERSAL_JSON.need);
  assert.deepEqual(providerCalls.map((call) => call.provider), ['claude']);
  const request = providerCalls[0].body;
  assert.equal(request.model, 'claude-haiku-5-5');
  for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(Object.hasOwn(request, key), false, key);
  assert.deepEqual(request.thinking, { type: 'adaptive' });
  assert.ok(['low', 'medium'].includes(request.output_config.effort));
  assert.ok(request.max_tokens >= 4096, 'the max_tokens floor applies');
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
  assert.equal(providerCalls[0].headers['x-api-key'], 'test-anthropic-key');
  const rows = ledgerRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'claude');
  assert.equal(rows[0].profile, 'prod');
  assert.equal(rows[0].model, 'claude-haiku-5-5');
  assert.equal(rows[0].salesClientId, CLIENT.id);
  // Priced from response.model: 1200 in + 300 out on Haiku 5.5.
  assert.ok(Math.abs(rows[0].usd - (1200 * 0.1 + 300 * 0.5) / 1e6) < 1e-12, String(rows[0].usd));
  assert.equal(rows[0].priceVerified, true);
});

test('env AI_PROFILE beats the override, and an invalid override is ignored (never fatal)', async () => {
  const dir = freshDir('profile-order');
  writeFileSync(join(dir, 'ai-routes.override.json'), JSON.stringify({ version: 1, profile: 'prod' }));
  const fromEnv = createHubLlm({ dataDir: dir, env: { ...process.env, AI_PROFILE: 'test' }, fetch: globalThis.fetch, log: { warn() {} } });
  assert.equal(fromEnv.profile(), 'test');
  assert.equal((await fromEnv.status()).profileSource, 'env');
  writeFileSync(join(dir, 'ai-routes.override.json'), JSON.stringify({ version: 1, profile: 'prod', profiles: { prod: { default: 'claude:claude-haiku-9' } } }));
  const facade = facadeAt(dir);
  assert.equal(facade.profile(), 'legacy', 'a bad override leaves the hub on its base config');
  const status = await facade.status();
  assert.equal(status.overrides.routes.applied, false);
  assert.match(status.overrides.routes.error, /claude-haiku-9/);
  const refused = facade.setRoutesOverride({ profile: 'nonsense' });
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join(' '), /nonsense/);
  const unknownModel = facade.setRoutesOverride({ profiles: { prod: { tasks: { 'offer.fill-from-transcript': 'deepseek:deepseek-v9' } } } });
  assert.equal(unknownModel.ok, false);
  assert.match(unknownModel.errors.join(' '), /deepseek-v9/);
});

test('refusal is final: needs review, no other vendor, and the DeepSeek wrapper keeps one error type', async () => {
  const dir = freshDir('refusal');
  const facade = facadeAt(dir);
  facade.setRoutesOverride({ profile: 'prod', profiles: { prod: { tasks: { 'offer.reflect-contract': 'claude:claude-haiku-5-5:medium|deepseek:deepseek-chat' } } } });
  registerHubLlm(facade);
  providerCalls.length = 0;
  claudeScript.push({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } });
  await assert.rejects(
    () => deepseekChatJson({ task: 'offer.reflect-contract', system: 's', user: 'Contract text with no client data.' }),
    (error) => error instanceof DeepseekError && error.code === 'refusal' && error.cause?.needsReview === true,
  );
  registerHubLlm(null);
  assert.deepEqual(providerCalls.map((call) => call.provider), ['claude'], 'no cross-vendor retry after a refusal');
  const rows = ledgerRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'refusal');
  assert.equal(rows[0].needsReview, true);
});

test('a max_tokens stop retries once on Claude with the cap doubled; both attempts are in the ledger', async () => {
  const dir = freshDir('max-tokens');
  const facade = facadeAt(dir);
  facade.setRoutesOverride({ profile: 'prod' });
  providerCalls.length = 0;
  claudeScript.push({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"partial":' }] });
  const result = await facade.json({ task: 'brief.map', system: 'Extract.', user: 'Synthetic text without client data.', ctx: { salesClientId: 'c-2' } });
  assert.deepEqual(result.data, UNIVERSAL_JSON);
  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[1].body.max_tokens, providerCalls[0].body.max_tokens * 2);
  assert.deepEqual(ledgerRows(dir).map((row) => row.status), ['max_tokens', 'ok']);
});

test('budgets: the hub day cap from the budgets override alerts and the call still runs', async () => {
  const dir = freshDir('budgets');
  writeFileSync(join(dir, 'ai-budgets.override.json'), JSON.stringify({ periodic: { hubDayUsd: 0.000001, clientMonthUsd: 0.000001 } }));
  const warnings = [];
  const facade = createHubLlm({ dataDir: dir, env: process.env, fetch: globalThis.fetch, log: { warn: (line) => warnings.push(line), log() {} } });
  registerHubLlm(facade);
  await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'u', ctx: { salesClientId: 'c-3' } });
  await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'u2', ctx: { salesClientId: 'c-3' } });
  registerHubLlm(null);
  const status = await facade.status();
  assert.equal(status.overrides.budgets.applied, true);
  assert.ok(status.spend.alerts.some((alert) => alert.scope === 'hubDay'), JSON.stringify(status.spend.alerts));
  assert.ok(status.spend.alerts.some((alert) => alert.scope === 'clientMonth' && alert.salesClientId === 'c-3'));
  assert.equal(ledgerRows(dir).length, 2, 'alerts never stop a call');
  assert.ok(warnings.some((line) => /budget alert/.test(line)));
  assert.ok(existsSync(join(dir, 'ai', 'spend-summary.json')));
});

test('the ledger records 100% of calls in a scripted run of every hub task (legacy profile, mocks only)', async () => {
  const dir = freshDir('all-tasks');
  const facade = facadeAt(dir);
  registerHubLlm(facade);
  providerCalls.length = 0;
  const jpeg = await tinyJpeg();
  const png = await tinyPng();

  // Each call site gets the sales client the way its caller passes it.
  const salesClientId = CLIENT.id;
  await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
  await offerAi.reflectContractFromEmail({ emailHtml: '<p>Vi lager en nettside med booking.</p>', products: [{ id: 'p1', name: 'Nettside', pages: 5, priceExMva: 1499 }], client: { id: salesClientId } });
  await offerAi.summarizeClientIntent({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
  await generateWorkshopSummaryWithDeepSeek({ client: CLIENT, salesMeeting: MEETING, workshopMeeting: MEETING });
  await generateWorkshopProjectDocumentWithDeepSeek({ client: CLIENT, salesMeeting: MEETING, workshopMeeting: MEETING, meetingId: 'meeting-1' });
  await evaluateWorkshopTranscriptWithDeepSeek({ transcript: TRANSCRIPT, durationMinutes: 30, businessName: CLIENT.businessName, meetingId: 'meeting-1', salesClientId });
  await generateBookerPreviewSummaryWithDeepSeek({ client: CLIENT, transcriptChat: TRANSCRIPT });
  await runProductAssistantTurn({ messages: [{ role: 'user', text: 'Hei, vi selger brød og kaker.' }], summary: {}, salesClientId });
  await interpretLooseNote('Vi har åpent fra ti til seks hver dag og selger brød.', {}, { salesClientId });
  await structureProductsFromText({ texts: [{ fileName: 'liste.txt', text: 'Brød 45 kr\nKanelbolle 35 kr', preferAi: true }], salesClientId });
  await extractIngestText({ buffer: png, originalName: 'meny.png', mimeType: 'image/png' }, { salesClientId });
  await transcribeClientMedia({ buffer: jpeg, fileName: 'kaffe.jpg', context: { businessName: CLIENT.businessName }, salesClientId });
  await categorizeEmail({ from: 'kunde@firma.test', subject: 'Spørsmål', text: 'Hei, når er siden klar?', salesClientId });
  await decideInboxWrite({ client: CLIENT, message: { text: 'Hei, kan vi flytte møtet?', subject: 'Møte', from: 'kunde@firma.test' }, heuristic: { intent: 'question' } });
  await askVisionIfSigned({ bytes: png, mimeType: 'image/png' }, { salesClientId });
  await askGeminiForLinks({ id: salesClientId, businessName: CLIENT.businessName, city: 'Bergen' }, ['instagramUrl'], { fetchImpl: globalThis.fetch });
  claudeScript.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'submit_card', input: { industry: 'bakeri', meetingPlace: '', orgNumber: '', websiteDomain: '', instagramUrl: '', facebookUrl: '', proffUrl: '', googleBusinessProfile: '', briefShort: 'Et bakeri.' } }] });
  await runInfokortAgent({ id: CLIENT.id, businessName: CLIENT.businessName }, {
    search: async () => [],
    mapsSearch: async () => ({ ok: true, results: [] }),
    readWebsite: async () => [],
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  // WS8 tasks have no call site yet; they run through the facade directly (legacy profile -> core).
  for (const task of ['brief.map', 'brief.reduce', 'brief.iteration', 'change.classify', 'followups.extract']) {
    await facade.json({ task, system: 'Extract the facts.', user: 'Synthetic note without client data.', ctx: { salesClientId: CLIENT.id } });
  }
  registerHubLlm(null);

  const rows = ledgerRows(dir);
  assert.equal(rows.length, providerCalls.length, `one ledger row per provider call (${rows.length} rows, ${providerCalls.length} calls)`);
  assert.ok(rows.every((row) => row.status === 'ok'), JSON.stringify(rows.filter((row) => row.status !== 'ok')));
  const seen = new Set(rows.map((row) => row.task));
  for (const task of HUB_TASKS) assert.ok(seen.has(task), `no ledger row for ${task}`);
  const providersByTask = Object.fromEntries(rows.map((row) => [row.task, row.provider]));
  assert.equal(providersByTask['offer.fill-from-transcript'], 'deepseek');
  assert.equal(providersByTask['inbox.inspect-contract'], 'gemini');
  assert.equal(providersByTask['sales-link.discover'], 'gemini');
  assert.equal(providersByTask['infokort.agent'], 'claude');
  assert.equal(providersByTask['brief.map'], 'claude');
  // Per-client spend: every row names the sales client, so the hub part of a client's spend is complete.
  const unnamed = rows.filter((row) => row.salesClientId !== salesClientId).map((row) => row.task);
  assert.deepEqual(unnamed, [], 'rows without the sales client');
  assert.equal(facade.spend({ salesClientId }).hub.calls, rows.length);
  assert.deepEqual(outsideSockets, []);
});

test('the portal assistant and the inbox find the sales client for their ledger rows', async () => {
  const { salesClientIdOf } = await import('../lib/ai-assistant/service.js');
  const { ingestInboxMessage } = await import('../lib/inbox-bot/index.js');
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    { id: 'sc-connected', product: 'asoldi', businessName: 'Connected AS', status: 'active', portalUserId: 'portal-user-1', contactEmail: 'post@connected.test' },
  ], null, 2));
  assert.equal(salesClientIdOf('portal-user-1'), 'sc-connected', 'the sales client connected to the portal user');
  assert.equal(salesClientIdOf('portal-user-unknown'), '');
  assert.equal(salesClientIdOf(''), '');

  // The inbox categorizer gets the sender's client (the categorize call runs before the full match).
  const seen = [];
  await ingestInboxMessage({ id: 'm-1', mailbox: 'alexander@asoldi.com', from: 'Kari <post@connected.test>', subject: 'Spørsmål', text: 'Hei, når er siden klar?', mailAt: '2026-10-20T10:00:00.000Z' }, {
    clients: JSON.parse(readFileSync(join(dataDir, 'sales-clients.json'), 'utf8')),
    categorize: async (input) => {
      seen.push(input.salesClientId);
      return { kind: 'other', summary: '', match: {}, elements: [], dueAt: '' };
    },
    force: true,
    sendEmail: async () => ({ ok: true }),
    queryBusy: async () => [],
    decideAi: async () => ({}),
  }).catch(() => null);
  assert.deepEqual(seen, ['sc-connected']);
});

test('legacy Infokort turns send today\'s Claude request: raw tools as written, configured model and effort', async () => {
  const dir = freshDir('infokort');
  registerHubLlm(facadeAt(dir));
  providerCalls.length = 0;
  claudeScript.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'submit_card', input: { industry: 'bakeri', meetingPlace: '', orgNumber: '', websiteDomain: '', instagramUrl: '', facebookUrl: '', proffUrl: '', googleBusinessProfile: '', briefShort: 'Et bakeri.' } }] });
  const result = await runInfokortAgent({ id: 'c-ik', businessName: 'Bakeri' }, { search: async () => [], mapsSearch: async () => ({ ok: true, results: [] }), readWebsite: async () => [], fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  registerHubLlm(null);
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 1);
  assert.equal(providerCalls.length, 1);
  const body = providerCalls[0].body;
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal(body.max_tokens, 4096);
  assert.equal(typeof body.system, 'string', 'today\'s request sends the system prompt as a string');
  assert.ok(body.tools.every((tool) => tool.strict === undefined), 'tools as written');
  assert.equal(providerCalls[0].headers['anthropic-version'], '2023-06-01');
  const [row] = ledgerRows(dir);
  assert.equal(row.task, 'infokort.agent');
  assert.equal(row.salesClientId, 'c-ik');
  assert.equal(row.stopReason, 'tool_use');
});

test('spend: totals by task and by client from the ledger', async () => {
  const dir = freshDir('spend');
  const facade = facadeAt(dir);
  registerHubLlm(facade);
  await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'u', ctx: { salesClientId: 'c-a' } });
  await deepseekChatJson({ task: 'inbox.decide', system: 's', user: 'u', ctx: { salesClientId: 'c-b' } });
  registerHubLlm(null);
  const byTask = facade.spend({ by: 'task' });
  assert.equal(byTask.hub.calls, 2);
  assert.deepEqual(Object.keys(byTask.hub.groups).sort(), ['inbox.categorize', 'inbox.decide']);
  const oneClient = facade.spend({ by: 'task', salesClientId: 'c-a' });
  assert.equal(oneClient.hub.calls, 1);
  assert.equal(oneClient.maker.totalUsd, 0);
  assert.equal(oneClient.totalUsd, oneClient.hub.totalUsd);
  const byClient = facade.spend({ by: 'client' });
  assert.deepEqual(Object.keys(byClient.hub.groups).sort(), ['c-a', 'c-b']);
});

test('configuredFor follows the profile: legacy needs today\'s key, prod needs a key on the route', () => {
  const dir = freshDir('configured');
  const env = { ANTHROPIC_API_KEY: 'k' };
  const facade = createHubLlm({ dataDir: dir, env, log: { warn() {} } });
  registerHubLlm(facade);
  assert.equal(aiTaskConfigured('offer.fill-from-transcript', () => true), false, 'legacy: no DeepSeek key, not configured');
  assert.equal(aiTaskConfigured('infokort.agent', () => false), true);
  facade.setRoutesOverride({ profile: 'prod' });
  assert.equal(aiTaskConfigured('offer.fill-from-transcript', () => false), true, 'prod: Claude has a key');
  registerHubLlm(null);
  assert.equal(aiTaskConfigured('offer.fill-from-transcript', () => true), true, 'no facade: the legacy check decides');
  assert.equal(hubLlm(), null);
});

// ---------------------------------------------------------------- safe mode (WS0.29) covers every call
test('safe mode: legacy and prod-profile calls never reach a provider; each is guarded and recorded', async () => {
  const safeMode = await import('../lib/safe-mode.js');
  await import('../lib/safe-mode-ai.js');
  const safeDir = freshDir('safe');
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir: safeDir, log: null, egress: false });
  try {
    providerCalls.length = 0;
    const dir = freshDir('safe-ledger');
    const facade = facadeAt(dir);
    registerHubLlm(facade);
    const legacy = await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'u' });
    assert.deepEqual(legacy, { safeModeStub: true });
    const media = await transcribeClientMedia({ buffer: await tinyJpeg(), fileName: 'x.jpg' });
    assert.equal(media, null);
    facade.setRoutesOverride({ profile: 'prod' });
    const prod = await facade.json({ task: 'brief.map', system: 's', user: 'Synthetic text.' });
    assert.deepEqual(prod.data, {});
    const turn = await facade.turn({ task: 'infokort.agent', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(turn.stopReason, 'end_turn');
    // The Gemini call sites on the legacy profile: their own key check refuses and records the intent.
    facade.setRoutesOverride({ profile: 'legacy' });
    const intentsBefore = safeMode.readRecentIntents(200).filter((intent) => intent.kind === 'aiCalls').length;
    const png = await tinyPng();
    await extractIngestText({ buffer: png, originalName: 'meny.png', mimeType: 'image/png' });
    assert.equal(await askVisionIfSigned({ bytes: png, mimeType: 'image/png' }), null);
    const links = await askGeminiForLinks({ businessName: CLIENT.businessName, city: 'Bergen' }, ['instagramUrl'], { fetchImpl: globalThis.fetch });
    assert.equal(links.reason, 'no-gemini-key');
    registerHubLlm(null);
    assert.equal(providerCalls.length, 0, 'no provider request left the process');
    const allIntents = safeMode.readRecentIntents(200).filter((intent) => intent.kind === 'aiCalls');
    const geminiIntents = allIntents.slice(0, allIntents.length - intentsBefore); // newest first
    for (const site of ['products-ingest', 'inspect-contract', 'link-discovery']) {
      assert.ok(geminiIntents.some((intent) => String(intent.detail || '').includes(site)), `${site}: ${JSON.stringify(geminiIntents)}`);
    }
    const intents = safeMode.readRecentIntents(50).filter((intent) => intent.kind === 'aiCalls');
    assert.ok(intents.length >= 3, JSON.stringify(intents));
    const rows = ledgerRows(dir);
    assert.ok(rows.some((row) => row.task === 'inbox.categorize' && row.safeMode === 'guarded'));
    assert.ok(rows.some((row) => row.task === 'brief.map' && row.provider === 'claude' && row.usd === 0));
  } finally {
    safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir: safeDir, log: null, egress: false });
  }
});

test('safe-mode cassette keys tell different inputs apart (Gemini images, provider-specific calls)', async () => {
  const { createGeminiAdapter } = await import('../lib/llm/providers/gemini.js');
  const seen = [];
  const guard = async ({ request }) => {
    seen.push(JSON.stringify(request));
    return { text: '{}', usage: {}, servedModel: 'gemini-2.5-flash', response: {} };
  };
  const adapter = createGeminiAdapter({ env: { GEMINI_API_KEY: 'k' }, guard });
  const call = { task: 'assistant.media-brief', model: 'gemini-2.5-flash', kind: 'json', user: 'Describe.', maxTokens: 1200 };
  await adapter({ ...call, images: [{ mime: 'image/jpeg', base64: (await tinyJpeg()).toString('base64') }] });
  await adapter({ ...call, images: [{ mime: 'image/png', base64: (await tinyPng()).toString('base64') }] });
  assert.notEqual(seen[0], seen[1]);
  assert.doesNotMatch(seen[0], /\/9j\//, 'the key holds a hash, not the image');

  const dir = freshDir('native-key');
  const facade = facadeAt(dir);
  facade.setRoutesOverride({ profile: 'prod' });
  // sales-link.discover is business data; Gemini is not paid-confirmed, so the route has no Gemini.
  await assert.rejects(
    () => facade.native({ task: 'sales-link.discover', provider: 'gemini', payload: { user: 'Find links for one business.' }, run: async () => ({}) }),
    (error) => error.code === 'route_unavailable',
  );
  assert.equal(ledgerRows(dir).length, 0, 'no call, no row');

  // A provider-specific call that its route allows: the guard's cassette key follows the payload.
  const { aiCassetteKey } = await import('../lib/safe-mode-ai.js');
  const keys = [];
  const recordingGuard = async ({ provider, request, real }) => {
    keys.push(aiCassetteKey(provider, request));
    return real();
  };
  const guarded = facadeAt(freshDir('native-guard'), { guard: recordingGuard });
  guarded.setRoutesOverride({ profile: 'prod' });
  const run = async () => ({ text: '{}', usage: { inputTokens: 10, outputTokens: 2 }, servedModel: 'claude-haiku-5-5' });
  for (const user of ['Find links for business A.', 'Find links for business B.', 'Find links for business A.']) {
    await guarded.native({ task: 'sales-link.discover', provider: 'claude', payload: { user }, run });
  }
  assert.equal(keys.length, 3);
  assert.notEqual(keys[0], keys[1], 'different payloads never share a cassette');
  assert.equal(keys[0], keys[2], 'the same payload replays the same cassette');
});

// ---------------------------------------------------------------- one row per attempt, shared data dir, alerts
test('a legacy call that tries twice writes a ledger row for each attempt (grounded search retry, next media model)', async () => {
  const dir = freshDir('attempts');
  registerHubLlm(facadeAt(dir));
  providerCalls.length = 0;
  try {
    // The grounded call with thinkingConfig fails once; the retry without it answers.
    geminiFailures.push(400);
    const links = await askGeminiForLinks({ businessName: CLIENT.businessName, city: 'Bergen', salesClientId: 'c-att' }, ['instagramUrl'], { fetchImpl: globalThis.fetch });
    assert.equal(links.reason, 'gemini');
    // The media brief's first model answers 503; the helper moves on to the next model.
    geminiFailures.push(503);
    const brief = await transcribeClientMedia({ buffer: await tinyJpeg(), fileName: 'kaffe.jpg', context: { businessName: CLIENT.businessName } });
    assert.ok(brief, 'the second model gave the brief');
  } finally {
    registerHubLlm(null);
    geminiFailures.length = 0;
  }
  const rows = ledgerRows(dir);
  assert.equal(rows.length, providerCalls.length, `one row per provider call (${rows.length} rows, ${providerCalls.length} calls)`);
  const links = rows.filter((row) => row.task === 'sales-link.discover');
  assert.deepEqual(links.map((row) => [row.status, row.attempt]), [['error', 1], ['ok', 2]]);
  assert.equal(links[0].salesClientId, 'c-att');
  assert.ok(links[0].error?.message, 'the failed attempt keeps its error');
  const media = rows.filter((row) => row.task === 'assistant.media-brief');
  assert.deepEqual(media.map((row) => [row.status, row.attempt]), [['error', 1], ['ok', 2]]);
  assert.deepEqual(media.map((row) => row.requestedModel), ['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
  assert.ok(media[1].inputTokens > 0, 'the answer that was used is priced');
});

test('a DeepSeek answer that is not JSON is recorded as an error row with its tokens and price', async () => {
  const dir = freshDir('bad-json');
  registerHubLlm(facadeAt(dir));
  deepseekContent = '{"need": "en ny nettside", "project": [';
  try {
    await assert.rejects(
      () => deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'u', ctx: { salesClientId: 'c-bad' } }),
      (error) => error instanceof DeepseekError && error.code === 'bad-json',
    );
  } finally {
    deepseekContent = null;
    registerHubLlm(null);
  }
  const [row] = ledgerRows(dir);
  assert.equal(row.status, 'error');
  assert.equal(row.error.code, 'bad-json');
  assert.equal(row.inputTokens, 900);
  assert.equal(row.outputTokens, 200);
  assert.ok(row.usd > 0, 'billed tokens are priced');
  assert.equal(row.stopReason, 'max_tokens', 'the cut-off answer says why');
});

test('two hub processes on one data dir: totals, budgets and spend-summary.json count every process\'s rows', async () => {
  const dir = freshDir('two-process');
  const { createHubLedger } = await import('../lib/llm/ledger.js');
  const row = (task, salesClientId) => core.buildLedgerRow({ at: new Date().toISOString(), repo: 'hub', task, provider: 'deepseek', requestedModel: 'deepseek-chat', profile: 'legacy', ctx: { salesClientId }, usage: { inputTokens: 1_000_000, outputTokens: 0 } });
  const parent = createHubLedger({ dataDir: dir, log: null });
  parent.append(row('offer.reflect-contract', 'c-parent'));
  const one = parent.summary();
  assert.equal(one.calls, 1);

  // Another process appends three rows for another client.
  const ledgerUrl = new URL('../lib/llm/ledger.js', import.meta.url).href;
  const coreUrl = new URL('../packages/suite/core/llm/index.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createHubLedger } = await import(${JSON.stringify(ledgerUrl)});
    const core = await import(${JSON.stringify(coreUrl)});
    const ledger = createHubLedger({ dataDir: process.argv[1], log: null });
    for (let i = 0; i < 3; i += 1) ledger.append(core.buildLedgerRow({ at: new Date().toISOString(), repo: 'hub', task: 'inbox.categorize', provider: 'deepseek', requestedModel: 'deepseek-chat', profile: 'legacy', ctx: { salesClientId: 'c-child' }, usage: { inputTokens: 1000000, outputTokens: 0 } }));
  `, dir], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const unit = one.monthUsd;
  const seen = parent.summary();
  assert.equal(seen.calls, 4, 'the parent counts the other process\'s rows');
  assert.ok(Math.abs(seen.monthUsd - unit * 4) < 1e-9);
  assert.ok(Math.abs(parent.spentUsd({ scope: 'clientMonth', ctx: { salesClientId: 'c-child' } }) - unit * 3) < 1e-9, 'budgets see the other process\'s client spend');
  assert.ok(Math.abs(parent.spentUsd({ scope: 'hubDay', ctx: {} }) - unit * 4) < 1e-9);
  parent.append(row('offer.reflect-contract', 'c-parent'));
  const file = JSON.parse(readFileSync(join(dir, 'ai', 'spend-summary.json'), 'utf8'));
  assert.equal(file.calls, 5, 'spend-summary.json holds every row on disk');
  assert.ok(Math.abs(file.monthUsd - unit * 5) < 1e-9);
  assert.deepEqual(createHubLedger({ dataDir: dir, log: null }).summary().calls, 5);
});

test('budget alerts: five calls over the cap write one alert per scope and client for the day', async () => {
  const dir = freshDir('alert-dedupe');
  writeFileSync(join(dir, 'ai-budgets.override.json'), JSON.stringify({ periodic: { hubDayUsd: 0.000001, clientMonthUsd: 0.000001 } }));
  const warnings = [];
  const facade = createHubLlm({ dataDir: dir, env: process.env, fetch: globalThis.fetch, log: { warn: (line) => warnings.push(line), log() {} } });
  registerHubLlm(facade);
  try {
    for (let i = 0; i < 5; i += 1) await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: `u${i}`, ctx: { salesClientId: 'c-cap' } });
  } finally {
    registerHubLlm(null);
  }
  const month = new Date().toISOString().slice(0, 7);
  const alerts = readFileSync(join(dir, 'ai', `alerts-${month}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(alerts.map((alert) => alert.scope).sort(), ['clientMonth', 'hubDay']);
  assert.equal(warnings.filter((line) => /budget alert/.test(line)).length, 2);
  // A second process (a fresh ledger on the same dir) does not write the same alerts again.
  const other = createHubLlm({ dataDir: dir, env: process.env, fetch: globalThis.fetch, log: { warn() {}, log() {} } });
  registerHubLlm(other);
  try {
    await deepseekChatJson({ task: 'inbox.categorize', system: 's', user: 'again', ctx: { salesClientId: 'c-cap' } });
  } finally {
    registerHubLlm(null);
  }
  assert.equal(readFileSync(join(dir, 'ai', `alerts-${month}.jsonl`), 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal((await other.status()).spend.alerts.length, 2, 'status reads the alerts every process wrote');
  assert.equal(ledgerRows(dir).length, 6, 'alerts never stop a call');
});

test('the data-dir off switch sends every call site directly: no facade, no ledger row, today\'s provider even on prod', async () => {
  const dir = freshDir('off-switch');
  const facade = facadeAt(dir);
  facade.setRoutesOverride({ profile: 'prod' });
  registerHubLlm(facade);
  providerCalls.length = 0;
  try {
    assert.equal(hubLlm(), facade);
    const off = facade.setRoutesOverride({ facade: false }, { by: 'admin:test' });
    assert.equal(off.ok, true);
    assert.equal(off.profile, 'prod', 'the saved profile stays');
    assert.equal(facade.enabled(), false);
    assert.equal(hubLlm(), null);
    await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
    assert.deepEqual(providerCalls.map((call) => call.provider), ['deepseek'], 'the call site ran its own request');
    assert.equal(ledgerRows(dir).length, 0, 'nothing is recorded while the facade is off');
    assert.equal(aiTaskConfigured('offer.fill-from-transcript', () => true), true, 'gates use the call site\'s own check');
    assert.equal(facade.setRoutesOverride({ profile: 'legacy' }).code, 'facade_off');
    // A broken override does not stop the off switch.
    writeFileSync(join(dir, 'ai-routes.override.json'), JSON.stringify({ version: 1, profile: 'prod', facade: false, profiles: { prod: { default: 'claude:claude-haiku-9' } } }));
    facade.reload();
    assert.equal(facade.enabled(), false);
    assert.equal(facade.setRoutesOverride({ facade: true }).ok, true);
    assert.equal(hubLlm(), facade);
    writeFileSync(join(dir, 'ai-routes.override.json'), JSON.stringify({ version: 1, profile: 'prod' }));
    facade.reload();
    providerCalls.length = 0;
    await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
    assert.deepEqual(providerCalls.map((call) => call.provider), ['claude'], 'back on: the prod route applies again');
    assert.equal(ledgerRows(dir).length, 1);
  } finally {
    registerHubLlm(null);
  }
});

test('the override may choose test, replay or record only in safe mode or a local run with AI_PROFILE', () => {
  const dir = freshDir('profile-allowlist');
  const facade = facadeAt(dir);
  for (const profile of ['record', 'replay', 'test']) {
    const result = facade.setRoutesOverride({ profile });
    assert.equal(result.ok, false, profile);
    assert.match(result.errors.join(' '), /safe mode/);
  }
  assert.equal(existsSync(join(dir, 'ai-routes.override.json')), false);
  const local = createHubLlm({ dataDir: dir, env: { ...process.env, AI_PROFILE: 'test' }, fetch: globalThis.fetch, log: { warn() {} } });
  assert.equal(local.setRoutesOverride({ profile: 'record' }).ok, true, 'a local run may save it');
  facade.reload();
  assert.equal(facade.profile(), 'legacy', 'outside safe mode a saved record profile is not applied');
});

test('aiUnavailableMessage keeps the call site\'s message on legacy and names no provider on other profiles', async () => {
  const { aiUnavailableMessage } = await import('../lib/llm-hooks.js');
  const legacyMessage = 'DeepSeek er ikke konfigurert (DEEPSEEK_API_KEY mangler).';
  assert.equal(aiUnavailableMessage('offer.fill-from-transcript', legacyMessage), legacyMessage, 'no facade');
  const facade = facadeAt(freshDir('message'));
  registerHubLlm(facade);
  try {
    assert.equal(aiUnavailableMessage('offer.fill-from-transcript', legacyMessage), legacyMessage, 'legacy profile');
    facade.setRoutesOverride({ profile: 'prod' });
    assert.doesNotMatch(aiUnavailableMessage('offer.fill-from-transcript', legacyMessage), /DeepSeek/);
  } finally {
    registerHubLlm(null);
  }
});

test('status probes run side by side and each gives up after its time limit', { timeout: 10_000 }, async () => {
  const { createHealth } = await import('../lib/llm/health.js');
  const started = [];
  const hang = (name) => () => {
    started.push(name);
    return new Promise(() => {});
  };
  const health = createHealth({
    env: { ANTHROPIC_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', GEMINI_API_KEY: 'k' },
    probes: { claude: hang('claude'), deepseek: hang('deepseek'), gemini: hang('gemini') },
    timeoutMs: 40,
  });
  const pending = health.providers({ runProbe: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['claude', 'deepseek', 'gemini'], 'all three started before any finished');
  const out = await pending;
  for (const name of ['claude', 'deepseek', 'gemini']) assert.equal(out[name].probe.error, 'timeout', name);
});

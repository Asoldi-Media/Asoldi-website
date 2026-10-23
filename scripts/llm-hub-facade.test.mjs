// Hub LLM facade (lib/llm, WS0.19) on the shared core. Every provider is a local mock: global fetch
// answers DeepSeek, Anthropic and Gemini requests from memory, and a socket spy refuses any
// non-loopback connection, so no test here can reach a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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
});
delete process.env.DEEPSEEK_MODEL;
delete process.env.ANTHROPIC_MODEL;
delete process.env.ANTHROPIC_EFFORT;
delete process.env.GEMINI_MODEL;
delete process.env.SALES_LINK_GEMINI_MODEL;
delete process.env.CLIENT_MEDIA_VISION_MODEL;

// Last line of defence: a socket to anything but loopback is refused and recorded.
const leakedSockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  leakedSockets.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTLEAK' })));
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
      choices: [{ message: { content: JSON.stringify(UNIVERSAL_JSON) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 100 },
    });
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    providerCalls.push({ provider: 'claude', url, body, headers });
    return jsonResponse(anthropicReply(body));
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    providerCalls.push({ provider: 'gemini', url, body, headers });
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

  await offerAi.fillOfferFromTranscript({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
  await offerAi.reflectContractFromEmail({ emailHtml: '<p>Vi lager en nettside med booking.</p>', products: [{ id: 'p1', name: 'Nettside', pages: 5, priceExMva: 1499 }] });
  await offerAi.summarizeClientIntent({ client: CLIENT, meeting: MEETING, meetings: [MEETING] });
  await generateWorkshopSummaryWithDeepSeek({ client: CLIENT, salesMeeting: MEETING, workshopMeeting: MEETING });
  await generateWorkshopProjectDocumentWithDeepSeek({ client: CLIENT, salesMeeting: MEETING, workshopMeeting: MEETING, meetingId: 'meeting-1' });
  await evaluateWorkshopTranscriptWithDeepSeek({ transcript: TRANSCRIPT, durationMinutes: 30, businessName: CLIENT.businessName, meetingId: 'meeting-1' });
  await generateBookerPreviewSummaryWithDeepSeek({ client: CLIENT, transcriptChat: TRANSCRIPT });
  await runProductAssistantTurn({ messages: [{ role: 'user', text: 'Hei, vi selger brød og kaker.' }], summary: {} });
  await interpretLooseNote('Vi har åpent fra ti til seks hver dag og selger brød.', {});
  await structureProductsFromText({ texts: [{ fileName: 'liste.txt', text: 'Brød 45 kr\nKanelbolle 35 kr', preferAi: true }] });
  await extractIngestText({ buffer: png, originalName: 'meny.png', mimeType: 'image/png' });
  await transcribeClientMedia({ buffer: jpeg, fileName: 'kaffe.jpg', context: { businessName: CLIENT.businessName } });
  await categorizeEmail({ from: 'kunde@firma.test', subject: 'Spørsmål', text: 'Hei, når er siden klar?' });
  await decideInboxWrite({ client: CLIENT, message: { text: 'Hei, kan vi flytte møtet?', subject: 'Møte', from: 'kunde@firma.test' }, heuristic: { intent: 'question' } });
  await askVisionIfSigned({ bytes: png, mimeType: 'image/png' });
  await askGeminiForLinks({ businessName: CLIENT.businessName, city: 'Bergen' }, ['instagramUrl'], { fetchImpl: globalThis.fetch });
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
  assert.deepEqual(leakedSockets, []);
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
    registerHubLlm(null);
    assert.equal(providerCalls.length, 0, 'no provider request left the process');
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
  const native = await import('../lib/llm/index.js');
  assert.match(String(native.createHubLlm), /payload: request\.payload \|\| null/);
});

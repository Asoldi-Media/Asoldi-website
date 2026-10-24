// Static scan of the hub's LLM call sites (WS0.19): provider endpoints and SDKs only inside lib/llm/ and
// the two wrappers, a registered task key on every call, the safe-mode guard on every provider call,
// and none of it in the browser bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asoldiLlmConfig } from '../packages/suite/harness/asoldi/llm.js';
import { LEGACY_TASKS } from '../lib/llm/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUB_TASKS = asoldiLlmConfig('hub').tasks;

function rel(file) {
  return relative(root, file).split(sep).join('/');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m?js|cjs|tsx?)$/.test(name)) out.push(full);
  }
  return out;
}

const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
/** Source without block comments and whole-line comments. */
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVER_FILES = [...walk(join(root, 'lib')), ...walk(join(root, 'data')), join(root, 'server.js')].map(rel);

// Provider endpoints and SDKs. A match outside the allowed files is a direct provider call.
const PROVIDER_MARKERS = [
  /api\.deepseek\.com/,
  /api\.anthropic\.com/,
  /generativelanguage\.googleapis\.com/,
  /api\.openai\.com/,
  /['"]@google\/genai['"]/,
  /['"]@anthropic-ai\/sdk['"]/,
  /\bnew\s+GoogleGenAI\s*\(/,
  /\bnew\s+Anthropic\s*\(/,
];
const PROVIDER_ALLOWED = new Map([
  ['lib/deepseek.js', 'wrapper: the one DeepSeek HTTP call'],
  ['lib/claude-messages.js', 'wrapper: today\'s Claude request (legacy profile)'],
  ['lib/safe-mode-egress.js', 'egress allowlist (host names, no call)'],
]);

test('no direct provider endpoint or SDK outside lib/llm/ and the two wrappers', () => {
  const offenders = [];
  for (const file of SERVER_FILES) {
    if (file.startsWith('lib/llm/') || PROVIDER_ALLOWED.has(file)) continue;
    const source = read(file);
    for (const marker of PROVIDER_MARKERS) if (marker.test(source)) offenders.push(`${file}: ${marker}`);
  }
  assert.deepEqual(offenders, []);
});

test('the suite\'s direct Gemini helper is reached only through the facade\'s media-brief task', () => {
  const users = SERVER_FILES.filter((file) => /generateGeminiJson/.test(read(file)));
  assert.deepEqual(users, ['lib/ai-assistant/media-transcript.js']);
  const media = read('lib/ai-assistant/media-transcript.js');
  assert.match(media, /: mediaBriefThroughFacade\(models, \{ salesClientId \}\)/, 'describeMedia always gets a generate function, so its default Gemini call is never used');
  assert.match(media, /runLlmTask\(isImage \? 'json' : 'native', \{\n\s+task: 'assistant\.media-brief'/);
});

// Every call that can reach a model, with the task keys each file must use.
const CALL_SITES = {
  'lib/offer-ai.js': ['offer.fill-from-transcript', 'offer.reflect-contract', 'offer.summarize-intent'],
  'lib/workshop-summary.js': ['workshop.summary'],
  'lib/workshop-project-document.js': ['workshop.project-document'],
  'lib/workshop-transcript-eval.js': ['workshop.transcript-eval'],
  'lib/booker-preview-document.js': ['booker.preview-document'],
  'lib/ai-assistant/chat.js': ['assistant.chat'],
  'lib/ai-assistant/gather.js': ['assistant.gather'],
  'lib/ai-assistant/products-ingest.js': ['assistant.products-ingest', 'assistant.products-image'],
  'lib/ai-assistant/media-transcript.js': ['assistant.media-brief'],
  'lib/inbox-bot/categorize.js': ['inbox.categorize'],
  'lib/inbox-bot/decide.js': ['inbox.decide'],
  'lib/inbox-bot/inspect-contract.js': ['inbox.inspect-contract'],
  'lib/sales-link-discovery.js': ['sales-link.discover'],
  'lib/infokort-agent.js': ['infokort.agent'],
};

// A model call: the wrappers, the hook entry points, or a call-site `chat({`.
const CALL_RE = /\b(deepseekChatJson|claudeMessages|claudeToolLoop|runLlmTask|chat)\s*\(([^(){};]*?,\s*)?\{/g;

function callsIn(source) {
  const out = [];
  for (const match of source.matchAll(CALL_RE)) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    // Definitions (`function chat({`, `async ({`) and destructuring are not calls.
    if (/function\s*$|async\s*$/.test(before)) continue;
    const window = source.slice(match.index, match.index + 600);
    const task = window.match(/\btask:\s*'([a-z0-9.-]+)'/);
    out.push({ fn: match[1], task: task ? task[1] : '', at: source.slice(0, match.index).split('\n').length, window });
  }
  return out;
}

test('every model call in a call-site file carries a registered hub task key', () => {
  const problems = [];
  for (const [file, expected] of Object.entries(CALL_SITES)) {
    const calls = callsIn(read(file));
    assert.ok(calls.length, `${file} has no model call`);
    for (const call of calls) {
      if (!call.task) problems.push(`${file}:${call.at} ${call.fn}(...) has no task key`);
      else if (!HUB_TASKS[call.task]) problems.push(`${file}:${call.at} task "${call.task}" is not a hub task`);
      else if (!expected.includes(call.task)) problems.push(`${file}:${call.at} task "${call.task}" is not expected here`);
    }
    for (const task of expected) if (!calls.some((call) => call.task === task)) problems.push(`${file}: no call with task "${task}"`);
  }
  assert.deepEqual(problems, []);
});

test('every model call in a call-site file passes a ctx, so its ledger row can name the sales client', () => {
  const missing = [];
  for (const file of Object.keys(CALL_SITES)) {
    for (const call of callsIn(read(file))) {
      // The call's own argument object, up to its task's closing lines (the window callsIn scanned).
      if (!/\bctx\b/.test(call.window)) missing.push(`${file}:${call.at} ${call.fn}(...) task "${call.task}" has no ctx`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no other server file calls the DeepSeek or Claude wrappers', () => {
  const others = SERVER_FILES.filter((file) => !CALL_SITES[file] && !file.startsWith('lib/llm/') && !PROVIDER_ALLOWED.has(file) && file !== 'lib/llm-hooks.js');
  const offenders = [];
  for (const file of others) {
    for (const call of callsIn(read(file))) {
      if (call.fn === 'chat') continue;
      offenders.push(`${file}:${call.at} ${call.fn}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the wrappers and call sites keep deps.chat injection and route the default chat through the wrapper', () => {
  for (const file of ['lib/workshop-summary.js', 'lib/workshop-project-document.js', 'lib/workshop-transcript-eval.js', 'lib/booker-preview-document.js']) {
    const source = read(file);
    assert.match(source, /const chat = deps\.chat;/, file);
    assert.match(source, /deps: \{ chat: deepseekChatJson \}/, file);
  }
  const offer = read('lib/offer-ai.js');
  assert.equal((offer.match(/const chat = deps\.chat \|\| deepseekChatJson;/g) || []).length, 3);
  assert.match(read('lib/infokort-agent.js'), /chat: limited\.chat \|\| null/);
});

test('every legacy task is a registered hub task and has a call site', () => {
  const used = new Set(Object.values(CALL_SITES).flat());
  for (const task of Object.keys(LEGACY_TASKS)) {
    assert.ok(HUB_TASKS[task], `${task} is not registered for the hub`);
    assert.ok(used.has(task), `${task} has no call site`);
  }
});

test('the safe-mode guard (aiCalls) is on every provider call path', () => {
  const deepseek = read('lib/deepseek.js');
  assert.match(deepseek, /export async function deepseekLegacyJson[\s\S]*?runAiCall\(\{\s*provider: 'deepseek'/);
  assert.equal((deepseek.match(/fetchImpl\(API_URL/g) || []).length, 1, 'one DeepSeek HTTP call');
  const claude = read('lib/claude-messages.js');
  assert.match(claude, /export async function claudeLegacyMessages[\s\S]*?runAiCall\(\{\s*provider: 'anthropic'/);
  assert.equal((claude.match(/fetchImpl\(API_URL/g) || []).length, 1, 'one Claude HTTP call');
  for (const file of ['lib/llm/providers/claude.js', 'lib/llm/providers/deepseek.js', 'lib/llm/providers/gemini.js']) {
    assert.match(read(file), /guard\(\{/, `${file} sends through the guard`);
    assert.match(read(file), /guard = guardAiCall/, `${file} defaults to the hub guard`);
  }
  const facade = read('lib/llm/index.js');
  assert.match(facade, /guard = guardAiCall,/, 'the facade defaults to the hub guard');
  assert.match(facade, /async function native[\s\S]*?await guard\(\{/, 'native calls go through the guard');
  // Gemini legacy calls keep their key check, which records the aiCalls intent in safe mode.
  for (const file of ['lib/ai-assistant/products-ingest.js', 'lib/inbox-bot/inspect-contract.js', 'lib/sales-link-discovery.js', 'lib/ai-assistant/media-transcript.js']) {
    assert.match(read(file), /aiKeyOrBlank\('gemini'/, file);
  }
  // The DeepSeek legacy path is the only caller of the raw request besides the facade's adapter.
  const rawUsers = SERVER_FILES.filter((file) => /deepseekChatRaw\(/.test(read(file)));
  assert.deepEqual(rawUsers.sort(), ['lib/deepseek.js', 'lib/llm/providers/deepseek.js']);
  const geminiRawUsers = SERVER_FILES.filter((file) => /geminiGenerateRaw\(/.test(read(file))).sort();
  assert.deepEqual(geminiRawUsers, ['lib/ai-assistant/products-ingest.js', 'lib/inbox-bot/inspect-contract.js', 'lib/llm/providers/gemini.js', 'lib/sales-link-discovery.js']);
});

test('the facade\'s Claude path never sends sampling parameters (the core builds the request)', () => {
  const adapter = code('lib/llm/providers/claude.js');
  assert.doesNotMatch(adapter, /temperature|top_p|top_k/);
  assert.match(adapter, /call\.claude/);
  const deepseekAdapter = code('lib/llm/providers/deepseek.js');
  assert.doesNotMatch(deepseekAdapter, /temperature:/, 'non-legacy DeepSeek calls send no temperature');
});

test('browser bundle: no module the app imports reaches lib/llm/ or a provider SDK', () => {
  const seen = new Set();
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec);
    for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const bare = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1] || match[2] || match[3];
      const next = resolveSpec(file, spec);
      if (next) visit(next);
      else bare.add(spec);
    }
  };
  walk(join(root, 'app')).forEach(visit);
  const files = [...seen].map(rel);
  assert.ok(files.includes('lib/deepseek.js'), 'the walk reaches the wrapper (it is bundled today)');
  assert.deepEqual(files.filter((file) => file.startsWith('lib/llm/')), []);
  assert.ok(!bare.has('@anthropic-ai/sdk'));
  assert.ok(files.includes('lib/llm-hooks.js'));
  const hooks = read('lib/llm-hooks.js');
  assert.doesNotMatch(hooks, /^\s*import\s/m, 'lib/llm-hooks.js has no imports (it is bundled into the browser app)');
});

test('the only server.js changes for the facade are the boot import, the admin routes, the callback and the task gates', () => {
  const server = read('server.js');
  assert.match(server, /^import '\.\/lib\/safe-mode-boot\.js';\n\/\/ .*\nimport '\.\/lib\/llm\/boot\.js';/m);
  assert.match(server, /registerAiAdminRoutes\(app, \{ adminAuth, sales \}\);/);
  assert.match(server, /if \(event === 'run\.ai\.spend'\) \{\n\s+const spend = applyRunAiSpendCallback\(\{ sales, client, runId: nextRunId, body: req\.body \}\);/);
  assert.doesNotMatch(server, /isDeepseekConfigured\(\)/, 'every DeepSeek gate asks the facade for its task');
  assert.equal((server.match(/aiTaskConfigured\('offer\.(fill-from-transcript|reflect-contract)', isDeepseekConfigured\)/g) || []).length, 5);
  // The two 503 answers name no provider once the hub runs another profile.
  assert.equal((server.match(/aiUnavailableMessage\('offer\.(fill-from-transcript|reflect-contract)', 'DeepSeek er ikke konfigurert \(DEEPSEEK_API_KEY mangler\)\.'\)/g) || []).length, 2);
});

test('Superadmin System safety shows the AI card, which reads only the AI admin endpoints', () => {
  const section = read('app/pages/Admin/sections/SystemSafetySection.tsx');
  assert.match(section, /import \{ AiStatusCard \} from '\.\/AiStatusCard';/);
  assert.match(section, /<AiStatusCard \/>/);
  const card = read('app/pages/Admin/sections/AiStatusCard.tsx');
  const endpoints = [...card.matchAll(/\$\{API\}(\/[a-z0-9/?=-]+)/gi)].map((m) => m[1].replace(/\?.*$/, '').replace(/\$\{.*$/, ''));
  assert.deepEqual([...new Set(endpoints)].sort(), ['/admin/ai/routes', '/admin/ai/status']);
  assert.doesNotMatch(card, /dangerouslySetInnerHTML|innerHTML/);
});

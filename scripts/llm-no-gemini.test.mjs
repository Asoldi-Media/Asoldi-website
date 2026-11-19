// "No Gemini for pictures or PDFs" as a checked fact (owner decision 2026-11-19: one vendor wallet for vision).
// Every image or PDF read runs on Claude. Gemini stays only for audio and video of client uploads (Claude has no
// audio or video input) and the grounded link search, which is a web search. These tests read the shipped routes,
// policy and legacy table, so a route string that names Gemini on the wrong task fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../packages/suite/core/llm/index.js';
import { ASOLDI_LLM_ROUTES, ASOLDI_LLM_POLICY, AUDIO_VIDEO_TASKS, asoldiLlmConfig } from '../packages/suite/harness/asoldi/llm.js';
import { LEGACY_TASKS, legacyRouteFor, legacyEntryFor } from '../lib/llm/config.js';

const NOW = new Date('2026-11-19T00:00:00Z');
/** Tasks that may name Gemini: audio and video, plus the grounded link search (no picture, no PDF). */
const GEMINI_TASKS = Object.freeze([...AUDIO_VIDEO_TASKS, 'sales-link.discover']);
const cfg = asoldiLlmConfig();
const legacyRoute = legacyRouteFor({});

/** Every route string in a routes config with the path it sits at. Lists (candidates, judges) are walked too. */
function routeStrings(routes) {
  const out = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (/^[a-z]+:/.test(value) || value.includes('|')) out.push({ path, value });
    } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, String(index)]));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (key !== 'note') walk(item, [...path, key]);
  };
  walk(routes, []);
  return out;
}

/** The route strings that name Gemini on a path that is not an audio or video task entry. */
function geminiOutsideAudioVideo(routes) {
  return routeStrings(routes).filter(({ path, value }) => {
    if (!/gemini/i.test(value)) return false;
    const [, , group, task] = path; // profiles.<name>.<group>.<task>
    const taskEntry = (group === 'tasks' || group === 'escalate') && AUDIO_VIDEO_TASKS.includes(task);
    return !taskEntry;
  });
}

test('no shipped route string names Gemini except the audio and video task entries', () => {
  assert.deepEqual(geminiOutsideAudioVideo(ASOLDI_LLM_ROUTES), []);
  // Control: the audio and video entries exist and are what the check lets through.
  const av = routeStrings(ASOLDI_LLM_ROUTES).filter(({ value }) => /gemini/i.test(value));
  assert.ok(av.length >= 4, JSON.stringify(av));
  assert.ok(av.every(({ path }) => AUDIO_VIDEO_TASKS.includes(path[3])), JSON.stringify(av));
  // Negative controls: a Gemini tail on a picture route, on a family, on an escalation or on the eval lists is caught.
  const plants = [
    (r) => { r.profiles.prod.vision += '|gemini:gemini-2.5-flash'; },
    (r) => { r.profiles.prod.kinds.media += '|gemini:gemini-2.5-flash-lite'; },
    (r) => { r.profiles.prod.escalate['dev.judge'][0] += '|gemini:gemini-2.5-pro'; },
    (r) => { r.profiles.prod.escalateKinds['visual-qa'][0] += '|gemini:gemini-2.5-pro'; },
    (r) => { r.profiles.test.vision = 'gemini:gemini-2.5-flash-lite|claude:claude-haiku-5-5:low'; },
    (r) => { r.profiles.eval.judges.push('gemini:gemini-2.5-pro'); },
    (r) => { r.profiles.eval.candidates.push('gemini:gemini-2.5-flash'); },
    (r) => { r.profiles.prod.tasks['step15.judge'] = 'gemini:gemini-2.5-flash'; },
  ];
  for (const [index, plant] of plants.entries()) {
    const planted = structuredClone(ASOLDI_LLM_ROUTES);
    plant(planted);
    assert.equal(geminiOutsideAudioVideo(planted).length, 1, `planted change ${index} is caught`);
  }
});

test('the shipped policy scopes Gemini to audio and video (and the link search); a picture task is refused whatever its route says', () => {
  assert.deepEqual(ASOLDI_LLM_POLICY.providers.gemini.tasks, GEMINI_TASKS);
  for (const [task, spec] of Object.entries(cfg.tasks)) {
    for (const dataClass of ['public', 'business', 'personal', 'transcript']) {
      const verdict = core.providerAllows(ASOLDI_LLM_POLICY, 'gemini', dataClass, { task, family: spec.family });
      assert.equal(verdict.allowed, GEMINI_TASKS.includes(task), `${task} (${dataClass}): ${verdict.reason}`);
    }
  }
});

test('no image or PDF task resolves to Gemini in any profile, tier, escalation step or data flag', () => {
  const tasks = Object.entries(cfg.tasks);
  const mediaTasks = tasks.filter(([key, spec]) => spec.vision || spec.family === 'media' || spec.family === 'visual-qa' || /vision|media|image|ingest|transcript|contract/.test(key));
  assert.ok(mediaTasks.length >= 15, `picture and document tasks found: ${mediaTasks.length}`);
  const profiles = ['prod', 'production', 'test', 'record', 'eval', 'replay', 'legacy'];
  const flags = [{}, { synthetic: true }, { redacted: true, imagesRedacted: true }, { dataClass: 'public' }, { dataClass: 'business' }, { dataClass: 'personal' }, { vision: false }];
  const tiers = ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce', 'custom'];
  const router = core.createRouter({ ...cfg, legacyRoute, now: NOW });
  // The legacy placeholder as the Maker resolves it is covered by the Maker's own tests; here it is the hub's table.
  let resolved = 0;
  const check = (task, ctx, extra, label) => {
    let route;
    try {
      route = router.resolveRoute(task, ctx, extra);
    } catch (error) {
      // A legacy call site on DeepSeek whose task reads pictures has no route for a picture call: refused, never Gemini.
      if (error?.code === 'route_config' && /needs vision/.test(error.message)) {
        resolved += 1;
        return;
      }
      throw error;
    }
    resolved += 1;
    if (!route.chain.some((entry) => entry.provider === 'gemini')) return;
    assert.ok(GEMINI_TASKS.includes(task), `${label} ${task}: ${route.route}`);
    // Even an audio or video task refuses a client picture: Gemini is dropped from the chain for it.
    if (extra.images >= 1 && !ctx.synthetic && !ctx.imagesRedacted && ctx.dataClass !== 'public') assert.fail(`${task} kept Gemini for a client picture`);
  };
  for (const [task] of tasks) {
    for (const profile of profiles) {
      for (const flag of flags) {
        for (const escalation of [0, 1, 2, 3]) {
          for (const images of [undefined, 0, 1]) check(task, { profile, ...flag, escalation, maxEscalation: 3 }, images === undefined ? {} : { images }, `${profile} ${JSON.stringify(flag)} step ${escalation}`);
        }
      }
      for (const tier of tiers) check(task, { profile, tier }, { images: 1 }, `${profile} tier ${tier}`);
    }
  }
  assert.ok(resolved > 10_000, `resolutions checked: ${resolved}`);
});

test('the hub legacy table: no picture task starts on Gemini, the audio and video task and the link search do', () => {
  const env = {};
  for (const task of ['assistant.products-image', 'inbox.inspect-contract', 'assistant.media-brief']) {
    const entry = legacyEntryFor(task, env);
    assert.equal(entry.provider, 'claude', task);
    assert.equal(entry.model, 'claude-haiku-5-5', task);
    assert.equal(entry.keyEnv, 'ANTHROPIC_API_KEY', task);
    assert.equal(legacyRoute(task), `claude:claude-haiku-5-5:${entry.effort}`, task);
  }
  assert.equal(legacyEntryFor('inbox.inspect-contract', env).effort, 'medium');
  assert.equal(legacyEntryFor('assistant.products-image', env).effort, 'low');
  // A Gemini model env var no longer moves a picture task.
  assert.equal(legacyEntryFor('assistant.media-brief', { CLIENT_MEDIA_VISION_MODEL: 'gemini-2.5-pro', GEMINI_MODEL: 'gemini-2.5-pro' }).provider, 'claude');
  const hubGeminiTasks = GEMINI_TASKS.filter((task) => asoldiLlmConfig('hub').tasks[task]);
  assert.deepEqual(hubGeminiTasks.sort(), ['assistant.media-brief-av', 'sales-link.discover']);
  const geminiTasks = Object.entries(LEGACY_TASKS).filter(([, spec]) => spec.provider === 'gemini').map(([task]) => task).sort();
  assert.deepEqual(geminiTasks, hubGeminiTasks);
  for (const task of hubGeminiTasks) assert.equal(legacyEntryFor(task, env).keyEnv, 'GEMINI_API_KEY', task);
});

test('audio and video still route to Gemini: flash-lite, then flash, in the production and test profiles', () => {
  const router = core.createRouter({ ...cfg, legacyRoute, now: NOW });
  for (const task of AUDIO_VIDEO_TASKS) {
    for (const profile of ['prod', 'test']) {
      const route = router.resolveRoute(task, { profile }, { images: 0 });
      assert.equal(route.route, 'gemini:gemini-2.5-flash-lite|gemini:gemini-2.5-flash', `${profile} ${task}`);
      assert.equal(route.dataClass.effective, 'business', task);
      assert.equal(route.dataClass.imageCall, false, `${task} carries no image block`);
    }
    // Real client audio on the paid tier stays allowed (recorded default until the owner chooses another route).
    assert.equal(core.providerAllows(ASOLDI_LLM_POLICY, 'gemini', 'business', { task }).allowed, true, task);
  }
  // The same task refuses the exception once the paid tier is not confirmed.
  const unpaid = structuredClone(ASOLDI_LLM_POLICY);
  unpaid.providers.gemini.paidTierConfirmedAt = null;
  const refused = core.createRouter({ ...cfg, policy: unpaid, legacyRoute, now: NOW }).resolveRoute('assistant.media-brief-av', { profile: 'prod' }, { images: 0 });
  assert.ok(!refused.chain.some((entry) => entry.provider === 'gemini'));
  // Both audio and video tasks are in the registry for their repo and take no image.
  assert.deepEqual(cfg.tasks['assistant.media-brief-av'].vision, false);
  assert.deepEqual(cfg.tasks['media.transcript-av'].vision, false);
  assert.ok(asoldiLlmConfig('hub').tasks['assistant.media-brief-av']);
  assert.ok(asoldiLlmConfig('maker').tasks['media.transcript-av']);
});

// ---------------- a PDF document block counts for the data rule ----------------

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const documentMessages = () => [{
  role: 'user',
  content: [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
    { type: 'text', text: 'List the offers in this price list.' },
  ],
}];

function mockCore({ policy = ASOLDI_LLM_POLICY, env = { AI_PROFILE: 'test' } } = {}) {
  const reached = [];
  const rows = [];
  const answer = (provider) => async (call) => {
    reached.push(provider);
    if (provider === 'claude') return core.normalizeClaudeResponse({ id: 'm', model: call.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 100, output_tokens: 10 } });
    return { servedModel: call.model, text: '{"ok":true}', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } };
  };
  const llm = core.createLlmCore({
    ...cfg,
    policy,
    env,
    legacyRoute,
    providers: { claude: answer('claude'), gemini: answer('gemini'), deepseek: answer('deepseek'), openai: answer('openai') },
    repo: 'test',
    clock: () => NOW,
    ledger: { append: (row) => rows.push(row) },
  });
  return { llm, reached, rows };
}

/** The shipped policy without Gemini's task scope, so only the data rule can keep a PDF off a planted Gemini route. */
const GEMINI_UNSCOPED = (() => {
  const { tasks: _scope, ...gemini } = ASOLDI_LLM_POLICY.providers.gemini;
  return { ...ASOLDI_LLM_POLICY, providers: { ...ASOLDI_LLM_POLICY.providers, gemini } };
})();

test('a PDF document block of client data is read by Claude only, like an image (planted Gemini route, scope removed so the data rule alone decides)', async () => {
  assert.equal(core.countDocumentBlocks(documentMessages()), 1);
  assert.equal(core.countDocumentBlocks([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }] }] }]), 1, 'inside a tool result too');
  assert.equal(core.countImageBlocks(documentMessages()), 0, 'a document is not an image for the JPEG and size rules');
  const call = (ctx = {}, policy = GEMINI_UNSCOPED) => {
    const mock = mockCore({ policy });
    return mock.llm.json({ task: 'upload.ingest', messages: documentMessages(), ctx: { runId: 'r-pdf', route: 'gemini:gemini-2.5-flash', ...ctx } }).then(
      () => mock,
      (error) => Object.assign(mock, { error }),
    );
  };
  const kept = await call();
  assert.deepEqual(kept.reached, ['claude'], 'the client PDF went to Claude');
  assert.equal(kept.rows.length, 1);
  assert.deepEqual([kept.rows[0].provider, kept.rows[0].images, kept.rows[0].dataClass, kept.rows[0].redacted], ['claude', 1, 'business', false]);
  assert.match(kept.rows[0].policyRedirect.from, /^gemini:/);
  // The text redaction flag alone never covers a PDF; both flags together are accepted (as for pictures).
  const redactedText = await call({ redacted: true });
  assert.deepEqual(redactedText.reached, ['claude']);
  const redactedBoth = await call({ redacted: true, imagesRedacted: true });
  assert.deepEqual(redactedBoth.reached, ['gemini'], 'positive control: accepted redacted pictures may leave Claude');
  const synthetic = await call({ synthetic: true });
  assert.deepEqual([synthetic.reached, synthetic.rows[0].dataClass], [['gemini'], 'synthetic'], 'positive control: a synthetic PDF may');
  // The shipped policy (with the Gemini task scope) keeps it off Gemini as well.
  const shipped = await call({}, ASOLDI_LLM_POLICY);
  assert.deepEqual(shipped.reached, ['claude'], 'with the shipped scope too');
});

test('the Gemini task scope is a second layer: the shipped policy keeps a synthetic picture off Gemini even on a planted route', async () => {
  const mock = mockCore();
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
  await mock.llm.json({ task: 'dev.judge', user: 'Does the page look right?', images: [{ mime: 'image/jpeg', base64: jpeg.toString('base64') }], ctx: { synthetic: true, route: 'gemini:gemini-2.5-flash-lite' } });
  assert.deepEqual(mock.reached, ['claude']);
  assert.match(mock.rows[0].policyRedirect.reason, /limited to/);
});

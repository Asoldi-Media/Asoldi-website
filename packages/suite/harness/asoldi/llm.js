// Asoldi's LLM data on the shared core: the one task-key registry for website-maker and the hub, and the
// reference routes, data policy and budgets. Facades load these (or a JSON copy with the same schema) and
// may override values from their own config or data-dir files; the schemas are the core's.
//
// Task keys are append-only: other areas add entries here, never rename one.

import { parseTaskRegistry, tasksForRepo } from '../../core/llm/index.js';

const M = ['maker'];
const H = ['hub'];

function t(kind, vision, dataClass, maxTokens, extra = {}) {
  return { kind, vision, dataClass, maxTokens, ...extra };
}

// Public tasks that may also read a client's own site (live-site imports, import / site intelligence). `public` holds only
// for template sources; callers pass ctx.dataClass: 'business' when the source is a client's live site, so the
// data policy keeps it off DeepSeek and unpaid Gemini.
const LIVE_SITE = { note: "public for template sources; pass ctx.dataClass 'business' when the source is a client's live site" };

// Image tasks that run inside a client run: what they capture is client data, so they are business class and the
// core's image rule keeps their images on Claude unless the call is synthetic or carries an accepted
// imagesRedacted. Every image task is business class or higher except the template-only tasks (see
// TEMPLATE_ONLY_IMAGE_TASKS in CONTRACT.md and the registry test).
const IN_RUN_CAPTURE = { note: 'runs inside a client run: its captures are client data, also when the page comes from a template; images go to Claude unless the call is synthetic or carries an accepted imagesRedacted' };

// Audio and video input exists on Gemini only. These tasks are the one place a Gemini route may appear
// (see AUDIO_VIDEO_TASKS and the registry test); every image or PDF task is Claude only.
const AV_ONLY = { note: 'audio and video of a client upload; Claude cannot read them, so this task stays on Gemini (paid tier) until the owner chooses another route' };

export const ASOLDI_LLM_TASKS = {
  version: 1,
  tasks: {
    // Maker: Step 1.5 site intelligence
    'step15.analyze': t('json', false, 'public', 8000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.curate': t('json', false, 'public', 6000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.finalize': t('json', false, 'public', 6000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.nav-resolve': t('json', false, 'public', 2000, { family: 'classification', effort: 'low', repo: M, ...LIVE_SITE }),
    'step15.judge': t('json', true, 'business', 4000, { family: 'visual-qa', repo: M, ...IN_RUN_CAPTURE }),
    'step15.media-vision': t('json', true, 'business', 2000, { family: 'media', repo: M }),
    'siteintel.page-kind-vision': t('json', true, 'business', 1000, { family: 'visual-qa', repo: M, owner: 'siteintel', ...IN_RUN_CAPTURE }),
    'siteintel.golden-judge-text': t('json', false, 'public', 1000, { family: 'judge', repo: M, owner: 'WS2', ...LIVE_SITE }),
    'siteintel.golden-judge-vision': t('json', true, 'public', 1000, { family: 'judge', repo: M, owner: 'WS2', ...LIVE_SITE }),
    // Maker: Step 2 branding
    'step2.copywriter': t('json', false, 'business', 16000, { family: 'copy', repo: M }),
    'step2.typesetter': t('json', false, 'business', 8192, { family: 'copy', repo: M }),
    'step2.copy-judge': t('json', false, 'business', 4000, { family: 'judge', repo: M }),
    'step2.repair': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'step2.claims-rewrite': t('json', false, 'business', 4000, { family: 'copy', repo: M, owner: 'WS3' }),
    // One batched call per site, only for CTAs that carry no intent marker: a closed choice of intent per label.
    'step2.cta-classify': t('json', false, 'business', 2000, { family: 'arbiter', effort: 'low', repo: M, owner: 'branding' }),
    'qa.label': t('json', false, 'business', 2000, { family: 'judge', repo: M, owner: 'WS3' }),
    // Maker: SEO and CMS
    'seo.meta': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'seo.keywords.relevance': t('json', false, 'business', 4000, { family: 'keyword-judge', effort: 'low', repo: M }),
    'cms.page-kinds': t('json', false, 'business', 2000, { family: 'classification', effort: 'low', repo: M }),
    'cms.propose': t('json', false, 'business', 4000, { family: 'extraction', repo: M }),
    // CMS hookup: closed choices where the structural rules find no answer, read from the client's branded site.
    'cms.shell-arbiter': t('json', false, 'business', 2000, {
      family: 'arbiter',
      effort: 'low',
      repo: M,
      owner: 'publish',
      note: 'which top-level body children are the header and which the footer chrome, from an outline (tag, short text, link count, position)',
    }),
    'cms.cta-arbiter': t('json', false, 'business', 2000, {
      family: 'arbiter',
      effort: 'low',
      repo: M,
      owner: 'publish',
      note: 'which commerce binding a template element gets (add to cart, cart link, buy CTA or none)',
    }),
    // CMS spec from the delivery brief: its directives carry short quotes from client meetings, so these
    // tasks are transcript data and reach DeepSeek only when the brief is synthetic.
    'cms.spec-writer': t('json', false, 'transcript', 8000, {
      family: 'brief',
      effort: 'medium',
      repo: M,
      owner: 'CMS',
      note: 'free-text brief directives the deterministic CMS spec rules do not cover; closed JSON checked by the CMS spec validator',
    }),
    'cms-spec.email': t('json', false, 'transcript', 4000, {
      family: 'brief',
      effort: 'medium',
      repo: M,
      owner: 'email',
      note: 'the email section; a value counts only when its quote is found in a brief directive',
    }),
    // Health and benefit statements in a draft or keyword plan, each with its span; any error rejects (fail closed).
    'seo.claims-extract': t('json', false, 'business', 8000, { family: 'compliance', effort: 'medium', repo: M, owner: 'SEO' }),
    // Keyword research: the scope of a business (a closed choice), the nouns of its facts, and the page map
    // (which page targets which keyword). They read client facts, so production is Claude only; DeepSeek runs
    // them only in the test profile, on synthetic data.
    'seo.scope': t('json', false, 'business', 2000, { family: 'seo', effort: 'low', repo: M, owner: 'SEO' }),
    'seo.facts-nouns': t('json', false, 'business', 4000, { family: 'seo', effort: 'low', repo: M, owner: 'SEO' }),
    'seo.page-map': t('json', false, 'business', 8000, { family: 'seo', effort: 'medium', repo: M, owner: 'SEO' }),
    // Maker: intake, media, import
    'quickfill.narrative': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'quickfill.colors': t('json', true, 'business', 1000, { family: 'media', repo: M }),
    'quickfill.social': t('json', true, 'business', 2000, { family: 'media', repo: M }),
    'media.transcript': t('json', true, 'business', 1500, { family: 'media', repo: M }),
    // Audio and video of a client upload. Claude has no audio or video input, so this is the one task family that
    // stays on Gemini (paid tier). It sends no image; images use media.transcript on Claude.
    'media.transcript-av': t('json', false, 'business', 1500, { family: 'media-av', repo: M, ...AV_ONLY }),
    'media.categorize': t('json', true, 'business', 1500, { family: 'media', repo: M }),
    'icon.resolve': t('json', false, 'public', 1000, { family: 'classification', effort: 'low', repo: M }),
    'icon.resolve-vision': t('json', true, 'business', 1000, { family: 'classification', effort: 'low', repo: M, ...IN_RUN_CAPTURE }),
    'products.import': t('json', false, 'business', 8000, { family: 'extraction', repo: M }),
    'template-import.classify': t('json', false, 'public', 4000, { family: 'classification', effort: 'low', repo: M, ...LIVE_SITE }),
    'template-import.qa-vision': t('json', true, 'public', 4000, { family: 'visual-qa', repo: M, owner: 'WS1', ...LIVE_SITE }),
    'upload.ingest': t('json', true, 'business', 2000, { family: 'extraction', repo: M }),
    'data-extract.repair': t('json', false, 'business', 4000, { family: 'extraction', repo: M }),
    // Maker: automatic development agent and model evaluation (developer automation)
    'dev.plan': t('json', true, 'personal', 16000, { family: 'plan', repo: M, owner: 'WS4' }),
    'dev.copy': t('json', false, 'personal', 8000, { family: 'copy', repo: M, owner: 'WS4' }),
    'dev.judge': t('json', true, 'business', 4000, { family: 'visual-qa', repo: M, owner: 'WS4' }),
    'dev.locate': t('json', true, 'business', 2000, { family: 'visual-qa', repo: M, owner: 'WS4' }),
    'eval.judge': t('json', true, 'business', 4000, { family: 'judge', repo: M, owner: 'WS4' }),
    // Hub: offers, workshops, assistant, inbox, Infokort
    'offer.fill-from-transcript': t('json', false, 'transcript', 4000, { family: 'extraction', repo: H }),
    'offer.reflect-contract': t('json', false, 'personal', 4000, { family: 'copy', repo: H }),
    'offer.summarize-intent': t('json', false, 'transcript', 2000, { family: 'extraction', repo: H }),
    'workshop.summary': t('json', false, 'transcript', 4000, { family: 'brief', repo: H }),
    'workshop.project-document': t('json', false, 'transcript', 8000, { family: 'brief', repo: H }),
    'workshop.transcript-eval': t('json', false, 'transcript', 4000, { family: 'judge', repo: H }),
    'booker.preview-document': t('json', false, 'business', 4000, { family: 'copy', repo: H }),
    'assistant.chat': t('json', false, 'personal', 4000, { family: 'copy', repo: H }),
    'assistant.gather': t('json', false, 'personal', 4000, { family: 'extraction', repo: H }),
    'assistant.products-ingest': t('json', true, 'business', 8000, { family: 'extraction', repo: H }),
    // Hub: a price list or menu photo read as plain text lines, and a client media file's placement brief.
    'assistant.products-image': t('text', true, 'business', 4000, { family: 'extraction', repo: H }),
    'assistant.media-brief': t('json', true, 'business', 2000, { family: 'media', repo: H }),
    // The audio and video part of a client file's placement brief: Gemini only (Claude has no audio or video input).
    'assistant.media-brief-av': t('json', false, 'business', 2000, { family: 'media-av', repo: H, ...AV_ONLY }),
    'inbox.categorize': t('json', false, 'personal', 2000, { family: 'classification', effort: 'low', repo: H }),
    'inbox.decide': t('json', false, 'personal', 4000, { family: 'extraction', repo: H }),
    'inbox.inspect-contract': t('json', true, 'personal', 4000, { family: 'extraction', repo: H }),
    'infokort.agent': t('tools', false, 'public', 4096, { family: 'agent', repo: H }),
    // A real business's name, city, phone and address: business data (Q5), not public.
    'sales-link.discover': t('json', false, 'business', 4000, { family: 'extraction', repo: H }),
    // Hub: delivery brief and change requests
    'brief.map': t('json', false, 'transcript', 8000, { family: 'brief', repo: H, owner: 'WS8' }),
    'brief.reduce': t('json', false, 'transcript', 16000, { family: 'brief', repo: H, owner: 'WS8' }),
    'brief.iteration': t('json', false, 'transcript', 8000, { family: 'brief', repo: H, owner: 'WS8' }),
    // A closed choice over a client's own words (personal data): Claude only in production, with no DeepSeek
    // fallback even for synthetic or redacted text (the arbiter family).
    'change.classify': t('json', false, 'personal', 2000, { family: 'arbiter', effort: 'low', repo: H, owner: 'delivery' }),
    'followups.extract': t('json', false, 'transcript', 4000, { family: 'extraction', repo: H, owner: 'WS8' }),
    // Hub: SEO keyword proposals from meetings, a focused second pass on transcript chunks with keyword talk
    // but no clean phrase. Proposals are never approved automatically.
    'seo.agreed-extract': t('json', false, 'transcript', 4000, { family: 'brief', effort: 'medium', repo: H, owner: 'SEO' }),
  },
};

/**
 * Starting routes before the model evaluation (owner order: DeepSeek for tests, then Haiku 5.5, then other
 * Claude, then Gemini). Production routes by task family; developer automation's evaluation adopts values into `tasks`.
 * Q5: real client data runs on Claude (or replay). DeepSeek stays only as a fallback for families whose tasks
 * are mostly public (template HTML, template classification); the data policy removes it for any client data.
 * When such a task reads a client's live site, the caller passes ctx.dataClass 'business' (see LIVE_SITE).
 * Every image or PDF read is Claude only (owner decision 2026-11-19: one vendor wallet for vision). The only Gemini
 * entries left are the audio and video tasks (AUDIO_VIDEO_TASKS): Claude has no audio or video input, and the
 * owner confirmed the paid Gemini tier on 2026-11-10 (ASOLDI_LLM_POLICY below).
 * DeepSeek in production (owner decision 2026-11-13): fallback for synthetic or redacted payloads only; the
 * policy skips this entry for unredacted real-client data. It stays second choice for classification and extraction.
 * The judge of the development agent never runs on the planner's model: dev.judge starts on Sonnet 5.5 where
 * dev.plan starts on Haiku 5.5, and their escalation lists differ at every step.
 * `eval` is the model-evaluation profile: production routes plus explicit lists. `candidates` are the models an
 * evaluation compares and `judges` the blind panel; each item is one route entry with no fallback, so an answer
 * or verdict always comes from the model named. OpenAI appears only as a judge (the policy limits it to the
 * evaluation tasks); Gemini is neither a candidate nor a judge.
 */
/** The tasks that carry audio or video. The only tasks whose routes may name Gemini (every other task is Claude, DeepSeek or OpenAI). */
export const AUDIO_VIDEO_TASKS = Object.freeze(['media.transcript-av', 'assistant.media-brief-av']);
const AV_ROUTE = 'gemini:gemini-2.5-flash-lite|gemini:gemini-2.5-flash';

export const ASOLDI_LLM_ROUTES = {
  version: 1,
  profiles: {
    legacy: {
      default: '${legacy}',
      vision: '${legacy}',
      note: "Today's provider per call site (the facade supplies legacyRoute()), filtered by the data policy like every profile.",
    },
    prod: {
      default: 'claude:claude-haiku-5-5:medium',
      vision: 'claude:claude-haiku-5-5:medium',
      note: 'DeepSeek (second choice of classification and extraction): fallback for synthetic or redacted payloads only; the policy skips this entry for unredacted real-client data.',
      kinds: {
        // DeepSeek here: fallback for synthetic or redacted payloads only; the policy skips this entry for
        // unredacted real-client data.
        classification: 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash',
        extraction: 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash',
        copy: 'claude:claude-haiku-5-5:medium',
        plan: 'claude:claude-haiku-5-5:medium',
        'visual-qa': 'claude:claude-haiku-5-5:medium',
        media: 'claude:claude-haiku-5-5:low',
        brief: 'claude:claude-haiku-5-5:medium',
        'keyword-judge': 'claude:claude-haiku-5-5:low',
        judge: 'claude:claude-haiku-5-5:medium',
        agent: 'claude:claude-haiku-5-5:medium',
        // Closed-choice arbiters and claims extraction always read client data: Claude only in production,
        // with no DeepSeek fallback even for synthetic data (the test profile is where DeepSeek runs).
        arbiter: 'claude:claude-haiku-5-5:low',
        compliance: 'claude:claude-haiku-5-5:medium',
        // Keyword research reads client facts: Claude only (the task sets low or medium effort).
        seo: 'claude:claude-haiku-5-5:medium',
      },
      tasks: {
        'eval.judge': 'claude:claude-opus-5-5:high',
        // The judge is never the planner's model (dev.plan starts on Haiku 5.5).
        'dev.judge': 'claude:claude-sonnet-5-5:medium',
        // One signature question on a contract page: accuracy matters and the cost is cents.
        'inbox.inspect-contract': 'claude:claude-haiku-5-5:medium',
        // Audio and video: Gemini only (flash-lite, then flash), no image is sent.
        'assistant.media-brief-av': AV_ROUTE,
        'media.transcript-av': AV_ROUTE,
      },
      escalate: {
        // Step by step: plan Haiku -> Sonnet -> Opus, judge Sonnet -> Opus -> Sonnet (high): never the same model.
        'dev.plan': ['claude:claude-sonnet-5-5:medium', 'claude:claude-opus-5-5:medium'],
        'dev.judge': ['claude:claude-opus-5-5:medium', 'claude:claude-sonnet-5-5:high'],
      },
      escalateKinds: {
        classification: ['claude:claude-haiku-5-5:medium'],
        extraction: ['claude:claude-haiku-5-5:medium'],
        copy: ['claude:claude-sonnet-5-5:medium'],
        plan: ['claude:claude-sonnet-5-5:medium', 'claude:claude-sonnet-5-5:high'],
        'visual-qa': ['claude:claude-sonnet-5-5:medium'],
        brief: ['claude:claude-sonnet-5-5:medium'],
        'keyword-judge': ['claude:claude-haiku-5-5:medium'],
        judge: ['claude:claude-sonnet-5-5:medium'],
        arbiter: ['claude:claude-haiku-5-5:medium'],
        compliance: ['claude:claude-sonnet-5-5:medium'],
        seo: ['claude:claude-sonnet-5-5:medium'],
      },
    },
    test: {
      default: 'deepseek:deepseek-flash',
      vision: 'claude:claude-haiku-5-5:low',
      kinds: { agent: 'claude:claude-haiku-5-5:low' },
      tasks: { 'assistant.media-brief-av': AV_ROUTE, 'media.transcript-av': AV_ROUTE },
      note: 'DeepSeek for text on public or synthetic data, and on redacted data that is not a transcript (Q5); the policy moves real client data and every non-synthetic transcript to Claude Haiku at the task effort.',
    },
    replay: { default: 'replay:strict', vision: 'replay:strict' },
    record: { inherit: 'test', record: true },
    eval: {
      inherit: 'prod',
      // Owner order: DeepSeek, then Haiku 5.5, then other Claude. DeepSeek candidates run only on
      // synthetic or redacted items (the data policy removes them otherwise).
      candidates: [
        'deepseek:deepseek-flash',
        'deepseek:deepseek-v4-pro',
        'claude:claude-haiku-5-5:low',
        'claude:claude-haiku-5-5:medium',
        'claude:claude-haiku-5-5:high',
        'claude:claude-sonnet-5-5:medium',
        'claude:claude-sonnet-5-5:high',
        'claude:claude-opus-5-5:medium',
      ],
      judges: ['claude:claude-opus-5-5:high', 'openai:gpt-4.1'],
      note: 'Model evaluation: production routes plus explicit candidates and judges (one entry each, no fallback). OpenAI is a judge only; images of real-client data stay on Claude unless redacted.',
    },
  },
};

/** Owner decision Q5. The core hard-codes the DeepSeek rules; this file can only narrow them further. */
export const ASOLDI_LLM_POLICY = {
  version: 1,
  providers: {
    claude: { allow: ['public', 'business', 'personal', 'transcript'], dpa: 'anthropic-commercial-terms' },
    gemini: {
      allow: ['public', 'business', 'personal', 'transcript'],
      billingTier: 'paid',
      paidTierConfirmedAt: '2026-11-10',
      allowUnpaidPublic: false,
      tasks: [...AUDIO_VIDEO_TASKS, 'sales-link.discover'],
      note: 'Audio and video of client uploads only (media.transcript-av, assistant.media-brief-av; Claude has no audio or video input), plus the grounded link search of sales-link.discover. Paid tier confirmed by the owner on 2026-11-10 (the core needs both billingTier paid and the date). Images of real-client data go only to Claude (core image rule), and no image or PDF task has a Gemini route.',
    },
    deepseek: { allow: ['public', 'business'], note: 'Never personal or transcript data; client data only when synthetic or redacted (Q5).' },
    openai: {
      allow: ['public', 'business'],
      tasks: ['eval.judge', 'siteintel.golden-judge-text', 'siteintel.golden-judge-vision'],
      note: 'Q5: OpenAI only as the third evaluation judge.',
    },
  },
  redirect: 'claude:claude-haiku-5-5',
  // Known LLM calls outside the core, so outside this policy, ledger and budgets (critic platform #36).
  exceptions: [
    {
      id: 'cms-local-blog-job',
      provider: 'deepseek',
      where: 'website-cms server/local-blog-job.js',
      dataClass: 'business',
      owner: 'WS9',
      reason: 'The CMS generates local blog posts by calling DeepSeek directly (with temperature, per-site DEEPSEEK_API_KEY). WS9 moves it to a hub relay endpoint that uses lib/llm (ledger, budgets, this policy); until then it is a known exception.',
    },
  ],
};

/** Expected costs scale with project size; reaching them alerts, only 5x (runaway) or a loop stops. */
export const ASOLDI_LLM_BUDGETS = {
  version: 1,
  alertRatio: 1,
  runawayFactor: 5,
  scopes: {
    run: { baseUsd: { default: 2, 'tier-1-standard': 1, 'tier-2-seo': 1.5, 'tier-3-ecommerce': 3 }, referencePages: 6, extraLocaleFactor: 0.75, productsPerPage: 20 },
    devSession: { baseUsd: { default: 2.5, 'tier-1-standard': 1.5, 'tier-2-seo': 2.5, 'tier-3-ecommerce': 4 }, referencePages: 6, extraLocaleFactor: 0.75, productsPerPage: 20 },
    iteration: { of: 'devSession', factor: 0.5 },
    step2: { baseUsd: { default: 0.6 }, referencePages: 6, extraLocaleFactor: 0.75, productsPerPage: 20 },
    // Opt-in scopes (ctx.budgetScope plus the run or job id); a call without one counts toward its run as before.
    cmsHookup: {
      baseUsd: { default: 0.3, 'tier-3-ecommerce': 0.5 },
      referencePages: 6,
      extraLocaleFactor: 0.75,
      productsPerPage: 20,
      note: 'one CMS hookup attempt: shell and CTA arbiters, the CMS spec writer and its email section',
    },
    seoPass: {
      baseUsd: { default: 0.4 },
      referencePages: 6,
      extraLocaleFactor: 0.75,
      productsPerPage: 20,
      note: 'one SEO pass of a run: meta, keyword relevance and the claims check',
    },
    meetingKeywords: { baseUsd: { default: 0.2 }, note: "one keyword pass over a client's meeting transcripts in the hub" },
  },
  periodic: { clientMonthUsd: 10, makerDayUsd: 15, hubDayUsd: 5, evalTotalUsd: 200 },
  loop: { maxRepeats: 3, maxIdentical: 6, windowMinutes: 15 },
};

/**
 * Parsed config for one repo ('maker' or 'hub'), ready for createLlmCore({...asoldiLlmConfig(repo), providers}).
 * The shared routes name both repos' tasks, so a repo config passes unknownTasks:'warn' (the other repo's task
 * routes become warnings) and its repo name (for the makerDay / hubDay periodic budget).
 */
export function asoldiLlmConfig(repo = '') {
  const all = parseTaskRegistry(ASOLDI_LLM_TASKS);
  return {
    tasks: repo ? tasksForRepo(all, repo) : all,
    routes: ASOLDI_LLM_ROUTES,
    policy: ASOLDI_LLM_POLICY,
    budgets: ASOLDI_LLM_BUDGETS,
    ...(repo ? { repo, unknownTasks: 'warn' } : {}),
  };
}

// Asoldi's LLM data on the shared core: the one task-key registry for website-maker and the hub, and the
// reference routes, data policy and budgets. Facades load these (or a JSON copy with the same schema) and
// may override values from their own config or data-dir files; the schemas are the core's.
//
// Task keys are append-only: other workstreams add entries here, never rename one.

import { parseTaskRegistry, tasksForRepo } from '../../core/llm/index.js';

const M = ['maker'];
const H = ['hub'];

function t(kind, vision, dataClass, maxTokens, extra = {}) {
  return { kind, vision, dataClass, maxTokens, ...extra };
}

// Public tasks that may also read a client's own site (live-site imports, WS1 / WS2.24). `public` holds only
// for template sources; callers pass ctx.dataClass: 'business' when the source is a client's live site, so the
// data policy keeps it off DeepSeek and unpaid Gemini.
const LIVE_SITE = { note: "public for template sources; pass ctx.dataClass 'business' when the source is a client's live site" };

export const ASOLDI_LLM_TASKS = {
  version: 1,
  tasks: {
    // Maker: Step 1.5 site intelligence
    'step15.analyze': t('json', false, 'public', 8000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.curate': t('json', false, 'public', 6000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.finalize': t('json', false, 'public', 6000, { family: 'extraction', repo: M, ...LIVE_SITE }),
    'step15.nav-resolve': t('json', false, 'public', 2000, { family: 'classification', effort: 'low', repo: M, ...LIVE_SITE }),
    'step15.judge': t('json', true, 'public', 4000, { family: 'visual-qa', repo: M, ...LIVE_SITE }),
    'step15.media-vision': t('json', true, 'business', 2000, { family: 'media', repo: M }),
    'siteintel.page-kind-vision': t('json', true, 'public', 1000, { family: 'visual-qa', repo: M, owner: 'WS2', ...LIVE_SITE }),
    'siteintel.golden-judge-text': t('json', false, 'public', 1000, { family: 'judge', repo: M, owner: 'WS2', ...LIVE_SITE }),
    'siteintel.golden-judge-vision': t('json', true, 'public', 1000, { family: 'judge', repo: M, owner: 'WS2', ...LIVE_SITE }),
    // Maker: Step 2 branding
    'step2.copywriter': t('json', false, 'business', 16000, { family: 'copy', repo: M }),
    'step2.typesetter': t('json', false, 'business', 8192, { family: 'copy', repo: M }),
    'step2.copy-judge': t('json', false, 'business', 4000, { family: 'judge', repo: M }),
    'step2.repair': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'step2.claims-rewrite': t('json', false, 'business', 4000, { family: 'copy', repo: M, owner: 'WS3' }),
    'step2.cta-classify': t('json', false, 'business', 2000, { family: 'classification', effort: 'low', repo: M, owner: 'WS3' }),
    'qa.label': t('json', false, 'business', 2000, { family: 'judge', repo: M, owner: 'WS3' }),
    // Maker: SEO and CMS
    'seo.meta': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'seo.keywords.relevance': t('json', false, 'business', 4000, { family: 'keyword-judge', effort: 'low', repo: M }),
    'cms.page-kinds': t('json', false, 'business', 2000, { family: 'classification', effort: 'low', repo: M }),
    'cms.propose': t('json', false, 'business', 4000, { family: 'extraction', repo: M }),
    'cms-spec.email': t('json', false, 'transcript', 4000, { family: 'extraction', repo: M, owner: 'WS7' }),
    // Maker: intake, media, import
    'quickfill.narrative': t('json', false, 'business', 4000, { family: 'copy', repo: M }),
    'quickfill.colors': t('json', true, 'business', 1000, { family: 'media', repo: M }),
    'quickfill.social': t('json', true, 'business', 2000, { family: 'media', repo: M }),
    'media.transcript': t('json', true, 'business', 1500, { family: 'media', repo: M }),
    'media.categorize': t('json', true, 'business', 1500, { family: 'media', repo: M }),
    'icon.resolve': t('json', false, 'public', 1000, { family: 'classification', effort: 'low', repo: M }),
    'icon.resolve-vision': t('json', true, 'public', 1000, { family: 'classification', effort: 'low', repo: M }),
    'products.import': t('json', false, 'business', 8000, { family: 'extraction', repo: M }),
    'template-import.classify': t('json', false, 'public', 4000, { family: 'classification', effort: 'low', repo: M, ...LIVE_SITE }),
    'template-import.qa-vision': t('json', true, 'public', 4000, { family: 'visual-qa', repo: M, owner: 'WS1', ...LIVE_SITE }),
    'upload.ingest': t('json', true, 'business', 2000, { family: 'extraction', repo: M }),
    'data-extract.repair': t('json', false, 'business', 4000, { family: 'extraction', repo: M }),
    // Maker: automatic development agent and model evaluation (WS4)
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
    'inbox.categorize': t('json', false, 'personal', 2000, { family: 'classification', effort: 'low', repo: H }),
    'inbox.decide': t('json', false, 'personal', 4000, { family: 'extraction', repo: H }),
    'inbox.inspect-contract': t('json', true, 'personal', 4000, { family: 'extraction', repo: H }),
    'infokort.agent': t('tools', false, 'public', 4096, { family: 'agent', repo: H }),
    // A real business's name, city, phone and address: business data (Q5), not public.
    'sales-link.discover': t('json', false, 'business', 4000, { family: 'extraction', repo: H }),
    // Hub: delivery brief and change requests (WS8)
    'brief.map': t('json', false, 'transcript', 8000, { family: 'brief', repo: H, owner: 'WS8' }),
    'brief.reduce': t('json', false, 'transcript', 16000, { family: 'brief', repo: H, owner: 'WS8' }),
    'brief.iteration': t('json', false, 'transcript', 8000, { family: 'brief', repo: H, owner: 'WS8' }),
    'change.classify': t('json', false, 'personal', 2000, { family: 'classification', effort: 'low', repo: H, owner: 'WS8' }),
    'followups.extract': t('json', false, 'transcript', 4000, { family: 'extraction', repo: H, owner: 'WS8' }),
  },
};

/**
 * Starting routes before the model evaluation (owner order: DeepSeek for tests, then Haiku 5.5, then other
 * Claude, then Gemini). Production routes by task family; WS4's evaluation adopts values into `tasks`.
 * Q5: real client data runs on Claude (or replay). DeepSeek stays only as a fallback for families whose tasks
 * are mostly public (template HTML, template classification); the data policy removes it for any client data.
 * When such a task reads a client's live site, the caller passes ctx.dataClass 'business' (see LIVE_SITE).
 * Gemini entries take effect once WS0.34 confirms the paid tier; until then the policy removes them.
 */
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
      vision: 'claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash',
      kinds: {
        classification: 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash',
        extraction: 'claude:claude-haiku-5-5:low|deepseek:deepseek-flash',
        copy: 'claude:claude-haiku-5-5:medium',
        plan: 'claude:claude-haiku-5-5:medium',
        'visual-qa': 'claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash',
        media: 'claude:claude-haiku-5-5:low|gemini:gemini-2.5-flash-lite',
        brief: 'claude:claude-haiku-5-5:medium',
        'keyword-judge': 'claude:claude-haiku-5-5:low',
        judge: 'claude:claude-haiku-5-5:medium',
        agent: 'claude:claude-haiku-5-5:medium',
      },
      tasks: {
        'eval.judge': 'claude:claude-opus-5-5:high',
      },
      escalate: {
        'dev.plan': ['claude:claude-sonnet-5-5:medium', 'claude:claude-opus-5-5:medium'],
        'dev.judge': ['claude:claude-sonnet-5-5:medium|gemini:gemini-2.5-pro'],
      },
      escalateKinds: {
        classification: ['claude:claude-haiku-5-5:medium'],
        extraction: ['claude:claude-haiku-5-5:medium'],
        copy: ['claude:claude-sonnet-5-5:medium'],
        plan: ['claude:claude-sonnet-5-5:medium', 'claude:claude-sonnet-5-5:high'],
        'visual-qa': ['claude:claude-sonnet-5-5:medium|gemini:gemini-2.5-pro'],
        brief: ['claude:claude-sonnet-5-5:medium'],
        'keyword-judge': ['claude:claude-haiku-5-5:medium'],
        judge: ['claude:claude-sonnet-5-5:medium'],
      },
    },
    test: {
      default: 'deepseek:deepseek-flash',
      vision: 'gemini:gemini-2.5-flash-lite|claude:claude-haiku-5-5:low',
      kinds: { agent: 'claude:claude-haiku-5-5:low' },
      note: 'DeepSeek for text on public or synthetic data, and on redacted data that is not a transcript (Q5); the policy moves real client data and every non-synthetic transcript to Claude Haiku at the task effort.',
    },
    replay: { default: 'replay:strict', vision: 'replay:strict' },
    record: { inherit: 'test', record: true },
  },
};

/** Owner decision Q5. The core hard-codes the DeepSeek rules; this file can only narrow them further. */
export const ASOLDI_LLM_POLICY = {
  version: 1,
  providers: {
    claude: { allow: ['public', 'business', 'personal', 'transcript'], dpa: 'anthropic-commercial-terms' },
    gemini: {
      allow: ['public', 'business', 'personal', 'transcript'],
      billingTier: 'unknown',
      paidTierConfirmedAt: null,
      allowUnpaidPublic: false,
      note: 'Gemini only after the paid tier is confirmed (Q5; WS0.34 sets billingTier and the date).',
    },
    deepseek: { allow: ['public', 'business'], note: 'Never personal or transcript data; client data only when synthetic or redacted (Q5).' },
    openai: {
      allow: ['public', 'business'],
      tasks: ['eval.judge', 'siteintel.golden-judge-text', 'siteintel.golden-judge-vision'],
      note: 'Q5: OpenAI only as the third evaluation judge.',
    },
  },
  redirect: 'claude:claude-haiku-5-5',
  // Known LLM calls outside the core, so outside this policy, ledger and budgets (critic WS0 #36).
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

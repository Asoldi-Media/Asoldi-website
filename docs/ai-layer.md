# Hub AI layer (`lib/llm`)

Every LLM call the hub makes goes through one facade on the shared core (`packages/suite/core/llm`,
contract 1.2.0). The facade adds the hub's provider clients, the AI ledger, data-dir overrides, budget
alerts and the Superadmin view. The shared task registry, reference routes, data policy and budgets are
in `packages/suite/harness/asoldi/llm.js`.

## Profiles

| Profile | What a call does |
|---|---|
| `legacy` (default) | Each call site sends its own request exactly as before the facade (same provider, model, temperature, prompts and `max_tokens`). The facade only records it in the ledger, with `shadowRoute`: the route the `prod` profile would take. |
| `prod` | Per-task routes from the shared config, filtered by the data policy: transcripts and personal data never go to DeepSeek, and client data goes to Gemini only after its paid tier is confirmed. Claude requests are built by the core (no `temperature`/`top_p`/`top_k`, adaptive thinking, `output_config.effort`, a `max_tokens` floor of 4096, strict tools). |
| `test`, `replay`, `record` | Local use: DeepSeek for synthetic data, cassette replay, cassette recording. The data override can choose them only while hub safe mode is on (or in a local run with `AI_PROFILE` set); elsewhere the override may choose `legacy` or `prod`. |

The profile comes from, in order: env `AI_PROFILE` (local runs and tests), the `profile` field of
`<dataDir>/ai-routes.override.json`, `AI_TEST_MODE=1` (test), else `legacy`. Production switches only
through the data override (Superadmin card or `PUT /api/admin/ai/routes`), never through env.

Two off switches make every call site send its request directly, as before the facade, with nothing
recorded:

- `"facade": false` in `<dataDir>/ai-routes.override.json` (Superadmin card "Turn off", or
  `PUT /api/admin/ai/routes {"facade":false}`). It is checked on every call and works even when the
  rest of the override does not validate. `{"facade":true}` turns the facade back on and keeps the
  saved profile.
- `HUB_LLM_FACADE=0` (optional env, read only): the facade is not registered at boot.

While either is set, `GET /api/admin/ai/status` reports `facade.callSites: "direct"` and a profile
change is refused with 409.

## Call sites and task keys

| Task | Call site | Legacy provider |
|---|---|---|
| `offer.fill-from-transcript`, `offer.reflect-contract`, `offer.summarize-intent` | `lib/offer-ai.js` | DeepSeek |
| `workshop.summary`, `workshop.project-document`, `workshop.transcript-eval` | `lib/workshop-*.js` | DeepSeek |
| `booker.preview-document` | `lib/booker-preview-document.js` | DeepSeek |
| `assistant.chat`, `assistant.gather`, `assistant.products-ingest` | `lib/ai-assistant/*` | DeepSeek |
| `assistant.products-image` | `lib/ai-assistant/products-ingest.js` (price list photo to text) | Gemini |
| `assistant.media-brief` | `lib/ai-assistant/media-transcript.js` (client media brief) | Gemini |
| `inbox.categorize`, `inbox.decide` | `lib/inbox-bot/*` | DeepSeek |
| `inbox.inspect-contract` | `lib/inbox-bot/inspect-contract.js` | Gemini |
| `sales-link.discover` | `lib/sales-link-discovery.js` (Google Search grounding) | Gemini |
| `infokort.agent` | `lib/infokort-agent.js` (tool loop) | Claude Haiku 5.5 |
| `brief.map`, `brief.reduce`, `brief.iteration`, `change.classify`, `followups.extract` | WS8 (no call site yet) | Claude Haiku 5.5 |

- `lib/deepseek.js` (`deepseekChatJson`) and `lib/claude-messages.js` (`claudeMessages`,
  `claudeToolLoop`) are wrappers over the facade. Call sites pass `task` (and `ctx.salesClientId`
  where they know it); `deps.chat` injection in tests is unchanged.
- Modules that the browser app also bundles reach the facade through `lib/llm-hooks.js`, which has
  no imports. The server registers the facade at boot (`lib/llm/boot.js`).
- Grounded search (`sales-link.discover`) and video or audio media briefs need Gemini. On a non-legacy
  profile they run only while the task's route still allows Gemini; otherwise they return no result.
- `scripts/llm-hub-callsites.test.mjs` keeps provider endpoints and SDKs inside `lib/llm/` and the two
  wrappers, and requires a registered task key on every call.

## Ledger, spend and budgets

- `<dataDir>/ai/ledger-YYYY-MM.jsonl`: one v2 row per provider attempt (task, provider, requested and
  served model, profile, tokens, USD priced from the served model, status, `attempt`, `salesClientId`).
  A call that tried more than once (the grounded search retry without `thinkingConfig`, the next media
  model) writes a row for each attempt. An answer that was billed but not usable (DeepSeek text that is
  not JSON) is an error row with its tokens and price.
- Several hub processes may share the data dir. Totals (the card, budgets, `spend-summary.json`) are
  always counted from the ledger file on disk, so rows from every process are included.
- `<dataDir>/ai/spend-summary.json`: today and this month, by task and provider.
- `<dataDir>/ai/alerts-YYYY-MM.jsonl`: budget alerts, one per scope, client, run and UTC day. Caps
  never stop work; only the core's runaway (more than 5x expected in one run or session) or loop rules
  stop a call.
- `<dataDir>/ai-budgets.override.json`: partial budgets merged over the shared ones (for example
  `{ "periodic": { "hubDayUsd": 5, "clientMonthUsd": 10 } }`).
- The Maker reports its own spend with the callback event `run.ai.spend`
  `{ runId, salesClientId, totalUsd, byTask, calls?, profile?, at }`; `at` is required (400 without
  it). It is stored as `makerRun.aiSpend` (only for the client's linked run; an older snapshot, or one
  with fewer calls at the same `at`, is ignored) and per run in `<dataDir>/ai/maker-spend.json`. Only
  this callback writes `makerRun.aiSpend`, and it is dropped when the client is linked to another run.

## Admin endpoints (Superadmin)

- `GET /api/admin/ai/status[?probe=1]`: profile and source, overrides, provider keys, routes per task
  with the prod shadow route, spend, alerts. Without `probe` it makes no network call; with it, free
  key checks run side by side (Anthropic model list, DeepSeek balance, Gemini model list), each with a
  15 second limit, cached for 10 minutes and skipped while safe mode blocks AI calls. `facade` tells
  whether the call sites use the facade.
- `GET /api/admin/ai/spend?from&to&by=task|client|provider|model|run&salesClientId=`: ledger totals;
  with `salesClientId` also the Maker's runs, and the sum of both.
- `PUT /api/admin/ai/routes` with `{ profile?, profiles?, facade? }`: validated against the shared
  registry and price table, then written to `<dataDir>/ai-routes.override.json` (replacing the previous
  override; `facade` is kept unless the body sets it). 400 for an invalid override or a local-only
  profile, 409 for a profile change while the call sites do not use the facade.

## Safe mode

Every provider call goes through the `aiCalls` guard (`lib/safe-mode-ai.js`): the legacy requests in the
wrappers and Gemini call sites, the core's provider adapters (`lib/llm/providers/*`) and the
provider-specific calls. In safe mode a call is replayed from a cassette or answered with a stub, the
attempt is recorded as an `aiCalls` intent, and the ledger row has `usd: 0`.

## Before switching production to `prod`

1. `GET /api/admin/ai/status?probe=1` shows the Anthropic key as `ok`.
2. Compare a sample of `shadowRoute` rows in the ledger with the outputs you expect.
3. Switch with the card (or `PUT /api/admin/ai/routes {"profile":"prod"}`); switch back the same way.
4. If the facade itself misbehaves, turn it off with the card or `PUT /api/admin/ai/routes {"facade":false}`.

# Hub AI layer (`lib/llm`)

Every LLM call the hub makes goes through one facade on the shared core (`packages/suite/core/llm`,
contract 1.3.0). The facade adds the hub's provider clients, the AI ledger, data-dir overrides, budget
alerts and the Superadmin view. The shared task registry, reference routes, data policy and budgets are
in `packages/suite/harness/asoldi/llm.js`.

## Profiles

| Profile | What a call does |
|---|---|
| `legacy` (default) | Each call site sends its own request exactly as before the facade (same provider, model, temperature, prompts and `max_tokens`). The facade only records it in the ledger, with `shadowRoute`: the route the `prod` profile would take. One exception, the image rule below: a call that carries a picture of client data never runs a request to another provider than Claude. |
| `prod` | Per-task routes from the shared config, filtered by the data policy: transcripts and personal data never go to DeepSeek, every picture goes to Claude (Haiku 5.5), and Gemini is used only for audio and video of client uploads (paid tier, confirmed 2026-11-10). Claude requests are built by the core (no `temperature`/`top_p`/`top_k`, adaptive thinking, `output_config.effort`, a `max_tokens` floor of 4096, strict tools). |
| `test`, `replay`, `record`, `eval` | Local use: DeepSeek for synthetic data, cassette replay, cassette recording, model evaluation. The data override can choose them only while hub safe mode is on (or in a local run with `AI_PROFILE` set); elsewhere the override may choose `legacy` or `prod`. |

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

## Data policy: pictures, DeepSeek and Gemini

**One vendor for vision (owner decision 2026-11-19).** Every image or PDF read runs on Claude Haiku 5.5 (Sonnet 5.5
or Opus 5.5 where a stronger model is needed). No route of an image or PDF task names Gemini, and the policy limits
Gemini to the tasks that need it: audio and video of a client upload (`assistant.media-brief-av`, and the Maker's
`media.transcript-av`), because Claude has no audio or video input, plus the grounded link search
(`sales-link.discover`, a web search rather than vision). `GEMINI_API_KEY` is optional for everything else.
`scripts/llm-no-gemini.test.mjs` fails when a route string, a legacy entry or the policy lets any other task reach Gemini. The hub has no
native PDF block call: contract PDFs are rasterized to a page picture, and price list PDFs are read as text.

The hard rules live in the core (`packages/suite/core/llm/policy.js`, `CONTRACT.md` section 5). A config file
can only make them stricter. They apply in every profile, `legacy` included.

- **Pictures of client data go only to Claude.** A call with at least one image block (in `images`, or inside
  a message or a tool result) and a data class above `public` keeps only its Claude route entries. If none is
  left, the policy moves the call to Claude Haiku 5.5 and the ledger row records the `policyRedirect`. Two
  cases may use another provider: a synthetic call, and a call whose text redaction the policy accepted and
  which also carries `ctx.imagesRedacted` (every picture was rendered from redacted content). No hub call site
  sets `imagesRedacted`.
  - Three call sites used to send a picture to Gemini: the price list or menu photo
    (`assistant.products-image`), the client media brief for a picture (`assistant.media-brief`) and the
    signed-contract check (`inbox.inspect-contract`). They now read it on Claude in every mode: the legacy
    profile sends a plain Claude Haiku 5.5 request (`lib/llm/claude-vision.js`), other profiles go through the
    core. Their feature switch now looks for `ANTHROPIC_API_KEY`, so a hub with only a Gemini key no longer
    reads pictures. Do not remove `GEMINI_API_KEY` before this is deployed and the Anthropic key is checked
    on the admin status card: audio and video still need it.
  - Pictures are turned into JPEG with a long edge of at most 1568 px before they leave (Claude takes JPEG,
    PNG, GIF and WebP only). HEIC and HEIF need a decoder that is not installed (sharp's libvips has no HEVC
    decoder): such a file is skipped with a reason and still filed by name.
  - Video and audio media briefs (`assistant.media-brief-av`) and the grounded link search carry no image
    block and stay on Gemini.
  - A provider-specific call (`native`) that sends pictures passes `images` (a list or a count). The core
    cannot shape such a call, so when the rule refuses it there is no Claude route to move it to: it ends with
    one `policy_blocked` row and an error.
- **DeepSeek in production: fallback for synthetic or redacted payloads only; the policy skips this entry
  for unredacted real-client data.** The `prod` routes keep DeepSeek as second choice for the classification
  and extraction families. Personal and transcript data never reach it; other client data only when the call
  is synthetic or carries a redaction the policy accepted.
- **Gemini is a paid provider for audio and video only** (`billingTier: "paid"`,
  `paidTierConfirmedAt: "2026-11-10"` in the shared policy; the core needs both). The policy limits it to the
  audio and video tasks and `sales-link.discover`, so a picture task could not reach it even if a route named it.
- Every image task in the shared registry is business class or higher, except two template-only tasks listed
  with their reason in `scripts/llm-harness.test.mjs` and in `CONTRACT.md` (`template-import.qa-vision`,
  `siteintel.golden-judge-vision`).

## Call sites and task keys

| Task | Call site | Legacy provider |
|---|---|---|
| `offer.fill-from-transcript`, `offer.reflect-contract`, `offer.summarize-intent` | `lib/offer-ai.js` | DeepSeek |
| `workshop.summary`, `workshop.project-document`, `workshop.transcript-eval` | `lib/workshop-*.js` | DeepSeek |
| `booker.preview-document` | `lib/booker-preview-document.js` | DeepSeek |
| `assistant.chat`, `assistant.gather`, `assistant.products-ingest` | `lib/ai-assistant/*` | DeepSeek |
| `assistant.products-image` | `lib/ai-assistant/products-ingest.js` (price list photo to text) | Claude Haiku 5.5 (low) |
| `assistant.media-brief` | `lib/ai-assistant/media-transcript.js` (client media brief of a picture) | Claude Haiku 5.5 (low) |
| `assistant.media-brief-av` | `lib/ai-assistant/media-transcript.js` (brief of audio and video) | Gemini (the only option; Claude has no audio or video input) |
| `inbox.categorize`, `inbox.decide` | `lib/inbox-bot/*` | DeepSeek |
| `inbox.inspect-contract` | `lib/inbox-bot/inspect-contract.js` | Claude Haiku 5.5 (medium) |
| `sales-link.discover` | `lib/sales-link-discovery.js` (Google Search grounding) | Gemini |
| `infokort.agent` | `lib/infokort-agent.js` (tool loop) | Claude Haiku 5.5 |
| `brief.map`, `brief.reduce`, `brief.iteration`, `change.classify`, `followups.extract` | Delivery (no call site yet) | Claude Haiku 5.5 |
| `seo.agreed-extract` | `lib/seo-ops/transcript-keywords.js` (SEO keyword proposals from meetings, a second pass on transcript chunks; budget scope `meetingKeywords`) | Claude Haiku 5.5 |

- `lib/deepseek.js` (`deepseekChatJson`) and `lib/claude-messages.js` (`claudeMessages`,
  `claudeToolLoop`) are wrappers over the facade. Call sites pass `task` (and `ctx.salesClientId`
  where they know it); `deps.chat` injection in tests is unchanged.
- Modules that the browser app also bundles reach the facade through `lib/llm-hooks.js`, which has
  no imports. The server registers the facade at boot (`lib/llm/boot.js`).
- Grounded search (`sales-link.discover`) and video or audio media briefs (`assistant.media-brief-av`) need
  Gemini. On a non-legacy profile they run only while the task's route still allows Gemini; otherwise they
  return no result. On the `prod` routes `sales-link.discover` has no Gemini entry, so it runs only on the legacy profile.
- `scripts/llm-hub-callsites.test.mjs` keeps provider endpoints and SDKs inside `lib/llm/` and the two
  wrappers, and requires a registered task key on every call.

## Newer shared tasks: data class and starting route

The shared registry holds the Maker's tasks too. These newer ones route by family (`arbiter`, `brief`,
`compliance`, `seo`), so the shared routes name none of them and neither repo gets an unknown-task warning.
Production never falls back to DeepSeek for these families, not even for synthetic data; the `test`
profile uses DeepSeek only where the data policy allows it.

| Task | Repo | Data class | `prod` | `test` profile | Escalation |
|---|---|---|---|---|---|
| `step2.cta-classify` | Maker | business | Haiku 5.5 low | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 low | Haiku 5.5 medium |
| `cms.shell-arbiter`, `cms.cta-arbiter` | Maker | business | Haiku 5.5 low | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 low | Haiku 5.5 medium |
| `cms.spec-writer`, `cms-spec.email` | Maker | transcript (brief directives quote meetings) | Haiku 5.5 medium | DeepSeek only for a synthetic brief, else Haiku 5.5 medium | Sonnet 5.5 medium |
| `seo.claims-extract` | Maker | business | Haiku 5.5 medium | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 medium | Sonnet 5.5 medium |
| `seo.agreed-extract` | hub | transcript | Haiku 5.5 medium | DeepSeek only for synthetic transcripts, else Haiku 5.5 medium | Sonnet 5.5 medium |
| `seo.scope`, `seo.facts-nouns` | Maker | business | Haiku 5.5 low | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 low | Sonnet 5.5 medium |
| `seo.page-map` | Maker | business | Haiku 5.5 medium | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 medium | Sonnet 5.5 medium |
| `change.classify` | hub | personal | Haiku 5.5 low | DeepSeek for synthetic data or a clean redaction, else Haiku 5.5 low | Haiku 5.5 medium |

Two more route rules:

- The judge of the development agent never runs on the planner's model. `dev.plan` goes Haiku 5.5, then
  Sonnet 5.5, then Opus 5.5; `dev.judge` goes Sonnet 5.5, then Opus 5.5, then Sonnet 5.5 at high effort.
- The `eval` profile is the `prod` routes plus two explicit lists for model evaluation: `candidates` (DeepSeek
  and Claude models) and `judges` (Claude Opus 5.5 and one OpenAI model). Gemini is neither. Each item is
  one model with no fallback. OpenAI is a judge only.

Budget scopes a caller may opt into with `ctx.budgetScope` (plus its run or job id): `cmsHookup` (one CMS
hookup attempt, $0.30, $0.50 on tier 3, scaled by pages like the run), `seoPass` ($0.40, scaled by pages)
and `meetingKeywords` ($0.20). Reaching the expected cost alerts and the call goes on; only more than 5x
stops. A call without a scope counts toward its run as before.

## Ledger, spend and budgets

- The ledger is also the policy log. Every row carries `dataClass` (`synthetic`, `public`, `business`,
  `personal` or `transcript`) and `redacted` (`true` or `false`): what the policy decided for the call's
  payload, never a copy of the caller's flag. A `synthetic` or `redacted` flag the policy did not accept gives
  `redacted: false` and a real-client class. The legacy passthrough, the rows of earlier attempts and the
  provider-specific calls carry both fields too. `images` counts every image block of the request, those
  inside messages and tool results included. Rows written before this have neither field; readers accept them.
- `<dataDir>/ai/ledger-YYYY-MM.jsonl`: one v2 row per provider attempt (task, provider, requested and
  served model, profile, tokens, USD priced from the served model, status, `attempt`, `salesClientId`).
  A call that tried more than once (the grounded search retry without `thinkingConfig`, the next media
  model) writes a row for each attempt. An answer that was billed but not usable (DeepSeek text that is
  not JSON) is an error row with its tokens and price. Every call site passes the sales client it works
  for when it knows one (the offer's client, the workshop's client, the portal user's connected client,
  the inbox sender's or the matched client), so a client's hub spend is complete.
- Several hub processes may share the data dir. Totals (the card, budgets, `spend-summary.json`) are
  always counted from the ledger file on disk, so rows from every process are included.
- Retention: ledger files are kept for this month and the 12 before it (13 months, UTC). Older
  `ledger-YYYY-MM.jsonl` files are deleted by the ledger's own clock, never by the month of a row: a
  row dated in a later month cannot move the window, and this month and last month are never
  deleted. Each hub process checks once per month of its clock, on its first AI call of that month.
  Files whose name is not a ledger month are left alone. So the hub's own rows in
  `GET /api/admin/ai/spend` reach back at most those 13 months. The other AI files keep their own
  bounds and are not pruned by month: the Maker's run spend (`maker-spend.json`, added to the spend
  answer with `salesClientId`) keeps the newest 50 runs per client whatever their month, so an older
  range can still show Maker runs, and the budget alerts (`alerts-YYYY-MM.jsonl`) hold at most one row
  per budget and UTC day. This month's totals, `spend-summary.json` and the budgets read only this
  month's ledger file, so a prune never changes them (`lib/llm/ledger.js` `pruneLedgers`).
- `<dataDir>/ai/spend-summary.json`: today and this month, by task and provider.
- `<dataDir>/ai/alerts-YYYY-MM.jsonl`: budget alerts, one per budget and UTC day: the hub day cap once
  a day, the client month cap once a day per client, a run or session budget once a day per run or
  session. Caps never stop work; only the core's runaway (more than 5x expected in one run or session)
  or loop rules stop a call.
- `<dataDir>/ai-budgets.override.json`: partial budgets merged over the shared ones (for example
  `{ "periodic": { "hubDayUsd": 5, "clientMonthUsd": 10 } }`).
- The Maker reports its own spend with the callback event `run.ai.spend`. The canonical body is the
  Maker's ledger v2 summary:
  `{ runId, salesClientId, totalUsd, byTask: { <task>: { usd, calls } }, byProvider?: { <provider>: { usd, calls } }, calls?, unverifiedUsd?, profile?, at }`
  (`target`, `status` and `ledgerVersion` may be sent and are ignored). A group may also be a plain USD
  number. `at` is required (400 without it). It is stored as `makerRun.aiSpend`
  `{ runId, totalUsd, byTask: { <task>: usd }, callsByTask?, byProvider?: { <provider>: usd }, calls?, unverifiedUsd?, profile?, at, receivedAt }`
  (only for the client's linked run; an older snapshot, or one with fewer calls at the same `at`, is
  ignored) and per run in `<dataDir>/ai/maker-spend.json`. Only this callback writes
  `makerRun.aiSpend`, and it is dropped when the client is linked to another run.

## Admin endpoints (Superadmin)

- `GET /api/admin/ai/status[?probe=1]`: profile and source, overrides, provider keys, routes per task
  with the prod shadow route, spend, alerts. Without `probe` it makes no network call; with it, free
  key checks run side by side (Anthropic model list, DeepSeek balance, Gemini model list; Gemini is optional and reads audio and video only), each with a
  15 second limit, cached for 10 minutes and skipped while safe mode blocks AI calls. `facade` tells
  whether the call sites use the facade.
- `GET /api/admin/ai/spend?from&to&by=task|client|provider|model|run&salesClientId=`: ledger totals
  (default range: this month); with `salesClientId` also the Maker's runs (`totalUsd`, `calls`,
  `byTask`, `byProvider`, `runs`), and the sum of both. A Maker run counts in the range of its newest
  snapshot's `at`; the client's current run is added only when the per-run history has no row for it.
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

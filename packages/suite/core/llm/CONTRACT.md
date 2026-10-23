# LLM core contract 1.0.0 (frozen 2026-10-23)

`core/llm` is the one place where LLM routing, data policy, prices, Claude request rules, budgets and
ledger rows are defined. Both facades build on it: the Maker facade (`lib/ai-pipeline/_shared/llm`) and
the hub facade (`lib/llm`). The core is pure: no SDK, no network, no file system, no `process.env`. Facades
pass env maps, provider adapters and storage in.

The machine-readable form is `LLM_CONTRACT` in `contract.js`. Its fingerprint is pinned in the contract
tests of both repos:

```
version      1.0.0
fingerprint  sha256:<see scripts/llm-contract.test.mjs>
```

A change to anything below is a contract change: bump `LLM_CONTRACT.version`, update this file, and update
the pinned fingerprint in both repos in the same change.

## 1. Exported names

Facade methods (the same names in both repos):

| Method | Meaning |
|---|---|
| `json({task, system, user, images, schema, maxTokens, ctx, signal, data})` | JSON task. Output parsed and validated against `schema` on every provider. |
| `text({...})` | Free-text task. |
| `tools({task, system, messages, tools, maxTurns, onToolUse, ctx})` | Tool loop (Claude-shaped messages, Claude only). |
| `callLlm(request)` | Any kind; `json`/`text` are kind-checked wrappers. |
| `resolveRoute(task, ctx)` = `routeFor(task, ctx)` | The provider chain for a call, without calling. Same function. |
| `status()` | Facade-owned: provider health, profile, spend today. |

`createLlmCore({tasks, routes, policy, budgets, env, providers, ledger, spentUsd, onAlert, cassettes, legacyRoute, repo})`
returns `callLlm`, `json`, `text`, `tools`, `resolveRoute`, `routeFor`. A facade adds `status()`.

Every core export the contract relies on is listed in `CORE_EXPORTS`.

## 2. Task registry

```json
{ "version": 1, "tasks": { "step2.copy-judge": { "kind": "json", "vision": false, "dataClass": "business",
  "maxTokens": 4000, "effort": "low", "family": "judge", "repo": ["maker"], "owner": "WS4" } } }
```

- `kind`: `json | text | tools`. `dataClass`: `public < business < personal < transcript`.
- `family` groups tasks for routing (`kinds`, `escalateKinds`). `effort` is the task default.
- Keys match `^[a-z0-9]+([.-][a-z0-9]+)*$` and are append-only. The shared registry lives in
  `harness/<owner>/llm.js`; a facade may keep a JSON copy with the same schema.
- Env override key: `AI_ROUTE_` + key uppercased with `.` and `-` turned into `_`.

## 3. ai-routes.json

```json
{ "version": 1, "profiles": {
  "legacy": { "default": "${legacy}", "vision": "${legacy}" },
  "prod":   { "default": "claude:claude-haiku-5-5:medium|deepseek:deepseek-flash",
              "vision":  "claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash",
              "tasks": { "<task>": "<route>" }, "kinds": { "<family>": "<route>" },
              "escalate": { "<task>": ["<route>", "..."] }, "escalateKinds": { "<family>": ["<route>"] },
              "tiers": { "tier-3-ecommerce": { "tasks": {}, "kinds": {}, "escalate": {} } } },
  "test":   { "default": "deepseek:deepseek-flash", "vision": "gemini:gemini-2.5-flash-lite" },
  "replay": { "default": "replay:strict", "vision": "replay:strict" },
  "record": { "inherit": "test", "record": true } } }
```

- Route string: `provider:model[:effort]`, `|` separates fallbacks. Providers: `claude deepseek gemini openai replay`.
- Claude models: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` only.
- Profiles: `legacy prod test replay record`; `production` is an alias of `prod`.
- Profile choice: `ctx.profile` beats `AI_PROFILE`; `AI_TEST_MODE=1` means `test`; default `legacy`.
- Resolution order: `ctx.route` (tests) → `AI_ROUTE_<TASK>` → `AI_ROUTE_DEFAULT`/`AI_ROUTE_VISION_DEFAULT`
  → escalation → `tiers[tier].tasks` → `tasks` → `tiers[tier].kinds` → `kinds` → `vision` → `default`.
- Escalation: `ctx.escalation = n` (1-based) picks entry n of `escalate[task]`, else `escalateKinds[family]`,
  capped by `ctx.maxEscalation` and the list length.
- Load-time errors (`createRouter` throws `RouteConfigError`): unparseable route, unknown provider or Claude
  model, unknown task, model without a price. Warnings: unverified prices, vision routes that will be
  filtered, and prices older than 120 days. `validateRoutesConfig` (tests, CI) treats a stale price as an
  error, so the price table is re-read at least every 120 days without a running facade ever stopping over it.
- A routes file shared by two repos names both repos' tasks; each facade passes `unknownTasks: 'warn'`.

## 4. ctx

`runId salesClientId sessionId taskId jobId step tier profile kind escalation maxEscalation dataClass
synthetic redacted vision route budgetScope expectedUsd projectSize`. Other keys are ignored and listed in
`route.ignoredCtx`. Tiers: `tier-1-standard tier-2-seo tier-3-ecommerce` (1, 2, 3 accepted).

## 5. Data policy

- Effective class = max(task class, `ctx.dataClass`, `personal` if the payload has person fields: person-name,
  email, phone, address keys with a value, or email/phone patterns in any string).
- `ctx.synthetic: true` → `public`. `ctx.redacted: true` → personal/transcript count as `business`.
- Hard rules (config can only be stricter): DeepSeek never gets personal or transcript data. Gemini gets
  anything above `public` only with `billingTier: "paid"` and a `paidTierConfirmedAt` date.
- Blocked entries are dropped. If none is left, the policy `redirect` route (default
  `claude:claude-haiku-5-5:low`) is used; if that is blocked too, `PolicyBlockedError`.

## 6. Claude requests

- Never `temperature`, `top_p`, `top_k`. Params are built from a whitelist.
- `thinking: {type: "adaptive"}`; depth through `output_config.effort` (`low medium high xhigh max`).
  Task or route effort; default `medium`; classification tasks use `low`.
- `max_tokens = max(requested or task cap, 4096)`. A `max_tokens` stop retries once on the same model
  with the cap doubled; a second one is `MaxTokensError` (the chain may fall back).
- Structured JSON through `output_config.format = {type: "json_schema", schema}` (unsupported constraints
  removed, objects closed); the full schema is still validated client-side. No assistant prefill.
- Tools: `strict: true`; `tool_choice` always `auto` (or `none`).
- Images: JPEG, long edge ≤ 1568 px, ≤ 6 per call, before the text. `prepareImage()` converts (sharp).
- Requests with `max_tokens > 16000` are flagged `stream: true`.
- Sonnet and Opus 5.5 get `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`
  (Anthropic's own refusal fallback); Haiku 5.5 has none; Batches never get it.
- `stop_reason: "refusal"` → `RefusalError` (`needsReview: true`, `crossVendorRetry: false`). No other vendor
  is tried.

## 7. Fallback rules

| Failure | Next entry in chain? |
|---|---|
| 401/403, missing adapter | yes, and the provider is marked dead for the process |
| 429, 5xx, network, timeout, 400/404 | yes |
| `max_tokens` after the doubled retry, invalid JSON or schema | yes |
| refusal, budget runaway, loop, policy, config, invalid request, cassette miss | no, thrown |

## 8. Prices

One table in `prices.js` with `source` and `verifiedAt`. Rows are priced from `response.model` (the model
that served the call), and from `usage.iterations` when a server-side fallback ran. Haiku 5.5 uses the
long-context card for prompts over 100k tokens (input + cache read + cache write), Gemini 2.5 Pro over 200k.
Batch 0.5×, `inference_geo: us` 1.1× (Claude). Unverified entries (DeepSeek on 2026-10-23) are flagged
`priceVerified:false`; pre-call budget estimates price them at CEILING ($5/$25 per MTok).

## 9. Budgets (scaled soft budgets)

- Expected cost per scope from project size: `baseUsd[tier] × max(1, units / referencePages)`,
  `units = pages × (1 + (locales − 1) × extraLocaleFactor) + products / productsPerPage`. `iteration` is
  half a `devSession`.
- Projected spend (spent + this call's estimate) ≥ 100 % of expected → alert, work continues.
- Hard stop only for a runaway (> 5 × expected) → `BudgetExceededError`, or a loop (the same request
  giving the same outcome 3 times in a row, or sent 6 times) → `LoopDetectedError`.
- Periodic totals (client per month, global per day, evaluation) alert only.

## 10. Ledger row v2

`v kind at repo task provider requestedModel model effort profile runId salesClientId sessionId tier
inputTokens outputTokens cacheReadTokens cacheWriteTokens images usd priceVerified latencyMs status
stopReason attempt maxTokens fallbackFrom policyRedirect needsReview budget`. One row per provider attempt.
Statuses: `ok error refusal max_tokens schema_invalid budget_blocked loop_blocked policy_blocked skipped_dead`.
v1 rows (`{at, provider, model, purpose, runId, step, inputTokens, outputTokens, usd}`) read as v2 with
`task: "legacy:<purpose>"`. Non-LLM paid APIs use `buildApiSpendRow` (`kind: "api"`).

## 11. Replay

Cassette key = sha256 of task, system, user, messages, image hashes, schema and tools, with dates,
timestamps, UUIDs, epoch-ms values and run ids normalized. The model is stored in the record, not the key,
so `replay:strict` finds cassettes recorded under any route. Records carry no keys or tokens.

## 12. Provider adapter

```
adapter(call) -> response
call     = {provider, model, effort, task, kind, system, user, messages, images, schema, tools, maxTokens,
            attempt, cassetteKey, signal, ctx, claude?: {params, betas, stream}}
response = {servedModel, text, data?, content?, stopReason, stopDetails?, usage}
```

`stopReason` uses Claude's words (`end_turn max_tokens refusal tool_use`); adapters map other vendors'
values (`length` → `max_tokens`, safety blocks → `refusal`). Errors carry `status` or `code`.
For Claude, the adapter sends `call.claude.params` with `call.claude.betas` (streaming when
`call.claude.stream`) and returns `normalizeClaudeResponse(message)`.

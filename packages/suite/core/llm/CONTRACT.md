# LLM core contract 1.2.0 (frozen 2026-10-23)

`core/llm` is the one place where LLM routing, data policy, prices, Claude request rules, budgets and
ledger rows are defined. Both facades build on it: the Maker facade (`lib/ai-pipeline/_shared/llm`) and
the hub facade (`lib/llm`). The core is pure: no SDK, no network, no file system, no `process.env`. Facades
pass env maps, provider adapters and storage in.

The machine-readable form is `LLM_CONTRACT` in `contract.js`. Its fingerprint is pinned in the contract
tests of both repos:

```
version      1.2.0
fingerprint  sha256:<see scripts/llm-contract.test.mjs>
```

A change to anything below is a contract change: bump `LLM_CONTRACT.version`, update this file, and update
the pinned fingerprint in both repos in the same change.

1.1.0 replaced 1.0.0 on the same day, before any facade adopted it. It added the Q5 client-data rule for
DeepSeek, payload checks behind `synthetic`/`redacted`, provider task scopes, the strict Gemini rule,
warnings for unknown tiers, scoped and windowed loop detection, budgets that are on by default, the
Claude-only `max_tokens` retry, caller aborts, free replay rows and open-map schemas.

1.2.0 replaced 1.1.0 on the same day, also before any facade adopted it. Changes:

- The person-field scan fails closed when it hits a limit.
- Redaction never lowers transcript data.
- Image and document blocks skip only their binary source.
- Email detection covers IDN domains; phone detection covers dashed and 47-prefixed numbers.
- Loops count only failures and caller-marked retries of the exact request to the same model, and replays
  are never loops.
- The core uses `DEFAULT_BUDGETS` when no budgets config is given, treats `expectedUsd <= 0` as not given,
  and keeps no in-process tally without an id.
- Schemas: `oneOf` is sent as `anyOf`, `not` is dropped, and recursive `$ref` schemas skip structured output.
- The image rules apply to images in messages and tool results.
- The ledger gets `policy_blocked` and `skipped_dead` rows.
- The policy gets an `exceptions` list.

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
  `public` means no client data at all (template HTML, a template's demo text). Anything read from a client's
  site, intake or files is at least `business`. A task registered as `public` because its usual source is a
  template (`template-import.*`, `step15.*`, `siteintel.*`) gets `ctx.dataClass: "business"` from its caller
  whenever the source is a client's live site (live-site imports); the registry `note` says so.
- `family` groups tasks for routing (`kinds`, `escalateKinds`). `effort` is the task default.
- Keys match `^[a-z0-9]+([.-][a-z0-9]+)*$` and are append-only. The shared registry lives in
  `harness/<owner>/llm.js`; a facade may keep a JSON copy with the same schema.
- Env override key: `AI_ROUTE_` + key uppercased with `.` and `-` turned into `_`.

## 3. ai-routes.json

```json
{ "version": 1, "profiles": {
  "legacy": { "default": "${legacy}", "vision": "${legacy}" },
  "prod":   { "default": "claude:claude-haiku-5-5:medium",
              "vision":  "claude:claude-haiku-5-5:medium|gemini:gemini-2.5-flash",
              "tasks": { "<task>": "<route>" }, "kinds": { "<family>": "<route>" },
              "escalate": { "<task>": ["<route>", "..."] }, "escalateKinds": { "<family>": ["<route>"] },
              "tiers": { "tier-3-ecommerce": { "tasks": {}, "kinds": {}, "escalate": {} } } },
  "test":   { "default": "deepseek:deepseek-flash", "vision": "gemini:gemini-2.5-flash-lite|claude:claude-haiku-5-5:low" },
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
- A routes file shared by two repos names both repos' tasks; each facade passes `unknownTasks: 'warn'`
  (the harness's `asoldiLlmConfig(repo)` returns it together with `repo`).
- The data policy (section 5) filters every profile's chain, `legacy` included.

## 4. ctx

`runId salesClientId sessionId taskId jobId step tier profile kind escalation maxEscalation dataClass
synthetic redacted vision route budgetScope expectedUsd projectSize retryOf attempt`. Other keys are ignored
and listed in `route.ignoredCtx`. Tiers: `tier-1-standard tier-2-seo tier-3-ecommerce` (1, 2, 3 accepted).

- `expectedUsd` counts only when it is above 0. 0 or a negative value means "not given", never "no limit".
- `retryOf` (any id of the call being retried) or `attempt` (2 or more) marks a call as the caller's retry
  of the same request. Loop detection counts such calls even when they succeed (section 9).
- `dataClass` raises the class of one call. Pass `business` for a client's live site read by a public task.

Values that come from client data never throw. An unknown tier (for example the hub's `custom` tier) adds a
warning: the call then uses no tier routes and the default budget base. Malformed values that come from code
(`profile`, `kind`, `dataClass`, `maxEscalation`) throw `RouteConfigError`.

## 5. Data policy (owner decision Q5)

- Effective class = max(task class, `ctx.dataClass`, `personal` if the payload has person fields). Person
  fields are person-name, email, phone or address keys with a value, or email or phone patterns in any string.
  A redaction placeholder such as `[NAME]`, `<email>`, `***` or `REDACTED` is not a value.
  - Emails include internationalized domains (`post@blåbærkafé.no`, and `xn--` forms).
  - Phones include `+` numbers, 8 digits, 2-2-2-2 and 3-2-3 groups split by spaces or dashes, and 47/0047
    followed by 8 digits. ISO dates (4-2-2), YYYYMMDD dates and runs of numbers (SVG paths) are not phones.
- The scanned payload is everything sent (system, user, messages) plus `request.data`.
  - In image and document blocks, only a `base64`, `url` or `file` source is skipped. Captions, alt text and
    text-source documents are scanned.
  - Inline base64 data URLs are binary and are not scanned.
- **The scan fails closed.** Its limits (`PERSON_SCAN_LIMITS`) are 8,000,000 characters, 200,000 objects and
  arrays, and a depth of 256. Hitting any of them sets `truncated`; the call is then handled as `personal`,
  and neither `synthetic` nor `redacted` is accepted. The scan has no other early exit: an email or phone
  cannot hide behind many `@` signs or phone-like numbers.
- `ctx.synthetic: true` makes the call `public`, unless the payload holds an email or phone that is not a
  reserved fixture value, or the scan was truncated. Reserved values are email domains `example.<tld>`,
  `*.example.<tld>`, `*.test`, `*.invalid`, `*.example` and `*.localhost`. A phone counts as reserved when
  its national part starts with 0, repeats one digit, is 12345678 or 87654321, or falls in the US 555-01xx
  range.
- `ctx.redacted: true` turns `personal` into `business`, unless person fields or a non-fixture email or
  phone remain in the payload, or the scan was truncated. A failed redaction keeps the class.
- **Transcripts are lowered only by `synthetic`.** Redaction cannot find person names in free text
  ("Kari Nordmann sa at …"), so a redacted transcript (task class or `ctx.dataClass`) stays `transcript` and
  never reaches DeepSeek.
- Hard rules, which config can only make stricter:
  - DeepSeek never gets personal or transcript data.
  - DeepSeek gets anything above `public` only when the call is synthetic or redacted and the payload check
    agreed: no real client data goes to DeepSeek.
  - Gemini gets nothing until the policy records `billingTier: "paid"` and a `paidTierConfirmedAt` date.
    `allowUnpaidPublic: true` opts public data back in; it is off by default.
- `providers.<name>.tasks` / `families` limit a provider to those tasks. The reference policy limits OpenAI
  to the evaluation judges.
- Blocked entries are dropped. If none is left, the policy `redirect` route (default `claude:claude-haiku-5-5`)
  is used; if that is blocked too, `PolicyBlockedError` (with a `policy_blocked` ledger row). A full redirect
  keeps the work's effort: the task effort, else the replaced entry's effort, else the redirect route's, else
  `medium`. When only some entries are dropped, a task-specific route keeps its explicit efforts.
- `exceptions` lists known LLM calls that do not go through the core yet, so they bypass this policy, the
  ledger and budgets. Each has `id`, `provider`, `where`, `owner`, `reason` and an optional `dataClass`.
  The list is validated but not used for routing. The reference policy lists the CMS's
  `server/local-blog-job.js` DeepSeek call (owner WS9, moving to a hub relay).
- **Legacy profile.** The policy also applies under `AI_PROFILE=legacy`. Today's DeepSeek, Gemini and OpenAI
  call sites therefore move to Claude Haiku 5.5 whenever they carry client data. Legacy reproduces today's
  provider only for public data. A working Anthropic key is a precondition for a facade to adopt the core.

## 6. Claude requests

- Never `temperature`, `top_p`, `top_k`. Params are built from a whitelist.
- `thinking: {type: "adaptive"}`; depth through `output_config.effort` (`low medium high xhigh max`).
  Task or route effort; default `medium`; classification tasks use `low`.
- `max_tokens = max(requested or task cap, 4096)`. A `max_tokens` stop retries once on the same model
  with the cap doubled (Claude only). A second stop is `MaxTokensError`, and the chain may fall back. Other
  vendors fall back on their first `max_tokens` stop.
- Structured JSON through `output_config.format = {type: "json_schema", schema}`: unsupported constraints are
  removed, objects are closed, `oneOf` is sent as `anyOf` and `not` is dropped. The full schema (exactly-one
  and `not` included) is still validated client-side. Two kinds of schema skip the format: open maps
  (`additionalProperties` as a schema, objects with no declared properties, `patternProperties`), because
  closing them would leave only `{}`, and recursive `$ref`s (a nav item whose children are nav items), which
  structured outputs reject. Their JSON is validated client-side only, and `jsonMode` is `prompt`. No
  assistant prefill.
- Tools: `strict: true`, except tools whose input schema has open maps or recursive `$ref`s (sent as
  written, `strict: false`); `tool_choice` always `auto` (or `none`).
- Images: JPEG, long edge ≤ 1568 px, ≤ 6 per call, before the text. `prepareImage()` converts (sharp).
  Images already in `messages`, including those inside `tool_result` content, count toward the 6. Base64
  ones are checked the same way (JPEG, long edge from the bytes), and URL ones must be https
  (`checkMessageImages`).
- Requests with `max_tokens > 16000` are flagged `stream: true`.
- Sonnet and Opus 5.5 get `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`
  (Anthropic's own refusal fallback; it may serve from Claude Opus 5, Opus 4.8 or Sonnet 5); Haiku 5.5 has
  none; Batches never get it.
- `stop_reason: "refusal"` → `RefusalError` (`needsReview: true`, `crossVendorRetry: false`). No other vendor
  is tried.

## 7. Fallback rules

| Failure | Next entry in chain? |
|---|---|
| 401/403, missing adapter | yes, and the provider is marked dead for the process |
| 429, 5xx, network, timeout, 400/404 | yes |
| `max_tokens` (after Claude's doubled retry), invalid JSON or schema | yes |
| caller abort (`AbortError`, `APIUserAbortError`, aborted `signal`) | no, thrown |
| refusal, budget runaway, loop, policy, config, invalid request, cassette miss | no, thrown |

## 8. Prices

One table in `prices.js` with `source` and `verifiedAt`. Rows are priced from `response.model` (the model
that served the call), and from `usage.iterations` when a server-side fallback ran. The fallback models
(Claude Opus 5, Opus 4.8, Sonnet 5) are in the table, marked `fallbackOnly`. Routes cannot name them.
Haiku 5.5 uses the long-context card for prompts over 100k tokens (input + cache read + cache write), and
Gemini 2.5 Pro uses it over 200k. Batch is 0.5×, and `inference_geo: us` is 1.1× (Claude). Unverified
entries (DeepSeek on 2026-10-23) are flagged `priceVerified:false`; pre-call budget estimates price them at
CEILING ($5/$25 per MTok). Replay rows cost $0; the recorded model is kept in `replayOf`.

## 9. Budgets (scaled soft budgets, owner decision Q6)

- Expected cost per scope from project size: `baseUsd[tier] × max(1, units / referencePages)`,
  `units = pages × (1 + (locales − 1) × extraLocaleFactor) + products / productsPerPage`. `iteration` is
  half a `devSession`.
- `createLlmCore` validates a given budgets config and throws `RouteConfigError` if it is malformed. Without
  a config, or with a config that has no scopes, `DEFAULT_BUDGETS` scopes apply: run $2, dev session $2.5,
  iteration half a session, with tier bases. The runaway stop is therefore on by default.
- The scaled scope is `ctx.budgetScope`. Without it, a `sessionId` means `devSession`, a `runId` means
  `run`, and anything else has no scaled scope. A call in a scaled scope has an expected cost:
  `ctx.expectedUsd` (if above 0), else the budgets config with `ctx.projectSize`. A `budgetScope` that is
  not in the config uses the cost of the session or run it belongs to. Without a size, the base cost of one
  reference project applies, so facades pass `projectSize` for larger projects.
- Spend comes from the facade's `spentUsd({scope, ctx, task})`. Without that hook, the core keeps an
  in-process tally per run, session, job or task id. A scope without any of those ids (a bare
  `budgetScope`) is never tallied in-process, so unrelated runs and clients are not pooled; it gets a
  scaled decision only through `spentUsd`.
- Projected spend (spent + this call's estimate) ≥ 100 % of expected → alert, work continues.
- Hard stop only for a runaway (> 5 × expected) → `BudgetExceededError`, or a loop → `LoopDetectedError`.
- **Loops** ("the same task retried with no progress"):
  - The key is the scope (`runId`, `sessionId`, `jobId` or `taskId`), the provider, model and effort the
    call goes to, and the sha256 of the exact request. There is no replay normalization, so pages that
    differ only by a UUID or a date are different requests, and each escalation step is a new request.
  - Only no-progress outcomes count: an error after the chain (refusal, `max_tokens`, `schema_invalid`,
    provider failures), empty output, and calls the caller marked as retries (`ctx.retryOf`,
    `ctx.attempt` ≥ 2). A successful call that is not a retry never counts, and it ends a streak.
  - A loop is 3 such outcomes in a row with the same result, or 6 such sends, within 15 minutes. A block
    expires with the window.
  - Never checked: calls without a scope, replay calls and caller aborts.
- Periodic totals alert only: `clientMonthUsd` (calls with a `salesClientId`), `makerDayUsd` / `hubDayUsd`
  (by `repo`) and `evalTotalUsd` (`eval.*` tasks or `budgetScope: "eval"`). They are read through `spentUsd`
  with scopes `clientMonth`, `makerDay`, `hubDay` and `eval`.

## 10. Ledger row v2

`v kind at repo task provider requestedModel model effort profile runId salesClientId sessionId tier
inputTokens outputTokens cacheReadTokens cacheWriteTokens images usd priceVerified latencyMs status
stopReason attempt maxTokens fallbackFrom policyRedirect needsReview budget`. Statuses: `ok error refusal
max_tokens schema_invalid budget_blocked loop_blocked policy_blocked skipped_dead`.

The core writes:

- one row per provider attempt (a missing adapter is an `error` row);
- one `skipped_dead` row (USD 0) for each chain entry skipped because its provider is dead;
- one `budget_blocked`, `loop_blocked` or `policy_blocked` row when a call is stopped before any provider.
  A `policy_blocked` row carries the route's first provider, the profile, and
  `policyRedirect: {from, to: null, reason, dataClass}`.
v1 rows (`{at, provider, model, purpose, runId, step, inputTokens, outputTokens, usd}`) read as v2 with
`task: "legacy:<purpose>"`. Non-LLM paid APIs use `buildApiSpendRow` (`kind: "api"`).

## 11. Replay

Cassette key = sha256 of task, system, user, messages, image hashes, schema and tools, with dates,
timestamps, UUIDs, epoch-ms values and run ids normalized. The model is stored in the record, not the key,
so `replay:strict` finds cassettes recorded under any route. `requestKey()` hashes the same fields with
nothing normalized; loop detection uses it. Records keep only the response fields: model
output (text, data, content, tool inputs) keeps every key and has key-shaped values masked, and transport
or usage fields lose secret-named keys.

## 12. Provider adapter

```
adapter(call) -> response
call     = {provider, model, effort, task, kind, system, user, messages, images, schema, tools, maxTokens,
            attempt, cassetteKey, signal, ctx, claude?: {params, betas, stream}}
response = {servedModel, text, data?, content?, stopReason, stopDetails?, usage}
```

`stopReason` uses Claude's words (`end_turn max_tokens refusal tool_use`); adapters map other vendors'
values (`length` → `max_tokens`, safety blocks → `refusal`). Errors carry `status` or `code`; an abort keeps
its `AbortError` / `APIUserAbortError` name. For Claude, the adapter sends `call.claude.params` with
`call.claude.betas` (streaming when `call.claude.stream`) and returns `normalizeClaudeResponse(message)`.

# Delivery runbooks

What to do when part of the delivery flow misbehaves. Every runbook has the **symptom**, the **check**
(an endpoint or a command) and the **fix**. Flow and terms: [delivery-flow.md](delivery-flow.md).

All `/api/admin/...` calls below need a Superadmin (admin role) token: `Authorization: Bearer <token>`.
Commands run from the hub repo root. On the operator PC the data dir is `~/.asoldi-website-data` unless
`APP_DATA_DIR` or `DATA_DIR` is set; on Hostinger use the endpoints, never FTP edits.

Runbooks for later batches (stuck or blocked job, Maker host offline, brief rebuild or rollback, re-linking a
recording, erase request, payment not connected) are added by the batch that ships the feature.

---

## Settings rollback

**Symptom.** An automation switch was changed and mail, auto-queue or publishing now behaves wrongly.

**Check.**
- `GET /api/admin/automation-settings`: `audit` lists the last 50 changes with `at`, `by`, `source` (`superadmin`, `guard`, `resume`, `release`), `reason` and each `changes[{path, from, to}]`. `effective` shows what actually runs.
- Older full copies: `<dataDir>/backups/automation-settings.json.<timestamp>.json` (kept by `writeDataJson`).

**Fix.**
- Put the old values back with `PUT /api/admin/automation-settings {"settings": {...the "from" values...}, "reason": "rollback"}`. A partial object is enough; it is deep-merged, except `paused` objects, which replace as a whole. The per-mailbox maps merge per mailbox, so a PUT that names one mailbox leaves the other mailbox's flag alone. To remove a mailbox, PUT the old `inbox.mailboxes` (its entries in `inbox.autoActions` / `inbox.autoReply` go with it) and, if `sender.service.replyTo` pointed at it, the old `replyTo` too.
- To go back to the defaults for one group, PUT the matching part of `defaults` from the GET response.
- If the whole file is broken, restore it from a delivery snapshot (below) or copy a backup over it on the operator PC; the hub re-reads it within 10 s.

## Automation switch paused by a runtime guard

**Symptom.** An email kind or a publish target stopped sending; `effective.emails.<kind>.mode` is `paused`.

**Check.** `GET /api/admin/automation-settings`: `settings.emails.<kind>.paused` has `{at, reason, by}`; the newest `audit` entry with `source: "guard"` shows when. `GET /api/admin/automation/promotion` shows the guard counters of the kind (`switches[].guard`: sends, errors, bounces and complaints in the window) and the latest trips; `GET /api/admin/system/delivery-alerts` shows the `switch-paused:emails.<kind>` alert. A reason that starts with `guard empty-fields` or `guard recipient-class` names a mail that was stopped before it went out.

**Fix.** Fix the cause in the reason (bounces, complaints, errors, a volume spike, empty fields, a wrong recipient class). Then resume with `PUT /api/admin/automation-settings {"emails": {"<kind>": {"paused": null}}}`. To stop a kind on purpose, PUT `{"paused": {"reason": "..."}}` instead. A rate guard counts the last `guards.windowHours`, so a kind resumed right away pauses again on the next send while the old failures are still in the window; wait for the window or fix the data first.

## A switch cannot be set to auto

**Symptom.** PUT returns 400 with `... cannot run in auto before the pre-release suite has passed for it`.

**Check.** `GET /api/admin/automation-settings`: `settings.releases` lists the switches that passed; `releaseGated` lists the switches that need a pass. `GET /api/admin/automation/promotion` lists what still keeps each switch from `auto` (`blockers`).

**Fix.** Keep the switch in `shadow` until the pre-release suite (golden clients, safe-mode outbox snapshots, the canary site) passes for it; the suite records the pass and, with `promotion.auto` on, switches it to `auto`. A settings PUT cannot write `releases`. A spine switch (`signing`, `brief`, `delivery.loop`, `privacy.purge`) also needs at least one client in `pilotClientIds`.

## Recording a release pass

**Symptom.** A switch shows `no-release` in the promotion view, or the release suite passed but the hub still runs the switch in shadow.

**Check.** `node scripts/release-suite.mjs --out <dir>` (a throwaway safe-mode hub with invented clients; nothing leaves the PC) prints the report path and `switches.<id>.status` for every release-gated switch. `GET /api/admin/automation/promotion`: `releaseKey.keyId` must equal the report's `signature.keyId`.

**Fix.** Add the pilot clients first (`PUT /api/admin/automation-settings {"pilotClientIds": [...]}`); until a client is a pilot or a pass is recorded the promotion routes answer 404. Install the release key once if the hub has none (`PUT /api/admin/automation/release-key {"key": "<64 hex>"}`, from the operator PC's key file next to the reports), then `POST /api/admin/automation/release-pass {"report": <the report JSON>}`. A report older than 14 days, one with a changed byte, one signed with another key, or one where the switch is `fail` or `not-covered` is refused (422) and records nothing. Run the suite again after a code change: its report names the commit it ran.

## Snapshot restore

**Symptom.** A batch deploy or a bad write damaged sales clients, sites, offers or a delivery store.

**Check.**
- `GET /api/admin/system/delivery-snapshots` (or `node scripts/delivery-snapshot.mjs --list`): snapshots with time, schema version, files and record counts; `storedSchemaVersion` and `codeSchemaVersion`.
- Dry run: `POST /api/admin/system/delivery-snapshots/<id>/restore` with `{}` (or `node scripts/restore-delivery-snapshot.mjs --snapshot <id> --dry-run`). It lists per file `replace`, `create` or `unchanged`, record ids `added`, `removed` and `changed` (with the changed top-level keys), and files that are not in the snapshot (kept as they are).

**Fix.**
- Restore: `POST /api/admin/system/delivery-snapshots/<id>/restore {"dryRun": false}` (or the script without `--dry-run`, locally). The current state is saved first as `pre-restore-<timestamp>`, which undoes the restore if needed.
- After a local restore with the script, restart the hub. The endpoint resets the sales list cache itself.
- A restore refuses a snapshot whose files no longer match the manifest checksums (409) or that names a file outside the delivery stores.

## Schema snapshot at deploy

**Symptom.** After a batch deploy, `GET /api/admin/system/delivery-snapshots` shows no `batch-<n>-...` snapshot, or the log shows `[delivery] startup snapshot failed`.

**Check.** `storedSchemaVersion` against `codeSchemaVersion` in the same response. Equal means the snapshot ran on an earlier boot. The server log line `[delivery] schema vA -> vB: snapshot <id>` names it.

**Fix.**
- Failed: the stored version was not raised, so the next boot tries again. Fix the cause (disk full, permissions) and restart, or take one by hand: `POST /api/admin/system/delivery-snapshots {"label": "batch-<n>"}`.
- No delivery data yet (fresh data dir): no snapshot is taken; the version is stored. That is expected.
- Log says `data schema vX is newer than this code`: an older batch is running on newer data (a revert). Nothing is lost: the normalizers keep the newer keys. Re-deploying the newer batch takes no second snapshot.

## Reverting a batch

**Symptom.** A batch must be rolled back on asoldi.com.

**Check.** On the batch branch, before it ships: `FORWARD_COMPAT_REF=<commit that is live now> node --test scripts/forward-compat-revert.test.mjs`. It writes every key from `data/normalize-ext.js` and lets that older commit update a client, a site, a heartbeat and an offer; it fails if any key is lost.

**Fix.** Revert with a new commit and push (never force-push). Data written by the reverted batch stays on disk and comes back when the batch is re-deployed. If the data itself is wrong, use the snapshot restore above. When a batch starts owning a key from `normalize-ext.js`, give that key a realistic sample in the revert test so the working-tree run keeps passing.

## Test client shows up in numbers

**Symptom.** A test or canary client appears in offer counts, reports, social proof or Myphoner.

**Check.** The client card (Kundekort) shows the **Testkunde** checkbox; the hub site list shows **Testside**. API: `GET /api/admin/sales/<id>` has `isTest: true`.

**Fix.** Tick Testkunde (`PATCH /api/admin/sales/<id>/test-flag {"isTest": true}`) and Testside for its hub site (`PATCH /api/hub/sites/<id>/test-flag {"isTest": true}`). To let the test client run delivery automation, add its id to `pilotClientIds`.

## Myphoner winner skipped for a test client

**Symptom.** The server log shows `[myphoner] winner for lead <leadId> skipped: linked to test client <clientId>`, and no sales client appears for a lead someone won.

**Check.** Only a lead-id link reaches a test client (email, phone and name matches leave test clients out). `GET /api/admin/sales/<clientId>` shows `isTest: true` and `myphoner.leadId` equal to that lead.

**Fix.** If the client is in fact real, untick Testkunde (`PATCH /api/admin/sales/<id>/test-flag {"isTest": false}`) and send the winner event again from Myphoner. If it really is a test client, it should not hold a real lead id: remove `myphoner.leadId` / `myphoner.leadIds` from that client, then send the winner event again, which creates a real client.

---

## Backfill could not plan some clients

**Symptom.** The backfill report lists clients under `needsChoice` (a dual offer was signed without a recorded alternative), `noEvidence` (signed, but no accepted or sent offer, no linked hub site, no payment plan and no explicitly picked tier) or with `needsConfirmation` (the plan was derived from offer text with lines it could not read, or from a custom offer).

**Check.** `GET /api/admin/system/delivery-backfill` shows the latest report; `node scripts/backfill-site-plans.mjs` prints the counts for the current data (dry run).

**Fix.** `needsChoice`: get the chosen alternative recorded (the client accepts it in the portal), then run the dry run again. `noEvidence`: pick the tier in the meeting-notes calculator (this stores `tierExplicit`) or send the offer, then run again. `needsConfirmation` is informational until the signing batch: check the listed offer lines. Nothing reads `client.sitePlan` for these clients until then, so leaving them unplanned changes nothing.

---

## Backfill applied a wrong plan or stage

**Symptom.** After an apply, a client's `sitePlan`, a site's `planSource` or a stored stage is not what it should be.

**Check.** The apply report (`GET /api/admin/system/delivery-backfill/reports/<file>`) names the evidence per client and the `snapshotId` taken before writing; `GET /api/admin/system/delivery-snapshots` lists that snapshot.

**Fix.** Restore the snapshot (dry run first): `POST /api/admin/system/delivery-snapshots/<snapshotId>/restore` with `{"dryRun": true}`, then `{"dryRun": false}`. Set `migrations.deliveryBackfill` back to `off` (`PUT /api/admin/automation-settings`), correct the evidence (offer, accepted alternative, hub site plan) and run the dry run again before the next apply. The next apply goes through `POST /api/admin/system/delivery-backfill {"dryRun": false}`: a boot apply is one-time and skips while an apply is recorded in `migrations/delivery-backfill-state.json` (`lastApply`). Live site flags are never changed by the backfill, so no client site needs a fix.

---

## Maker events are not recorded

**Symptom.** `makerRun.materials` or `makerRun.autopilot` stays empty although the Maker sends `run.materials.updated` / `run.autopilot.updated`, and the material dots stay empty whenever the live run fetch fails.

**Check.** `GET /api/admin/automation-settings`: `development.makerEvents` must be `record`. The callback also ignores an event whose `runId` is not the run linked to the client (`callback-run-does-not-match-linked-run`).

**Fix.** `PUT /api/admin/automation-settings` with `{"development": {"makerEvents": "record"}}`. If the run link is wrong, link the right run on the client first. A snapshot stands in only when the live run fetch fails, only for the run linked now and only while it is younger than 24 hours; the next event from the Maker refreshes it.

## Delivery loop does not tick

**Symptom.** Stages and jobs do not move, the Maker chip shows an old loop time, or the alert `loop-stalled` is active.

**Check.** `GET /api/admin/system/delivery-loop`: `enabled`, `mode` (`off`, `paused`, `shadow`, `auto`), `health.lastTickAt`, `health.skipped.lease` (another hub process holds the lease) and `health.lastErrors` (the step that failed). `steps` lists the registered steps and `stepErrors` the step modules that did not load.

**Fix.** Turn the loop on or resume it with `PUT /api/admin/automation-settings {"delivery": {"loop": {"enabled": true, "paused": null}}}`. A failing step keeps its clients dirty and retries every tick; fix the cause shown in `lastErrors`. A lease held by a process that died expires after 90 seconds. To stop everything at once set `delivery.loop.enabled` to `false`: the tick then does nothing at all.

## Maker job does not start

**Symptom.** A job stays `queued` or `retrying`, or the alert `host-offline` or `job-blocked` is active.

**Check.** `GET /api/admin/delivery/jobs?clientId=<id>` shows the client's `mode` and the job with its `hostId`, `notBefore`, `attempts`, `error`, `blocking` and the last 50 `log` lines. A job is handed out only while the client runs in `auto`: with the loop paused or in `shadow`, or the client off `pilotClientIds`, it stays queued. `GET /api/admin/maker-hosts` shows each host's handlers and last heartbeat: a job goes only to a host that lists its kind.

**Fix.** Start the Maker and its hub worker (the chip in the Maker header), or route the work by setting `development.defaultHostId`. A `retrying` job waits for its backoff (5, 15, 45 minutes). Clear a blocking code (table below), then `POST /api/admin/delivery/jobs/<jobId>/retry`; `POST …/cancel` drops the job (a failed one too, which ends its `job-blocked` alert).

---

## Gate line wrong or post-workshop mail missing

**Symptom.** The developer gate panel shows a line as missing although the client sent it, or no post-workshop mail (or shadow record) appeared after a workshop.

**Check.**
- `GET /api/admin/automation-settings`: `settings.gate.enabled` must be `true`; `emails.postWorkshop` must not be off or paused.
- `GET /api/admin/delivery/gate/<clientId>`: each line's `status`, `evidence` and `source`, `stale` (the stored gate is older than its inputs) and `info`.
- The client's `delivery.emails.postWorkshopDueAt`; shadow mails are never sent: an admin reads them under the client in the developer gate panel (or in `shadowMails` of `GET /api/admin/delivery/gate/<clientId>`); they are stored in `<dataDir>/outbox` with channel `delivery-shadow` (purged after 30 days), keyed in `<dataDir>/delivery-email-shadow.json`, and listed in `<dataDir>/delivery-audit/<YYYY-MM>.jsonl` (`email-shadow`).

**Fix.**
- Evidence the gate cannot see (sent by phone, for example): put it in Kundedata, or waive the line with `PUT /api/admin/delivery/gate/<clientId>/waivers/<lineId> {"option": "..."}`; then `POST /api/admin/delivery/gate/<clientId>/evaluate`.
- No due time: `POST /api/admin/sales/<clientId>/workshop/held {"startedAt": "...", "endedAt": "..."}`. A workshop that ended more than about a day ago gets no due time (`reason: 'stale'`); that is intended.
- The desk kind `post-workshop` sends at once only when the post-workshop mail is auto for the client; while the gate is in shadow it records a shadow mail, and off or paused it answers 409. A sent mail is sent again only with `{"force": true}`.

---

## Delivery brief missing or stale

**Symptom.** The developer board shows no brief for a signed client, or the brief misses a recent meeting.

**Check.** `GET /api/admin/automation-settings`: `brief.enabled` must be true (a 404 `{code:'brief-disabled'}` from the brief routes means it is off). `GET /api/admin/development/<id>/brief/versions` lists the stored versions. In `<dataDir>/delivery-briefs/<id>/state.json`, `pendingSince` shows a rebuild waiting out its 10-minute debounce, `partial: true` a rebuild that ran out of time or met provider errors (`lastErrors`), `retryAt` when a failed chunk may be asked again (`chunkFailures` holds the count per chunk), `failureRetryAt` the backoff after a rebuild that failed outright, and `builtInputHash` the inputs of the newest version. `stats.chunks.gaps` in the brief counts chunks the model could not answer. A meeting that is missing although it is linked may still be live captions: its stored Fireflies copy is live or partial without a final summary, and it joins on the first rebuild after the final copy arrives. No media in the brief means the media switch (`media.signedUrls`) is off or the build has no media manifest.

**Fix.** Wait for the debounce or the backoff, or `POST /api/admin/development/<id>/brief/rebuild` with `{"wait":true}` (it does not wait for chunk backoffs). A 409 `brief-busy` means another rebuild of the same client is running; try again when it is done. A partial rebuild resumes from its cached chunks; provider errors need the LLM provider back (`GET /api/admin/ai/status`). Gaps (refusals, output limits, broken answers, or 6 provider failures in a row; safe mode, a switched-off facade or the spend guard never make gaps) stay until the prompt changes; once the cause is fixed, ask again with `{"wait":true,"retryGaps":true}`. A brief never falls back to another provider for transcripts. A 410 `brief-erased` (or the loop status `erased`) means a privacy erase removed the client's brief; `<dataDir>/delivery-briefs/.erased/<id>.json` says when, and no brief is built for that client again. A privacy erase whose brief row answers with an error could not write that marker; the folder was deleted anyway, but a rebuild that was running could write it again, so run the erase again.

---

## Blocking codes

What each code means and how to clear it. Jobs and the board arrive in later batches; the codes are fixed now (`BLOCKING_CODES` in the vocabulary).

| Code | Meaning | Fix |
|---|---|---|
| `needs-language` | The run has no locked language | Lock the language on the developer card, then retry the job |
| `needs-pages` | No pages chosen for the run | Pick pages (Sider), then retry |
| `needs-template` | No template on the run | Choose the template, then retry |
| `needs-confirm` | A custom plan was derived from text and needs a developer to confirm it | Confirm or correct the plan on the client, then retry |
| `needs-brief-identity` | The brief lacks business name or identity facts | Fill Kundedata or the brief facts, rebuild the brief, retry |
| `needs-approval` | Production publish without a client approval of the current preview | Get the client's approval (portal or recorded with a quote), then publish |
| `needs-payment-setup` | A shop goes to production without a connected payment provider | The client connects Stripe or PayPal in the staging CMS |
| `dns-not-switched` | Production was pushed but the domain does not serve the new site | Point the domain at the new site; the live check retries |
| `run-not-on-host` | The run is not on the Maker host that claimed the job | Hand the run over or let the job route to the right host |
| `no-handler` | The Maker has no handler for the job kind | Update the Maker; the job retries |
| `maker-offline` | No Maker host has sent a heartbeat recently | Start the Maker and its worker |
| `step-failed` | A pipeline step failed (`step-failed:<target>` names it) | Open the run log for that step, fix, retry |
| `dev-agent-failed` | The development agent session failed | Read the agent report; retry or do the change by hand |
| `budget-runaway` | Spend passed 5× the expected cost for the project | Check for a stuck prompt or loop, then retry; normal overruns only warn |
| `loop-detected` | The same task retried with no progress | Fix the cause the job log shows, then retry |

Warnings (`WARNING_CODES`) never block: `dev-skipped` (no dev agent ran), `seo-deferred-no-domain` (Step 5 waits for a domain), `cms-review-pending` (CMS bindings proposed, not accepted), `plan-changed-rerun` (the plan changed; re-run development), `budget-soft-limit` (expected cost reached; work continues).

## Keyword jobs not queued

**Symptom.** A brief change in tier, agreed keywords, services or audience did not queue `seo.refresh`, or a new month did not queue `seo.maintenance` for a live tier 2 or tier 3 client.

**Check.** `GET /api/admin/automation-settings`. `development.seoJobs` is false by default. `seo.jobGating` is `{enabled:false, mode:'shadow', paused:null}` (`seo.jobGating.enabled`, `seo.jobGating.mode`, `seo.jobGating.paused`). The producer runs only when `development.seoJobs` is true and `seo.jobGating.enabled` is true with `seo.jobGating.paused` null. While either is off it does not read `<dataDir>/seo-ops/keyword-jobs.json`. See [Keyword research jobs](seo-jobs.md).

**Fix.** Turn on `development.seoJobs` and enable `seo.jobGating` (auto still needs the release pass for `seo.jobGating`). The next delivery tick queues at most one `seo.refresh` per client and SEO inputs hash, and one `seo.maintenance` per live tier 2 or higher client per Europe/Oslo month. The recorded hash moves forward only after the queue accepts the job. A note-only brief edit queues nothing. A state file that is not versioned JSON is kept as `keyword-jobs.json.bak` and read as empty.

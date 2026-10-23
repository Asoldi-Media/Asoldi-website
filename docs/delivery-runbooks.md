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

**Check.** `GET /api/admin/automation-settings`: `settings.emails.<kind>.paused` has `{at, reason, by}`; the newest `audit` entry with `source: "guard"` shows when.

**Fix.** Fix the cause in the reason (bounces, complaints, errors, a volume spike, empty fields, a wrong recipient class). Then resume with `PUT /api/admin/automation-settings {"emails": {"<kind>": {"paused": null}}}`. To stop a kind on purpose, PUT `{"paused": {"reason": "..."}}` instead.

## A switch cannot be set to auto

**Symptom.** PUT returns 400 with `... cannot run in auto before the pre-release suite has passed for it`.

**Check.** `GET /api/admin/automation-settings`: `settings.releases` lists the switches that passed; `releaseGated` lists the switches that need a pass.

**Fix.** Keep the switch in `shadow` until the pre-release suite (golden clients, safe-mode outbox snapshots, the canary site) passes for it; the suite records the pass and, with `promotion.auto` on, switches it to `auto`. A settings PUT cannot write `releases`.

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

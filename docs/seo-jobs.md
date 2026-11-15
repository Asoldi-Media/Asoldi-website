# Keyword research jobs

The hub queues two jobs, `seo.refresh` and `seo.maintenance`. It decides when. It does not do the research. The payload contract is `seo-jobs/1`. The consumer reads keywords and facts from the brief it already has. The hub does not send them in the job.

Both switches are off by default. While either is off, `runSeoJobProducer` returns `{ ran: false }` and does not read its state file, write it, or enqueue.

- `development.seoJobs` — the kind switch for `seo.refresh` and `seo.maintenance`.
- `seo.jobGating` — `{ enabled, mode, paused }`. The producer runs only when `enabled` is true and `paused` is null. A paused switch counts as off. `mode` (`shadow` or `auto`) is not a third gate for these jobs.

The delivery loop calls the producer once per tick, and only when both switches allow it. The producer makes no outbound call.

A client whose contract is cancelled, ended or paused gets nothing while `lifecycle.cancellation` is in auto for that client. The producer asks `lifecycleJobBlock`. `contract-ended` or `paused` means no job.

## SEO inputs hash

For each client with a delivery brief the producer hashes four inputs, and nothing else:

- `tierId` — `sitePlan.tierId`
- `services` — sorted unique ids from `sitePlan.services`
- `agreedKeywords` — approved keywords only, Unicode NFC, lower case, unique, sorted
- `audience` — the brief's audience fact values, trimmed, sorted

The hash is `sha256:` plus the hex sha256 of the canonical JSON of that object: keys sorted, no spaces.

The first time a client is seen, the hash and the inputs are recorded and no refresh is queued. An unchanged hash queues nothing. A changed hash queues exactly one `seo.refresh`. `changed` lists which of `tier`, `services`, `agreedKeywords`, `audience` differ, in that order. `mode` is `agreed-only` when `changed` is exactly `["agreedKeywords"]`, and `full` otherwise. A note, a directive, or a fact of another kind does not change the hash.

The dedupe key is `seo.refresh:<salesClientId>:<first 16 hex of the new hash>`. The recorded hash advances only after the queue accepted the job. A `409` duplicate (an older job of that kind is still active) or any other error leaves the hash where it was, so the next tick tries again. One client's error does not stop the others.

## Monthly job

`seo.maintenance` is one job per Europe/Oslo calendar month for a client whose go-live has happened and whose tier level is 2 or higher. Go-live is a verified production go-live, the delivery live event, or the older progression flag. The tier level is the resolved tier number. A custom tier is level 0, so it does not qualify. Tier 1, a client that is not live, and a client with no tier get none.

The dedupe key is `seo.maintenance:<salesClientId>:<YYYY-MM>`. The same month queues nothing. The next month queues one new job.

## Payload

Flat JSON, at most 2048 bytes. Strings at most 500 characters, lists at most 50, nesting at most 4. Ids, hashes and enums only: no keyword text, no contact data, no URL.

A refresh payload carries `contract` (`seo-jobs/1`), `trigger` (`brief-changed`), `mode`, `changed`, `seoInputsHash`, `previousSeoInputsHash`, `briefVersion`, `briefHash`, `tierId` and `dedupeKey`.

A maintenance payload carries `contract`, `trigger` (`monthly`), `mode` (`maintenance`), `period`, `tierId` and `dedupeKey`.

`salesClientId` and `runId` (when the client has a linked run) sit on the job. The payload does not repeat them.

The consumer checks the payload and refuses one it does not recognise. This producer does not validate the consumer's result.

## State

`<dataDir>/seo-ops/keyword-jobs.json` is version 1:

```json
{ "version": 1, "updatedAt": "", "clients": { "<id>": { "seoInputsHash": "", "inputs": {}, "lastRefreshKey": "", "lastMaintenancePeriod": "" } } }
```

`inputs` is the four fields the hash was computed from. `lastRefreshKey` and `lastMaintenancePeriod` are the last accepted dedupe key and Oslo month.

A file that is not that JSON is copied to `keyword-jobs.json.bak` (an existing copy is kept) and then read as empty. Empty means first sight: hashes are recorded and no refresh is queued. The broken bytes are not replaced until that copy exists.

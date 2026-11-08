# SEO keyword proposals from meetings

When a client says in a meeting what they want to be found for ("vi vil rangere på kjøkken på mål",
"folk søker etter sykkelservice"), the hub turns the phrase into a keyword proposal in the client's SEO
record (`seo-ops/clients/<clientId>.json`, see [seo-record.md](seo-record.md)). A proposal is an
`agreedKeywords` row with status `proposed`, source `transcript` and `quoteRef` `meeting:<meetingId>`.
Nothing here approves a keyword: a developer approves or blocks the proposal on the developer page, and only
approved keywords reach the contract text, the Maker and the SEO consumers.

Code: `lib/seo-ops/transcript-keywords.js`. Tests: `scripts/seo-transcript-keywords.test.mjs` (synthetic
meetings in `scripts/fixtures/seo-keyword-talk/`) and `scripts/seo-keyword-proposals.test.mjs` (the record
writer `proposeAgreedKeywords`).

## Where the phrases come from

1. **The delivery brief's items.** The brief extractor ([delivery-flow.md](delivery-flow.md#delivery-brief))
   reads sales, demo, workshop and iteration meetings and stores items whose quotes it has verified to be the
   transcript's own words. Only those quotes are read here. A quote talks about search terms when it has a cue
   such as `søkeord`, `rangere på`, `bli funnet på`, `dukke opp på`, `søker etter`, `SEO`, `rank for` or
   `show up for`. The phrase is the words right after the cue, up to clause punctuation or a word that starts
   the rest of the sentence (`og`, `men`, `enn`, `er`, `det`, ...), at most six words, or the words inside
   quote marks right after the cue.
2. **The focused second pass.** Where the client talked about search terms but no clean phrase came out of the
   quote, or when the brief is not running for the client (no stored extraction), the step asks a model about
   the transcript chunks with such talk: task `seo.agreed-extract`, data class `transcript`, budget scope
   `meetingKeywords` (job id `meeting-keywords:<clientId>`), at most six chunks per run. The route has no
   DeepSeek in production. A phrase from the model is kept only when its quote verifies against the chunk, the
   phrase's words stand together in that quote, and no negation stands before them in the same clause.

## What is never proposed

- A phrase the client turned down: a negation before the cue in the same clause ("vi vil ikke bli funnet på
  X"), or the second phrase of "heller X enn Y". A turned-down phrase is not proposed from any meeting.
- A phrase that is not searchable: empty, more than six words, a link or an address, only small words, or one
  word of fewer than three letters.
- The business's own name: exactly the name (without its legal form) or a brand search the Maker listed, or,
  for a name of two or more identifying words, a phrase with all of them. A one-word name is often a town as
  well, so a phrase that only contains it is kept; the record flags it as a possible brand phrase.
- A prescription-only substance (`REGULATED_SUBSTANCE_TERMS` in `lib/seo-ops/phrase-filters.js`). When the
  build has the shared claims data (`lib/seo-ops/claims/index.js`), its term lists and checks apply too; a check
  that fails counts as regulated.
- A phrase the record already holds in any status, and one proposed from meetings before. The record keeps the
  keys it proposed (`keywordProposals.transcript.seen`, the last 200), so a proposal a person removed is not made
  again.

## The step and the switch

The delivery loop runs the step `seo-transcript-keywords` (registered in `lib/seo-ops/record.js`, order 60,
every 15 minutes per client) behind `intake.transcriptKeywords`:

| Mode | What happens |
|---|---|
| Off (default) or paused | The step answers `skipped: 'switch-off'` before it reads anything. |
| Shadow (the switch in shadow, a client that is not a pilot, or the loop in shadow) | The step records in the loop's shadow log which phrases it would propose and how many chunks the second pass would read. No model call, no SEO record write. |
| Auto (a pilot client, with the loop in auto) | The step proposes the phrases, runs the second pass where needed, and stores the hash of its inputs (`keywordProposals.transcript.sourceHash`). The same meetings are not handled again; a second pass that stopped on an error stores no hash, so the next run tries again. |

Proposals from the client's own answers in the portal assistant use the same writer with source `client`
(see [delivery-intake.md](delivery-intake.md)).

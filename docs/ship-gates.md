# Ship gates: what a hub push must pass

A push to `main` deploys the hub. Before every push, the release that is about to go out (head)
is compared with the release that is live (base) on a copy of the live data. The comparison is
`scripts/ship/dark-diff.mjs`. A push goes out only when it exits 0.

## The gates, in order

1. `npm test` is green on the head commit (it includes the dark-diff self-tests,
   `npm run test:ship-safety`).
   It starts with `npm run test:server-load`, which loads `server.js` the way the host does. The
   host (LiteSpeed `lsnode.js`, Node 22) calls `require()` on `server.js`, and `require()` refuses
   an ES module graph with a top-level await: one `await` outside a function in `server.js` or in
   a module it imports, and the hub does not start there (HTTP 503). `node server.js` accepts
   such an await, so the dark-diff and every test that starts the hub that way cannot see it.
   Run this test on Node 22 before a push; on a Node older than 22.12 its two load tests are
   skipped. Optional route modules (`lib/routes/optional-routes.js`) add their routes before
   `register(app, deps)` returns and return a promise for start-up work that has to wait.
2. `node scripts/security/secret-scan.mjs --range <base>..<head>` is clean (the pre-push hook
   runs the same scan).
3. Dark-diff on a copy of the live data, with every new switch at its default:

   ```
   node scripts/ship/dark-diff.mjs --base <live commit> --head <commit to push> \
     --data <local copy of the live data dir> --intended <intended.json> \
     --secrets --secret-names <names-only listing of the live secrets folder> \
     --rollback --out <report.json>
   ```

   Large media folders that no flow reads can be left out of the copies with
   `--skip-data <folder,folder>` (top-level folder names; `secrets` is never left out). A data
   copy that holds symbolic links or junctions is refused (exit 2): a hub writing through a copied
   link would write to its target. Copy the data without links, or leave those top-level folders
   out with `--skip-data`.
   It must exit 0. Exit 1 means a difference that the intended file does not list, a changed or
   new secret file, or data that the older release loses. Exit 2 means it could not run or proved
   nothing (read the message): for example a clock start before the data's token cut-off, flows
   that both releases refused, `--secrets` with no secret file to check, or a rollback control
   that head itself refused. Leave `--clock-start` out unless a test needs a fixed one.
4. The switch audit and the route probe on the same two commits (see "The committed tools" below):
   `node scripts/ship/switch-audit.mjs <base tree> <head tree>` lists every new default and every new
   environment variable name, and exits 1 on a default that is neither off nor shadow;
   `node scripts/ship/route-probe.mjs <head tree>` calls the staff and switched-off routes
   without credentials and exits 1 on any other answer or any data file the calls changed.
5. The safe-mode soak (`npm run soak:safe -- --minutes 3`) passes: see "The safe-mode soak" below.
6. After the push: the post-deploy check and the hub probe (`scripts/security/probe-hub.mjs`).

## What dark-diff does

- Checks out `--base` and `--head` (git revisions of this checkout, or `dir:<path>`) into a temp
  folder through a private git index. The repository's HEAD, index and work tree are not touched.
  Each tree gets a link to `--node-modules` (default: this checkout's `node_modules`).
- Copies the data folder (the source is never written; the run stops with exit 2 if it changes).
  A prep copy gets a local admin password and a local Maker host token through the base release's
  own data modules; base and head then each get their own copy of it.
- Boots each release from an empty folder with a temp HOME, in safe mode (`HUB_SAFE_MODE=1`), with
  the egress recorder refusing every connection that is not to this machine, a loopback guard
  refusing every connection to this machine except to the hub's own port (a dev Maker on
  127.0.0.1:3000 or any other local service is never reached; each refused connection is a note
  in the report), and with the clock of both starting at the same instant. No `.env` is read. A
  release that does not report safe mode, or in which the egress recorder or the loopback guard
  did not run, is stopped before anything is compared.
- The clock starts at `--clock-start`, or by default at now rounded up to the minute. It never
  starts before the data's latest token cut-off: `revokedBefore`, `migrations` and `updatedAt`
  in `security-settings.json` and `revokedAt` in `token-revocations.json`. Tokens issued before a
  cut-off are refused, so a run on such a clock would see every signed-in step refused on both
  releases. The default moves past the cut-off; an explicit earlier `--clock-start` is exit 2.
- When a signed-in step (auth `admin`, `maker` or `bearer:*`) is refused (401 or 403) on both
  releases, or a step is skipped on both because the step that saves its value was refused or
  failed, the flows did not run and the run stops with exit 2. Two releases that refuse every
  step compare equal, so that is never a pass. A step that only one release refuses is a
  difference. A skip whose saving step answered 2xx without the value (no recording in the data,
  for example) is a note.
- Refusing is not the only way to run too little. After the flows, the signed-in steps and the
  value-saving steps (a step with `save`) that ran on both releases, not skipped and not refused,
  are counted against the flow files. Fewer than half of either kind (`--min-ran <0 to 1>`, default
  0.5; at least one when there are any) is exit 2: a copy of the data that has none of the records
  the flows need (no clients, no recordings) would otherwise skip nearly every step on both
  releases and pass. The counts are in the report (`flowMinimum`).
- An interrupted run (Ctrl-C or SIGTERM) stops its hubs and deletes its temp folder, which holds
  copies of the data, and exits 130 (SIGINT) or 143 (SIGTERM). A temp folder that cannot be deleted
  is named in the report; delete it by hand. The same cleanup runs when the run ends in any other
  way, and a deletion that fails is a warning in the report, never a replacement for it.
- Runs, against each:
  - every flow in `scripts/ship/flows/*.json` (see below);
  - `GET /api/hub/site-config` by site key and by domain for every site in the data (the report
    names a site by its domain, never by its key);
  - a fake clock moved over 24 hours through each tick route listed in `flows/clock.json` that
    the release has (a release without one answers 404 and is skipped);
  - the route inventory: every literal route of either release, called without credentials and
    recorded only as present or absent. A 404 and the app page that an unknown path gets both
    count as absent, so a route that is switched off reads like a route that does not exist.
- Compares the normalized responses, the safe-mode outbox (one row per mail with its text), the
  route inventory and the two data folders. Times, dates, random ids, tokens, password hashes and
  temp paths become placeholders; arrays are compared as sets. A PDF is compared by its page count.
  - Ids are recognised by their shape, not by the characters they happen to hold: a prefixed part
    that mixes letters and digits, a time part followed by a random hex part
    (`mem_mvxaxykl_df1b74a2`), or a part whose base-36 reading is a time inside the run's clock
    range. Plain words after a prefix (`tier-standard`) stay as they are.
  - A number becomes a placeholder when it looks like epoch milliseconds or sits under a time key:
    a whole-word key (`at`, `ts`, `exp`, `iat`, `mtimeMs`, …) or a camelCase or snake_case time
    suffix (`createdAt`, `sentTs`, `expiresAt`, `updated_at`, `timeoutMs`, …). Counts and amounts
    (`attempts`, `items`, `limits`, `slots`, `vat`, …) are compared as they are.
  - Keys of a map keyed by random ids normalize alike; the values under them are put in order by
    their content before they get `#2`, `#3`, … suffixes, so neither the ids nor the order the
    entries were made in decide which value lands under which key.

## Flows

A flow file is `{ "name", "description", "steps": [...] }`. A step is

```
{ "name": "…", "method": "POST", "path": "/api/admin/sales/{{clientId}}/progression",
  "auth": "admin", "body": { … }, "expect": 200, "save": { "clientId": "body.client.id" } }
```

- `auth`: `none`, `admin` (the prepared admin), `maker` (the prepared Maker host token) or
  `bearer:<variable>` (a token saved by an earlier step, for example a client portal sign-up).
- `{{name}}` in a path, header or body is a saved value; a step whose value is missing is
  skipped on both sides and listed in the report. `save` reads a dot path from the response
  (`body.meetings.0.meetingId`).
- `expect` is the status the flow means to see. A different status is a note in the report, not a
  difference: the comparison is between the two releases.
- `{ "settle": 10000 }` waits until the data folder stops changing (mails and other work that
  finish after the response).
- `{{run}}` is a tag of the pass (`dd` for the comparison, `rb` for the rollback pass). Flows put
  it in e-mail addresses, names and domains, so the rollback pass makes its own records and its
  sign-ups never collide with the ones head made.
- `"replay": true` marks a step the rollback pass runs again, with the values head's run saved, on
  head's own records (an update, or a read of a record head made). Mark only steps that are safe
  to repeat.

The shipped flows cover the signing paths (staff marking a contract signed, the contract signed
on the preview page, the offer accepted in the client portal, and the signed-contract backfill
that files contracts signed by e-mail), portal onboarding in both portal versions, and linking
and unlinking a Fireflies recording. The mailbox poll that reads signed contracts from e-mail is
off in safe mode, so only its HTTP end (the backfill) is covered here.

## The intended file

```json
{
  "description": "What this push changes on purpose.",
  "changes": [
    { "kind": "route", "match": "route POST /api/admin/system/example/tick", "reason": "safe-mode only route" },
    { "kind": "response", "match": "response signing-admin#1 * body.client.example", "reason": "new field" }
  ],
  "ignore": [ { "kind": "data", "match": "data example-cache.json *", "reason": "a cache rebuilt at boot" } ],
  "allowNewSecrets": [],
  "rollbackLost": []
}
```

Every difference has a kind (`response`, `site-config`, `tick`, `route`, `outbox`, `data`) and a
key, printed in the report. `match` is a glob over the key (`*` is any text). A change listed but
never seen is a note. A push that is meant to change nothing uses no intended file.

## --secrets and --fake-secrets

`--secrets` checks every file under `secrets/` after boot and at the end of the run: the same
paths with the same sha256, and no new file. A file that the source lacks and that base creates
as well is a note, not a failure. `allowNewSecrets` lists a secret a push adds on purpose. The
report names paths only, never values or hashes.

A local copy of the live data never holds `secrets/` (secrets stay on the server), so the copies
get fake files with random values:

- `--fake-secrets` fills the standard layout only (signing secret, Maker token, e-mail keys,
  webhook file). It shows that both releases read those files as they are. It says nothing about
  the real files on the server: other names, extra files or older formats are not in it.
- `--secret-names <file>` (implies `--fake-secrets`) makes a fake file for every name in a
  names-only listing of the live secrets folder: one relative name per line, a folder ends with
  `/`, `#` starts a comment. Take the listing with a tool that shows names only (for example the
  hosting file manager's folder view); never download the contents. Known names keep their usual
  shape; any other `.json` name gets a JSON object with a random value, and any other name 64
  random hex characters. Names with `..`, absolute paths or unusual characters are refused. Use
  it for every push that touches secret handling.

`--secrets` on a copy with no secret file to check (no `secrets/`, and neither `--secret-names`
nor `--fake-secrets`) is exit 2: both releases make the standard secrets at boot, and a file base
makes too is excused, so the check would pass without having looked at one existing file.

Either way the check compares paths and hashes of fake values: it proves that a release leaves
each listed file as it is and makes no new one, not that it can read the real values.

## --rollback

Base is booted on a copy of the data head wrote after its flows, and its write paths are driven:

1. the flows again (with the `rb` run tag, so they make new records; most stores then rewrite
   their whole file, which is where an older release drops fields it does not know);
2. every `"replay": true` step with the values head's run saved, so base updates and reads the
   records head made;
3. the site configs and the clock ticks.

Head does exactly the same on a second copy (the control). Both start their clock after the latest
time head's run reached, so times head wrote (a session cut-off set at its first boot, for
example) are never in their future. Base must start in safe mode, accept the prepared admin,
answer every step and site config with the status head answers (a tick route base does not have
is skipped), and answer the site configs without a server error. A JSON field head wrote counts
as lost when the control still has it and base's copy does not; a field under a reserved key
(`ext`, `delivery`, `sitePlan`, `seo`, …) counts as changed when base leaves it different from the
control; any other field counts as changed when the control left its value as it was and base did
not (an older release that drops a field and writes it back empty). Times and ids are normalized
first. So a change the flows make on purpose (an unlink, a status move) is never read as a loss.
When the control itself is refused a step that head's run accepted (sign-in, 401, 403, or a step
skipped for a missing value), the pass proves nothing and the run stops with exit 2. `rollbackLost` lists rollback keys a push accepts
(`rollback <file>:<path glob>`, `rollback response <flow>#<step> * status`, …); a listed one is a
note. `backups/` is left out: every release prunes its own oldest copies at boot.

## The report

`--out` writes the whole report as JSON; the terminal shows the unlisted differences, the listed
ones, secret and rollback failures and notes. The report can hold short excerpts of the data, so
it stays on the operator PC and never goes into a repository.

## The committed tools

Three small tools next to the dark-diff, each with self-tests (`npm run test:ship-safety`).

- `scripts/ship/switch-audit.mjs <base tree> <head tree> [--json] [--accept <file>]` loads both trees' data modules in
  safe mode with a temp data folder. It prints every automation-settings default and e-mail
  settings default that head adds or changes, every settings key head adds (with the vocabulary
  version change), and every environment variable name head's runtime files read that base's do not.
  A new leaf that is false, `off`, null, empty or 0 is `off`, `shadow` is `shadow`, anything else is
  `CHECK` and a person looks at it. Exit 1 when there is a `CHECK` (read it as: review by hand), 2 when a module cannot be loaded or
  no longer exports `defaultAutomationSettings`, `SETTINGS_KEYS` or the e-mail defaults. A person
  who has reviewed a `CHECK` leaf (a numeric limit, say) records it in a JSON file
  `{ "accept": ["defaultAutomationSettings(): quota.perSiteTestMax"] }` and passes it with `--accept`;
  accepted leaves print as `ACCEPTED` and do not count, and an entry that matches nothing is printed
  as unused.
- `scripts/ship/route-probe.mjs <hub tree> [--routes <file>] [--json]` boots the tree locally (safe
  mode, temp data folder and HOME, empty working folder, no .env), calls each route in
  `scripts/ship/probe-routes.json` without credentials and checks the answer: `staff` routes must
  answer 401 or 403, `dark` routes 404 with the code `disabled` (a row can name another code with
  `expectCode`; a plain 404 is not accepted as proof the switch is off). It then lists every data file the calls changed (logs and the
  outbox are left out). Add a row for every staff route or switched-off route a push brings. Exit 1
  on a wrong answer or a changed file, 2 when the tree does not start or the routes file lists
  nothing.
- `scripts/ship/segments.mjs <checkout> <log folder> [script]` runs every `&&` segment of a package
  script on its own, so one failing segment does not hide the others. It prints one line per segment,
  the names of the failing tests and the totals, and keeps the output of each failing segment in
  `<log folder>/seg-<n>.log`. `--find <text>` prints the segment that holds a test file name.

Run them from an empty working folder through the same wrapper as the test suite. They read the
trees they are given and write only to temp folders.

## The safe-mode soak

`npm run soak:safe -- --minutes 3` boots the hub in safe mode on a fresh data folder with an egress
recorder, drives the actions that would reach the outside world and fails on any unlisted
connection. Besides the original checks (production publish, payment webhooks, tunnel, Maker hand-off,
reminder mail in the outbox) it runs on seeded fixtures from `scripts/fixtures/safe-mode-soak/`:

- booked meetings with calendar records and a made-up connected calendar account: a calendar write
  (open the Meet room, the calendar backfill) must be refused and recorded as an intent;
- Fireflies meetings stored the way the hub stores them: a refresh of one must be refused (the
  made-up API key never leaves the machine), a live join answers 423, and the list shows the seeded
  meetings;
- handled inbox messages: the bot's status lists them, the mailbox peek and the backfill answer
  `skipped` without opening a connection, and the inbox and Fireflies background jobs are off.

It also fails when any connection goes to a mail port or a mail provider host. The fixtures are
invented (example.invalid addresses, no phone numbers); `scripts/safe-mode-soak-fixtures.test.mjs`
checks that and that a missing or empty fixture file is an error, not an empty soak.

## Reading files for the scanner

`decodeText` in `scripts/security/secret-scan-lib.mjs` reads a file as UTF-8, UTF-16 or Latin-1. A
file that is mostly UTF-8 with a few stray bytes (more valid multi-byte characters than stray bytes)
is read as UTF-8, each stray byte standing as one lone surrogate that matches nothing, so a name or a
secret next to Norwegian letters is still found. Redaction writes the stray bytes back unchanged.

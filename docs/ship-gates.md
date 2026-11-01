# Ship gates: what a hub push must pass

A push to `main` deploys the hub. Before every push, the release that is about to go out (head)
is compared with the release that is live (base) on a copy of the live data. The comparison is
`scripts/ship/dark-diff.mjs`. A push goes out only when it exits 0.

## The gates, in order

1. `npm test` is green on the head commit (it includes the dark-diff self-tests,
   `npm run test:ship-safety`).
2. `node scripts/security/secret-scan.mjs --range <base>..<head>` is clean (the pre-push hook
   runs the same scan).
3. Dark-diff on a copy of the live data, with every new switch at its default:

   ```
   node scripts/ship/dark-diff.mjs --base <live commit> --head <commit to push> \
     --data <local copy of the live data dir> --intended <intended.json> \
     --secrets --fake-secrets --rollback --out <report.json>
   ```

   Large media folders that no flow reads can be left out of the copies with
   `--skip-data <folder,folder>` (top-level folder names; `secrets` is never left out).
   It must exit 0. Exit 1 means a difference that the intended file does not list, a changed or
   new secret file, or data that the older release loses. Exit 2 means it could not run (read the
   message; nothing was compared).
4. After the push: the post-deploy check and the hub probe (`scripts/security/probe-hub.mjs`).

## What dark-diff does

- Checks out `--base` and `--head` (git revisions of this checkout, or `dir:<path>`) into a temp
  folder through a private git index. The repository's HEAD, index and work tree are not touched.
  Each tree gets a link to `--node-modules` (default: this checkout's `node_modules`).
- Copies the data folder (the source is never written; the run stops with exit 2 if it changes).
  A prep copy gets a local admin password and a local Maker host token through the base release's
  own data modules; base and head then each get their own copy of it.
- Boots each release from an empty folder with a temp HOME, in safe mode (`HUB_SAFE_MODE=1`), with
  the egress recorder refusing every connection that is not to this machine, and with the clock
  of both starting at the same instant. No `.env` is read. A release that does not report safe
  mode is stopped before anything is sent to it.
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

A local copy of the live data never holds `secrets/` (secrets stay on the server), so
`--fake-secrets` fills the live layout with random values in the copies. The check then shows
that both releases read existing secrets exactly as they are.

## --rollback

Boots base on the data head wrote after its flows: base must start in safe mode, accept the
prepared admin and answer the site configs without a server error. Every JSON field head wrote
must still be there after base ran, and every field under a reserved key (`ext`, `delivery`,
`sitePlan`, `seo`, …) must be unchanged. `rollbackLost` lists a field a push accepts losing on a
rollback (`rollback <file>:<path glob>`). `backups/` is left out: every release prunes its own
oldest copies at boot.

## The report

`--out` writes the whole report as JSON; the terminal shows the unlisted differences, the listed
ones, secret and rollback failures and notes. The report can hold short excerpts of the data, so
it stays on the operator PC and never goes into a repository.

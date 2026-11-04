# Go-live callback fixtures

Shared by the hub (`asoldi-website/scripts/fixtures/golive-callback/`) and the Maker
(`website-maker/scripts/fixtures/golive-callback/`); the two folders hold the same bytes.

- `v1-*.json`: what a Maker without schema 2 sends (`status` `ready` after the push, or `failed`).
- `v2-ready.json`, `v2-failed.json`: the same callbacks with `schema: 2`, `target` and `liveVerifiedAt`
  added; nothing else changes, so a hub that reads only the old fields handles them as before.
- `v2-production-live.json`, `v2-staging-live.json`, `v2-needs-import.json`: statuses of a Maker that
  verifies the live site.
- `v2-plan-fields.json`: a callback that also carries plan and feature fields, which the hub never reads.

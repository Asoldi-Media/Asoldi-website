# Cursor prompt

`GET /api/admin/development/:id/cursor-prompt` returns `{ prompt }` for one client run.

The switch is `iteration.cursorPrompt` (`iteration.cursorPrompt.enabled`, `iteration.cursorPrompt.mode`, `iteration.cursorPrompt.paused`). While it is off or paused the route answers `404` `{ code: 'disabled' }` and writes nothing. With the switch on, a request without credentials is `401`, a sales-only user is `403`, and an admin or developer is `200`.

`buildCursorPrompt` in `lib/cursor-prompt.js` builds the markdown. The first line names `CURSOR_PROMPT_MODEL` (`claude-sonnet-5-5`). That is not the editor's default model. The rest of the prompt is the client display name, tier, services, run id, the `/start-rediger` and `/rediger` commands, the ids of accepted-but-unapplied directives, proposed must directives, open change requests and open thread asks, and the counts of those lists.

The prompt tells the agent to send the header `x-asoldi-local: 1` and to post edits to `POST {{MAKER}}/api/runs/<runId>/custom/edits` with `source:"agent"`. Without that header the Maker answers 403. Edits stay out of `.generated-runs`, and the prompt does not name a CMS or a template.

The prompt never contains a quote, a transcript, a secret, an email address or a phone number. If the text would pass 6,000 characters, whole ids are dropped from the lowest-priority list first.

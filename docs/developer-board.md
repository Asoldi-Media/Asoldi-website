# Developer board

The developer page can show a delivery board. The board is off until the development list response includes `devBoardV2: true` (or the same boolean under `settings`). A missing value stays off, and the page then renders the same view as before. The boolean is not stored in the automation settings file from this change; it has to be added to the response the page already loads.

While the board is on, a **Gammel visning** control swaps back to the previous view. The previous view is the one that polls each card and the queue. The board does not mount that view, so those polls do not run.

## What the board shows

Lanes, in order: Preview (før signering), Signert / Innsamling, Workshop, Venter på info, Utvikling, Til gjennomgang, Hos kunde, Iterasjon, Godkjent / Publisering, Live. A stage the board does not know stays visible in a fallback lane named Ukjent steg. Preview rows from `previewItems` stay in the preview lane. SSU rows from `ssuItems` stay in their own section. Cards in a lane are ordered by due date. Filters are Mine, Tier and Blokkert.

A card shows tier, services, due date, owner, host and spend, and a stage stepper. Opening a card loads that client's detail and dev report once and keeps them. The open card has the gate, the brief tabs, directives, the job (including the dev report), change requests with a quota meter, the prompt copy button, the read-only checklist and the SEO panel. Blocking codes have an inline action. Quality notes in the dev report are shown as a proposal.

Maker links are built in the browser from the card's `makerPort` and the page hostname. A loopback hostname produces no link.

## Polling

The board uses one interval of 15 seconds for `GET /api/admin/development/board-status?since=<rev>`. The first poll waits 15 seconds; the opening read is the development list. A hidden tab makes no request. After an error the next ticks are skipped, so the wait grows without a second timer. Idle, the interval makes at most four requests a minute. Card details are not on this timer.

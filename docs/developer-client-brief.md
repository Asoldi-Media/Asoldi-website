# Developer client brief

The line next to **Ingen domene** / **Workshop ikke holdt** on `/developer`, and **Klientbeskrivelse** inside Prosjektdokument.

## What it is

A short summary of **what the business is and what they do**. Industry is part of that sentence, not a leftover Brønnøysund NACE code.

- `client.clientBrief.short` — 2–3 Norwegian sentences on the card.
- `client.clientBrief.full` — the same summary, plus at most two extra sentences from proven public pages. After a sales meeting, this slot can also hold transcript detail. It is not the T07 workshop summary (Intro / Voice / What they want / Functionality). That still waits for **Ha workshop**.

Until Infokort has written a brief, the card shows the industry word alone.

## What it is not

Not org.nr, legal form, “registrert i Brønnøysund”, or a NACE dump.

Good: `Bakkes Bilpleie er bilpleie i Kristiansand. De vasker og pleier biler.`
Bad: `Bakkes Bilpleie er et enkeltpersonforetak registrert i Brønnøysundregistrene med org.nr. 937366221.`

## Who writes it

The Infokort Haiku agent on MyPhoner ingest, hand-add, and refresh of upcoming meetings. Empty public links stay empty. A later run does not wipe a Maps CID or social URL the card already has.

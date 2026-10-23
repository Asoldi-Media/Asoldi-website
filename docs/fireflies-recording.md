# Fireflies recording

How the hub makes sure every booked online meeting (sales, workshop, iteration, recorded Møte) is
recorded by the Fireflies notetaker.

## Meet rooms: let the notetaker in without anyone admitting it

The notetaker joins the Meet as an anonymous guest ("Fireflies.ai Notetaker …"), not as
fred@fireflies.ai, even when fred@ is invited on the event. In a room at Google's default access
it knocks, and Meet often files it under "With potential risks". It gets in only if someone is
already in the room and admits it. A rep who is late, alone with the client, or who does not
recognise the knock loses the recording, and Fireflies stores nothing.

So the hub opens the rooms it books. Right after a calendar sync writes an event with a real Meet
(`upsertMeetingEvent` for sales, workshop and iteration; `upsertRecordedSalesActionEvent` for an
extra Møte), and only when the event's organizer is the mailbox of the OAuth login that wrote it,
`lib/google-meet-access.js` reads the room with the Google Meet REST API (`spaces.get` on the
meeting code). If its `config.accessType` is not `OPEN`, it patches it to `OPEN`
(`spaces.patch`, `updateMask=config.accessType`). Anyone with the link then joins without
knocking, the notetaker included. The trade-off: so would anyone else who has the link.

Live join can ask again shortly before the start with `ensureMeetRoomOpen({ meetLink,
accountKey, ownerEmail })`, for rooms minted before the host reconnected.

### Owner steps (once)

1. Google Cloud console, the project that owns `GOOGLE_OAUTH_CLIENT_ID`: APIs & Services →
   Library → **Google Meet REST API** → Enable.
2. Same project, OAuth consent screen (Google Auth Platform → Data access) → Add or remove scopes →
   add `https://www.googleapis.com/auth/meetings.space.settings` and save. Google classes it as
   non-sensitive ("Edit and see the settings for all of your Google Meet calls"), so no review.
3. Every Meet host logs in on `/sales` as themselves and clicks Connect Google Calendar once:
   today alexander@asoldi.com and damian@asoldi.com (Damian hosts workshops and iterations; each
   rep hosts their own sales meetings and Møte). Leave the Meet box ticked on Google's consent
   page. The connect URL keeps `include_granted_scopes`, so calendar and Gmail access stay as
   they were.

No Hostinger env change and no Google Admin step: asoldi.com has no Google Workspace, so a
service account cannot act for a mailbox, and only each host's own login can change their rooms.

### Seeing whether rooms are open

- `GET /api/admin/sales/google/status` (and the `calendar` block of the sales list) carries
  `meetSettingsScope: true` once that mailbox has a token with the scope. `false` means: reconnect.
- `<dataDir>/meet-room-access.json` keeps one row per meeting code (dropped after 90 days):
  `{ accessType, checkedAt, ok, reason, message, ownerKey }`. `ok: true` with `accessType: "OPEN"`
  is an open room.
- The log prints `[meet-room] <code> open owner=…` or `[meet-room] <code> not opened: <reason> …`
  whenever a room's result changes.
- In Google Calendar: open the event → the Meet host controls → Meeting access shows Open.

| `reason` | Meaning | Fix |
|---|---|---|
| `scope-missing` | No OAuth login of the room owner's mailbox carries the scope (not connected, connected before the scope was added, the box was unticked, or only a service account), or Google said the token lacks it. Without the scope, Google is not called. | The host reconnects on `/sales`. |
| `forbidden` | Google refused: the Meet REST API is not enabled, the login was rejected, or Google does not allow opening this room. | Step 1; read `message`. |
| `not-owner` | Google showed the room but would not let this login change it: another account created it. | The room's own host reconnects, or the meeting gets a new room. |
| `not-found` | Google does not know the meeting code. | Check the event's Meet link. |
| `safe-mode` | A safe-mode hub (PC or LAN box) never changes rooms unless `HUB_SAFE_MODE_ALLOW=calendarWrite`. | None needed. |
| `error` | Timeout, network or an unexpected answer. | Tried again on the next sync. |

### When it is not set up, or Google says no

Everything stays as it was before: the room keeps Google's default access, the hub still sends
the notetaker, and someone in the room has to admit it. Nothing waits on the Meet API. The check
runs in the background after the calendar write, each call has a 4 s deadline, and every failure
is stored and logged, never thrown, so mail and calendar sync are never held up. An open room is
checked again after 6 hours; a room Google refused, after 15 minutes.

Not verified yet: that Google lets a consumer (non-Workspace) account open a room Calendar
created. If rooms the host created keep coming back `forbidden` or `not-owner`, the fallback is to
mint rooms with `spaces.create` (scope `meetings.space.created`, sensitive) and attach them to the
event as conferenceData.

### Rescheduling keeps the room attached

When a time or mode change, a stale start, a deleted event or a move to another mailbox makes the
hub insert the calendar event again, a room the meeting keeps goes onto the new event as
`conferenceData` with `conferenceDataVersion=1`: a copy of the old event's conference when there
is one (without its `createRequest`, so Google never mints a second room), otherwise one built
from the meeting code. Guests keep the "Join with Google Meet" button, not just a link in
location. If Google refuses the copy, the event is inserted with the link in location only, as
before.

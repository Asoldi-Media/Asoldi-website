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

### For the live-join engine

Live join asks again shortly before the start, for rooms minted before the host reconnected and
in case a host closed the room again in Meet:

```js
ensureMeetRoomOpen({ meetLink, accountKey, ownerEmail, maxAgeMs: 15 * 60 * 1000 })
```

- `ownerEmail` is the mailbox that hosts the room: `calendar.meetHostVerifiedEmail` when set,
  else the event organizer. If that login is refused and another login opened this room before,
  that login is tried once too.
- Calling it on every tick is fine. An open room is read again only after `maxAgeMs` (default
  6 hours). The same login is not asked again within 15 minutes of a refusal or a missing scope
  (a reconnect lifts that at once), or within 3 minutes of an error. `force: true` asks anyway.
- Never await it on a mail path. It never rejects, but each Google call may take up to 4 s:
  about 12 s for one login (token, read, change), twice that when a second login is tried.

An open room changes what "the notetaker is in" means. In a knock-only room the notetaker seems
to show up in `active_meetings` only after someone has let it in. In an open room it can walk into
an empty room at T-3 and be listed at once, with nobody there to record. Fireflies gives up after
about 10 minutes alone, with at best an empty transcript. So a listing before the first
person has joined is not proof of a recording: keep checking until people are in the room (or
until about T+10), and send the notetaker again if it drops out before then.

The engine does both. `server.js` passes `openLiveSessionMeetRoom` as `deps.openMeetRoom`: from
T-30 it asks for the room each tick until it is open, with the host taken from the sales calendar
(`meetHostVerifiedEmail`, else the organizer) or Damian's login for workshops and iterations. A
notetaker that leaves before T+30 is sent back again, more than once if the one sent back also
sits alone and leaves (the open room's version of an unanswered knock), within the five-send cap.

### Before switching it on

- Single notetaker first. An open room lets every notetaker in, not only the hub's: a rep's own
  Fireflies (started by fred@ on events that rep hosts) and the hub-key owner's calendar
  auto-join on workshops and iterations. Today the knock keeps them out of an empty room. Two
  notetakers from the hub-key account in one room have left a silent one-minute fragment beside
  the real transcript. Ship this together with, or after, the host-aware fred@ policy, and have
  the hosts turn off their own Fireflies auto-join for hub meetings.
- Not verified yet: whether a consumer (non-Workspace) account may open a room that Calendar
  created, and whether Meet lets an anonymous guest into an open room of a consumer account
  before the host has joined. Check both once on a test booking (owner step 4) before relying on
  it.

### Owner steps (once)

1. Google Cloud console, the project that owns `GOOGLE_OAUTH_CLIENT_ID`: APIs & Services →
   Library → **Google Meet REST API** → Enable.
2. Same project, OAuth consent screen (Google Auth Platform → Data access) → Add or remove scopes →
   add `https://www.googleapis.com/auth/meetings.space.settings` and save. Google classes it as
   non-sensitive ("Edit and see the settings for all of your Google Meet calls"), so no review.
3. Every Meet host logs in on `/sales` as themselves and clicks Connect Google Calendar once:
   today alexander@asoldi.com and damian@asoldi.com (Damian hosts workshops and iterations; each
   rep hosts their own sales meetings and Møte). On Google's consent page, tick the Google Meet
   permission (or Select all) before Continue: new permissions may start unticked. The connect
   URL keeps `include_granted_scopes`, so calendar and Gmail access stay as they were. Then
   check that `GET /api/admin/sales/google/status` for that login shows `meetSettingsScope: true`.
4. Test once: book an online test meeting for yourself and wait until its room shows as open (the
   log line `[meet-room] <code> open`, or its row in `meet-room-access.json`). Then open the Meet
   link in a private window without signing in. With nobody in the room, and again with the host
   in it, you should get straight in without knocking.

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
| `scope-missing` | No OAuth login of the room owner's mailbox carries the scope (not connected, connected before the scope was added, the permission was not ticked, or only a service account), or Google said the token lacks it. Without the scope, Google is not called. | The host reconnects on `/sales`; the next check runs at once. |
| `forbidden` | Google refused: the Meet REST API is not enabled, the login was rejected, or Google does not allow opening this room. | Step 1; read `message`. |
| `not-owner` | Google showed the room but would not let this login change it: another account created it. | The room's own host reconnects, or the meeting gets a new room. |
| `not-found` | Google does not know the meeting code, or does not show it to this login. | Check the event's Meet link. |
| `safe-mode` | A safe-mode hub (PC or LAN box) never changes rooms unless `HUB_SAFE_MODE_ALLOW=calendarWrite`. | None needed. |
| `error` | Timeout, network, Google busy (429 and the like), a failed login, or an unexpected answer. | Tried again after 3 minutes. |

### When it is not set up, or Google says no

Everything stays as it was before: the room keeps Google's default access, the hub still sends
the notetaker, and someone in the room has to admit it. Nothing waits on the Meet API. The check
runs in the background after the calendar write, each call has a 4 s deadline, and every failure
is stored and logged, never thrown, so mail and calendar sync are never held up. An open room is
read again after 6 hours (sooner when the caller asks). A login Google refused, or one without
the scope, is asked again after 15 minutes or as soon as the host reconnects; after an error,
after 3 minutes.

If rooms the host created keep coming back `forbidden` or `not-owner`, Google does not let a
consumer account open a room Calendar made. The fallback then is to mint rooms with
`spaces.create` (scope `meetings.space.created`, sensitive) and attach them to the event as
conferenceData.

### Rescheduling keeps the room attached

When a time or mode change, a stale start, a deleted event or a move to another mailbox makes the
hub insert the calendar event again, a room the meeting keeps goes onto the new event as
`conferenceData` with `conferenceDataVersion=1`: a copy of the old event's conference when there
is one (without its `createRequest`, so Google never mints a second room), otherwise one built
from the meeting code. A room the hub's own patch just minted on the stale event is kept the same
way. Guests keep the "Join with Google Meet" button, not just a link in location. If Google
refuses the copy, or attaches some other room, the event is inserted again with the link in
location only, as before.

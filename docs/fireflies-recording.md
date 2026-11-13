# Fireflies recording

How the hub makes sure every booked online meeting (sales, workshop, iteration, recorded Møte) is
recorded by the Fireflies notetaker, and says so plainly when it is not.

## Recording states and alerts

Every booked online meeting is a live-join session (`lib/fireflies-live-sessions.js`): one Meet
room at one start time. Its state shows on the card (`client.liveRecordings`, from 30 minutes
before start to 2 hours after the booked end) and on the meeting's placeholder row in
`client.meetings` (`live:…`, its `recording` object) until the real recording replaces it.

| State | Meaning | Written by |
|---|---|---|
| `scheduled` | Booked; the notetaker goes in 3 minutes before start. | capture |
| `dispatched` | Fireflies accepted a send. That only means the bot is at the door. | capture |
| `recording` | The bot is in the room (Fireflies `active_meetings`). | capture |
| `ended` | The bot was in and has left; the transcript is on its way. | capture |
| `not-admitted` | The bot was never seen in the room: sent but never let in, sent but nobody could look at the room after (the hub was down, or an older hub sent it), or never sent at all (`message` says why: no Fireflies key, the rate limit, Fireflies refused, or the hub did not try in time). | capture |
| `missing` | Session end + 90 minutes and no recording. | watchdog |
| `empty` | By then Fireflies only has a recording with no talk, or too little to be the meeting (silent, or a few sentences). | watchdog |
| `declined` | A person marked the meeting held without a recording, or not held. One room at one start is one call, so it stops the bot for every card booked on it: another card says so on its live card and, after T+30, gets a `not-admitted` row with that reason, followed to `missing` like any other. | rep |

The placeholder row is written at the first send Fireflies accepts. A session that ends with no
bot in the room and no such send (never sent, every send refused or rate-limited, or the hub was
down) gets its row once the first-send window (T+30) is over, in `not-admitted` with the reason in
`message` and no `liveJoinedAt`. A session whose bot the hub did not send (someone added Fireflies
by hand) gets its row as soon as that bot is seen, as `recording`. A row is written once per
session: one that intake dropped after linking the recording never comes back, and none is written
when the slot's recording is already linked. A ticked "Møtet hatt" or a done Møte stops only a
meeting that has not begun: once it has begun it stays booked, so a hub that was down through the
meeting, or did not run yet, still writes its row when it comes back (within 48 hours of the start,
the engine's collect horizon and the watchdog's watch), and the meeting is reported missing.

"The slot's recording is linked" is one rule everywhere (`lib/fireflies-cover.js`, the card's own
rule): a recording on the card with talk that is not live captions and at least 10 sentences (or
talk from before sentences were counted), on that slot by its room and window, by this meeting's own
bot, or put there by a person. Capture uses it to stop sending the bot back and to skip the
placeholder, "Marker uten opptak" to answer 409, the watchdog to stop following a placeholder, and
"Møter uten opptak" to leave a row out. A "hallo?" from a bot that sat alone in an open room, a
silent copy, or live captions linked while the meeting runs never count: the bot is still sent back
while the first-send window lasts, and the meeting is still followed to `missing` or `empty`.

A reused room can still hold the bot of an earlier meeting that ran over. A bot that started more
than 30 minutes before the booked start is that meeting's: the card says so ("Fireflies fra møtet
før …"), its id never goes on this meeting's placeholder, and the watchdog only offers its
recording as a candidate, so it is never moved off the client it belongs to. The same holds the
other way: a bot that started after this meeting's booked end, or once the next booked meeting in
the room (any client's) reached its first send, is that meeting's, unless it started within the
lobby wait of one of this meeting's own sends. The engine never takes it for this meeting (a look or
a `meeting.bot_joined`), and the watchdog's room window ends at that next meeting's first send, so
an earlier meeting with no recording is reported missing instead of taking the next client's. A
`meeting.bot_joined` whose transcript is no longer live (a late or replayed delivery) counts as no
sighting at all.

The watchdog (`lib/fireflies-recording-watchdog.js`) follows every placeholder after the meeting:
it links the recording when it turns up, and at the deadline (session end + 90 minutes) sets
`missing` or `empty`. It takes a recording as found only when it would cover the placeholder once
linked (the rule above, with the card at hand: one that would land on another booked slot in the
same room is offered as a candidate). A finished recording with only a few sentences is linked so
the rep sees it, but counts as `empty` at the deadline. A recording a person excluded from this
client ("Ikke denne kunden"), pinned to another client or holds as their link on another card is
never found or offered, and a link the hub refuses (`linkStoredTranscriptToClient` answers null)
counts as nothing found: no "funnet og koblet", and a missing meeting stays missing. `empty` is
never decided earlier: a notetaker that sat alone in an open room
before the meeting leaves a silent fragment in many meetings that are recorded after all. Missing
and empty rows are looked for hourly for 48 hours, so a late recording still links. A recording is
taken by the bot's id, or on the room, only when it started between 30 minutes before the booked
start and the session's end. Without a Fireflies key nothing is looked up: a meeting no bot of the
hub's was sent to or seen in is still followed to its deadline and reported (the e-mail says the hub
could not look in Fireflies), and one a bot may have recorded waits for the key.

### E-mails, who gets them, and what to do

| E-mail | When | To | What to do |
|---|---|---|---|
| **Slipp inn Fireflies – \<bedrift>** | Fireflies accepted a send, and by max(T+3, the first accepted send + 4 minutes) a look at the room since that send finds no bot (one seen only before it, such as an earlier meeting's, does not count), while the first-send window (to T+30) lasts. Once for those first sends. **Slipp inn Fireflies igjen – \<bedrift>**: a send after the bot had been in (sent back after it dropped out, a continuation near its end time, a rep's send) that no look finds in the room 4 minutes later, while it still waits in the lobby (10 minutes). Once per such send. | The client's owning rep (`FIREFLIES_NOTIFY_EMAIL`, ansatte@, only when that rep has no e-mail), and the room's Meet host when that is someone else: only someone in the meeting can admit the bot, and Damian's calendar hosts workshops and iterations (server.js `liveSessionMeetHost`). One copy per address. Only the host when the client has no rep; nobody for a test client that is not an automation pilot. | In the meeting: admit «Fireflies.ai Notetaker» (Meet may list it under «Med potensielle risikoer»), and only one if two knock. Nobody there yet: nothing, the hub knocks again; the e-mail says so only while another automatic knock is due before T+30, and otherwise asks to admit it now. |
| **Fireflies: ingen opptak av \<møtet> med \<bedrift>** | The deadline passed with no recording (also for a meeting the bot was never sent to, and also without a Fireflies key for one no bot was sent to). Once. | `FIREFLIES_NOTIFY_EMAIL` and the owning rep. None for a test client that is not an automation pilot (its row is still marked). | Paste a Fireflies link under Bytt opptak on Tilbud if someone recorded it (a recording from the same room at another time is listed), write product notes on the card, or mark the meeting "uten opptak". |
| **Fireflies: tomt opptak av \<møtet> med \<bedrift>** | At the deadline Fireflies only has a recording with no talk, or a few sentences. Once (it shares the stamp with the missing e-mail, so a meeting is reported one way). | Same as above. | Same as above. Usually the notetaker sat alone, or the meeting was held somewhere else. |
| **Fireflies: live-join står stille / live-join feiler / tar ikke imot innsendinger til møtene / nøkkelen mangler, ingen opptak av møtene** | The live-join loop has not run for 10 minutes while a booked meeting is in its window, every round has failed for 15 minutes, Fireflies refused or rate-limited every send of the last 15 minutes (the e-mail quotes its last answer), or the Fireflies key is missing while a booked meeting starts within 2 hours. At most once per 12 hours for each of these, so a new kind of trouble is told at once. | `FIREFLIES_ALERT_EMAIL` (default damian@asoldi.com). | Check that the hub runs and logs `[fireflies] live-join …`, that the key is set and valid, that the Fireflies plan takes live joins, and that Fireflies answers. |
| **Fireflies: opptak hentes ikke inn** (and the other ingest alerts) | The transcript pull keeps failing (`docs/sales-offer-flow.md`, intake). **Fireflies: arkivet er tomt**: the archive reads empty while cards hold recordings, so the meet-link backfill stands still; once each time it happens. | `FIREFLIES_ALERT_EMAIL`. | As the e-mail says. |

The lobby stamps (`lobbyAlertAt` for the first knocks, `lobbyAlertKnockAt` for the knock after the bot
had been in that was last told) live on the session in `fireflies-live-sessions.json` and are
taken before the send, so a restart or a second hub process never sends it twice; a failed send is
tried again after 2 minutes while the window lasts. The missing/empty stamp (`alertedAt`) is on the
placeholder. The health stamps (`lastLiveJoinAlertAt:<reason>` for each reason and `lastLiveJoinAlertAt`
for the latest, like the ingest alert's `lastHealthAlertAt`) are in `fireflies-ingest-state.json`,
checked and written under the store's lock so two hub processes send each once, and kept in memory
too. The health check runs from both the live-join loop
and the ingest loop, so a live-join loop that died is still reported. Nothing alerts while safe
mode keeps live join off on purpose.

All of it goes through the hub mailer, so a safe-mode hub writes these e-mails to its outbox.
Optional `FIREFLIES_LOBBY_ALERT=0` turns the lobby e-mail off (default on).

### Routes

- `POST /api/admin/sales/:id/fireflies/live-join` `{ slotKey }`: send Fireflies again (capture).
- `POST /api/admin/sales/:id/fireflies/recording` `{ meetingId | slotKey, state: 'declined' | 'open' }`
  (the rep's own clients, or admin) → `200 { meetingId, recording, client }`. `declined` is "Marker
  uten opptak": the engine stops sending and the watchdog stops looking. A `slotKey` names the slot's
  current booking: a booked slot with no placeholder yet (a client who cancelled before the meeting)
  gets one, in `declined`. A moved Møte keeps its slot key, so the row of the time it was moved from
  is marked by its `meetingId`; a key that is no longer booked finds its newest placeholder.
  `open` undoes a rep's `declined`: a meeting already reported missing goes back to `missing`
  without a second e-mail, otherwise to capture's state (`scheduled` for one the engine has no
  session for yet, more than 36 hours ahead), and the engine takes the session up again. `400` for
  another state, `404` when no placeholder or booked slot matches, `409` when the slot's recording
  is already linked (the rule above: a fragment does not count).
- `GET /api/admin/fireflies/missing-recordings` (a rep sees their own clients, admin all) →
  `{ rows: [{ clientId, businessName, ownerId, meetingId, slotKey, kind, startedAt, meetLink, title,
  state: 'missing' | 'empty' | 'not-admitted', message, missingAt, alertedAt }], count }`: placeholders
  no linked recording covers (the rule above) that are past their deadline (later while Fireflies is
  still processing a recording from the room) or already `missing` or `empty`, not declined, newest first, the last 60
  days. A row past its deadline that the watchdog has not reached yet keeps `not-admitted` and its
  why; any other state lists as `missing`.
- `GET /api/admin/fireflies/live-join-status` (admin) → `firefliesLiveJoinStatus()` (last tick, last
  tick without errors, `failingSince`, sessions in their window with `unsentReason` and
  `lobbyAlertAt`, the limiter, `apiKeyPresent`, `safeModeBlocking`), plus `rateLimit`
  (Fireflies' pauses), `liveJoinEnabled`, `lobbyAlertsEnabled` and `alert: { reason, lastAlertAt }`.
- `GET /api/admin/fireflies/ingest-status` (admin): the transcript pull's health.

## Meet rooms: staff and Fred as co-hosts; the client still knocks

The notetaker joins the Meet as an anonymous guest ("Fireflies.ai Notetaker …"), not as
fred@fireflies.ai, even when fred@ is invited on the event. In a room at Google's default access
it knocks, and Meet often files it under "With potential risks". A signed-in sales rep who is
not the host knocks too. The client must still knock; OPEN is not used, because anyone with the
link would walk in.

So the hub prepares the rooms it books. Right after a calendar sync writes an event with a real Meet
(`upsertMeetingEvent` for sales, workshop and iteration; `upsertRecordedSalesActionEvent` for an
extra Møte), and only when the event's organizer is the mailbox of the OAuth login that wrote it,
`lib/google-meet-access.js` reads the room (`spaces.get` on the meeting code). If access is OPEN
(or not TRUSTED/RESTRICTED), it patches to TRUSTED with moderation ON. Then it adds co-hosts
(`spaces.members.create`, role COHOST): Damian, every sales user in Admin → Users (a new rep
counts as soon as they are added), every other connected @asoldi.com sales mailbox, and
fred@fireflies.ai. Those people join without knocking and can admit the client and the
notetaker. The client's own email is never added.

### For the live-join engine

Live join asks again shortly before the start, for rooms minted before the host reconnected and
in case a host closed the room again in Meet:

```js
ensureMeetRoomOpen({ meetLink, accountKey, ownerEmail, memberEmails, maxAgeMs: 15 * 60 * 1000 })
```

- `ownerEmail` is the mailbox that hosts the room: `calendar.meetHostVerifiedEmail` when set,
  else the event organizer. If that login is refused and another login opened this room before,
  that login is tried once too.
- Calling it on every tick is fine. A prepared room is read again only after `maxAgeMs` (default
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
This holds to T+30 whatever the booked length (a 30-minute workshop too); only after T+30 do the
last 10 booked minutes get no send-back. A notetaker sent back that leaves within a few minutes of
walking in was taken out by someone in the meeting, so it is not sent again; the card points the
rep to «Marker uten opptak» when the client does not want a recording.

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
   add `https://www.googleapis.com/auth/meetings.space.settings` and
   `https://www.googleapis.com/auth/meetings.space.created` and save. Settings is non-sensitive;
   created is sensitive (co-hosts) and needs a reconnect.
3. Every Meet host logs in on `/sales` as themselves and clicks Connect Google Calendar once:
   today alexander@asoldi.com and damian@asoldi.com (Damian hosts workshops and iterations; each
   rep hosts their own sales meetings and Møte). On Google's consent page, tick the Google Meet
   permissions (or Select all) before Continue: new permissions may start unticked. The connect
   URL keeps `include_granted_scopes`, so calendar and Gmail access stay as they were. Then
   check that `GET /api/admin/sales/google/status` for that login shows `meetSettingsScope: true`.
4. Test once: book an online test meeting for yourself and wait until its room shows as prepared (the
   log line `[meet-room] <code> open`, or its row in `meet-room-access.json` with
   `accessType: "TRUSTED"`). Sign in as another @asoldi.com rep and join without knocking. Open the
   Meet link in a private window without signing in: that guest (the client) should still knock.

No Hostinger env change and no Google Admin step: asoldi.com has no Google Workspace, so a
service account cannot act for a mailbox, and only each host's own login can change their rooms.

### Seeing whether rooms are open

- `GET /api/admin/sales/google/status` (and the `calendar` block of the sales list) carries
  `meetSettingsScope: true` once that mailbox has a token with the scope. `false` means: reconnect.
- `<dataDir>/meet-room-access.json` keeps one row per meeting code (dropped after 90 days):
  `{ accessType, checkedAt, ok, reason, message, ownerKey, memberEmails? }`. `ok: true` with
  `accessType: "TRUSTED"` (or `RESTRICTED`) is a prepared room. `OPEN` is treated as stale and
  patched again.
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

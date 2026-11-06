# Inbox bot (alexander@asoldi.com)

`lib/inbox-bot/` reads new mail in alexander@asoldi.com over IMAP every minute (`startInboxBotLoop` in `server.js`), matches the sender to a sales card and decides what to do. Set `INBOX_BOT_ENABLED=0` to stop the loop.

The rule throughout: when the bot is not sure, it hands the mail to a person (`needs_human`). It never guesses a booking or a cancel.

## Who gets an answer

Only clients **before Tilbud**: the card is active, not SSU, and has none of Møte holdt, Tilbud sendt or Kontrakt signert (`lib/inbox-bot/stage.js`). The stage is read again after the AI and calendar checks; if a rep moved the card on meanwhile, nothing is sent or changed.

Clients in **Tilbud**, **Venter signering** or **Solgt** (and Ikke solgt / Sekundær cards) never get a reply, a booking or a card change from the bot. Their mail is logged as `needs_human` with reason `stage:offer`, `stage:signature`, `stage:won` or `stage:off`. A plain "takk" is logged without the flag. The card shows the amber pill "E-post venter svar", and the Admin card lists the mail under "E-post fra kunden".

The sender must be the card's own address (`via: 'email'`: contact, client or website e-mail). The reply goes to that address. Reply-To is always alexander@asoldi.com (the mailbox the bot reads), so the client's answer comes back to the bot. The subject is always ours ("Re: …").

- An address the AI found (in the body, by org number or business name) is `via: 'hint' | 'org' | 'name'`. No reply; logged `needs_human` with reason `other-address`.
- An address that is on two cards is `via: 'ambiguous'`. No reply on either card; logged `needs_human` (`ambiguous-sender`) on the later-stage card.
- Mail from @asoldi.com and machine mail are never answered.

## What the client asks for

`lib/inbox-bot/intent.js` reads only the client's new text: no subject, no quoted thread (`packages/suite/core/mail/thread.js`). Line breaks are kept for the time parser, so "Torsdag passer ikke / Fredag kl 13 går fint" on separate lines reads as two sentences. It sorts the mail into one request.

| Request | Example | What the bot does |
|---|---|---|
| confirm | "Ok 👍", "Takk, det stemmer. Sees!", "Torsdag passer fint", "Vi snakkes torsdag", "ok, ses på torsdag", "Gleder meg til å se utkastet på torsdag", a reminder echo | Nothing. |
| reschedule | "Kan vi ta fredag 7. mars kl 13 i stedet?", "kan ikke kl 10, men kl 14 samme dag", "Kan vi ta torsdag kl 14 i stedet?" or "Kan vi flytte møtet til kl 11?" (meeting Thursday 10:00), "Vi må dessverre flytte til torsdag 13. mars kl 10", "Neste uke tirsdag kl 9 hadde passet bedre" | Books the time for the card's sales rep (see below). |
| reschedule_day | "Tirsdag passer bedre", "Hva med fredag ettermiddag?", "kan vi ta det neste uke?", "Kan vi utsette møtet en uke?" | Cancels the old time, offers free times that day (or that week; "en uke" means the week after the booked meeting). |
| cancel | "Jeg kan dessverre ikke komme på møtet", "Torsdag blir vanskelig" | Cancels the meeting, adds a "Ny møtetid" task, asks which day and time suits and offers free times. |
| question | "Hva koster det?", "Er møtet fortsatt torsdag kl 10?", "Hvilken dag var det vi hadde møte igjen?", "står det kl 10 eller 11?", "Hvordan blir jeg med?" | Answers from the brief, or the FAQ in `faqReply` without AI, and keeps the meeting. A question about the booked day or time gets the booked time from the card; the FAQ never says how long the meeting lasts ("Hvor lenge varer møtet?" goes to a person). An unknown question goes to a person. |
| call / not_now | "Ring meg", "Ta kontakt etter sommeren" | Adds a follow-up task and says when we get in touch (see below). |
| not_interested | "Vi er ikke interessert", "Nei takk, …", "Vi ønsker ikke å gå videre med dette", "vi kommer ikke til å gå videre", "vi trekker oss", "Jeg har ombestemt meg" (only when nothing else in the mail asks for a time or a day; a question or an "hvis" about it is not a no) | Cancels the meeting. Asks once why, and offers a short chat. A second no closes politely. A cancel that already gives a reason about money or need ("Må avlyse, vi har ikke budsjett i år", "har valgt et annet byrå") cancels and closes politely at once, with a follow-up task for the rep; it never asks which day suits. |
| contract | "Når kommer kontrakten?" | No reply. Marked `needs_human`. |
| info | Opening hours, address | Files the facts in Kundedata. A short thanks only when the AI writes one. With no AI reply, a facts mail that names a weekday, a clock or the meeting ("vi kan møtes fredag kl 13") goes to a person (`info-about-meeting`) instead of being filed silently. |
| other / unclear | Anything the words don't settle | No reply. Marked `needs_human`. |

How the words are read:

- **Confirm** needs a real yes ("ok", "takk", "det passer", "det går fint", "det stemmer", "sees" or the typo "ses", "gleder meg til" with the booked day, emoji and punctuation allowed) and no question. A mail that also has a can't-come cue is never a confirm (only the exemption in the next point lifts the cue); "Jeg kan ikke komme, men torsdag går fint" goes to a person (`booked-day-unclear`) and is never cancelled either. A question that names the booked day or time is a question. The booked day named with a reason it does not work ("vanskelig", "umulig", "kolliderer", "fullbooket", "ferie", "kurs", "opptatt", "bortreist", "går ikke", "funker ikke", "ikke så bra", "ikke tid") is a cancel. The booked day named with neither is `unclear` (`booked-day-unclear`).
- A generic "kan / får / klarer / rekker / kommer … ikke" only cancels when the meeting, a day or a time follows within a few words ("kan ikke komme", "får ikke til møtet", "kan ikke torsdag", "kan ikke i morgen"). "Jeg kan ikke åpne lenken" is never a cancel.
- "Kan ikke i morgen" about a day that is not the meeting day, while the meeting stands, goes to a person (`cancel-other-day`): asking for a new time while the reminders still name the old one would confuse. When the same mail names the booked day with a yes ("Jeg er syk i dag, men torsdag skal gå fint"), it is a confirm and the meeting stays. The same holds when the can't-come clause names no day and not the meeting itself ("Jeg er syk, men torsdag skal gå fint", "Ligger syk nå, men torsdag går nok fint").
- Weekdays count in their definite form too ("torsdagen", "denne torsdagen"): "Jeg rekker ikke denne torsdagen" cancels. "Torsdagen etter kl 10" (the Thursday a week on, or Thursday after 10?) is never read on its own: a person decides (`time-unclear`).
- **A date written out** ("torsdag 13. mars kl 10", "13.03", "13/3") that is not the booked date is a new time, never the booked meeting, even at the booked weekday and clock. Only without such a date does "torsdag kl 10" count as the booked meeting when the parser lands a week off.
- **The time is read three ways**: with the line breaks kept, with soft wraps joined (a line that goes on in lower case continues the line above) and as one line. A soft-wrapped "…på torsdag / kl 10 likevel. Kan vi ta fredag kl 13?" would otherwise pair the orphan "kl 10" with "fredag". When the readings name different times, nothing is booked or cancelled and a person decides (`time-unclear`). One thought per capitalised line ("Torsdag passer ikke / Fredag kl 13 går fint") still books.
- **A new clock on the booked day** ("Kan vi ta torsdag kl 14 i stedet?", "kan vi ta kl 11 i dag?" on the meeting day, "Kan vi flytte møtet til kl 13 samme dag?", "Torsdag går fint / Men kan vi starte kl 10.30 i stedet?") is a new time, never the booked meeting: it is booked like any new time (hours and the rep's calendar checked; the booked meeting's own calendar event does not count as busy). Named as a plain yes ("Torsdag kl 14 passer fint" when the meeting is at 10) it goes to a person (`time-unclear`).
- **A new clock with no day at all** ("Kan vi flytte møtet til kl 11?", "Går det an å flytte til kl 13?", "Kan vi utsette møtet til kl 14?", "Jeg rekker ikke kl 10. Kl 12 da?") is a move on the booked day, never a cancel, booked the same way (hours and the rep's calendar checked). "Kan vi flytte fra 10 til 11?" means the "til" clock; when the "fra" clock is not the booked one, or the sentences name different clocks, a person decides (`time-unclear`). Only a sentence that asks counts: a clock about something else ("er på jobb til kl 17", "kan vi ta en prat kl 11?") never moves the meeting, and a day, date or week named anywhere in the mail turns this rule off.
- **A new clock on the booked day that cannot be booked** (outside 08:00–17:00, busy for the rep, or already passed) never voids the meeting and never offers its own slot back: the meeting stands and a person answers (`time-unavailable`).
- "Ingen av disse passer" never books one of the offered times. With nothing booked, the bot offers other days (none of the offered days), except a day the client asks for ("Har dere noe på mandag ettermiddag?" gets Monday afternoon, never the same times again); a clear new time ("Ingen av tidene passer. Torsdag neste uke kl 14?") is booked. With a meeting still booked, a person answers (`decline-all`).
- A day only books an offered slot when it is named as a yes ("fredag passer"), never "fredag er helt fullt", never "neste uke passer" (a week is not the Monday we offered), and only when the slot fits the part of the day the client named: "Onsdag passer, men helst etter lunsj" gets Wednesday afternoon times instead of the 09:00 we offered.
- "Ja takk" to an offer with nothing booked goes to a person (`yes-to-offer`).
- A time in a mail about something else ("Takk! Regnskapsføreren er her fredag kl 13") never books; "takk" only counts as a sign-off at the very end.
- English works the same way ("Could we do Friday at 2pm instead?" books Friday 14:00 and is not a side question). "Vi snakkes" counts as a yes; past tense "hadde passet bedre" counts as a preference.
- A question about the meeting link ("Kan du sende lenken på nytt?", "jeg kan ikke åpne lenken") gets the link from the card. With no link on the card a person answers (`no-meet-link`). Teams, Zoom or a physical meeting is the rep's call: a person answers.

The AI (`decide.js`, DeepSeek) writes the reply text and may veto an action. It can never book or cancel on its own, and it never turns a mail meant for a person (contract, unclear, another day) into an automatic answer; such a mail keeps its own reason (`time-unclear`, `decline-all` …) even when the AI reads it as a booking. When an AI is configured and the call fails or returns no valid request for a card change, the mail goes to a person (`ai-unavailable`); with no AI at all, the words alone decide. A model reply is dropped when it names a day or clock time (Oslo date and HH:MM together) we did not offer, uses "klokka 14", "14-tiden" or "2 pm", quotes a price (kr, kroner, NOK, ",-"), links a domain other than the meeting link, or claims it moved, booked, set up, cancelled or confirmed anything.

## Booking and cancelling

- **Book**: weekdays 08:00–17:00 only, and only for the card's assigned sales rep (no rep: a person books, `no-assigned-rep`). The time must be free in the rep's Google Calendar (if Google cannot answer, the booking still goes ahead and the rep chain sends the invite) and not already passed on the real clock. The server hook `moveSalesMeetingFromInbox` runs the same chain as a rep moving the Møte row in the panel: it moves the row, re-keys the 3d/24h/1h reminders, sends the rep's calendar invite and the branded confirmation. The bot only mails its own short line when that confirmation did not go out, and closes any open "Ny møtetid" task. A question in the same mail ("Hva koster det? Og kan vi ta fredag kl 13?") gets its FAQ answer in that line; when the rep confirmation already went out, or there is no FAQ answer, the row is flagged `question-with-booking`. A busy, weekend or off-hours time on another day gets other times instead ("Vi har dessverre ikke møter i helgen"); on the booked day it goes to a person (`time-unavailable`) and the meeting stays. A reply that opens with a formatted date starts with a capital ("Fredag 7. mars 2031 kl. 14:00 er dessverre opptatt hos oss.").
- **Move hook partial failure**: the hook writes the Møte row first. When the calendar sync or the confirmation mail throws after that, it still reports `ok: true` (the card did move) with a `warning`. The bot then flags the row `needs_human` (`move-warning:<warning>`) so a rep checks that the Google event and the client have the new time; the client still gets the bot's short line.
- **Offers**: never Saturday or Sunday, never the booked day, never the day of a meeting the client just cancelled (`salesPlaybook.cancelledMeetingAt`), never a day the client said they cannot do. A day the client names for a new clock stays offerable.
- **Cancel (void)**: `voidSalesMeetingFromInbox` deletes the Google event (the client gets the calendar cancellation). `sales.voidSalesMeetingTime` then clears the agreed time, the Møte row time, every reminder stamp including the confirmation stamp, and the calendar fields. It also stores `salesPlaybook.cancelledMeetingAt`. A voided time never comes back: a MyPhoner replay or merge may set a time on a voided card only from a winner event newer than the cancel, and the startup booking backfill never fills a voided card's meeting time from the MyPhoner lead. The card moves to Venter møtebekreftelse. If the void fails, nothing else happens: no task, no mail, and the row is `needs_human` (`void-failed:<error>`).
- **Later**: "ta kontakt etter sommeren / til høsten / etter jul / etter påske / neste måned" voids a booked meeting and puts the follow-up in that period ("Helt greit, da tar vi kontakt etter sommeren."). With no day and no period named, the bot promises no date ("… litt senere"), and the follow-up task never lands on the declined meeting day. "Vet ikke ennå" while a meeting is still booked goes to a person (`unsure-with-meeting`).
- **Old mail**: a mail older than 30 minutes on the real clock, or written before the meeting was last confirmed or cancelled, never voids or moves a meeting (`stale-mail`). Backfill never voids or moves.
- **Same sender, one batch**: only the newest mail gets a reply. An older cancel or new-time request is only skipped by a newer decision or a yes to the booked meeting ("torsdag passer likevel"), never by a thanks or a side note, and a skipped one is flagged `needs_human` (`older-same-thread`).
- **Mail that does not go out**: a card change or an answer whose reply fails is `needs_human` (`reply-failed`), with the error in the summary. Only times the client actually received count as offered.
- The reminder loop also skips Tilbud, Venter signering, Solgt, inactive cards and meetings marked no-show/skip. It re-keys stale stamps before it sends, so a reminder can never name a wrong or cancelled time.
- When the client answers the bot's offered times with a day ("mandag passer"), the bot books the one slot it offered that day.

## Contracts

A PDF counts as our contract only when it is a PDF and its file name is `Asoldi-kontrakt…`, or its text has org no. 934 327 497 or CHAPANA. Every PDF in the mail is checked, not only the first. The bot files it on the card and never replies about the contract. It marks **Solgt** only when every gate passes:

- the sender is the client's own address;
- the card is in Venter signering;
- the card is not already signed, here or on the preview;
- the PDF is not the unsigned copy we sent;
- the last page has the client's signature block ("For kunden" / "For Client"). An Asoldi invoice, a CHAPANA receipt, printed vilkår or an appended e-signing certificate page is stored as `pending` with reason `no-signature-block` for a person ("PDF fra Asoldi mottatt, men siste side har ikke kundens signaturfelt …");
- the signature check finds real signing evidence.

Anything else is stored as `pending` (Admin sees "Kontrakt mottatt"), `unsigned_copy` or `already_signed`. Solgt from an e-mailed PDF never fast-tracks past Møte/Tilbud.

Accepting the offer in the client portal or on the website preview is the client's e-signature: it marks the card **Solgt** with `fastTrack`, so it reaches Solgt even when Møte holdt and Tilbud sendt are not ticked. The preview-acceptance backfill (`backfillRecognizedSignedContracts`) does the same for an acceptance it finds later.

The client's own words in a contract mail still pass the normal gate: answered in the meeting stage, logged for a person in Tilbud, Venter signering and Solgt. A bare "her er kontrakten" with no question is only logged.

## Files from the client

Attachments (logo, photos, menus) are filed on a card only when the sender's own address matched it; anything else is filed as unmatched for a person to assign. A forwarded mail with no words of the client's own (subject "VS:" / "Fwd:") still sends the forwarded text to the Kundedata facts filer.

## Reasons a mail goes to a person

Each `needs_human` row has a `reason` (the part before `:` picks the Admin label in `InboxBotPanel.tsx`; the rest is detail) and a summary from `needsHumanSummary` in `write.js`. The card shows the amber pill "E-post venter svar".

| Reason | When |
|---|---|
| `stage:offer`, `stage:signature`, `stage:won`, `stage:off` | The client is past the meeting stage (or not active in sales). |
| `other-address` | The mail came from an address that is not the card's own. |
| `ambiguous-sender` | The address is on two cards. |
| `stale-mail` | Older than 30 minutes, written before the meeting was last confirmed or cancelled, or the meeting changed while the bot waited. |
| `older-same-thread` | An older cancel or new-time request in the same batch was not answered. |
| `time-unclear` | The line-kept, soft-wrap-joined and one-line readings name different times, a different clock on the booked day is named without asking to move, "fra 9 til 11" does not start at the booked clock, or "torsdagen etter" cannot be read on its own. |
| `time-unavailable` | A new clock on the booked day is outside 08:00–17:00, busy for the rep or already passed. The meeting stands. |
| `booked-day-unclear` | The booked day is named with neither a yes nor a no, or a can't-come clause sits next to a yes to the booked day. |
| `day-differs-from-booked`, `day-without-meeting` | Another day is named, but not clearly as a wish to move (or nothing is booked). |
| `cancel-other-day` | "Kan ikke i morgen" about a day that is not the meeting day. |
| `unsure-with-meeting` | "Vet ikke ennå" while a meeting is still booked. |
| `decline-all` | "Ingen av disse passer" while a meeting is still booked. |
| `yes-to-offer` | "Ja takk" to an offer, without picking a time. |
| `question:contract`, `question:unknown` | A contract or offer question, or a question the bot has no answer for. |
| `no-meet-link` | The client asks for the meeting link and the card has none. |
| `question-with-booking` | The bot moved the meeting, but a side question got no answer. |
| `move-warning:<warning>` | The meeting moved, but the calendar sync or the confirmation failed afterwards. |
| `no-assigned-rep` | A booking was asked for, but the card has no sales rep. |
| `book-failed:<error>` | The move hook failed; nothing changed. |
| `void-failed:<error>` | The cancel failed; nothing was added or sent. |
| `reply-failed` | The card changed (or an answer was ready) but the mail did not go out. |
| `ai-unavailable` | The AI was configured but did not answer about a card change. |
| `ai-disagrees:<request>`, `ai-sees:<request>` | The AI read a different request than the words; a person decides. |
| `info-about-meeting` | A facts mail with no AI reply names a weekday, a clock or the meeting. |
| `unclear` | Nothing the words settle. |

## Data and routes

- `~/.asoldi-website-data/inbox-bot.json`: processed ids, mailbox baselines and the last 400 items. Each item has `kind`, `status` (`applied`, `logged`, `needs_human`, `skipped`, `pending` …), `intent`, `reason`, `stage` and `offeredSlots`.
- `~/.asoldi-website-data/inbox-contracts/<clientId>/`: contract PDFs.
- `GET /api/admin/inbox-bot/status` and `GET /api/admin/inbox-bot/peek` (dry run, no sends). `POST /api/admin/inbox-bot/backfill` with `confirm: 'backfill-once'` answers missed mail; it uses the same gates, never voids or moves a meeting, and checks again right before each mail that the live tick has not handled it. It answers 409 (with `busy: 'tick'` or `busy: 'backfill'`) while the minute tick or another backfill runs; try again a minute later.
- Tests: `scripts/inbox-bot.test.mjs`, `scripts/inbox-bot-intents.test.mjs`, `scripts/inbox-bot-contract.test.mjs`, `scripts/inbox-bot-panel.test.mjs`, `scripts/mail-thread.test.mjs`, `scripts/workshop-time-parse.test.mjs`, `scripts/sales-meeting-void.test.mjs`.

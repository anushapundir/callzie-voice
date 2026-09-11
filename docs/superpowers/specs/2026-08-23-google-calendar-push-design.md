# Design: Google Calendar push and Collision detection

**Issue:** [#20](https://github.com/anushapundir/callzie/issues/20)
**Date:** 2026-08-23
**Status:** Implemented. Plan at `docs/superpowers/plans/2026-08-23-google-calendar-push.md`

## What changed while building it

Six things this design did not anticipate, each recorded because the reasoning
matters more than the edit.

**1. The column is `google_access_lost_at`, not `google_revoked_at`.** Verifying
against Google's docs turned up the seven-day expiry on Testing-status refresh
tokens, which arrives as the same `invalid_grant` as a revocation. "Revoked"
would have been false most of the time, so the name describes the state rather
than one of its two causes. The seven-day section above was written after that
discovery, not before it.

**2. The push-time read widened to whole days too.** The design originally said
push-time needed no arithmetic because Google's `timeMin`/`timeMax` filter is
already an overlap test. That is true and irrelevant: an all-day event might not
be returned by a query for one 45-minute Appointment, and all-day events raise a
Collision by decision. Both triggers now ask for whole local days, so there is
one rule rather than two. Caught reading the spec back before writing any code.

**3. `CsvUploadReport` gained `createdIds`.** The report carried a count, and the
push needs an id per row. The alternative — a callback threaded into
`uploadCsvRows` — was more machinery to avoid one field. The field is documented
as not for display, because nothing renders it.

**4. `lib/tools/handle.test.ts` does not exist, and neither do Settings component
tests.** The plan listed both as files to modify. The Tool path is covered
end-to-end by `app/api/tools/routes.test.ts`, which drives the real route
handlers, so the three new assertions about which Tools defer a push went there
instead of into a new file that would duplicate its fixture.

**5. `routes.test.ts` needed the `after()` mock.** `after()` throws outside a
request scope, so adding it to `handleToolRequest` broke ten existing tests that
call the handlers directly. The fix was the pattern
`app/api/webhooks/retell/route.test.ts` already used: collect the callbacks
instead of running them. Those tests deliberately never flush them, which is
itself the assertion — what Maya is told and what Postgres holds must not depend
on the push.

**6. The migration is `0005`, not `0004`.** Main gained one while this branch was
behind.

## Summary

Callzie writes its Appointments to the Business's Google Calendar, then reads
that window back to find out whether anything else is already sitting in it. If
something is, the Appointment is marked `collision` and stops being callable
until a human clears it.

The direction never reverses. Google is told what Callzie decided; Google never
tells Callzie anything. An event the owner creates by hand does not remove a
Slot from Availability, does not move an Appointment and does not change a
status. It raises a Collision and stops there. That is ADR-0004, and every
choice below follows from it.

Three things this design is careful about.

**One function owns every conversation with Google.** `syncAppointmentToGoogle`
reads the Appointment row and works out whether that means insert, patch, delete
or nothing. Callers say "this Appointment changed" and never pick a verb. That
makes the whole thing safe to run twice, which is the entire retry story for
work that happens after the response has already been sent.

**Nothing Google does can slow down a live Call.** The booking that matters
happens inside a Retell Tool endpoint while somebody is talking, and a slow
response there is dead air. Every Google call runs in `after()`, so Maya's reply
is already on its way back to Retell before Callzie says a word to Google.

**Clearing a Collision is permanent.** Callzie remembers which Google events it
has already reported, so a re-check that sees the same overlap again does
nothing. Without that, Clear would undo itself within seconds and the button
would look broken.

## What already exists

Most of the surrounding machinery shipped in other tickets. This one is smaller
than the issue makes it sound.

| Already built | Where | What it gives us |
|---|---|---|
| The OAuth handshake | `app/api/google/start`, `app/api/google/callback` | A stored, working refresh token |
| Token encryption | `lib/google/crypto.ts` (ADR-0009) | `v1:` prefixed AES-256-GCM, key in Secret Manager |
| The feature flag | `lib/google/config.ts` | `googleCalendarConfigured()` — all three env vars or nothing |
| Connection state | `lib/google/connection.ts` | `googleConnection()`, `storeGoogleConnection()`, `clearGoogleConnection()` |
| The write scope | `lib/google/oauth.ts:51` | `calendar.events`, already requested and granted |
| The calendar id | `lib/google/oauth.ts:332` | `fetchPrimaryCalendarId()`, falling back to the `primary` alias |
| `google_event_id` | `lib/db/schema.ts:175` | The column, waiting for a writer |
| The `collision` reason | `lib/db/schema.ts:45` | Already one of the four `NEEDS_ATTENTION_REASONS` |
| The Needs Attention surface | `components/overview/needs-attention.tsx` (#15) | Renders `collision` with copy already written |
| The call block | `lib/calls/start-web-call.ts:138`, `lib/calls/batch/eligible.ts:40` | Both Call now and Call all already refuse a flagged Appointment |
| Clearing | `lib/appointments/clear-attention.ts` (#15) | The only resolution, human-triggered, one column |
| The Collision marker | `lib/schedule/day-layout.ts:191` (#18) | The day grid already draws it, currently always silent |
| `after()` in production | `app/api/webhooks/retell/route.ts:78` | The post-response pattern, already proven |
| CPU after the response | `scripts/setup-infrastructure.sh:484` | Cloud Run deployed `--no-cpu-throttling` |
| Timezone arithmetic | `lib/time/zone.ts` (ADR-0007) | `zonedTimeToInstant`, `addCalendarDays` — no library needed |
| Injected-`fetch` testing | `lib/google/oauth.test.ts` | The pattern for testing a third party without calling it |

So three of the six acceptance criteria are already met before a line is
written: connecting is optional, a Collision blocks calling, and nothing from
Google touches Availability — Availability is computed entirely from Postgres
(SPEC.md §6) and this design adds no reader to it.

## Decisions taken during brainstorming

**1. Detection runs at push time *and* when the owner is looking.** ADR-0004
describes the push-time read: write the event, read the window back. That read
alone cannot satisfy the acceptance criterion, because the criterion is a
*manually created* overlapping event, and an owner who adds that event an hour
after the booking would never be seen. So Overview also fires a re-check.
Rejected: push-time only (the demo would only work if the manual event were
created first, a sequencing constraint nobody watching would know about); a
Cloud Scheduler sweep (a new job, a new authenticated endpoint and a window to
bound by hand, for a feature behind a flag on one account).

**2. The calendar mirrors the full Appointment lifecycle.** Insert on create,
patch on Reschedule, delete on cancel or decline. Rejected: insert only. A
Reschedule would leave the old event behind, and Callzie's own ghost at 10am
would then be detected as a Collision against Callzie's own booking at 4pm — the
feature generating its own false positives.

**3. Every Google call runs in `after()`.** One pattern for all callers rather
than "inline here, deferred there". Rejected: an outbox table with a worker. It
is the only option that survives a crash between the Postgres commit and the
push, and it is a new table, a new migration and a new runner for a flagged
feature on one account. The reconciler being safe to re-run is the cheaper
ninety per cent of the same guarantee.

**4. A cleared Collision is not raised again for the same event.** Callzie
records the Google event ids it has already reported. Rejected: re-raising every
time. The overlap is still real, so re-raising is not *wrong* — but Clear means
"I have seen this", and a button whose effect vanishes in five seconds is not a
button.

**5. All-day events count as a Collision.** If the owner has blocked out the
whole day, every Appointment in it genuinely is a problem. The cost is that one
"Vacation" event raises a Collision on every Appointment that day. Decision 4 is
what makes that acceptable: it happens once, and clearing it sticks.

**6. Losing access clears the connection and says so.** Callzie deletes its copy
of the credential and stamps `google_access_lost_at`, so Settings reads "not
connected" with a line explaining why. Rejected: keeping a token Callzie knows
is dead; and logging silently, which would leave Settings claiming a calendar
was connected while nothing had reached it for weeks — the exact half-state
ADR-0004 exists to rule out.

## Verified against Google's documentation

Fetched 2026-08-23, per SPEC.md §3 rule 12. These belong in
`docs/verification.md`.

| Fact | What the docs say | Source |
|---|---|---|
| `timeMin` | "Lower bound (**exclusive**) for an event's **end** time to filter by." RFC3339, "mandatory time zone offset" | [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) |
| `timeMax` | "Upper bound (**exclusive**) for an event's **start** time to filter by." | same |
| `singleEvents` | Expands recurring events into instances. **Default `false`** | same |
| `showDeleted` | Includes events with `status` `cancelled`. **Default `false`** | same |
| `maxResults` | "By default the value is 250 events. The page size can never be larger than 2500 events" | same |
| `transparency` | "`opaque` - **Default value.** The event does block time... `transparent` - The event does not block time" | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| `status` | `confirmed` (default), `tentative`, `cancelled` | same |
| All-day shape | `start.date` `"yyyy-mm-dd"` for all-day; `start.dateTime` RFC3339 for timed. `end.date` is **exclusive** | same |
| `events.insert` | `POST .../calendars/{calendarId}/events`. Only **two** required properties: `start` and `end` | [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) |
| `events.patch` | "supports patch semantics... Fields that you don't specify in the request remain unchanged". Costs **three quota units** | [events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch) |
| `events.delete` | Already deleted → **410**, reason `deleted`. "For already deleted events, no further action is necessary." Never existed → **404** | [errors](https://developers.google.com/workspace/calendar/api/guides/errors) |
| Refresh | `POST https://oauth2.googleapis.com/token`, form-encoded, `grant_type=refresh_token` + `refresh_token` + `client_id` + `client_secret` | [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2/web-server) |
| Refresh response | `access_token`, `expires_in`, `scope`, `token_type`. A new `refresh_token` only when `access_type=offline` was set on the original request | same |
| `invalid_grant` | "the token may have expired or has been invalidated. Authenticate the user again". Carries an `error_subtype` distinguishing revocation from a session policy | same |
| **Testing status expiry** | "a publishing status of 'Testing' is issued a **refresh token expiring in 7 days**, unless the only OAuth scopes requested are a subset of name, email address, and user profile" | [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) |
| **Test user cap** | "limited to up to **100 test users** listed in the OAuth consent screen" | [Manage App Audience](https://support.google.com/cloud/answer/15549945) |
| Scope classification | `calendar.events` is **sensitive, not restricted** — the restricted list contains only Gmail, Drive and Fit | [Restricted scopes](https://support.google.com/cloud/answer/13464325) |
| Refresh token cap | "a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID... creating a new refresh token automatically invalidates the oldest" | [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) |

**The `timeMin`/`timeMax` pair is the single most useful fact here.** "End time
after `timeMin`, start time before `timeMax`" is precisely the overlap test —
`startsAt < otherEnd && endsAt > otherStart`. That is what makes a single
request over a wide window safe: Google is guaranteed to return everything that
overlaps any part of it, so nothing can be missed by asking for too much. Both
bounds being *exclusive* also means an event that merely touches the boundary is
not returned, which is the right answer for back-to-back bookings.

Callzie still does its own comparison in `overlap.ts` rather than trusting the
window to have narrowed things down — see the all-day problem below, which
forces the query to be wider than any one Appointment.

**`singleEvents=true` is not optional.** Left at its default, a weekly recurring
meeting comes back as the recurrence *rule* rather than as this week's instance,
so its times would be meaningless and the occupied slot would be missed.

**`transparency` must be checked in our code even though `showDeleted` need not
be.** Cancelled events are excluded for free. Free-marked events are not, and
the field is *absent* on most events because `opaque` is the default — so the
test is `transparency === "transparent"` means ignore, and anything else,
including absent, means busy.

## The seven-day clock

**This is the most important thing verification turned up, and it answers
SPEC.md §13 item 4.**

Google issues a refresh token that **expires after seven days** to any external
app whose OAuth consent screen is in Testing status, unless the only scopes
requested are name, email and profile. `calendar.events` is not in that exempt
subset. ADR-0004 ships this integration in Testing status deliberately, so the
connection dying weekly is not a bug to fix — it is the price of not waiting
weeks for OAuth verification.

Two consequences, both designed for rather than worked around.

**The designed state covers expiry and revocation identically.** Both surface as
`invalid_grant` on the refresh, and the honest thing to tell an owner is the
same in both cases: the connection is gone, reconnect. That is why the column is
`google_access_lost_at` and not `google_revoked_at` — "revoked" would be a lie
six days out of seven.

**The Settings copy has to say it out loud.** An owner who reconnects on Monday
and finds it broken the following Tuesday, with no explanation, will conclude
Callzie is broken. One sentence prevents that.

The test-user cap is 100, which settles the other half of §13 item 4 and is far
more than a single-builder account needs.

## Architecture: one reconciler

The rule the whole feature enforces is one sentence:

> The connected calendar holds exactly one event for every Appointment holding a
> Slot, and none for any Appointment that is not.

That sentence is already in the schema. `SLOT_HOLDING_STATUSES` and
`SLOT_FREEING_STATUSES` (`lib/db/schema.ts:69`) split the seven statuses in two,
and the split is exactly the one Google needs — `cancelled` and `declined` are
precisely the Appointments whose events should not exist. Reusing that constant
means the calendar and the `appointments_no_overlap` exclusion constraint can
never disagree about which Appointments are real.

So there is one entry point, and it decides:

```
syncAppointmentToGoogle(appointmentId)
```

| Row says | `google_event_id` | Action |
|---|---|---|
| Holding a Slot | null | **Insert**, store the returned id |
| Holding a Slot | set | **Patch** that event's `start` and `end` |
| Freeing a Slot | set | **Delete** that event, null the id |
| Freeing a Slot | null | Nothing |

**It reads the row itself rather than accepting one.** A caller passing a stale
row could push a time Postgres has already moved past. Reading inside means the
calendar can only ever be told something that was true in the database.

**It returns early when Google is not in play.** No flag, no refresh token, no
calendar id — return, silently, having done nothing. ADR-0004: "Callzie must be
fully functional for a Business that never connects Google."

**A delete that 404s or 410s is a success.** Google's own guidance for the 410
case is "no further action is necessary". The goal is that the event is not on
the calendar, and it is not.

### The insert race, and the compare-and-set that settles it

Two syncs for the same Appointment could both read `google_event_id` as null and
both insert, leaving one event stored and one orphaned on the owner's calendar
forever.

The write-back is therefore conditional — the same shape `releaseAppointment` in
`lib/calls/record.ts` uses, with the guard inside the `WHERE` rather than in an
`if` before it:

```sql
UPDATE appointments SET google_event_id = $1
 WHERE id = $2 AND google_event_id IS NULL
RETURNING id
```

If that returns no row, another sync won. The loser deletes the event it just
created and re-reads. Losing is rare and cheap; an orphan on somebody's real
calendar is neither.

## Detection: one helper, two triggers

Detecting an overlap means asking Google what is on the calendar between two
instants. The naive version asks once per Appointment. This one takes the widest
window covering all of them, makes **a single `events.list` request**, and does
the matching in memory:

```
findOverlaps({ calendarId, accessToken, appointments, timezone })
```

**Push-time.** After an insert or a patch, the reconciler checks that one
Appointment. This is ADR-0004's second read, and it catches an owner event that
was already sitting there.

**On-screen.** Overview fires a Server Action that checks every upcoming
Slot-holding Appointment in one request. This is what catches an event added
after the booking, which push-time alone can never see.

**Why Overview and not Schedule.** Schedule is a pure Server Component with no
client JavaScript at all, and #18's design says to cut that screen if
interaction starts creeping in. Overview already has client components and a
~5s revalidation tick. Putting the trigger there costs nothing new; putting it
on Schedule would quietly undo a deliberate decision in somebody else's ticket.

### What counts as an overlap

1. **Not our own event** — match on `google_event_id`. Callzie cannot collide
   with itself anyway: `appointments_no_overlap` makes two overlapping Callzie
   Appointments impossible in Postgres, so anything left is somebody else's.
2. **Not cancelled** — free, `showDeleted` defaults to false.
3. **Not transparent** — `transparency === "transparent"` is ignored.
4. **All-day counts** — decision 5.

### The all-day problem, and the widened window

**Google does not document how a date-only event is compared against `timeMin`
and `timeMax`.** The parameter docs describe the filter purely in terms of an
event's start and end time and say nothing about how `"2026-08-25"` becomes an
instant. Presumably it is midnight in the calendar's zone, but presumption is
not verification, and decision 5 makes all-day events load-bearing.

So the design does not depend on it. **Every query asks for whole days**: from
midnight at the start of the earliest Appointment's day to midnight after the
latest, in the Business's timezone, built with `zonedTimeToInstant` and
`addCalendarDays` from `lib/time/zone.ts`. An all-day event on any day in range
is then unambiguously inside the window however Google resolves it, and
`overlap.ts` expands it to that day's midnight-to-midnight instants and does the
comparison itself.

**Both triggers do this, not just the re-check.** A push-time check for a
`14:00 → 14:45` Appointment asks Google for that whole day. If it asked only for
`14:00 → 14:45`, an all-day "Vacation" might not come back, and decision 5 says
it must. One rule for both callers, so there is no window size to remember.

Widening costs nothing — the same single request, returning a few more events
that are then filtered in memory.

`scripts/try-google.ts` settles the question empirically against a real
calendar, and the answer goes into `docs/verification.md`.

### Bounding the re-check

`lib/business/needs-attention.ts:17` leaves this ticket a note: `collision` is
the one reason not bounded by "how much has gone wrong", because one sync could
write many rows at once. It is bounded here rather than in that file.

The re-check considers Appointments that are **Slot-holding, in the future, and
starting within the next 14 days**, capped at 100 rows. One `events.list` call
covers all of them, well inside the 250-event default page size for any
realistic calendar. So a re-check costs one HTTP request regardless of how full
the calendar is, and the number of Collisions one re-check can raise has a
ceiling.

### Callzie never un-raises

If the owner deletes the conflicting event, the Collision stays until a human
clears it. SPEC.md §14 rule 3: "Never resolves a Collision. It detects, blocks,
and hands over."

### A failed push raises nothing

There are exactly four Needs Attention reasons and none of them is "the push
failed". A Google outage must not fill the surface with rows about Google. The
error is logged, the Appointment is untouched, and Callzie keeps booking.

## Making Clear stick

One new column on `appointments`:

```sql
ALTER TABLE appointments
  ADD COLUMN collision_event_ids text[] NOT NULL DEFAULT '{}';
```

It holds the Google event ids Callzie has already raised a Collision about for
this Appointment. The rule is a set subtraction: overlapping events found, minus
events already reported. Raise only if something is left, and append what was
left.

The demo, step by step:

1. Callzie books `14:00 → 14:45` and pushes it. Nothing else is there. No
   Collision.
2. The owner adds "Dentist" `14:30 → 15:00` in Google by hand.
3. The re-check finds `evt_dentist`. Not in the list. **Collision raised**,
   `evt_dentist` recorded.
4. The re-check runs again. Finds `evt_dentist`. Already recorded. **Nothing.**
5. The owner presses Clear. `needs_attention_reason` goes null; the id list is
   untouched.
6. The re-check runs again. Still nothing. **The clear holds.**
7. The owner adds a second conflicting event. New id. **Collision raised again**
   — correctly, because it is genuinely new.

Step 6 works precisely because `clearNeedsAttention` writes one column and this
is not it. That file's existing comment already insists clearing means "somebody
has seen this", not "this turned out to be fine".

**A Reschedule wipes the list.** A new time is a new question: events that
conflicted with `10:00` say nothing about `16:00`. The wipe happens in the same
`UPDATE` that moves the Appointment, so there is no window where the two
disagree.

**An Appointment already flagged for another reason is skipped entirely.** If it
is already `book_failed`, it is already blocked from calling, and overwriting
the label would lose why. The ids are **not** recorded in that case either —
otherwise clearing the `book_failed` would silently swallow a Collision that was
never shown to anyone.

## Losing access

Second column, on `businesses`:

```sql
ALTER TABLE businesses ADD COLUMN google_access_lost_at timestamptz;
```

When a refresh returns `invalid_grant`, `accessTokenFor` calls the existing
`clearGoogleConnection()` and stamps this. Settings then renders the ordinary
not-connected state plus one line: the connection expired or was revoked,
reconnect. `storeGoogleConnection()` clears the stamp on reconnect.

**A 500 does neither.** A transient Google failure must not destroy a working
credential. Only `invalid_grant` — the documented, definitive answer — clears
anything.

**Why a column and not a `GoogleStatus`.** Those ride on a query parameter from
the OAuth callback redirect. Lost access is discovered by a background push with
nobody watching, so there is no redirect to carry it.

This also closes the note left in `lib/google/connection.ts:180`: revocation
handling was "worth revisiting alongside issue #20, when there is a token
refresh path to hang it off". There now is.

## Where the sync is called from

| Trigger | File | Why |
|---|---|---|
| Quick-add, CSV upload | `app/(app)/actions.ts` | The two ways a human creates an Appointment |
| `book_slot`, `cancel_appointment` | `lib/tools/handle.ts` | The only two Tools that change a time or end an Appointment. `check_availability` and `confirm_appointment` change neither, so they push nothing |
| Decline | `lib/extraction/outcome.ts` | Already runs inside the webhook's `after()`, so it calls the sync directly |
| Re-check | `app/(app)/actions.ts` | The Server Action behind `collision-check.tsx` |

Onboarding's seeded Appointments (`lib/onboarding/create-business.ts:92`) push
nothing: they are written before any Business could have connected Google, and
the reconciler's early return covers them if one ever were.

The re-check action only calls `revalidatePath` when it actually wrote
something. A client component that fires on mount plus an unconditional
revalidate is a render loop; because a cleared Collision is never re-raised, a
second run writes nothing and the loop cannot start.

## The modules

### New

| File | Job |
|---|---|
| `lib/google/token.ts` | `accessTokenFor(businessId)` — decrypt, refresh, and turn `invalid_grant` into a lost connection |
| `lib/google/events.ts` | The four HTTP calls and nothing else. `fetchImpl` injected, matching `oauth.ts` |
| `lib/google/overlap.ts` | Pure. Google events plus Appointment windows in, overlapping ids out. All-day expansion lives here |
| `lib/google/sync.ts` | `syncAppointmentToGoogle(id)` — the reconciler, plus the push-time read |
| `lib/google/recheck.ts` | `recheckCollisions(businessId)` — the bounded, whole-day span read |
| `lib/google/collision.ts` | The set subtraction: raise, record ids, skip a row already flagged |
| `components/overview/collision-check.tsx` | Client. Fires the re-check once on mount |
| `drizzle/0004_google_collisions.sql` | The two columns |
| `scripts/try-google.ts` | Real-API smoke test, matching `try-tools` and `try-extraction` |

`overlap.ts` is separate from `events.ts` on purpose. The interesting rules —
touching edges, all-day, transparent, our own event — are arithmetic and
filtering with no network in them, and they should be testable without a fake
`fetch` in the way.

### Changed

| File | Change |
|---|---|
| `lib/db/schema.ts` | The two columns, and a note tying `collision_event_ids` to the clear |
| `app/(app)/actions.ts` | `after()` on quick-add and CSV; the re-check action; revalidate `/schedule` on clear |
| `lib/tools/handle.ts` | `after()` for the two Tools that change the calendar |
| `lib/extraction/outcome.ts` | Sync on the decline path |
| `lib/appointments/reschedule.ts` | Wipe `collision_event_ids` in the move |
| `app/(app)/page.tsx` | Mount `collision-check.tsx` |
| `components/settings/google-calendar-section.tsx` | The copy says events are not syncing. That stops being true. Plus the seven-day line and the lost-access line |
| `docs/verification.md` | The verified table above, and §13 item 4 answered |
| `package.json` | `try-google` |

## Testing

SPEC.md §3 rule 11 forbids real Calls in tests, and the same logic applies to a
third-party API that rate-limits and needs a real consent. Every test injects
`fetch`, the way `lib/google/oauth.test.ts` already does.

**`overlap.test.ts` — pure, no database, no fetch.** Touching at `09:45` is not
a collision. An all-day event is. A `transparent` event is not. An event with no
`transparency` field is, because the default is `opaque`. Our own
`google_event_id` is not. An all-day event whose `end.date` is exclusive covers
one day, not two. An empty calendar.

**`token.test.ts`.** A good refresh returns the access token. An `invalid_grant`
clears the connection and stamps `google_access_lost_at`. A 500 does neither. A
response with no `refresh_token` leaves the stored one alone.

**`sync.test.ts` — real Postgres from `vitest.globalSetup.ts`, faked Google.**
Each of the four rows of the reconciler table. Running it twice changes nothing
the second time. A 410 on delete is treated as success. The compare-and-set: a
simulated concurrent winner makes the loser delete its event. A Business with no
connection makes no HTTP call at all.

**`collision.test.ts` — real Postgres.** The seven-step walkthrough above, as
seven assertions. Plus: an Appointment already `book_failed` is skipped and its
id list stays empty.

**`recheck.test.ts`.** Bounding: an Appointment 20 days out is not considered. A
`cancelled` Appointment is not considered. Ten Appointments cost exactly one
`events.list` call. The window is widened to whole days in the Business's zone.

**`scripts/try-google.ts`** does what the suite deliberately cannot: proves a
real token refreshes, a real event appears, a real overlapping event is
detected, and — the open question above — whether a real all-day event comes
back from a partial-day window. Against the builder's own calendar, behind the
flag. Free; the Calendar API costs nothing.

## Acceptance criteria, mapped

| Criterion | Where it is met |
|---|---|
| Connecting Google is optional and everything works without it | The reconciler's early return; `googleCalendarConfigured()`; no Availability reader added. Already true today |
| A booking made in Callzie appears on the connected calendar | `sync.ts` insert, from four trigger points |
| A manually created overlapping Google event raises a Collision | `overlap.ts` + `collision.ts`, at push time and on the re-check |
| A Collision marks the Appointment as needing attention and blocks calling | `collision.ts` writes the column; #15's `start-web-call.ts:138` and `eligible.ts:40` already refuse |
| Nothing created in Google ever alters Callzie's Availability | Structural. Availability reads Postgres only (SPEC.md §6) and this design adds no writer to it |
| Token refresh works, and a revoked connection degrades to a designed state | `token.ts` + `google_access_lost_at` + the Settings copy |

## Out of scope

| Not here | Why |
|---|---|
| Bidirectional sync | ADR-0004 rejected it. Strictly additive, layerable later |
| Resolving a Collision | SPEC.md §14 rule 3. Callzie detects and hands over |
| Revoking the grant at Google on disconnect | `connection.ts:180`. Disconnecting must not depend on Google being reachable |
| Choosing a calendar other than the primary one | `fetchPrimaryCalendarId()` already picks it; a picker is not in SPEC.md §11.3 |
| OAuth verification, and leaving Testing status | Weeks of review for a sensitive scope. ADR-0004 ships behind a flag |
| The README limitation line | There is no README yet — it is M7. The sentence goes into the Settings copy now, where an owner will actually read it |

## Known limitations, stated deliberately

**Callzie detects Collisions; it does not prevent them.** ADR-0004 says this
belongs in the README as a stated design choice. Google Calendar permits
overlapping events and `events.insert` reports no conflict, so detection is a
deliberate second read and there is always a window between the two.

**The connection expires every seven days.** Testing status, verified above.
Callzie handles it as a designed state rather than an error, and the owner
reconnects. Leaving Testing means OAuth verification for a sensitive scope,
which ADR-0004 already declined.

**A crash between the Postgres commit and the push loses that push.** `after()`
gives no delivery guarantee. The Appointment is correct in Callzie and missing
from Google until the next sync for that row. An outbox table would close this
and was judged not worth the machinery for a flagged, single-account feature.

**The re-check only runs when somebody opens Overview.** A Collision created on
a calendar nobody is watching is detected the next time the owner looks. That is
the trade for having no cron.

**An in-flight Call is not interrupted.** If a re-check raises a Collision while
Maya is talking to that person, the Appointment becomes uncallable — but the
block is checked when a Call starts, not continuously, so the Call in progress
runs to its end.

**Detection is bounded to 14 days and 100 Appointments.** Something further out
is not checked until it comes into range.

**`events.patch` costs three quota units** where a `get` plus `update` would
cost two. Google says to prefer the latter. Patch is one round trip instead of
two and the daily quota is not remotely a constraint here, so the simpler code
wins.

## What was not verified

- **Whether an all-day event is returned by a partial-day `timeMin`/`timeMax`
  window.** Google publishes no statement. The design routes around it by
  querying whole days; `scripts/try-google.ts` settles it empirically and the
  answer goes into `docs/verification.md`.
- **The exact success status code for `events.delete`.** The docs say only
  "empty response body". The code treats any 2xx, plus 404 and 410, as success,
  so the exact number does not matter.
- **The `invalid_grant` body shape for the refresh grant specifically.** The 400
  status and the `error` field are documented for the same token endpoint under
  the device grant. Matching on `error === "invalid_grant"` is the safe read.
- **Whether `after()` reliably completes on Cloud Run under load.**
  `--no-cpu-throttling` is set, which is the documented requirement, and the
  Retell webhook already relies on it. Settled by watching logs after a real
  push.

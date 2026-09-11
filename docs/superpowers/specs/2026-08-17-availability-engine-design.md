# Design: the Availability engine and the no-overlap constraint

**Issue:** [#6](https://github.com/anushapundir/callzie/issues/6)
**Date:** 2026-08-17
**Status:** Approved, not yet implemented

## Summary

Build the Availability engine: given a Business and a Service, return the open
Slots. Then prove the database — not the application — is what stops two Calls
booking the same Slot.

Move the test suite onto a Postgres that runs on the developer's own machine, so
the suite needs no network and the `appointments_no_overlap` constraint can be
dropped and restored safely.

Nothing here touches a paid service. No Retell, no Anthropic, no telephony.

## What the issue asks for that is already done

Three of #6's assumptions were satisfied by earlier tickets. Recording them so
the plan does not redo them:

- **The constraint already exists.** `drizzle/0001_appointments_no_overlap.sql`,
  hand-written because Drizzle cannot express `EXCLUDE`, already carries the
  `declined`/`cancelled` exemption. Acceptance criteria 3 and 4 are about proving
  it holds, not adding it.
- **The test harness already exists.** #4 and #5 brought Vitest, `dotenv`
  loading, serial test files and the raised timeouts. The issue's line "this
  ticket also introduces the test harness" is stale.
- **The timezone arithmetic already exists.** `lib/time/zone.ts` (ADR-0007) was
  written anticipating this ticket — its own text says "#6 needs to own this
  arithmetic regardless" — and it already pins the DST semantics this engine
  depends on: an ambiguous wall clock resolves to the earlier instant, a
  nonexistent one shifts forward.

## Verified before designing

Run against a local Postgres 16.14, matching production's
`--database-version=POSTGRES_16` (`scripts/setup-infrastructure.sh:353`), using
the DDL from `drizzle/0001` verbatim:

```
PASS  CREATE EXTENSION btree_gist
PASS  EXCLUDE USING gist constraint accepted
PASS  overlap rejected — code=23P01 constraint=appointments_no_overlap
PASS  adjacent slot allowed (half-open range)
PASS  cancelled Appointment exempt from the constraint
PASS  without the constraint the overlap lands (test is sensitive)
```

Four facts the design rests on:

1. **`btree_gist` is available in the local binaries.** Without it there is no
   `EXCLUDE USING gist` and the ticket has no foundation.
2. **A rejection arrives as SQLSTATE `23P01` with `constraint` set to
   `appointments_no_overlap`.** That pair is how the booking path tells "someone
   else took this Slot" apart from a genuine database error — the distinction
   SPEC.md §8 is built on.
3. **Adjacent Slots do not collide.** `tstzrange` is half-open, so a 10:00–10:30
   Appointment leaves 10:30–11:00 bookable. Back-to-back Slots need no fencepost
   handling.
4. **Dropping the constraint does let a double-book through.** Acceptance
   criterion 4 is demonstrable, and it is demonstrable as an ordinary test.

## Part 1 — Postgres on the developer's machine

### The problem with the current harness

`vitest.setup.ts` requires `DATABASE_URL` and refuses to run without the Cloud
SQL Auth Proxy. Every query is a round trip to `us-central1`, which is why
`vitest.config.mts` had to raise the timeout to 30 seconds. This fails
acceptance criterion 6 — "the whole suite runs with no network access" — and it
means the database behind the live Cloud Run URL is the one under test.

That second point blocks acceptance criterion 4. Proving the concurrency test is
sensitive to the constraint means dropping `appointments_no_overlap`. Dropping it
on the shared instance opens a window where production can genuinely
double-book, and a crashed test run leaves it dropped.

### The decision

`embedded-postgres` as a dev dependency, pinned to `16.14.0-beta.17` to match
production's major version.

It vendors real Postgres binaries through npm. No Docker, no WSL, no installer,
no administrator rights, and no Windows service competing for port 5432 with the
Cloud SQL Auth Proxy. The version is pinned in `package.json` beside every other
dependency.

Rejected alternatives:

- **Docker.** Not installed, and neither is WSL, which Docker Desktop needs on
  Windows 11 Home. A reboot and a multi-gigabyte install to obtain a database
  that npm can already deliver.
- **A local Postgres install via `winget`.** Registers a Windows service on port
  5432, which is the port `scripts/setup-infrastructure.sh:395` tells the
  developer to run the Cloud SQL Auth Proxy on. Guaranteed collision.
- **PGlite.** Attractive — in-process WASM, no binaries. Not chosen because
  `btree_gist` support was unverified, and this ticket cannot proceed without it.
- **A second database on the existing Cloud SQL instance.** Makes dropping the
  constraint safe and costs nothing extra, but still needs the proxy, so
  acceptance criterion 6 stays unmet and the suite stays slow.

Two caveats, recorded rather than hidden: the package publishes only `-beta.N`
versions, and the binaries come from zonky's `embedded-postgres-binaries`, a
third-party build rather than postgresql.org. Pinned exactly, it is reproducible.

### How it wires in

A new `vitest.globalSetup.ts` runs once before any test file:

1. Start the cluster on port **55432** — deliberately not 5432, so it cannot
   collide with the Cloud SQL Auth Proxy if that happens to be running.
2. **Drop and recreate the `callzie_test` database.**
3. Apply `drizzle/` with `migrate()` from `drizzle-orm/node-postgres/migrator`,
   so the schema under test is the one that ships. Migration `0001` is in
   `drizzle/meta/_journal.json`, so the standard migrate path picks up the
   hand-written `EXCLUDE` constraint.
4. Overwrite `process.env.DATABASE_URL` to point at it.
5. Stop the cluster on teardown, leaving the data directory in place.

**The cluster is kept between runs; the database is not.** `initdb` — the
one-time step that creates a Postgres data directory — takes several seconds, and
paying that on every `npm test` is a tax on the fast feedback this ticket is
supposed to buy. So the data directory persists in `.pgdata/` and `initdb` runs
only when it is missing.

But the *database* is rebuilt from migrations every run, and that is not just
tidiness. The test for acceptance criterion 4 drops
`appointments_no_overlap`. If a run crashes between the drop and the restore, a
reused database would keep Drizzle's record of migration `0001` as already
applied, so the constraint would never come back — and every later run would pass
while silently testing a database with no no-overlap guarantee at all. Dropping
the database makes that failure impossible rather than unlikely.

Postgres will not drop a database you are connected to, so the drop is issued
from a client connected to the default `postgres` database.

One more detail with a visible effect: `embedded-postgres` defaults its `onLog`
to `console.log`, which prints every Postgres server line into the test output.
Pass a no-op so the suite stays readable.

Setting `DATABASE_URL` in `globalSetup` is what makes this safe by construction:
`lib/db/index.ts` reads the variable lazily, at first query rather than at
import, so the value written in `globalSetup` is the one every test connects
with. A developer with a real `DATABASE_URL` in `.env.local` cannot accidentally
point the suite at Cloud SQL.

Consequential detail: **the tests themselves do not change.** #4's and #5's
tests already delete the rows they write. They only need a different database
behind them.

`vitest.config.mts`'s 30-second timeout comes down, because its stated reason —
"every DB test here crosses the Cloud SQL Auth Proxy to a `db-f1-micro` in
us-central1" — stops being true. The comment must be rewritten, not just the
number; leaving it would describe a harness that no longer exists.

## Part 2 — The Availability engine

Two files, split so the hard part needs no database.

### `lib/availability/slots.ts` — pure

Takes Business Hours, a timezone, a duration, a window, the busy periods and the
current time. Returns the open Slots. No database, no clock of its own.

`now` is injected rather than read, following `lib/onboarding/seed-schedule.ts`,
whose comment gives the reason: otherwise correctness depends on the day the test
runs. The DST cases are the substance of this ticket and they must be assertable
without seeding a Business.

### `lib/availability/find.ts` — the database

Loads the Business's timezone and Business Hours, the Service's duration, and the
Appointments overlapping the window. Passes them to `slots.ts`.

Signature per the agreed shape — the caller supplies the window:

```ts
findAvailableSlots({ businessId, serviceId, from, to, now }): Promise<Slot[]>
```

The engine owns no policy about how far ahead to look. #10's
`check_availability` Tool decides that, and turns its optional `preferred_time`
argument into a window. This keeps the engine total and its tests free of a
lookahead constant.

### How candidate Slots are generated

Step equals the Service's duration, which is SPEC.md §6 read literally
("generate candidate Slots from `business_hours` [...] at the Service's
duration"). A 45-minute Haircut in a 09:00–17:00 salon yields 09:00, 09:45,
10:30, and so on. A candidate survives only if it ends at or before closing.

Accepted cost: an off-grid Appointment wastes a little bookable time. A booking
at 09:45 blocks the 09:45 candidate, and the 30 free minutes before it are never
offered. Acceptable because `check_availability` returns at most three Slots
(SPEC.md §7) — density is not the binding constraint.

Rejected: a fixed 15-minute grid, which introduces a granularity constant
SPEC.md never mentions; and gap-packing, which is denser but makes the same day
offer different times before and after a booking lands.

### The rule that makes clock changes come out right

**Convert the opening and closing wall-clock times to instants once, then step
forward in real milliseconds.** Do not step through wall-clock times and convert
each one.

Both produce identical results on the ~363 ordinary days a year. They diverge on
the two that matter:

- **Spring forward.** The clock jumps 02:00 → 03:00, so the day contains one
  hour less real time and yields correspondingly fewer Slots. That is the truth
  about the day, not a defect.
- **Stepping through wall clocks instead** would hit nonexistent times inside the
  gap. ADR-0007 resolves those forward, so two different wall-clock readings can
  map to the same instant — the engine would offer one Slot twice, or offer two
  that overlap. The database would then reject the second booking of a Slot the
  Agent had just offered aloud.
- **Autumn fall-back.** The day holds 25 real hours, so a window reading
  00:00–07:00 on the clock is eight hours long and yields eight Slots. Two of
  them read as "01:00" locally while being an hour apart in real time, and both
  are separately bookable. Converting wall clocks would have named only the
  first, because ADR-0007 takes the earlier instant for an ambiguous time — so
  real-time stepping is not just safer against the spring gap, it is the only one
  of the two that offers a fall-back day's full availability.
- **The one narrow limitation.** If `opens_at` or `closes_at` itself falls inside
  a transition — opening at 01:30 on a fall-back day, or 02:30 on a
  spring-forward day — ADR-0007's disambiguation applies to that single
  conversion and the window comes out an hour longer or shorter than the clock
  reads. Accepted: Businesses open at 09:00, and all four shipped Templates do.

This also matches how `lib/onboarding/seed-schedule.ts` already derives `endsAt`,
and for the same stated reason: an Appointment occupies real time, so a 90-minute
Colour across a spring-forward still takes 90 minutes even though the clock
advances 150.

The half-hour and quarter-hour offsets in the acceptance criteria — Asia/Kolkata
at +05:30, Asia/Kathmandu at +05:45 — need no special handling, because nothing
here performs hour arithmetic. `zonedTimeToInstant` carries them.

Overnight windows need no handling either: `lib/settings/hours-input.ts:126`
already rejects them with "must close after it opens — overnight hours are not
supported", so every weekday window is same-day.

### Which Appointments hold a Slot

The constraint's `WHERE (status NOT IN ('declined', 'cancelled'))` and the
engine's query must agree. If they drift, Availability offers a Slot the database
then refuses — or hides one it would have accepted.

So the set becomes a single named export in `lib/db/schema.ts`, used by both, with
a test that reads `drizzle/0001_appointments_no_overlap.sql` and asserts the two
still list the same statuses. A constant alone would not catch someone editing
the migration.

Note what this means for `unreachable`: it is **not** exempt, so an unanswered
Appointment keeps its Slot. That is SPEC.md §14 rule 2, and the migration's
comment already says so.

## Part 3 — The booking function

`lib/availability/book.ts` inserts the Appointment and translates a constraint
rejection into a value instead of an exception:

```ts
bookSlot({ businessId, serviceId, name, phoneE164, startsAt }):
  Promise<{ ok: true; appointment } | { ok: false; reason: "slot_taken" }>
```

It inspects the error for SQLSTATE `23P01` **and** constraint name
`appointments_no_overlap` — both, so a future exclusion constraint on another
table cannot be silently read as "Slot taken". Any other error propagates
unchanged; a broken connection is not a busy Slot.

`endsAt` is derived from the Service's duration inside this function, not
accepted from the caller. It is what the constraint compares, so letting a caller
supply it would let a caller defeat it.

This is the whole of #6's write path. #10 wraps it as an HTTP Tool endpoint and
adds no logic. The concurrency test therefore exercises the code production runs,
which was the point of building it here rather than writing raw inserts in a
test.

## Part 4 — The tests

| File | Needs a DB | Proves |
|---|---|---|
| `lib/availability/slots.test.ts` | no | Slots sit inside Business Hours, never in the past, skip busy periods, keep back-to-back Slots. Spring-forward yields one fewer Slot; fall-back offers the repeated hour once. +05:30 and +05:45 land correctly. |
| `lib/availability/find.test.ts` | yes | A `declined` or `cancelled` Appointment frees its Slot; every other status holds it. Availability never returns a Slot the constraint would reject. |
| `lib/availability/book.test.ts` | yes | Acceptance criteria 3 and 4. |
| `lib/db/schema.test.ts` (addition) | no | The Slot-holding status list matches the migration's `WHERE` clause. |

### The concurrency test

Three concurrent `bookSlot` calls at one Slot — three because SPEC.md §5 permits
three concurrent Calls. Exactly one returns `ok: true`; the other two return
`slot_taken`. Then the database is read back and holds exactly one Appointment
for that range.

`Promise.all` on three calls against one pool is genuine concurrency here: each
`INSERT` takes its own connection, and Postgres serialises them on the gist index
rather than the application ordering them. This is the same technique
`create-business.test.ts:182` already uses to race two onboarding submits.

### Proving the test tests the constraint

A second test drops `appointments_no_overlap`, fires the same three bookings, and
asserts **more than one** succeeds — the double-book, reproduced. It restores the
constraint in `afterEach` so ordering cannot leak into other files.

This is what acceptance criterion 4 asks for, as a test rather than a note in a
document. It is only safe because the cluster is local and disposable, which is
why Part 1 comes first in the plan.

One consequence to accept: this test writes overlapping rows, so its cleanup must
be thorough. It runs in its own file and `fileParallelism: false` already keeps
files serial.

## File-by-file changes

| File | Change |
|---|---|
| `package.json` | `embedded-postgres@16.14.0-beta.17` as a dev dependency. |
| `vitest.globalSetup.ts` | New. Boots the cluster, migrates, sets `DATABASE_URL`, tears down. |
| `vitest.config.mts` | Add `globalSetup`. Lower `testTimeout`/`hookTimeout` and rewrite the comment explaining them — its Cloud SQL reasoning no longer holds. |
| `vitest.setup.ts` | Stop throwing on a missing `DATABASE_URL`; `globalSetup` now provides it. Keep `dotenv` for other variables. |
| `.gitignore` | The cluster's data directory. |
| `lib/db/schema.ts` | Export the Slot-holding status list, with a comment tying it to migration `0001`. |
| `lib/db/schema.test.ts` | New — no test file exists for `schema.ts` today. Asserts that list still matches the migration file. |
| `lib/availability/slots.ts` | New. Pure Slot generation. |
| `lib/availability/find.ts` | New. Database reads plus composition. |
| `lib/availability/book.ts` | New. The write, with `23P01` translated to `slot_taken`. |
| `lib/availability/*.test.ts` | New. The three test files above. |
| `docs/adr/0010-availability-steps-in-real-time-not-wall-clock.md` | The real-milliseconds decision, the fall-back hour that goes unoffered, and the move to a local test Postgres. |
| `CONTEXT.md` | The `PENDING` block at the foot still tells readers not to use Availability, Slot, Service, Appointment or Reschedule. Both of its stated blockers have since resolved — the calendar-ownership boundary by ADR-0004, the role split by SPEC.md §14 rule 9 — and the terms are already defined above it and used throughout `lib/`. This ticket implements them, so the block is false and must go. |

## Out of scope

No HTTP endpoints, no Retell, no Agent, no UI. #10 builds the Tool endpoints on
top of `bookSlot` and `findAvailableSlots`.

No Google Calendar. Availability is computed entirely from Callzie's Postgres per
SPEC.md §6 and ADR-0003, which is what keeps `check_availability` fast enough to
avoid dead air mid-Call.

No CI wiring. The suite becoming network-free makes CI possible later; setting it
up is not this ticket.

## Known limitations, stated deliberately

1. **A window whose opening or closing time falls inside a DST transition comes
   out an hour off.** Opening at 01:30 on a fall-back day, or 02:30 on a
   spring-forward day. No shipped Template does this.
2. **Off-grid Appointments waste some bookable time**, because candidates step by
   the Service's duration from opening.
3. **The local Postgres is Postgres 16.14 from a third-party build.** Same major
   as production, not the same binary.

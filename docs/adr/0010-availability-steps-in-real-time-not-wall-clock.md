# ADR-0010: Availability steps in real time, and tests run on a local Postgres

**Status:** Accepted
**Date:** 2026-08-17
**Relates to:** SPEC.md §6, §3 rule 8, §14 rule 1; ADR-0007; issue #6

## Context

SPEC.md §6 requires candidate Slots generated "from `business_hours` in the
Business's timezone, at the Service's duration". Business Hours are wall-clock
times; Appointments are `timestamptz`. ADR-0007 built `lib/time/zone.ts` to cross
that line and anticipated this ticket leaning on it harder.

Two decisions about the engine had to be made that ADR-0007 did not settle, and
two more about how the engine is tested and how the database's refusal reaches
the caller.

## Decision 1: step in real milliseconds, not through wall-clock times

Convert each day's opening and closing wall clock to an instant once, then add
`durationMinutes` in milliseconds.

The rejected alternative — walking wall-clock times (09:00, 09:45, 10:30) and
converting each — gives identical results on ~363 days a year and is wrong on the
other two. Inside a spring-forward gap ADR-0007 resolves a nonexistent wall clock
*forward*, so two distinct wall clocks can map to the same instant. Availability
would offer one Slot twice, or offer two that overlap, and the database would
then reject a booking for a time Maya had just read aloud — SPEC.md §3 rule 7,
the most damaging failure available to this product.

Stepping in real time yields one fewer Slot on a spring-forward day, because the
day contains one hour less real time. That is a fact about the day.

This also matches `lib/onboarding/seed-schedule.ts`, which derives `endsAt` in
absolute milliseconds for the same stated reason: an Appointment occupies real
time.

### The fall-back day is the stronger argument, not the spring gap

Stepping in real milliseconds covers **both** passes through a repeated fall-back
hour. An autumn fall-back day holds 25 real hours, so a window reading 00:00–07:00
on the clock is eight real hours long and yields eight Slots. Two of them read as
"01:00" locally while being an hour apart in real time, and both are genuinely,
separately bookable — which is the truth about that day.

Converting wall clocks would have named only the first, because ADR-0007 resolves
an ambiguous wall clock to the earlier instant. So real-time stepping is not
merely safer against the spring-forward gap; it is the only one of the two that
offers a fall-back day's full availability. Asserted by "covers both passes
through a repeated fall-back hour" in `lib/availability/slots.test.ts`, which
pins all eight instants.

### Accepted limitation, narrow

The genuine limitation is narrower than the day. If `opens_at` or `closes_at`
*itself* falls inside a transition — a Business opening at 01:30 on a fall-back
day, or at 02:30 on a spring-forward day — ADR-0007's disambiguation applies to
that single conversion and the window comes out an hour longer or shorter than
the clock reads. Not worth a disambiguation parameter threaded through the
engine: Businesses open at 09:00, and the four shipped Templates all do.

## Decision 2: candidates step by the Service's duration

A 45-minute Haircut in a 09:00–17:00 salon yields 09:00, 09:45, 10:30. This is
SPEC.md §6 read literally.

Accepted cost: an off-grid Appointment wastes some bookable time — a 09:45
booking blocks the 09:45 candidate and the 30 free minutes before it are never
offered. Acceptable because `check_availability` returns at most three Slots
(SPEC.md §7), so density is not the binding constraint.

Rejected: a fixed 15-minute grid, which introduces a granularity constant
SPEC.md never mentions; and gap-packing, which is denser but makes the same day
offer different Slot times before and after a booking lands.

## Decision 3: the test suite runs Postgres locally

`embedded-postgres`, pinned to 16.14 to match production's `POSTGRES_16`, started
by `vitest.globalSetup.ts`.

Three reasons, in order of weight:

1. **The concurrency test has to be able to drop the constraint.** Proving the
   test is sensitive to `appointments_no_overlap` means removing it. Against the
   Cloud SQL instance that backs the live URL, that opens a window in which
   Callzie can genuinely double-book, and a crashed run leaves it open.
2. **Issue #6 requires the suite to run with no network access.**
3. **Speed.** A local round trip is sub-millisecond against tens of milliseconds
   through the Cloud SQL Auth Proxy, which is why the old timeouts were 30s.

Rejected: Docker (not installed, and needs WSL on Windows 11 Home); a `winget`
Postgres install (registers a service on 5432, colliding with the Cloud SQL Auth
Proxy that `scripts/setup-infrastructure.sh` tells the developer to run there);
PGlite (`btree_gist` support unverified, and the ticket cannot proceed without
it); a second database on the existing instance (safe for the constraint, but
still needs the proxy).

The cluster persists in `.pgdata/` so `initdb` is paid once, but the *database*
is dropped and re-migrated every run. That is a correctness requirement: if a run
died between dropping the constraint and restoring it, a reused database would
keep migration `0001` recorded as applied and the constraint would never come
back — every later run passing while testing a database with no no-overlap
guarantee.

This reverses decision 13 of `docs/verification.md` ("Don't run local Postgres"),
which is annotated there.

## Decision 4: `isSlotTaken` walks the error's `cause` chain

`lib/availability/book.ts` turns the constraint's refusal into
`{ ok: false, reason: "slot_taken" }` by matching SQLSTATE `23P01` **and** the
constraint name `appointments_no_overlap`. Both are checked, because the code
alone would also match a future exclusion constraint on some other table, and
reading that as "Slot taken" would make Maya offer an alternative time for a
problem that has nothing to do with the Slot.

The non-obvious part, and the reason this is recorded rather than left to the
code comment: **Drizzle does not rethrow the error `pg` raised.** Drizzle
0.45.2 wraps it in a `DrizzleQueryError` carrying the SQL and the parameters, and
hangs the original off `cause`. So `code` and `constraint` sit one level down. The
plan for this ticket specified a top-level-only check; that check never matched,
and every lost race was thrown at the caller as a hard failure instead of coming
back as an offer of another time — SPEC.md §3 rule 7's worst outcome, arrived at
by a detail of a dependency's error shape.

So the function walks `cause`, checking each level, with a fixed depth of three
so a cyclic `cause` cannot spin. Both the wrapped and the unwrapped shape match,
which means it keeps working if Drizzle ever stops wrapping.

This is a dependency on a library's internal error shape and it is not covered by
Drizzle's public API. It will break loudly rather than silently: the concurrency
tests in `lib/availability/book.test.ts` assert the losers come back as
`slot_taken` values, so a change in how Drizzle wraps errors fails the suite.

## Consequences

- Running the suite no longer needs the Cloud SQL Auth Proxy. `.env.local`'s
  `DATABASE_URL` is ignored by tests; `globalSetup` overwrites it.
- The local Postgres is a third-party build (zonky, via `embedded-postgres`) of
  the same major version as production, not the same binary.
- `embedded-postgres` publishes only `-beta.N` versions. Pinned exactly.
- CI becomes possible, since the suite has no external dependency. Not wired up.
- Upgrading `drizzle-orm` means re-reading Decision 4's assumption. The suite
  checks it, but only because those tests exist — nothing in the type system does.

## Revisit if

- `Temporal` lands in the deployed runtime. Decision 1 stays correct but could be
  expressed with explicit disambiguation, which would also fix the narrow case of
  a window opening or closing inside a transition.
- A Business asks for Slots at a finer granularity than its Service durations, at
  which point Decision 2's grid deserves reopening.
- Drizzle starts exposing the driver error directly, or gives
  `DrizzleQueryError` a typed accessor for the underlying `pg` error. Decision 4
  can then stop walking `cause` by hand.

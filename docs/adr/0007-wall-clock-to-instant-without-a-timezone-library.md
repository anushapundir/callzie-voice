# ADR-0007: Convert wall clock to instant with `Intl`, not a timezone library

**Status:** Accepted
**Date:** 2026-08-12
**Relates to:** SPEC.md §5, §6, §14 rule 1, issue #4

## Context

SPEC.md §5 splits time in two. Business Hours are stored as local wall-clock
times — `business_hours.opens_at` is a pg `time` — and "resolved against [the
Business timezone], never as absolute timestamps". Appointments are
`timestamptz`. Seeding a Business at onboarding has to cross that line: "the
clinic opens at 09:00" plus "the Business is in Asia/Kolkata" has to become an
instant.

The repo carries no date library, and #6's Availability engine will need the same
arithmetic on the hot path for every candidate Slot.

## Decision

Hand-roll it in `lib/time/zone.ts`, on `Intl.DateTimeFormat`.

The offset of a zone at an instant is derived rather than tabulated: format the
instant into the zone's wall clock, read that clock back as if it were UTC, and
the difference is the offset. `zonedTimeToInstant` inverts that by trying the
offsets in force either side of the target day and **verifying** each candidate
reads back as the requested wall clock.

## Rationale

Rejected alternatives:

- **`Temporal`.** The right tool, and the runtime does not have it. Not
  available in `node:22-alpine`.
- **`@date-fns/tz` / `date-fns-tz`.** Works, but it is a dependency whose entire
  value is the ~60 lines in `lib/time/zone.ts`, in a repo that has deliberately
  kept zero date libraries, and #6 needs to own this arithmetic regardless.
- **Dodging the problem** by seeding at `now + N hours` in absolute time.
  Rejected outright: the seeds would land outside Business Hours, contradicting
  SPEC.md §14 rule 1 in the product's own demo data, breaking the invariant #6
  is built on, and reading as "your 03:40 haircut" on the screen that is
  supposed to sell the product.
- **Whole-hour offset arithmetic.** Wrong for `Asia/Kolkata` (+05:30) — Callzie's
  first market — as well as `Asia/Kathmandu` (+05:45) and `Australia/Eucla`
  (+08:45). Nothing here rounds to hours.

**A single guess-and-correct pass is not enough**, which is worth recording
because it is the implementation most people reach for. Guessing the offset at
the target instant read as UTC, then correcting once, resolves a spring-forward
gap **backwards** (02:30 becomes 01:30 rather than 03:30) and picks the *later*
instant for an ambiguous time in a zone whose transition falls on the far side of
UTC midnight, such as `Pacific/Auckland`. Verifying candidates by reading them
back is what makes both cases come out right.

## DST semantics, chosen deliberately

These differ silently between implementations, so they are fixed here and
asserted in `lib/time/zone.test.ts`:

- **Ambiguous** wall clocks — the autumn hour that occurs twice — resolve to the
  **earlier** instant.
- **Nonexistent** wall clocks — the spring-forward hour that never occurs —
  shift **forward** by the transition delta.

This matches Temporal's `disambiguation: "compatible"`, so migrating to Temporal
later is a straight swap rather than a behaviour change.

## Timezone identity is a runtime property, not a constant

`Intl.supportedValuesOf("timeZone")` returns whatever that runtime's ICU build
considers canonical, **and builds disagree**. Node 22.14 on Windows lists
`Asia/Calcutta` and `Asia/Katmandu`; a newer ICU lists `Asia/Kolkata` and
`Asia/Kathmandu`. Callzie runs the browser's ICU on one side of the form and the
container's on the other.

So a submitted timezone is **not** validated by membership in the server's list.
Doing that would reject an Indian user's own timezone whenever the two builds
disagreed, with no way for them to proceed. `normalizeTimeZone` instead asks the
runtime to resolve the zone — which accepts canonical ids and link names alike,
and throws `RangeError` on anything else — and returns the runtime's own name for
it. That normalised value is what is stored, so `businesses.timezone` always
holds a spelling this deployment can resolve, and stays resolvable after an ICU
upgrade because the old name survives as a link.

`supportedValuesOf` is still used, but only to populate the picker's options.

## Consequences

- Callzie owns its DST edge-case semantics. They are documented above and pinned
  by tests; #6 will lean on them harder than #4 does.
- **Correctness depends on the runtime's ICU data.** A small-icu build has no
  timezone catalogue at all, and the failure is invisible until deploy: the
  picker renders empty in production while working locally.
  `lib/time/timezones.test.ts` asserts a full-size catalogue as a canary, and the
  runtime image should be checked directly:
  ```
  docker run --rm --entrypoint node <image> -p "Intl.supportedValuesOf('timeZone').length"
  ```
  If that is small, add `icu-data-full` to the runner stage or move to
  `node:22-slim`.
- `Intl.DateTimeFormat` instances are cached per zone for the life of the
  process. Construction is the expensive part and #6 will call these per Slot;
  the key space is bounded by the IANA catalogue, so the cache cannot grow
  without bound.
- Business Hours remain wall-clock in the database. Nothing in this ADR changes
  what is stored — only how it is read.

## Revisit if

- `Temporal` becomes available in the deployed runtime. The swap is mechanical
  and the semantics already match.
- Something needs a timezone from outside the picker — an import, a public API —
  at which point "accept anything the runtime resolves" deserves a second look
  against whatever that source guarantees.

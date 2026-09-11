# Design: Schedule — read-only day view

**Issue:** [#18](https://github.com/anushapundir/callzie/issues/18)
**Date:** 2026-08-19
**Status:** Implemented. See `docs/superpowers/plans/2026-08-19-schedule-read-only-day-view.md`

## Summary

`/schedule` shows one day as a vertical column of time. Business Hours are the
shape of the day, Appointments are blocks placed inside it by start time and
duration, and a Collision is marked on the block it belongs to.

It is deliberately inert. The only interactive elements on the page are three
links that change the day. Nothing is draggable, nothing is clickable to book.
SPEC.md §11.3 says that if this screen starts growing interaction it should be
cut, because it competes with the Needs Attention surface (#15) — so the design
below spends its effort on being correct and legible, not on being clever.

Three things this design is careful about:

**No Service is chosen anywhere.** A Slot's size is a Service's duration, and a
Business can hold several Services with different durations. Any grid built out
of one Service's Slots misrepresents every other Service. So the axis is plain
hour gridlines and blocks are positioned proportionally.

**The database keeps guaranteeing that blocks cannot overlap.** The view loads
only the statuses that hold their Slot — the same list the
`appointments_no_overlap` constraint uses. That is what removes the need for
side-by-side lane layout entirely.

**Nothing rounds to whole hours in the wrong direction.** Rounding the window
outward can only ever widen it. On a spring-forward morning, rounding 02:30 down
to 02:00 lands in the DST gap, where ADR-0007 resolves *forward* to 03:00 — later
than where we started, which would clip a real Appointment off the top of the
day.

## What #18 does not own

| Surface | Issue |
|---|---|
| Detecting Collisions against Google Calendar, and writing `needs_attention_reason = 'collision'` | #20 |
| The Needs Attention triage surface | #15 |
| `/calls/[id]`, the Call detail screen | #16 |

#20 is the important one. Collision detection **does not exist yet** — nothing in
the codebase writes `needs_attention_reason = 'collision'` today. This design
reads the column and renders the marker anyway, so #20 lights the marker up by
writing one value and changes nothing on this screen.

## Decisions

Four questions were settled before any code was designed.

**1. The time axis is hour gridlines, not Slot rows.** The day is one continuous
column from the window's start to its end, marked every hour. Each Appointment's
block takes its top and height from its own start and duration. Gaps are just
empty space — visible as free time without claiming to be a bookable Slot for
any particular Service.

Rejected: one row per Slot of a chosen Service (needs a Service picker, which is
interaction the issue warns against, and a 30-minute Haircut lines up with no
45-minute Cleaning row). Rejected: a grid stepped at the shortest Service
duration (a 45-minute Appointment still straddles a 30-minute row, so the
"blocks fill whole rows" promise breaks anyway).

**2. The day lives in the URL.** `/schedule?date=2026-08-19`, with Prev / Today /
Next as ordinary links. The page stays a Server Component with zero client
JavaScript, and a day is shareable and bookmarkable. No `?date` means today **in
the Business's timezone**, never the viewer's browser clock. Navigation is not
booking, so the read-only rule holds.

Rejected: a `<input type="date">` (needs `"use client"` and hydration on an
otherwise static screen). Rejected: today-only (seeded Appointments land on
future days and would be invisible).

**3. Collisions render from `needs_attention_reason`.** Only that one reason. The
other three — `book_failed`, `negotiation_truncated`, `unreachable` — are not
marked here, because marking them would turn this screen into a second triage
queue and #15 owns that surface.

**4. Only Slot-holding Appointments appear.** `pending`, `calling`, `confirmed`,
`rescheduled`, `unreachable`. Not `declined`, not `cancelled` — those free their
Slot, so the time really is free and should look free.

This is not only a display decision. Freed Appointments can legally be booked
over, so showing them would put two blocks in the same minutes and force
lane-splitting layout. Excluding them makes the `appointments_no_overlap`
constraint guarantee that no two blocks ever overlap, and the layout code never
has to consider the case.

## Architecture

The repo's existing shape, followed exactly: a pure core with no clock and no
database, a thin loader that feeds it, and components that only render.

```
lib/schedule/day-layout.ts    pure — positions, gridlines, window
lib/schedule/day-param.ts     pure — ?date parsing
lib/schedule/load-day.ts      two queries, then calls the core
app/(app)/schedule/page.tsx   Server Component, no client JS
components/schedule/*         render only
```

`lib/availability/slots.ts` is a pure core with `now` injected and
`lib/availability/find.ts` is its loader. This mirrors that pair. The reason is
the same one that file gives: the DST cases are the substance of the module and
they have to be assertable without seeding a Business.

Rejected: computing positions inside the page component (the maths would only be
reachable through a Server Component, so testing it means rendering React and
seeding Postgres, and the DST cases would go untested). Rejected: a Client
Component using CSS grid rows (needs a timezone-aware clock on the client, and
the day would risk rendering as the viewer's date rather than the Business's —
`components/overview/appointments-table.tsx` is a server component for exactly
this reason).

## The pure core — `lib/schedule/day-layout.ts`

**In:** the chosen civil date, the IANA timezone, that weekday's Business Hours
window or `null` if closed, and the day's Appointments as instants.

**Out:** the window's start and end instants, the window's length in minutes, the
hour gridlines with their labels and positions, each block's top and height as
percentages, and the bands that fall outside Business Hours.

Four rules:

**The window stretches to cover everything.** It starts at the earlier of the
opening instant and the first Appointment's start, and ends at the later of the
closing instant and the last Appointment's end. On a closed day with
Appointments, only the Appointments define it. On a closed day with none, there
is no window and the caller renders the closed card instead.

**Rounding outward can only widen.** Both ends round to a whole wall-clock hour
so gridlines read as round numbers. The rounded start is taken as
`min(original, rounded)` and the rounded end as `max(original, rounded)`. Without
that guard, a spring-forward morning breaks: 02:30 rounded down to 02:00 is a
wall clock that never happens, ADR-0007 shifts it forward to 03:00, and the
window would start *after* the Appointment it was supposed to contain.

**Gridlines step in real milliseconds.** One hour at a time from the window
start, each labelled by reading the wall clock at that instant. Same rule as
`slots.ts`, same reason. Consequences, both correct:

- A spring-forward day has no `02:00` line. The hour did not happen.
- A fall-back day has two lines both reading `01:00`, a full row apart on
  screen. The hour happened twice.

**Positions are percentages of the window.** `top = (startsAt − windowStart) /
windowLength`, `height = duration / windowLength`, both clamped so a block can
never render above the top or below the bottom. Percentages rather than pixels
keeps the core free of visual units; the component turns the window's length into
a pixel height at 64px per hour.

## The loader — `lib/schedule/load-day.ts`

Two queries.

**Business Hours** for that one weekday, or nothing if the Business is closed
then. Normalised through `toWallTime`, because `pg` renders a `time` column as
`"09:00:00"` and the pure core expects `"09:00"`.

**Appointments overlapping that civil day** — midnight to midnight in the
Business's own timezone, via `zonedTimeToInstant`. That is a superset of anything
the stretched window can reach, which resolves the ordering problem: the window
depends on the Appointments, so the Appointments cannot be queried using the
window.

The status filter imports `SLOT_HOLDING_STATUSES` from `lib/db/schema.ts` rather
than re-listing the five statuses. That constant is already kept in step with the
`appointments_no_overlap` migration by `lib/db/schema.test.ts`. A second copy of
the list is precisely the drift that file exists to prevent.

The query joins `services` for the Service name and selects
`needs_attention_reason`, which is how a Collision reaches the screen.

`listAppointments` is deliberately not reused: it is capped at 20 rows, has no
date filter, and does not carry the attention reason. Widening it would make
Overview pay for a column it never renders.

## `?date` parsing — `lib/schedule/day-param.ts`

Pure, so it is testable without a page.

Strict `YYYY-MM-DD`, and the parse round-trips: `2026-02-30` is well-formed but
`Date.UTC(2026, 1, 30)` silently rolls it to March 2, so the parser reads its own
output back and rejects anything that moved.

Anything rejected — malformed, impossible, absent, or an array of values — becomes
today in the Business's timezone. A bad URL is not an error page.

Prev and Next are `addCalendarDays(date, ±1)`, which is civil arithmetic with no
zone involved. Counting in absolute milliseconds would land on the wrong date
across a DST transition.

## The screen

`app/(app)/schedule/page.tsx` reads `searchParams` the way
`app/(app)/settings/page.tsx` already does: `PageProps<"/schedule">`, `await
searchParams`, and the same small guard against a `string[]` value.

**Header.** Prev / Today / Next on the left, the day on the right — "Wed 19 Aug
2026", then "Open 09:00 – 17:00" or "Closed".

**Column.** A 56px mono gutter of hour labels on the left. To its right the track,
64px per hour, with an absolutely-positioned block per Appointment.

**Block.** Two lines, and which fact goes on which line is a real decision,
because a block clips rather than grows — letting one push its neighbours down
would put the whole column out of step with the hour labels beside it.

- **Line one is who and when**: the name, the status word, and `09:00–09:45` in
  mono. A 15-minute Appointment is only 16px tall at 64px an hour, which is less
  than one line of text once the border and padding come off, so the block
  carries a 24px floor (`min-h-6`) that guarantees this line always renders in
  full. A short block then overhangs the following few minutes by a few pixels.
  That is the right trade: an unreadable block is worth nothing.
- **Line two is the extras**: the Service, and any marker. This is the first
  thing clipped, and nothing on it is needed to identify the booking.

A 3px left bar carries the Appointment's status colour. The status *word* rides
on line one specifically so it cannot be clipped away and leave the colour
speaking alone. A collided Appointment takes the amber `attention` border and a
"Collision" marker; one outside opening hours gets a muted "Outside hours".

Every colour is an existing token in `app/globals.css`. The `--color-*: initial`
reset in that file means an off-token colour does not compile, so this is
enforced at build time rather than in review.

### Components

| File | Does |
|---|---|
| `components/schedule/day-nav.tsx` | The three links and the day heading |
| `components/schedule/day-grid.tsx` | The track, the hour gutter, the shaded bands |
| `components/schedule/appointment-block.tsx` | One block |
| `components/schedule/closed-day.tsx` | The card a shut, empty day renders instead of a grid |

### One change to existing code

`STATUS_STYLES` currently lives inside `components/overview/status-pill.tsx`. The
block needs the same seven colours for its left bar, so the map moves to
`lib/appointments/status-style.ts` and both read it.

Two screens deriving the same colours independently is how `cancelled` ends up
slate on one and red on the other. That file's own comment already records that
`pending` and `cancelled` were decided once so nobody re-derives them — this
makes the decision reachable from the second screen that needs it.

The map holds literal Tailwind class strings, which is what keeps the scanner
able to see them.

## Edge cases

| Case | What renders |
|---|---|
| Open day, Appointments | The grid |
| Open day, nothing booked | The grid still renders, hour lines and all, plus a quiet "No appointments." The shape of the day is the information |
| Closed day, nothing booked | No grid. "Closed on Sundays. No appointments." |
| Closed day, something booked | The grid over the Appointments' own hours, fully shaded, header reads "Closed · 1 appointment" |
| Appointment outside opening hours | Window stretches, that band is shaded, block carries "Outside hours" |
| `?date=banana`, `?date=2026-02-30`, no `?date` | Today, in the Business's timezone |
| Spring-forward day | No `02:00` gridline; window rounding cannot narrow |
| Fall-back day | Two `01:00` gridlines, an hour apart |
| Appointment crossing midnight | Appears whole on both days; each day's window stretches to hold it |

Business Hours can be narrowed after Appointments are booked —
`lib/settings/hours-conflicts.ts` exists because Settings only warns about that,
it does not move or refuse the Appointments. So an Appointment outside opening
hours is an ordinary state, not a corruption, and the grid must show it in place.

### Not built

A "now" line across the grid. It would need a Client Component and a ticking
clock to stay honest, and it is in neither the issue nor SPEC.md §11.3.

## 375px

The gutter is 56px, blocks take the rest, and the column scrolls vertically. The
page never scrolls horizontally.

A block clips rather than grows, with the 24px floor described above keeping its
first line readable however short the Appointment. Line two — the Service and any
marker — is what gets clipped.

## Testing

The pure core carries the weight, because that is where every hard case lives.

**`lib/schedule/day-layout.test.ts`** — pure, no database:

- ordinary day: block tops and heights against known percentages
- an Appointment before opening stretches the window and is shaded
- a closed day with Appointments produces a window from the Appointments alone
- a closed day with none produces no window
- **spring-forward**: the window start is never later than the earliest
  Appointment, and no `02:00` gridline exists
- **fall-back**: two gridlines read `01:00`, one real hour apart
- Asia/Kolkata `+05:30`: the window rounds to whole hours on the Business's own
  clock, which are half hours in UTC. Nothing anywhere rounds a UTC instant
- clamping: a block can never exceed the window

**`lib/schedule/day-param.test.ts`** — pure: valid dates, malformed strings,
`2026-02-30`, an array value, and a missing param.

**`lib/schedule/load-day.test.ts`** — database-backed, following
`lib/business/list-appointments.test.ts`: only that day's Appointments come back;
`declined` and `cancelled` are absent; `needs_attention_reason` is carried
through; another Business's Appointments never appear.

## Acceptance criteria mapped

| #18 criterion | Where it is met |
|---|---|
| A chosen day renders Business Hours with Appointments positioned by time and duration | `day-layout.ts` window and block percentages; `day-grid.tsx` |
| Appointment blocks carry the status colours and are readable at a glance | `lib/appointments/status-style.ts` shared with `StatusPill` |
| Days outside Business Hours, and empty days, render sensibly | The edge case table above |
| It is genuinely read-only — nothing draggable or clickable-to-book | The only interactive elements are three `<Link>`s |
| It holds up at 375px | 56px gutter, vertical scroll only, block text clips |

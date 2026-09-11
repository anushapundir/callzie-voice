# Design: Appointments — quick-add, list and seeded demo data

**Issue:** [#7](https://github.com/anushapundir/callzie/issues/7)
**Date:** 2026-08-17
**Status:** Implemented. See `docs/superpowers/plans/2026-08-17-appointments-quick-add.md`

## Summary

Make Appointments real and visible on Overview. Add one by hand from a card that
offers only times Availability actually has open, and see it land in a table
that carries its status, its attempts and a link to its last Call.

Two things this design is careful about:

**The database stays the only judge of "that Slot is taken."** #6 put that
guarantee in an `EXCLUDE` constraint on purpose. Nothing here asks the same
question in application code, because a second answer is a second place to
delete.

**Nothing is re-seeded.** Onboarding already writes five example Appointments in
the same transaction as the `businesses` row. A second seed would collide with
`appointments_no_overlap`.

## What the issue asks for that is already done

Two of #7's acceptance criteria were satisfied by #4.

- **"A brand-new account sees seeded Appointments."** `lib/onboarding/templates.ts`
  → `lib/onboarding/seed-schedule.ts` writes five Appointments per Business Type
  inside the Business's own transaction. The placement rules — next open days
  strictly after today in the Business's timezone, inside Business Hours,
  guaranteed non-overlapping — are pinned by `lib/onboarding/seed-schedule.test.ts`
  across four Templates × seven timezones. That test is the contract. This work
  does not touch it, and adds no "seed demo data" action.

- **A minimal Overview read exists.** `app/(app)/page.tsx` renders
  `components/overview/appointments-list.tsx` — Name · Phone · Service · Time ·
  a plain status word. #7 replaces it.

Two facts about the seed that constrain what is built here:

- **Seeded phone numbers use the reserved fictional `+1 202 555 01xx` range.**
  #11 and #19 will eventually point a real dialler at exactly these rows. The
  E.164 validator must accept this shape without special-casing it.
- **Seeded statuses are four `pending` and one `confirmed`, with no
  `needs_attention_reason`.** So a fresh account's stat strip reads Total 5,
  Confirmed 1, Needs attention 0. That is correct, not a bug — the Needs
  Attention surface belongs to #15, and a fabricated reason would be a lie the
  product then has to explain.

## What #7 does not own

SPEC.md §11.3 describes the whole Overview screen. Most of it belongs elsewhere:

| Surface | Issue |
|---|---|
| CSV upload with per-row errors | #8 |
| Call all, throttling, retry | #17 |
| The Needs Attention section | #15 |
| `/calls/[id]`, the Call detail screen | #16 |
| Placing an actual Web Call | #11 |
| Revalidating every ~5s while a Call is live | #11 |

So the accent button on the Quick Call card creates an Appointment and stops
there, and the last-Call column renders as text rather than a link until #16
builds the route to link to.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| How is the time chosen? | A dropdown of real open Slots, computed by #6's engine. Not a free-text time. |
| What does the accent button say today? | "Add appointment". #11 renames it to "Call now" and chains the dial onto the same submit. A button must not name something it does not do. |
| What is "Answer rate"? | Answered Calls ÷ Calls placed, counted on `calls`. `null` — rendered "—" — until a first Call exists. |
| What do the stat tiles count? | Every Appointment for the Business, not only future ones. |
| Phone validation library? | None. Hand-written, matching `lib/onboarding/input.ts` and `lib/settings/services-input.ts`. |

## Part 1 — Who decides a Slot is taken

This is the load-bearing part of the design.

### The trap

The obvious shape for "refuse with a clear reason, not a generic error" is to
look before booking: check whether the Slot is free, and if it is not, say so.

That check would be a second answer to a question the database already answers.
`bookSlot()` in `lib/availability/book.ts` deliberately does not look before it
inserts, and its own comment says why: SPEC.md §5 permits three concurrent
Agents, and three check-then-write sequences find any gap between the read and
the write. The `appointments_no_overlap` constraint closes that gap because
Postgres serialises the contending inserts on its gist index.

Add a check in front of it and two things go wrong. The check is useless — it
cannot prevent the race it appears to prevent. Worse, it makes the constraint
look redundant, and the next person to read the file deletes the "slow" branch
that handles the insert failing.

### The split

The question "can this Appointment be created here?" is two questions with two
different owners.

**"Is the Business open then, and is the time still ahead?"** Postgres cannot
answer this. `appointments_no_overlap` compares time ranges and knows nothing
about `business_hours`. So application code must answer it, and there is no
constraint for it to undermine.

**"Is another Appointment already sitting there?"** Only the database can answer
this correctly. Application code never asks.

### The shape that follows

```
createAppointment()
  1. slotIsOffered()  →  "not_offered" | "in_the_past"  →  refuse, with the reason
  2. bookSlot()       →  { ok: false, reason: "slot_taken" }  →  refuse, with the reason
  3. bookSlot()       →  { ok: true, appointment }  →  done
```

Step 2's refusal is the *only* source of "that time is taken". It arrives
because Postgres rejected the insert, exactly as #6 built it.

`slotIsOffered()` calls `openSlots()` with `busy: []`. Passing real Appointments
into it is now visibly wrong rather than a subtle mistake, because the function's
whole purpose is to ignore them.

### Why this survives a future editor

Before the split, two code paths could both report "occupied", so deleting the
slower one reads as a cleanup. That is how a constraint gets orphaned.

After the split there is one path. Nothing to delete and nothing to prefer.
Reintroducing the bug would mean *adding* an overlap query, which is a decision
someone has to argue for rather than a tidy-up.

## Part 2 — New and changed modules

### `lib/appointments/phone.ts` — new

```ts
export type ParsedPhone =
  | { ok: true; value: string }
  | { ok: false; error: string }

export function parseE164(raw: string): ParsedPhone
```

Strips spaces, dashes, dots and brackets, then requires:

- a leading `+`
- a first digit of 1–9, never 0
- 8 to 15 digits in total, which is the E.164 length range

`+1 202 555 0142` → `+12025550142`. `9820012345` is refused with "Start with the
country code, like +44 or +91."

**No country inference, deliberately.** `businesses` carries an IANA timezone and
no country column, so there is nothing to anchor a national-format parse to.
Requiring the `+` is forced by the data model, not a shortcut.

**This is shape validation, not existence validation.** It cannot tell you a
number is reachable. SPEC.md §3 rule 10 asks for E.164 storage and a per-field
rejection reason, and that is what this provides. #8 reuses it per CSV row.

### `lib/appointments/quick-add-input.ts` — new

Follows `lib/settings/services-input.ts` exactly: a `parse*` function returning a
discriminated result, plus the state types and `INITIAL_QUICK_ADD_STATE`. These
live here rather than in the action because a `"use server"` module may only
export async functions.

```ts
export type QuickAddErrors = {
  name?: string
  phone?: string
  serviceId?: string
  startsAt?: string
  form?: string
}

export type QuickAddState = {
  errors?: QuickAddErrors
  values?: QuickAddValues   // echoed back so a rejected submit repopulates
  added?: { name: string; startsAt: string }
}
```

All four fields are reported at once. A form with two problems must not take two
round trips to fix.

`serviceId` and `startsAt` arrive as opaque strings. `startsAt` is parsed as an
ISO instant — the option values the picker renders are ISO strings, and anything
else is a field error, not a 500. Whether the Service belongs to this Business is
settled against the database, never here.

### `lib/availability/find.ts` — refactor only

Extract the three reads that define a Business's schedule — timezone, Service
duration, and Business Hours — into a loader the new `slotIsOffered` shares.

The fourth read, busy Appointments, stays inside `findAvailableSlots` and is
deliberately **not** part of the shared loader. `slotIsOffered` has no use for it
and must not acquire one; see Part 1.

`findAvailableSlots`'s behaviour does not change, and its existing tests must
pass untouched.

### `lib/availability/offered.ts` — new

```ts
export type SlotOffer = "offered" | "not_offered" | "in_the_past"

export function slotIsOffered(input: {
  businessId: string
  serviceId: string
  startsAt: Date
  now?: Date
}): Promise<SlotOffer>
```

Generates candidate Slots for a one-Slot window around `startsAt` with `busy: []`
and asks whether one begins at exactly that instant. If none does, `startsAt <
now` separates "already passed" from "you are closed then".

`now` is injected rather than read, matching `slots.ts` and `seed-schedule.ts` —
otherwise correctness depends on the day the test runs.

### `lib/appointments/create.ts` — new

```ts
export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "not_offered" | "in_the_past" | "slot_taken" }
```

The three-step flow from Part 1. It is a thin function on purpose: the two
interesting behaviours already live in `slotIsOffered` and `bookSlot`, and this
is the seam that names their refusals.

### `lib/business/list-appointments.ts` — changed

- `listUpcomingAppointments` → **`listAppointments`**. The function has no time
  filter and never had one, so the old name described behaviour it did not have.
  Two call sites: `app/(app)/page.tsx` and `app/(app)/settings/actions.ts`.
- `AppointmentRow` gains `attempts: number` and `lastCallId: string | null`.
- The explicit `innerJoin` stays. No `relations()` are declared anywhere in this
  repo, and adding them is a schema-wide convention change that deserves its own
  decision rather than a drive-by in a feature ticket.

**Calls are loaded in a second query and folded in with JavaScript**, not a
lateral join or a window function. `businesses.call_quota` defaults to 5, so an
account holds at most five `calls` rows in total. "Load every Call for these
Appointments" is bounded by the quota, and a `DISTINCT ON` would be more SQL to
read for no measurable gain.

### `lib/business/appointment-stats.ts` — new

```ts
export type AppointmentStats = {
  total: number
  confirmed: number
  needsAttention: number
  /** null when no Call has been placed — rendered "—", never 0%. */
  answerRate: number | null
}
```

Two aggregates. One over `appointments` for the first three counts;
`needsAttention` counts rows where `needs_attention_reason IS NOT NULL`, because
§5 makes the reason orthogonal to `status` rather than a value of it. One over
`calls` for the rate: `completed` over every Call that has left `queued`.

A fresh account has no Calls at all, so `answerRate` is `null` and the tile reads
"—". Rendering 0% would claim a dialler had tried and failed.

## Part 3 — The Server Actions

New file `app/(app)/actions.ts`, following the three rules
`app/(app)/settings/actions.ts` already documents: `requireBusiness()` first
always, nothing closes over anything, and a rejected write returns state rather
than throwing.

### `addAppointmentAction(previous, formData)`

`requireBusiness()` → `parseQuickAddInput` → `createAppointment` →
`revalidatePath("/")`.

That last call is the whole of "appears in the table without a manual refresh".
Next re-runs the page's Server Component once the action resolves, so the table,
the stat strip and the Slot options all come back fresh together. No polling, no
client-side cache to reconcile.

Three refusals, each naming the actual problem rather than a generic error:

| Reason | Message | Placed on |
|---|---|---|
| `not_offered` | "That is not a time you can book. Pick one from the list." | the time field |
| `in_the_past` | "That time has already passed." | the time field |
| `slot_taken` | "Someone just booked that time. Pick another." | the time field |

`slot_taken` is worded for the race it describes. Because the picker only ever
offers open Slots, the ordinary way to see it is that someone else booked the
same Slot between the page rendering and the submit.

### `slotOptionsAction(serviceId)`

A read. `requireBusiness()`, then `findAvailableSlots` for that Service over a
fixed horizon, returned as `{ value: ISO string, label: "Tue 18 Aug, 09:30" }`.

**Horizon: 14 days, capped at 50 options.** Long enough that a Business closed
several days a week still has something to offer; short enough that the query
and the `<select>` stay small. The cap is a `<select>` that stays usable, not a
correctness bound.

**Why an action rather than loading every Service's Slots up front.** Slot size
is the Service duration, so a Service's Slots cannot be reused for another one.
Settings lets a Business add Services without limit, so pre-computing all of them
makes page load cost scale with the Service count. One Availability run per page
load and one per Service change does not.

**Why not a `?service=` URL parameter.** It keeps everything server-rendered,
which is attractive, but the navigation risks discarding the name and phone
already typed into the card. Losing typed input to a dropdown change is the worst
possible behaviour on the screen the demo runs on.

## Part 4 — The screen

`components/overview/appointments-list.tsx` is deleted. Four files replace it.

### `stat-strip.tsx` — Server Component

Four tiles: Total · Confirmed · Needs attention · Answer rate. Numbers in mono
per §11.2. Needs attention renders in the `attention` token when non-zero and in
`text-muted` at zero, so an empty count does not read as an alarm.

### `quick-call-card.tsx` — the only Client Component

Accent border, per §11.3 — it is the demo path and should look like it.

Name · Phone · Service (`<select>`) · Time (`<select>` of open Slots) · one
accent "Add appointment" button.

- `useActionState` for the submit, matching `services-section.tsx`.
- The button carries its own spinner. §11.4 rules out a full-page blocker.
- Changing the Service calls `slotOptionsAction` inside `useTransition`; the time
  field is disabled and reads "Loading times…" while it runs.
- Field errors render through `FieldError`, tied to their input with
  `aria-describedby` and `aria-invalid`.
- A success renders an inline line — "Added Priya Sharma, Tue 18 Aug 09:30" —
  and clears the fields. Inline rather than a toast, because the row it refers to
  has just moved somewhere in a twenty-row table.

**No `window.confirm`, no browser dialog**, following the line
`services-section.tsx` already holds: it blocks the thread, cannot be styled to
§11.2, and is unreachable from a test.

### `appointments-table.tsx` — Server Component

Name · Phone (mono) · Service · Time (mono) · Status pill · Attempts · Last Call.
Table above `md`, stacked cards below, per §11.4's 375px floor.

A **Server** Component on purpose, as the file it replaces already was: every
time is formatted in the Business's own timezone, so formatting on the server
means one `Intl` pass and no hydration mismatch between the viewer's clock and
the Business's.

Attempts renders as "—" at zero rather than "0", which reads as a failed attempt.
Last Call renders the Call's timestamp as plain text; #16 turns it into a link to
`/calls/[id]` once that route exists. A link to a 404 is worse than no link.

### `status-pill.tsx`

A coloured dot plus a label, per §11.2. All six colour tokens already exist in
`app/globals.css`; this adds none.

§11.2 names colours for five statuses and the schema has seven, so two need a
decision:

| Status | Token | Why |
|---|---|---|
| `pending` | `text-muted` | Nothing has happened yet. Not a state to draw the eye. |
| `calling` | `accent` | §11.2: "in-progress uses accent". |
| `confirmed` | `confirmed` | |
| `rescheduled` | `rescheduled` | |
| `declined` | `declined` | |
| `cancelled` | `unreachable` (slate) | A cancellation is a neutral outcome, not a failure. Red is reserved for the person saying no. |
| `unreachable` | `unreachable` | |

This mapping is written into the file, because the gap in §11.2 will otherwise be
re-derived differently by the next screen that needs a pill.

### `components/ui/field-error.tsx` — moved

`FieldError` moves out of `components/settings/section.tsx`, which Overview
should not be importing from. Seven lines, no behaviour change, one import
updated in each settings component that uses it. Nothing else in `section.tsx`
moves — `SettingsSection` and `SettingsCallout` are genuinely settings-shaped.

### `app/(app)/page.tsx`

Runs `listAppointments`, `appointmentStats`, the Business's Services, and the
first Service's Slot options, then renders the stat strip, the Quick Call card
and the table. `requireBusiness()` is React-`cache()`d and the shell layout above
has already called it, so it costs no second query.

## Part 5 — Tests

`vitest`, against the local Postgres harness #6 set up.

### Pure, no database

- `parseE164` across good and bad input: `+1 202 555 0142` (the seed's reserved
  fictional range) normalises; a bare national number, a leading `0` after the
  `+`, seven digits, sixteen digits and an empty string each come back with a
  reason.
- `parseQuickAddInput` reports all four fields at once, echoes the submission
  back, and rejects a `startsAt` that is not an ISO instant as a field error
  rather than throwing.

### Against the database

- `slotIsOffered` returns each of its three answers: a time inside Business Hours
  is `offered`; 03:00 on an open day is `not_offered`; yesterday is
  `in_the_past`. A Slot that is inside hours but already booked is still
  `offered`, which pins the split in Part 1 — this function does not look at
  other Appointments.
- `createAppointment` refuses an out-of-hours time with `not_offered` and a
  past time with `in_the_past`, and creates on the happy path with `ends_at`
  derived from the Service duration.
- `appointmentStats` on a freshly seeded account reads Total 5, Confirmed 1,
  Needs attention 0, Answer rate `null`.
- `listAppointments` returns `attempts: 0` and `lastCallId: null` for an
  Appointment with no Calls, and the right count and latest id once Calls exist.

### The test that protects Part 1

Two `createAppointment` calls for the same Slot, fired concurrently through the
real function. One returns the Appointment; the other returns `slot_taken`.

This is not a duplicate of `lib/availability/book.test.ts`. That one proves the
constraint holds at the database level. This one proves the layer above does not
route around it: a pre-check reintroduced in `createAppointment` would let both
calls read "free" before either wrote, and the test would fail.

## File-by-file changes

**New**

| File | |
|---|---|
| `lib/appointments/phone.ts` + test | E.164 validation |
| `lib/appointments/quick-add-input.ts` + test | form parsing and state types |
| `lib/appointments/create.ts` + test | the three-step create |
| `lib/availability/offered.ts` + test | hours and past, never overlap |
| `lib/business/appointment-stats.ts` + test | the four tiles |
| `app/(app)/actions.ts` | `addAppointmentAction`, `slotOptionsAction` |
| `components/overview/stat-strip.tsx` | |
| `components/overview/quick-call-card.tsx` | |
| `components/overview/appointments-table.tsx` | |
| `components/overview/status-pill.tsx` | |
| `components/ui/field-error.tsx` | moved out of settings |

**Changed**

| File | |
|---|---|
| `lib/availability/find.ts` | extract the shared loader; behaviour unchanged |
| `lib/business/list-appointments.ts` | rename, plus `attempts` and `lastCallId` |
| `app/(app)/page.tsx` | render the four new pieces |
| `app/(app)/settings/actions.ts` | one import rename |
| `components/settings/section.tsx` | `FieldError` moves out |
| `components/settings/*.tsx` | import `FieldError` from its new home |

**Deleted**

| File | |
|---|---|
| `components/overview/appointments-list.tsx` | replaced by the table |

No migration. No schema change. `appointments` and `calls` already carry every
column this needs.

## Out of scope

Everything in the "What #7 does not own" table above. Also:

- **No re-seeding and no "load demo data" button.** The seed runs once, inside
  onboarding's transaction.
- **No editing or deleting an Appointment.** #7 creates and lists. Changing one
  is a Reschedule, which belongs to the Agent (#12).
- **No `relations()` in the Drizzle schema.** Wanted for the joins here, but it
  is a schema-wide convention change and needs its own ADR.

## Known limitations, stated deliberately

- **`not_offered` covers two different problems.** A time when the Business is
  closed, and a time inside opening hours but off the Slot grid — 09:07 when
  Slots run 09:00, 10:00, 11:00. Both read the same to the person, and the
  picker only offers grid-aligned times, so the second is only reachable by a
  forged POST.
- **The Slot picker can go stale.** It is rendered at page load, and a Slot can
  be taken between then and the submit. That is what the `slot_taken` message
  exists for, and it is the correct outcome rather than a defect to design away.
- **The table shows the earliest twenty Appointments, past ones included.** The
  stat tiles count every row, so the numbers and the table can disagree for an
  account with more than twenty. Acceptable at demo scale; paging belongs with
  #18's Schedule view if it is ever needed.
- **Phone validation checks shape, not reachability.** A well-formed number that
  belongs to nobody is accepted. Only placing a Call can find that out, which is
  #11's problem and lands as a Needs Attention reason in #15.

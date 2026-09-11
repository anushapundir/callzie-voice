# Design: CSV upload with per-row validation

**Issue:** [#8](https://github.com/anushapundir/callzie/issues/8)
**Date:** 2026-08-19
**Status:** Implemented, except the browser walkthrough. See the Progress section
of `docs/superpowers/plans/2026-08-19-csv-upload.md` for what shipped and how it
differs from the design below.

## Summary

Load a list of people in one go. Upload a CSV, get the valid rows created, and see
exactly which rows were rejected and why.

The point of this work is the **rejection report**, not the bulk insert. A row the person
has to go and fix is not a transient notification — SPEC.md §11.4 says inline persistent
UI, and #8's acceptance criteria say the same thing twice ("lists each rejected row with
its row number and a specific reason", "persists on screen until dismissed").

Two constraints shape everything below.

**Every row is validated the same way quick-add is.** #7 already built that path:
`parseE164` → `createAppointment` → `slotIsOffered` → `bookSlot`. This work reuses it once
per row. It does not write a second validator, because a second validator is a second set
of rules that will drift from the first.

**The database stays the only judge of "that Slot is taken."** `appointments_no_overlap` is
a Postgres `EXCLUDE` constraint — a rule that rejects an insert whose time range overlaps a
row already there. SPEC.md §3 rule 8 puts that guarantee in the database on purpose.
Nothing here asks "is this Slot free?" before inserting, **including the check that looks
harmless because both rows are in the same file.** See Part 2.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| How is the time written in the file? | Local wall-clock in the Business's timezone — `2026-08-21 09:30`. No offset written anywhere in the file. |
| Where does the rejection report live? | On Overview, above the Quick call card, persistent with its own Dismiss. The upload panel closes when the run finishes. |
| What is the upload surface built from? | `components/ui/sheet.tsx`. It is already a Radix Dialog underneath, and already themed to §11.2. No new `dialog.tsx`. |
| Client or server validation? | Parsing is client-side (PapaParse, SPEC.md §2). **All** validation is server-side — a Server Action is a POST anyone can send. |
| All-or-nothing, or partial? | Partial, by design. Good rows are created; bad rows are reported. That is what the issue asks for. |
| Does a bad row stop the run? | No. Every row is attempted, so one upload produces one complete list of things to fix. |

## Part 1 — Why the time is a wall clock

A CSV time is written by a person in a spreadsheet. `2026-08-21 09:30` means half past
nine **where the Business is**, and the file says nothing about UTC offsets.

The alternative was an ISO instant with an offset — `2026-08-21T09:30:00+05:30` — which is
what the quick-add picker already submits, and which needs no conversion code at all. It
was rejected because almost nobody exports that from a spreadsheet, and a wrong offset
silently books the wrong hour. A silently wrong booking is the failure mode this whole
product is built to avoid.

The conversion already exists. `lib/time/zone.ts` has `zonedTimeToInstant(wall, timezone)`,
built for exactly this in ADR-0007: it reads the zone's offset at the specific instant
involved, handles half-hour zones like `Asia/Kolkata`, and resolves DST irregularities the
same way Temporal would.

What is missing is only the parse. `tryParseWallTime("09:30")` handles the time half.
This adds `tryParseWallClock("2026-08-21 09:30")` beside it, which delegates the time half
to the existing function so the strict `HH:mm` rule stays written down once.

## Part 2 — Naming the same-file collision without a pre-check

This is the load-bearing part of the design, and it is the acceptance criterion "two CSV
rows targeting the same Slot cannot both be created."

### It is already satisfied

Rows are processed one at a time, awaited in order. Row 4 books 09:30. Row 9 asks for
09:30, `bookSlot` attempts the insert, `appointments_no_overlap` rejects it, and
`createAppointment` hands back `slot_taken`. Nothing new is needed to make this work — #6
and #7 already built it.

### The trap

The message is wrong, though. Quick-add says "Someone just booked that time." Nobody else
did. Row 4 did, in this same upload, a moment ago.

The obvious fix is to remember which times the file has claimed and check that list before
inserting. That is a check-then-write, and it is the exact thing SPEC.md §3 rule 8 exists
to rule out. It is *especially* tempting here because within one file it looks like it
cannot race — but the harm is not the race. The harm is that it produces a second code path
that also reports "occupied", which makes the constraint look redundant to the next person
who reads the file and deletes the "slow" branch.

### The shape that follows

1. Attempt the insert. Postgres still decides.
2. Keep an in-memory list of `{ rowNumber, startsAt, endsAt }` for rows **this run
   created**.
3. Consult that list **only after** the constraint has already refused — purely to pick
   which sentence to print.

| Constraint refused, and… | Message |
|---|---|
| an earlier row in this run overlaps | `Row 4 already takes that time.` |
| nothing in this run overlaps | `Someone already has that time.` |

The list carries no authority over whether a row is created. Delete it and the behaviour is
identical — only the wording gets worse. That property is what stops it rotting into a
pre-check, and the test in Part 6 pins it.

Note the list stores **ranges**, not start times. Two rows can collide without sharing a
start: a 90-minute Colour at 10:00 and a 45-minute Haircut at 11:00 overlap, and the
constraint refuses the second. Comparing start times alone would print the wrong sentence.

## Part 3 — What the file has to look like

A header row, then one row per person. Four columns are required, matched **by name,
case-insensitive, in any order**. Extra columns are ignored.

```csv
name,phone,service,time
Priya Raman,+1 202 555 0110,Cleaning,2026-08-21 09:30
Daniel Okafor,+12025550111,Check-up,2026-08-21 10:00
```

- **name** — 1 to 80 characters, the same ceiling `quick-add-input.ts` applies.
- **phone** — anything `parseE164` accepts. Spaces, dashes and brackets are fine; the `+`
  and country code are not optional, because `businesses` has no country column to anchor
  a guess against.
- **service** — the name of one of the Business's Services, trimmed and matched
  case-insensitively.
- **time** — `YYYY-MM-DD HH:mm`, or the same with a `T` in the middle. Read in the
  Business's timezone.

### Row numbers are spreadsheet line numbers

The report says "Row 4", and it has to mean the fourth line of the file the person is
looking at — otherwise the report sends them to the wrong row.

So the file is parsed with `skipEmptyLines: false`. A blank line at row 6 does not
renumber everything after it. The server skips a fully blank row silently and counts it in
`skipped`; a trailing newline is not an error worth reporting.

The header is line 1, so the *n*th data row is row *n* + 1.

## Part 4 — The flow

```
Browser                                    Server Action
───────                                    ─────────────
pick file
  ↓
Papa.parse(file, { header: true,
                   skipEmptyLines: false })
  ↓
check columns, emptiness, row cap    ──→   file-level refusal, shown in the sheet
  ↓                                        (no round trip — nothing to list per row)
rows: [{ rowNumber, name, phone,
         service, time }]
  ↓  ──────────────────────────────────→   uploadCsvAction(rows)
                                             requireBusiness()
                                             listServices() once
                                             for each row, in order:
                                               parseCsvRow      → reasons[]
                                               createAppointment → created | refusal
                                             revalidatePath("/")
       report  ←──────────────────────────  { created, rejected[], skipped }
  ↓
sheet closes; the panel appears on the page
```

**Parsing is client-side, validation is server-side.** SPEC.md §2 fixes PapaParse and says
client-side, and that is what parsing means here: turning bytes into rows. Deciding whether
a row is acceptable happens on the server, every time, because a Server Action is a POST
reachable by anyone who can send it. The client's own checks — missing columns, empty file,
row cap — exist to save a round trip, not to be trusted.

**Rows are awaited one at a time**, not `Promise.all`. The report must be deterministic,
and sequential inserts are what make the second row targeting a Slot lose to the first
cleanly rather than by chance.

## Part 5 — New and changed modules

### `lib/time/zone.ts` — changed

One function added beside `tryParseWallTime`:

```ts
export function tryParseWallClock(value: string): WallClock | null
```

Accepts `YYYY-MM-DD HH:mm` and `YYYY-MM-DDTHH:mm`. Strict on digit counts — four, two,
two — and delegates the time half to `tryParseWallTime`, so `"09:7"` stays refused in one
place rather than two. Returns `null` on anything else, matching the `try*` convention the
file already sets: throwing is for values this repo authored, `null` is for values a person
typed.

Nothing else in `zone.ts` changes.

### `lib/appointments/csv-input.ts` — new, pure

Mirrors `lib/appointments/quick-add-input.ts`: a hand-written parser returning a
discriminated result, with the state types alongside it because a `"use server"` module may
only export async functions.

```ts
export const CSV_COLUMNS = ["name", "phone", "service", "time"] as const
export const MAX_CSV_ROWS = 200

export type CsvRow = {
  rowNumber: number
  name: string
  phone: string
  service: string
  time: string
}

export type CsvRowRejection = { rowNumber: number; name: string; reasons: string[] }

export type CsvUploadReport = {
  created: number
  rejected: CsvRowRejection[]
  /** Fully blank lines. Counted, never reported — a trailing newline is not an error. */
  skipped: number
}

export type CsvUploadState =
  | { status: "idle" }
  | { status: "file_error"; message: string }
  | { status: "done"; report: CsvUploadReport }

export const INITIAL_CSV_UPLOAD_STATE: CsvUploadState

export function checkColumns(headers: string[]):
  | { ok: true }
  | { ok: false; message: string }

export function parseCsvRow(
  row: CsvRow,
  context: { services: ServiceOption[]; timezone: string; },
): ParsedCsvRow
```

**Every reason for a row is collected, not just the first.** A row with a bad phone number
*and* an unknown service reports both. Otherwise one upload takes two passes to fix, and
the whole point of a per-row report is that it takes one.

**`parseE164` is reused verbatim, wording included.** A bad number reads identically in the
CSV report and in the quick-add card. `lib/appointments/phone.ts` already promised this in
its own header comment.

**An ambiguous Service name is its own rejection.** Nothing stops a Business having two
Services called "Haircut" — `lib/settings/services-input.ts` enforces no uniqueness. Picking
one arbitrarily would book an unknown duration, so the row is refused and the person is
told to rename one in Settings.

**`serviceId` is never accepted from the file.** The CSV carries a Service *name*, which is
resolved against the Business's own Services. There is no id in the file to forge.

### `lib/appointments/csv-upload.ts` — new, database

```ts
export async function uploadCsvRows(input: {
  businessId: string
  timezone: string
  rows: CsvRow[]
  now?: Date
}): Promise<CsvUploadReport>
```

Loads `listServices(businessId)` once, then loops. Per row: `parseCsvRow`, then
`createAppointment` — the function from `lib/appointments/create.ts`, unchanged and not
copied. Its three refusals are mapped onto CSV wording, with Part 2's rule applied to
`slot_taken`.

`now` is injected rather than read, matching every other module in this area, so
correctness does not depend on the day the test runs.

**The per-row cost is accepted deliberately.** `createAppointment` calls `loadSchedule`
every time, which is three reads, plus `bookSlot`'s read and insert — about five queries per
row, so roughly a thousand for a full file. Hoisting the schedule out of the loop would be
faster and would mean the CSV path no longer runs the identical code quick-add runs. That
trade is not worth making. `MAX_CSV_ROWS = 200` is the bound that keeps the untuned version
safe.

### `app/(app)/actions.ts` — changed

One action added:

```ts
export async function uploadCsvAction(rows: CsvRow[]): Promise<CsvUploadState>
```

Follows the three rules the file already documents: `requireBusiness()` first always,
nothing closes over anything, and a rejected write returns state rather than throwing.

It re-checks the array shape and the row cap. `revalidatePath("/")` at the end, so the
table and the stat strip come back fresh in the same round trip.

### `components/overview/csv-upload.tsx` — new, client

Three exports, one file, because they are one interaction.

- **`CsvUploadProvider`** — holds the report in React state and renders `{children}`.
  Server Components pass straight through it; React context reaches the client components
  nested inside them because context follows tree position, not module boundaries.
- **`UploadCsvButton`** — the button plus the `Sheet`. `side="right"`, widened with
  `data-[side=right]:sm:max-w-lg` (the built-in variant has to be beaten by a `data-`
  selector — see the note at `components/app-shell/mobile-nav.tsx:34`). Inside: a file
  input, the expected columns with one example line rendered in the Business's own
  timezone, file-level errors, and a submit button carrying its own spinner. §11.4 rules
  out a full-page blocker.
- **`useCsvUploadReport`** — the hook `CsvRejections` reads.

No `window.confirm` and no native dialog, holding the line
`components/settings/services-section.tsx:47` already holds: it blocks the thread, cannot be
styled to §11.2, and is unreachable from a test.

The sheet closes once the run finishes. The report is the page's now, not the sheet's.

### `components/overview/csv-rejections.tsx` — new, client

The persistent panel. Renders nothing when there is no report.

- **No rejections** — "Created 8 appointments." in the `confirmed` token, with Dismiss.
- **Some rejections** — `attention` amber border and heading, "Created 8. 3 rows rejected.",
  then one entry per rejected row: `Row 4 · Grace Mwangi` with its reasons beneath it.

**Amber, not red.** §11.2's `attention` means a human has to act, which is exactly what a
rejected row is. `components/overview/status-pill.tsx` already reserves red for the person
saying no. This is not a `needs_attention_reason` row — #15's section is a separate,
database-backed surface with its own heading — but the colour carries the same meaning, so
sharing it is the honest choice rather than a collision.

Stacks at 375px per §11.4. Dismiss clears the provider state.

### `components/overview/appointments-table.tsx` — changed

Its heading block becomes a `flex items-start justify-between` row and gains a
`toolbar?: React.ReactNode` prop. The file's own header comment already reserves this spot
for #8. Nothing else in it changes.

A slot rather than the button itself, because the table is a Server Component and the
button is a client one — passing it in as a node keeps the table from having to know that.

### `app/(app)/page.tsx` — changed

Wraps its contents in `CsvUploadProvider`, renders `CsvRejections` between the stat strip
and the Quick call card, and passes `<UploadCsvButton />` into the table's toolbar slot.

### `package.json` — changed

`papaparse` and `@types/papaparse`. Named by SPEC.md §2, so this needs no ADR.

**No migration. No schema change.** `appointments` already carries every column this needs.

## Part 6 — Messages

Per row, shown in the panel:

| Problem | Message |
|---|---|
| name blank | `Enter the person's name.` |
| name too long | `Keep the name under 80 characters.` |
| phone | whatever `parseE164` returns, verbatim |
| service blank | `Enter a service.` |
| service unknown | `No service called "Colur". Known services: Haircut, Colour, Blow-dry.` |
| service ambiguous | `Two services are called "Haircut". Rename one in Settings.` |
| time blank | `Enter a time.` |
| time unparseable | `Write the time as 2026-08-21 09:30.` |
| `not_offered` | `That is not a time you can book. Check your business hours and the service length.` |
| `in_the_past` | `That time has already passed.` |
| `slot_taken`, existing Appointment | `Someone already has that time.` |
| `slot_taken`, earlier row this run | `Row 4 already takes that time.` |

Whole-file, shown in the sheet — there is nothing to list per row:

| Problem | Message |
|---|---|
| empty file | `That file is empty.` |
| header but no rows | `That file has a header row and nothing under it.` |
| missing columns | `That file needs columns named name, phone, service and time. Found: forename, mobile.` |
| over the cap | `That file has 640 rows. Upload at most 200 at a time.` |
| unparseable as CSV | `That file could not be read as CSV. Check for an unclosed quote.` |

Every one of these is a designed message. The fifth acceptance criterion — "a malformed or
empty file fails with a designed message rather than an exception" — is this table.

## Part 7 — Tests

`vitest`, against the embedded Postgres harness #6 set up. The repo has no component tests
and this adds none; the UI is verified by a browser walkthrough at the end of the plan.

### Pure, no database

- `tryParseWallClock` across both separators, a bad month, `"09:7"`, and an empty string.
- `checkColumns` accepts headers in any order and any case, ignores extras, and names the
  missing one when a column is absent.
- `parseCsvRow` returns **both** reasons for a row with a bad phone and an unknown service;
  lists the known Services when one is unknown; refuses an ambiguous Service name; reports
  a fully blank row as blank rather than as four errors.

### Against the database

- A valid file creates every row, and `created` matches.
- A mixed file creates the good rows and returns the bad ones with the **spreadsheet** row
  number — including one sitting below a blank line, which is what pins the numbering rule.
- A row whose Slot is already held by an existing Appointment is rejected with "Someone
  already has that time."
- A file over `MAX_CSV_ROWS` is refused whole, with nothing created.

### The test that protects Part 2

Two rows in one file targeting the same Slot. One is created; the other comes back with
"Row 4 already takes that time."

This is not a duplicate of `lib/availability/book.test.ts`, which proves the constraint
holds at the database level, nor of `create.test.ts`'s concurrency test, which proves the
layer above does not route around it. This one proves the *bulk* layer does not either. A
pre-check reintroduced in `uploadCsvRows` would change which row wins, or stop Postgres
being the thing that decides, and this test fails either way.

## Out of scope

- **Editing a rejected row in the browser and retrying it.** #8 reports; the person fixes
  the file and uploads again. An in-browser row editor is a second quick-add form.
- **Downloading a template CSV.** The sheet shows the columns and one example line, which
  is enough. A generated file is a route and a content-type for no gain.
- **Persisting the report.** See the limitations below.
- **Placing Calls for the uploaded rows.** That is "Call all", #17.
- **A progress bar per row.** The action returns once. At 200 rows the run is short enough
  that a spinner on the button is the honest UI.

## Known limitations, stated deliberately

- **The report is client state.** It survives `revalidatePath` — React state outlives a
  server-driven re-render, the same property `quick-call-card.tsx` already documents — but
  not a reload or a navigation away. The upload it describes has already happened and the
  rows are in the table; only the list of what was rejected is lost. Persisting it would
  mean a table and a migration, and #8 does not ask for one.
- **200 rows per upload.** A bound on the per-row `loadSchedule` cost, chosen so every row
  can go through the exact path quick-add uses.
- **Phone validation checks shape, not reachability.** The same limit
  `lib/appointments/phone.ts` already documents.
- **A spring-forward time shifts forward.** `zonedTimeToInstant` resolves a wall clock that
  never happens by moving it past the gap. The shifted time is then usually refused as
  `not_offered`, because it no longer sits on the Slot grid. That is an honest outcome, but
  the reason will not mention DST.
- **`not_offered` still covers two problems** — closed then, or inside opening hours but off
  the Slot grid. Inherited from #7, and the CSV wording says both out loud.

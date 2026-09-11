# Design: Tool endpoints — check availability, book, confirm, cancel

**Issue:** [#10](https://github.com/anushapundir/callzie/issues/10)
**Date:** 2026-08-19
**Status:** Implemented. See `docs/superpowers/plans/2026-08-19-tool-endpoints.md`

## Summary

Four HTTP endpoints that Maya calls while she is still talking to someone. They
are the moment Callzie stops being a dashboard and starts being a product: the
Reschedule commits during the conversation, not from a transcript someone parses
afterwards (ADR-0003).

No voice is involved in building them. A fixture posts the same body Retell
would post, and the tests assert on what came back and what landed in the
database. Telephony spend for this ticket is zero.

Three things this design is careful about.

**Maya can only book a time we actually offered her.** `lib/retell/tools.ts`
already declares `slot_start` as an opaque token that `check_availability`
returns and `book_slot` echoes back. This design makes that a rule the server
enforces, by looking back at what this Call was told. Without it, "only ever
offer times `check_availability` returned" is a line in a prompt, and SPEC.md §3
rule 6 exists because a line in a prompt is a suggestion.

**One booking per Call is a database rule, not a code check.** The same
reasoning #6 applied to Slots. A check in application code is a check someone
can delete without a test going red.

**Every invocation is recorded, including the ones that fail.** SPEC.md §9 step 3
makes `tool_invocations` the authoritative record of the outcome — Extraction
never overwrites it. A booking that happened but was not recorded is worse than
one that failed, because the Call detail screen (#16) would show a Call in which
Maya apparently did nothing.

## What already exists

Most of the hard parts are done. This ticket is largely wiring.

| Already built | Where | What it gives us |
|---|---|---|
| Slot arithmetic, DST-correct | `lib/availability/slots.ts` | Candidate Slots inside Business Hours |
| Availability query | `lib/availability/find.ts` | `findAvailableSlots({businessId, serviceId, from, to, now})` |
| "Is this exact time offered?" | `lib/availability/offered.ts` | `offered` / `not_offered` / `in_the_past` |
| The no-overlap guarantee | `drizzle/0001_appointments_no_overlap.sql` | Postgres refuses a second Appointment in the same Slot |
| Constraint-error translation | `lib/availability/book.ts` | Turns SQLSTATE `23P01` into `{ ok: false, reason: "slot_taken" }` |
| Tool names, arguments, paths | `lib/retell/tools.ts` | The contract both sides compile against |
| The `tool_invocations` table | `lib/db/schema.ts` | `call_id`, `tool_name`, `arguments`, `result`, `succeeded` |
| Timezone rendering | `lib/time/zone.ts` | `formatInZone`, `partsInZone` |
| Network-free test Postgres | `vitest.globalSetup.ts` | A real database, on this machine, per run |

## Decisions taken during brainstorming

1. **Proving a Slot was Offered: replay `tool_invocations`.** `book_slot` reads
   this Call's earlier `check_availability` rows and requires the incoming
   `slot_start` to appear in one of their results. Rejected: signing each
   `slot_start` with `INTERNAL_SECRET`, which is faster but adds a second
   secret-signing scheme beside `lib/google/oauth.ts` for a saving of one indexed
   read.
2. **`preferred_time` is recorded and otherwise ignored.** The endpoint always
   returns the next three open Slots. Rejected for now: a phrase parser, and
   changing the tool schema so the model sends a structured hint — the second
   would reopen #9 and require re-provisioning four Agents at Retell.
3. **One Reschedule per Call is a partial unique index.** Rejected:
   check-then-write in application code, which is the exact pattern #6 ruled out;
   and deriving it from `appointments.status`, which says nothing about the Call.
4. **Both `Authorization: Bearer` and `X-Callzie-Secret` are accepted.**
   `docs/verification.md` A12 records it as UNVERIFIED whether Retell forwards
   `Authorization` unmodified, and names `X-Callzie-Secret` as the fallback.
   Accepting both costs a few lines and removes a live-call debugging round trip.

## What #10 does not own

- **Creating `calls` rows.** Nothing writes `calls.retell_call_id` yet; #11 (Web
  Call) does that. These endpoints only *read* it. The tests insert a `calls` row
  directly, which is exactly the state #11 will leave behind.
- **The Needs Attention screen.** #10 writes
  `needs_attention_reason = 'book_failed'`; #15 renders it.
- **The Call detail screen.** #16 reads `tool_invocations` and displays it.
- **The Agent prompt.** #9 owns it. Nothing here changes what Maya is told —
  that is the point of enforcing in the endpoint.
- **Webhooks.** #13. A Tool call is not a webhook: Retell posts it synchronously
  and waits for the answer.

---

## Part 1 — The request Retell sends, and who it is

### The body

`docs/verification.md` A12 settles the shape: Retell posts
`{ name, call, args }`. `args_at_root` stays `false`, so the `call` wrapper
survives — which is what makes the next section possible.

```json
{
  "name": "book_slot",
  "call": { "call_id": "call_abc123", "transcript": "…" },
  "args": { "slot_start": "2026-08-20T08:30:00.000Z" }
}
```

`call` carries much more than this, including the transcript so far. We read one
field from it.

### Resolving identity from `call`, never from `args`

`lib/retell/tools.ts` already refuses to put any identifier in a tool's argument
schema, and gives the reason: if the Appointment id were an argument, the model
would be choosing which row it writes to, and one hallucinated uuid becomes a
cross-tenant write.

So identity is resolved server-side, in one join:

```
call.call_id  →  calls.retell_call_id
              →  calls.appointment_id
              →  appointments (business_id, service_id, starts_at, status)
              →  businesses.timezone, services.duration_minutes
```

Everything downstream is scoped by the `business_id` that came out of that join.
The model contributes no part of it.

### Authenticating

`INTERNAL_SECRET`, read from either header, compared with
`crypto.timingSafeEqual` — a comparison that takes the same time whether the
first character is wrong or the last one is, so the number of correct leading
characters cannot be measured by timing repeated requests.

`timingSafeEqual` throws when the two buffers differ in length, which itself
leaks the length. Both sides are hashed to a fixed 32 bytes with SHA-256 first,
so every comparison is 32 bytes against 32 bytes.

If `INTERNAL_SECRET` is unset on the deployment, every request is refused. A
blank secret must never mean "no gate" — the same reasoning
`app/api/google/start/route.ts` gives for refusing to start a handshake it
cannot sign.

### `proxy.ts` — the step that is easy to miss

`proxy.ts` makes every route private by default, and says so:

> routes are listed here to be made *public*, so a screen added later is
> protected by omission rather than by remembering to protect it.

`/api/tools(.*)` has to join `/api/webhooks(.*)` in `isPublicRoute`. Without it
Clerk redirects Retell to the sign-in page, and every Tool call fails as a `302`
to HTML — which Maya would experience as a Tool that never works, with nothing in
the logs that says "auth".

"Public" here means "no session cookie required". The secret check is the gate,
and it is stricter than a cookie, because a cookie would let any signed-up
account call these endpoints.

---

## Part 2 — Two database changes

Migration `drizzle/0003_tool_invocations.sql`.

### `latency_ms`

```sql
ALTER TABLE "tool_invocations" ADD COLUMN "latency_ms" integer;
```

The issue asks for it directly: *"Latency is measured and recorded — a slow Tool
is dead air on a live call."* It also closes an open item.
`docs/verification.md` A12 records the Tool latency budget as UNVERIFIED and
names this ticket as what settles it. A column, not a log line, because #16
renders each invocation and this belongs on that card.

Nullable, because a row written after a crash may have nothing to record, and a
`NOT NULL` here would turn a failed Tool into a failed *record* of a failed Tool.

### The one-booking index

```sql
CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"
  ON "tool_invocations" ("call_id")
  WHERE "tool_name" = 'book_slot' AND "succeeded";
```

A **partial unique index** is a uniqueness rule that only applies to rows
matching a condition. Here: at most one row per Call where the tool was
`book_slot` and it succeeded.

Read the `WHERE` clause carefully, because it is the whole design:

- Unlimited `check_availability` rows per Call. The negotiation is the product's
  best moment (SPEC.md §7) and nothing may cap it.
- Unlimited *failed* `book_slot` rows per Call. SPEC.md §8 retries once, and a
  Slot lost to a concurrent Call is an ordinary outcome Maya answers by offering
  another time.
- Exactly one *successful* `book_slot`. That is CONTEXT.md's Reschedule:
  *"One Reschedule commits per Call, however many Offers preceded it."*

The index is hand-written in the migration rather than generated, following
`drizzle/0001`'s precedent for rules Drizzle's schema DSL does not round-trip
cleanly. `lib/db/schema.test.ts` already parses migration `0001` to prove a
constant still matches its SQL; a sibling test does the same here, so editing
one file and not the other fails a test rather than silently disabling the rule.

---

## Part 3 — One transaction per Tool call

Every Tool runs inside a single Postgres transaction that **also writes its own
`tool_invocations` row**.

That is one sentence and it is the mechanism that makes Part 2's index work.
Consider the second `book_slot` in a Call:

1. Transaction opens.
2. The Appointment is moved to the new Slot.
3. The `tool_invocations` row is inserted — and the partial unique index
   refuses it, because this Call already has a successful booking.
4. The whole transaction rolls back. **Step 2 is undone with step 3.**

The Appointment keeps the time it was already moved to. There is no window in
which the booking happened but the record of it did not, and no ordering of the
two writes that could leave them disagreeing.

The same wrapper is used for all four Tools. For `check_availability`,
`confirm_appointment` and `cancel_appointment` the transaction is doing nothing
clever, and that is fine — one shape for all four is worth more than saving a
`BEGIN` on three of them.

### `lib/tools/run.ts` — the wrapper

```ts
runTool({ name, call, args, handler }): Promise<ToolResult>
```

What it does, in order:

1. Start the clock.
2. Open a transaction.
3. Run `handler(tx, context)`, which returns `{ succeeded, result }`.
4. Insert the `tool_invocations` row inside the same transaction, with
   `arguments`, `result`, `succeeded` and `latency_ms`.
5. Commit. Return `result`.

If step 3 or step 4 throws, the transaction rolls back and the wrapper writes a
`succeeded: false` row on a **fresh connection**, outside the rolled-back
transaction — otherwise the record of the failure would be rolled back along with
the failure. `succeeded: false` is also what keeps that row clear of the
one-booking index.

Latency is measured around steps 2–5, so it includes the database work the
endpoint actually does. It deliberately excludes Retell's network hop, which we
cannot see and cannot fix.

### The four handlers

`lib/tools/check-availability.ts`, `book-slot.ts`, `confirm-appointment.ts`,
`cancel-appointment.ts`. Each is a plain function taking a transaction and the
resolved context, returning a value. No `Request`, no `NextResponse`, no
`headers()` — which is what lets them be tested without constructing HTTP.

### The routes

`app/api/tools/<tool>/route.ts`, four files, each about ten lines: authenticate,
parse, resolve the Call, hand to `runTool`, return JSON. The same thin-route
shape as `app/api/google/start/route.ts`.

---

## Part 4 — What each endpoint does

### `check_availability`

**Returns up to three open Slots in Business-local time.**

```ts
findAvailableSlots({
  businessId, serviceId,
  from: now,
  to: now + LOOKAHEAD_DAYS,
  now,
}).slice(0, MAX_OFFERS)
```

`MAX_OFFERS` is 3, from SPEC.md §7's table. `LOOKAHEAD_DAYS` is 14 — long enough
that a Business open two days a week still has something to offer, short enough
that the query stays small. Both are named constants in one place, because #16
and a future preference parser will want the same numbers.

The two rules the issue names are already guaranteed by the engine, not re-checked
here: `openSlots` never generates a Slot that runs past closing time, and never
one before `now`. Re-checking would create a second place to be wrong.

Each Slot comes back twice over:

```json
{
  "ok": true,
  "slots": [
    { "slot_start": "2026-08-20T08:30:00.000Z", "time": "Thursday 20 August at 2:00 PM" }
  ]
}
```

- `slot_start` — an ISO 8601 instant in UTC. This is the token `book_slot` must
  echo back verbatim. ISO rather than an opaque hash because #16 has to render
  it and a support conversation has to be able to read it.
- `time` — what Maya says out loud, in the Business's timezone.

Two formats because they have opposite requirements. `formatInZone` in
`lib/time/zone.ts` produces `"Thu 20 Aug, 14:00"` — fixed-width and 24-hour,
correct for a dashboard table in a mono face, and wrong to read aloud. A new
`spokenTime(instant, timezone)` in `lib/tools/spoken-time.ts` produces the
speakable form. It does not replace `formatInZone`; the comment on each says why
the other exists.

An empty `slots` array is a normal answer, not a failure: `{ ok: true, slots: [] }`.
A fully booked fortnight is something Maya should say, not something that should
read to her as a broken Tool.

### `book_slot`

**Commits the Reschedule.** Four checks, in this order, because each is cheaper
than the next and each failure means something different to the person on the
phone.

1. **Is `slot_start` a valid instant?** Reject anything `Date.parse` will not
   take. → `invalid_time`
2. **Did we offer it in this Call?** Load this Call's `check_availability` rows
   from `tool_invocations` and look for an exact `slot_start` match in their
   recorded results. → `not_offered`
3. **Is it inside Business Hours, and still ahead?** `slotIsOffered`. →
   `not_offered` / `in_the_past`
4. **Move the Appointment.** → `slot_taken` on the constraint.

Check 2 is the new rule. Check 3 looks redundant after it and is not: a Slot
offered forty seconds ago can be in the past by the time it is booked if the
Slot boundary fell in between, and Business Hours can be edited in Settings
mid-Call. Check 2 answers "did we say this?"; check 3 answers "is it still
true?".

**Why the offer check is a lookup and not a cache.** The rows are already being
written — the issue requires it. Reading them back adds one indexed query on
`tool_invocations(call_id)`, an index that already exists in `lib/db/schema.ts`.
A cache would be a second copy of the record, and a second copy is a thing that
can disagree.

**The move itself** is a new `lib/appointments/reschedule.ts`:

```sql
UPDATE appointments
   SET starts_at = $new, ends_at = $new + duration, status = 'rescheduled'
 WHERE id = $appointment
```

`ends_at` is derived from the Service duration inside the function and never
accepted from a caller — the same rule `lib/availability/book.ts` states, and for
the same reason: `ends_at` is half of what the exclusion constraint compares, so
a caller who could supply it could defeat the constraint with a one-minute end
time.

Absolute milliseconds, not wall-clock addition: a 90-minute Service across a
spring-forward still takes 90 minutes even though the clock advances 150.

An `UPDATE` is checked by `appointments_no_overlap` exactly as an `INSERT` is —
an exclusion constraint tests the row's new range whichever statement produced
it. So the guarantee holds without anything new. The error translation is the
same too: `lib/availability/book.ts` already has `isSlotTaken`, which walks the
`cause` chain past Drizzle's `DrizzleQueryError` wrapper. That function moves to
`lib/availability/slot-taken.ts` unchanged and both files import it, rather than
being copied — a copy would be one of two places to fix.

**On failure, SPEC.md §8.** Retry once, silently, inside the endpoint —
`docs/verification.md` A12 records that Retell's own `max_retry` stays at 0
precisely because `book_slot` is not idempotent, so this retry is ours to own.

**Each attempt needs its own savepoint.** A **savepoint** is a marker inside a
transaction you can roll back to without losing the whole transaction. It matters
here because Postgres aborts a transaction the moment a statement fails: after the
constraint rejects the first `UPDATE`, every later statement in that transaction —
including the retry, including the `book_failed` write, including the
`tool_invocations` row — fails with "current transaction is aborted". So each
attempt runs in a nested `tx.transaction(...)`, which Drizzle issues as a
savepoint. A losing attempt rolls back to its savepoint and the outer transaction
carries on.

Without this the whole design collapses quietly: the retry would never run, and
Part 3's guarantee that the record is written alongside the write would produce no
record at all.

If the second attempt also loses:

- `needs_attention_reason = 'book_failed'` on the Appointment.
- The Appointment keeps its original Slot.
- Return `{ ok: false, reason: "slot_taken" }`.

The endpoint never returns `ok: true` for a write that did not happen. That is
SPEC.md §3 rule 7 and SPEC.md §14 rule 4 — the most damaging failure available to
this product — and it is the one thing in this file that has no acceptable
workaround.

On success:

```json
{ "ok": true, "booked_time": "Thursday 20 August at 2:00 PM" }
```

### `confirm_appointment`

`status = 'confirmed'`. No arguments — it acts on the Appointment this Call is
already about. Returns `{ ok: true }`.

Idempotent: confirming an already-confirmed Appointment succeeds. Maya
occasionally calls a Tool twice, and a second confirmation is not an error worth
making her explain.

### `cancel_appointment`

`status = 'cancelled'`. Returns `{ ok: true }`.

The Slot frees itself. `cancelled` is one of `SLOT_FREEING_STATUSES`, so both
the `appointments_no_overlap` constraint and `findAvailableSlots` stop counting
it — no separate "release the Slot" step, and therefore no way for the two to
disagree.

Note what this does **not** do: SPEC.md §14 rule 2 says a Slot is never freed on
a weak signal. A person saying "cancel it" is not a weak signal — an unanswered
phone is, and that path is #17's, not this one's.

---

## Part 5 — Status codes

| Situation | Status | Body |
|---|---|---|
| Missing or wrong secret | `401` | `{ "error": "unauthorized" }` |
| Body is not `{ name, call: { call_id }, args }` | `400` | `{ "error": "bad_request" }` |
| No `calls` row for that `call_id` | `404` | `{ "error": "unknown_call" }` |
| Anything else, including every refusal | `200` | `{ "ok": …, … }` |

The line: **`4xx` means this request should never have been made, and there is
nothing for Maya to say.** A business refusal is different — "that time just
went" is part of the conversation, so it comes back as `200` with
`{ ok: false, reason }` and Maya reads it.

Nothing is recorded for a `401`, `400` or `404`. `tool_invocations.call_id` is
`NOT NULL` with a foreign key, so a request we cannot tie to a Call has no row to
write. Stated here because it is a real gap: a wrong `call_id` leaves no trace in
the product. It is the right trade — the alternative is a nullable `call_id` that
makes every reader of that table handle a case that only ever means "someone
posted garbage".

---

## Part 6 — Tests

All of it against the local Postgres `vitest.globalSetup.ts` starts. No network,
no Retell, no telephony (SPEC.md §10).

### How the endpoints are driven

The exported `POST` function is called directly with a `new Request(...)`. No
server is started. Next 16 route handlers are plain functions over the Web
`Request`/`Response` types, so this is the real handler on the real path, not a
stand-in.

### Fixtures

`fixtures/retell/tools/` — a JSON file per Tool call, shaped exactly as A12
records Retell's body. This directory is new; SPEC.md §10 puts `fixtures/retell/`
in the tree and #13 will fill in the webhook side.

A fixture carries a placeholder `call_id` that each test replaces with the id of
the `calls` row it seeded. One helper builds the `Request` from a fixture plus a
`call_id`, so a change to Retell's envelope is a one-line change here rather than
across thirty tests.

### One test per acceptance criterion

| Criterion | Test |
|---|---|
| Reachable only with the secret | Each of the four routes, no header → `401`; wrong secret → `401`; `X-Callzie-Secret` → works; `Authorization: Bearer` → works |
| Never a Slot outside Business Hours or in the past | Seed a Business closed on the target day and one whose only free Slot has passed; assert both come back empty |
| Booking an occupied Slot fails cleanly | Seed a conflicting Appointment; assert `ok: false`, `needs_attention_reason = 'book_failed'`, and the Appointment still on its original `starts_at` |
| Second `book_slot` refused, `check_availability` not | One Call: check, book, check, check, book. Assert two successful checks after the booking, and the second booking refused with the Appointment unchanged |
| Every invocation recorded | After the sequence above, assert one `tool_invocations` row per request, with arguments, result and the right `succeeded` flag — including the refused booking |
| Latency measured | Assert `latency_ms` is a non-negative integer on every row |
| No telephony spend | Structural: no test imports `retell-sdk` or opens a socket |

### Tests beyond the criteria

- **A time we never offered is refused** — post a `slot_start` that is a
  perfectly valid open Slot but was never returned in this Call. This is the test
  that protects decision 1; without it, deleting the offer check breaks nothing.
- **Dropping the one-booking index makes the second-booking test fail** —
  the same technique `lib/availability/book.test.ts` uses for
  `appointments_no_overlap`, proving the test is sensitive to the database rule
  rather than to a code path. This file must restore the index and, like
  `book.test.ts`, relies on `fileParallelism: false` in `vitest.config.mts`.
- **A rolled-back second booking leaves the Appointment untouched** — the
  claim Part 3 makes. Asserted on the row, not on the response.
- **A second Business's hours never leak into the answer** — seed two Businesses
  with different timezones and different Business Hours, then drive a Call
  belonging to the first. Assert every returned Slot sits inside *its* hours. The
  join in Part 1 is the only thing scoping these endpoints, so it deserves a test
  that fails if someone widens it.
- **A savepoint retry leaves the outer transaction usable** — force the first
  `UPDATE` to lose, and assert the `tool_invocations` row still gets written. This
  is the test that catches the aborted-transaction trap described above.
- **`spokenTime` across a half-hour zone and a DST boundary** — pure, no
  database. `Asia/Kolkata` is Callzie's first market and `+05:30` is exactly the
  offset a naive formatter gets wrong.

---

## File-by-file changes

| File | Change |
|---|---|
| `drizzle/0003_tool_invocations.sql` | **New.** `latency_ms` column; the partial unique index. Hand-written, registered in `_journal.json`. |
| `lib/db/schema.ts` | **Modify.** Add `latencyMs` to `toolInvocations`. |
| `lib/db/schema.test.ts` | **Modify.** Parse migration `0003` and assert the index's `WHERE` clause still says `book_slot` and `succeeded`. |
| `proxy.ts` | **Modify.** Add `/api/tools(.*)` to `isPublicRoute`, with the reason. |
| `lib/tools/auth.ts` | **New.** Read the secret from either header; hashed constant-time compare. |
| `lib/tools/auth.test.ts` | **New.** Both headers, wrong secret, missing secret, unset `INTERNAL_SECRET`. |
| `lib/tools/request.ts` | **New.** Parse `{ name, call, args }`; resolve Call → Appointment → Business + Service. |
| `lib/tools/request.test.ts` | **New.** Malformed bodies, unknown `call_id`, the resolved context. |
| `lib/tools/run.ts` | **New.** The transaction wrapper; writes `tool_invocations` with latency. |
| `lib/tools/run.test.ts` | **New.** Records success and failure; a rolled-back write leaves nothing behind; the failure row is written outside the rollback. |
| `lib/tools/spoken-time.ts` | **New.** The speakable rendering of an instant in a Business's timezone. |
| `lib/tools/spoken-time.test.ts` | **New.** Pure. Half-hour offsets, DST, midnight, noon. |
| `lib/tools/check-availability.ts` + `.test.ts` | **New.** Up to three Slots; `preferred_time` recorded, not used. |
| `lib/tools/book-slot.ts` + `.test.ts` | **New.** The four checks, the single retry, `book_failed`. |
| `lib/tools/confirm-appointment.ts` + `.test.ts` | **New.** |
| `lib/tools/cancel-appointment.ts` + `.test.ts` | **New.** |
| `lib/tools/offers.ts` + `.test.ts` | **New.** "Was this `slot_start` offered in this Call?" — reads `tool_invocations`. |
| `lib/appointments/reschedule.ts` + `.test.ts` | **New.** Move an Appointment; translate the constraint rejection. |
| `lib/availability/slot-taken.ts` | **New.** `isSlotTaken`, moved verbatim out of `book.ts`. |
| `lib/availability/book.ts` | **Modify.** Import `isSlotTaken` instead of defining it. |
| `app/api/tools/check-availability/route.ts` | **New.** Thin. |
| `app/api/tools/book-slot/route.ts` | **New.** Thin. |
| `app/api/tools/confirm-appointment/route.ts` | **New.** Thin. |
| `app/api/tools/cancel-appointment/route.ts` | **New.** Thin. |
| `fixtures/retell/tools/*.json` | **New.** One body per Tool, as Retell sends it. |
| `docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md` | **New.** Decisions 1 and 3, with what was rejected. |
| `docs/verification.md` | **Modify.** A12: both headers accepted; the latency item now has a column behind it. |

## Out of scope

- Understanding `preferred_time`. Recorded, unused. Revisit once real phrases
  are in the table.
- Anything that places a Call. #11.
- Rendering any of this. #15, #16.
- Google Calendar push on a Reschedule. #20, and behind a flag.
- Rate limiting the endpoints. Retell is the only caller and the secret is the
  gate; a limiter with one client is a way to break a live call.

## Known limitations, stated deliberately

- **A request with an unknown `call_id` leaves no record.** Part 5 explains the
  trade.
- **`preferred_time` is ignored, and Maya is not told so.** She will pass
  "Thursday afternoon" and receive Monday morning. The prompt already tells her to
  offer what came back, so she will offer it — but the conversation will read as
  slightly deaf. This is the honest cost of decision 2 and the first thing to
  revisit after #12.
- **Latency measures our database work, not Retell's round trip.** The number
  answers "is our query slow", not "did the caller hear silence". The second needs
  a live Call, which is #12.
- **The offer check is per Call, not per Offer.** A `slot_start` offered in turn
  two can be booked in turn nine, even if Maya offered three other times in
  between. Tightening it would mean tracking which Offer was live, and refusing a
  customer who said "actually, the first one you said" — which is a real thing
  people say.

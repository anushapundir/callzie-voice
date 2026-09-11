# Design: Call All — throttling and retry on no answer

**Issue:** [#17](https://github.com/anushapundir/callzie/issues/17)
**Date:** 2026-08-23
**Status:** Implemented. See
`docs/superpowers/plans/2026-08-23-call-all-throttling.md`

## What changed while building it

Three things this design did not anticipate, each recorded because the reasoning
matters more than the edit:

1. **The give-up write had to accept a `queued` Appointment, not just a
   `pending` one.** This design says both aftermath writes key on `pending`,
   because `releaseAppointment` puts the row there first. It misses the state the
   *second* silence actually finds: attempt 1's retry left the Appointment
   `queued`, and while the phone flag is off nothing moves it back — so attempt 2
   found `queued`, matched neither write, and left the Appointment stuck in a
   queue that would never drain instead of asking for a human. Caught by
   `scripts/replay-webhook.ts`, not by any unit test, because it takes two
   deliveries against one Appointment to show up. Both writes now accept either.

2. **The advisory lock is not what the ten-pump test proves.** The design implies
   the concurrency test fails without it. It does not: ten pumps starting
   together read the same count, select the same top-three Appointments and
   contend on the same rows, so Postgres' row locks alone give the right answer
   for that shape. The window the lock closes is narrower — a pump whose count
   and queue read straddle another pump's commit, which is a phantom read no row
   lock can cover. The lock stays; the claim about the test was corrected in
   `pump.ts` and `pump.test.ts` rather than left standing.

3. **The strip holds no state.** The design has it polling into local state.
   React's lint rule refuses that shape — an effect syncing props into state
   causes cascading renders — and it was unnecessary: the counts come from the
   Server Component, the tick calls `router.refresh()`, and `stopBatchAction`
   revalidates. One source of truth, no resynchronisation.

## Summary

One button calls everybody. Three Calls at a time, never four. A Call nobody
answers is tried once more, and a second silence makes the Appointment
unreachable — needing a human, and **still holding its Slot**.

Three things this design is careful about:

**There is no background worker, and there cannot be one.** Cloud Run throttles
CPU the moment a response is sent (ADR-0001), so anything left running after the
button press is frozen mid-loop. The queue lives in Postgres and is pumped by
the `call_ended` webhook — which has to be involved anyway, because "nobody
answered" is a fact that only arrives on that event.

**The throttle is enforced by a lock, not by counting.** Two webhooks can arrive
in the same millisecond and both will pump. Count-then-place lets both see two
in flight and both place one, which is four. The claim runs inside a per-Business
advisory lock, and no network call happens while it is held.

**Nothing here can be exercised for real yet, and that is deliberate.** Call All
needs concurrency, and only the Phone Call path has any. So this ticket ships the
engine and a port; #19 supplies the dialler.

## The problem this design starts from

#17 says "at most three at a time". Callzie cannot place three Calls at a time.

Today the only Call it can place is a **Web Call**: the server creates it, and
then a *browser* has to join it with an access token within 30 seconds, or Retell
kills it with `error_user_not_joined` (`docs/verification.md` A3). One browser has
one microphone and one person in front of it, so it can be in one Web Call.

A server-side loop firing three Web Calls nobody joins would spend three of the
account's five Quota on rows that all land `failed` — and `start-web-call.ts`
only refunds when Retell itself errors, so that Quota is gone for nothing.

Real concurrency exists only on the Phone Call path, which is
[#19](https://github.com/anushapundir/callzie/issues/19) and still open. #17 is
not blocked by it, so the split is:

- **#17** builds the queue, the throttle, the Quota rule, the retry rule and the
  screen. It proves all of it against the local Postgres and through the real
  webhook path, spending nothing.
- **#19** supplies the one function that actually dials a telephone, plus the KYC,
  the number purchase, the India question and the kill switch.

Until #19 lands, pressing Call all on any account says **"Phone calls are off for
this account"** and queues nothing.

## What #17 does not own

| Surface | Issue |
|---|---|
| Dialling a telephone; the phone flag's kill switch | #19 |
| The Needs Attention section that renders `unreachable` | #15 |
| The README sentence about why the throttle is three | #21 (see below) |
| Google Calendar Collisions | #20 |

**The README sentence has nowhere to go.** #17 asks the README to say that three
concurrent Calls is cost control and demo pacing rather than a platform limit —
the workspace allows twenty (`docs/verification.md` A10). There is no README in
the repo; writing one is #21. So the reasoning is recorded twice where it cannot
be lost — in ADR-0013 and in the comment above `MAX_CONCURRENT_CALLS` — and #21
gets a note pointing at both.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| What kind of Call does Call All place? | Phone Calls. The engine is call-type agnostic behind a `CallPlacer` port; #19 supplies the real one. Web Calls were rejected: three at once is impossible, and unjoined ones burn Quota. |
| What advances the queue? | The `call_ended` webhook, in `after()`. The open Overview page also ticks every 5s, which revalidates the rows and un-sticks a batch if a delivery never arrives. |
| Where does the queue live? | A new `queued` Appointment status. No migration, no new table, no new noun — and the table shows a Queued pill for free. |
| Which Calls earn the automatic retry? | Every Call, whatever placed it. The rule belongs to the Call, not the batch, so a one-off Call now behaves the same as a batched one. |
| Which Appointments does a batch call? | `pending`, no `needs_attention_reason`, `starts_at` in the future. |
| What does the button do? | Confirms with real numbers, then shows a persistent strip with a Stop. Call now spends one Quota; this spends every one you have left. |
| What ships behind the port now? | A refusal that checks `phone_calls_enabled`. No Retell phone code at all. |

## The queue: one new Appointment status

`queued` joins the seven in `lib/db/schema.ts`:

```ts
export const APPOINTMENT_STATUSES = [
  "pending",
  "queued",
  "calling",
  ...
] as const;
```

**No migration.** `status` is a `text` column (SPEC.md §5 chose that so a new
status never needs one), and the `appointments_no_overlap` constraint frees a
Slot only for `declined` and `cancelled` — so a queued Appointment holds its Slot
automatically, and `SLOT_HOLDING_STATUSES` picks it up without being edited.

Two knock-on edits, both forced by the compiler rather than remembered:

- `lib/appointments/status-style.ts` is a `Record<AppointmentStatus, …>`, so it
  will not build until `queued` has a colour and a word. It gets `bg-text-muted`
  and "Queued" — the same muted treatment as `pending`, because a queued
  Appointment is waiting rather than happening.
- `lib/availability/find.ts` and `lib/schedule/load-day.ts` read
  `SLOT_HOLDING_STATUSES` and need no change; a test asserts a queued Appointment
  still blocks its Slot.

**Two things are now called `queued` and they mean different things.**
`calls.status = 'queued'` means the Call row exists and Retell has not been
contacted. `appointments.status = 'queued'` means the Appointment is waiting for
a free slot in the throttle. They are analogous — both are "written down, not yet
dialled" — and both are documented at their declaration.

## The modules

Five small files, each testable on its own.

| File | Job |
|---|---|
| `lib/calls/batch/eligible.ts` | Which Appointments a batch may call, and how many Calls the Quota still allows. |
| `lib/calls/batch/queue.ts` | `enqueueBatch` (pending → queued, capped), `stopBatch` (queued → pending), `batchProgress`. |
| `lib/calls/batch/pump.ts` | Fill the free slots. Called by the button, by every `call_ended`, and by the page tick. |
| `lib/calls/batch/placer.ts` | The `CallPlacer` port, and the refusal that is its only implementation today. |
| `lib/calls/batch/retry.ts` | A pure function: what a finished Call earns. |

Plus one extraction from existing code, described below.

### `eligible.ts`

```ts
export async function eligibleAppointmentIds(
  businessId: string,
  now: Date,
): Promise<string[]>
```

`status = 'pending'`, `needs_attention_reason IS NULL`, `starts_at > now`,
ordered by `starts_at` so the soonest Appointment is called first.

Each condition earns its place. Phoning someone about a time that has already
passed spends Quota on a call that cannot change anything. An Appointment
carrying a reason is blocked from calling until a human clears it — #15's rule,
and the reason `unreachable` Appointments are skipped twice over. Everything
already `confirmed`, `rescheduled`, `declined` or `cancelled` is left alone.

`now` is injected, matching `slots.ts` and `active-calls.ts`, so a test does not
depend on the clock it runs at.

Beside it:

```ts
export async function quotaRemaining(businessId: string): Promise<number>
```

`call_quota - calls_used`, floored at zero, or `Number.POSITIVE_INFINITY` for an
admin. This is a **preview**, not a guarantee — the real bound is
`claimCallQuota`'s single UPDATE, and this number can be stale the instant it is
read. It exists so the confirmation dialog can say something true at the moment
it opens.

### `queue.ts`

```ts
export async function enqueueBatch(
  { businessId, now }: { businessId: string; now: Date },
): Promise<{ queued: number; eligible: number }>
```

One statement: `UPDATE appointments SET status = 'queued' WHERE id IN (SELECT …
ORDER BY starts_at LIMIT n)`, where `n` is the smaller of the eligible count, the
remaining Quota, and `MAX_BATCH_SIZE` (200, matching `MAX_CSV_ROWS` — a bound on
the shape of a request, not a product rule).

**Queueing more than the Quota allows was considered and rejected.** A queued
Appointment that can never be placed is a row that lies about what is going to
happen. Capping at the Quota is what lets the dialog say "3 will be placed and 5
stay pending" and be right.

One statement also means a double press is safe: the second finds no `pending`
rows left to claim and queues nothing.

```ts
export async function stopBatch(businessId: string): Promise<number>
export async function batchProgress(businessId: string):
  Promise<{ calling: number; waiting: number }>
```

`stopBatch` returns every `queued` Appointment to `pending`. It does not touch
Calls already in flight — you can stop a queue, not un-ring a phone.

`batchProgress` returns `waiting` (Appointments at `queued`) and `calling`
(**Phone** Calls in flight). The call-type filter is what stops the strip from
duplicating the live-call bar: a browser conversation is already reported by
`live-call-bar.tsx`, and a second banner announcing the same Call would be noise.

There is deliberately no "done" count. Without a Batch entity there is no honest
way to compute one, and a made-up number on the demo stage is worse than an
absent one.

Note the asymmetry with the throttle, which counts Calls of **every** type: a
live Web Call is genuinely one of the account's concurrent Calls and must occupy
a slot. Both counts come from one function with a call-type filter, so the two
rules sit side by side rather than in different files.

### `pump.ts` — the throttle, and the race it has to survive

```ts
export const MAX_CONCURRENT_CALLS = 3;

export async function pumpBatch({
  businessId,
  now,
  place = refusingPlacer,
}): Promise<{ placed: number; blocked?: "phone_calls_disabled" | "exhausted" }>
```

The naive version counts what is in flight, subtracts from three, and places the
difference. That is wrong for the reason SPEC.md §3 rule 8 gives about
double-booking: two webhooks arriving together both read two in flight, both
place one, and four Calls are live.

So the claim runs in **one transaction holding a per-Business advisory lock** — a
named Postgres lock, taken by number, that makes this Business's pumps take turns
while every other account runs untouched:

```sql
SELECT pg_advisory_xact_lock(hashtext($businessId))
```

Inside that transaction, and in this order:

1. **Refuse early if the account cannot place a Phone Call.** Return
   `blocked: 'phone_calls_disabled'` and claim nothing. This is what keeps a
   requeued retry from spending Quota on a dial that is going to be refused.
2. **Count what is in flight.** `calls` rows with status `queued`, `ringing` or
   `in_progress` whose `created_at` is inside `LIVE_CALL_STALENESS_MS` (180s, the
   120s cap plus slack, already exported by `lib/business/active-calls.ts`).
   Read-time staleness for the same reason that file gives: a Call cannot outlive
   the cap, so an older row is not live whatever the column says, and a delivery
   that never arrived must not hold a slot for the life of the account.
3. **Claim up to `3 − inFlight` Appointments.** For each, `UPDATE … SET status =
   'calling' WHERE id = … AND status = 'queued'`. No row means another pump got
   there first, so skip it. The conditional UPDATE is the guard, never a read
   followed by a write.
4. **Reserve each Call** — `reserveCall`, below. An exhausted Quota stops the
   loop, returns the Appointment just claimed to `pending`, and drains the rest of
   the queue back to `pending` as well, because none of them can be placed either.

**No network call happens inside the lock.** Dialling runs afterwards, over the
claims the transaction returned. That is the same rule `start-web-call.ts` states
about holding a row lock across an HTTP round trip; here the lock is per-Business
and briefly held, and the only contention is this Business's own pumps, which
must serialise anyway.

If a dial fails, the compensating write is the one that already exists: mark that
Call `failed`, release the Quota, return the Appointment to `pending` via
`releaseAppointment`. **It is not re-queued.** A permanently broken dialler would
otherwise loop the batch forever.

### The extraction this needs: `lib/calls/reserve.ts`

`startWebCall` already opens a transaction that counts prior Calls, claims the
Quota and inserts the row. The pump needs exactly that, inside its own
transaction. So it moves:

```ts
export async function reserveCall(
  tx: Executor,
  { appointmentId, businessId, callType }: {
    appointmentId: string; businessId: string; callType: CallType;
  },
): Promise<{ ok: true; callId: string } | { ok: false; reason: "exhausted" }>
```

`startWebCall` then calls it inside its existing transaction and keeps its
`QuotaExhausted` shape. One implementation of "attempt is `existing + 1`, and the
Quota claim lands with the row", not two that drift — and the count stays inside
the transaction, which is what stops two concurrent Calls for one Appointment
both coming out as attempt 2.

### `placer.ts` — the port, and today's only implementation

```ts
export type CallPlacer = (params: {
  businessId: string;
  appointmentId: string;
  callId: string;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;
```

The production implementation reads `phone_calls_enabled` and refuses. There is
no Retell phone code in this ticket.

The pump already checks the flag in step 1, so this second check looks redundant.
It is not: SPEC.md §3 rule 9 and #19's first acceptance criterion say an unflagged
account cannot place a Phone Call **by any route**, and the placer is the route.
A guard at the boundary is worth more than a guard on the caller.

Tests inject a fake placer. Nothing in this ticket contacts Retell, which is
SPEC.md §3 rule 11.

### `retry.ts` — one pure function

```ts
export const MAX_ATTEMPTS = 2;

export function afterCall(
  { status, attempt }: { status: CallStatus; attempt: number },
): "retry" | "unreachable" | "nothing"
```

`no_answer` with `attempt < 2` → `retry`. `no_answer` at attempt 2 or beyond →
`unreachable`. Everything else → `nothing`.

Pure, so every case is a one-line test — the same shape as
`lib/calls/truncation.ts` and for the same reason: the judgement is worth pinning
separately from the writes it triggers.

## Retry, and going unreachable

Applied in `lib/webhooks/process.ts`, in `applyEnded`, immediately after
`releaseAppointment`. That function returns a `calling` Appointment to `pending`,
so by the time this runs the row is `pending` and the writes below can key on it.

**Retry** — the Appointment goes back into the queue:

```sql
UPDATE appointments SET status = 'queued'
 WHERE id = $1 AND status = 'pending' AND needs_attention_reason IS NULL
```

The retry is a **second Call row**, written by `reserveCall` with `attempt = 2`
when the pump reaches it — not a revival of the first. It waits its turn behind
the throttle like anything else. The conditions are not decoration: a Tool that
confirmed the Appointment mid-Call leaves it `confirmed`, and a Call that also
earned a `book_failed` leaves a reason set. Neither may be dragged back into a
queue.

**Unreachable** — one statement, two columns:

```sql
UPDATE appointments
   SET status = 'unreachable',
       needs_attention_reason = coalesce(needs_attention_reason, 'unreachable')
 WHERE id = $1 AND status = 'pending'
```

`coalesce` because `book_failed` is the more specific reason and must survive —
the same rule `flagTruncated` already applies. **`starts_at` and `ends_at` are not
touched**, and `unreachable` is a slot-holding status, so the booking stays where
it is. SPEC.md §14 rule 2: an unanswered phone is not a cancellation.

Both are conditional UPDATEs writing fixed values, which is the property
`process.ts` states about itself and the reason a redelivered `call_ended` is a
no-op.

Then `pumpBatch` runs, so the slot the finished Call just freed is filled in the
same delivery.

### The consequence worth writing down

While `phone_calls_enabled` is off, a retried Appointment sits at `queued` and is
never placed — the pump refuses at step 1. The row is visible in the table with a
Queued pill, and Stop returns it to pending.

This is the honest state: "waiting to be called", which becomes true the moment
#19 lands. The alternative — marking someone unreachable after a single silence
because the account cannot dial — would contradict #17's own acceptance criterion
and would set a Needs Attention reason that describes nothing that happened.

In practice this is rare on today's accounts: a Web Call nobody joins ends
`error_user_not_joined`, which maps to `failed`, not `no_answer`
(`docs/verification.md` A9). The no-answer reasons are telephone reasons.

## Where the pump is called from

Three callers, one function.

1. **The button.** `startBatchAction` checks `phone_calls_enabled` first and
   refuses without queueing anything, then enqueues and pumps once, so the first
   three Calls go out inside the request. Like every Server Action in this repo it
   opens with `requireBusiness()` — a Server Action is a POST anyone can send, and
   rendering a button on an authenticated screen is not a security boundary.
2. **The webhook.** `processWebhookEvent` → `applyEnded` → pump. It runs inside
   the route's `after()` (ADR-0012), which is where the 200 has already been sent
   and the work continues. Wrapped in try/catch and logged, the way extraction is:
   a pump that throws must not undo the Call row the handler just wrote.
3. **The page tick.** While the strip shows anything, the browser calls
   `tickBatchAction` every 5s. It pumps and returns progress.

The third is belt and braces, and it earns its place twice: it is also what
satisfies "rows revalidate while Calls are in flight". The existing 5s refresh in
`live-call-provider.tsx` only runs while *the browser* owns a live Call, which is
never true of a batch of Phone Calls.

## The screen

**Call all** joins Upload CSV in the Appointments table header — the `toolbar`
slot `appointments-table.tsx` already accepts, with the comment that says #17
fills it.

**The confirmation.** Pressing it opens the existing `sheet` component (the one
CSV upload uses; there is no dialog primitive in `components/ui`, and this does
not need one). It states the numbers plainly:

> Call 8 people?
> You have 3 calls left, so 3 will be placed and 5 stay pending.
> Callzie calls at most 3 at a time.

When the account cannot place Phone Calls the button is **disabled with the reason
on it** — `title="Phone calls are off for this account"` — because a disabled
control that does not explain itself reads as a broken one, which is the rule
`call-now-button.tsx` already follows. Same when nothing is eligible: "No
appointments to call."

**The strip.** Above the table, for the life of the batch, persistent inline UI
rather than a toast (SPEC.md §11.4):

> Calling 2 · 4 waiting — **Stop**

Stop returns every queued Appointment to pending and leaves in-flight Calls alone;
it is hidden once nothing is waiting, because a Stop with an empty queue does
nothing and a control that does nothing is a lie.

The strip renders nothing when both counts are zero, so it costs nothing on a
quiet screen — and a solo Web Call placed from a table row does not raise it, per
the call-type filter above. It ticks every 5s while visible.

Rows being called already shimmer — `list-appointments.ts` decides `isCalling`
and the table applies it. Queued rows do not shimmer; they show the pill.

## Testing

**Pure tests, no database.**

- `retry.ts`: `no_answer` at attempt 1 retries; at attempt 2 goes unreachable; at
  attempt 3 (which should not happen) still goes unreachable rather than looping;
  `completed`, `failed` and `in_progress` all earn nothing.

**Integration tests, local Postgres, fake placer.** These are where the
acceptance criteria are actually settled.

- **The throttle.** Queue eight Appointments, fire ten pumps concurrently, assert
  exactly three Calls exist and exactly three Appointments are `calling`. This is
  the test the advisory lock exists for; it is the `quota.test.ts` pattern applied
  to concurrency instead of a counter.
- **Quota across the batch.** An account with `call_quota` 5 and 8 eligible
  Appointments queues 5, not 8. When the Quota runs out mid-batch — a Call now
  placed from another tab in between — the remaining queue drains back to
  `pending` rather than sitting there unplaceable.
- **Eligibility.** An Appointment with a `needs_attention_reason` is not queued.
  Nor is one in the past, nor one already `confirmed`. Proves #17's second
  criterion and #15's third.
- **Refusal.** With `phone_calls_enabled` false, `startBatchAction` queues nothing
  and spends nothing; a pump over an already-queued Appointment places nothing and
  writes no Call row.
- **Slot held.** A queued Appointment and an unreachable one both still block
  their Slot in `findAvailableSlots`.
- **Draining.** `stopBatch` returns queued rows to pending and leaves `calling`
  ones alone.

**Through the real webhook path** — `lib/webhooks/process.test.ts`:

- A `call_ended` carrying `dial_no_answer` on an attempt-1 Call leaves the
  Appointment `queued`, with its Slot and its start time untouched.
- The same delivery on an attempt-2 Call leaves it `unreachable` with
  `needs_attention_reason = 'unreachable'`, Slot untouched.
- An Appointment already carrying `book_failed` keeps that reason when it goes
  unreachable.
- Delivering the same `call_ended` twice changes nothing the second time.

**Replay** — `scripts/replay-webhook.ts`. The `call-ended-no-answer.json` fixture
already exists and is already driven; what is new is a two-step scenario with its
own throwaway Appointment, so marking it unreachable cannot disturb the other
assertions:

1. Attempt 1 ends `dial_no_answer` → assert the Appointment is `queued`.
2. Attempt 2 ends `dial_no_answer` → assert `unreachable`, reason `unreachable`,
   and `starts_at` unchanged.

The replay account has no phone flag, so nothing is dialled and no Quota moves —
which is the point. As with every replay scenario, its throwaway rows are named
`replay-…` and a run that dies partway leaves one behind (CLAUDE.md).

**Component tests.**

- The Call all button renders disabled, with its reason, when phone calls are off.
- The confirmation states the capped number, not the eligible number, when the
  Quota is the smaller of the two.
- The strip renders nothing at zero, renders both counts otherwise, and hides
  Stop when nothing is waiting.
- `batchProgress` does not count a live Web Call, so a solo Call now leaves the
  strip absent.

**Not tested.** The 5s tick, for the same reason the Call detail poller is not: it
is a `setInterval` around a Server Action and a `router.refresh()`.

## Acceptance criteria, mapped

| Criterion | Met by |
|---|---|
| Call All queues every pending Appointment and never exceeds three concurrent | `enqueueBatch` plus `pumpBatch`'s advisory-locked claim; the ten-concurrent-pumps test |
| Appointments needing attention are skipped | `eligibleAppointmentIds`' `needs_attention_reason IS NULL`, tested directly |
| A no-answer produces exactly one retry, tracked as a second attempt | `afterCall` plus the requeue in `applyEnded`; `reserveCall` writes `attempt = 2` |
| After the final attempt the Appointment is unreachable, needs attention, and still holds its Slot | The single `coalesce` UPDATE; `unreachable` is a slot-holding status, asserted against `findAvailableSlots` |
| The quota is respected across the whole batch, not per Call | `enqueueBatch` caps at `quotaRemaining`; `reserveCall`'s `claimCallQuota` is the real bound, and exhaustion drains the queue |
| Rows revalidate while Calls are in flight | The strip's 5s tick calling `tickBatchAction` and `router.refresh()` |

## ADR-0013

Worth a decision record, because two of the choices above will look wrong to
whoever reads the code next:

**"Call All is throttled in the app and pumped by webhooks."** Why there is no
background worker (Cloud Run freezes CPU after the response — ADR-0001). Why the
limit is three when the workspace allows twenty (cost control and demo pacing —
`docs/verification.md` A10, and the note SPEC.md's README deliverable owes). Why
the queue is an Appointment status rather than a Batch table. And why Retell's own
`POST /create-batch-call` is not used: it gives no per-Call `call_id` mapping for
the data model in SPEC.md §5, and its `reserved_concurrency` is a manual hold
rather than a throttle (`docs/verification.md` line 323 says so outright).

## Files

**New**

- `lib/calls/batch/limits.ts` — the three constants, with no database import, so
  a client component can read `MAX_CONCURRENT_CALLS`
- `lib/calls/batch/retry.ts` + test
- `lib/calls/batch/summary.ts` + test — the sentences the confirmation shows
- `lib/calls/batch/eligible.ts` + test
- `lib/calls/batch/in-flight.ts` + test — one counter, two filters
- `lib/calls/batch/queue.ts` + test
- `lib/calls/batch/placer.ts` + test
- `lib/calls/batch/pump.ts` + test
- `lib/calls/reserve.ts` + test
- `app/(app)/calls/batch-actions.ts`
- `components/overview/call-all-button.tsx`
- `components/overview/batch-strip.tsx`
- `components/overview/batch-strip-view.tsx` + test — the strip's markup, split
  out so it renders to a string without a browser
- `docs/adr/0013-call-all-throttled-in-app-pumped-by-webhooks.md`

**Changed**

- `lib/db/schema.ts` — `queued` joins `APPOINTMENT_STATUSES`
- `lib/appointments/status-style.ts` — a colour and a word for it
- `lib/calls/start-web-call.ts` — reserve half moved out
- `lib/webhooks/process.ts` — the retry rule and the pump, in `applyEnded`
- `app/(app)/page.tsx` — the button in the toolbar, the strip above the table
- `scripts/replay-webhook.ts` — the two-step no-answer scenario
- `fixtures/retell/webhooks/README.md` — what the new scenario proves

**No migration.**

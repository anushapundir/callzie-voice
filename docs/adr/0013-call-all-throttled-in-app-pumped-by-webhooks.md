# Call All is throttled in the app, and pumped by webhooks

Status: accepted

Issue #17 asks for one button that calls everybody, three Calls at a time. Two
facts decide how that is built, and neither is about the button.

**There is nowhere for a loop to run.** ADR-0001 records that Cloud Run
withdraws CPU when a response is sent. `--no-cpu-throttling` buys `after()` a
window at the end of one request (ADR-0012); it does not buy a process that
keeps placing Calls for the next ten minutes. There is no queue service in this
stack, and adding one for a five-Call Quota would be absurd.

**The event that matters arrives later anyway.** "Nobody answered" is
`disconnection_reason` on `call_ended`, minutes after the Call was placed. So a
webhook handler is already involved in every retry, whatever else is true.

## Decision

The queue is `appointments.status = 'queued'`, and `call_ended` pumps it.

- **Queue.** Pressing Call all marks the callable Appointments `queued`, capped
  at the remaining Quota, and places the first three.
- **Pump.** `lib/webhooks/process.ts` tops the in-flight count back up to three
  after every ending, inside the `after()` block ADR-0012 established, and
  places any retry that ending earned.
- **Backstop.** An open Overview page ticks every five seconds. It pumps too,
  which un-sticks a batch if a delivery never arrives, and it is what refreshes
  the rows while a batch of Phone Calls is in flight — `live-call-provider.tsx`
  cannot, because it only runs while the browser owns a Web Call.
- **Throttle.** The claim runs inside `pg_advisory_xact_lock(hashtext(business))`
  with no network call held inside it.

## Why a lock and not a count

Counting what is in flight and then placing the difference is the obvious
implementation, and it is wrong for the reason SPEC.md §3 rule 8 gives about
double-booking.

The row lock on the claim hides most of it. Two pumps starting together read the
same count, select the same top-N Appointments and contend on the same rows, so
the loser claims nothing and the total is right. `lib/calls/batch/pump.test.ts`
fires ten pumps at once and still gets three **without** the advisory lock, and
its comment says so rather than pretending otherwise.

The window the lock closes is the one where a pump's two reads straddle another
pump's commit: count "none running", then — after a second pump has claimed the
first three and committed — select the queue, see three *different* Appointments
still waiting, and place three more. Counting is a phantom read, and no row lock
can cover rows that do not exist yet. Either serialise, or run SERIALIZABLE and
handle the retries. A per-Business advisory lock is the cheaper of the two, and
it holds no network call.

## Why three

**Cost control and demo pacing, not a platform limit.** A Retell Pay-As-You-Go
workspace is allowed twenty concurrent Calls and the first twenty are free
(`docs/verification.md` A10). Three is what keeps a demo watchable and stops a
five-Call Quota vanishing in one press.

This is worth stating plainly because the opposite reading is the natural one.
The README owes the sentence (SPEC.md §12's M7 deliverable, tracked on #21), and
`lib/calls/batch/limits.ts` carries it above the constant.

## Considered options

- **Retell's `POST /create-batch-call`.** Rejected, and `docs/verification.md`
  line 323 already said so: it gives no per-Call `call_id` mapping, which the
  data model in SPEC.md §5 is built on, and its `reserved_concurrency` is a
  manual hold rather than a throttle.
- **A `call_batches` table.** Rejected. Membership on the Appointment row needs
  no migration, no new noun in `CONTEXT.md`, and gives the table a Queued pill
  for free. What it gives up is a per-batch "done" count — which is why the
  strip shows "Calling 2 · 4 waiting" and no total.
- **Driving the whole batch from the browser.** Rejected. Closing the tab would
  halt a batch mid-way, and a retry earned by a no-answer would never be placed
  at all. The page tick survives as a backstop, not as the mechanism.
- **Placing Web Calls.** Rejected, and this is the decision that shapes the
  ticket. A Web Call needs a browser to join it within 30 seconds
  (`docs/verification.md` A3) and a browser has one microphone, so three at once
  is not possible. Three unjoined Web Calls would spend three of the account's
  five Calls on rows that all land `failed`. Call All therefore places Phone
  Calls, and #17 ships the engine behind a `CallPlacer` port while #19 supplies
  the dialler.

## Consequences

- **Call All does nothing on an unflagged account, on purpose.** The button says
  "Phone calls are off for this account" and queues nothing. Everything behind it
  is proven against the local Postgres with a fake placer and through the real
  webhook path by replay, spending nothing (SPEC.md §3 rule 11).
- **A retried Appointment waits at `queued` until #19 lands.** The pump refuses
  before it claims anything, so no Quota is spent and no Call row is written.
  This is the honest state — waiting to be called — and Stop clears it. The
  alternative, marking somebody unreachable after one silence because the
  account cannot dial, would contradict #17's own acceptance criteria and set a
  Needs Attention reason describing nothing that happened.
- **`queued` now means two things**, one on `appointments` and one on `calls`.
  They are analogous — both "written down, not yet dialled" — and both are
  documented at their declaration in `lib/db/schema.ts`.
- **A stalled Call cannot hold a slot forever.** In-flight is counted at read
  time with the same staleness rule as `lib/business/active-calls.ts`: a Call
  cannot outlive `max_call_duration_ms`, so a row older than that plus slack is a
  missing delivery rather than a Call. No cleanup job, nothing to schedule,
  nothing that can itself fail.
- **A no-answer now rewrites the Appointment**, which the replay script had to
  be restructured around: `call-ended-no-answer` no longer shares the Appointment
  every other ending is delivered to.

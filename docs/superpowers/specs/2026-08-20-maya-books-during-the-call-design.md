# Design: Maya books through the Tools, during the call

**Issue:** [#12](https://github.com/anushapundir/callzie/issues/12)
**Date:** 2026-08-20
**Status:** Implemented and verified on a live Web Call, 2026-08-21. See
`docs/superpowers/plans/2026-08-20-maya-books-during-the-call.md`

## What the live Call proved, and what it broke

Two Web Calls on 2026-08-21, against a tunnelled localhost so the Tools ran this
branch's code.

**Call one — the negotiation fix works, and exposed a bug this design missed.**
Three rounds, nine distinct times, no repeats: the thing this ticket exists for.
Then the customer accepted 12:30 and Maya said *"I'll book Monday 24 August at
12:30 PM. I'm placing a hold for that time now"* — and never invoked `book_slot`.
The customer hung up believing she was booked. Nothing was written and, because
the Call lasted 65 seconds, the `NEAR_CAP_SECONDS` rule stayed silent too.

That is SPEC.md §3 rule 7 happening for real, and no test would have found it:
the endpoints all behaved correctly. Four changes followed —

1. the prompt tells her to call `book_slot` the moment they accept and to say
   nothing about the booking until it answers;
2. the `book_slot` filler became *"Please hold for a moment while I book that
   in"*, which promises effort rather than an outcome;
3. `COMMITTED.booked` leads with *"That's booked in"*, spoken only after the
   write;
4. **`negotiation_truncated` now fires on `offersMade && !committed` at any
   duration.** The 120s cap turned out to be the rarer half of SPEC.md §5's
   reason — a negotiation can be abandoned in 65 seconds.

**Call two — booked, and the row moved mid-call.** `book_slot` committed at
12:30, the Appointment read `rescheduled` while `calls.status` was still
`in_progress`, and Maya spoke the `say` value verbatim.

**But she narrated once more anyway**, saying *"you're all set… I'll proceed to
book that slot now"* a turn before invoking the Tool — against a prompt clause
written that morning to forbid exactly that. The booking landed, so the outcome
was right. The lesson is the one this codebase keeps relearning: change 4 is the
part that holds, and changes 1–3 are the part that helps. See ADR-0012.

## What changed while building it

Four things, each recorded because the reasoning matters more than the edit:

1. **No `book-slot-taken.json` fixture.** A `book_slot` failure is forced by
   *state* — the constraint refuses the write because another Appointment holds
   the Slot — so a second fixture would be byte-identical to `book-slot.json`
   apart from a placeholder the test fills in anyway. The route test seeds a
   competing Appointment instead, which reproduces the whole path with no spend.

2. **The retry-count test needed its own file.** `vi.mock` is hoisted to the top
   of whichever file it appears in, so putting the `rescheduleAppointment` spy in
   `book-slot.test.ts` would have mocked the module for eleven tests that want
   the real one. `lib/tools/book-slot-retry.test.ts` wraps the real function
   rather than replacing it, so its database assertions are still about real
   behaviour and all it adds is a count.

3. **Four more assertions broke than expected.** This design said
   `confirm-cancel.test.ts` asserts on the Appointment row rather than the whole
   response body. It does both, and `one-booking.test.ts` compares a whole body
   too. Adding an optional field to a result type is not a backwards-compatible
   change to a suite that uses `toEqual` — worth knowing before the next field.

4. **`npm run typecheck` needs `npx next typegen` first in a fresh worktree.**
   Next 16 generates the `PageProps` and `LayoutProps` globals into `.next/types`
   during `dev` or `build`, so a clone that has never run either reports six
   errors in files nobody touched. Not a regression, and not something this
   ticket changed — but the next person to typecheck a fresh worktree will hit
   it.

## Summary

This is the product. The person says the time does not work, Maya checks real
Availability, offers Slots until one lands, and commits the Reschedule before
they hang up. SPEC.md §7's negotiation — 10am unavailable, offer noon, noon
refused, offer 4pm, book it, read it back — has to work end to end.

Most of the machinery already exists. #10 built the four Tool endpoints and
proved them; #11 built the Web Call and the live dashboard refresh. What is
missing is smaller than the ticket looks, and it is four things:

**The negotiation cannot progress.** `check_availability` returns the next three
open Slots and ignores `preferred_time`. A second call in the same conversation
returns the *same three times* Maya just had refused. Today the negotiation
loops until the 120s cap.

**Nothing writes `negotiation_truncated`.** The reason is in the schema and in
SPEC.md §5's table, and no code sets it.

**Nothing pins what Maya says when a Tool fails.** `book_slot` returns
`{ ok: false, reason: "slot_taken" }` and the sentence is left to the model.
SPEC.md §3 rule 7 — never state a booking succeeded when it did not — is the
most damaging failure available to this product, and it is currently defended by
one line of prompt.

**The failure path is not reproducible.** There is no fixture that forces
`book_slot` to fail, so SPEC.md §8's path has never been driven end to end.

One principle runs through all four: **enforce in the Tool, never in the prompt**
(SPEC.md §3 rule 6). #10 applied it to Business Hours and to which Slots may be
booked. This ticket applies it to which Slots are offered next, and to the words
Maya is handed when something goes wrong.

## What already exists

From #10 (`docs/superpowers/specs/2026-08-19-tool-endpoints-design.md`):

- All four Tool endpoints, behind `INTERNAL_SECRET`, one transaction per call.
- `lib/tools/offers.ts` — `book_slot` replays this Call's
  `check_availability` rows and refuses any `slot_start` we did not name
  (ADR-0011). "Only offer times check_availability returned" is already enforced,
  not suggested.
- `tool_invocations_one_booking_per_call` — a partial unique index. One
  Reschedule commits per Call however many Offers preceded it, and the whole
  transaction rolls back if a second is attempted.
- `book_slot`'s two attempts (SPEC.md §8 step 1) and its
  `needs_attention_reason = 'book_failed'` write (step 3).
- `cancel_appointment` freeing the Slot, `confirm_appointment` holding it.

From #11 (`docs/superpowers/specs/2026-08-19-web-call-connects-design.md`):

- The Web Call path, the Quota claim, and the microphone ordering.
- `LiveCallProvider` calling `router.refresh()` every 5 seconds while a Call is
  live. **The dashboard row already changes before the call ends** — nothing in
  this ticket needs to build that, only to give it something to show.
- `lib/calls/record.ts` — the three browser-reported writes, each scoped to the
  Business inside its own WHERE clause, each refusing to overwrite an outcome a
  Tool committed.

So three of the six acceptance criteria are already largely satisfied by code on
`main`. This design says so plainly rather than rebuilding them, and Part 5 pins
each one with a test at the level the criterion is written.

## What #12 does not own

- **The Needs Attention screen.** This ticket writes
  `negotiation_truncated`; #15 renders it, alongside the `book_failed` rows #10
  already writes.
- **The Call detail screen.** #16 reads `tool_invocations` and shows what Maya
  did.
- **Webhooks.** #13. A Tool call is not a webhook — Retell posts it
  synchronously and waits for the answer. Part 3 is deliberately shaped so #13
  can reuse its decision rather than write a second copy.
- **Extraction.** #14. Tools record what the Agent *did*; extraction records what
  was *said*, and never overwrites the first (SPEC.md §9 step 3).
- **Parsing `preferred_time`.** See decision 2.

---

## Decisions taken during brainstorming

### 1. A second `check_availability` subtracts what this Call already offered

The negotiation moves forward because the endpoint refuses to repeat itself, not
because the model is asked nicely to vary. `offeredSlotsInCall` already returns
the set of every `slot_start` named so far, so this is a filter over a set we are
already computing for `book_slot`.

*Rejected:* a `round` or `after` argument on the tool schema, so the model asks
for "the next three". It reopens #9 and needs four Agents re-provisioned, and it
hands the model a lever it can get wrong. The server knows what it said; it does
not need to be told.

*Rejected:* offering more than three at once. SPEC.md §7 fixes the number at
three, and nobody holds five times in their head down a phone line.

### 2. `preferred_time` stays unparsed

#10's design doc calls a phrase parser "the first thing to revisit after #12",
and that judgement still holds. Subtracting past Offers delivers what a refusal
usually means — "not those, what else" — without a parser that can be
confidently wrong about a time. Being confidently wrong is the failure class this
product exists to refuse.

The argument is still recorded on every invocation, so the phrases people really
use accumulate in `tool_invocations.arguments` and a future parser can be built
against real data rather than imagined data.

### 3. The Tool supplies the sentence, not just the reason

Every Tool result gains an optional `say` — the words Maya is handed. The
failure lines are the point: a response that says
`"I couldn't lock that in — I'll have someone call you back to confirm."`
cannot be read as a success, where a bare `reason: "slot_taken"` leaves the
model to compose one.

*Rejected:* leaving it to the prompt. A prompt instruction is a suggestion
(SPEC.md §3 rule 6), and this is the one rule whose violation would damage a real
business.

*Rejected:* Retell's `response_variables`, which maps response fields into
dynamic variables. Same outcome, plus a re-provisioning step and a second place
for the wording to live.

**Stated honestly:** `say` is a strong steer, not a guarantee. Retell's
`speak_after_execution` has the model generate speech from the tool response, so
it may paraphrase. What it cannot do is read a response whose every field says
"this did not work" and conclude that it did.

### 4. Truncation is decided by one pure function, called from two places

`wasNegotiationTruncated` takes facts and returns a boolean. `recordCallEnded`
calls it now with what the server can prove; #13's webhook calls it later with
Retell's own `disconnection_reason`. One rule, two callers, no copy to drift.

*Rejected:* letting the browser report "the call was cut off". The browser can
claim anything, and `lib/calls/record.ts` already refuses to accept a duration
from it for the same reason.

*Rejected:* waiting for #13 entirely. Acceptance criterion 5 belongs to this
ticket, and the Web Call is the demo path (SPEC.md §16).

---

## Part 1 — The negotiation moves forward

### The change

`lib/tools/check-availability.ts` gains one step. Today:

```
find open Slots → take the first 3 → format
```

After:

```
find open Slots → drop any this Call already offered → take the first 3 → format
```

The set comes from `offeredSlotsInCall(tx, context.callId)`, which
`lib/tools/book-slot.ts` already calls. Slots are compared on
`startsAt.toISOString()`, the same token the offer set holds and the same one
`book_slot` normalises to — so there is exactly one spelling of an instant in
this path.

### What this does to the conversation

```
Maya: "I have Thursday 21 August at 10:00 AM, 12:00 PM or 2:00 PM."
Them: "None of those work, I'm away Thursday."
Maya: "How about Friday 22 August at 10:00 AM, 12:00 PM or 2:00 PM?"
Them: "Friday at 12 is perfect."
```

Round two returns the next three open Slots rather than repeating round one's.

### Booking stays cumulative

`book_slot`'s check is unchanged and must stay unchanged: it looks at *every*
`check_availability` row on the Call, not the most recent one. So "actually, the
first one you said" still books, even though round two did not include it. The
endpoint refuses to *re-offer* a time; it does not refuse to *honour* one.

That asymmetry is the design, and it is worth stating because the two rules read
like they should be the same rule.

### When there is nothing left

Filtering can empty the list — a Business with four open Slots in a fortnight
runs out in round two. That returns `{ ok: true, slots: [], say: ... }`, not a
failure: a fully booked fortnight is a fact about the Business, not a broken
Tool. #10 already made that call for the never-open case and it holds here.

`say` matters most in exactly this case, because SPEC.md §7's prompt has no
branch for "nothing open" and an unguided model will improvise one. Part 2
supplies the words.

---

## Part 2 — The Tool supplies the sentence

### `lib/tools/say.ts` — new

Every sentence a Tool can hand Maya lives in one module, in two groups. The
grouping is the safety property, not tidiness:

```ts
/** Lines that may tell the customer something was committed. */
export const COMMITTED = {
  booked: (time: string) => `You're all set for ${time}.`,
  alreadyBooked: "You're already booked in — there's nothing else to change.",
  confirmed: "That's locked in, thanks.",
  cancelled: "That's cancelled, thanks for letting me know.",
};

/** Lines for when nothing was committed. None of these may claim otherwise. */
export const NOT_COMMITTED = {
  bookFailed:
    "I couldn't lock that in — I'll have someone call you back to confirm.",
  notAvailable: "That time isn't available — let me check what else we have.",
  nothingOpen:
    "I don't have anything open in the next two weeks. " +
    "I'll have someone call you back.",
  wentWrong:
    "Something went wrong on my end — I'll have someone call you back.",
};
```

`alreadyBooked` sits in `COMMITTED` deliberately. A second `book_slot` is
refused, but a Reschedule *did* commit earlier in the same Call, so telling the
person they are booked is true. Putting it in the other group would make the test
below either wrong or toothless.

### Which line goes where

| Tool | Situation | Line |
|---|---|---|
| `check_availability` | one or more Slots | *none* — she offers them from `slots[].time` |
| `check_availability` | no Slots left | `nothingOpen` |
| `book_slot` | committed | `booked(booked_time)` |
| `book_slot` | `slot_taken` after both attempts | `bookFailed` |
| `book_slot` | `not_offered`, `invalid_time`, `in_the_past` | `notAvailable` |
| `book_slot` | `already_booked` (the one-booking index) | `alreadyBooked` |
| any | `error` from `runTool`'s catch | `bookFailed` for `book_slot`, else `wentWrong` |

**No `say` when Slots come back.** Maya has to offer three times in her own
words and react to the answer; handing her a script would make her sound like an
IVR, and the times are already in `slots[].time` in the form she should read them
(`lib/tools/spoken-time.ts` — "Thursday 21 August at 2:00 PM").

**`runTool`'s catch already branches on the tool name** to recognise the
one-booking index, so choosing between `bookFailed` and `wentWrong` there costs
nothing new.

### The test that earns this module

```
every line in NOT_COMMITTED contains no success language
```

Asserted against a list of phrases — "all set", "locked in", "booked", "done",
"confirmed" — so a future edit that softens a failure line into a reassuring one
fails the suite rather than a real call.

---

## Part 3 — The truncated negotiation

### `lib/calls/truncation.ts` — new, pure

```ts
export const CAP_SECONDS = 120;          // SPEC.md §7's max_call_duration_ms
export const NEAR_CAP_SECONDS = 115;     // the browser's view of the same thing

export function wasNegotiationTruncated({
  durationSeconds,
  committed,
  disconnectionReason,
}: {
  durationSeconds: number | null;
  /** Did any Tool write an outcome on this Call? */
  committed: boolean;
  /** Retell's own word for why the call ended. #13 supplies it; #12 does not. */
  disconnectionReason?: string | null;
}): boolean;
```

Three rules, in order:

1. `committed` → **false**, always. A Call that booked, confirmed or cancelled
   has an outcome, whatever else happened to it.
2. `disconnectionReason === "max_duration_reached"` → **true**. Retell's own
   string (`docs/verification.md` A9), and the authoritative answer when it is
   available.
3. Otherwise `durationSeconds >= NEAR_CAP_SECONDS` → **true**.

Rule 3 is the Web Call's approximation. The browser reports that the Call ended
but not why, so "it ran to about the cap with nothing decided" is the best the
server can prove today. 115 rather than 120 because the SDK's `call_ended` and
the server's `now()` are not the same clock.

**"Committed" means a write, not any Tool call.** A successful
`check_availability` commits nothing — it is a question with an answer. So the
query counts successful `book_slot`, `confirm_appointment` and
`cancel_appointment` rows only.

### Wiring it into `recordCallEnded`

`lib/calls/record.ts` already completes the Call and computes the duration
server-side from `started_at`. It gains one step after that:

```
complete the Call → did any Tool commit? → wasNegotiationTruncated?
  → if so, set needs_attention_reason = 'negotiation_truncated'
```

**Only when the column is null.** `book_slot` may already have written
`book_failed`, and that is the more specific reason — a Call that tried and
failed to book is not the same as one that never got there. A conditional UPDATE,
not a read followed by a write, for the reason SPEC.md §3 rule 8 gives.

The Appointment's `status` is untouched by this. `releaseAppointment` already
returns it to `pending` if and only if it is still `calling`, which is exactly
"nothing decided it". Acceptance criterion 5 — a truncated negotiation does not
record as a completed booking — is satisfied by that existing guard; this part
adds the human-visible half.

### What a human sees

A row in the Needs Attention surface (#15) saying the call ran out of time before
anything was agreed, with a Clear action. Callzie will not call that person again
until someone clears it (SPEC.md §5). It stops and asks — SPEC.md §16 step 7,
"the part that makes it safe to point at a real business's calendar".

---

## Part 4 — The prompt, and re-provisioning

`lib/retell/templates.ts` `buildPrompt` gains two clauses, applied identically to
all four Templates so the structure stays single-copy
(`lib/retell/templates.test.ts` asserts that by rendering all four and comparing):

1. **A branch for nothing open.** Step 3 currently assumes
   `check_availability` always returns something. One sentence: if it comes back
   empty, say so and end the call.
2. **One line about `say`.** When a tool response includes `say`, use those
   words. This is a suggestion — which is the honest description of anything in
   a prompt — layered on top of a response that is already unambiguous on its
   own.

Then `npm run create-agents`. The script reconciles on agent name rather than
creating blindly (ADR-0006), so re-running it updates the four existing Agents.

**This is the only step in the ticket that touches Retell's stored
configuration**, and it must run before the live Call in Part 6.

---

## Part 5 — Tests, one per acceptance criterion

Everything below runs against the embedded Postgres in `vitest.globalSetup.ts`
and contacts nobody. SPEC.md §3 rule 11: no automated test places a real Call.

| Criterion | Test |
|---|---|
| Multi-round negotiation ends with the Appointment moved | `app/api/tools/routes.test.ts` — two checks, asserting round two's `slot_start`s are disjoint from round one's, then a `book_slot` on a round-two Slot, then the Appointment row read back at the new time |
| Maya only offers times `check_availability` returned | Already covered ("refuses a Slot the Agent invented"). Extended: a Slot from round one still books after round two has moved on |
| Cancelling frees the Slot; confirming holds it | Already covered in `lib/tools/confirm-cancel.test.ts` and the route tests. Left alone |
| Forced failure → one silent retry, callback promise, needs-attention, no success claim | New route test driven from the fixture below |
| Truncated negotiation does not record as a booking | `lib/calls/truncation.test.ts` for the rule; `lib/calls/record.test.ts` for the write and for not stomping `book_failed` |
| The failure path is reproducible from a fixture with no spend | The fixture, plus a leg in `scripts/try-tools.ts` |

### The forced-failure fixture

A `book_slot` failure cannot be forced by a payload. The endpoint fails because
of *state* — `appointments_no_overlap` refuses the write because another
Appointment holds that Slot. So the fixture is an ordinary `book_slot` body whose
`slot_start` placeholder the test fills with a Slot it has deliberately given
away:

```
1. seed an Appointment and a Call, as #10's tests already do
2. check_availability            → three Slots offered
3. seed a second Appointment onto the first offered Slot
4. POST fixtures/retell/tools/book-slot-taken.json with that slot_start
```

What is asserted:

- The response is `{ ok: false, reason: "slot_taken", say: <bookFailed> }`.
- `say` contains the callback promise and no success language.
- `tool_invocations` holds the failed `book_slot` with its arguments, its result
  and `succeeded: false` — the retry is silent to the *customer*, not to the
  record.
- The Appointment still holds its **original** Slot (SPEC.md §8 step 3).
- `needs_attention_reason` is `book_failed`.

Proving "two attempts, not one" needs a seam rather than a fixture: the second
attempt only happens if the first fails, and both fail identically here. A unit
test in `lib/tools/book-slot.test.ts` counts calls to a stubbed
`rescheduleAppointment` — the existing file already stubs at that level.

### `scripts/try-tools.ts`

Gains a forced-failure leg after the existing negotiation, so the whole path can
be driven by hand over real HTTP against a real database without placing a Call.
It cleans up after itself exactly as it does today, guarded by the name marker.

---

## Part 6 — The one live Call

One Web Call in the browser, ~$0.15, run manually (SPEC.md §3 rule 11). It is
the M3 checkpoint: "a browser conversation with Maya rebooks an Appointment and
the row updates before hangup."

It also settles the two items `docs/verification.md` marks as pending
"issue #12's first live Tool invocation":

- **A12** — whether Retell forwards `Authorization` unmodified. If it does not,
  `lib/tools/auth.ts` already accepts `X-Callzie-Secret` as a fallback, so the
  Call still works and the answer is read off `tool_invocations`.
- **A4/A12** — whether `create-web-call` runs the draft Agent or the published
  one. If the prompt changes from Part 4 do not take effect, they do not, and
  `scripts/create-agent.ts` needs one `publish` call per Agent.

Both answers get written back into `docs/verification.md` with the date.

---

## File-by-file changes

**New**

| File | Responsibility |
|---|---|
| `lib/tools/say.ts` + `.test.ts` | Every sentence a Tool can hand Maya, in two groups |
| `lib/calls/truncation.ts` + `.test.ts` | The truncation rule. Pure |
| `fixtures/retell/tools/book-slot-taken.json` | A `book_slot` body for a Slot that has been given away |
| `docs/adr/0012-the-tool-supplies-the-sentence.md` | Decisions 3 and 4, with what was rejected |

**Modified**

| File | Change |
|---|---|
| `lib/tools/check-availability.ts` | Subtract this Call's earlier Offers; `say` when empty |
| `lib/tools/book-slot.ts` | `say` on every return |
| `lib/tools/confirm-appointment.ts`, `cancel-appointment.ts` | `say` on success |
| `lib/tools/run.ts` | `say` on the two catch-path results |
| `lib/calls/record.ts` | Ask whether a Tool committed; write `negotiation_truncated` |
| `lib/retell/templates.ts` | The empty-Availability branch and the `say` line |
| `app/api/tools/routes.test.ts` | Multi-round negotiation; the forced failure |
| `lib/tools/check-availability.test.ts` | Round two is disjoint from round one |
| `lib/tools/book-slot.test.ts` | Two attempts, counted |
| `lib/calls/record.test.ts` | The truncation write, and not stomping `book_failed` |
| `scripts/try-tools.ts` | The forced-failure leg |
| `docs/verification.md` | A12 and A4 answered after the live Call |
| `fixtures/retell/tools/README.md` | The new fixture and why state, not payload, forces the failure |

## Out of scope

- Parsing `preferred_time`. Decision 2.
- Rendering Needs Attention (#15) or the Call detail screen (#16).
- Webhooks (#13) and extraction (#14).
- Google Calendar push on a Reschedule (#20, behind a flag).
- Any Phone Call (#19).

## Known limitations, stated deliberately

- **`preferred_time` is still ignored.** She will pass "Thursday afternoon" and
  receive Friday morning. Subtracting past Offers makes the conversation
  progress; it does not make it listen.
- **`say` is a steer, not a guarantee.** The model generates the audio. What the
  response makes impossible is *concluding* success from a failure.
- **Truncation is inferred from duration on the Web Call path.** A person who
  hangs up at 116 seconds with nothing agreed is recorded the same as one cut off
  by the cap. Both want a human to call back, so the wrong answer costs a row in
  a queue rather than a wrong action. #13 replaces the inference with Retell's
  own reason.
- **Round two can come back empty for a quiet Business.** Honest, and `say`
  covers it — but a Business with a nearly full fortnight gets one round of
  Offers, not several.
- **The retry count is proved by a stub, not by the database.** Two real
  constraint violations in a row cannot be told from one without a seam.

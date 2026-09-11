# Design: The Needs Attention surface

**Issue:** [#15](https://github.com/anushapundir/callzie/issues/15)
**Date:** 2026-08-21
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-needs-attention-surface.md`

## Summary

Four independent failures converge on one column. `book_failed` when a booking
lost its race, `collision` when Google Calendar holds something in the same
window, `negotiation_truncated` when a conversation named times and committed
nothing, and `unreachable` when nobody picked up on the final attempt.

An Appointment carrying any of them is **blocked from calling until a human
clears it**. That is the whole point of the feature, and it is worth saying why
in plain terms: phoning somebody to confirm a time that is about to change is
worse than not phoning at all.

Three things this design is careful about.

**The block lives in one place on the server.** `lib/calls/start-web-call.ts` is
the only function that turns a request into a Call. Refusing there means Call
all (#17) and the Phone path (#19) inherit the rule without knowing it exists.
Four call sites would be four places for it to drift, and the drift would be
invisible until somebody got phoned who should not have been.

**Clearing is the only resolution, and it changes exactly one column.** Not the
Slot, not the status, not the Call history. SPEC.md §14 rules 2 and 3 both say
Callzie hands over rather than deciding, and a Clear action that also tidied the
row up would be Callzie deciding.

**The Slot is held by the database, not by this code remembering to.**
`unreachable` is absent from `SLOT_FREEING_STATUSES` (`lib/db/schema.ts:69`), so
the `appointments_no_overlap` exclusion constraint keeps holding the range on its
own. SPEC.md §14 rule 2 is structural here, not a rule somebody has to follow.

## What already exists

More of this ticket is built than it looks. Two of the six acceptance criteria
are met before any code is written.

| Already built | Where | What it gives us |
|---|---|---|
| The column and its four values | `lib/db/schema.ts:45` | `NEEDS_ATTENTION_REASONS`, already a typed union |
| The stat strip count | `lib/business/appointment-stats.ts:48` | "counted in the stat strip" — done, no change |
| The Collision marker on Schedule | `lib/schedule/day-layout.ts:191` | The day view already reads the column |
| `book_failed`, written for real | `lib/tools/book-slot.ts:136` | Its own comment says "#15 renders this; #10 only writes it" |
| `negotiation_truncated`, two writers | `lib/calls/record.ts:141`, `lib/extraction/outcome.ts:119` | The duration rule and the spoken-new-time fallback |
| The Slot-holding guarantee | `lib/db/schema.ts:69` + `drizzle/0001_appointments_no_overlap.sql` | An `unreachable` Appointment cannot have its range taken |
| The conditional-UPDATE pattern | `lib/calls/record.ts:138` | `flagTruncated` puts the guard inside the `WHERE` |
| The pure-predicate pattern | `lib/calls/truncation.ts` | One rule, two callers, no second copy |
| Two amber inline panels to copy | `components/overview/call-alerts.tsx`, `csv-rejections.tsx` | The exact §11.4 shape, tokens and a11y notes included |
| A no-answer webhook fixture | `fixtures/retell/webhooks/call-ended-no-answer.json` | The `unreachable` path is testable with zero telephony |
| Network-free test Postgres | `vitest.globalSetup.ts` | A real database, on this machine, per run |

No new dependencies. Nothing new to wire into the deploy.

## Decisions taken during brainstorming

1. **#15 owns the `unreachable` writer. #20 keeps `collision`.** The issue lists
   #10, #13 and #14 as blockers and all three are closed, but the four reasons
   are not all written yet. `unreachable` was deferred to #17 by the extraction
   design; we pull it here, because #15's own acceptance criteria name the
   Slot-holding rule and #17 is not a blocker. Without it, three of the four rows
   this surface exists to show could never appear.

   `collision` stays with #20. There is no Google Calendar code in the repo at
   all — writing a detector here would be inventing #20's design inside somebody
   else's ticket. The surface renders `collision` correctly from day one; #20
   supplies the write.

2. **The final attempt is the second one.** `MAX_CALL_ATTEMPTS = 2`. The first
   no-answer leaves the Appointment callable; the second sets it `unreachable`.

   Rejected: flagging on the first no-answer. It reads as the strictest version
   of "never call again until a human clears it", but it forecloses #17 entirely
   — the block would fire before the retry #17 exists to make. One missed call is
   not an unreachable person.

   Rejected: flagging when the Quota is spent. That ties an Appointment-level
   fact to an account-level one, so topping the Quota up would silently
   un-finalise attempts that already happened.

3. **`unreachable` writes both columns.** `status = 'unreachable'` and
   `needs_attention_reason = 'unreachable'`. They are orthogonal (SPEC.md §5) and
   here they are both true: the status is what the Appointment is, the reason is
   why Callzie stopped. The status alone would not block calling; the reason
   alone would leave the row's Status pill saying `pending` about somebody who
   was never reached.

4. **The block is a refusal, not a hidden button.** `startWebCall` returns
   `reason: "needs_attention"` before the Quota is claimed, so a blocked press
   costs nothing. The button is *also* disabled in the browser.

   That looks like it contradicts `components/calls/call-now-button.tsx:15`,
   which says the Quota is deliberately not checked client-side. It does not.
   The Quota is an account-wide number another tab can spend, so a client-side
   guess goes stale; `needs_attention_reason` is a fact on the row already
   rendered. Disabling on a fact you are holding is honest. The server refuses a
   forged POST either way.

5. **Tool endpoints are not gated.** `book_slot` and the rest keep working on a
   flagged Appointment. The rule is "no further calling", and no Call can start,
   so no Tool can run mid-conversation. Gating them as well would add a second
   rule with no reachable failure behind it.

6. **One amber panel, one row per Appointment.** Rejected: grouping by reason,
   which with a 5-Call Quota produces four headings over one or two rows;
   rejected: a table, because a reason sentence either truncates in a cell or
   blows the column widths out, and it would need a second stacked layout under
   768px like `appointments-table.tsx` already carries.

7. **No confirmation dialog on Clear.** It is one column, the Appointment stays
   in the table below, and every reason is re-derivable by looking at the Call.
   A confirm step on a queue somebody works through ten rows at a time is
   friction with nothing behind it.

## Architecture

### New files

| File | Responsibility |
|---|---|
| `lib/business/needs-attention.ts` | `listNeedsAttention(businessId)` — the flagged rows the panel renders |
| `lib/appointments/attention-reason.ts` | Pure reason → sentence. No React, no database |
| `lib/appointments/clear-attention.ts` | `clearNeedsAttention(businessId, appointmentId)` |
| `components/overview/needs-attention.tsx` | The panel. Server Component |
| `components/overview/clear-attention-button.tsx` | The one client island |

### Changed files

| File | Change |
|---|---|
| `lib/calls/start-web-call.ts` | Read the column in the existing select; refuse before the Quota claim |
| `lib/business/list-appointments.ts` | `AppointmentRow` carries `needsAttentionReason` |
| `components/overview/appointments-table.tsx` | Pass it to the row's button |
| `components/calls/call-now-button.tsx` | A `blocked` prop — disabled, with a `title` saying why |
| `app/(app)/actions.ts` | `clearAttentionAction` |
| `app/(app)/page.tsx` | Load and render the panel |
| `scripts/replay-webhook.ts` | Prove the new path, and clear it before the next step |
| `lib/settings/hours-conflicts.test.ts` | Not anticipated. It builds an `AppointmentRow` literal, so the new required field broke it |

## The unreachable rule

`lib/calls/unreachable.ts` is shaped deliberately like `lib/calls/truncation.ts`:
a constant, an input type, and a pure function that decides. The decision is
testable without a database and without Retell, and #17 changes one predicate
rather than editing a webhook handler.

```ts
export const MAX_CALL_ATTEMPTS = 2

export type UnreachableInput = {
  /** After `mapDisconnectionReason`. Only `no_answer` can reach the rule. */
  callStatus: CallStatus
  /** `calls.attempt` on the Call that just ended. */
  attempt: number
}

export function wasFinalNoAnswer({ callStatus, attempt }: UnreachableInput): boolean
```

`no_answer` is the mapped status, so voicemail and a declined call reach it too —
`lib/webhooks/status.ts:39` already puts `voicemail_reached` and `ivr_reached`
there, and says why: a machine answering is not the person answering.

The writer goes in `lib/calls/record.ts` directly beneath `flagTruncated`, not
beside its own predicate. That is the split the repo already makes —
`truncation.ts` decides and `record.ts` writes — and `lib/webhooks/process.ts`
already imports `releaseAppointment` from there. It mirrors `flagTruncated`
exactly:

```sql
UPDATE appointments
   SET status = 'unreachable', needs_attention_reason = 'unreachable'
 WHERE id = $1
   AND needs_attention_reason IS NULL
   AND status IN ('calling', 'pending')
```

Both guards are inside the `WHERE`, not in a read followed by an `if`, for the
reason SPEC.md §3 rule 8 gives — two workers handling a redelivered event cannot
both win a check they each made before writing.

The reason guard means a more specific reason already there survives. The status
guard means a Tool-written `confirmed` or `rescheduled` is never overwritten;
that combination should be unreachable in practice, since a no-answer Call has
nobody in it to commit anything, but the guard costs one clause.

**The browser path is untouched.** `recordCallFailed` writes `failed`, never
`no_answer` — only Retell's own disconnection reasons produce it. So this is a
webhook-only path, which is correct: the browser knows a Call ended, not why.

## The surface

Renders between the Quick Call card and the Appointments table, following
SPEC.md §11.3's own numbering. `return null` when the list is empty — the
section does not exist on a healthy account, rather than existing as an empty
state.

```
┌─ Needs attention ────────────────────────────────┐
│ 3 appointments need attention                    │
│ Callzie will not call these until you clear them.│
│                                                  │
│ Priya Nair · 14 Aug, 09:00           [ Clear ]   │
│ Maya could not book the new time. The original   │
│ 09:00 slot is still held.                        │
│ ──────────────────────────────────────────────── │
│ Sam Patel · 14 Aug, 11:30            [ Clear ]   │
│ Nobody answered after 2 attempts. The 11:30 slot │
│ is still held.                                   │
└──────────────────────────────────────────────────┘
```

A `<section aria-labelledby>`, not `role="alert"` — the same call
`call-alerts.tsx:50` documents. This is persistent, and a live region would have
a screen reader re-announce the whole list on every unrelated re-render of the
page, of which there is one after every quick-add.

Amber (`border-attention`, `text-attention`) because §11.2 gives Needs Attention
its own token. Red stays reserved for the person on the phone saying no.

### The sentences

`lib/appointments/attention-reason.ts` takes `{ reason, slotLabel, attempts }`
and returns one sentence. Pure, so it is unit-tested without React — the same
split `lib/appointments/status-style.ts` already makes. The Slot is formatted by
the Server Component with `formatInZone`, because a time means nothing without
the Business's timezone and the server should format it once.

| Reason | Sentence |
|---|---|
| `book_failed` | Maya could not book the new time. The original slot is still held — {slot}. |
| `collision` | This clashes with an event on the connected Google Calendar. Callzie will not move either one — decide which keeps the time, then clear this. |
| `negotiation_truncated` | The call ended before a new time was agreed. The slot is still held — {slot}. |
| `unreachable` | Nobody answered after {attempts} attempts. The slot is still held — {slot}. |

Every one of them says what happened and what is still true about the Slot.
That second half is the part a person needs: the common fear when a row appears
in this list is that the appointment has been lost.

All four are written now, `collision` included. #20 supplies the write; the
surface is ready for it.

### Clearing

`clearNeedsAttention` sets one column to null, scoped to the Business inside the
`WHERE` clause. An Appointment id from another account matches nothing and
writes nothing — the same cross-tenant shape as `ownedBy` in
`lib/calls/record.ts:151`.

`clearAttentionAction` in `app/(app)/actions.ts` is the thin wrapper the other
actions in that file already are: `requireBusiness()` first, delegate,
`revalidatePath("/")`. That one line refreshes the panel, the stat strip and the
table's disabled buttons in the same round trip — nothing polled, no client cache
to reconcile.

The button is a client island using `useTransition`, so the loading state sits
on the button that was pressed and not on the page (§11.4).

## Testing

Every path is provable without spending anything.

| What | How |
|---|---|
| `wasFinalNoAnswer` | Pure unit test. Attempt 1 no-answer, attempt 2 no-answer, a `completed` Call at attempt 2, voicemail at attempt 2 |
| The unreachable write | Real Postgres. Both guards: a row already carrying `book_failed` is left alone; a `confirmed` row is left alone |
| The Slot is held | Insert an overlapping Appointment against an `unreachable` one and assert the exclusion constraint refuses |
| The block | `startWebCall` with a flagged Appointment returns `needs_attention` **and the Quota is unchanged** |
| Call all inherits it | Asserted at `startWebCall`, which is the only path #17 can dial through |
| Clearing | Reason becomes null; `starts_at`, `ends_at` and `status` are byte-identical afterwards |
| Cross-tenant | Another Business's Appointment id clears nothing |
| The sentences | Pure unit test, one per reason |
| The panel | Renders nothing when empty; one row per flagged Appointment when not |
| End to end | `scripts/replay-webhook.ts`, below |

### One thing this breaks, found by reading the replay script

`scripts/replay-webhook.ts:236` builds one Call per scenario at
`attempt: index + 1`. The `no-answer` scenario is **attempt 2**. So the moment
the writer lands, that existing step starts flagging the throwaway Appointment
`unreachable` — and the `book_failure` step that runs after it inherits a dirty
row.

It would still pass, because `lib/tools/book-slot.ts:136` writes `book_failed`
unconditionally and would overwrite it. Passing for that reason is worse than
failing.

The fix is the better test anyway. Step 4 asserts `unreachable` was written and
the Slot held, then calls **the same `clearNeedsAttention` the Clear button
calls** before step 5 runs. The replay proves the writer and the clearer in one
pass, with no telephony, and the later steps run against a clean row on purpose
rather than by luck.

## Out of scope

- **The `collision` writer.** #20, with ADR-0004 and the Google flag behind it.
- **Retry and throttling on no answer.** #17. This design leaves it room:
  `MAX_CALL_ATTEMPTS` is one constant and `wasFinalNoAnswer` is one predicate.
- **Any Needs Attention surface outside Overview.** Schedule already marks
  Collisions and SPEC.md §11.3 says to cut it if it grows.
- **Bulk clear.** A 5-Call Quota does not produce a list worth batching.
- **Gating the Tool endpoints.** Decision 5.
- **Notifications of any kind.** Not in SPEC.md.

## Known limitations, stated deliberately

**`collision` is unwritable until #20 ships.** The surface renders it, the copy
exists, and a test writes the column directly to prove the row renders — but no
code path produces one yet. That is the honest state of the feature and the
README should say so.

**Two attempts is a judgement, not a measurement.** Nobody has data on how often
a second Callzie call reaches somebody the first missed. The number is isolated
in one constant so #17 can move it once there is a reason to.

**Clearing loses the reason.** The column goes null and nothing records that it
once held `book_failed`. The Call it came from is still there with its
`tool_invocations`, so the history is recoverable — but the flag itself is not,
and a re-flag on a later Call cannot tell it is a repeat.

**A sighted touch user gets a dead button with no explanation.** The table's
"Call now" explains itself with a `title`, which does not fire on a tap, and the
stacked layout below `md` is the mobile one. Screen readers are covered — both
layouts carry an `sr-only` line pointing at the panel — and so are sighted mouse
users. Nobody else is. `busy` has had the same gap since #11, so this is not
new, but a blocked row makes it worse: `busy` clears itself when the Call ends
and this one waits for a person.

## What #17 took over

This branch built the `unreachable` writer, and #17 (Call All) merged first
with its own. They agreed on everything that mattered — the same threshold of
two, the same Slot-holding, the same "a more specific reason already there
wins" — so keeping both would have meant two writers for one reason, which is
the class of bug this feature exists to prevent.

**#17's won**, and it is the better one: it also knows about retry, so a first
silence requeues rather than doing nothing. Dropped from this branch on the
merge: `lib/calls/unreachable.ts`, `flagUnreachable` in `lib/calls/record.ts`,
and the `applyEnded` wiring. The replay script's section 6 came from #17 too,
with the Clear proof added to it here.

Two things worth recording, because they were decided twice and agreed both
times. #17 named its writer `markUnreachable`, which is the rename the final
review of this branch recommended for `flagTruncated`/`flagUnreachable` —
`flagged` is on CONTEXT.md's `_Avoid_` list and already means "an account
permitted Phone Calls". And #17's `lib/calls/batch/eligible.ts` already skips
an Appointment carrying a reason, citing this issue by number, so Call All
honours the block at the query level as well as through `startWebCall`.

## What was not verified

Two checks the plan asked for could not be run, and neither has been done since.
Both need a `.env.local`, which this worktree does not have.

**Nobody has seen this on a screen.** The plan's Task 9 ends with a manual pass:
flag a row by hand in `db:studio`, confirm the amber panel appears with the
right name, confirm the stat strip reads 1 in amber, press Clear and watch both
drop without a reload. Every part of that is covered by an automated test
somewhere, but the parts have not been watched working together in a browser.

**The replay suite has not been run against this branch.** `scripts/replay-webhook.ts`
now carries the `unreachable` section, and it typechecks and lints — but running
it needs `npm run dev` against a real database, so the assertions have been read
rather than executed. SPEC.md §10 requires the replay to pass before any real
Call is placed, so **this must be run before #19's phone path or any demo
rehearsal**, not merely before merge.

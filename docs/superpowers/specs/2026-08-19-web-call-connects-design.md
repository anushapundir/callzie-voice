# Design: Web Call connects, and the quota holds

**Issue:** [#11](https://github.com/anushapundir/callzie/issues/11)
**Date:** 2026-08-19
**Status:** Implemented, pending one manual Call. See
`docs/superpowers/plans/2026-08-19-web-call-connects.md`

## What changed while building it

Three things this design did not anticipate, each recorded because the reasoning
matters more than the edit:

1. **The three reporters moved into `lib/calls/record.ts`.** They were going to
   live in the Server Action, untested, on the grounds that both halves they
   compose were covered. That was wrong: the cross-tenant guard and the "only if
   still `calling`" condition are the two things in this ticket most worth
   pinning, and neither is testable through an action that needs Clerk. The
   action is now a thin wrapper — authenticate, delegate, revalidate.

2. **One press could become two Calls.** The provider guards `start` on the
   state, but the state ref is written in an effect, so two calls in the same
   tick both read the old value and both reach the server. The reducer refuses
   the second `START`, but by then the second `create-web-call` is already in
   flight — two Retell Calls and two Quota decrements for one press. A ref set
   before the first `await` closes it.

3. **The `error` event carries a string, not an `Error`,** and `startCall`
   swallows its own exception to emit that event rather than rejecting. Read off
   the installed bundle rather than the docs. Also: `stopCall` only emits
   `call_ended` if the Call actually connected — which is why the expiry handler
   has to report the failure itself rather than relying on the event.

## Summary

Pressing "Call now" starts a real conversation with Maya in the browser, and it
ends cleanly. No booking yet — this is the Call connecting, the Quota holding,
and the two failure modes being designed rather than thrown.

Three things this design is careful about:

**Nothing is spent until it cannot be wasted.** The microphone is requested in
the browser *before* any Call row is written and before Retell is contacted. A
person who declines has cost the account nothing, which is what makes the strict
refund rule below painless rather than harsh.

**The Quota is enforced by one SQL statement, not by a read followed by a
write.** Two tabs pressing "Call now" on the fifth Call must not both pass. Same
lesson as `appointments_no_overlap` (SPEC.md §3 rule 8), applied to a counter
instead of a range.

**Every state is reachable from a plain reducer.** Both designed failure
states — microphone declined, and the access token expiring — are unit-tested
without a browser, without Retell, and without spending anything (SPEC.md §3
rule 11).

## What #11 does not own

SPEC.md §11.3 describes the whole Overview screen and §7 the whole voice path.
Most of it belongs elsewhere:

| Surface | Issue |
|---|---|
| The four Tool endpoints at `/api/tools/*` | #10 |
| Maya actually rebooking through the Tools | #12 |
| The webhook receiver, signature and idempotency | #13 |
| Extraction | #14 |
| The Needs Attention section | #15 |
| `/calls/[id]`, the Call detail screen | #16 |
| Call all, throttling, retry on no answer | #17 |
| The Phone Call path and the kill switch | #19 |

**The Tools still 404, and that is accepted.** The four Agents were provisioned
by #9 with Tool declarations pointing at `/api/tools/*`, which #10 has not built.
So during a #11 Call, if the person says the time does not work, Maya calls
`check_availability` and gets a 404 back.

This is written down rather than designed around. #11 proves the confirm
path — "yes, that time works" — and the failure modes. The reschedule path is
#12's entire ticket. Stub routes were considered and rejected: a stub that
answers about Availability is the shape of failure SPEC.md §3 rule 7 exists to
prevent, and it would be deleted in #10 anyway.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Which surfaces get "Call now"? | Both. The Quick Call card's accent button becomes "Call now" and chains the dial onto the same submit; every table row gets its own "Call now". #17 reuses the row button. |
| Is a Call refunded when nobody joins? | Only when the failure is ours and provable on the server — `create-web-call` erroring or timing out. A declined microphone or an expired token stays spent. Before #13's webhooks the only evidence either happened is the browser's own word, and an account that can refund itself by claiming failure can place unlimited Calls. |
| What tells the app a Call is live, before webhooks exist? | The browser. The Retell Web SDK's `call_started` and `call_ended` events call Server Actions that move `calls.status`. #13's webhook later writes the same row and wins, because it is the one source that cannot be forged. |
| Where does the live-Call UI render? | A sticky bar under the topbar, for the life of the Call. It never covers the Appointments table, which is what SPEC.md §16 step 5 — "cut to the dashboard before hanging up" — depends on. |
| Does the Quick Call card keep an "Add appointment" button? | No. SPEC.md §11.3 asks for one accent "Call now" on that card, and that is what it gets. Adding without calling stays possible from CSV upload (#8). |

## Part 1 — The order of operations

This is the load-bearing part of the design. The sequence is chosen so that each
failure costs the least it can.

```
Press "Call now"
  1. browser: getUserMedia({ audio: true })
       denied  → mic_denied state.  Nothing written. Nothing spent.
       granted → stop the tracks, continue
  2. server action startWebCall(appointmentId)
       a. requireBusiness()
       b. load Appointment + Service, scoped to this Business
       c. build the four dynamic variables and VALIDATE them
       d. transaction: claim the Quota + insert the calls row
       e. retell.call.createWebCall(...)
       f. success → store retell_call_id, Appointment → 'calling', return the token
       g. failure → mark the row failed, give the Quota back, refuse
  3. browser: retellWebClient.startCall({ accessToken })
  4. SDK events → server actions → calls.status
```

### Why the microphone comes first

`getUserMedia` is the only step that can prove a failure locally. Asking for it
before anything else means a declined prompt writes no row, contacts no Retell,
and decrements nothing — so the account is exactly where it started.

Put it after the Call was placed and the same decline burns one of five Calls
that we then cannot honestly return, because the browser's claim is unverifiable.
The order is the whole reason the refund rule can be strict.

The permission is requested and the tracks are stopped immediately. The SDK opens
its own stream; all we wanted was the answer.

### Why the variables are validated before Retell is contacted

Retell renders an unset variable literally. A plumbing bug means Maya says
"curly-curly-name" out loud to a customer (docs/verification.md A5). That is a
demo-breaking failure and it is entirely preventable, so it is prevented before
anything is spent rather than discovered on the call.

### Why step (e) sits outside the transaction, and what replaces the rollback

Step (e) is a network call. It cannot participate in a Postgres transaction, and
holding one open across it would hold a row lock for the length of an HTTP
round trip.

So a failure at (e) is handled by a **compensating write** rather than a
rollback: mark the Call row `failed` with `disconnect_reason =
'create_web_call_failed'`, and decrement `calls_used` back. This is the only
refund in the system.

The ordering the issue asks for is preserved exactly — "a Call row is written
before Retell is contacted, and the quota decrements".

### What happens when the Call ends

`calls` gets `status = 'completed'`, `ended_at`, and a duration.

The Appointment goes **back to `pending`, and only if it is still `calling`.**

Nothing decided its outcome. No Tool committed, because no Tool endpoint exists
yet. Leaving it at `calling` would show a permanently-calling row in the table
until #13 ships; setting it to `confirmed` would be the small version of SPEC.md
§3 rule 7. `pending` is where it genuinely is, and the attempts count plus the
last-Call timestamp are what record that a Call happened.

**The condition is not decoration.** Once #12's Tools land, a Tool may write
`confirmed` or `rescheduled` mid-Call, and this handler must not overwrite it.
The Tool wins (SPEC.md §9 step 3). Writing the guard now means the behaviour is
already correct when the Tools arrive.

## Part 2 — The Quota is one statement

The obvious shape — read `calls_used`, compare it to `call_quota`, then write —
has the same defect as a pre-check in front of `bookSlot`. Two tabs both read
"four used" and both write "five", and the account places six Calls.

```sql
UPDATE businesses
   SET calls_used = calls_used + 1
 WHERE id = $1
   AND (is_admin = true OR calls_used < call_quota)
RETURNING calls_used, call_quota, is_admin
```

No row returned means the Quota is gone. Postgres takes a row lock for the
update, so contending statements serialise and the sixth Call cannot slip through
a gap between a read and a write.

**Admin skips the bound but still counts up.** `is_admin` short-circuits the
comparison, so an admin account is never refused. It is set by hand in SQL —
SPEC.md §14 rule 9 rules out roles, so there is no UI for it, and none is added
here.

The counter still increments for an admin. Not for the sidebar's benefit — the
meter renders "Unlimited" alone and shows no number for an admin today, and this
issue does not change that. It increments because `calls_used` is the record of
what the account spent, and a counter frozen at zero while Calls are placed is
simply wrong.

`lib/quota.ts` already translates `is_admin` into `callQuota: null` for the
meter. Nothing there changes.

## Part 3 — New and changed modules

### `lib/calls/dynamic-variables.ts` — new

```ts
export type DynamicVariables = Record<string, string>

export function buildDynamicVariables(input: {
  businessName: string
  name: string
  serviceName: string
  startsAt: Date
  timezone: string
}): DynamicVariables

export function validateDynamicVariables(
  vars: DynamicVariables,
): { ok: true } | { ok: false; missing: string[] }
```

Produces exactly the four keys `PROMPT_VARIABLES` already declares in
`lib/retell/templates.ts` — `business_name`, `name`, `service`, `time` — and
nothing else. `time` is formatted with the existing `formatInZone` in the
Business's own timezone, because a `timestamptz` handed to Retell would be
rejected: all values must be strings (docs/verification.md A5).

`validateDynamicVariables` rejects a missing key, a non-string value, and an
empty string. An empty string is rejected rather than allowed because Retell
replaces it with nothing — Maya would say "your appointment on" and stop.

Pure, no database, no Retell. This is where AC #2 is proven.

### `lib/calls/quota.ts` — new

```ts
export type QuotaClaim =
  | { ok: true; callsUsed: number }
  | { ok: false; reason: "exhausted" }

export function claimCallQuota(tx, businessId): Promise<QuotaClaim>
export function releaseCallQuota(tx, businessId): Promise<void>
```

Part 2's statement, and its compensating opposite. Both take a transaction
handle rather than reaching for `db`, so the claim and the `calls` insert land
together or not at all.

`releaseCallQuota` floors at zero, so a double-release can never produce a
negative count.

### `lib/calls/machine.ts` — new

The reducer behind the sticky bar. Named for the live Call, not a "session" —
CONTEXT.md rules that word out as a synonym for Call.

```ts
export type CallState =
  | { name: "idle" }
  | { name: "requesting_mic" }
  | { name: "mic_denied" }
  | { name: "placing" }
  | { name: "refused"; message: string }
  | { name: "connecting"; callId: string; deadlineAt: number }
  | { name: "live"; callId: string; startedAt: number }
  | { name: "ended"; callId: string }
  | { name: "expired"; callId: string }
  | { name: "failed"; callId: string | null; message: string }

export function reduceCall(state: CallState, event: CallEvent): CallState
```

Three guards carry the design, and each one is a test:

- **`DEADLINE_PASSED` is ignored once `live`.** The 30-second timer is still
  running when the Call connects at second three. Without the guard it fires at
  second thirty and kills a healthy conversation.
- **`SDK_CALL_ENDED` after `SDK_ERROR` does not resurrect.** A failed Call stays
  failed; the SDK may emit both.
- **`SDK_CALL_STARTED` outside `connecting` is ignored.** A late or duplicated
  event cannot re-open a finished Call.

`refused` and `failed` are separate states because their causes and their Quota
consequences differ. `refused` is the server declining before the Call
existed — Quota exhausted, or variables invalid, or `create-web-call` failing,
in which case the Quota has already been returned. `failed` is a Call that
existed and broke.

### `lib/calls/start-web-call.ts` — new

Part 1's steps (a) through (g), with the Retell client passed in rather than
constructed, so tests exercise the whole orchestration against a fake and no test
ever contacts Retell.

```ts
export type StartWebCallResult =
  | { ok: true; callId: string; accessToken: string; deadlineAt: number }
  | {
      ok: false
      reason: "exhausted" | "invalid_variables" | "retell_failed"
      message: string
    }
```

`call_type` is the literal `'web'`. There is no branch on
`phone_calls_enabled` anywhere in this file, because there is nothing here that
could place a Phone Call — #19 adds that path and its own guard. A test asserts
the written row is always `web` (SPEC.md §3 rule 9).

`attempt` is the Appointment's existing Call count plus one. A second Call is a
second `calls` row, per CONTEXT.md.

### `lib/business/active-calls.ts` — new

```ts
/** The 120s cap (SPEC.md §7) plus slack. A Call older than this is not live. */
export const LIVE_CALL_STALENESS_MS = 180_000

export function countActiveCalls(businessId, now?): Promise<number>
export function liveCallAppointmentIds(businessId, now?): Promise<Set<string>>
```

Both read `calls.status = 'in_progress'` **and** `started_at` inside the
staleness window, joined to Appointments of this Business.

The window is the answer to "the tab closed mid-Call". The browser is what
reports the end, so a closed tab reports nothing and the row stays
`in_progress` forever — which would leave the pulsing dot on permanently. A Call
that cannot outlive `max_call_duration_ms` simply stops counting after three
minutes. No background job, no cleanup process, nothing to schedule.

`now` is injected, matching `slots.ts` and `seed-schedule.ts`, so the test does
not depend on the clock.

### `lib/business/list-appointments.ts` — changed

`AppointmentRow` gains `isCalling: boolean`, from `liveCallAppointmentIds`. The
existing second-query-folded-in-JavaScript shape is unchanged; this is one more
lookup against the same bounded set.

### `app/(app)/calls/actions.ts` — new

Four Server Actions. `requireBusiness()` first in every one, and every write
scoped to the caller's Business in the `WHERE` clause rather than by a prior
read.

| Action | Does |
|---|---|
| `startWebCallAction(appointmentId)` | Part 1 steps (a)–(g) |
| `reportCallStartedAction(callId)` | `status = 'in_progress'`, `started_at = now()` |
| `reportCallEndedAction(callId)` | `status = 'completed'`, `ended_at`, duration; Appointment `calling` → `pending` |
| `reportCallFailedAction(callId, reason)` | `status = 'failed'`, `disconnect_reason` |

**The duration is computed on the server**, from `started_at` to `now()`, not
taken from the browser. There is no reason to accept a number we already hold,
and a Call's own length is the kind of thing that ends up in a stat tile.

**On trusting the browser here.** A forged POST can only move a Call the account
already owns and already paid for. The worst available outcome is an account
lying to its own dashboard about its own Call. No Quota is returned by any of
these three, so there is nothing to farm. #13's webhook is the authoritative
writer and overwrites all of it.

`reportCallFailedAction` records Retell's own reason strings — in particular
`error_user_not_joined` for the expired token (docs/verification.md A3, A9) —
rather than inventing new ones. When #13's webhook writes the same row later, the
two agree instead of contradicting.

## Part 4 — The screen

### `components/calls/live-call-provider.tsx` — new, Client Component

Holds `reduceCall`'s state and exposes `start(appointment)` and `hangUp()`. Wraps
`{children}` in the app shell layout, which keeps every page below it a Server
Component.

It owns the three things that must not be duplicated: the `getUserMedia` call,
the `RetellWebClient` instance, and the 30-second timer. The SDK is imported
dynamically inside the client component — it is browser-only and must stay out
of the server bundle.

On every state change, and every five seconds while `live`, it calls
`router.refresh()`. That is SPEC.md §11.3's "revalidate every ~5s while any Call
is live", running only while it earns its keep.

### `components/calls/live-call-bar.tsx` — new

The sticky bar under the topbar. One rendering of every state, whichever button
started the Call:

| State | Shows |
|---|---|
| `requesting_mic` | "Waiting for microphone permission…" |
| `mic_denied` | What happened, how to re-enable it in the browser, "Try again". **Says plainly that no call was used.** |
| `placing` | Spinner, "Connecting to Maya…" |
| `refused` | The reason. Quota exhausted reads "You've used all 5 of your calls." |
| `connecting` | Spinner, "Connecting to Maya…", Cancel |
| `live` | Pulsing accent dot, the person's name, a running timer in mono, "Hang up" |
| `expired` | "The call didn't connect in time." Retry, and what the 30 seconds were for |
| `ended` | Duration, and a Dismiss |
| `failed` | The reason, and Retry |

Accent is legitimate on the live dot — §11.2 allows it for the live indicator.
The timer is mono, per §11.2's list. `prefers-reduced-motion` is already handled
globally in `app/globals.css`.

### `components/calls/call-now-button.tsx` — new

The row action. Calls `useLiveCall().start(...)`. Disabled, with a reason, when a
Call is already in flight or the Quota is gone — a disabled button that does not
say why is worse than no button.

### `components/overview/quick-call-card.tsx` — changed

The accent button becomes **"Call now"**. One submit adds the Appointment and
starts the Call, which is what §11.3 asks that card to be.

`addAppointmentAction` must return the created Appointment's id in its state so
the card can chain the dial. `QuickAddState.added` gains `id`.

The existing behaviour that survives untouched: the form reset, the Slot refetch
after a successful add, and the request-ordering guard on the Service dropdown.

### `components/overview/appointments-table.tsx` — changed

A "Call now" button per row, and a shimmer on any row where `isCalling` is true —
§11.2's second signature animation. New keyframes in `app/globals.css` beside
the existing `animate-live-pulse`.

The table stays a Server Component. Only the button is a client island.

### `app/(app)/layout.tsx` — changed

`const ACTIVE_CALLS = 1` is deleted and replaced with `countActiveCalls`. It has
carried a TODO naming this issue since the shell was built.

## Part 5 — Tests

`vitest`, against the local Postgres harness #6 set up. **No test places a real
Call** (SPEC.md §3 rule 11).

### Pure, no database

- `buildDynamicVariables` produces exactly the four keys `PROMPT_VARIABLES`
  declares, all of them strings, with `time` rendered in the Business's timezone.
- `validateDynamicVariables` rejects a missing key, a non-string value and an
  empty string, and names which key was wrong.
- **The placeholder sweep.** For all four Templates: substitute the built
  variables into `buildPrompt(template)` and into `template.beginMessage`, then
  assert no `{{` survives anywhere. This is AC #2 — "no literal double-brace
  placeholder is ever spoken aloud" — proven for every Template without spending
  anything.
- `reduceCall` reaches all ten states, including `mic_denied` and `expired`
  driven directly rather than by waiting 30 seconds, plus the three guards in
  Part 3.

### Against the database

- `claimCallQuota` succeeds at 4 of 5 used and refuses at 5 of 5.
- An admin account at 99 used still succeeds, and `calls_used` still increments.
- `releaseCallQuota` floors at zero.
- `countActiveCalls` ignores an `in_progress` row whose `started_at` is four
  minutes old, and ignores a live Call belonging to another Business.
- `startWebCall` with a fake Retell client: refuses before claiming when a
  variable is missing; writes `call_type: 'web'`; refuses an Appointment
  belonging to another Business; and on a Retell throw, marks the row `failed`
  **and** returns `calls_used` to where it started.

### The test that protects Part 2

Ten `claimCallQuota` calls fired concurrently at an account with five Calls left.
Exactly five return `ok: true`, and `calls_used` lands on exactly five.

This is the Quota's version of M1's concurrency test. A read-then-write
implementation passes every other test in this file and fails this one.

### Manual, once, by hand

One real Web Call, roughly seven cents, placed by explicit human action (SPEC.md
§3 rule 11). The script: press "Call now", grant the microphone, let Maya greet
you by name, **say the time works**, hear her confirm, and watch the topbar dot
and the row shimmer while she talks.

Saying "no" is out of scope — that is #12, and the Tools 404 until #10.

## File-by-file changes

**New**

| File | |
|---|---|
| `lib/calls/dynamic-variables.ts` + test | the four variables, and the placeholder sweep |
| `lib/calls/quota.ts` + test | the atomic claim and its release |
| `lib/calls/machine.ts` + test | the ten states and three guards |
| `lib/calls/start-web-call.ts` + test | the orchestration, Retell injected |
| `lib/business/active-calls.ts` + test | live count and live Appointment ids |
| `app/(app)/calls/actions.ts` | the four Server Actions |
| `components/calls/live-call-provider.tsx` | the SDK, the mic, the timer |
| `components/calls/live-call-bar.tsx` | every designed state |
| `components/calls/call-now-button.tsx` | the row action |

**Changed**

| File | |
|---|---|
| `app/(app)/layout.tsx` | real active count; the provider wraps children |
| `app/(app)/actions.ts` | `QuickAddState.added` gains `id` |
| `app/(app)/page.tsx` | pass the live ids through |
| `components/overview/quick-call-card.tsx` | button becomes "Call now", chains the dial |
| `components/overview/appointments-table.tsx` | row action and shimmer |
| `lib/business/list-appointments.ts` | `isCalling` on the row |
| `app/globals.css` | shimmer keyframes |
| `package.json` | `retell-client-js-sdk` |

No migration. No schema change. No new environment variable. `calls` already
carries every column this needs, and `retell_agents` already holds the ids.

## Out of scope

Everything in the "What #11 does not own" table. Also:

- **No mute button.** The SDK offers `mute()` and `unmute()`; the ticket does
  not ask for them and a demo does not need them.
- **No audio waveform.** §11.2 mentions the accent is allowed on one, but the
  waveform belongs with #16's Call detail screen where there is a recording to
  draw.
- **No retry-on-no-answer.** That is #17.
- **No Calls list page.** `/calls` stays the placeholder it is; #16 owns it.

## Known limitations, stated deliberately

- **A closed tab leaves a Call row at `in_progress`.** The browser is the only
  reporter until #13. The staleness window means it stops being counted as live
  after three minutes, but the row itself stays wrong until the webhook
  receiver ships and corrects it.
- **The 30-second expiry is very hard to hit on purpose.** Requesting the
  microphone first removes the ordinary way to reach it — the token is minted
  after permission is already granted. The state is designed, and unit-tested
  through the reducer, but reproducing it in a browser needs a deliberately
  throttled network.
- **The microphone needs HTTPS or localhost.** Cloud Run is HTTPS and `next dev`
  is localhost, so both real environments work. An IP address on a LAN does not.
- **Saying "that time doesn't work" produces a stall, not a reschedule.** Maya
  calls `check_availability`, gets a 404, and improvises without times. #10 and
  #12 close this. It is listed here so it is not discovered during a demo.
- **The Quota counts Calls placed, not conversations had.** A declined
  microphone costs nothing, but a Call that connects and reaches a wrong number
  still counts. That is the honest reading of "five Calls".

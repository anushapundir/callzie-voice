# Design: Phone Call path and the kill switch

**Issue:** [#19](https://github.com/anushapundir/callzie/issues/19)
**Date:** 2026-08-20
**Status:** Implemented, pending the runbook's two real Calls. See
`docs/superpowers/plans/2026-08-20-phone-call-path-and-the-kill-switch.md` and
`docs/runbooks/phone-call-preflight.md`.

## What changed while building it

Four things this design did not anticipate, each recorded because the reasoning
matters more than the edit:

1. **The number that was validated was not the number that was dialled.**
   `checkDestination` normalises before it checks — that normalisation is the
   only reason its fictional-range pattern can match — but it returned nothing,
   so the caller dialled the raw column. `+1 (202) 555-0110` would have passed
   the check and then been dialled. It now returns the normalised number and
   that is what goes to Retell.

2. **The sticky bar's `switch` was not exhaustive-checked.** No `default`, no
   `never` assertion, so it fell off the end and React rendered nothing. An
   unhandled state therefore rendered an empty grey strip *and* — because `busy`
   is derived from the state — disabled every Call button on the page, with no
   Dismiss to escape it. Silently, with nothing in the build to catch it. There
   is now a `never`-typed `default`.

3. **A thrown Server Action stranded the bar.** `await startCallAction(...)` sat
   outside any `try`, so a network drop left the reducer in `placing` forever —
   a state with no Dismiss and every button disabled. Pre-existing on the Web
   Call path; the phone route routed through the same line. Both are now
   wrapped, and the message does not claim nothing was spent, because the
   browser cannot know.

4. **The fictional block is wider than the seed.** `555-01xx` is reserved for
   fiction in every North American area code, not just the 202 the seed uses. A
   number hand-typed during the runbook would have billed the same ~$0.50 and
   connected to nobody.

## Summary

The same Agent, the same Tools, the same webhooks — carried over the telephone
instead of the browser, and only for an account carrying `phone_calls_enabled`.

Three things this design is careful about:

**The flag and the route are one database read.** There is no function that can
place a Phone Call without `phone_calls_enabled` being true in the same query
that fetched the Appointment. Not a guard you can forget to call — a guard you
cannot get past, because it is the thing that chose the route.

**The code ships with the kill switch already fired.** `phone_calls_enabled`
defaults to false and nothing in the product has ever set it. So the shipped
state is the safe state, and the failure case for M5 requires undoing nothing.

**The riskiest part is not code.** Retell's own docs contradict each other on
whether a Retell-purchased number can reach +91 at all
(`docs/verification.md` A2). One real call settles that, and no amount of
software can. This design ends in a runbook, not in a green test.

## What #19 does not own

| Surface | Issue |
|---|---|
| The webhook receiver, signature and idempotency | #13 |
| Extraction — what Maya *said* | #14 |
| The Needs Attention section | #15 |
| `/calls/[id]`, the Call detail screen | #16 |
| Call all, throttling, retry on no answer | #17 |

**A Phone Call's row stays `calling` until #13 lands, and that is accepted.**

The Web Call path settles its own rows because the browser is present to report
what the SDK saw. A Phone Call has no browser in the loop — nobody is watching
the audio stream, so nothing client-side can honestly say the Call ended.

Two alternatives were considered and rejected. Polling Retell's `get-call` API
from a Server Action would work, but it is a second, pull-shaped source of truth
for call status that #13 then has to delete. Bringing #13's webhook forward is
just doing #13. So the sticky bar says what it knows, offers Dismiss, and the
row settles when the webhook exists.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| How does a flagged account place a Phone Call? | The same "Call now" button, everywhere. The server reads `phone_calls_enabled` and picks the route. One button, one flag, no third piece of state to disagree with the other two. A flagged account that wants a cheap Web Call turns the flag off. |
| One call path or two? | One. `lib/calls/start-web-call.ts` widens into `lib/calls/start-call.ts`. A second file would duplicate the attempt count, the Quota claim and the compensating write — the three things in the file that must never drift apart. |
| Where does the guard live? | In the read that selects the route. See Part 1. |
| How does an account get flagged? | An admin-only switch on Settings, alongside the environment panel. `is_admin` is never written by application code, so the switch is reachable only from an account somebody promoted by hand in SQL. |
| What is built against, given #12 and #13 are open? | Today's code. #19's acceptance criterion about the shared webhook path becomes a design constraint — store `call_type`, add no branch on it — verified when #13 lands rather than now. |
| Is the KYC → number → India sequence automated? | No. It is a runbook you work through by hand. It happens once, most of it is dashboard clicking Retell has no API for, and the one scriptable step — the test call — is the step where an accidental re-run costs real money. |

---

## Part 1 — The guard is the route

This is the load-bearing part of the design.

`startCall` already opens with one scoped read that fetches the Appointment,
its Service and its Business, restricted to the caller's `businessId` inside the
`WHERE` clause. Two columns join it:

```ts
const [row] = await db.select({
  …the existing six,
  phoneCallsEnabled: schema.businesses.phoneCallsEnabled,
  phoneE164:         schema.appointments.phoneE164,
}) …

const route = row.phoneCallsEnabled ? "phone" : "web"
```

That is the whole permission check. There is no `if (!enabled) return refuse`
anywhere, because there is nothing to refuse: an unflagged account does not
reach a branch that could dial. It gets a Web Call.

**Why this beats the obvious shape.** The obvious shape is a `startPhoneCall`
function that begins by checking the flag. That works until somebody adds a
second caller and forgets — and the failure is silent, outbound, and to a
stranger. Here, forgetting is not available. `createPhoneCall` is reachable from
exactly one branch, and the condition on that branch is the flag.

It is the same argument `lib/calls/quota.ts` makes about the Quota and
`appointments_no_overlap` makes about double-booking: put the guarantee where it
cannot be routed around, not where it has to be remembered.

**"By any route, including a crafted request."** A Server Action is a POST
anybody can send. After this change there is one action, `startCallAction`, and
it takes an Appointment id and nothing else. A crafted POST reaches the same
function, is scoped to the sender's own Business, reads the sender's own flag,
and gets a Web Call. There is no `startPhoneCallAction` to aim at, and no
parameter that selects the route.

## Part 2 — The order of operations

Unchanged from #11 in shape. Nothing is spent until it cannot be wasted. Two
phone-only checks slot in **before** the Quota is claimed:

```
Press "Call now"
  1. browser: microphone — WEB ONLY. A Phone Call needs no mic, so a flagged
     account never sees the prompt.
  2. server action startCallAction(appointmentId)
       a. requireBusiness()
       b. load Appointment + Service + Business, scoped. Route decided here.
       c. build the four dynamic variables and VALIDATE them
       d. PHONE ONLY: RETELL_FROM_NUMBER must be set
       e. PHONE ONLY: the destination must be dialable
       f. transaction: claim the Quota + insert the calls row
       g. retell.call.createWebCall(…) or createPhoneCall(…)
       h. success → store retell_call_id, Appointment → 'calling'
       i. failure → mark the row failed, give the Quota back, refuse
  3. WEB ONLY: retellWebClient.startCall({ accessToken })
```

Steps (d) and (e) are the only additions, and both sit above (f) deliberately.
A Phone Call refused for a missing number must not have cost a Call — so the
tests for both assert not just the refusal but that `calls_used` did not move
and no `calls` row was written.

### Why (e) exists at all

Every seeded Appointment carries a number in the reserved fictional
`+1 202 555 01xx` range. `lib/onboarding/templates.ts` already says why:

> the product's entire job is to dial the numbers in this table, and #11/#19
> point a real dialler at exactly these rows. A plausible real number here is a
> cold call to a stranger.

The fiction range protects the stranger. It does not protect the budget: a
flagged account pressing "Call now" on a seeded row spends roughly $0.50 of an
$8 line on a call that cannot connect, and then shows a confusing failure in
what was meant to be a demo rehearsal.

So a Phone Call to that range is refused with a message that says what to do —
add an Appointment with a real number. It costs one comparison and prevents the
most likely first mistake.

### The two new refusals

| Reason | Message |
|---|---|
| `phone_not_configured` | "No phone number is configured for outbound calls." |
| `phone_number_unusable` | "That's a demo number. Add an appointment with a real number first." |

Worded for the person reading a dashboard, like the four already there.

### The failure at (g) compensates exactly as the Web Call does

Mark the row `failed` with `disconnect_reason = 'create_phone_call_failed'`,
release the Quota. Same argument as #11: this is the one failure provable on the
server, so it is the one refund in the system.

## Part 3 — What is genuinely different, and nothing else

The acceptance criterion is "no branching on call type beyond what is genuinely
different". Here is the complete list of what differs:

| | Web | Phone |
|---|---|---|
| Retell endpoint | `createWebCall` | `createPhoneCall` (`/v2/`, via the SDK) |
| Agent parameter | `agent_id` | `override_agent_id` — the name really does change (`docs/verification.md` A6) |
| Destination | none | `from_number` + `to_number` |
| Returns | `access_token` for the browser | nothing to join |
| `calls.call_type` | `web` | `phone` |
| Browser | mic, SDK, event reporting | none |

Everything else is shared: the scoped read, the dynamic variables, the Agent
lookup, the attempt count, the Quota claim, the row insert, the compensating
write, and the `metadata` payload.

That last one matters most. Both routes send
`metadata: { call_id, appointment_id }`, so when #13 arrives it recovers a Phone
Call by the identical mechanism it recovers a Web Call. Nothing downstream reads
`call_type` to decide anything — the column records what happened, it does not
steer.

## Part 4 — The sticky bar, without a browser in the loop

`lib/calls/machine.ts` gains one state, `dialling`, reachable from `placing`.

It has no `live` and no `ended` transition. Not an omission: no event can arrive
that would justify either. The bar renders "Ringing {name} at {number}" with the
number in mono, and a Dismiss.

The provider learns which route it is on from a `phoneCallsEnabled` boolean
passed down through `app/(app)/layout.tsx`. It decides four browser-side things:
whether to ask for the microphone, whether to load the SDK, whether to arm the
30-second token deadline, and which message a mismatch gets.

**A lying client cannot reach anybody it should not, which is why a boolean is
enough.** Not the same as "cannot cause harm" — the earlier draft of this
paragraph said that, and it was wrong in a way worth recording.

Claim "web" on a flagged account and a Phone Call **still goes out**, because
the server reads the flag and the client's hint does not enter that decision. A
real customer is dialled. That is not a breach: it is the account's own
customer, which is exactly what the flag permits. What the browser loses is only
its own bookkeeping, and the bar says so.

Claim "phone" on an unflagged one and you skipped a microphone prompt you did
not need, and the server places a Web Call whose token nothing joins. **That
case spends a Call**, so the message for it says so rather than inviting a
second press.

The guarantee the boolean carries is therefore narrow and worth stating exactly:
the client cannot choose the route, and cannot cause a number to be dialled that
the server would not have dialled anyway.

## Part 5 — The Settings switch

Admin-only, and gated the same way the environment panel is: in
`app/(app)/settings/page.tsx`, so a non-admin's HTML never contains it.

The page is not the boundary. `setPhoneCallsEnabledAction` is a POST anybody can
send, so `lib/settings/phone-calls.ts` puts `is_admin = true` **inside the
`WHERE` clause** of the update. A non-admin's write matches zero rows. Same
discipline as every cross-tenant guard in `lib/` — scope in the statement, never
a read followed by a check.

**The honest risk.** This puts the product's most dangerous flag behind a UI
control, on an app with open signup. What makes it acceptable is that `is_admin`
is not reachable from the product at all: nothing in the codebase writes it, and
SPEC.md §14 rule 9 rules out the roles UI that would. Reaching the switch
requires a `UPDATE businesses SET is_admin = true` somebody typed into a
database console.

The section also renders whether `RETELL_FROM_NUMBER` is set, reusing
`envStatus()` — which returns booleans and never a value. A switch that is on
while the number is blank is a real state, and the panel should say so rather
than let it be discovered by a refused Call.

## Part 6 — The kill switch

"Kill switch" gets used for two different things around this ticket, and it is
worth separating them. SPEC.md itself uses the phrase once, at §12 M5, in only
the second sense.

**The flag** is per-account, and defaults off.

**The kill switch** is the project-level decision at M5: if India turns out to be
unreachable, no account is flagged, the finding is written up, and M6 and M7
proceed. Callzie ships complete on Web Calls.

Because the flag defaults off and nothing has ever set it, **firing the kill
switch requires no action.** It is the shipped state. That is the whole reason
this ticket is safe to build before the India question is answered.

Either outcome ends with the same code merged. If India works, a switch gets
turned on. If it does not, the switch stays off and
`docs/verification.md` gains a dated answer where it currently has a
contradiction. The story becomes "phone delivery is a config change" — proven,
not claimed.

## Part 7 — The human runbook

Written to `docs/runbooks/phone-call-preflight.md`. None of it is automated;
all of it is dashboard work Retell exposes no API for, except the one step where
an accidental re-run spends real money.

1. **KYC.** Record which of the three paths you land in — automatic, Persona, or
   manual review (`docs/verification.md` A1). Manual review means stop and fire
   the kill switch. That is a finding, not a failure.
2. **Buy the $2 US number.** Record whether a card was required. That answers
   SPEC.md §13 item 1, currently UNVERIFIED.
3. **Set `RETELL_FROM_NUMBER`** locally and on Cloud Run.
4. **Settle India from Retell's dashboard, before Callzie touches it.** One call
   from the new number to your own +91 mobile, ~$0.25. Connects → supported.
   `invalid_destination`, `telephony_provider_permission_denied` or
   `dial_failed` → blocked.
5. **Record the answer** in `docs/verification.md`, Decision 1 and A2, with the
   date and the exact `disconnection_reason`.

If supported: promote your account in SQL, turn the switch on, quick-add an
Appointment with your own number, press "Call now". Listen for your name and the
right time. Confirm it ends inside 120 seconds — `max_call_duration_ms` is
already 120,000 in `scripts/create-agent.ts`, so this observes the cap rather
than adding one. Cost ~$0.50.

If blocked: change nothing, and write the finding into `docs/verification.md`
and the README's stated limitations.

## Testing

Everything except the two real calls in Part 7 is proven offline, with no Call placed
(SPEC.md §3 rule 11). Both Retell creators are injected, exactly as
`WebCallCreator` already is.

The cases that matter most:

- An unflagged Business gets a Web Call, and `createPhoneCall` is **never
  called**. This is the acceptance criterion, as an assertion.
- A flagged Business with `RETELL_FROM_NUMBER` blank is refused, **and** the
  Quota did not move **and** no `calls` row exists. Same three assertions for a
  seeded fictional number. These pin the ordering, not just the refusal.
- Both routes write the same `calls` row apart from `call_type`.
- A non-admin cannot flip the flag, and neither can an admin flip somebody
  else's.

## Cost

| | |
|---|---|
| The India test call (Part 7, step 4) | ~$0.25 |
| One real Callzie Phone Call under 120s | ~$0.50 |
| The number | $2/month |

Inside the ~$8 line in `docs/verification.md` A2. Everything else is free.

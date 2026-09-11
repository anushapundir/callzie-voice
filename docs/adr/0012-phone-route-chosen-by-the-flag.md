# The Phone Call route is chosen by the flag, not guarded by it

Status: accepted

`SPEC.md` §3 rule 9 and §14 rule 6 both forbid the same thing: placing a Phone
Call from an account without `businesses.phone_calls_enabled`. Callzie has open
signup, so arbitrary outbound dialling would make it a robocalling tool.

`lib/calls/start-call.ts` reads that flag in the **same scoped query that
fetches the Appointment**, and the route is that column:

```ts
const route: "web" | "phone" = row.phoneCallsEnabled ? "phone" : "web";
```

There is no `if (!enabled) refuse` anywhere in the file, because there is
nothing to refuse. An unflagged account does not reach a branch that could dial;
it gets a Web Call. `createPhoneCall` is reachable from exactly one branch, and
the condition on that branch is the flag.

**The join is what makes "whose flag" unambiguous.** `businesses` is joined on
`businesses.id = appointments.business_id`, keyed off the Appointment's owner,
and the `WHERE` separately pins `appointments.business_id = businessId`. Those
two together mean the joined row is simultaneously the owner and the caller, so
the two possible readings of the question are the same row by construction.

Same argument as `claimCallQuota` and `appointments_no_overlap`: put the
guarantee where it cannot be routed around, rather than where it has to be
remembered.

**The flag is read once, so the switch stops new Calls, not in-flight ones.** A
Call already past that line completes. Narrowing that window would mean
re-reading the flag inside the Quota transaction, which is possible but buys
little: the flag is only settable from an account somebody promoted by hand in
SQL, so nobody is racing it.

## Considered options

- **A `startPhoneCall` function that checks the flag first.** The obvious shape,
  and the one this rejects. It works until somebody adds a second caller and
  forgets — and that failure is silent, outbound, and to a stranger. A guard is
  something you can omit; a route selection is not.
- **A `route` argument on the Server Action.** Rejected outright. A Server
  Action is a POST anybody can send, so an argument naming the route is
  precisely the "crafted request" the acceptance criterion rules out.
  `startCallAction` takes an Appointment id and nothing else.
- **Two files, `start-web-call.ts` and `start-phone-call.ts`.** Rejected. The
  refuse → claim → insert → dial → compensate ordering is the file's whole
  reason to exist, and two copies would drift on the three things that must not:
  the attempt count, the Quota claim, and the compensating write. The genuine
  branch is about twenty lines out of three hundred.
- **Leaving the raw Retell diallers exported.** Rejected once it was pointed out
  that `import { createPhoneCallWithRetell }` would itself be a path to the
  dialler that never saw the flag, making this ADR's central claim untrue by one
  import. Both are module-private; only the injectable types are exported.

## What this costs

A flagged account cannot place a cheap Web Call without turning the flag off
first. Accepted: the switch is one click, and one flag beats two pieces of state
that can disagree.

## Revisit if

Accounts ever need both routes at once — a per-Appointment choice, or Web Calls
for rehearsal on a flagged account. That would make the route an argument again,
and an argument needs its own server-side authorisation rather than inheriting
one from the row it was read off.

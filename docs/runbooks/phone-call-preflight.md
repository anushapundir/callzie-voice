# Phone Call preflight

**None of this is automated, and that is deliberate.** Most of it is dashboard
clicking Retell exposes no API for. The one step that could be scripted — the
test call — is the step where an accidental re-run spends real money.

You do these by hand. Roughly $0.75 in total, plus $2/month for the number.

**Step 4 is the whole kill switch.** Retell's own documentation contradicts
itself on whether a Retell-purchased number can reach a +91 number at all
(`docs/verification.md` A2). One call settles it. No amount of code can.

**Everything in Callzie ships either way.** The flag defaults to false and
nothing has ever written it except the Settings switch, so the blocked outcome
requires undoing nothing. If India turns out to be unreachable, the product is
complete on Web Calls and the story becomes "phone delivery is a config
change" — proven rather than claimed.

---

## 1. Complete Retell KYC

KYC unlocks outbound calling, number purchases and SMS. Three paths exist:
automatic, Persona (government ID), and manual review.

**Record which one you land in** in `docs/verification.md` A1, which currently
marks the turnaround time UNVERIFIED.

**If you land in manual review, stop here.** Go to the *If blocked* branch
below — both of its steps, not just the write-up. That
is a finding, not a failure — it is exactly the risk M5 was isolated for.

## 2. Buy a $2 US local number

Retell sells US and Canada numbers only. The cheapest is $2/month for a US
local number.

**Record whether a card was required.** That answers `SPEC.md` §13 item 1,
currently UNVERIFIED in `docs/verification.md` A1 — the docs never state whether
trial credit alone can buy a number.

## 3. Set `RETELL_FROM_NUMBER`

In `.env.local` and on the Cloud Run service. Restart the service.

Confirm it took: sign in as an admin, open `/settings`, and check the
Configuration panel shows `RETELL_FROM_NUMBER` as **Set**. The panel shows
booleans only, never the value.

Until this is set, a flagged account's Phone Calls are refused **before**
anything is spent — no Quota, no `calls` row. The Settings screen says so.

## 4. Settle India — from Retell's dashboard, before Callzie touches it

Place **one** call from your new number to your own +91 mobile. About $0.25.

Do this from Retell's own dashboard, not through Callzie. The question is
whether the telephony works at all; putting Callzie in the path only adds a
second thing that could be wrong.

Read `disconnection_reason` on the call in the dashboard:

| Outcome | Verdict |
|---|---|
| It connects | **Supported** |
| `invalid_destination` | **Blocked** |
| `telephony_provider_permission_denied` | **Blocked** |
| `dial_failed` | **Blocked** |

If it is blocked, check whether a geographic restriction is on by default —
Retell ships fraud-protection tooling that restricts destinations, and that is a
different problem from the number being incapable.

## 5. Record the answer

In `docs/verification.md`, edit **both**:

- **Decision 1** in the table at the top, which currently reads "Treat as
  unresolved and plan for the fallback."
- **A2's "⚠️ The blocking contradiction" subsection.**

Give the date and the exact `disconnection_reason`. Replace the contradiction
with the resolved answer — do not leave both standing. The whole point of that
file is that it records what was checked rather than what was assumed.

---

## If supported

## 6. Promote your account

Nothing in Callzie writes `is_admin`, by design — `SPEC.md` §14 rule 9 rules out
roles and invites, so there is no UI for it and none is coming. Set it by hand:

```sql
UPDATE businesses SET is_admin = true WHERE id = '<your business id>';
```

## 7. Turn the switch on

`/settings` → Phone calls → **Turn on phone calls**.

The section appears only for an admin account. It is gated on the page, so a
non-admin's HTML never contains it, and the write is separately scoped to
admins inside its own `UPDATE`.

## 8. Place one real Phone Call

**Quick-add an Appointment with your own number first.** Every seeded
Appointment carries a number in the reserved fictional `+1 XXX 555-01xx` block,
and the app now refuses to dial those — they connect to nobody and would bill
about $0.50 for the privilege.

Then press **Call now** on that row.

What to check:

- Your phone rings.
- Maya uses **your name** and **the right time**. If you hear her say
  "curly-curly-name", the dynamic variables are broken — that is the failure
  `docs/verification.md` A5 warns about.
- **The call ends inside 120 seconds.** `max_call_duration_ms` is already
  120,000 in `scripts/create-agent.ts`, so this observes the cap rather than
  adding one.

  **If it runs past 120 seconds, hang up your own phone.** Do not wait to see
  what happens. There is no Hang up button on a Phone Call — the browser has no
  SDK on this route — so your handset is the only stop, and Retell's default cap
  is an hour, which at ~$0.25/min would eat roughly twice the whole budget.
  Then check whether the Agent version being dialled is the published one:
  `docs/verification.md` A12 records that as UNVERIFIED, and it is the likeliest
  reason a configured cap would not apply.

About $0.50.

**Then turn the switch back off**, so the deployed demo account cannot dial.

Note what does *not* happen yet, and check the right table if you go looking.
The **Appointment** row stays `calling`, so the dashboard keeps an orange
"Calling" pill on it. The **Call** row stays `queued` with `started_at` null —
`calls.status` has no `calling` value at all. There is no
browser on a Phone Call to report the outcome, and issue #13's webhook receiver
does not exist. The sticky bar says so and offers Dismiss. That is the honest
state, not a bug.

---

## If blocked

## 6. Change nothing

The flag defaults to false and only the Settings switch writes it. The kill
switch is already fired — there is nothing to undo.

## 7. Write the finding up

Into `docs/verification.md` (step 5 above). Say plainly which
`disconnection_reason` came back and on what date.

There is no README in this repo yet. Issue #21 adds one, and `SPEC.md` §15
requires it to carry the stated limitations — so when it exists, this finding
belongs in that list. Until then `docs/verification.md` is the record.

The phone path stays in the codebase, tested, with the flag off. That is the
claim worth making: phone delivery is a config change away, and here is the code
that proves it rather than a paragraph asserting it.

---

## What this does not cover

**DLT and TRAI.** India's regulatory position on commercial calling is
UNVERIFIED and out of scope for this build (`docs/verification.md` A2). You are
calling your own phone and consenting friends' phones, a handful of times, in a
demo. That is materially different from a commercial outbound campaign. Say so
in the README rather than letting it be a hidden risk.

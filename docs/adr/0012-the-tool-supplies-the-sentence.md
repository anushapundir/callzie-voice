# The Tool supplies the sentence, and one pure function decides a Call ran out of time

Status: accepted

Two rules `SPEC.md` states in prose needed a mechanism, and both of them are
about Callzie refusing to be confidently wrong in front of a customer.

**Maya is handed the words, not just the reason.** Every Tool result carries an
optional `say`. The failure lines are the point: a response reading
`{ ok: false, reason: "slot_taken" }` leaves the model to compose an answer, and
the wrong answer there is `SPEC.md` §14 rule 4 — claiming a booking that never
happened, the most damaging failure available to this product. The lines live in
`lib/tools/say.ts` in two groups, `COMMITTED` and `NOT_COMMITTED`, and
`lib/tools/say.test.ts` holds the second group to containing no success language.
This is §3 rule 6's lesson — a prompt instruction is a suggestion — applied to
the sentence rather than to Business Hours.

**A Call that ran out of time is named by one pure function.**
`wasNegotiationTruncated` in `lib/calls/truncation.ts` takes three facts and
returns a boolean. `lib/calls/record.ts` calls it when the browser reports a Web
Call ended; #13's webhook will call it with Retell's own `disconnection_reason`.
`SPEC.md` §5's fourth Needs Attention reason had no writer at all before this.

## Considered options

- **Leaving the wording to the prompt.** It is where the rule lived until now:
  "If book_slot fails, say you'll have someone call back to confirm; never say
  the booking is done." Rejected as the *only* defence for the same reason
  Business Hours are not defended there. The line stays in the prompt — it is
  now the second layer rather than the first.
- **Retell's `response_variables`,** which map fields of a tool response into
  dynamic variables the prompt can reference. Rejected: the same outcome, plus a
  re-provisioning step for four Agents, plus a second home for wording that
  should have one.
- **Scripting what Maya says when Slots come back.** Rejected. She has to offer
  three times in her own words and react to the answer; a script there makes her
  an IVR. `say` appears on a `check_availability` response only when the list is
  empty, which is the case the prompt had no branch for.
- **Letting the browser report that a Call was cut off.** Rejected: the browser
  can claim anything. `lib/calls/record.ts` already refuses to accept a duration
  from it, and this is the same argument.
- **Waiting for #13's webhook to write `negotiation_truncated`.** Rejected: the
  Web Call is the demo path (`SPEC.md` §16) and #12 owns the acceptance
  criterion. The pure function means #13 improves the input rather than
  duplicating the rule.

## Consequences

- **`say` is a strong steer, not a guarantee — and in practice it was read
  verbatim.** Retell's `speak_after_execution` has the model generate speech
  *from* the tool response, so it may paraphrase. On the live Call of
  2026-08-21 it did not: Maya spoke `COMMITTED.booked` word for word — "That's
  booked in — you're all set for Monday 24 August at 12:30 PM." One call is not
  a guarantee and this stays a steer, but the mechanism works better than it was
  written up as.

- **⚠️ The prompt did not stop her narrating the booking, and the safety net is
  what makes that survivable.** The same Call, one turn earlier:

  > *"Great, you're all set for Monday 24 August at 12:30 PM. I'll proceed to
  > book that slot now."*

  Said **before** `book_slot` was invoked, in direct contradiction of a prompt
  clause added that morning specifically to forbid it. The booking did land a
  moment later, so the outcome was correct — but had the customer hung up on
  "Okay", they would have left believing they were booked.

  This is SPEC.md §3 rule 6 demonstrating itself: *a prompt instruction is a
  suggestion.* The clause is worth keeping — it is cheap and it clearly moved
  her behaviour, since she then asked the customer to hold and confirmed only
  after the write. But it cannot be the defence. The defence is
  `negotiation_truncated` firing on `offersMade && !committed`, which would have
  caught that hang-up at any duration. **Anything that relies on Maya choosing
  to speak in a particular order needs a mechanism underneath it.**
- **`alreadyBooked` lives in `COMMITTED`.** A second `book_slot` is refused by
  the one-booking index, but a first one committed earlier in the same Call, so
  telling the person they are booked is true. Filing it under `NOT_COMMITTED`
  would have made the failure-line test either wrong or toothless.
- **Only `slot_taken` promises a callback.** `not_offered`, `invalid_time` and
  `in_the_past` mean Maya named a time that was never on the table, and the
  right move there is another `check_availability` — not a promise to ring back
  about a problem the customer does not have.
- **On the Web Call path, truncation is inferred from duration.** The browser
  knows a Call ended, not why, so the rule falls back to "ran to about the cap
  with nothing committed" — 115 seconds, five short of the cap, because the
  SDK's clock and Postgres's `now()` are not the same clock. A person who hangs
  up at 116 seconds with nothing agreed is therefore recorded the same as one
  the cap cut off. Both want a human to call back, so the wrong answer costs a
  row in a queue rather than a wrong action.
- **`negotiation_truncated` never overwrites an existing reason.** A conditional
  `UPDATE ... WHERE needs_attention_reason IS NULL`, so `book_failed` — written
  by `book_slot` moments earlier and strictly more specific — survives. A Call
  that tried and failed to book is not the same as one that never got there, and
  #15 renders the difference.
- **A successful `check_availability` is not an outcome.**
  `lib/tools/committed.ts` counts only `book_slot`, `confirm_appointment` and
  `cancel_appointment`. The Call that asked what was open three times and then
  ran out of time is exactly the Call `SPEC.md` §5 wants in front of a human.
- **`check_availability` refuses to repeat itself, and `book_slot` does not.**
  The Slots this Call already named are subtracted from the next round, or
  §7's "ask what would suit and call check_availability again" means asking the
  same question louder. Booking stays cumulative — ADR-0011's per-Call Offer
  check is unchanged — so a time from round one is still bookable in round four.

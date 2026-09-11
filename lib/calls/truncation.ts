/**
 * Whether a Call ran out of time before anything was agreed.
 *
 * SPEC.md §5's fourth Needs Attention reason: the Call hit the 180s cap with no
 * Tool committed. The Appointment keeps its Slot and waits for a human — Callzie
 * refuses to guess an outcome from a conversation that did not reach one
 * (SPEC.md §14 rule 4, the same instinct as rule 2).
 *
 * **Pure, and called from two places.** `lib/calls/record.ts` calls it now with
 * what the browser's report leaves the server able to prove. #13's webhook calls
 * it later with Retell's own `disconnection_reason`, which is the authoritative
 * answer. One rule, two callers, no second copy to drift.
 */

/** SPEC.md §7's `max_call_duration_ms`, in seconds. The cost guardrail. */
export const CAP_SECONDS = 120;

/**
 * Close enough to the cap to count as having hit it.
 *
 * Five seconds of slack because the SDK's `call_ended` in the browser and
 * Postgres's `now()` are not the same clock, and `recordCallEnded` computes the
 * duration from the second one.
 */
export const NEAR_CAP_SECONDS = 115;

/** Retell's own word for the cap firing (docs/verification.md A9). */
export const MAX_DURATION_REACHED = "max_duration_reached";

export type TruncationInput = {
  /** From `calls.duration_seconds`. Null until a Call has ended. */
  durationSeconds: number | null;
  /**
   * Did any Tool write an outcome on this Call?
   *
   * A successful `check_availability` is not one — it is a question with an
   * answer. See `lib/tools/committed.ts`.
   */
  committed: boolean;
  /**
   * Did Maya name any Slot out loud on this Call?
   *
   * The signal that matters most, and the one the 120s rule alone misses. A live
   * Call on 2026-08-21 ran three rounds of Offers, had the customer accept a
   * time, and ended at 65 seconds with nothing written — well under the cap, so
   * the duration rule stayed silent and nobody was told. A negotiation that got
   * as far as naming times and then committed nothing needs a human whatever the
   * clock says.
   */
  offersMade?: boolean;
  /**
   * Retell's `disconnection_reason`, when we have it. #13 supplies it; the Web
   * Call path does not, because the browser reports that the Call ended and not
   * why.
   */
  disconnectionReason?: string | null;
};

export function wasNegotiationTruncated({
  durationSeconds,
  committed,
  offersMade,
  disconnectionReason,
}: TruncationInput): boolean {
  // An outcome is an outcome. Nothing after this can override it.
  if (committed) return false;

  // The authoritative answer, when there is one.
  if (disconnectionReason === MAX_DURATION_REACHED) return true;

  /*
    Times were named and nothing was booked. SPEC.md §5 words this reason around
    the call cap, and the cap turned out to be the rarer half of it: a Call can
    reach the end of a negotiation and drop it in 65 seconds. The Slot is never
    freed either way — this only asks a human to look (SPEC.md §14 rule 2), so a
    false positive costs a row in a queue and a false negative costs a customer
    who believes they are booked and is not.
  */
  if (offersMade) return true;

  if (durationSeconds === null) return false;
  return durationSeconds >= NEAR_CAP_SECONDS;
}

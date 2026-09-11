import { failureKind } from "@/lib/webhooks/status";

/*
  A disconnection reason, in words a person at a front desk can act on.

  `lib/webhooks/status.ts` owns the classification — which reasons mean
  completed, no-answer or failed, and which two failures are not really about
  this Call. This module does not re-derive any of that. It wraps `failureKind`
  and adds the two things the screen needs and the webhook does not: a sentence,
  and whether Retry could possibly succeed.

  Every reason listed here comes from docs/verification.md A9, transcribed from
  Retell's own "Debug call disconnection" page.
*/

export type CallFailure = {
  headline: string;
  detail: string;
  /** Whether to render the Retry button at all. */
  canRetry: boolean;
};

/*
  Every sentence below is read by the owner of a salon, so none of them name the
  voice provider, cite the spec, or capitalise a domain noun mid-sentence. The
  place for those is a code comment, like this one.
*/
const REASONS: Record<string, Omit<CallFailure, "canRetry">> = {
  dial_no_answer: {
    headline: "Nobody answered",
    detail:
      "The phone rang out. The appointment keeps its time — an unanswered phone is not a cancellation.",
  },
  dial_busy: {
    headline: "The line was busy",
    detail: "The number was engaged. Nothing about the appointment has changed.",
  },
  user_declined: {
    headline: "The call was declined",
    detail:
      "Somebody rejected the call at the handset. That is not the same as declining the appointment, which is untouched.",
  },
  voicemail_reached: {
    headline: "Voicemail picked up",
    detail:
      "A machine answered, so there was nobody to book with. That came back from the phone line itself, rather than being guessed from the transcript.",
  },
  ivr_reached: {
    headline: "A phone menu answered",
    detail:
      "The number led to an automated menu rather than a person. Worth checking the number on the appointment.",
  },
};

/**
 * What to show on a `failed` or `no_answer` Call.
 *
 * Unknown reasons get the generic sentence and are still offered a Retry, which
 * matches how `mapDisconnectionReason` fails closed: a reason Retell added after
 * this was written lands here, and refusing to let somebody try again would be
 * the worse guess.
 */
export function callFailure(reason: string | null | undefined): CallFailure {
  const kind = failureKind(reason);

  if (kind === "credit_exhausted") {
    return {
      headline: "The calling account is out of credit",
      detail:
        "No call will connect until the balance is topped up. Trying again cannot help, so there is no retry here.",
      canRetry: false,
    };
  }

  if (kind === "concurrency_limit") {
    return {
      headline: "Too many calls at once",
      detail:
        "The account had already hit its limit on calls running at the same time. Wait a moment and try again.",
      canRetry: true,
    };
  }

  const known = reason ? REASONS[reason] : undefined;
  if (known) return { ...known, canRetry: true };

  return {
    headline: "The call failed",
    detail: reason
      ? `The reason that came back was "${reason}", which Callzie has no specific sentence for. Trying again is reasonable.`
      : "No reason came back at all, which usually means the call never reached the phone network. Trying again is reasonable.",
    canRetry: true,
  };
}

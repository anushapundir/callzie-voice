import { MAX_BATCH_SIZE, MAX_CONCURRENT_CALLS } from "@/lib/calls/batch/limits";

/**
 * What the Call all sheet says, and whether its button does anything.
 *
 * Pure, and tested, because this is the moment somebody decides to spend every
 * Call their account has left. A refusal here is written as a sentence rather
 * than a disabled control with no explanation — SPEC.md §11.4, and the same
 * rule `components/calls/call-now-button.tsx` follows.
 *
 * `quotaRemaining` is `null` for an admin account, meaning unlimited. It is not
 * `Infinity`: this value crosses from a Server Action to the browser as JSON,
 * and `JSON.stringify(Infinity)` is `null` anyway.
 */
export type BatchSummary = {
  title: string;
  detail: string;
  /** How many Calls pressing the button would actually place. */
  willPlace: number;
  canStart: boolean;
};

export function batchSummary({
  eligible,
  quotaRemaining,
  phoneCallsEnabled,
}: {
  eligible: number;
  quotaRemaining: number | null;
  phoneCallsEnabled: boolean;
}): BatchSummary {
  const pacing = `Callzie calls at most ${MAX_CONCURRENT_CALLS} at a time.`;

  /*
    First, because it is the one refusal that is about the account rather than
    about the work. SPEC.md §3 rule 9: signups get Web Calls, and a Web Call
    needs a browser to join it — which is why Call All cannot use one.
  */
  if (!phoneCallsEnabled) {
    return {
      title: "Phone calls are off for this account",
      detail:
        "Callzie places web calls from this browser, one at a time. " +
        "Call all needs the phone path.",
      willPlace: 0,
      canStart: false,
    };
  }

  if (eligible === 0) {
    return {
      title: "No appointments to call",
      detail:
        "Every appointment here is already handled, needs attention, or has " +
        "already happened.",
      willPlace: 0,
      canStart: false,
    };
  }

  if (quotaRemaining === 0) {
    return {
      title: "You've used all your calls",
      detail: "Nothing will be placed until the quota is raised.",
      willPlace: 0,
      canStart: false,
    };
  }

  const willPlace = Math.min(
    eligible,
    quotaRemaining ?? eligible,
    MAX_BATCH_SIZE,
  );

  if (willPlace < eligible) {
    return {
      title: `Call ${willPlace} of ${eligible} people?`,
      detail:
        `You have ${quotaRemaining} calls left, so ${willPlace} will be ` +
        `placed and ${eligible - willPlace} stay pending. ${pacing}`,
      willPlace,
      canStart: true,
    };
  }

  return {
    title: `Call ${eligible} ${eligible === 1 ? "person" : "people"}?`,
    detail: pacing,
    willPlace,
    canStart: true,
  };
}

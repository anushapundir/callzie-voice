import { MAX_ATTEMPTS } from "@/lib/calls/batch/limits";
import type { CallStatus } from "@/lib/db/schema";

/**
 * What a finished Call leaves behind (issue #17).
 *
 * `retry` means the Appointment goes back in the queue and gets one more Call.
 * `unreachable` means it stops and waits for a human — **keeping its Slot**,
 * because an unanswered phone is not a cancellation (SPEC.md §14 rule 2).
 *
 * Only `no_answer` earns either. `failed` covers a broken Web Call token and an
 * empty Retell balance (`docs/verification.md` A9), and neither says anything
 * about whether the person would have picked up.
 */
export type CallAftermath = "retry" | "unreachable" | "nothing";

export function afterCall({
  status,
  attempt,
}: {
  status: CallStatus;
  attempt: number;
}): CallAftermath {
  if (status !== "no_answer") return "nothing";
  return attempt < MAX_ATTEMPTS ? "retry" : "unreachable";
}

import type { CallStatus } from "@/lib/db/schema";

/*
  Retell's vocabulary, translated into Callzie's.

  The whole table is in docs/verification.md A9, transcribed from Retell's own
  "Debug call disconnection" page. Two things about it are worth knowing before
  editing anything here.

  **Read `disconnection_reason`, not `call_status`.** Retell reports voicemail as
  `call_status: "ended"` — the same value a real conversation gets — so a
  status-only check files a machine picking up as a completed Call. The reason is
  the only field that distinguishes them.

  **And it is `disconnection_reason`, not `disconnect_reason`.** Our column is
  spelled the second way (SPEC.md §5) and Retell's field the first. Reading the
  wrong one yields `undefined`, which lands every Call on `failed` — a system
  that looks like it is working and having a very bad day.
*/

/** Reasons where the conversation happened, however it ended. */
const COMPLETED = new Set([
  "user_hangup",
  "agent_hangup",
  "call_transfer",
  "call_take_over",
  "max_duration_reached",
  "inactivity",
  "transfer_bridged",
]);

/**
 * Reasons where nobody was reached.
 *
 * Voicemail and IVR are here rather than under `completed` because a machine
 * answering is not the person answering — and SPEC.md §14 rule 2 turns on that
 * distinction: an unreachable Appointment keeps its Slot.
 */
const NO_ANSWER = new Set([
  "dial_no_answer",
  "dial_busy",
  "user_declined",
  "voicemail_reached",
  "ivr_reached",
]);

/**
 * Which Call status a disconnection reason means.
 *
 * Everything unlisted is `failed`, including a reason Retell adds after this was
 * written and a reason that never arrived at all. Failing closed is the safe
 * direction: a wrongly-failed Call is a row someone looks at, where a wrongly-
 * completed one is a row nobody ever does.
 */
export function mapDisconnectionReason(
  reason: string | null | undefined,
): CallStatus {
  if (!reason) return "failed";
  if (COMPLETED.has(reason)) return "completed";
  if (NO_ANSWER.has(reason)) return "no_answer";
  return "failed";
}

/**
 * The two failures that are not really about this Call.
 *
 * Both are `failed` in the database and both need to read as themselves on
 * screen (issue #13, last acceptance criterion). `no_valid_payment` means the
 * Retell balance is gone and nothing will connect until someone tops it up;
 * `concurrency_limit_reached` means too many Calls at once, so wait and retry.
 * Told as a generic failure, the first looks like a bug for as long as it takes
 * someone to check the billing page.
 */
export type FailureKind = "credit_exhausted" | "concurrency_limit" | "generic";

export function failureKind(reason: string | null | undefined): FailureKind {
  if (reason === "no_valid_payment") return "credit_exhausted";
  if (reason === "concurrency_limit_reached") return "concurrency_limit";
  return "generic";
}

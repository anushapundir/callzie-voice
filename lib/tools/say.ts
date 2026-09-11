import type { ToolName } from "@/lib/db/schema";

/**
 * What Maya says, chosen by the endpoint rather than by the prompt.
 *
 * SPEC.md §3 rule 6 settles Business Hours in the Tool because "a prompt
 * instruction is a suggestion". The same argument applies to the sentence
 * itself, and it applies hardest to the failure lines: a response that reads
 * `{ ok: false, reason: "slot_taken" }` leaves the model to compose an answer,
 * and the wrong answer there is SPEC.md §14 rule 4 — claiming a booking that did
 * not happen.
 *
 * **Honest about the limit.** Retell's `speak_after_execution` has the model
 * generate speech *from* the tool response, so it may paraphrase. What it cannot
 * do is read a response whose every field says this did not work and conclude
 * that it did.
 *
 * The two groups are the safety property, not tidiness. `lib/tools/say.test.ts`
 * holds `NOT_COMMITTED` to containing no success language, and that test is only
 * meaningful because the lines that *may* claim success live somewhere else.
 */

/** Lines that may tell the customer something was written down. */
export const COMMITTED = {
  /**
   * `time` comes from `lib/tools/spoken-time.ts` — "Monday 17 August at 10:00 AM".
   *
   * Leads with the fact that it is done. This is the only sentence in the system
   * entitled to say a Reschedule committed, and it is spoken *after* the write,
   * so it states the outcome rather than an intention — see the `book_slot`
   * filler in `lib/retell/tools.ts` for the sentence that covers the gap before.
   */
  booked: (time: string): string =>
    `That's booked in — you're all set for ${time}.`,
  /**
   * A second `book_slot` in one Call, refused by
   * `tool_invocations_one_booking_per_call`.
   *
   * This sits in COMMITTED deliberately. The second Reschedule was refused, but
   * a first one *did* commit earlier in the same Call — so telling the person
   * they are booked is true, and putting it in the other group would make the
   * failure-line test either wrong or toothless.
   */
  alreadyBooked: "You're already booked in — there's nothing else to change.",
  confirmed: "That's locked in, thanks.",
  cancelled: "That's cancelled, thanks for letting me know.",
} as const;

/** Lines for when nothing was written down. None of these may suggest otherwise. */
export const NOT_COMMITTED = {
  /** SPEC.md §8 step 2, verbatim in intent: a callback, never a claim. */
  bookFailed:
    "I couldn't lock that in — I'll have someone call you back to confirm.",
  /**
   * A `slot_start` we never offered, or one that has since passed.
   *
   * Steers her back to `check_availability` rather than to a callback promise,
   * because nothing is actually wrong: she has simply named a time that is not
   * on the table.
   */
  notAvailable: "That time isn't available — let me check what else we have.",
  nothingOpen:
    "I don't have anything open in the next two weeks. " +
    "I'll have someone call you back.",
  wentWrong: "Something went wrong on my end — I'll have someone call you back.",
} as const;

/**
 * The line for `runTool`'s catch-all, which knows the Tool's name and nothing
 * else about what went wrong.
 *
 * A `book_slot` that threw is, to the person on the phone, the same event as a
 * Slot that was taken: not booked, someone will ring. Every other Tool gets the
 * vaguer line, because promising a callback about a failed availability check
 * would be promising the wrong thing.
 */
export function sayForError(name: ToolName): string {
  return BOOKING_TOOLS.includes(name)
    ? NOT_COMMITTED.bookFailed
    : NOT_COMMITTED.wentWrong;
}

/**
 * The Tools whose failure is, to the person on the phone, "not booked".
 *
 * `book_appointment` joins `book_slot` here in issue #43 for the identical
 * reason: a caller who has just agreed to Tuesday at four needs to be told
 * somebody will ring them, not that "something went wrong on my end". Both
 * lines are honest; only one of them says what happens next.
 */
const BOOKING_TOOLS: readonly ToolName[] = ["book_slot", "book_appointment"];

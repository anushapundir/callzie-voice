import type { NeedsAttentionReason } from "@/lib/db/schema";

/**
 * What to tell a person about an Appointment Callzie has stopped calling.
 *
 * Pure, and it takes the Slot already formatted rather than a `Date` and a
 * timezone. A time means nothing without the Business's zone, the Server
 * Component that renders this has the zone and calls `formatInZone` once, and
 * keeping `Intl` out of here is what makes every sentence testable as a string.
 * Same split `lib/appointments/status-style.ts` makes for the Status pill.
 *
 * Every sentence says two things: what went wrong, and what is still true about
 * the Slot. The second half is the one a person actually needs — the fear when
 * a row turns up in this list is that the appointment has been lost, and in
 * three of four cases nothing has been lost at all.
 *
 * `collision` is the exception and says nothing about the Slot, because both
 * times are still standing and that is the whole problem. SPEC.md §14 rule 3:
 * Callzie detects, blocks, and hands over.
 *
 * The time goes at the end rather than in front of the word "slot". Written the
 * other way it reads "The original Fri 14 Aug, 09:00 slot is still held" — a
 * date wedged between an adjective and its noun, which is a stumble on a screen
 * somebody is glancing at.
 *
 * A `switch` with no `default`, on purpose. `NeedsAttentionReason` is a closed
 * union, so a fifth reason added to `lib/db/schema.ts` fails `npm run typecheck`
 * here instead of rendering an empty row on somebody's dashboard.
 */

export type AttentionContext = {
  reason: NeedsAttentionReason;
  /** The Appointment's Slot, already formatted in the Business's timezone. */
  slotLabel: string;
  /**
   * How many Calls have been placed for this Appointment.
   *
   * The `unreachable` sentence says "Nobody answered after N attempts", which
   * is the same number only when every Call was a no-answer. It can overstate:
   * a Call that truncated, was cleared, and was then followed by one nobody
   * answered counts as two. Rare, and the number is still the honest count of
   * times this person's phone rang — but it is not a count of silences.
   */
  attempts: number;
};

export function explainNeedsAttention({
  reason,
  slotLabel,
  attempts,
}: AttentionContext): string {
  switch (reason) {
    case "book_failed":
      // SPEC.md §8 step 3: the Appointment keeps its original Slot. Maya has
      // already told the person somebody will call back to confirm.
      return `Maya could not book the new time. The original slot is still held — ${slotLabel}.`;

    case "collision":
      /*
        The only one of the four that ends by asking for a decision rather than
        reporting one. It is also the only one where there is a decision to make:
        two times are standing and somebody has to say which wins. SPEC.md §14
        rule 3 is that Callzie detects, blocks and hands over — handing over
        properly means saying what the person is being handed.
      */
      return (
        "This clashes with an event on the connected Google Calendar. " +
        "Callzie will not move either one — decide which keeps the time, " +
        "then clear this."
      );

    case "negotiation_truncated":
      // Worded around the outcome rather than the call cap, because
      // lib/calls/truncation.ts flags the wider case — a Call that named times
      // and committed nothing, whatever the clock said.
      return `The call ended before a new time was agreed. The slot is still held — ${slotLabel}.`;

    case "unreachable":
      return (
        `Nobody answered after ${attempts} ` +
        `${attempts === 1 ? "attempt" : "attempts"}. ` +
        `The slot is still held — ${slotLabel}.`
      );
  }
}

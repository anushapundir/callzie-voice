import { describe, expect, it } from "vitest";

import { explainNeedsAttention } from "@/lib/appointments/attention-reason";
import { NEEDS_ATTENTION_REASONS } from "@/lib/db/schema";

/*
  Issue #15's first acceptance criterion asks for "a specific, human-readable
  explanation" per reason. Specific means two things here: what went wrong, and
  what is still true about the Slot. The second half is the one a person needs —
  the fear when a row appears in this list is that the appointment has been lost.
*/

const SLOT = "Fri 14 Aug, 09:00";

describe("explainNeedsAttention", () => {
  it("says a booking failed and the old time still stands", () => {
    expect(
      explainNeedsAttention({
        reason: "book_failed",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toBe(
      `Maya could not book the new time. The original slot is still held — ${SLOT}.`,
    );
  });

  it("says a Collision is not Callzie's to resolve", () => {
    // SPEC.md §14 rule 3: it detects, blocks, and hands over.
    expect(
      explainNeedsAttention({
        reason: "collision",
        slotLabel: SLOT,
        attempts: 0,
      }),
    ).toBe(
      "This clashes with an event on the connected Google Calendar. " +
        "Callzie will not move either one — decide which keeps the time, " +
        "then clear this.",
    );
  });

  it("tells the reader what the Collision leaves them to decide", () => {
    /*
      The one reason of the four where a person has to choose something. Ending
      on "Callzie will not move either one" is a flat no; the sentence has to
      say what is now theirs to settle, or handing over is just refusing.
    */
    expect(
      explainNeedsAttention({
        reason: "collision",
        slotLabel: SLOT,
        attempts: 0,
      }),
    ).toContain("decide which keeps the time");
  });

  it("says the call ended before anything was agreed", () => {
    expect(
      explainNeedsAttention({
        reason: "negotiation_truncated",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toBe(
      `The call ended before a new time was agreed. The slot is still held — ${SLOT}.`,
    );
  });

  it("counts the attempts nobody answered", () => {
    expect(
      explainNeedsAttention({
        reason: "unreachable",
        slotLabel: SLOT,
        attempts: 2,
      }),
    ).toBe(`Nobody answered after 2 attempts. The slot is still held — ${SLOT}.`);
  });

  it("says one attempt, not one attempts", () => {
    // A count with the wrong noun reads as a bug, the same call
    // components/overview/csv-rejections.tsx makes for rows.
    expect(
      explainNeedsAttention({
        reason: "unreachable",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toContain("after 1 attempt.");
  });

  it("has a sentence for every reason the schema allows", () => {
    /*
      The guard that matters. `collision` has no writer until #20 and
      `NEEDS_ATTENTION_REASONS` is the only list of all four — if somebody adds a
      fifth, this fails here rather than rendering an empty row on the dashboard.
    */
    for (const reason of NEEDS_ATTENTION_REASONS) {
      const sentence = explainNeedsAttention({
        reason,
        slotLabel: SLOT,
        attempts: 1,
      });
      expect(sentence.length).toBeGreaterThan(0);
      /*
        And it is a sentence rather than the column value. `book_failed` on a
        dashboard is a developer's word showing through, which is the lazy way
        this function could be "completed" for a fifth reason someone adds in a
        hurry.
      */
      expect(sentence).not.toContain(reason);
    }
  });
});

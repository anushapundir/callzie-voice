import { describe, expect, it } from "vitest";

import { COMMITTED, NOT_COMMITTED, sayForError } from "@/lib/tools/say";

/*
  SPEC.md §3 rule 7 and §14 rule 4: Maya must never state that a booking
  succeeded when the Tool call failed. This is the most damaging failure
  available to this product, so the words are owned by the endpoint rather than
  left to the prompt — the same reasoning SPEC.md §3 rule 6 gives for Business
  Hours.

  What this file guards is small and specific: nobody softens a failure line into
  a reassuring one during a later edit.
*/

/** Phrases that would tell a customer their appointment is settled. */
const SOUNDS_LIKE_SUCCESS = [
  "all set",
  "locked in",
  "booked",
  "confirmed",
  "you're set",
  "sorted",
];

describe("NOT_COMMITTED", () => {
  it.each(Object.entries(NOT_COMMITTED))(
    "%s never sounds like a booking happened",
    (_key, line) => {
      for (const phrase of SOUNDS_LIKE_SUCCESS) {
        expect(line.toLowerCase()).not.toContain(phrase);
      }
    },
  );

  it.each(Object.entries(NOT_COMMITTED))("%s is a whole sentence", (_key, line) => {
    // Read aloud by a voice model. A fragment reads as a fragment.
    expect(line.length).toBeGreaterThan(20);
    expect(line.endsWith(".")).toBe(true);
  });

  it("offers a callback whenever a booking was attempted and did not happen", () => {
    expect(NOT_COMMITTED.bookFailed).toContain("call you back");
    expect(NOT_COMMITTED.nothingOpen).toContain("call you back");
    expect(NOT_COMMITTED.wentWrong).toContain("call you back");
  });
});

describe("COMMITTED", () => {
  it("reads the booked time back to the customer", () => {
    // SPEC.md §7 step 3: "call book_slot and read the booked time back to them".
    expect(COMMITTED.booked("Monday 17 August at 10:00 AM")).toContain(
      "Monday 17 August at 10:00 AM",
    );
  });
});

describe("COMMITTED.booked", () => {
  it("states the booking is done, not that it is being done", () => {
    // Said only after the write has landed, so it may speak in the past tense —
    // the sentence that covers the gap before is the book_slot filler in
    // lib/retell/tools.ts, and that one only ever asks the customer to hold.
    const line = COMMITTED.booked("Monday 24 August at 12:30 PM").toLowerCase();

    expect(line).toContain("booked in");
    for (const intention of ["i'll book", "placing a hold", "let me", "i am booking"]) {
      expect(line).not.toContain(intention);
    }
  });
});

describe("sayForError", () => {
  it("promises a callback when a booking blew up", () => {
    // An unexpected error during book_slot is indistinguishable, to the person
    // on the phone, from a Slot that was taken. Both mean: not booked, someone
    // will ring you.
    expect(sayForError("book_slot")).toBe(NOT_COMMITTED.bookFailed);
  });

  it("stays vague about a Tool that was not booking anything", () => {
    expect(sayForError("check_availability")).toBe(NOT_COMMITTED.wentWrong);
    expect(sayForError("confirm_appointment")).toBe(NOT_COMMITTED.wentWrong);
    expect(sayForError("cancel_appointment")).toBe(NOT_COMMITTED.wentWrong);
  });
});

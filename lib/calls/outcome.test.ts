import { describe, expect, it } from "vitest";

import { callOutcome, type InvocationRow } from "@/lib/calls/outcome";

/*
  The card that is the point of the whole screen: what the Agent DID, from
  `tool_invocations`, not what an LLM said about it afterwards (SPEC.md §9
  step 3).

  The rule that matters most here is that a failed invocation stays in the list,
  in place. A `book_slot` that failed is the most interesting row the card can
  hold — it is the moment Maya told somebody a time and Callzie could not honour
  it — and a card that quietly dropped it would be undoing the product's central
  claim.
*/

const AT = (seconds: number) => new Date(2026, 7, 21, 9, 0, seconds);

const THURSDAY_4PM = {
  slot_start: "2026-08-27T10:30:00.000Z",
  time: "Thursday at four in the afternoon",
};
const FRIDAY_11AM = {
  slot_start: "2026-08-28T05:30:00.000Z",
  time: "Friday at eleven in the morning",
};

const CHECK = (
  slots: { slot_start: string; time: string }[],
  seconds: number,
): InvocationRow => ({
  id: `check-${seconds}`,
  toolName: "check_availability",
  arguments: {},
  result: { ok: true, slots },
  succeeded: true,
  latencyMs: 120,
  createdAt: AT(seconds),
});

describe("callOutcome", () => {
  it("keeps a failed invocation in the list, in order", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM], 1),
      {
        id: "book-fail",
        toolName: "book_slot",
        arguments: { slot_start: THURSDAY_4PM.slot_start },
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 340,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.invocations).toHaveLength(2);
    expect(outcome.invocations[1].succeeded).toBe(false);
    expect(outcome.invocations[1].toolName).toBe("book_slot");
  });

  it("orders invocations by when they ran, not by how they arrived", () => {
    const outcome = callOutcome([CHECK([FRIDAY_11AM], 9), CHECK([THURSDAY_4PM], 1)]);

    expect(outcome.invocations.map((row) => row.id)).toEqual(["check-1", "check-9"]);
  });

  it("collects the offered Slots across every check, deduped, in first-seen order", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM, FRIDAY_11AM], 1),
      CHECK([FRIDAY_11AM], 5),
    ]);

    expect(outcome.offeredSlots).toEqual([THURSDAY_4PM, FRIDAY_11AM]);
  });

  it("ignores the Slots of a check that failed", () => {
    const outcome = callOutcome([{ ...CHECK([THURSDAY_4PM], 1), succeeded: false }]);

    expect(outcome.offeredSlots).toEqual([]);
  });

  it("reports the time a successful book_slot committed", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM], 1),
      {
        id: "book-ok",
        toolName: "book_slot",
        arguments: { slot_start: THURSDAY_4PM.slot_start },
        result: { ok: true, booked_time: "Thursday at four in the afternoon" },
        succeeded: true,
        latencyMs: 410,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.bookedTime).toBe("Thursday at four in the afternoon");
  });

  it("reports no booked time when the booking failed", () => {
    const outcome = callOutcome([
      {
        id: "book-fail",
        toolName: "book_slot",
        arguments: {},
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 340,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.bookedTime).toBeNull();
  });

  it("says a Tool committed when confirm_appointment succeeded", () => {
    const outcome = callOutcome([
      {
        id: "confirm",
        toolName: "confirm_appointment",
        arguments: {},
        result: { ok: true },
        succeeded: true,
        latencyMs: 90,
        createdAt: AT(3),
      },
    ]);

    expect(outcome.aToolCommitted).toBe(true);
  });

  it("says no Tool committed when only check_availability ran", () => {
    const outcome = callOutcome([CHECK([THURSDAY_4PM], 1)]);

    expect(outcome.aToolCommitted).toBe(false);
  });

  it("survives a result of a shape nobody expected", () => {
    const outcome = callOutcome([
      { ...CHECK([], 1), result: "this should have been an object" },
    ]);

    expect(outcome.offeredSlots).toEqual([]);
    expect(outcome.invocations).toHaveLength(1);
  });

  it("returns an empty model for a Call where nothing ran", () => {
    const outcome = callOutcome([]);

    expect(outcome).toEqual({
      invocations: [],
      offeredSlots: [],
      bookedTime: null,
      aToolCommitted: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import { batchSummary } from "@/lib/calls/batch/summary";

/*
  What the Call all sheet says before it spends anything.

  Three refusals and three invitations. The numbers are the point: a sheet that
  said "Call 8 people?" while the Quota allowed three would be lying at the
  moment the person decides.
*/

describe("batchSummary", () => {
  it("refuses when the account cannot place Phone Calls", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 5,
      phoneCallsEnabled: false,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("Phone calls are off for this account");
  });

  it("refuses when there is nobody to call", () => {
    const summary = batchSummary({
      eligible: 0,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("No appointments to call");
  });

  it("refuses when the Quota is spent", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 0,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("You've used all your calls");
  });

  it("says how many will actually be placed when the Quota is smaller", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 3,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(true);
    expect(summary.willPlace).toBe(3);
    expect(summary.title).toBe("Call 3 of 8 people?");
    expect(summary.detail).toBe(
      "You have 3 calls left, so 3 will be placed and 5 stay pending. " +
        "Callzie calls at most 3 at a time.",
    );
  });

  it("calls everybody when the Quota allows it", () => {
    const summary = batchSummary({
      eligible: 4,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.willPlace).toBe(4);
    expect(summary.title).toBe("Call 4 people?");
    expect(summary.detail).toBe("Callzie calls at most 3 at a time.");
  });

  it("says person, not people, for one", () => {
    const summary = batchSummary({
      eligible: 1,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.title).toBe("Call 1 person?");
  });

  it("treats an unlimited Quota as no bound at all", () => {
    // An admin account. `quotaRemaining` is null rather than a number, because
    // Infinity does not survive the trip from the server (SPEC.md §11.1).
    const summary = batchSummary({
      eligible: 40,
      quotaRemaining: null,
      phoneCallsEnabled: true,
    });

    expect(summary.willPlace).toBe(40);
    expect(summary.title).toBe("Call 40 people?");
  });
});

import { describe, expect, it } from "vitest";

import { afterCall } from "@/lib/calls/batch/retry";

/*
  SPEC.md §14 rule 2 in one function: an unanswered phone is not a
  cancellation. One retry, then a human.

  Pure, so every case is a line — the same shape as lib/calls/truncation.ts,
  and for the same reason: the judgement is worth pinning separately from the
  writes it triggers.
*/

describe("afterCall", () => {
  it("retries the first silence", () => {
    expect(afterCall({ status: "no_answer", attempt: 1 })).toBe("retry");
  });

  it("gives up after the second", () => {
    expect(afterCall({ status: "no_answer", attempt: 2 })).toBe("unreachable");
  });

  it("gives up rather than looping if an attempt somehow got past two", () => {
    expect(afterCall({ status: "no_answer", attempt: 3 })).toBe("unreachable");
  });

  it("does nothing for a Call that connected", () => {
    expect(afterCall({ status: "completed", attempt: 1 })).toBe("nothing");
  });

  it("does nothing for a failure, which is not a silence", () => {
    // `error_user_not_joined` and `no_valid_payment` both map to `failed`
    // (docs/verification.md A9). Neither means nobody picked up the phone.
    expect(afterCall({ status: "failed", attempt: 1 })).toBe("nothing");
  });

  it("does nothing for a Call that has not finished", () => {
    expect(afterCall({ status: "in_progress", attempt: 1 })).toBe("nothing");
  });
});

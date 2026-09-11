import { describe, expect, it } from "vitest";

import { callFailure } from "@/lib/calls/failure-reason";

/*
  The failure card, which is the only card with anything to say on a Call that
  never connected.

  `lib/webhooks/status.ts` already classifies these — this does not re-derive
  the classification, it wraps it and adds the two things a screen needs: a
  sentence in ordinary words, and whether pressing Retry could possibly work.

  Credit exhaustion is the case that earns the module. Retrying cannot succeed
  until somebody tops up the Retell balance, and a button that cannot work is
  worse than no button — it turns one failure into a person pressing it four
  times.
*/

describe("callFailure", () => {
  it("says top up the balance, and offers no Retry, on credit exhaustion", () => {
    const failure = callFailure("no_valid_payment");

    expect(failure.canRetry).toBe(false);
    expect(failure.headline).toBe("The calling account is out of credit");
    expect(failure.detail).toContain("balance");
  });

  it("says wait, and offers Retry, on the concurrency limit", () => {
    const failure = callFailure("concurrency_limit_reached");

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("Too many calls at once");
  });

  it("distinguishes a voicemail from an unanswered phone", () => {
    expect(callFailure("voicemail_reached").headline).toBe("Voicemail picked up");
    expect(callFailure("dial_no_answer").headline).toBe("Nobody answered");
  });

  it("has its own sentence for a busy line and a declined Call", () => {
    expect(callFailure("dial_busy").headline).toBe("The line was busy");
    expect(callFailure("user_declined").headline).toBe("The call was declined");
  });

  it("has its own sentence for an IVR", () => {
    expect(callFailure("ivr_reached").headline).toBe("A phone menu answered");
  });

  it("offers Retry on every no-answer reason", () => {
    const reasons = [
      "dial_no_answer",
      "dial_busy",
      "user_declined",
      "voicemail_reached",
      "ivr_reached",
    ];

    for (const reason of reasons) {
      expect(callFailure(reason).canRetry).toBe(true);
    }
  });

  it("falls back to a generic sentence, and still offers Retry, on an unknown reason", () => {
    const failure = callFailure("some_reason_retell_added_last_tuesday");

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("The call failed");
    expect(failure.detail).toContain("some_reason_retell_added_last_tuesday");
  });

  it("handles a Call that ended with no reason recorded at all", () => {
    const failure = callFailure(null);

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("The call failed");
    expect(failure.detail.length).toBeGreaterThan(0);
  });
});

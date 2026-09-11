import { describe, expect, it } from "vitest";

import {
  MAX_DURATION_REACHED,
  NEAR_CAP_SECONDS,
  wasNegotiationTruncated,
} from "@/lib/calls/truncation";

/*
  SPEC.md §5: `negotiation_truncated` is set when a Call hit the 120s cap with no
  Tool committed. Callzie will not call that person again until a human clears it.

  Pure, so every case is here rather than reachable only by holding a real
  conversation for two minutes.
*/

describe("wasNegotiationTruncated", () => {
  it("is false whenever a Tool committed, however long the Call ran", () => {
    // A Call that booked, confirmed or cancelled has an outcome. Whatever else
    // happened to it, nothing was truncated.
    expect(
      wasNegotiationTruncated({ durationSeconds: 120, committed: true }),
    ).toBe(false);
  });

  it("is false even for Retell's own cap reason when a Tool committed", () => {
    expect(
      wasNegotiationTruncated({
        durationSeconds: 120,
        committed: true,
        disconnectionReason: MAX_DURATION_REACHED,
      }),
    ).toBe(false);
  });

  it("trusts Retell's reason over the clock", () => {
    // #13 supplies this. A Call the cap ended is truncated whatever the recorded
    // duration says.
    expect(
      wasNegotiationTruncated({
        durationSeconds: 3,
        committed: false,
        disconnectionReason: MAX_DURATION_REACHED,
      }),
    ).toBe(true);
  });

  it("falls back to the duration when nobody said why the Call ended", () => {
    // The Web Call path. The browser reports that the Call ended, not why.
    expect(
      wasNegotiationTruncated({
        durationSeconds: NEAR_CAP_SECONDS,
        committed: false,
      }),
    ).toBe(true);
  });

  it("flags a short Call that named times and booked none", () => {
    /*
      The live Call of 2026-08-21, exactly: three rounds of Offers, the customer
      accepted a time, Maya announced the booking without invoking book_slot, and
      the whole thing ended at 65 seconds. Under the cap, so the duration rule
      alone said nothing and the customer hung up believing she was booked.
    */
    expect(
      wasNegotiationTruncated({
        durationSeconds: 65,
        committed: false,
        offersMade: true,
      }),
    ).toBe(true);
  });

  it("says nothing about a Call that named times and then booked one", () => {
    expect(
      wasNegotiationTruncated({
        durationSeconds: 65,
        committed: true,
        offersMade: true,
      }),
    ).toBe(false);
  });

  it("leaves a short Call that never got as far as naming a time alone", () => {
    // A wrong number or voicemail. Maya never offered anything, so there is no
    // half-finished negotiation for a human to pick up.
    expect(
      wasNegotiationTruncated({
        durationSeconds: 12,
        committed: false,
        offersMade: false,
      }),
    ).toBe(false);
  });

  it("leaves a short Call alone", () => {
    // A wrong number or a voicemail is over in seconds and is not a negotiation
    // that ran out of time. #14's extraction covers those.
    expect(
      wasNegotiationTruncated({ durationSeconds: 12, committed: false }),
    ).toBe(false);
  });

  it("leaves a Call that never started alone", () => {
    // `duration_seconds` is null until a Call ends. A missing number is not a
    // long one.
    expect(
      wasNegotiationTruncated({ durationSeconds: null, committed: false }),
    ).toBe(false);
  });

  it("ignores a disconnection reason that means something else", () => {
    // docs/verification.md A9: an expired access token produces this one.
    expect(
      wasNegotiationTruncated({
        durationSeconds: 4,
        committed: false,
        disconnectionReason: "error_user_not_joined",
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  decideInbound,
  MAX_CALLS_PER_NUMBER,
  type InboundBusiness,
} from "@/lib/inbound/decide";

/*
  No database and no clock. Every branch of the guard is a value, which is the
  point of keeping this function pure — it runs inside Retell's ten-second
  budget on every inbound call, and the cost of getting it wrong is either a
  stranger's call going unanswered or an account billed for calls it never
  agreed to take.
*/

const READY: InboundBusiness = {
  id: "11111111-2222-3333-4444-555555555555",
  businessType: "clinic",
  inboundEnabled: true,
  inboundQuota: 20,
  inboundCallsUsed: 0,
  emergencyLine: "+12025550111",
  isAdmin: false,
};

const CALLER = "+12025550142";

function decide(
  overrides: Partial<InboundBusiness> = {},
  input: { fromNumber?: string | null; recentCallsFromNumber?: number } = {},
) {
  return decideInbound({
    business: { ...READY, ...overrides },
    fromNumber: input.fromNumber === undefined ? CALLER : input.fromNumber,
    recentCallsFromNumber: input.recentCallsFromNumber ?? 0,
  });
}

describe("decideInbound", () => {
  it("admits a ready Business and names the Agent to use", () => {
    expect(decide()).toEqual({
      admit: true,
      businessId: READY.id,
      businessType: "clinic",
    });
  });

  it("refuses a number no Business owns", () => {
    // A number released back to the carrier and re-issued, or somebody probing
    // the webhook. Either way there is no account to bill.
    expect(
      decideInbound({
        business: null,
        fromNumber: CALLER,
        recentCallsFromNumber: 0,
      }),
    ).toEqual({ admit: false, reason: "unknown_number" });
  });

  it("refuses an account that has not switched inbound on", () => {
    expect(decide({ inboundEnabled: false })).toEqual({
      admit: false,
      reason: "inbound_disabled",
    });
  });

  it("refuses an account with no emergency number", () => {
    /*
      Without one Maya cannot perform SPEC.md §14 rule 10, and that is the
      refusal that matters most. Not answering is recoverable; answering with
      nothing useful to say to somebody in pain is not.
    */
    expect(decide({ emergencyLine: null })).toEqual({
      admit: false,
      reason: "no_emergency_line",
    });
  });

  it("refuses a withheld caller ID", () => {
    // Cannot be rung back, cannot be rate limited, cannot be looked up. Rule 11
    // already refuses to book somebody unreachable, so the whole call would be
    // Maya declining to help.
    expect(decide({}, { fromNumber: null })).toEqual({
      admit: false,
      reason: "anonymous_caller",
    });
  });

  it("refuses an account that has used its inbound allowance", () => {
    expect(decide({ inboundQuota: 20, inboundCallsUsed: 20 })).toEqual({
      admit: false,
      reason: "quota_exhausted",
    });
  });

  it("lets an admin past the allowance", () => {
    const decision = decide({
      isAdmin: true,
      inboundQuota: 20,
      inboundCallsUsed: 999,
    });

    expect(decision.admit).toBe(true);
  });

  it("meters inbound separately from the outbound Quota", () => {
    /*
      An account chooses when to place a Call and does not choose when its phone
      rings. `callsUsed` is deliberately not an input here — if it were, a busy
      morning of outbound Calls would stop the phone being answered.
    */
    const decision = decide({ inboundCallsUsed: 0, inboundQuota: 1 });

    expect(decision.admit).toBe(true);
  });

  it("refuses a number that has already called too many times", () => {
    expect(decide({}, { recentCallsFromNumber: MAX_CALLS_PER_NUMBER })).toEqual({
      admit: false,
      reason: "too_many_recent_calls",
    });
  });

  it("lets a real person ring back after a dropped line", () => {
    // The rate limit must never catch somebody redialling because the call
    // failed. Four is well inside the window.
    expect(decide({}, { recentCallsFromNumber: 4 }).admit).toBe(true);
  });

  describe("the order of the guards", () => {
    /*
      Order is load-bearing, not cosmetic. Each guard narrows what the next has
      to consider, and the first four cost no query at all — `recentCalls` is
      the only input that costs a round trip.
    */
    it("reports the disabled flag before the missing emergency number", () => {
      // An account that never turned inbound on is not missing configuration;
      // it declined the feature. That is the more useful thing to be told.
      expect(
        decide({ inboundEnabled: false, emergencyLine: null }).admit,
      ).toBe(false);
      expect(decide({ inboundEnabled: false, emergencyLine: null })).toEqual({
        admit: false,
        reason: "inbound_disabled",
      });
    });

    it("reports an unknown number before anything about the account", () => {
      expect(
        decideInbound({
          business: null,
          fromNumber: null,
          recentCallsFromNumber: 99,
        }),
      ).toEqual({ admit: false, reason: "unknown_number" });
    });
  });
});

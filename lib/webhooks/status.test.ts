import { describe, expect, it } from "vitest";

import { failureKind, mapDisconnectionReason } from "@/lib/webhooks/status";

/*
  The whole of docs/verification.md A9, reason by reason.

  Written out in full rather than sampled, because the table is the contract
  between Retell's vocabulary and Callzie's. A reason that quietly falls through
  to `failed` is the exact bug A9 warns about — read the wrong field and every
  Call maps to `failed`, which looks like a working system having a bad day.
*/

const COMPLETED = [
  "user_hangup",
  "agent_hangup",
  "call_transfer",
  "call_take_over",
  "max_duration_reached",
  "inactivity",
  "transfer_bridged",
];

const NO_ANSWER = [
  "dial_no_answer",
  "dial_busy",
  "user_declined",
  "voicemail_reached",
  "ivr_reached",
];

const FAILED = [
  "dial_failed",
  "invalid_destination",
  "telephony_provider_permission_denied",
  "telephony_provider_unavailable",
  "sip_routing_error",
  "marked_as_spam",
  "concurrency_limit_reached",
  "no_concurrency_fallback",
  "no_valid_payment",
  "scam_detected",
  "error_llm_websocket_open",
  "error_llm_websocket_lost_connection",
  "error_llm_websocket_runtime",
  "error_llm_websocket_corrupt_payload",
  "error_no_audio_received",
  "error_asr",
  "error_retell",
  "error_unknown",
  "error_user_not_joined",
  "registered_call_timeout",
  "transfer_cancelled",
  "manual_stopped",
];

describe("mapDisconnectionReason", () => {
  it.each(COMPLETED)("%s is a completed Call", (reason) => {
    expect(mapDisconnectionReason(reason)).toBe("completed");
  });

  it.each(NO_ANSWER)("%s is a Call nobody answered", (reason) => {
    expect(mapDisconnectionReason(reason)).toBe("no_answer");
  });

  it.each(FAILED)("%s is a failed Call", (reason) => {
    expect(mapDisconnectionReason(reason)).toBe("failed");
  });

  /*
    Voicemail is the one a status-only check gets wrong. Retell reports
    `call_status: "ended"` for it, exactly as it does for a real conversation, so
    reading the status instead of the reason would file a machine picking up as
    a completed Call (A9).
  */
  it("does not mistake voicemail for a completed Call", () => {
    expect(mapDisconnectionReason("voicemail_reached")).toBe("no_answer");
  });

  /*
    A missing reason is `failed` rather than a throw. Retell's own docs put
    `disconnection_reason` on `call_ended` and `call_analyzed` only, and the
    field name is one letter away from our column's — so "absent" is an ordinary
    thing to receive, not an exceptional one.
  */
  it.each([null, undefined, ""])("treats %s as failed", (reason) => {
    expect(mapDisconnectionReason(reason)).toBe("failed");
  });

  // A reason Retell adds after this was written. Failing closed is the safe
  // direction: it shows up as a failure to look at rather than a completed Call
  // nobody checks.
  it("fails closed on a reason it has never seen", () => {
    expect(mapDisconnectionReason("error_something_invented_later")).toBe("failed");
  });
});

describe("failureKind", () => {
  /*
    Two reasons that must not read as a generic failure (issue #13, last
    acceptance criterion). `no_valid_payment` means the Retell credit is gone and
    nothing will connect until it is topped up; `concurrency_limit_reached` means
    wait a moment and try again. Same `failed` status, completely different thing
    for a person to do about it.
  */
  it("names an exhausted Retell balance", () => {
    expect(failureKind("no_valid_payment")).toBe("credit_exhausted");
  });

  it("names too many Calls at once", () => {
    expect(failureKind("concurrency_limit_reached")).toBe("concurrency_limit");
  });

  it.each(["error_retell", "dial_failed", null, undefined])(
    "leaves %s generic",
    (reason) => {
      expect(failureKind(reason)).toBe("generic");
    },
  );

  // A Call that went fine has no failure to name.
  it("leaves a completed Call generic", () => {
    expect(failureKind("user_hangup")).toBe("generic");
  });
});

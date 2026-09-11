import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseWebhookPayload } from "@/lib/webhooks/payload";

/*
  Reading Retell's envelope, and refusing anything that is not one.

  A malformed body on a URL reachable from the internet is ordinary, not
  exceptional, so this returns null and the route turns it into a 400 — the same
  contract `parseToolRequest` in lib/tools/request.ts uses, for the same reason.

  Everything here is a string in and a value out. No database, no clock.
*/

/** The two-key shape from docs/verification.md A7, as a string to parse. */
function body(call: Record<string, unknown>, event = "call_ended"): string {
  return JSON.stringify({ event, call: { call_id: "call_abc", ...call } });
}

describe("parseWebhookPayload", () => {
  it("reads the fields Callzie writes to a Call row", () => {
    const parsed = parseWebhookPayload(
      body({
        disconnection_reason: "user_hangup",
        transcript: "Agent: Hello.\nUser: Hi.\n",
        recording_url: "https://example.com/recording.wav",
        start_timestamp: 1787216400000,
        end_timestamp: 1787216495000,
        duration_ms: 95000,
      }),
    );

    expect(parsed).toEqual({
      event: "call_ended",
      retellCallId: "call_abc",
      callzieCallId: null,
      disconnectionReason: "user_hangup",
      transcript: "Agent: Hello.\nUser: Hi.\n",
      // Null for the same reason `inVoicemail` is: `transcript_object` rides on
      // `call_analyzed` only, so a `call_ended` never carries one (A9).
      transcriptTurns: null,
      recordingUrl: "https://example.com/recording.wav",
      // Null on a `call_ended`, which never carries `call_analysis` (A9).
      inVoicemail: null,
      startedAt: new Date(1787216400000),
      endedAt: new Date(1787216495000),
      durationSeconds: 95,
    });
  });

  /*
    lib/calls/start-web-call.ts:193 echoes the Callzie `calls.id` into every
    webhook as `metadata.call_id`. It is the fallback for finding the Call when
    `retell_call_id` has not landed on the row yet, so losing it here would lose
    the recovery path.
  */
  it("reads the Callzie call id back out of metadata", () => {
    const parsed = parseWebhookPayload(
      body({ metadata: { call_id: "9f1c", appointment_id: "44ab" } }),
    );

    expect(parsed?.callzieCallId).toBe("9f1c");
  });

  it.each([
    ["no metadata at all", {}],
    ["metadata with no call_id", { metadata: { appointment_id: "44ab" } }],
    ["a non-string call_id", { metadata: { call_id: 7 } }],
  ])("has no Callzie call id given %s", (_case, call) => {
    expect(parseWebhookPayload(body(call))?.callzieCallId).toBeNull();
  });

  describe("duration", () => {
    it("prefers duration_ms", () => {
      const parsed = parseWebhookPayload(
        body({
          duration_ms: 95000,
          start_timestamp: 1787216400000,
          // Deliberately disagrees. Retell's own number wins.
          end_timestamp: 1787216999000,
        }),
      );

      expect(parsed?.durationSeconds).toBe(95);
    });

    it("falls back to the two timestamps", () => {
      const parsed = parseWebhookPayload(
        body({
          start_timestamp: 1787216400000,
          end_timestamp: 1787216495000,
        }),
      );

      expect(parsed?.durationSeconds).toBe(95);
    });

    // A negative duration would be worse than a zero, the same call
    // lib/calls/record.ts:55 makes with GREATEST(..., 0).
    it("never goes negative", () => {
      const parsed = parseWebhookPayload(
        body({
          start_timestamp: 1787216495000,
          end_timestamp: 1787216400000,
        }),
      );

      expect(parsed?.durationSeconds).toBe(0);
    });

    it("is unknown when nothing says how long the Call ran", () => {
      expect(parseWebhookPayload(body({}))?.durationSeconds).toBeNull();
    });
  });

  /*
    An empty transcript is "nothing was said", which is what null means in that
    column. Keeping it as "" would also break the fill-if-null rule in
    process.ts: a call_ended that arrived before the transcript was ready would
    block the call_analyzed that carries it.
  */
  it.each(["transcript", "recording_url"])(
    "treats an empty %s as absent",
    (field) => {
      const parsed = parseWebhookPayload(body({ [field]: "" }));

      expect(parsed?.transcript ?? parsed?.recordingUrl).toBeNull();
    },
  );

  it("keeps an event it does not handle, rather than refusing it", () => {
    // Retell can send these; we subscribe to three (scripts/create-agent.ts:59).
    // Storing the raw row costs nothing and makes an unexpected delivery
    // visible instead of silently dropped.
    const parsed = parseWebhookPayload(body({}, "transcript_updated"));

    expect(parsed?.event).toBe("transcript_updated");
  });

  describe("refuses", () => {
    it.each([
      ["not JSON at all", "<html>sign in</html>"],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["a bare string", '"call_ended"'],
      ["an empty body", ""],
      ["no event name", JSON.stringify({ call: { call_id: "call_abc" } })],
      ["a non-string event name", JSON.stringify({ event: 7, call: { call_id: "a" } })],
      ["no call object", JSON.stringify({ event: "call_ended" })],
      ["a null call", JSON.stringify({ event: "call_ended", call: null })],
      ["no call id", JSON.stringify({ event: "call_ended", call: {} })],
      [
        "an empty call id",
        JSON.stringify({ event: "call_ended", call: { call_id: "" } }),
      ],
      [
        "a non-string call id",
        JSON.stringify({ event: "call_ended", call: { call_id: 7 } }),
      ],
    ])("%s", (_case, raw) => {
      expect(parseWebhookPayload(raw)).toBeNull();
    });
  });

  /*
    Every shipped fixture, parsed. This is what stops a fixture drifting into a
    shape the receiver cannot read — the replay suite is the only thing standing
    between this code and a real Call (SPEC.md §10).
  */
  it.each([
    "call-started",
    "call-ended-completed",
    "call-ended-no-answer",
    "call-ended-failed",
    "call-ended-credit-exhausted",
    "call-ended-concurrency",
    "call-analyzed",
  ])("parses the %s fixture", (name) => {
    const raw = readFileSync(`./fixtures/retell/webhooks/${name}.json`, "utf8");

    const parsed = parseWebhookPayload(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.retellCallId).toBe("CALL_ID_PLACEHOLDER");
    expect(parsed!.callzieCallId).toBe("CALLZIE_CALL_ID_PLACEHOLDER");
  });
});

describe("call_analysis.in_voicemail", () => {
  /** Retell only attaches `call_analysis` to `call_analyzed` (A9). */
  function analyzed(call: Record<string, unknown>) {
    return parseWebhookPayload(body(call, "call_analyzed"));
  }

  it("reads the flag when the analysis carries it", () => {
    expect(analyzed({ call_analysis: { in_voicemail: true } })?.inVoicemail).toBe(
      true,
    );
    expect(
      analyzed({ call_analysis: { in_voicemail: false } })?.inVoicemail,
    ).toBe(false);
  });

  it("is null when there is no analysis — call_ended never carries one", () => {
    expect(analyzed({})?.inVoicemail).toBeNull();
    expect(parseWebhookPayload(body({}))?.inVoicemail).toBeNull();
  });

  it("is null rather than false when the flag is not a boolean", () => {
    // Null means "Retell did not say", which is not the same as "not a
    // voicemail". Only an explicit `true` stops the outcome step.
    expect(
      analyzed({ call_analysis: { in_voicemail: "yes" } })?.inVoicemail,
    ).toBeNull();
  });

  it("is null when call_analysis is not an object", () => {
    expect(analyzed({ call_analysis: "done" })?.inVoicemail).toBeNull();
  });
});

describe("transcript_object", () => {
  /*
    The field only rides on `call_analyzed` (docs/verification.md A9). Absent on
    the other two events, which is not an error — it is null, meaning "Retell did
    not say", exactly like `in_voicemail`.
  */

  function analyzed(call: Record<string, unknown>) {
    return parseWebhookPayload(body(call, "call_analyzed"));
  }

  it("is read into transcriptTurns when present", () => {
    const event = analyzed({
      transcript_object: [
        {
          role: "agent",
          content: "Hi Priya.",
          words: [{ word: "Hi", start: 0.4, end: 0.6 }],
        },
      ],
    });

    expect(event?.transcriptTurns).toEqual([
      { role: "agent", content: "Hi Priya.", startSeconds: 0.4 },
    ]);
  });

  it("is null when the event does not carry one", () => {
    expect(parseWebhookPayload(body({}, "call_started"))?.transcriptTurns).toBeNull();
  });

  it("is null, and the delivery still parses, when the field is garbage", () => {
    const event = analyzed({
      transcript: "Agent: Hi Priya.",
      transcript_object: "not an array",
    });

    expect(event).not.toBeNull();
    expect(event?.transcriptTurns).toBeNull();
    expect(event?.transcript).toBe("Agent: Hi Priya.");
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { AppointmentStatus, CallStatus } from "@/lib/db/schema";
import type { ExtractionLlm } from "@/lib/extraction/llm";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";
import { parseWebhookPayload, type WebhookEvent } from "@/lib/webhooks/payload";
import { processWebhookEvent } from "@/lib/webhooks/process";

/*
  What a delivery does to the Call row.

  This is where the browser stops being the source of truth. Until now
  app/(app)/calls/actions.ts wrote the Call's ending from the page, and said in
  its own comment that #13 would overwrite all of it. So the rule these tests
  pin down is: Retell wins, including when it disagrees.

  What Retell does NOT win is the Appointment's outcome. If a Tool committed a
  Reschedule mid-call, the Tool wins (SPEC.md §9 step 3) — the webhook arrives
  afterwards and must not undo it.
*/

const CLERK_ID = "user_test_webhooks_process";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

const STARTED_AT = new Date(1787216400000);
const ENDED_AT = new Date(1787216495000);

let seed: ToolTestSeed;

/** A parsed delivery for the seeded Call. */
function event(
  type: string,
  call: Record<string, unknown> = {},
): WebhookEvent {
  const parsed = parseWebhookPayload(
    JSON.stringify({
      event: type,
      call: { call_id: seed.retellCallId, ...call },
    }),
  );
  if (!parsed) throw new Error("test fixture did not parse");
  return parsed;
}

/** A `call_ended` that ran for 95 seconds and ended for the given reason. */
function ended(reason: string, call: Record<string, unknown> = {}) {
  return event("call_ended", {
    disconnection_reason: reason,
    start_timestamp: STARTED_AT.getTime(),
    end_timestamp: ENDED_AT.getTime(),
    duration_ms: 95000,
    ...call,
  });
}

async function call() {
  return db.query.calls.findFirst({ where: eq(schema.calls.id, seed.callId) });
}

async function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

async function setCallStatus(status: CallStatus) {
  await db
    .update(schema.calls)
    .set({ status })
    .where(eq(schema.calls.id, seed.callId));
}

async function setAppointmentStatus(status: AppointmentStatus) {
  await db
    .update(schema.appointments)
    .set({ status })
    .where(eq(schema.appointments.id, seed.appointmentId));
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
    // Where a Call sits before Retell says anything about it.
    callStatus: "queued",
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("call_started", () => {
  it("moves a queued Call to in progress", async () => {
    await processWebhookEvent(event("call_started", { start_timestamp: STARTED_AT.getTime() }));

    const row = await call();
    expect(row!.status).toBe("in_progress");
    expect(row!.startedAt).toEqual(STARTED_AT);
  });

  /*
    Retell retries, so a `call_started` can land after the Call has already
    ended. Re-opening a finished Call would put a permanent live indicator in the
    topbar and a permanent shimmer on the row.
  */
  it.each(["completed", "no_answer", "failed"] as const)(
    "does not re-open a Call that already ended as %s",
    async (status) => {
      await setCallStatus(status);

      await processWebhookEvent(event("call_started"));

      expect((await call())!.status).toBe(status);
    },
  );

  it("is safe to apply twice", async () => {
    await processWebhookEvent(event("call_started", { start_timestamp: STARTED_AT.getTime() }));
    await processWebhookEvent(event("call_started", { start_timestamp: STARTED_AT.getTime() }));

    expect((await call())!.status).toBe("in_progress");
  });
});

describe("call_ended", () => {
  it("writes everything the browser never had", async () => {
    await processWebhookEvent(
      ended("user_hangup", {
        transcript: "Agent: Hello.\nUser: Hi.\n",
        recording_url: "https://example.com/recording.wav",
      }),
    );

    const row = await call();
    expect(row!.status).toBe("completed");
    expect(row!.disconnectReason).toBe("user_hangup");
    expect(row!.durationSeconds).toBe(95);
    expect(row!.transcript).toBe("Agent: Hello.\nUser: Hi.\n");
    expect(row!.recordingUrl).toBe("https://example.com/recording.wav");
    expect(row!.startedAt).toEqual(STARTED_AT);
    expect(row!.endedAt).toEqual(ENDED_AT);
  });

  it.each([
    ["user_hangup", "completed"],
    ["agent_hangup", "completed"],
    ["dial_no_answer", "no_answer"],
    ["voicemail_reached", "no_answer"],
    ["error_user_not_joined", "failed"],
    ["no_valid_payment", "failed"],
    ["concurrency_limit_reached", "failed"],
  ] as const)("maps %s to %s", async (reason, status) => {
    await processWebhookEvent(ended(reason));

    expect((await call())!.status).toBe(status);
  });

  /*
    The disagreement case. The browser reported a clean ending — it always does,
    the tab closed normally — but Retell says the user never joined. Retell is
    the one that was actually on the call.
  */
  it("overrules a completed Call the browser reported", async () => {
    await setCallStatus("completed");

    await processWebhookEvent(ended("error_user_not_joined"));

    expect((await call())!.status).toBe("failed");
  });

  it("still records an ending time when Retell sends no end timestamp", async () => {
    await processWebhookEvent(event("call_ended", { disconnection_reason: "user_hangup" }));

    expect((await call())!.endedAt).not.toBeNull();
  });

  it("leaves the transcript alone when the delivery has none", async () => {
    await processWebhookEvent(ended("user_hangup", { transcript: "Said something." }));

    await processWebhookEvent(ended("user_hangup"));

    expect((await call())!.transcript).toBe("Said something.");
  });

  it("is safe to apply twice", async () => {
    await processWebhookEvent(ended("user_hangup", { transcript: "Once." }));
    await processWebhookEvent(ended("user_hangup", { transcript: "Once." }));

    const row = await call();
    expect(row!.status).toBe("completed");
    expect(row!.durationSeconds).toBe(95);
  });

  describe("the Appointment", () => {
    it("goes back to pending when nothing decided it", async () => {
      await processWebhookEvent(ended("user_hangup"));

      expect((await appointment())!.status).toBe("pending");
    });

    /*
      SPEC.md §9 step 3, and the reason `releaseAppointment` is guarded rather
      than unconditional: a Tool that committed mid-call has already written the
      outcome, and this arrives afterwards.
    */
    it.each(["confirmed", "rescheduled", "cancelled"] as const)(
      "does not overwrite a Tool-written %s",
      async (status) => {
        await setAppointmentStatus(status);

        await processWebhookEvent(ended("user_hangup"));

        expect((await appointment())!.status).toBe(status);
      },
    );
  });
});

describe("call_analyzed", () => {
  /*
    Every test in this block passes an extractor, and that is not optional.

    `applyAnalyzed` builds a real Anthropic client when it is given none, so a
    `call_analyzed` event with no fake would make this suite spend money the
    moment anyone has a key in .env.local. `silent` is the default for tests
    that are not about Extraction: it answers nothing readable, which fails
    softly and leaves the Call row alone.
  */
  const silent: ExtractionLlm = async () => ({ raw: "", stopReason: "end_turn" });

  /** Answers with one valid extraction, and counts how often it was asked. */
  function saying(fields: Record<string, unknown>) {
    const prompts: string[] = [];
    const llm: ExtractionLlm = async (prompt) => {
      prompts.push(prompt);
      return {
        raw: JSON.stringify({
          notes: null,
          summary: "She confirmed.",
          sentiment: "positive",
          confirmed: null,
          new_time: null,
          ...fields,
        }),
        stopReason: "end_turn",
      };
    };
    return Object.assign(llm, { prompts });
  }

  it("fills in a transcript that never arrived", async () => {
    await processWebhookEvent(ended("user_hangup"));

    await processWebhookEvent(
      event("call_analyzed", { transcript: "Arrived late.\n" }),
      silent,
    );

    expect((await call())!.transcript).toBe("Arrived late.\n");
  });

  /*
    docs/verification.md A9 records `recording_url` timing as unverified —
    neither page says whether it rides on `call_ended` or only on
    `call_analyzed`. So take whichever carries it, and never blank one that is
    already there.
  */
  it("fills in a recording url that call_ended did not carry", async () => {
    await processWebhookEvent(ended("user_hangup"));

    await processWebhookEvent(
      event("call_analyzed", { recording_url: "https://example.com/r.wav" }),
      silent,
    );

    expect((await call())!.recordingUrl).toBe("https://example.com/r.wav");
  });

  it("does not overwrite a transcript call_ended already delivered", async () => {
    await processWebhookEvent(ended("user_hangup", { transcript: "The real one.\n" }));

    await processWebhookEvent(
      event("call_analyzed", { transcript: "A later one.\n" }),
      silent,
    );

    expect((await call())!.transcript).toBe("The real one.\n");
  });

  // The status was decided by call_ended. Analysis is extra detail about a Call
  // that has already finished, not a second opinion on how it went.
  it("never changes the status", async () => {
    await processWebhookEvent(ended("dial_no_answer"));

    await processWebhookEvent(
      event("call_analyzed", { disconnection_reason: "user_hangup" }),
      silent,
    );

    expect((await call())!.status).toBe("no_answer");
  });

  it("extracts the transcript once the analysis lands", async () => {
    await processWebhookEvent(
      ended("user_hangup", { transcript: "Agent: Hello.\nUser: Yes, that's fine.\n" }),
    );

    const llm = saying({ confirmed: true });
    await processWebhookEvent(
      event("call_analyzed", { call_analysis: { in_voicemail: false } }),
      llm,
    );

    const row = await db.query.extractions.findFirst({
      where: eq(schema.extractions.callId, seed.callId),
    });
    expect(row?.summary).toBe("She confirmed.");
    expect(row?.inVoicemail).toBe(false);
    // No Tool committed on this Call, so the fallback is what decides it.
    expect((await appointment())!.status).toBe("confirmed");
  });

  it("does not break the Call row when the model is unreachable", async () => {
    await processWebhookEvent(ended("user_hangup", { transcript: "Agent: Hello.\n" }));

    // SPEC.md §3 rule 5. A 429, a timeout, or an absent ANTHROPIC_API_KEY all
    // arrive here as a thrown error, and none of them may undo the write above.
    await expect(
      processWebhookEvent(
        event("call_analyzed", { recording_url: "https://example.com/r.wav" }),
        async () => {
          throw new Error("connect ETIMEDOUT");
        },
      ),
    ).resolves.toBeUndefined();

    expect((await call())!.recordingUrl).toBe("https://example.com/r.wav");
    expect((await appointment())!.status).toBe("pending");
  });
});

describe("finding the Call", () => {
  /*
    The recovery path. `lib/calls/start-web-call.ts` writes `retell_call_id` in a
    second statement after Retell returns, so a very fast `call_started` can beat
    it. The Callzie id was echoed into the metadata for exactly this.
  */
  it("falls back to the id echoed in metadata", async () => {
    await db
      .update(schema.calls)
      .set({ retellCallId: null })
      .where(eq(schema.calls.id, seed.callId));

    await processWebhookEvent(
      event("call_started", {
        start_timestamp: STARTED_AT.getTime(),
        metadata: { call_id: seed.callId },
      }),
    );

    expect((await call())!.status).toBe("in_progress");
  });

  it("does nothing for a Call it has never heard of", async () => {
    const stranger = parseWebhookPayload(
      JSON.stringify({
        event: "call_ended",
        call: { call_id: "call_nobody_has_ever_seen", disconnection_reason: "user_hangup" },
      }),
    )!;

    await expect(processWebhookEvent(stranger)).resolves.toBeUndefined();
    expect((await call())!.status).toBe("queued");
  });

  it("ignores a metadata id belonging to no Call", async () => {
    const stranger = parseWebhookPayload(
      JSON.stringify({
        event: "call_ended",
        call: {
          call_id: "call_nobody_has_ever_seen",
          metadata: { call_id: "8f1d4c5e-0000-4000-8000-000000000000" },
          disconnection_reason: "user_hangup",
        },
      }),
    )!;

    await expect(processWebhookEvent(stranger)).resolves.toBeUndefined();
  });
});

describe("an event Callzie does not act on", () => {
  // We subscribe to three (scripts/create-agent.ts:59) but the account-level
  // webhook can deliver others. Stored, not acted on, never a crash.
  it("leaves the Call untouched", async () => {
    await processWebhookEvent(event("transcript_updated", { transcript: "Live text." }));

    const row = await call();
    expect(row!.status).toBe("queued");
    expect(row!.transcript).toBeNull();
  });
});

describe("transcript_turns", () => {
  /*
    Written under `coalesce`, like `transcript` and `recording_url` beside it.
    Retell retries a delivery up to three times on a 10-second timeout, so a
    second `call_analyzed` arriving after the first has already landed must be a
    no-op rather than a rewrite.

    The extractor is passed for the reason the `call_analyzed` block above gives:
    `applyAnalyzed` builds a real Anthropic client when given none, and these
    tests are not about Extraction.
  */
  const silent: ExtractionLlm = async () => ({ raw: "", stopReason: "end_turn" });

  /** Retell's shape, which `event()` runs through the real parser. */
  const RETELL_TURNS = [
    {
      role: "agent",
      content: "Hi Priya.",
      words: [{ word: "Hi", start: 0.4, end: 0.6 }],
    },
  ];

  /** The same thing, as it should land in the column. */
  const STORED_TURNS = [{ role: "agent", content: "Hi Priya.", startSeconds: 0.4 }];

  async function storedTurns() {
    const [row] = await db
      .select({ transcriptTurns: schema.calls.transcriptTurns })
      .from(schema.calls)
      .where(eq(schema.calls.id, seed.callId));

    return row.transcriptTurns;
  }

  it("writes the turns the delivery carried", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
      silent,
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });

  it("does not blank them when a later delivery carries none", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
      silent,
    );
    await processWebhookEvent(
      event("call_analyzed", { transcript: "Agent: Hi Priya." }),
      silent,
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });

  it("does not overwrite turns an earlier delivery already wrote", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
      silent,
    );
    await processWebhookEvent(
      event("call_analyzed", {
        transcript_object: [
          {
            role: "agent",
            content: "Different.",
            words: [{ word: "Different.", start: 9 }],
          },
        ],
      }),
      silent,
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });
});

/*
  What a silence leaves behind (issue #17).

  SPEC.md §14 rule 2 is the rule under test: an unanswered phone is not a
  cancellation. One retry, then a human — and the Slot never moves.
*/
describe("a Call nobody answered", () => {
  async function setAttempt(attempt: number) {
    await db
      .update(schema.calls)
      .set({ attempt })
      .where(eq(schema.calls.id, seed.callId));
  }

  it("puts the Appointment back in the queue after the first", async () => {
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())!.status).toBe("queued");
    expect((await call())!.status).toBe("no_answer");
  });

  it("gives up after the second, and asks for a human", async () => {
    await setAttempt(2);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    const row = await appointment();
    expect(row!.status).toBe("unreachable");
    expect(row!.needsAttentionReason).toBe("unreachable");
  });

  it("keeps the Slot when it gives up", async () => {
    await setAttempt(2);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("treats voicemail as a silence, because a machine is not the person", async () => {
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("voicemail_reached"));

    expect((await appointment())!.status).toBe("queued");
  });

  it("leaves a Call that simply failed alone", async () => {
    // `error_user_not_joined` maps to `failed`, not `no_answer`
    // (docs/verification.md A9). Nobody declined to pick up a phone.
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("error_user_not_joined"));

    expect((await appointment())!.status).toBe("pending");
  });

  it("does not undo an outcome a Tool committed", async () => {
    await setAttempt(1);
    await setAppointmentStatus("confirmed");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())!.status).toBe("confirmed");
  });

  it("is a no-op on a delivery that arrives twice", async () => {
    await setAttempt(2);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));
    await processWebhookEvent(ended("dial_no_answer"));

    const row = await appointment();
    expect(row!.status).toBe("unreachable");
    expect(row!.needsAttentionReason).toBe("unreachable");
  });

  it("gives up on an Appointment still waiting from the first silence", async () => {
    /*
      The state the second silence really finds it in, and the bug
      scripts/replay-webhook.ts caught: the retry from attempt 1 leaves the
      Appointment `queued`, and while `phone_calls_enabled` is off nothing moves
      it back to `calling`. Keying the give-up write on `pending` alone left it
      stuck in the queue after its final attempt.
    */
    await setAttempt(2);
    await setAppointmentStatus("queued");

    await processWebhookEvent(ended("dial_no_answer"));

    const row = await appointment();
    expect(row!.status).toBe("unreachable");
    expect(row!.needsAttentionReason).toBe("unreachable");
    expect(row!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });
});

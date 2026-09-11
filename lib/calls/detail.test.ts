import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCallDetail } from "@/lib/calls/detail";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The single read behind the Call detail screen.

  Two things are worth a database test rather than a unit test. The first is the
  tenancy guard: `callId` arrives from the URL, this app is open signup, and a
  loader that read across accounts would put one Business's transcript on
  another's screen. The second is that the joins actually line up — four tables,
  and a wrong join key returns plausible-looking nonsense rather than an error.
*/

const CLERK_ID = "user_test_call_detail";
const OTHER_CLERK_ID = "user_test_call_detail_other";
const STARTS_AT = new Date("2026-08-27T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);

  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
    callStatus: "completed",
  });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
    callStatus: "completed",
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("loadCallDetail", () => {
  it("returns null for a Call belonging to another Business", async () => {
    expect(await loadCallDetail(seed.businessId, other.callId)).toBeNull();
  });

  it("returns null for an id that is not a Call at all", async () => {
    const detail = await loadCallDetail(
      seed.businessId,
      "00000000-0000-0000-0000-000000000000",
    );

    expect(detail).toBeNull();
  });

  it("carries the person and the Service off the Appointment", async () => {
    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.personName).toBe("Priya Sharma");
    expect(detail?.serviceName).toBe("Haircut");
    expect(detail?.appointmentId).toBe(seed.appointmentId);
  });

  it("returns the Tool invocations in the order they ran", async () => {
    await db.insert(schema.toolInvocations).values([
      {
        callId: seed.callId,
        toolName: "check_availability",
        arguments: {},
        result: { ok: true, slots: [] },
        succeeded: true,
        latencyMs: 100,
      },
      {
        callId: seed.callId,
        toolName: "book_slot",
        arguments: {},
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 200,
      },
    ]);

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.outcome.invocations).toHaveLength(2);
    expect(detail?.outcome.invocations[0].toolName).toBe("check_availability");
    expect(detail?.outcome.invocations[1].succeeded).toBe(false);
  });

  it("returns a null extraction rather than throwing when none exists yet", async () => {
    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.extraction).toBeNull();
  });

  it("carries the extraction when one exists", async () => {
    await db.insert(schema.extractions).values({
      callId: seed.callId,
      notes: "Wants an evening slot next time.",
      summary: "Rebooked to Thursday afternoon.",
      sentiment: "positive",
      inVoicemail: false,
      status: "ok",
    });

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.extraction?.summary).toBe("Rebooked to Thursday afternoon.");
    expect(detail?.extraction?.sentiment).toBe("positive");
  });

  it("renders a transcript from the plain text when there are no stored turns", async () => {
    await db
      .update(schema.calls)
      .set({ transcript: "Agent: Hello.\nUser: Hi." })
      .where(eq(schema.calls.id, seed.callId));

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.turns).toEqual([
      { speaker: "agent", text: "Hello.", startSeconds: null },
      { speaker: "person", text: "Hi.", startSeconds: null },
    ]);
    expect(detail?.hasTranscript).toBe(true);
  });

  it("prefers the stored turns, with their timestamps", async () => {
    await db
      .update(schema.calls)
      .set({
        transcript: "Agent: Something else.",
        transcriptTurns: [{ role: "agent", content: "Hello.", startSeconds: 0.4 }],
      })
      .where(eq(schema.calls.id, seed.callId));

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.turns).toEqual([
      { speaker: "agent", text: "Hello.", startSeconds: 0.4 },
    ]);
  });

  it("counts the attempts on this Appointment, so the header can say 2 of 2", async () => {
    await db.insert(schema.calls).values({
      businessId: seed.businessId,
      appointmentId: seed.appointmentId,
      callType: "web",
      attempt: 2,
      status: "queued",
    });

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.attemptCount).toBe(2);
  });
});

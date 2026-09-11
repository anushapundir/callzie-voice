import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { AppointmentStatus, ToolName } from "@/lib/db/schema";
import { applyExtractionOutcome } from "@/lib/extraction/outcome";
import type { ExtractionResult } from "@/lib/extraction/parse";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The rule this ticket exists to protect: a committed Tool outcome always wins
  (SPEC.md §9 step 3).

  The fallback fields are for one case only — a Call where Maya talked to
  somebody and invoked nothing. Every other case must leave the Appointment
  exactly as the Tools left it, and there are more ways for that to be quietly
  wrong than for it to be right, which is why the Tool-wins case gets a
  describe.each rather than a single test.
*/

const CLERK_ID = "user_test_extraction_outcome";
const STARTS_AT = new Date("2026-08-20T09:00:00.000Z");

let seed: ToolTestSeed;

/** What extraction returns for a Call that reached no outcome at all. */
function result(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    notes: null,
    summary: "A call happened.",
    sentiment: "neutral",
    confirmed: null,
    newTime: null,
    ...overrides,
  };
}

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

/** Put the Appointment where `call_ended` leaves one nobody decided. */
async function setStatus(status: AppointmentStatus) {
  await db
    .update(schema.appointments)
    .set({ status })
    .where(eq(schema.appointments.id, seed.appointmentId));
}

/** A Tool ran on this Call. `succeeded: false` is a Tool that did NOT commit. */
async function recordTool(toolName: ToolName, succeeded = true) {
  await db.insert(schema.toolInvocations).values({
    callId: seed.callId,
    toolName,
    arguments: {},
    result: {},
    succeeded,
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  // Where releaseAppointment leaves an Appointment once its Call is over.
  await setStatus("pending");
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("when no Tool committed", () => {
  it("confirms an Appointment the person agreed to keep", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });

  it("declines one the person refused, which frees the Slot", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: false }),
    });

    // `declined` is in SLOT_FREEING_STATUSES, so the Slot is released by the
    // status alone — there is no second step that could disagree with it.
    expect((await appointment()).status).toBe("declined");
  });

  it("flags a new time for a human, and never books it", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
    expect(row.status).toBe("pending");
    expect(row.startsAt).toEqual(STARTS_AT);
  });

  it("lets a new time outrank a confirmation in the same answer", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true, newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
  });

  it("does nothing when the call never got to an outcome", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result(),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });

  it("leaves a Tool that ran and FAILED to the fallback", async () => {
    // A book_slot the exclusion constraint rejected committed nothing, so there
    // is no outcome for it to defend (SPEC.md §9 step 3).
    await recordTool("book_slot", false);

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });

  it("leaves a check_availability to the fallback, because a read commits nothing", async () => {
    await recordTool("check_availability");

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });
});

describe("when a Tool committed", () => {
  const committed: { tool: ToolName; status: AppointmentStatus }[] = [
    { tool: "confirm_appointment", status: "confirmed" },
    { tool: "book_slot", status: "rescheduled" },
    { tool: "cancel_appointment", status: "cancelled" },
  ];

  const contradictions: ExtractionResult[] = [
    result({ confirmed: true }),
    result({ confirmed: false }),
    result({ newTime: "Friday morning" }),
  ];

  for (const { tool, status } of committed) {
    for (const [index, contradiction] of contradictions.entries()) {
      it(`keeps ${status} after ${tool}, whatever extraction says (${index})`, async () => {
        await recordTool(tool);
        await setStatus(status);

        await applyExtractionOutcome({
          callId: seed.callId,
          appointmentId: seed.appointmentId,
          inVoicemail: null,
          result: contradiction,
        });

        const row = await appointment();
        expect(row.status).toBe(status);
        expect(row.needsAttentionReason).toBeNull();
      });
    }
  }
});

describe("when Retell says it was a voicemail", () => {
  it("writes nothing, because nobody was on the line", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: true,
      result: result({ confirmed: true, newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });
});

describe("the status guard", () => {
  it("will not move an Appointment that is not pending", async () => {
    // No tool_invocations row at all, so only the third gate can stop this.
    await setStatus("rescheduled");

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: false }),
    });

    expect((await appointment()).status).toBe("rescheduled");
  });
});

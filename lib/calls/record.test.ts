import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import {
  recordCallEnded,
  recordCallFailed,
  recordCallStarted,
} from "@/lib/calls/record";
import { db, schema } from "@/lib/db";
import type {
  AppointmentStatus,
  NeedsAttentionReason,
  ToolName,
} from "@/lib/db/schema";

const CLERK_ID = "user_test_record_call";
const OTHER_CLERK_ID = "user_test_record_call_other";

let businessId: string;
let appointmentId: string;
let callId: string;
let otherBusinessId: string;

async function cleanupFor(clerkId: string) {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    const appointments = await db
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    for (const appointment of appointments) {
      const calls = await db
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));

      // tool_invocations references calls. Inner first, or the delete is
      // refused by the foreign key.
      for (const call of calls) {
        await db
          .delete(schema.toolInvocations)
          .where(eq(schema.toolInvocations.callId, call.id));
      }

      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}

async function cleanup() {
  await cleanupFor(CLERK_ID);
  await cleanupFor(OTHER_CLERK_ID);
}

async function seed(clerkId: string) {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Record Test Clinic",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
    })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({
      businessId: business.id,
      name: "Cleaning",
      durationMinutes: 30,
    })
    .returning();
  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Nair",
      phoneE164: "+12025550142",
      startsAt: new Date("2026-09-05T03:30:00.000Z"),
      endsAt: new Date("2026-09-05T04:00:00.000Z"),
      status: "calling",
    })
    .returning();
  const [call] = await db
    .insert(schema.calls)
    .values({
      businessId: business.id,
      appointmentId: appointment.id,
      callType: "web",
      status: "queued",
    })
    .returning();

  return {
    businessId: business.id,
    appointmentId: appointment.id,
    callId: call.id,
  };
}

async function callRow() {
  const call = await db.query.calls.findFirst({
    where: eq(schema.calls.id, callId),
  });
  return call!;
}

async function appointmentStatus(): Promise<AppointmentStatus> {
  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  return appointment!.status;
}

/**
 * Backdate the Call's start, so `recordCallEnded` computes a long duration.
 *
 * The duration is derived in SQL from `started_at`, never taken from the
 * browser, so this is the only way to stage a Call that ran to the cap.
 */
async function startedSecondsAgo(seconds: number) {
  await db
    .update(schema.calls)
    .set({
      status: "in_progress",
      startedAt: new Date(Date.now() - seconds * 1000),
    })
    .where(eq(schema.calls.id, callId));
}

/** Write a `tool_invocations` row, as a Tool call would. */
async function recordTool(toolName: ToolName, succeeded: boolean) {
  await db.insert(schema.toolInvocations).values({
    callId,
    toolName,
    arguments: {},
    result: { ok: succeeded },
    succeeded,
    latencyMs: 2,
  });
}

async function needsAttention(): Promise<NeedsAttentionReason | null> {
  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  return appointment!.needsAttentionReason as NeedsAttentionReason | null;
}


beforeEach(async () => {
  await cleanup();
  ({ businessId, appointmentId, callId } = await seed(CLERK_ID));
  ({ businessId: otherBusinessId } = await seed(OTHER_CLERK_ID));
});

afterEach(cleanup);

describe("recordCallStarted", () => {
  it("moves the Call to in_progress and stamps the start", async () => {
    await recordCallStarted(businessId, callId);

    const call = await callRow();
    expect(call.status).toBe("in_progress");
    expect(call.startedAt).toBeInstanceOf(Date);
  });

  it("leaves the Appointment calling, because the Call is still going", async () => {
    await recordCallStarted(businessId, callId);

    expect(await appointmentStatus()).toBe("calling");
  });
});

describe("recordCallEnded", () => {
  it("completes the Call and computes its length on the server", async () => {
    await recordCallStarted(businessId, callId);
    await recordCallEnded(businessId, callId);

    const call = await callRow();
    expect(call.status).toBe("completed");
    expect(call.endedAt).toBeInstanceOf(Date);
    expect(call.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("never records a negative length, even with no start", async () => {
    // A Call that ended without ever reporting a start.
    await recordCallEnded(businessId, callId);

    expect((await callRow()).durationSeconds).toBe(0);
  });

  it("returns the Appointment to pending, because nothing decided it", async () => {
    await recordCallEnded(businessId, callId);

    expect(await appointmentStatus()).toBe("pending");
  });

  it("never overwrites an outcome a Tool committed", async () => {
    /*
      SPEC.md §9 step 3 — if a Tool committed, the Tool wins. #12's Tools will
      write `confirmed` mid-Call, and this handler runs afterwards. Without the
      guard it would quietly undo the booking the customer just agreed to.
    */
    await db
      .update(schema.appointments)
      .set({ status: "confirmed" })
      .where(eq(schema.appointments.id, appointmentId));

    await recordCallEnded(businessId, callId);

    expect(await appointmentStatus()).toBe("confirmed");
  });
});

describe("recordCallFailed", () => {
  it("records Retell's own reason, so #13's webhook agrees with it", async () => {
    await recordCallFailed(businessId, callId, "error_user_not_joined");

    const call = await callRow();
    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("error_user_not_joined");
  });

  it("returns the Appointment to pending", async () => {
    await recordCallFailed(businessId, callId, "error_retell");

    expect(await appointmentStatus()).toBe("pending");
  });

  it("never overwrites an outcome a Tool committed", async () => {
    await db
      .update(schema.appointments)
      .set({ status: "rescheduled" })
      .where(eq(schema.appointments.id, appointmentId));

    await recordCallFailed(businessId, callId, "error_retell");

    expect(await appointmentStatus()).toBe("rescheduled");
  });
});

/*
  The guard that matters. `callId` arrives from the browser, so every one of
  these is reachable with someone else's id.
*/
describe("a Call belonging to another Business", () => {
  it("cannot be started", async () => {
    await recordCallStarted(otherBusinessId, callId);

    expect((await callRow()).status).toBe("queued");
  });

  it("cannot be ended", async () => {
    await recordCallEnded(otherBusinessId, callId);

    expect((await callRow()).status).toBe("queued");
    expect(await appointmentStatus()).toBe("calling");
  });

  it("cannot be failed", async () => {
    await recordCallFailed(otherBusinessId, callId, "error_retell");

    expect((await callRow()).status).toBe("queued");
  });
});

describe("a duplicated event", () => {
  it("writes the same row to the same state", async () => {
    // The SDK is free to emit an event twice; nothing here should mind.
    await recordCallStarted(businessId, callId);
    await recordCallStarted(businessId, callId);
    await recordCallEnded(businessId, callId);
    await recordCallEnded(businessId, callId);

    expect((await callRow()).status).toBe("completed");
    expect(await appointmentStatus()).toBe("pending");
  });
});

describe("a negotiation the 120s cap cut off", () => {
  it("asks a human to call back when nothing was committed", async () => {
    await startedSecondsAgo(118);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("does not record it as a booking", async () => {
    // Acceptance criterion 5. The Appointment goes back to where it genuinely
    // is — nothing decided it — rather than to a status nobody agreed to.
    await startedSecondsAgo(118);

    await recordCallEnded(businessId, callId);

    expect(await appointmentStatus()).toBe("pending");
  });

  it("says nothing about a Call that booked", async () => {
    await startedSecondsAgo(118);
    await recordTool("book_slot", true);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBeNull();
  });

  it("still flags a Call that only ever asked what was open", async () => {
    // Three rounds of Offers and no answer is exactly the Call SPEC.md §5 wants
    // in front of a human. A check commits nothing.
    await startedSecondsAgo(118);
    await recordTool("check_availability", true);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("still flags a Call whose booking failed", async () => {
    // A failed book_slot commits nothing. In the real path book_slot has
    // already written `book_failed`, which the next test covers — this one
    // proves the query does not count a failed row as an outcome.
    await startedSecondsAgo(118);
    await recordTool("book_slot", false);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("never overwrites the more specific book_failed", async () => {
    // A Call that tried and failed to book is not the same as one that never
    // got there, and #15 renders the difference.
    await startedSecondsAgo(118);
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("book_failed");
  });

  it("flags the 65-second Call that offered times and booked none", async () => {
    /*
      The live Call of 2026-08-21, reproduced. Three rounds of Offers, the
      customer accepted a time, Maya announced the booking without ever invoking
      book_slot, and the Call ended at 65 seconds — under the cap, so the
      duration rule alone said nothing. The customer hung up believing she was
      booked and nobody was told.
    */
    await startedSecondsAgo(65);
    await db.insert(schema.toolInvocations).values({
      callId,
      toolName: "check_availability",
      arguments: {},
      result: {
        ok: true,
        slots: [
          { slot_start: "2026-08-24T07:00:00.000Z", time: "Monday 24 August at 12:30 PM" },
        ],
      },
      succeeded: true,
      latencyMs: 2,
    });

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
    expect(await appointmentStatus()).toBe("pending");
  });

  it("says nothing when those offers ended in a booking", async () => {
    await startedSecondsAgo(65);
    await db.insert(schema.toolInvocations).values({
      callId,
      toolName: "check_availability",
      arguments: {},
      result: {
        ok: true,
        slots: [
          { slot_start: "2026-08-24T07:00:00.000Z", time: "Monday 24 August at 12:30 PM" },
        ],
      },
      succeeded: true,
      latencyMs: 2,
    });
    await recordTool("book_slot", true);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBeNull();
  });

  it("leaves a short Call alone", async () => {
    // A wrong number is over in seconds. #14's extraction covers those.
    await startedSecondsAgo(15);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBeNull();
  });

  it("leaves another Business's Call alone", async () => {
    await startedSecondsAgo(118);

    await recordCallEnded(otherBusinessId, callId);

    // Nothing was written at all — not the Call, and not the Appointment.
    expect(await needsAttention()).toBeNull();
    expect((await callRow()).status).toBe("in_progress");
  });
});

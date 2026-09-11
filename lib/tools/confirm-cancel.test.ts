import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findAvailableSlots } from "@/lib/availability/find";
import { db, schema } from "@/lib/db";
import { cancelAppointment } from "@/lib/tools/cancel-appointment";
import { confirmAppointment } from "@/lib/tools/confirm-appointment";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_tools_confirm_cancel";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");
const END_OF_MONDAY = new Date("2026-08-17T11:30:00.000Z");

let seed: ToolTestSeed;
let context: ToolContext;

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

/** The Slots Availability believes are open on the Appointment's own morning. */
async function openSlotStarts(): Promise<string[]> {
  const slots = await findAvailableSlots({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    from: NOW,
    to: END_OF_MONDAY,
    now: NOW,
  });
  return slots.map((s) => s.startsAt.toISOString());
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("confirmAppointment", () => {
  it("confirms the existing time", async () => {
    const result = await runTool({
      name: "confirm_appointment",
      args: {},
      context,
      handler: confirmAppointment,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, say: COMMITTED.confirmed });

    const confirmed = await appointment();
    expect(confirmed!.status).toBe("confirmed");
    // Confirming does not move anything.
    expect(confirmed!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("succeeds a second time", async () => {
    // Maya occasionally calls a Tool twice. A second confirmation is not an
    // error worth making her explain to the customer.
    const twice = async () =>
      runTool({
        name: "confirm_appointment",
        args: {},
        context,
        handler: confirmAppointment,
        now: NOW,
      });

    await twice();
    expect(await twice()).toEqual({ ok: true, say: COMMITTED.confirmed });
    expect((await appointment())!.status).toBe("confirmed");
  });

  it("keeps holding the Slot", async () => {
    // `confirmed` is a Slot-holding status, so nothing else may take that time.
    await runTool({
      name: "confirm_appointment",
      args: {},
      context,
      handler: confirmAppointment,
      now: NOW,
    });

    expect(await openSlotStarts()).not.toContain(APPOINTMENT_STARTS_AT.toISOString());
  });
});

describe("cancelAppointment", () => {
  const cancel = () =>
    runTool({
      name: "cancel_appointment",
      args: {},
      context,
      handler: cancelAppointment,
      now: NOW,
    });

  it("cancels the Appointment", async () => {
    expect(await cancel()).toEqual({ ok: true, say: COMMITTED.cancelled });
    expect((await appointment())!.status).toBe("cancelled");
  });

  it("frees the Slot", async () => {
    expect(await openSlotStarts()).not.toContain(APPOINTMENT_STARTS_AT.toISOString());

    await cancel();

    // No separate "release the Slot" step: `cancelled` is one of
    // SLOT_FREEING_STATUSES, so the constraint and Availability both stop
    // counting it at once, and cannot disagree.
    expect(await openSlotStarts()).toContain(APPOINTMENT_STARTS_AT.toISOString());
  });

  it("lets someone else take the freed Slot", async () => {
    await cancel();

    // The other half of "frees the Slot": appointments_no_overlap has to agree,
    // or Maya would offer a time the database then refuses (SPEC.md §3 rule 7).
    await expect(
      db.insert(schema.appointments).values({
        businessId: seed.businessId,
        serviceId: seed.serviceId,
        name: "Next Person",
        phoneE164: "+919876500003",
        startsAt: APPOINTMENT_STARTS_AT,
        endsAt: new Date(APPOINTMENT_STARTS_AT.getTime() + 60 * 60_000),
      }),
    ).resolves.toBeDefined();
  });

  it("is recorded like every other Tool", async () => {
    await cancel();

    const [row] = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    expect(row.toolName).toBe("cancel_appointment");
    expect(row.succeeded).toBe(true);
    expect(row.arguments).toEqual({});
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

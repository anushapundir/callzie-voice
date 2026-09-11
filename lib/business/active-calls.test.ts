import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import {
  countActiveCalls,
  listLiveCalls,
  liveCallAppointmentIds,
  LIVE_CALL_STALENESS_MS,
} from "@/lib/business/active-calls";
import { db, schema } from "@/lib/db";
import type { CallStatus } from "@/lib/db/schema";

const CLERK_ID = "user_test_active_calls";
const OTHER_CLERK_ID = "user_test_active_calls_other";
const NOW = new Date("2026-09-01T10:00:00.000Z");

let businessId: string;
let appointmentId: string;
let otherBusinessId: string;
let otherAppointmentId: string;

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
      name: "Active Calls Clinic",
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
    })
    .returning();

  return { businessId: business.id, appointmentId: appointment.id };
}

async function addCall(
  targetAppointmentId: string,
  status: CallStatus,
  startedAt: Date | null,
) {
  /*
    `calls.business_id` became NOT NULL in issue #43. Read off the Appointment
    rather than added as a fourth argument, so the twelve call sites below stay
    about what they are testing — which Calls count as live — instead of
    repeating a tenant id that is already implied by the Appointment.
  */
  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, targetAppointmentId),
    columns: { businessId: true },
  });
  if (!appointment) throw new Error(`No Appointment ${targetAppointmentId}`);

  await db.insert(schema.calls).values({
    businessId: appointment.businessId,
    appointmentId: targetAppointmentId,
    callType: "web",
    status,
    startedAt,
  });
}

beforeEach(async () => {
  await cleanup();
  ({ businessId, appointmentId } = await seed(CLERK_ID));
  ({ businessId: otherBusinessId, appointmentId: otherAppointmentId } =
    await seed(OTHER_CLERK_ID));
});

afterEach(cleanup);

describe("countActiveCalls", () => {
  it("counts a Call that started a moment ago", async () => {
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(1);
  });

  it("ignores a Call that is older than a Call can be", async () => {
    /*
      The tab closed mid-Call, so nothing ever reported the end. A Call cannot
      outlive max_call_duration_ms, so this one is not live whatever the column
      says — otherwise the dot pulses for the life of the account.
    */
    await addCall(
      appointmentId,
      "in_progress",
      new Date(NOW.getTime() - LIVE_CALL_STALENESS_MS - 1),
    );

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("still counts a Call just inside the window", async () => {
    // The boundary in the other direction, so the window cannot silently
    // narrow to nothing.
    await addCall(
      appointmentId,
      "in_progress",
      new Date(NOW.getTime() - LIVE_CALL_STALENESS_MS + 1_000),
    );

    expect(await countActiveCalls(businessId, NOW)).toBe(1);
  });

  it("ignores a queued Call, which has not connected", async () => {
    await addCall(appointmentId, "queued", null);

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("ignores a completed Call", async () => {
    await addCall(appointmentId, "completed", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("ignores a failed Call", async () => {
    await addCall(appointmentId, "failed", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("never counts another Business's Call", async () => {
    await addCall(
      otherAppointmentId,
      "in_progress",
      new Date(NOW.getTime() - 10_000),
    );

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
    expect(await countActiveCalls(otherBusinessId, NOW)).toBe(1);
  });
});

describe("liveCallAppointmentIds", () => {
  it("names the Appointment whose row should shimmer", async () => {
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 10_000));

    expect(await liveCallAppointmentIds(businessId, NOW)).toEqual(
      new Set([appointmentId]),
    );
  });

  it("is empty when nothing is live", async () => {
    expect(await liveCallAppointmentIds(businessId, NOW)).toEqual(new Set());
  });

  it("names an Appointment once even if it somehow has two live Calls", async () => {
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 10_000));
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 5_000));

    expect(await liveCallAppointmentIds(businessId, NOW)).toEqual(
      new Set([appointmentId]),
    );
  });
});

describe("listLiveCalls", () => {
  it("returns who Maya is talking to, with when the Call started", async () => {
    const startedAt = new Date(NOW.getTime() - 10_000);
    await addCall(appointmentId, "in_progress", startedAt);

    expect(await listLiveCalls(businessId, NOW)).toEqual([
      { appointmentId, name: "Priya Nair", startedAt },
    ]);
  });

  it("never shows another Business's Call", async () => {
    await addCall(
      otherAppointmentId,
      "in_progress",
      new Date(NOW.getTime() - 10_000),
    );

    expect(await listLiveCalls(businessId, NOW)).toEqual([]);
  });
});

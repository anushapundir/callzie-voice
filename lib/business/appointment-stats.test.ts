import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { appointmentStats } from "@/lib/business/appointment-stats";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_appointment_stats";

const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
const ELEVEN_AM = new Date("2026-08-17T05:30:00.000Z");
const NOON = new Date("2026-08-17T06:30:00.000Z");

let businessId: string;
let serviceId: string;
let firstAppointmentId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
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
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "stats@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Stats Test Salon",
      businessType: "salon",
      timezone: "Asia/Kolkata",
    })
    .returning();
  businessId = business.id;

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;

  const [first] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+919820012345",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
      status: "confirmed",
    })
    .returning();
  firstAppointmentId = first.id;

  await db.insert(schema.appointments).values({
    businessId,
    serviceId,
    name: "Daniel Okafor",
    phoneE164: "+12025550143",
    startsAt: ELEVEN_AM,
    endsAt: NOON,
    status: "pending",
  });
});

afterEach(cleanup);

describe("appointmentStats", () => {
  it("counts every Appointment, not only the ones still ahead", async () => {
    const stats = await appointmentStats(businessId);

    expect(stats.total).toBe(2);
    expect(stats.confirmed).toBe(1);
  });

  it("reads Answer rate as null when no Call has been placed", async () => {
    // A fresh account. Rendering 0% would claim a dialler had tried and failed.
    expect((await appointmentStats(businessId)).answerRate).toBeNull();
  });

  it("counts Needs attention from the reason, not the status", async () => {
    // SPEC.md §5: the reason is orthogonal to status. This row is confirmed
    // AND collided, and must be counted.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "collision" })
      .where(eq(schema.appointments.id, firstAppointmentId));

    const stats = await appointmentStats(businessId);

    expect(stats.needsAttention).toBe(1);
    expect(stats.confirmed).toBe(1);
  });

  it("divides completed Calls by Calls that left the queue", async () => {
    await db.insert(schema.calls).values([
      {
        businessId,
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 1,
        status: "no_answer",
      },
      {
        businessId,
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 2,
        status: "completed",
      },
      // Still queued — not yet an attempt at anything, so not in the divisor.
      {
        businessId,
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 3,
        status: "queued",
      },
    ]);

    expect((await appointmentStats(businessId)).answerRate).toBe(0.5);
  });

  it("counts nothing for a Business with no Appointments", async () => {
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));

    const stats = await appointmentStats(businessId);

    expect(stats).toEqual({
      total: 0,
      confirmed: 0,
      needsAttention: 0,
      callsPlaced: 0,
      answerRate: null,
    });
  });
});

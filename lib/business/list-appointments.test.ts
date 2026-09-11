import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { listAppointments } from "@/lib/business/list-appointments";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_list_appointments";

const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
const ELEVEN_AM = new Date("2026-08-17T05:30:00.000Z");
const NOON = new Date("2026-08-17T06:30:00.000Z");

let businessId: string;
let serviceId: string;
let appointmentId: string;

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
  const user = await provisionUser(CLERK_ID, "list@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "List Test Salon",
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

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+919820012345",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
    })
    .returning();
  appointmentId = appointment.id;
});

afterEach(cleanup);

describe("listAppointments", () => {
  it("joins the Service name and reports no Calls yet", async () => {
    const [row] = await listAppointments(businessId);

    expect(row.name).toBe("Priya Sharma");
    expect(row.serviceName).toBe("Haircut");
    expect(row.attempts).toBe(0);
    expect(row.lastCallId).toBeNull();
    expect(row.lastCallAt).toBeNull();
  });

  it("counts attempts and points at the latest Call", async () => {
    const [first] = await db
      .insert(schema.calls)
      .values({
        businessId,
        appointmentId,
        callType: "web",
        attempt: 1,
        status: "no_answer",
      })
      .returning();
    const [second] = await db
      .insert(schema.calls)
      .values({
        businessId,
        appointmentId,
        callType: "web",
        attempt: 2,
        status: "completed",
      })
      .returning();

    const [row] = await listAppointments(businessId);

    expect(row.attempts).toBe(2);
    expect(row.lastCallId).toBe(second.id);
    expect(row.lastCallId).not.toBe(first.id);
    // The timestamp travels with the Call the id points at, so the table's
    // "Last call" column and #16's eventual link cannot disagree about which
    // Call they mean.
    expect(row.lastCallAt).toEqual(second.createdAt);
  });

  it("returns Appointments earliest first", async () => {
    await db.insert(schema.appointments).values({
      businessId,
      serviceId,
      name: "Daniel Okafor",
      phoneE164: "+12025550143",
      startsAt: ELEVEN_AM,
      endsAt: NOON,
    });

    const rows = await listAppointments(businessId);

    expect(rows.map((r) => r.name)).toEqual(["Priya Sharma", "Daniel Okafor"]);
  });

  it("carries the Needs Attention reason, so the row can stop offering a Call", async () => {
    /*
      The table disables "Call now" from this. It is a fact about the row
      already on screen, unlike the Quota, which is an account-wide number
      another tab can spend — see the comment in
      components/calls/call-now-button.tsx.
    */
    const [healthy] = await db
      .insert(schema.appointments)
      .values({
        businessId,
        serviceId,
        name: "Daniel Okafor",
        phoneE164: "+12025550143",
        startsAt: ELEVEN_AM,
        endsAt: NOON,
      })
      .returning();

    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    const rows = await listAppointments(businessId);

    expect(rows.find((row) => row.id === appointmentId)!.needsAttentionReason)
      .toBe("book_failed");
    expect(rows.find((row) => row.id === healthy.id)!.needsAttentionReason)
      .toBeNull();
  });
});

/*
  The shimmer's data (SPEC.md §11.2). The row itself decides nothing — it is
  marked here so `appointments-table.tsx` stays a Server Component.
*/
describe("the row being called", () => {
  it("marks an Appointment whose Call is live", async () => {
    await db.insert(schema.calls).values({
      businessId,
      appointmentId,
      callType: "web",
      status: "in_progress",
      startedAt: new Date(),
    });

    const [row] = await listAppointments(businessId);

    expect(row.isCalling).toBe(true);
  });

  it("leaves a row with no Call alone", async () => {
    const [row] = await listAppointments(businessId);

    expect(row.isCalling).toBe(false);
  });

  it("does not mark a row whose Call has already ended", async () => {
    await db.insert(schema.calls).values({
      businessId,
      appointmentId,
      callType: "web",
      status: "completed",
      startedAt: new Date(),
      endedAt: new Date(),
    });

    const [row] = await listAppointments(businessId);

    expect(row.isCalling).toBe(false);
  });

  it("does not mark a row whose browser went away mid-Call", async () => {
    // Still `in_progress` because nothing reported the end, but far older than
    // a Call can be. The shimmer must stop even though the row is wrong.
    await db.insert(schema.calls).values({
      businessId,
      appointmentId,
      callType: "web",
      status: "in_progress",
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    const [row] = await listAppointments(businessId);

    expect(row.isCalling).toBe(false);
  });
});

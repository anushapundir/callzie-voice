import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppointment } from "@/lib/appointments/create";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_appointments_create";
const TIMEZONE = "Asia/Kolkata";

const NOW = new Date("2026-08-16T00:00:00.000Z");
// 09:00 Asia/Kolkata (+05:30) on Monday 17 August.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
// 03:00 local on an open day.
const THREE_AM = new Date("2026-08-16T21:30:00.000Z");
// The Monday a week before NOW.
const LAST_MONDAY = new Date("2026-08-10T03:30:00.000Z");

let businessId: string;
let serviceId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "create@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Create Test Salon",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning();
  businessId = business.id;

  await db.insert(schema.businessHours).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      businessId,
      weekday,
      opensAt: "09:00",
      closesAt: "17:00",
    })),
  );

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;
});

afterEach(cleanup);

function create(startsAt: Date, name = "Priya Sharma") {
  return createAppointment({
    businessId,
    serviceId,
    name,
    phoneE164: "+919820012345",
    startsAt,
    now: NOW,
  });
}

describe("createAppointment", () => {
  it("creates into an open Slot, with ends_at derived from the duration", async () => {
    const result = await create(NINE_AM);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.startsAt.toISOString()).toBe(
      "2026-08-17T03:30:00.000Z",
    );
    // 60-minute Service, so an hour later. Never accepted from the caller.
    expect(result.appointment.endsAt.toISOString()).toBe(
      "2026-08-17T04:30:00.000Z",
    );
    expect(result.appointment.status).toBe("pending");
  });

  it("refuses a time when the Business is closed", async () => {
    expect(await create(THREE_AM)).toEqual({ ok: false, reason: "not_offered" });
  });

  it("refuses a time that has already passed", async () => {
    expect(await create(LAST_MONDAY)).toEqual({
      ok: false,
      reason: "in_the_past",
    });
  });

  it("refuses a Slot another Appointment already holds", async () => {
    expect((await create(NINE_AM)).ok).toBe(true);

    expect(await create(NINE_AM, "Daniel Okafor")).toEqual({
      ok: false,
      reason: "slot_taken",
    });
  });

  it("lets exactly one of two concurrent creates win the same Slot", async () => {
    /*
      The test that protects the design. It is not a duplicate of
      lib/availability/book.test.ts: that one proves the constraint holds at the
      database level, this one proves the layer above does not route around it.

      A pre-check added to createAppointment would let both calls read "free"
      before either wrote, and both would be reported as created — so this fails
      the moment someone reintroduces one.
    */
    const results = await Promise.all([
      create(NINE_AM, "Priya Sharma"),
      create(NINE_AM, "Daniel Okafor"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "slot_taken")).toHaveLength(
      1,
    );

    const rows = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));
    expect(rows).toHaveLength(1);
  });
});

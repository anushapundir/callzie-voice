import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slotIsOffered } from "@/lib/availability/offered";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

/*
  Integration against the local Postgres from vitest.globalSetup.ts.

  The Business is built by hand rather than through createOnboardedBusiness,
  because a Template seeds Appointments of its own and this file needs to
  control exactly which times exist.
*/

const CLERK_ID = "user_test_availability_offered";
const TIMEZONE = "Asia/Kolkata";

// A Monday. Open 09:00-17:00 on weekdays, 60-minute Service.
const NOW = new Date("2026-08-16T00:00:00.000Z");
// 09:00 Asia/Kolkata (+05:30) on that Monday.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
// 03:00 local — a real instant on an open day, long before opening.
const THREE_AM = new Date("2026-08-16T21:30:00.000Z");
// 09:07 local — inside opening hours, but not on the 60-minute grid.
const SEVEN_PAST_NINE = new Date("2026-08-17T03:37:00.000Z");
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
    // FK order: every FK in this schema is ON DELETE NO ACTION, so children go
    // first or the Business delete fails and poisons the next run.
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
  const user = await provisionUser(CLERK_ID, "offered@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Offered Test Salon",
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

function offered(startsAt: Date) {
  return slotIsOffered({ businessId, serviceId, startsAt, now: NOW });
}

describe("slotIsOffered", () => {
  it("offers a Slot on the grid inside Business Hours", async () => {
    expect(await offered(NINE_AM)).toBe("offered");
  });

  it("refuses a time when the Business is closed", async () => {
    expect(await offered(THREE_AM)).toBe("not_offered");
  });

  it("refuses a time inside hours but off the Slot grid", async () => {
    expect(await offered(SEVEN_PAST_NINE)).toBe("not_offered");
  });

  it("refuses a time that has already passed", async () => {
    expect(await offered(LAST_MONDAY)).toBe("in_the_past");
  });

  it("still offers a Slot that another Appointment already holds", async () => {
    // The point of this module: overlap is the constraint's question, not this
    // function's. If this ever returns "not_offered", someone has added an
    // Appointment lookup here and `lib/appointments/create.ts` now has a
    // check-then-write race in it.
    await db.insert(schema.appointments).values({
      businessId,
      serviceId,
      name: "Existing Customer",
      phoneE164: "+12025550101",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
    });

    expect(await offered(NINE_AM)).toBe("offered");
  });
});

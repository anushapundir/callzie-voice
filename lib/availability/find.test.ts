import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findAvailableSlots } from "@/lib/availability/find";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { APPOINTMENT_STATUSES, SLOT_FREEING_STATUSES } from "@/lib/db/schema";

/*
  Integration against the local Postgres from vitest.globalSetup.ts.

  The Business is built by hand rather than through createOnboardedBusiness,
  because a Template seeds Appointments of its own and this file needs to control
  exactly which times are taken.
*/

const CLERK_ID = "user_test_availability_find";
const TIMEZONE = "Asia/Kolkata";

// A Monday. Business open 09:00-17:00 every weekday, 60-minute Service.
const MONDAY = new Date("2026-08-17T00:00:00.000Z");
const NOW = new Date("2026-08-16T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-18T00:00:00.000Z");

// 09:00 Asia/Kolkata (+05:30) on that Monday.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");

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
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "availability@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Availability Test Salon",
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

function find() {
  return findAvailableSlots({
    businessId,
    serviceId,
    from: MONDAY,
    to: WINDOW_END,
    now: NOW,
  });
}

async function bookDirectly(status: (typeof APPOINTMENT_STATUSES)[number]) {
  await db.insert(schema.appointments).values({
    businessId,
    serviceId,
    name: "Existing Customer",
    phoneE164: "+12025550101",
    startsAt: NINE_AM,
    endsAt: TEN_AM,
    status,
  });
}

describe("findAvailableSlots", () => {
  it("returns Slots inside Business Hours, in the Business's timezone", async () => {
    const slots = await find();

    // 09:00 Asia/Kolkata is 03:30Z — the +05:30 offset, not rounded to an hour.
    expect(slots[0].startsAt.toISOString()).toBe("2026-08-17T03:30:00.000Z");
    // 09:00-17:00 with a 60-minute Service is eight Slots; the last ends at
    // 17:00 local (11:30Z) and none runs past closing.
    expect(slots).toHaveLength(8);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });

  it("returns nothing when the Business has no hours for the day", async () => {
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId));

    expect(await find()).toEqual([]);
  });

  it("rejects a Service belonging to another Business", async () => {
    await expect(
      findAvailableSlots({
        businessId,
        serviceId: "00000000-0000-0000-0000-000000000000",
        from: MONDAY,
        to: WINDOW_END,
        now: NOW,
      }),
    ).rejects.toThrow(/No Service/);
  });
});

/*
  The heart of acceptance criterion 2, driven off the status list itself rather
  than a hand-written pair. Adding a status to the schema without deciding
  whether it holds a Slot now fails here.
*/
describe.each(APPOINTMENT_STATUSES)("an Appointment with status %s", (status) => {
  const freesSlot = (SLOT_FREEING_STATUSES as readonly string[]).includes(status);

  it(freesSlot ? "frees its Slot" : "holds its Slot", async () => {
    await bookDirectly(status);
    const slots = await find();
    const nineAm = slots.some(
      (s) => s.startsAt.getTime() === NINE_AM.getTime(),
    );

    expect(nineAm).toBe(freesSlot);
  });
});

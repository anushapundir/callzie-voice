import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { loadScheduleDay } from "@/lib/schedule/load-day";

const CLERK_ID = "user_test_load_schedule_day";
const OTHER_CLERK_ID = "user_test_load_schedule_day_other";
const KOLKATA = "Asia/Kolkata";

/** 19 August 2026, a Wednesday — the one weekday this Business opens. */
const WEDNESDAY = { year: 2026, month: 8, day: 19 };
/** 23 August 2026, a Sunday. Closed, but with a booking on it. */
const SUNDAY = { year: 2026, month: 8, day: 23 };
/** 30 August 2026, also a Sunday. Closed, and genuinely empty. */
const EMPTY_SUNDAY = { year: 2026, month: 8, day: 30 };

let businessId: string;
let otherBusinessId: string;
let serviceId: string;

async function makeBusiness(clerkId: string): Promise<string> {
  const user = await provisionUser(clerkId, `${clerkId}@test.local`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Test Business",
      businessType: "salon",
      timezone: KOLKATA,
    })
    .returning({ id: schema.businesses.id });
  return business!.id;
}

async function cleanup(clerkId: string) {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
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
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
}

beforeAll(async () => {
  await cleanup(CLERK_ID);
  await cleanup(OTHER_CLERK_ID);

  businessId = await makeBusiness(CLERK_ID);
  otherBusinessId = await makeBusiness(OTHER_CLERK_ID);

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Cleaning", durationMinutes: 45 })
    .returning({ id: schema.services.id });
  serviceId = service!.id;

  // Open 09:00-17:00 on Wednesday only. Every other weekday is closed.
  await db
    .insert(schema.businessHours)
    .values({ businessId, weekday: 3, opensAt: "09:00", closesAt: "17:00" });

  await db.insert(schema.appointments).values([
    // Wednesday 09:00-09:45 Kolkata, confirmed.
    {
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+12025550100",
      startsAt: new Date("2026-08-19T03:30:00.000Z"),
      endsAt: new Date("2026-08-19T04:15:00.000Z"),
      status: "confirmed",
    },
    // Wednesday 11:00-11:45, cancelled — frees its Slot, must not appear.
    {
      businessId,
      serviceId,
      name: "Cancelled Person",
      phoneE164: "+12025550101",
      startsAt: new Date("2026-08-19T05:30:00.000Z"),
      endsAt: new Date("2026-08-19T06:15:00.000Z"),
      status: "cancelled",
    },
    // Wednesday 13:00-13:45, declined — also frees its Slot.
    {
      businessId,
      serviceId,
      name: "Declined Person",
      phoneE164: "+12025550102",
      startsAt: new Date("2026-08-19T07:30:00.000Z"),
      endsAt: new Date("2026-08-19T08:15:00.000Z"),
      status: "declined",
    },
    // Wednesday 15:00-15:45, flagged as a Collision.
    {
      businessId,
      serviceId,
      name: "Collided Person",
      phoneE164: "+12025550103",
      startsAt: new Date("2026-08-19T09:30:00.000Z"),
      endsAt: new Date("2026-08-19T10:15:00.000Z"),
      status: "confirmed",
      needsAttentionReason: "collision",
    },
    // Thursday 09:00-09:45 — the next day, must not appear on Wednesday.
    {
      businessId,
      serviceId,
      name: "Tomorrow Person",
      phoneE164: "+12025550104",
      startsAt: new Date("2026-08-20T03:30:00.000Z"),
      endsAt: new Date("2026-08-20T04:15:00.000Z"),
      status: "pending",
    },
    // Sunday 14:00-14:45 — a closed day with a booking on it.
    {
      businessId,
      serviceId,
      name: "Sunday Person",
      phoneE164: "+12025550105",
      startsAt: new Date("2026-08-23T08:30:00.000Z"),
      endsAt: new Date("2026-08-23T09:15:00.000Z"),
      status: "pending",
    },
  ]);
});

afterAll(async () => {
  await cleanup(CLERK_ID);
  await cleanup(OTHER_CLERK_ID);
});

describe("loadScheduleDay", () => {
  it("returns that day's Slot-holding Appointments and nothing else", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    expect(layout?.blocks.map((block) => block.appointment.name)).toEqual([
      "Priya Sharma",
      "Collided Person",
    ]);
  });

  it("reads that weekday's Business Hours", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    // 09:00 and 17:00 Kolkata. `pg` hands back "09:00:00"; if toWallTime were
    // skipped, parseWallTime would throw rather than quietly misread it.
    expect(layout?.hours?.opensAt.toISOString()).toBe(
      "2026-08-19T03:30:00.000Z",
    );
    expect(layout?.hours?.closesAt.toISOString()).toBe(
      "2026-08-19T11:30:00.000Z",
    );
  });

  it("carries the Service name and the attention reason", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    const collided = layout!.blocks[1]!;
    expect(collided.appointment.serviceName).toBe("Cleaning");
    expect(collided.collision).toBe(true);
  });

  it("renders a closed day that still has a booking on it", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: SUNDAY,
    });

    expect(layout?.hours).toBeNull();
    expect(layout?.blocks.map((block) => block.appointment.name)).toEqual([
      "Sunday Person",
    ]);
  });

  it("returns null for a closed day with nothing on it", async () => {
    expect(
      await loadScheduleDay({
        businessId,
        timezone: KOLKATA,
        date: EMPTY_SUNDAY,
      }),
    ).toBeNull();
  });

  it("never returns another Business's Appointments", async () => {
    expect(
      await loadScheduleDay({
        businessId: otherBusinessId,
        timezone: KOLKATA,
        date: WEDNESDAY,
      }),
    ).toBeNull();
  });
});

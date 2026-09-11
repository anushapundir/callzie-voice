import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { createOnboardedBusiness } from "@/lib/onboarding/create-business";
import { saveBusinessHours } from "@/lib/settings/save-hours";
import { toWallTime, type WeekdayHours } from "@/lib/settings/weekdays";

/*
  Integration against the real Postgres named by DATABASE_URL, per
  vitest.config.mts. The whole point of `saveBusinessHours` is which SQL it
  emits — an upsert onto `business_hours_business_weekday_uniq` rather than a
  delete-then-insert — and a mocked db would assert the mock's opinion of that
  index instead of the index. The `time` round trip (pg returns `HH:MM:SS`) is
  real behaviour too, and only a real driver shows it.
*/

// Namespaced so a stray row is obviously a test artefact and cleanup can never
// touch a real account.
const CLERK_ID = "user_test_save_hours";
const TIMEZONE = "Asia/Kolkata";
const NOW = new Date("2026-08-13T09:00:00.000Z");

let businessId: string;

/**
 * Deletes in foreign-key order. Every FK in this schema is ON DELETE NO ACTION,
 * so removing the Business first fails, leaves fixtures behind, and poisons the
 * next run against the same database.
 */
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
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }

  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

/** The stored hours in the shape they were submitted, seconds stripped. */
async function storedHours(): Promise<WeekdayHours[]> {
  const rows = await db
    .select()
    .from(schema.businessHours)
    .where(eq(schema.businessHours.businessId, businessId))
    .orderBy(asc(schema.businessHours.weekday));

  return rows.map((row) => ({
    weekday: row.weekday,
    opensAt: toWallTime(row.opensAt),
    closesAt: toWallTime(row.closesAt),
  }));
}

/** The `id` of every stored row, keyed by weekday — how row identity is tracked. */
async function rowIdsByWeekday(): Promise<Map<number, string>> {
  const rows = await db
    .select()
    .from(schema.businessHours)
    .where(eq(schema.businessHours.businessId, businessId));
  return new Map(rows.map((row) => [row.weekday, row.id]));
}

const WEEKDAYS_9_TO_5: WeekdayHours[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: "09:00",
  closesAt: "17:00",
}));

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "settings@example.com");
  // Onboarding, not a bare insert: Settings edits Business Hours that already
  // exist (#4 seeds them), so every case here starts from a seeded Business.
  const { business } = await createOnboardedBusiness(
    {
      userId: user.id,
      name: "Test Business",
      businessType: "salon",
      timezone: TIMEZONE,
    },
    NOW,
  );
  businessId = business.id;
});

afterEach(cleanup);

describe("saveBusinessHours", () => {
  it("replaces the seeded hours with the submitted set", async () => {
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);

    expect(await storedHours()).toEqual(WEEKDAYS_9_TO_5);
  });

  it("stores wall-clock times that survive the pg `time` round trip", async () => {
    await saveBusinessHours(businessId, [
      { weekday: 6, opensAt: "10:30", closesAt: "18:45" },
    ]);

    const [row] = await db
      .select()
      .from(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId));

    // pg renders `time` with seconds; `toWallTime` is what puts it back into the
    // `HH:mm` an `<input type="time">` will accept.
    expect(row.opensAt).toBe("10:30:00");
    expect(toWallTime(row.opensAt)).toBe("10:30");
    expect(toWallTime(row.closesAt)).toBe("18:45");
  });

  it("updates a day in place rather than recreating its row", async () => {
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);
    const before = await rowIdsByWeekday();

    await saveBusinessHours(
      businessId,
      WEEKDAYS_9_TO_5.map((day) =>
        day.weekday === 3 ? { ...day, closesAt: "20:00" } : day,
      ),
    );
    const after = await rowIdsByWeekday();

    // Same primary key: the second save took the `onConflictDoUpdate` branch on
    // `business_hours_business_weekday_uniq`. A delete-then-insert would hand
    // back five fresh uuids, and would have passed through a moment with no
    // hours at all.
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect((await storedHours()).find((d) => d.weekday === 3)?.closesAt).toBe("20:00");
  });

  it("gives each weekday its own times in a single multi-row upsert", async () => {
    // Regression guard for the `excluded.opens_at` clause: binding literal
    // values in the `set` would stamp one day's times across every conflicting
    // row, which only shows up when the days differ from each other.
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);

    const varied: WeekdayHours[] = [
      { weekday: 1, opensAt: "08:00", closesAt: "12:00" },
      { weekday: 2, opensAt: "09:15", closesAt: "13:30" },
      { weekday: 3, opensAt: "10:00", closesAt: "22:00" },
      { weekday: 4, opensAt: "11:45", closesAt: "19:05" },
      { weekday: 5, opensAt: "07:30", closesAt: "16:00" },
    ];
    await saveBusinessHours(businessId, varied);

    expect(await storedHours()).toEqual(varied);
  });

  it("deletes the weekdays left out of the submission", async () => {
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);
    await saveBusinessHours(businessId, [WEEKDAYS_9_TO_5[0]]);

    // Absence of a row is how "closed" is represented — there is no `closed`
    // column and the schema does not need one.
    expect(await storedHours()).toEqual([WEEKDAYS_9_TO_5[0]]);
  });

  it("adds a weekday that had no row before", async () => {
    await saveBusinessHours(businessId, [
      { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
    ]);
    await saveBusinessHours(businessId, [
      { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
      { weekday: 0, opensAt: "11:00", closesAt: "15:00" },
    ]);

    expect((await storedHours()).map((d) => d.weekday)).toEqual([0, 1]);
  });

  it("is idempotent — saving the same set twice changes nothing", async () => {
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);
    const before = await rowIdsByWeekday();

    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);

    expect([...(await rowIdsByWeekday()).entries()].sort()).toEqual(
      [...before.entries()].sort(),
    );
    expect(await storedHours()).toEqual(WEEKDAYS_9_TO_5);
  });

  it("touches only this Business's rows", async () => {
    // A second Business, cleaned up inline: `cleanup` is keyed to one clerk id.
    const otherUser = await provisionUser(
      `${CLERK_ID}_other`,
      "settings-other@example.com",
    );
    const { business: other } = await createOnboardedBusiness(
      {
        userId: otherUser.id,
        name: "Other Business",
        businessType: "clinic",
        timezone: TIMEZONE,
      },
      NOW,
    );

    try {
      const otherBefore = await db
        .select()
        .from(schema.businessHours)
        .where(eq(schema.businessHours.businessId, other.id));

      // The prune is `NOT IN (…)` scoped by business_id. Without that `and`, this
      // save would empty every other account's Business Hours.
      await saveBusinessHours(businessId, [
        { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
      ]);

      const otherAfter = await db
        .select()
        .from(schema.businessHours)
        .where(eq(schema.businessHours.businessId, other.id));
      expect(otherAfter).toHaveLength(otherBefore.length);
    } finally {
      await db
        .delete(schema.appointments)
        .where(eq(schema.appointments.businessId, other.id));
      await db.delete(schema.services).where(eq(schema.services.businessId, other.id));
      await db
        .delete(schema.businessHours)
        .where(eq(schema.businessHours.businessId, other.id));
      await db.delete(schema.businesses).where(eq(schema.businesses.id, other.id));
      await db.delete(schema.users).where(eq(schema.users.id, otherUser.id));
    }
  });

  it("leaves the previous hours intact when the write fails", async () => {
    await saveBusinessHours(businessId, WEEKDAYS_9_TO_5);

    // A value Postgres cannot read as `time`, standing in for any failure
    // mid-transaction. What matters is what survives: the transaction rolls
    // back and the Business still has every hour it had, which is the promise
    // delete-then-insert cannot make.
    await expect(
      saveBusinessHours(businessId, [
        { weekday: 1, opensAt: "10:00", closesAt: "18:00" },
        { weekday: 2, opensAt: "not a time", closesAt: "18:00" },
      ]),
    ).rejects.toThrow();

    expect(await storedHours()).toEqual(WEEKDAYS_9_TO_5);
  });
});

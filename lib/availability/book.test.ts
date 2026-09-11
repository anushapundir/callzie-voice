import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bookSlot, type BookSlotResult } from "@/lib/availability/book";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

/*
  Acceptance criteria 3 and 4, against the local Postgres from
  vitest.globalSetup.ts.

  This file DROPS `appointments_no_overlap` in one test and restores it
  afterwards. That is only safe because the database is local and disposable —
  never run this against Cloud SQL, where it would open a window in which the
  live site can genuinely double-book. vitest.globalSetup.ts drops and
  re-migrates the database on every run, so even a crash mid-test cannot leave
  the constraint missing.
*/

const CLERK_ID = "user_test_availability_book";
const TIMEZONE = "Asia/Kolkata";

// 09:00 Asia/Kolkata on Monday 2026-08-17, with a 60-minute Service.
const SLOT_START = new Date("2026-08-17T03:30:00.000Z");

// SPEC.md §5 permits three concurrent Calls, so three is the number that matters.
const CONCURRENT_CALLS = 3;

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
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

/** Whether the EXCLUDE constraint is currently on the table. */
async function constraintExists(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap'
  `);
  return result.rows.length > 0;
}

async function restoreConstraint() {
  if (await constraintExists()) return;
  await db.execute(sql`
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
      EXCLUDE USING gist (
        "business_id" WITH =,
        tstzrange("starts_at", "ends_at") WITH &&
      ) WHERE (status NOT IN ('declined', 'cancelled'))
  `);
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "booking@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Booking Test Salon",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning();
  businessId = business.id;

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;
});

afterEach(async () => {
  await cleanup();
  // Restore before the next file runs, whatever happened above.
  await restoreConstraint();
});

/** Fire N bookings at the same Slot, as concurrently as the pool allows. */
function raceForTheSameSlot(count = CONCURRENT_CALLS) {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      bookSlot({
        businessId,
        serviceId,
        name: `Caller ${i + 1}`,
        phoneE164: `+1202555010${i + 1}`,
        startsAt: SLOT_START,
      }),
    ),
  );
}

async function appointmentsAtTheSlot() {
  return db
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.startsAt, SLOT_START));
}

describe("bookSlot under concurrency", () => {
  it("lets exactly one of three simultaneous bookings win", async () => {
    const results = await raceForTheSameSlot();

    /*
      Genuine contention, not sequencing: each insert takes its own connection
      from the pool, and Postgres serialises them on the gist index rather than
      the application ordering them. Same technique as
      create-business.test.ts:182, which races two onboarding submits.
    */
    // Type predicates, not a bare `r => r.ok`: without them TypeScript keeps the
    // union and `won[0].appointment` does not compile.
    const won = results.filter((r): r is Extract<BookSlotResult, { ok: true }> => r.ok);
    const lost = results.filter((r): r is Extract<BookSlotResult, { ok: false }> => !r.ok);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(CONCURRENT_CALLS - 1);
    for (const result of lost) {
      expect(result).toEqual({ ok: false, reason: "slot_taken" });
    }

    // And the database agrees — one row, not three.
    expect(await appointmentsAtTheSlot()).toHaveLength(1);
  });

  it("reports the loss as a value, never as a thrown error", async () => {
    // Maya must be able to respond to a lost Slot by offering another time
    // (SPEC.md §8). An exception would surface as a Tool failure instead, and
    // §3 rule 7 turns that into "someone will call you back".
    await expect(raceForTheSameSlot()).resolves.toBeDefined();
  });

  it("frees the Slot once the winner is cancelled", async () => {
    const [winner] = (await raceForTheSameSlot()).filter(
      (r): r is Extract<BookSlotResult, { ok: true }> => r.ok,
    );
    expect(winner).toBeDefined();

    await db
      .update(schema.appointments)
      .set({ status: "cancelled" })
      .where(eq(schema.appointments.id, winner.appointment.id));

    // The constraint exempts cancelled rows, so the Slot is bookable again.
    const second = await bookSlot({
      businessId,
      serviceId,
      name: "Later Caller",
      phoneE164: "+12025550199",
      startsAt: SLOT_START,
    });

    expect(second.ok).toBe(true);
  });
});

/*
  Acceptance criterion 4. Without this, the test above could be passing because
  bookSlot happens to serialise its own writes — and it would keep passing if
  someone removed the constraint.
*/
describe("the constraint, not the code, is what prevents the double-book", () => {
  it("double-books once the constraint is removed", async () => {
    expect(await constraintExists()).toBe(true);

    await db.execute(sql`
      ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_overlap"
    `);
    expect(await constraintExists()).toBe(false);

    const results = await raceForTheSameSlot();

    /*
      The defect, reproduced. With nothing in the database stopping it, more
      than one booking lands on the same Slot — which is what proves the test
      above is testing the constraint rather than the application's ordering.
    */
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(1);
    expect((await appointmentsAtTheSlot()).length).toBeGreaterThan(1);
  });

  it("has the constraint back afterwards", async () => {
    // afterEach restores it. This asserts the restore actually works, so the
    // test above cannot silently disarm every later file.
    expect(await constraintExists()).toBe(true);
  });
});

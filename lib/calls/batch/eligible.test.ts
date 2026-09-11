import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eligibleAppointmentIds,
  quotaRemaining,
} from "@/lib/calls/batch/eligible";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  "Call All queues every pending Appointment" and "Appointments needing
  attention are skipped" — issue #17's first two acceptance criteria, and #15's
  third.
*/

const CLERK_ID = "user_test_batch_eligible";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const FUTURE = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

/** A second Appointment for the same Business, parked clear of the seeded one. */
async function addAppointment(startsAt: Date) {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Second Person",
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: FUTURE,
  });
  // The seed leaves its Appointment `calling`; a batch only takes pending ones.
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("eligibleAppointmentIds", () => {
  it("takes a pending Appointment in the future", async () => {
    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      seed.appointmentId,
    ]);
  });

  it("skips an Appointment that needs attention", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([]);
  });

  it("skips an Appointment that has already happened", async () => {
    await addAppointment(new Date("2026-08-01T04:30:00.000Z"));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      seed.appointmentId,
    ]);
  });

  it("skips anything already settled", async () => {
    await db
      .update(schema.appointments)
      .set({ status: "confirmed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([]);
  });

  it("calls the soonest Appointment first", async () => {
    const sooner = await addAppointment(new Date("2026-09-07T04:30:00.000Z"));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      sooner.id,
      seed.appointmentId,
    ]);
  });

  it("never sees another Business's Appointments", async () => {
    expect(
      await eligibleAppointmentIds("00000000-0000-0000-0000-000000000000", NOW),
    ).toEqual([]);
  });
});

describe("quotaRemaining", () => {
  it("is what is left of the Quota", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 2, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(3);
  });

  it("floors at zero rather than going negative", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 9, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(0);
  });

  it("is unlimited for an admin", async () => {
    await db
      .update(schema.businesses)
      .set({ isAdmin: true, callsUsed: 99, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

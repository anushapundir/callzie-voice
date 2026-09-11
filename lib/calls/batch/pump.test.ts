import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallPlacer } from "@/lib/calls/batch/placer";
import { pumpBatch } from "@/lib/calls/batch/pump";
import { enqueueBatch } from "@/lib/calls/batch/queue";
import { db, schema } from "@/lib/db";
import type { AppointmentStatus } from "@/lib/db/schema";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The throttle (issue #17's first acceptance criterion).

  Nothing here contacts Retell (SPEC.md §3 rule 11): every placer is a fake.

  **What the concurrency case at the bottom does and does not prove.** It fires
  ten pumps at once and asserts three Calls come out, which catches an
  implementation that has no serialisation at all. It does *not* fail when only
  the advisory lock is removed: ten pumps starting together read the same count,
  select the same top-three Appointments, and contend on the same rows, so
  Postgres' row locks alone produce the right answer for this shape.

  The interleaving the lock exists for — one pump counting before another's
  claims commit and then selecting the queue after they do, so the two pick
  disjoint Appointments — needs the two reads to straddle a commit, and there is
  no seam here to force that without putting one in the production path. It is
  argued in pump.ts rather than asserted here. Do not read this file as
  permission to delete the lock.
*/

const CLERK_ID = "user_test_batch_pump";

/*
  The real clock, not a fixed instant — the one place in this suite where that
  is required rather than sloppy.

  `reserveCall` writes `calls.created_at` with the database's `now()`, and
  `countInFlightCalls` only counts a row created within the last 180 seconds of
  the `now` it is given. A fixed `NOW` two weeks in the future would make every
  Call this test places look stale, the throttle would count zero in flight, and
  the concurrency case below would pass ten Calls while appearing to test three.
*/
const NOW = new Date();
const FIRST_AT = new Date(NOW.getTime() + 14 * 86_400_000);

let seed: ToolTestSeed;

/** A placer that succeeds and records what it was asked to dial. */
function fakePlacer(): CallPlacer & { calls: string[] } {
  const calls: string[] = [];
  const placer = (async ({ appointmentId }) => {
    calls.push(appointmentId);
    return { ok: true as const };
  }) as CallPlacer & { calls: string[] };
  placer.calls = calls;
  return placer;
}

async function addAppointment(dayOffset: number) {
  const startsAt = new Date(FIRST_AT.getTime() + dayOffset * 86_400_000);
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: `Person ${dayOffset}`,
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row;
}

async function callsPlaced() {
  return db
    .select({ id: schema.calls.id, status: schema.calls.status })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(eq(schema.appointments.businessId, seed.businessId));
}

async function countByStatus(status: AppointmentStatus) {
  const rows = await db
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, seed.businessId),
        eq(schema.appointments.status, status),
      ),
    );
  return rows.length;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: FIRST_AT,
  });
  /*
    The seed leaves a Call and a `calling` Appointment behind. Clear both, so
    each case starts with an empty account, and turn the phone flag on — every
    test here is about the throttle, not about the flag.
  */
  await db.delete(schema.calls).where(eq(schema.calls.id, seed.callId));
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
  await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: true, callQuota: 50 })
    .where(eq(schema.businesses.id, seed.businessId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("pumpBatch", () => {
  it("places nothing when the queue is empty", async () => {
    const place = fakePlacer();

    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place }),
    ).toEqual({ placed: 0 });
  });

  it("places three and leaves the rest waiting", async () => {
    for (let i = 1; i <= 5; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place }),
    ).toEqual({ placed: 3 });

    expect(place.calls).toHaveLength(3);
    expect(await countByStatus("calling")).toBe(3);
    expect(await countByStatus("queued")).toBe(3);
  });

  it("calls the soonest Appointment first", async () => {
    const later = await addAppointment(9);
    const sooner = await addAppointment(1);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    await pumpBatch({ businessId: seed.businessId, now: NOW, place });

    expect(place.calls[0]).toBe(seed.appointmentId);
    expect(place.calls[1]).toBe(sooner.id);
    expect(place.calls[2]).toBe(later.id);
  });

  it("tops up only the free slots", async () => {
    for (let i = 1; i <= 5; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    await pumpBatch({ businessId: seed.businessId, now: NOW, place });

    // Two of the three finish; the third is still on the phone.
    const [first, second] = await callsPlaced();
    await db
      .update(schema.calls)
      .set({ status: "completed" })
      .where(eq(schema.calls.id, first.id));
    await db
      .update(schema.calls)
      .set({ status: "no_answer" })
      .where(eq(schema.calls.id, second.id));

    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place }),
    ).toEqual({ placed: 2 });
  });

  it("refuses an account that cannot place Phone Calls, without spending", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });
    await db
      .update(schema.businesses)
      .set({ phoneCallsEnabled: false })
      .where(eq(schema.businesses.id, seed.businessId));

    const place = fakePlacer();
    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place }),
    ).toEqual({ placed: 0, blocked: "phone_calls_disabled" });

    // Nothing dialled, no Call row, no Quota, and the Appointment still waiting.
    expect(place.calls).toHaveLength(0);
    expect(await callsPlaced()).toHaveLength(0);
    expect(await countByStatus("queued")).toBe(1);
  });

  it("drains the queue when the Quota runs out mid-batch", async () => {
    for (let i = 1; i <= 4; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });
    // Somebody else spent the account's Calls between the press and the pump.
    await db
      .update(schema.businesses)
      .set({ callsUsed: 50 })
      .where(eq(schema.businesses.id, seed.businessId));

    const place = fakePlacer();
    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place }),
    ).toEqual({ placed: 0, blocked: "exhausted" });

    // Nothing is left claiming it is about to be called.
    expect(await countByStatus("queued")).toBe(0);
    expect(await countByStatus("calling")).toBe(0);
    expect(await countByStatus("pending")).toBe(5);
  });

  it("hands the Call back when the dial fails", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const refuse: CallPlacer = async () => ({ ok: false, reason: "no_number" });
    expect(
      await pumpBatch({ businessId: seed.businessId, now: NOW, place: refuse }),
    ).toEqual({ placed: 0 });

    const [call] = await callsPlaced();
    const row = await db.query.calls.findFirst({
      where: eq(schema.calls.id, call.id),
    });
    expect(row?.status).toBe("failed");
    expect(row?.disconnectReason).toBe("no_number");

    /*
      The Quota is given back — this failure is ours and provable on the server,
      which is what separates it from a browser claiming its Call did not
      connect (lib/calls/quota.ts).
    */
    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });
    expect(business?.callsUsed).toBe(0);

    // And it is NOT requeued: a permanently broken dialler would loop forever.
    expect(await countByStatus("pending")).toBe(1);
  });
});

describe("the throttle under concurrency", () => {
  it("lets exactly three of ten simultaneous pumps place a Call", async () => {
    for (let i = 1; i <= 9; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        pumpBatch({ businessId: seed.businessId, now: NOW, place }),
      ),
    );

    // Three Calls, whichever pump won the lock.
    expect(results.reduce((total, result) => total + result.placed, 0)).toBe(3);
    expect(place.calls).toHaveLength(3);
    expect(await callsPlaced()).toHaveLength(3);
    expect(await countByStatus("calling")).toBe(3);
  });
});

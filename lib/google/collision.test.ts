import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
import { db, schema } from "@/lib/db";
import { raiseCollisions } from "@/lib/google/collision";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  The seven steps that make Clear mean something, run as seven assertions.

  Everything here is against a real Postgres — `vitest.globalSetup.ts` starts
  one. There is no database mock in this repo, and the guards being tested live
  in a WHERE clause, so a mock would be testing the mock.
*/

const CLERK_ID = "google-collision-test";

let businessId: string;
let appointmentId: string;

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

/** Back to a clean, callable Appointment. */
async function reset(): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: null, collisionEventIds: [] })
    .where(eq(schema.appointments.id, appointmentId));
}

beforeAll(async () => {
  await cleanupToolTest(CLERK_ID);
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-01T04:30:00Z"),
  });
  businessId = seed.businessId;
  appointmentId = seed.appointmentId;
});

afterAll(async () => {
  await cleanupToolTest(CLERK_ID);
});

beforeEach(reset);

describe("raiseCollisions", () => {
  it("does nothing when the calendar is clean", async () => {
    expect(await raiseCollisions(new Map())).toBe(0);
    expect((await appointment()).needsAttentionReason).toBeNull();
  });

  it("raises a Collision and records the event that caused it", async () => {
    // Step 2 of the walkthrough: the owner has added "Dentist" by hand.
    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]))).toBe(1);

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("collision");
    expect(row.collisionEventIds).toEqual(["evt-dentist"]);
  });

  it("says nothing the second time about the same event", async () => {
    // Step 4. Without this the id list would grow on every page load.
    await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]));

    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]))).toBe(0);
    expect((await appointment()).collisionEventIds).toEqual(["evt-dentist"]);
  });

  it("keeps the recorded ids when a human clears the Collision", async () => {
    // Step 5. Clearing writes one column, and this is not it.
    await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]));
    await clearNeedsAttention(businessId, appointmentId);

    const row = await appointment();
    expect(row.needsAttentionReason).toBeNull();
    expect(row.collisionEventIds).toEqual(["evt-dentist"]);
  });

  it("leaves a cleared Collision cleared", async () => {
    /*
      Step 6, and the assertion this whole column exists for. The overlapping
      event is still on the calendar and still being found — the owner has
      decided to live with it. Re-raising here would make Clear appear to do
      nothing at all.
    */
    await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]));
    await clearNeedsAttention(businessId, appointmentId);

    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]))).toBe(0);
    expect((await appointment()).needsAttentionReason).toBeNull();
  });

  it("raises again for a genuinely new event after a clear", async () => {
    /*
      Step 7. The clear is permanent for what was cleared, not for the
      Appointment forever — a second conflict the owner has never seen must
      still stop Callzie phoning somebody about that time.
    */
    await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]));
    await clearNeedsAttention(businessId, appointmentId);

    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist", "evt-lunch"]]]))).toBe(1);

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("collision");
    expect(row.collisionEventIds).toEqual(["evt-dentist", "evt-lunch"]);
  });

  it("records every overlapping event at once", async () => {
    await raiseCollisions(new Map([[appointmentId, ["evt-a", "evt-b"]]]));

    expect((await appointment()).collisionEventIds).toEqual(["evt-a", "evt-b"]);
  });

  it("leaves an Appointment already flagged for another reason completely alone", async () => {
    /*
      Both halves matter, and the second is the subtle one.

      The reason must not change: a `book_failed` Appointment is already blocked
      from calling, and relabelling it would lose why.

      The ids must ALSO stay empty. Recording them without raising would mean
      that clearing the `book_failed` silently swallows a Collision nobody was
      ever shown — the surface would go quiet about a conflict still sitting on
      the calendar.
    */
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]))).toBe(0);

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("book_failed");
    expect(row.collisionEventIds).toEqual([]);
  });

  it("surfaces the Collision once the other reason is cleared", async () => {
    // The pay-off of the rule above: nothing was swallowed.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));
    await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]));

    await clearNeedsAttention(businessId, appointmentId);

    expect(await raiseCollisions(new Map([[appointmentId, ["evt-dentist"]]]))).toBe(1);
    expect((await appointment()).needsAttentionReason).toBe("collision");
  });

  it("ignores an Appointment id that is not in the database", async () => {
    // The caller passes ids it read a moment ago; one could be deleted between
    // the read and the write.
    const gone = "11111111-2222-3333-4444-555555555555";

    expect(await raiseCollisions(new Map([[gone, ["evt-dentist"]]]))).toBe(0);
  });
});

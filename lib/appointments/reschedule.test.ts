import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_appointments_reschedule";

// 09:00 Asia/Kolkata on Monday 2026-08-17, 60-minute Service.
const ORIGINAL = new Date("2026-08-17T03:30:00.000Z");
// 11:00 the same day.
const TARGET = new Date("2026-08-17T05:30:00.000Z");
const TARGET_ENDS = new Date("2026-08-17T06:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: ORIGINAL });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

/** Park a competing Appointment on the target Slot. */
async function occupyTarget(status: "confirmed" | "cancelled" = "confirmed") {
  await db.insert(schema.appointments).values({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    name: "Someone Else",
    phoneE164: "+919876500000",
    startsAt: TARGET,
    endsAt: TARGET_ENDS,
    status,
  });
}

function move() {
  return db.transaction((tx) =>
    rescheduleAppointment({
      tx,
      appointmentId: seed.appointmentId,
      durationMinutes: 60,
      startsAt: TARGET,
    }),
  );
}

describe("rescheduleAppointment", () => {
  it("moves the Appointment and marks it rescheduled", async () => {
    const result = await move();
    expect(result.ok).toBe(true);

    const moved = await appointment();
    expect(moved!.startsAt).toEqual(TARGET);
    // Derived here, never accepted from a caller: ends_at is half of what the
    // exclusion constraint compares.
    expect(moved!.endsAt).toEqual(TARGET_ENDS);
    expect(moved!.status).toBe("rescheduled");
  });

  it("forgets the Collisions reported against the old time", async () => {
    /*
      A new time is a new question: events that conflicted with the original
      Slot say nothing about the new one. If the list survived a move, a real
      Collision at the new time could be skipped because its event id happened
      to be on the old day too (`lib/google/collision.ts`).
    */
    await db
      .update(schema.appointments)
      .set({ collisionEventIds: ["evt-old-conflict"] })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await move();

    expect((await appointment())!.collisionEventIds).toEqual([]);
  });

  it("keeps the reported Collisions when the move is refused", async () => {
    // Nothing moved, so nothing about the question changed.
    await db
      .update(schema.appointments)
      .set({ collisionEventIds: ["evt-old-conflict"] })
      .where(eq(schema.appointments.id, seed.appointmentId));
    await occupyTarget();

    await move();

    expect((await appointment())!.collisionEventIds).toEqual([
      "evt-old-conflict",
    ]);
  });

  it("reports a taken Slot as a value, not an exception", async () => {
    // Maya answers "that time just went" by offering another one (SPEC.md §8).
    // An exception would surface as a Tool failure instead.
    await occupyTarget();
    expect(await move()).toEqual({ ok: false, reason: "slot_taken" });
  });

  it("leaves the Appointment on its original Slot when it loses", async () => {
    await occupyTarget();
    await move();

    // SPEC.md §8 step 3: the Appointment keeps its original Slot.
    const unchanged = await appointment();
    expect(unchanged!.startsAt).toEqual(ORIGINAL);
    expect(unchanged!.status).toBe("calling");
  });

  it("leaves the caller's transaction usable after a loss", async () => {
    /*
      The savepoint, asserted. Postgres aborts a whole transaction the moment a
      statement fails, so without one, everything after the losing UPDATE —
      SPEC.md §8's retry, the book_failed write, the tool_invocations row — would
      fail with "current transaction is aborted". This test is what catches its
      removal.
    */
    await occupyTarget();

    const stillWorks = await db.transaction(async (tx) => {
      const lost = await rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      });
      expect(lost.ok).toBe(false);

      // Would throw "current transaction is aborted" without the savepoint.
      await tx
        .update(schema.appointments)
        .set({ needsAttentionReason: "book_failed" })
        .where(eq(schema.appointments.id, seed.appointmentId));

      return true;
    });

    expect(stillWorks).toBe(true);
    expect((await appointment())!.needsAttentionReason).toBe("book_failed");
  });

  it("allows a second attempt in the same transaction", async () => {
    // SPEC.md §8's "retry once, silently" happens inside one transaction. This
    // is that shape, with the competing Appointment removed between attempts.
    await occupyTarget();

    const result = await db.transaction(async (tx) => {
      const first = await rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      });
      expect(first.ok).toBe(false);

      return rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        // A different Slot this time — 12:00 local.
        startsAt: new Date("2026-08-17T06:30:00.000Z"),
      });
    });

    expect(result.ok).toBe(true);
  });

  it("takes a Slot freed by a cancelled Appointment", async () => {
    // `cancelled` is exempt from the constraint, so its Slot is bookable again.
    await occupyTarget("cancelled");
    expect((await move()).ok).toBe(true);
  });

  it("throws for an Appointment that does not exist", async () => {
    // Not a busy Slot and not something Maya can answer — a programming error,
    // and it must not come back looking like an ordinary refusal.
    await expect(
      db.transaction((tx) =>
        rescheduleAppointment({
          tx,
          appointmentId: "00000000-0000-0000-0000-000000000000",
          durationMinutes: 60,
          startsAt: TARGET,
        }),
      ),
    ).rejects.toThrow(/No Appointment/);
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listNeedsAttention } from "@/lib/business/needs-attention";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The rows the Needs Attention panel renders (SPEC.md §11.3 item 3).

  Deliberately a second query rather than a filter over `listAppointments`: that
  one is capped at 20 rows and ordered for the table, and a flagged Appointment
  sitting at position 21 would silently vanish from the surface that exists to
  show it.
*/

const CLERK_ID = "user_test_needs_attention";
const OTHER_CLERK_ID = "user_test_needs_attention_other";
/** 07:00, 09:00 and 11:00 in Asia/Kolkata, which is what `seedToolTest` uses. */
const SEVEN_AM = new Date("2026-09-02T01:30:00.000Z");
const NINE_AM = new Date("2026-09-02T03:30:00.000Z");
const ELEVEN_AM = new Date("2026-09-02T05:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

/**
 * Another Appointment for the seeded Business, at a time you choose.
 *
 * The time is a parameter because the ordering test needs to insert rows out of
 * chronological order — a fixture that always inserts later-and-later would let
 * that test pass on insertion order alone.
 */
async function appointmentAt(startsAt: Date, name: string) {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name,
      phoneE164: "+12025550143",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row.id;
}

/** A second Appointment for the same Business, at a later time. */
async function secondAppointment() {
  return appointmentAt(ELEVEN_AM, "Daniel Okafor");
}

async function flag(
  appointmentId: string,
  reason: "book_failed" | "collision" | "negotiation_truncated" | "unreachable",
) {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: reason })
    .where(eq(schema.appointments.id, appointmentId));
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: NINE_AM,
  });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: NINE_AM,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("listNeedsAttention", () => {
  it("returns nothing for a healthy Business", async () => {
    // The panel renders nothing at all in this case — it is not an empty state.
    expect(await listNeedsAttention(seed.businessId)).toEqual([]);
  });

  it("returns only the flagged Appointments", async () => {
    await secondAppointment();
    await flag(seed.appointmentId, "book_failed");

    const rows = await listNeedsAttention(seed.businessId);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seed.appointmentId);
    expect(rows[0].name).toBe("Priya Sharma");
    expect(rows[0].reason).toBe("book_failed");
    expect(rows[0].startsAt).toEqual(NINE_AM);
  });

  it("carries the Service name", async () => {
    await flag(seed.appointmentId, "collision");

    expect((await listNeedsAttention(seed.businessId))[0].serviceName).toBe(
      "Haircut",
    );
  });

  it("counts the Calls placed, for the unreachable sentence", async () => {
    await flag(seed.appointmentId, "unreachable");
    // `seedToolTest` already wrote one Call. A second makes two attempts.
    await db.insert(schema.calls).values({
      businessId: seed.businessId,
      appointmentId: seed.appointmentId,
      callType: "web",
      attempt: 2,
      status: "no_answer",
    });

    expect((await listNeedsAttention(seed.businessId))[0].attempts).toBe(2);
  });

  it("counts zero for an Appointment flagged without a Call", async () => {
    // A Collision needs no Call at all — #20 detects it from the calendar.
    const id = await secondAppointment();
    await flag(id, "collision");

    const rows = await listNeedsAttention(seed.businessId);
    expect(rows.find((row) => row.id === id)!.attempts).toBe(0);
  });

  it("puts the soonest Appointment first", async () => {
    /*
      The one about to happen is the one somebody has to deal with first.

      Note the insert order: 09:00 (seeded), then 11:00, then 07:00 last. It has
      to disagree with the answer, or the test passes on whatever order Postgres
      happens to return rows in and proves nothing about the ORDER BY. Deleting
      the `.orderBy` should break this test, and with the 07:00 row it does.
    */
    const later = await secondAppointment();
    const earlier = await appointmentAt(SEVEN_AM, "Ana Silva");

    await flag(later, "collision");
    await flag(earlier, "unreachable");
    await flag(seed.appointmentId, "book_failed");

    const rows = await listNeedsAttention(seed.businessId);

    expect(rows.map((row) => row.id)).toEqual([
      earlier,
      seed.appointmentId,
      later,
    ]);
  });

  it("does not leak another Business's flagged Appointment", async () => {
    await flag(seed.appointmentId, "book_failed");
    await flag(other.appointmentId, "book_failed");

    const rows = await listNeedsAttention(seed.businessId);

    expect(rows.map((row) => row.id)).toEqual([seed.appointmentId]);
  });
});

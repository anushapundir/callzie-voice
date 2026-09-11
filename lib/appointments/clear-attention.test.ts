import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  SPEC.md §5: clearing is the only resolution. Callzie never resolves a Needs
  Attention itself, so this is the one write that takes an Appointment out of
  the state — and it changes exactly one column.
*/

const CLERK_ID = "user_test_clear_attention";
const OTHER_CLERK_ID = "user_test_clear_attention_other";
const STARTS_AT = new Date("2026-09-02T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

async function appointmentRow(id: string) {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, id),
  });
  if (!row) throw new Error("the seeded Appointment vanished");
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);

  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });

  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, seed.appointmentId));
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, other.appointmentId));
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("clearNeedsAttention", () => {
  it("returns the Appointment to callable", async () => {
    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    expect((await appointmentRow(seed.appointmentId)).needsAttentionReason)
      .toBeNull();
  });

  it("changes nothing else about it", async () => {
    /*
      The acceptance criterion, literally: "Clearing restores it to callable
      without altering its Slot or status." A Clear that also tidied the row up
      would be Callzie resolving something, which SPEC.md §5 says it never does.
    */
    const before = await appointmentRow(seed.appointmentId);

    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    const after = await appointmentRow(seed.appointmentId);
    expect(after).toEqual({ ...before, needsAttentionReason: null });
  });

  it("leaves an unreachable status standing", async () => {
    /*
      Deliberate. Clearing says "a human has looked at this", not "this person
      turned out to be reachable after all". The pill goes on saying Unreachable
      until a Call proves otherwise, and the row is callable so one can be made.
    */
    await db
      .update(schema.appointments)
      .set({ status: "unreachable", needsAttentionReason: "unreachable" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    const row = await appointmentRow(seed.appointmentId);
    expect(row.needsAttentionReason).toBeNull();
    expect(row.status).toBe("unreachable");
  });

  it("clears nothing for another Business", async () => {
    // The cross-tenant guard, and it is inside the WHERE clause rather than a
    // read followed by a check — same shape as `ownedBy` in lib/calls/record.ts.
    await clearNeedsAttention(seed.businessId, other.appointmentId);

    expect((await appointmentRow(other.appointmentId)).needsAttentionReason)
      .toBe("book_failed");
  });

  it("is a no-op on an Appointment that is already clear", async () => {
    /*
      Narrow, and worth being honest about what it does and does not catch.
      Setting null to null twice is null, so this cannot fail against a wrong
      WHERE clause or a wrong column — the tests above cover those.

      What it does catch is somebody deciding that clearing a row with nothing
      to clear is an error worth raising. It is not. A Server Action is a POST
      anybody can send twice, two people can work the same queue, and a
      double-press is not a mistake to report back to either of them.
    */
    await clearNeedsAttention(seed.businessId, seed.appointmentId);
    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    expect((await appointmentRow(seed.appointmentId)).needsAttentionReason)
      .toBeNull();
  });
});

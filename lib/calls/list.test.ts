import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCalls } from "@/lib/calls/list";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The Calls list. The sidebar has linked here since #1 and it has been a
  Placeholder ever since; leaving it would ship a dead link into the screen this
  ticket exists to show off.

  The test that matters is the same one `loadCallDetail` has: this reads across
  a whole Business, so a missing scope would list another account's Calls.
*/

const CLERK_ID = "user_test_call_list";
const OTHER_CLERK_ID = "user_test_call_list_other";
const STARTS_AT = new Date("2026-08-27T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);

  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("listCalls", () => {
  it("returns only this Business's Calls", async () => {
    const rows = await listCalls(seed.businessId);

    expect(rows.map((row) => row.id)).toEqual([seed.callId]);
    expect(rows.map((row) => row.id)).not.toContain(other.callId);
  });

  it("carries the person and the Service off the Appointment", async () => {
    const [row] = await listCalls(seed.businessId);

    expect(row.personName).toBe("Priya Sharma");
    expect(row.serviceName).toBe("Haircut");
  });

  it("returns the newest Call first", async () => {
    const [second] = await db
      .insert(schema.calls)
      .values({
        businessId: seed.businessId,
        appointmentId: seed.appointmentId,
        callType: "web",
        attempt: 2,
        status: "queued",
        // Explicit rather than relying on the default: two rows inserted in the
        // same millisecond would leave the order to chance, and this test is
        // about the order.
        createdAt: new Date(Date.now() + 1_000),
      })
      .returning();

    const rows = await listCalls(seed.businessId);

    expect(rows[0].id).toBe(second.id);
  });

  it("returns an empty list for a Business that has never called", async () => {
    await db.delete(schema.toolInvocations);
    await db.delete(schema.extractions);
    await db.delete(schema.calls);

    expect(await listCalls(seed.businessId)).toEqual([]);
  });
});

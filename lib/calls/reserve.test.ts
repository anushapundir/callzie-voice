import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reserveCall } from "@/lib/calls/reserve";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The half of placing a Call that must happen in one transaction: the attempt
  number, the Quota claim and the `calls` row land together or not at all. A
  claimed Call with no row charges somebody for nothing; a row with no claim
  gives a Call away.
*/

const CLERK_ID = "user_test_calls_reserve";
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
});

afterEach(() => cleanupToolTest(CLERK_ID));

async function reserve() {
  return db.transaction((tx) =>
    reserveCall(tx, {
      businessId: seed.businessId,
      appointmentId: seed.appointmentId,
      callType: "phone",
    }),
  );
}

describe("reserveCall", () => {
  it("numbers the next attempt after the Calls already there", async () => {
    // The seed leaves one Call behind, so this is the second attempt.
    const result = await reserve();

    expect(result).toMatchObject({ ok: true, attempt: 2 });
  });

  it("writes the row queued, before Retell is contacted", async () => {
    const result = await reserve();
    if (!result.ok) throw new Error("expected a reservation");

    const call = await db.query.calls.findFirst({
      where: eq(schema.calls.id, result.callId),
    });

    expect(call?.status).toBe("queued");
    expect(call?.callType).toBe("phone");
    expect(call?.retellCallId).toBeNull();
  });

  it("spends one Call from the Quota", async () => {
    await reserve();

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });

    expect(business?.callsUsed).toBe(1);
  });

  it("refuses, and writes nothing, once the Quota is spent", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 5, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    const before = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, seed.appointmentId));

    expect(await reserve()).toEqual({ ok: false, reason: "exhausted" });

    const after = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, seed.appointmentId));
    expect(after.length).toBe(before.length);
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIVE_CALL_STALENESS_MS } from "@/lib/business/active-calls";
import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { db, schema } from "@/lib/db";
import type { CallStatus, CallType } from "@/lib/db/schema";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  What "running right now" means, which is not the same as what the status
  column says. A Call cannot outlive max_call_duration_ms (SPEC.md §7), so a row
  still marked in_progress three minutes later is a delivery that never arrived,
  not a Call — and it must not hold a slot in the throttle for the life of the
  account. Same read-time staleness rule as lib/business/active-calls.ts.
*/

const CLERK_ID = "user_test_batch_in_flight";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

async function addCall(
  status: CallStatus,
  callType: CallType,
  createdAt: Date = NOW,
) {
  await db.insert(schema.calls).values({
    businessId: seed.businessId,
    appointmentId: seed.appointmentId,
    callType,
    status,
    createdAt,
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  // The seed's own Call would count; clear it so each case starts from zero.
  await db.delete(schema.calls).where(eq(schema.calls.id, seed.callId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("countInFlightCalls", () => {
  it("counts a Call that has not connected yet", async () => {
    await addCall("queued", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(1);
  });

  it("counts a Call that is ringing or in progress", async () => {
    await addCall("ringing", "phone");
    await addCall("in_progress", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(2);
  });

  it("does not count a Call that has finished", async () => {
    await addCall("completed", "phone");
    await addCall("no_answer", "phone");
    await addCall("failed", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(0);
  });

  it("does not count a Call too old to still be running", async () => {
    /*
      One second past the staleness window, derived rather than written down.

      It used to be the literal 181_000, chosen when the cap was 120s and the
      window 180s. Raising the cap to 180s moved the window to 240s and left
      this test asserting that a 181-second-old Call was stale, which it no
      longer is. Reading the constant means the next change to the cap moves
      this with it instead of turning it red.
    */
    const tooOld = new Date(NOW.getTime() - LIVE_CALL_STALENESS_MS - 1_000);
    await addCall("in_progress", "phone", tooOld);

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(0);
  });

  it("still counts a Call inside the staleness window", async () => {
    // The other side of the same boundary, so a window shrunk to nothing
    // cannot pass the test above by counting everything as stale.
    const justInside = new Date(NOW.getTime() - LIVE_CALL_STALENESS_MS + 1_000);
    await addCall("in_progress", "phone", justInside);

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(1);
  });

  it("counts a live Web Call, because it is one of the account's Calls", async () => {
    await addCall("in_progress", "web");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(1);
  });

  it("can be asked for Phone Calls only, which is what the strip shows", async () => {
    await addCall("in_progress", "web");
    await addCall("in_progress", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW, ["phone"])).toBe(
      1,
    );
  });

  it("never counts another Business's Calls", async () => {
    await addCall("in_progress", "phone");

    expect(
      await countInFlightCalls(db, "00000000-0000-0000-0000-000000000000", NOW),
    ).toBe(0);
  });
});

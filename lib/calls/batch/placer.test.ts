import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refusingPlacer } from "@/lib/calls/batch/placer";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  SPEC.md §3 rule 9: never place a Phone Call from an account without
  `phone_calls_enabled`. Open signup plus arbitrary outbound dialling is a
  robocalling tool.

  The guard is here, at the boundary, as well as in the pump that calls it —
  issue #19's first acceptance criterion says an unflagged account cannot place
  a Phone Call *by any route*, and this is the route.
*/

const CLERK_ID = "user_test_batch_placer";
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

describe("refusingPlacer", () => {
  it("refuses an unflagged account", async () => {
    expect(
      await refusingPlacer({
        businessId: seed.businessId,
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_disabled" });
  });

  it("still refuses a flagged one, because nothing dials yet", async () => {
    await db
      .update(schema.businesses)
      .set({ phoneCallsEnabled: true })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(
      await refusingPlacer({
        businessId: seed.businessId,
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_not_implemented" });
  });

  it("refuses a Business that does not exist", async () => {
    expect(
      await refusingPlacer({
        businessId: "00000000-0000-0000-0000-000000000000",
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_disabled" });
  });
});

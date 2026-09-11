import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCallAlert } from "@/lib/business/call-alerts";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The two Retell failures that are not really about the Call (issue #13, last
  acceptance criterion).

  `no_valid_payment` means the Retell balance is gone — nothing will connect
  until someone tops it up. `concurrency_limit_reached` means too many Calls at
  once, so wait and retry. Both land as `failed` in the database, and told as a
  generic failure the first looks like a bug for as long as it takes somebody to
  think of checking the billing page.

  The rule this pins down is which Call is consulted: the most recent one. That
  is what makes the banner clear itself — a Call that goes through afterwards is
  proof the condition has passed, and no one has to dismiss anything.
*/

const CLERK_ID = "user_test_call_alerts";
const OTHER_CLERK_ID = "user_test_call_alerts_other";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;

/** Put the seeded Call into a finished state, at a known moment. */
async function endSeededCall(reason: string | null, at: Date) {
  await db
    .update(schema.calls)
    .set({
      status: reason === "user_hangup" ? "completed" : "failed",
      disconnectReason: reason,
      createdAt: at,
    })
    .where(eq(schema.calls.id, seed.callId));
}

/** A second, later Call on the same Appointment. */
async function addCall(reason: string, at: Date) {
  await db.insert(schema.calls).values({
    businessId: seed.businessId,
    appointmentId: seed.appointmentId,
    callType: "web",
    attempt: 2,
    status: reason === "user_hangup" ? "completed" : "failed",
    disconnectReason: reason,
    createdAt: at,
  });
}

const EARLIER = new Date("2026-08-20T09:00:00.000Z");
const LATER = new Date("2026-08-20T10:00:00.000Z");

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("loadCallAlert", () => {
  it("says nothing when the account has never placed a Call", async () => {
    await db.delete(schema.calls).where(eq(schema.calls.id, seed.callId));

    expect(await loadCallAlert(seed.businessId)).toBeNull();
  });

  it("says nothing about a Call still in progress", async () => {
    expect(await loadCallAlert(seed.businessId)).toBeNull();
  });

  it("names an exhausted Retell balance", async () => {
    await endSeededCall("no_valid_payment", EARLIER);

    expect(await loadCallAlert(seed.businessId)).toBe("credit_exhausted");
  });

  it("names too many Calls at once", async () => {
    await endSeededCall("concurrency_limit_reached", EARLIER);

    expect(await loadCallAlert(seed.businessId)).toBe("concurrency_limit");
  });

  it.each(["user_hangup", "dial_no_answer", "error_asr", null])(
    "says nothing about a Call that ended as %s",
    async (reason) => {
      await endSeededCall(reason, EARLIER);

      expect(await loadCallAlert(seed.businessId)).toBeNull();
    },
  );

  /*
    The banner clears itself. A Call that connected after the balance ran out is
    proof somebody topped it up, so there is nothing left to act on — and nothing
    to dismiss, which is what keeps this off the "persistent UI that outlives its
    problem" pile.
  */
  it("stops warning once a later Call goes through", async () => {
    await endSeededCall("no_valid_payment", EARLIER);

    await addCall("user_hangup", LATER);

    expect(await loadCallAlert(seed.businessId)).toBeNull();
  });

  it("warns when the newest Call is the one that failed", async () => {
    await endSeededCall("user_hangup", EARLIER);

    await addCall("no_valid_payment", LATER);

    expect(await loadCallAlert(seed.businessId)).toBe("credit_exhausted");
  });

  /*
    Scoped through `appointments` to the Business inside the WHERE clause, the
    way lib/business/active-calls.ts does it. Callzie is open signup, so a query
    that reads across accounts would put one account's billing state on another
    account's dashboard.
  */
  it("never reads another account's Calls", async () => {
    const other = await seedToolTest({
      clerkId: OTHER_CLERK_ID,
      appointmentStartsAt: APPOINTMENT_STARTS_AT,
    });
    await db
      .update(schema.calls)
      .set({ status: "failed", disconnectReason: "no_valid_payment" })
      .where(eq(schema.calls.id, other.callId));

    expect(await loadCallAlert(seed.businessId)).toBeNull();
  });
});

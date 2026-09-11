import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, schema } from "@/lib/db";
import { attachNumber, listNumbers } from "@/lib/inbound/numbers";
import { provisionNumber, releaseNumber } from "@/lib/inbound/provision";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Number provisioning (issue #44), contacting nobody.

  Both Retell operations are injected, so every branch below — including the two
  that describe a number Retell bought and Callzie could not record — runs for
  free (SPEC.md §3 rule 11).

  The property under test throughout is the same one: after any failure, the
  disagreement between Callzie and Retell must be the *visible* kind. A number
  with no row costs $2 a month and is findable in a dashboard. A row with no
  number is a phone that silently stops being answered.
*/

const CLERK_ID = "user_test_provision";
const APP_URL = "https://callzie.example";

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });

  await db
    .update(schema.businesses)
    .set({ inboundEnabled: true, emergencyLine: "+12025550111" })
    .where(eq(schema.businesses.id, seed.businessId));
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

/** A Retell that sells one number and remembers being asked. */
function seller(phoneNumber = "+12025550190") {
  return vi.fn(async () => ({
    phone_number: phoneNumber,
    phone_number_id: "num_abc123",
  }));
}

describe("provisionNumber", () => {
  it("buys a number and points it at the Business", async () => {
    const purchase = seller();

    const result = await provisionNumber({
      businessId: seed.businessId,
      appUrl: APP_URL,
      purchase,
    });

    expect(result).toEqual({ ok: true, e164: "+12025550190" });

    const [row] = await listNumbers(seed.businessId);
    expect(row.e164).toBe("+12025550190");
    // Recorded, so the number can never be orphaned in the dashboard with
    // nothing pointing at it.
    expect(row.retellNumberId).toBe("num_abc123");
  });

  it("bakes the deployed inbound webhook into the purchase", async () => {
    /*
      The same warning as `scripts/create-agent.ts` and APP_URL: Retell calls
      this from its own servers, so a localhost here is a number that rings and
      reaches nothing.
    */
    const purchase = seller();

    await provisionNumber({
      businessId: seed.businessId,
      appUrl: APP_URL,
      purchase,
    });

    expect(purchase).toHaveBeenCalledWith(
      expect.objectContaining({
        inbound_webhook_url: "https://callzie.example/api/webhooks/retell/inbound",
      }),
    );
  });

  it("refuses an account that is not answering calls", async () => {
    // A number on an account that declines every call is $2 a month for
    // nothing — and `inbound_enabled` is also where the emergency-number
    // requirement is enforced.
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: false })
      .where(eq(schema.businesses.id, seed.businessId));

    const purchase = seller();
    const result = await provisionNumber({
      businessId: seed.businessId,
      appUrl: APP_URL,
      purchase,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_enabled");
    // Bought first, then refused — so the orphan is reported, not swallowed.
    expect(result.orphanedNumber).toBe("+12025550190");
  });

  it("reports an orphaned number rather than silently dropping it", async () => {
    /*
      The failure this whole design is shaped around. Retell has to purchase
      before there is a number to record, so there is an instant where a number
      exists with no row. Releasing it automatically was the obvious
      alternative and is worse: a release that itself failed would leave nothing
      anywhere pointing at a number that bills every month.
    */
    const other = await seedToolTest({
      clerkId: `${CLERK_ID}_other`,
      appointmentStartsAt: new Date("2026-09-15T04:30:00.000Z"),
    });
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: true })
      .where(eq(schema.businesses.id, other.businessId));

    try {
      // Somebody else already holds it.
      await attachNumber({
        businessId: other.businessId,
        e164: "+12025550190",
      });

      const result = await provisionNumber({
        businessId: seed.businessId,
        appUrl: APP_URL,
        purchase: seller(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("already_taken");
      expect(result.orphanedNumber).toBe("+12025550190");
    } finally {
      await cleanupToolTest(`${CLERK_ID}_other`);
    }
  });

  it("orphans nothing when the purchase itself fails", async () => {
    const purchase = vi.fn(async () => {
      throw new Error("no numbers available in that area code");
    });

    const result = await provisionNumber({
      businessId: seed.businessId,
      appUrl: APP_URL,
      purchase,
    });

    expect(result).toEqual({ ok: false, reason: "purchase_failed" });
    expect(await listNumbers(seed.businessId)).toHaveLength(0);
  });
});

describe("releaseNumber", () => {
  async function attached() {
    const result = await attachNumber({
      businessId: seed.businessId,
      e164: "+12025550190",
      retellNumberId: "num_abc123",
    });
    if (!result.ok) throw new Error("could not attach");
    return result.id;
  }

  it("stops routing the number and gives it back", async () => {
    const id = await attached();
    const release = vi.fn(async () => {});

    expect(await releaseNumber({ businessId: seed.businessId, numberId: id, release }))
      .toEqual({ ok: true, releasedAtRetell: true });

    expect(release).toHaveBeenCalledWith("num_abc123");
    expect(await listNumbers(seed.businessId)).toHaveLength(0);
  });

  it("still forgets the number when Retell refuses to release it", async () => {
    /*
      The row goes first on purpose. What survives is a number nobody routes to
      — visible in the dashboard, costing $2, findable. The other ordering
      leaves a Business routing to a number that no longer exists, and the phone
      just stops being answered with nothing on screen to say why.
    */
    const id = await attached();
    const release = vi.fn(async () => {
      throw new Error("retell is down");
    });

    const result = await releaseNumber({
      businessId: seed.businessId,
      numberId: id,
      release,
    });

    expect(result).toEqual({ ok: true, releasedAtRetell: false });
    // Gone from Callzie regardless — the business asked to stop.
    expect(await listNumbers(seed.businessId)).toHaveLength(0);
  });

  it("refuses to release another account's number", async () => {
    const other = await seedToolTest({
      clerkId: `${CLERK_ID}_other`,
      appointmentStartsAt: new Date("2026-09-15T04:30:00.000Z"),
    });
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: true })
      .where(eq(schema.businesses.id, other.businessId));

    try {
      const theirs = await attachNumber({
        businessId: other.businessId,
        e164: "+12025550191",
      });
      if (!theirs.ok) throw new Error("could not attach");

      const release = vi.fn(async () => {});
      const result = await releaseNumber({
        businessId: seed.businessId,
        numberId: theirs.id,
        release,
      });

      expect(result).toEqual({ ok: false, reason: "not_found" });
      // Never contacted Retell about somebody else's number.
      expect(release).not.toHaveBeenCalled();
      expect(await listNumbers(other.businessId)).toHaveLength(1);
    } finally {
      await cleanupToolTest(`${CLERK_ID}_other`);
    }
  });

  it("says nothing was released for a hand-attached number", async () => {
    const result = await attachNumber({
      businessId: seed.businessId,
      e164: "+12025550190",
    });
    if (!result.ok) throw new Error("could not attach");

    const release = vi.fn(async () => {});
    expect(
      await releaseNumber({
        businessId: seed.businessId,
        numberId: result.id,
        release,
      }),
    ).toEqual({ ok: true, releasedAtRetell: false });

    expect(release).not.toHaveBeenCalled();
  });
});

describe("attachNumber", () => {
  it("refuses a number two Businesses would share", async () => {
    // The unique constraint speaking, not a check. Two Businesses on one number
    // leaves the inbound webhook unable to say whose customer is calling.
    await attachNumber({ businessId: seed.businessId, e164: "+12025550190" });

    expect(
      await attachNumber({ businessId: seed.businessId, e164: "+12025550190" }),
    ).toEqual({ ok: false, reason: "already_taken" });
  });

  it("normalises before storing, so one number has one spelling", async () => {
    await attachNumber({
      businessId: seed.businessId,
      e164: "+1 (202) 555-0190",
    });

    const [row] = await listNumbers(seed.businessId);
    expect(row.e164).toBe("+12025550190");
  });

  it("refuses a number that is not a number", async () => {
    expect(
      await attachNumber({ businessId: seed.businessId, e164: "the front desk" }),
    ).toEqual({ ok: false, reason: "invalid_number" });
  });
});

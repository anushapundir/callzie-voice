import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { claimCallQuota, releaseCallQuota } from "@/lib/calls/quota";
import { db, schema } from "@/lib/db";

/*
  The Quota (SPEC.md §11.1), against the local Postgres from
  vitest.globalSetup.ts.

  The test this file exists for is the last one. Every other test here passes
  against a read-then-write implementation; only the concurrent one fails.
*/

const CLERK_ID = "user_test_calls_quota";

let businessId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

async function makeBusiness(
  overrides: Partial<typeof schema.businesses.$inferInsert> = {},
) {
  const user = await provisionUser(CLERK_ID, "quota@example.com");
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Quota Test Clinic",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      ...overrides,
    })
    .returning();
  businessId = business.id;
  return business;
}

async function callsUsed(): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.callsUsed;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("claimCallQuota", () => {
  it("succeeds while Calls remain", async () => {
    await makeBusiness({ callsUsed: 4, callQuota: 5 });

    expect(await claimCallQuota(db, businessId)).toEqual({
      ok: true,
      callsUsed: 5,
    });
  });

  it("refuses the sixth Call", async () => {
    await makeBusiness({ callsUsed: 5, callQuota: 5 });

    expect(await claimCallQuota(db, businessId)).toEqual({
      ok: false,
      reason: "exhausted",
    });
    // And nothing moved.
    expect(await callsUsed()).toBe(5);
  });

  it("refuses an account whose Quota is zero", async () => {
    await makeBusiness({ callsUsed: 0, callQuota: 0 });

    expect(await claimCallQuota(db, businessId)).toEqual({
      ok: false,
      reason: "exhausted",
    });
  });

  it("does not limit an admin account", async () => {
    // Acceptance criterion 4.
    await makeBusiness({ callsUsed: 99, callQuota: 5, isAdmin: true });

    expect(await claimCallQuota(db, businessId)).toEqual({
      ok: true,
      callsUsed: 100,
    });
  });

  it("still counts an admin's Calls", async () => {
    // calls_used is the record of what was spent. Frozen at zero it is a lie,
    // even though the sidebar renders "Unlimited" rather than the number.
    await makeBusiness({ callsUsed: 0, callQuota: 5, isAdmin: true });

    await claimCallQuota(db, businessId);

    expect(await callsUsed()).toBe(1);
  });

  it("refuses a Business that does not exist", async () => {
    await makeBusiness();

    expect(
      await claimCallQuota(db, "00000000-0000-0000-0000-000000000000"),
    ).toEqual({ ok: false, reason: "exhausted" });
  });
});

describe("releaseCallQuota", () => {
  it("gives a Call back", async () => {
    await makeBusiness({ callsUsed: 3, callQuota: 5 });

    await releaseCallQuota(db, businessId);

    expect(await callsUsed()).toBe(2);
  });

  it("floors at zero, so a double release cannot go negative", async () => {
    await makeBusiness({ callsUsed: 0, callQuota: 5 });

    await releaseCallQuota(db, businessId);

    expect(await callsUsed()).toBe(0);
  });
});

/*
  The test this file exists for.

  A read-then-write implementation passes every test above and fails this one:
  both callers read "four used" and both write "five", and the account places
  six Calls. Same shape as lib/availability/book.test.ts, applied to a counter
  instead of a range.
*/
describe("the Quota under concurrency", () => {
  it("lets exactly five of ten simultaneous claims through", async () => {
    await makeBusiness({ callsUsed: 0, callQuota: 5 });

    // Genuine contention: each statement takes its own connection from the
    // pool, and Postgres serialises them on the row lock rather than the
    // application ordering them.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCallQuota(db, businessId)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(5);
    // And the database agrees — five, not ten.
    expect(await callsUsed()).toBe(5);
  });

  it("hands out each number exactly once, never the same one twice", async () => {
    // The counts above would still pass if two winners both reported "5".
    // Every winner must have taken a distinct Call.
    await makeBusiness({ callsUsed: 0, callQuota: 5 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCallQuota(db, businessId)),
    );

    const numbers = results
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => r.callsUsed)
      .sort();

    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});

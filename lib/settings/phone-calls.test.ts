import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { setPhoneCallsEnabled } from "@/lib/settings/phone-calls";

/*
  The flag that decides whether an account may dial a real phone.

  Every case here is about who may write it, not about what it does — the
  admin check is inside the UPDATE's WHERE clause, so a non-admin's write must
  match zero rows rather than be caught by a branch above it.
*/

const ADMIN_CLERK_ID = "user_test_phone_flag_admin";
const PLAIN_CLERK_ID = "user_test_phone_flag_plain";

let adminBusinessId: string;
let plainBusinessId: string;

async function seed(clerkId: string, isAdmin: boolean): Promise<string> {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Bandra Dental",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      isAdmin,
    })
    .returning();
  return business.id;
}

async function cleanup() {
  for (const clerkId of [ADMIN_CLERK_ID, PLAIN_CLERK_ID]) {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.clerkId, clerkId),
    });
    if (!user) continue;
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.userId, user.id));
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
  }
}

async function flagOf(businessId: string): Promise<boolean> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.phoneCallsEnabled;
}

beforeEach(async () => {
  await cleanup();
  adminBusinessId = await seed(ADMIN_CLERK_ID, true);
  plainBusinessId = await seed(PLAIN_CLERK_ID, false);
});

afterEach(cleanup);

describe("setPhoneCallsEnabled", () => {
  it("starts off for every account", async () => {
    expect(await flagOf(adminBusinessId)).toBe(false);
    expect(await flagOf(plainBusinessId)).toBe(false);
  });

  it("lets an admin turn it on", async () => {
    expect(await setPhoneCallsEnabled(adminBusinessId, true)).toBe(true);
    expect(await flagOf(adminBusinessId)).toBe(true);
  });

  it("lets an admin turn it off again", async () => {
    await setPhoneCallsEnabled(adminBusinessId, true);

    expect(await setPhoneCallsEnabled(adminBusinessId, false)).toBe(true);
    expect(await flagOf(adminBusinessId)).toBe(false);
  });

  it("writes nothing for a non-admin", async () => {
    expect(await setPhoneCallsEnabled(plainBusinessId, true)).toBe(false);
    expect(await flagOf(plainBusinessId)).toBe(false);
  });

  /*
    The other direction, and it matters as much as the first. If the check ever
    slipped out of the WHERE clause, a non-admin could still not turn the flag
    on — but it could turn one off that an admin had turned on, which is a write
    to somebody else's account either way. Both directions must match zero rows.

    The flag is put on with a direct `db.update` rather than through
    `setPhoneCallsEnabled`, because this account is not an admin and the function
    under test would correctly refuse to set it up.
  */
  it("writes nothing for a non-admin turning it off", async () => {
    await db
      .update(schema.businesses)
      .set({ phoneCallsEnabled: true })
      .where(eq(schema.businesses.id, plainBusinessId));

    expect(await setPhoneCallsEnabled(plainBusinessId, false)).toBe(false);
    expect(await flagOf(plainBusinessId)).toBe(true);
  });

  it("writes nothing for a Business that does not exist", async () => {
    const absent = "00000000-0000-0000-0000-000000000000";

    expect(await setPhoneCallsEnabled(absent, true)).toBe(false);
  });
});

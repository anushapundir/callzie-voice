import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { provisionUser } from "@/lib/auth/provision-user";

// Namespaced so a stray row is obviously a test artefact, and so cleanup can
// never touch a real account.
const CLERK_ID = "user_test_provision_user";

async function cleanup() {
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

async function rowsFor(clerkId: string) {
  return db.select().from(schema.users).where(eq(schema.users.clerkId, clerkId));
}

describe("provisionUser", () => {
  afterEach(cleanup);

  it("creates the User row on first sign-in", async () => {
    const user = await provisionUser(CLERK_ID, "first@example.com");

    expect(user.clerkId).toBe(CLERK_ID);
    expect(user.email).toBe("first@example.com");
    expect(await rowsFor(CLERK_ID)).toHaveLength(1);
  });

  it("returns the same row on a repeat call rather than duplicating it", async () => {
    const first = await provisionUser(CLERK_ID, "first@example.com");
    const second = await provisionUser(CLERK_ID, "first@example.com");

    expect(second.id).toBe(first.id);
    expect(await rowsFor(CLERK_ID)).toHaveLength(1);
  });

  it("does not duplicate when two requests race the first sign-in", async () => {
    // Two tabs, one cold account — the reason this is an upsert and not a
    // select-then-insert. Both callers must come back with the same row.
    const [a, b] = await Promise.all([
      provisionUser(CLERK_ID, "first@example.com"),
      provisionUser(CLERK_ID, "first@example.com"),
    ]);

    expect(a.id).toBe(b.id);
    expect(await rowsFor(CLERK_ID)).toHaveLength(1);
  });
});

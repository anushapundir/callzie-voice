import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  One test, for one hazard: `extractions.call_id` references `calls`, so a
  fixture that grew an extraction row can no longer be torn down by a cleanup
  that deletes calls first. The failure lands in whichever test file runs next,
  which is the worst possible place for it to be reported.
*/

const CLERK_ID = "user_test_tools_testing";

// Before as well as after: this is the file most likely to leave a fixture
// behind, because the thing it tests is the teardown itself.
beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

it("tears down a fixture that has an extraction row", async () => {
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-08-20T09:00:00.000Z"),
  });

  await db
    .insert(schema.extractions)
    .values({ callId: seed.callId, summary: "Anything." });

  await cleanupToolTest(CLERK_ID);

  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  expect(user).toBeUndefined();
});

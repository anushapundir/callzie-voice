import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Without this file, lib/tools/book-slot.test.ts's "second booking refused" could
  be passing for the wrong reason — because the application happens to order its
  own writes — and it would keep passing if someone dropped the index.

  So this file DROPS `tool_invocations_one_booking_per_call` and restores it,
  the same technique lib/availability/book.test.ts uses on
  `appointments_no_overlap`, and safe for the same reason: the database is local
  and disposable, and vitest.globalSetup.ts re-migrates it on every run. Never
  point this suite at Cloud SQL.

  It relies on `fileParallelism: false` in vitest.config.mts. No other file may
  observe the index missing.
*/

const CLERK_ID = "user_test_tools_one_booking";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const INDEX = "tool_invocations_one_booking_per_call";

let seed: ToolTestSeed;
let context: ToolContext;

async function indexExists(): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM pg_class WHERE relname = ${INDEX} AND relkind = 'i'`,
  );
  return result.rows.length > 0;
}

async function restoreIndex() {
  if (await indexExists()) return;
  await db.execute(sql`
    CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"
      ON "tool_invocations" ("call_id")
      WHERE "tool_name" = 'book_slot' AND "succeeded"
  `);
}

/** A book_slot that always succeeds, so only the index can refuse it. */
function commitABooking() {
  return runTool({
    name: "book_slot",
    args: {},
    context,
    handler: async () => ({ succeeded: true, result: { ok: true } }),
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  // Restore before the next file runs, whatever happened above.
  await restoreIndex();
});

describe("the index, not the code, is what caps a Call at one Reschedule", () => {
  it("commits two Reschedules once the index is removed", async () => {
    expect(await indexExists()).toBe(true);

    await db.execute(sql`DROP INDEX "tool_invocations_one_booking_per_call"`);
    expect(await indexExists()).toBe(false);

    /*
      The defect, reproduced. Nothing in application code counts bookings, so
      with the index gone both succeed — which is what proves the test in
      lib/tools/book-slot.test.ts is testing the index rather than luck.
    */
    expect(await commitABooking()).toEqual({ ok: true });
    expect(await commitABooking()).toEqual({ ok: true });

    const bookings = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));
    expect(bookings.filter((r) => r.succeeded).length).toBeGreaterThan(1);
  });

  it("has the index back afterwards", async () => {
    // afterEach restores it. This asserts the restore actually works, so the
    // test above cannot silently disarm every later file.
    expect(await indexExists()).toBe(true);
    expect(await commitABooking()).toEqual({ ok: true });
    expect(await commitABooking()).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });
  });
});

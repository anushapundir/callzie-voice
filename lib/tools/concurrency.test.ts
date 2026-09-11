import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  A Tool must never take a second database connection while `runTool` is holding
  one.

  The pool in lib/db/index.ts holds five connections. If a handler reads through
  `db` instead of through its own transaction, then enough simultaneous Tool
  calls leave every connection held by a transaction that is waiting for another
  one — and none is ever released. Postgres sits idle and every request hangs
  until `connectionTimeoutMillis` gives up ten seconds later.

  Ten seconds is longer than a Tool's entire budget (lib/retell/tools.ts sets
  timeout_ms to 10,000), so on this path the deadlock is dead air on a live call
  — the failure ADR-0003 calls the most damaging available to a voice product.
  And it would not show up in any single-request test.

  SPEC.md §5 permits three concurrent Calls. This fires more than the pool holds,
  because the number that matters is the one that breaks it, not the one the
  spec allows.
*/

const CLERK_ID = "user_test_tools_concurrency";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");

/** Comfortably above `max: 5` in lib/db/index.ts. */
const SIMULTANEOUS = 8;

let seed: ToolTestSeed;
let context: ToolContext;

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
});

describe("Tools do not exhaust the connection pool", () => {
  it("answers more simultaneous check_availability calls than the pool holds", async () => {
    const results = (await Promise.all(
      Array.from({ length: SIMULTANEOUS }, () =>
        runTool({
          name: "check_availability",
          args: {},
          context,
          handler: checkAvailability,
          now: NOW,
        }),
      ),
    )) as { ok: boolean; slots: unknown[] }[];

    // Every one answered. Before the fix, all eight timed out together.
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.slots.length).toBeGreaterThan(0);
    }
  });

  it("answers simultaneous book_slot calls without hanging", async () => {
    const offered = (await runTool({
      name: "check_availability",
      args: {},
      context,
      handler: checkAvailability,
      now: NOW,
    })) as { slots: { slot_start: string }[] };

    const results = (await Promise.all(
      Array.from({ length: SIMULTANEOUS }, () =>
        runTool({
          name: "book_slot",
          args: { slot_start: offered.slots[0].slot_start },
          context,
          handler: bookSlotTool,
          now: NOW,
        }),
      ),
    )) as { ok: boolean; reason?: string }[];

    // Exactly one Reschedule commits per Call, and every loser gets an answer
    // rather than a timeout. `already_booked` is the one-booking index; the
    // others lost the same race a different way.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const lost of results.filter((r) => !r.ok)) {
      expect(lost.reason).toBeDefined();
      expect(lost.reason).not.toBe("error");
    }
  });
});

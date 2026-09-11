import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { ToolName } from "@/lib/db/schema";
import { hasCommittedOutcome } from "@/lib/tools/committed";
import { offeredSlotsInCall } from "@/lib/tools/offers";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_tools_offers";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

const NINE_AM = "2026-08-20T03:30:00.000Z";
const TWO_PM = "2026-08-20T08:30:00.000Z";

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

async function recordCheck(slots: string[], succeeded = true) {
  await db.insert(schema.toolInvocations).values({
    callId: seed.callId,
    toolName: "check_availability",
    arguments: {},
    result: {
      ok: true,
      slots: slots.map((slot_start) => ({ slot_start, time: "whenever" })),
    },
    succeeded,
    latencyMs: 4,
  });
}

function offered() {
  return db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
}

describe("offeredSlotsInCall", () => {
  it("is empty before anything has been offered", async () => {
    expect((await offered()).size).toBe(0);
  });

  it("collects every Slot from every check in the Call", async () => {
    // Offers are unlimited (SPEC.md §7). A time offered in turn two is still
    // bookable in turn nine, because people say "actually, the first one".
    await recordCheck([NINE_AM]);
    await recordCheck([TWO_PM]);

    expect([...(await offered())].sort()).toEqual([NINE_AM, TWO_PM].sort());
  });

  it("ignores checks that failed", async () => {
    await recordCheck([NINE_AM], false);
    expect((await offered()).size).toBe(0);
  });

  it("ignores rows from other Tools", async () => {
    // A slot_start that appears only as a book_slot argument was never offered —
    // otherwise a refused booking would authorise the next attempt at it.
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "book_slot",
      arguments: { slot_start: NINE_AM },
      result: { ok: true },
      succeeded: true,
      latencyMs: 4,
    });

    expect((await offered()).size).toBe(0);
  });

  it("survives a result that is not shaped like a list of Slots", async () => {
    // The column is jsonb. Anything could be in an old row, and this must not be
    // the thing that throws mid-call.
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "check_availability",
      arguments: {},
      result: { ok: false, reason: "error" },
      succeeded: true,
      latencyMs: 4,
    });

    expect((await offered()).size).toBe(0);
  });

  it("skips a malformed entry without losing its siblings", async () => {
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "check_availability",
      arguments: {},
      result: { ok: true, slots: [{ slot_start: NINE_AM }, { time: "no start" }, null] },
      succeeded: true,
      latencyMs: 4,
    });

    expect([...(await offered())]).toEqual([NINE_AM]);
  });
});

describe("hasCommittedOutcome", () => {
  /** Write a `tool_invocations` row directly, as a Tool call would. */
  async function record(toolName: ToolName, succeeded: boolean) {
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName,
      arguments: {},
      result: { ok: succeeded },
      succeeded,
      latencyMs: 2,
    });
  }

  it("is false before anything has happened", async () => {
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it("is false for a check, which commits nothing", async () => {
    // A successful check_availability is a question with an answer, not an
    // outcome. This distinction is the whole point of the module.
    await record("check_availability", true);
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it("is false for a booking that failed", async () => {
    await record("book_slot", false);
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it.each(["book_slot", "confirm_appointment", "cancel_appointment"] as const)(
    "is true after a successful %s",
    async (toolName) => {
      await record(toolName, true);
      expect(await hasCommittedOutcome(db, seed.callId)).toBe(true);
    },
  );

  it("does not see another Call's outcome", async () => {
    await record("book_slot", true);
    expect(
      await hasCommittedOutcome(db, "00000000-0000-0000-0000-000000000000"),
    ).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { MAX_OFFERS, checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criterion 2: check_availability never returns a Slot outside
  Business Hours or in the past.
*/

const CLERK_ID = "user_test_tools_check_availability";

// The Appointment under discussion: 09:00 Asia/Kolkata, Monday 2026-08-17.
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
// "Now" is 08:00 Asia/Kolkata that Monday — an hour before the Business opens.
const NOW = new Date("2026-08-17T02:30:00.000Z");

// 03:30 UTC = 09:00 IST (opening). 10:30 UTC = 16:00 IST, the last start a
// 60-minute Slot can have before a 17:00 close.
const FIRST_START_MINUTES = 3 * 60 + 30;
const LAST_START_MINUTES = 10 * 60 + 30;

let seed: ToolTestSeed;
let context: ToolContext;

type CheckResult = { ok: boolean; slots: { slot_start: string; time: string }[] };

async function offer(now = NOW): Promise<CheckResult> {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now,
  })) as CheckResult;
}

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("checkAvailability", () => {
  beforeEach(async () => {
    await cleanupToolTest(CLERK_ID);
    seed = await seedToolTest({
      clerkId: CLERK_ID,
      appointmentStartsAt: APPOINTMENT_STARTS_AT,
    });
    context = (await resolveToolContext(seed.retellCallId))!;
  });

  it("returns at most three Slots", async () => {
    // SPEC.md §7: "up to 3 open Slots". More is not more helpful down a phone
    // line — nobody holds five times in their head.
    const result = await offer();
    expect(result.ok).toBe(true);
    expect(result.slots).toHaveLength(MAX_OFFERS);
  });

  it("gives each Slot a token and a spoken time", async () => {
    const [first] = (await offer()).slots;

    // 10:00 Asia/Kolkata: 09:00 is held by the Appointment this Call is about.
    expect(first.slot_start).toBe("2026-08-17T04:30:00.000Z");
    expect(first.time).toBe("Monday 17 August at 10:00 AM");
  });

  it("never offers the Slot the Appointment already holds", async () => {
    const starts = (await offer()).slots.map((s) => s.slot_start);
    expect(starts).not.toContain(APPOINTMENT_STARTS_AT.toISOString());
  });

  it("never offers a Slot in the past", async () => {
    // Midday Monday. Everything before it is gone.
    const noon = new Date("2026-08-17T06:30:00.000Z");
    const slots = (await offer(noon)).slots;
    expect(slots.length).toBeGreaterThan(0);

    for (const slot of slots) {
      expect(new Date(slot.slot_start).getTime()).toBeGreaterThanOrEqual(noon.getTime());
    }
  });

  it("never offers a Slot outside Business Hours", async () => {
    // SPEC.md §14 rule 1, and the reason it is enforced in the Tool rather than
    // asked of the prompt.
    for (const slot of (await offer()).slots) {
      const at = new Date(slot.slot_start);
      const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
      expect(minutes).toBeGreaterThanOrEqual(FIRST_START_MINUTES);
      expect(minutes).toBeLessThanOrEqual(LAST_START_MINUTES);
    }
  });

  it("returns Slots in ascending order", async () => {
    // Maya reads them out in the order they arrive, so the order is part of the
    // answer rather than an accident of the query.
    const starts = (await offer()).slots.map((s) => new Date(s.slot_start).getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("never offers a time it has already offered on this Call", async () => {
    // SPEC.md §7: "If they reject them, ask what would suit and call
    // check_availability again." Repeating the same three times is not asking
    // again — it is asking the same question louder.
    const first = await offer();
    const second = await offer();

    const alreadySaid = first.slots.map((s) => s.slot_start);
    for (const slot of second.slots) {
      expect(alreadySaid).not.toContain(slot.slot_start);
    }
  });

  it("carries on from where the last round stopped", async () => {
    // 09:00 is held by the Appointment this Call is about, and the Business
    // closes at 17:00, so Monday's open Slots run 10:00 to 16:00.
    const first = await offer();
    const second = await offer();

    expect(first.slots.map((s) => s.time)).toEqual([
      "Monday 17 August at 10:00 AM",
      "Monday 17 August at 11:00 AM",
      "Monday 17 August at 12:00 PM",
    ]);
    expect(second.slots.map((s) => s.time)).toEqual([
      "Monday 17 August at 1:00 PM",
      "Monday 17 August at 2:00 PM",
      "Monday 17 August at 3:00 PM",
    ]);
  });

  it("still offers a Slot that only a failed check ever named", async () => {
    // A check that failed offered nothing, whatever is in its result — the same
    // rule lib/tools/offers.ts states for book_slot. Narrowing the next round
    // because of a row nobody heard would silently shrink the conversation.
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "check_availability",
      arguments: {},
      result: {
        ok: true,
        slots: [{ slot_start: "2026-08-17T04:30:00.000Z", time: "x" }],
      },
      succeeded: false,
      latencyMs: 1,
    });

    const starts = (await offer()).slots.map((s) => s.slot_start);
    expect(starts).toContain("2026-08-17T04:30:00.000Z");
  });

  it("records preferred_time without acting on it", async () => {
    await runTool({
      name: "check_availability",
      args: { preferred_time: "Thursday afternoon" },
      context,
      handler: checkAvailability,
      now: NOW,
    });

    const [row] = await db.select().from(schema.toolInvocations);
    // Recorded so we can see the phrases people really use before writing a
    // parser for them. Deliberately not honoured yet — see the design doc.
    expect(row.arguments).toEqual({ preferred_time: "Thursday afternoon" });
    expect(row.succeeded).toBe(true);
  });
});

describe("checkAvailability when the Business is never open", () => {
  beforeEach(async () => {
    await cleanupToolTest(CLERK_ID);
    seed = await seedToolTest({
      clerkId: CLERK_ID,
      appointmentStartsAt: APPOINTMENT_STARTS_AT,
      hours: [],
    });
    context = (await resolveToolContext(seed.retellCallId))!;
  });

  it("returns an empty list, not a failure", async () => {
    // A fortnight with nothing open is something Maya should say, not something
    // that should read to her as a broken Tool.
    expect(await offer()).toEqual({
      ok: true,
      slots: [],
      // SPEC.md §7's prompt has no branch for "nothing open", so an unguided
      // model improvises one. The endpoint supplies the words instead.
      say: NOT_COMMITTED.nothingOpen,
    });

    const [row] = await db.select().from(schema.toolInvocations);
    expect(row.succeeded).toBe(true);
  });
});

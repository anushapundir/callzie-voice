import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criteria 5 and 6: every invocation is recorded with its arguments,
  result and success flag, and latency is measured.

  The handlers here are stubs. What is under test is the wrapper — the
  transaction, the record, and the one-booking index. The real handlers have
  their own files.
*/

const CLERK_ID = "user_test_tools_run";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

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

function invocations() {
  return db
    .select()
    .from(schema.toolInvocations)
    .where(eq(schema.toolInvocations.callId, seed.callId));
}

describe("runTool", () => {
  it("records the arguments, the result and the success flag", async () => {
    const result = await runTool({
      name: "check_availability",
      args: { preferred_time: "Thursday afternoon" },
      context,
      handler: async () => ({ succeeded: true, result: { ok: true, slots: [] } }),
    });

    expect(result).toEqual({ ok: true, slots: [] });

    const [row] = await invocations();
    expect(row.toolName).toBe("check_availability");
    expect(row.arguments).toEqual({ preferred_time: "Thursday afternoon" });
    expect(row.result).toEqual({ ok: true, slots: [] });
    expect(row.succeeded).toBe(true);
  });

  it("measures latency", async () => {
    await runTool({
      name: "confirm_appointment",
      args: {},
      context,
      handler: async () => ({ succeeded: true, result: { ok: true } }),
    });

    const [row] = await invocations();
    // A slow Tool is dead air on a live call (issue #10), so the number has to
    // exist before anyone can argue about what it should be.
    expect(row.latencyMs).toBeTypeOf("number");
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row.latencyMs)).toBe(true);
  });

  it("records a refusal, not just a success", async () => {
    await runTool({
      name: "book_slot",
      args: { slot_start: "2026-08-20T08:30:00.000Z" },
      context,
      handler: async () => ({
        succeeded: false,
        result: { ok: false, reason: "not_offered" },
      }),
    });

    const [row] = await invocations();
    expect(row.succeeded).toBe(false);
    expect(row.result).toEqual({ ok: false, reason: "not_offered" });
  });

  it("records a handler that threw, and does not rethrow", async () => {
    // SPEC.md §3 rule 7: Maya must never claim a booking succeeded when the Tool
    // failed. A thrown error reaching Retell as a 500 tells her nothing; a body
    // saying ok:false tells her what to say.
    const result = await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async () => {
        throw new Error("the database went away");
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "error",
      // The tool was book_slot, so this is a callback promise rather than the
      // vaguer line.
      say: NOT_COMMITTED.bookFailed,
    });

    const [row] = await invocations();
    expect(row.succeeded).toBe(false);
  });

  it("rolls back the handler's writes when it throws, but keeps the record", async () => {
    await runTool({
      name: "cancel_appointment",
      args: {},
      context,
      handler: async ({ tx }) => {
        await tx
          .update(schema.appointments)
          .set({ status: "cancelled" })
          .where(eq(schema.appointments.id, seed.appointmentId));
        throw new Error("changed my mind");
      },
    });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    // The write is gone...
    expect(appointment!.status).toBe("calling");
    // ...but the record of the attempt is not. It is written on a fresh
    // connection, outside the rolled-back transaction.
    expect(await invocations()).toHaveLength(1);
  });

  it("refuses a second successful book_slot in the same Call", async () => {
    const booking = () =>
      runTool({
        name: "book_slot",
        args: { slot_start: "2026-08-20T08:30:00.000Z" },
        context,
        handler: async ({ tx }) => {
          await tx
            .update(schema.appointments)
            .set({ status: "rescheduled" })
            .where(eq(schema.appointments.id, seed.appointmentId));
          return { succeeded: true, result: { ok: true } };
        },
      });

    expect(await booking()).toEqual({ ok: true });
    expect(await booking()).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });

    const rows = await invocations();
    expect(rows.filter((r) => r.succeeded)).toHaveLength(1);
    expect(rows.filter((r) => !r.succeeded)).toHaveLength(1);
  });

  it("stays vague when a Tool that was not booking anything blows up", async () => {
    const result = await runTool({
      name: "check_availability",
      args: {},
      context,
      handler: async () => {
        throw new Error("the database went away");
      },
    });

    // Promising a callback about a failed availability check would promise the
    // wrong thing.
    expect(result).toEqual({
      ok: false,
      reason: "error",
      say: NOT_COMMITTED.wentWrong,
    });
  });

  it("undoes the second booking's write along with its record", async () => {
    // The claim the whole design rests on: the Appointment cannot be moved by a
    // booking whose record the index refused.
    await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async () => ({ succeeded: true, result: { ok: true } }),
    });

    await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async ({ tx }) => {
        await tx
          .update(schema.appointments)
          .set({ status: "cancelled" })
          .where(eq(schema.appointments.id, seed.appointmentId));
        return { succeeded: true, result: { ok: true } };
      },
    });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("calling");
  });

  it("still allows further check_availability calls after a booking", async () => {
    await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async () => ({ succeeded: true, result: { ok: true } }),
    });

    // Offers are unlimited; the 120s cap is the backstop, not a turn limit
    // (SPEC.md §7).
    for (let i = 0; i < 3; i++) {
      expect(
        await runTool({
          name: "check_availability",
          args: {},
          context,
          handler: async () => ({ succeeded: true, result: { ok: true, slots: [] } }),
        }),
      ).toEqual({ ok: true, slots: [] });
    }

    const checks = (await invocations()).filter(
      (r) => r.toolName === "check_availability",
    );
    expect(checks).toHaveLength(3);
  });

  it("allows any number of failed book_slot attempts", async () => {
    // SPEC.md §8 retries once, and every lost race has to be recordable.
    for (let i = 0; i < 3; i++) {
      await runTool({
        name: "book_slot",
        args: {},
        context,
        handler: async () => ({
          succeeded: false,
          result: { ok: false, reason: "slot_taken" },
        }),
      });
    }

    const bookings = (await invocations()).filter((r) => r.toolName === "book_slot");
    expect(bookings).toHaveLength(3);
  });
});

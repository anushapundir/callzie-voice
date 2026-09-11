import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criteria 3 and 4: booking into an occupied Slot fails cleanly and
  does not corrupt the Appointment; a second book_slot in the same Call is
  refused, while further check_availability calls are not.
*/

const CLERK_ID = "user_test_tools_book_slot";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");
const HOUR_MS = 60 * 60_000;

/*
  13:00 Asia/Kolkata on the same Monday: a real, open, in-hours Slot that
  check_availability never names, because the three it returns are 10:00, 11:00
  and 12:00 — 09:00 being held by the Appointment this Call is about.

  That combination is the point. A time refused here is refused for one reason
  only: nobody offered it.
*/
const OPEN_BUT_NEVER_OFFERED = "2026-08-17T07:30:00.000Z";

let seed: ToolTestSeed;
let context: ToolContext;

type CheckResult = { ok: boolean; slots: { slot_start: string; time: string }[] };
type BookResult = {
  ok: boolean;
  booked_time?: string;
  reason?: string;
  say?: string;
};

async function check(): Promise<CheckResult> {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now: NOW,
  })) as CheckResult;
}

async function book(slotStart: unknown, now = NOW): Promise<BookResult> {
  return (await runTool({
    name: "book_slot",
    args: { slot_start: slotStart },
    context,
    handler: bookSlotTool,
    now,
  })) as BookResult;
}

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

function invocations() {
  return db
    .select()
    .from(schema.toolInvocations)
    .where(eq(schema.toolInvocations.callId, seed.callId));
}

/** Park a competing Appointment on a Slot, as a concurrent Call would. */
async function occupy(slotStart: string) {
  await db.insert(schema.appointments).values({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    name: "Faster Caller",
    phoneE164: "+919876500002",
    startsAt: new Date(slotStart),
    endsAt: new Date(new Date(slotStart).getTime() + HOUR_MS),
    status: "confirmed",
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
});

describe("bookSlotTool", () => {
  it("commits the Reschedule for a Slot it offered", async () => {
    const [first] = (await check()).slots;

    const result = await book(first.slot_start);

    expect(result.ok).toBe(true);
    expect(result.booked_time).toBe(first.time);

    const moved = await appointment();
    expect(moved!.startsAt.toISOString()).toBe(first.slot_start);
    expect(moved!.endsAt.getTime()).toBe(new Date(first.slot_start).getTime() + HOUR_MS);
    expect(moved!.status).toBe("rescheduled");
  });

  it("accepts the same instant written a different way", async () => {
    // The model is told to copy slot_start exactly, and usually will. Refusing a
    // booking the customer just agreed to over "+00:00" versus "Z" would be the
    // wrong way to be strict — what matters is that we named this instant.
    const [first] = (await check()).slots;
    const sameMoment = first.slot_start.replace("Z", "+00:00");

    expect((await book(sameMoment)).ok).toBe(true);
  });

  it("refuses a time it never offered, however valid that time is", async () => {
    // The rule that makes slot_start a token rather than a datetime the model
    // composes. 13:00 Monday is a genuinely open Slot inside Business Hours —
    // it was simply never named in this Call.
    const offers = (await check()).slots.map((s) => s.slot_start);
    expect(offers).not.toContain(OPEN_BUT_NEVER_OFFERED);

    expect(await book(OPEN_BUT_NEVER_OFFERED)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
    expect((await appointment())!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("refuses a Slot offered on some other Call", async () => {
    // The lookup is scoped to this Call. A Slot named to somebody else is not an
    // Offer to this person.
    const otherClerk = `${CLERK_ID}_other`;
    await cleanupToolTest(otherClerk);
    const other = await seedToolTest({
      clerkId: otherClerk,
      appointmentStartsAt: new Date("2026-08-18T03:30:00.000Z"),
    });
    await db.insert(schema.toolInvocations).values({
      callId: other.callId,
      toolName: "check_availability",
      arguments: {},
      result: {
        ok: true,
        slots: [
          { slot_start: OPEN_BUT_NEVER_OFFERED, time: "Monday 17 August at 1:00 PM" },
        ],
      },
      succeeded: true,
      latencyMs: 3,
    });

    expect(await book(OPEN_BUT_NEVER_OFFERED)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });

    await cleanupToolTest(otherClerk);
  });

  it.each([
    ["prose", "next Tuesday-ish"],
    ["an empty string", ""],
    ["a number", 1_755_000_000_000],
    ["nothing at all", undefined],
  ])("refuses %s as a slot_start", async (_label, value) => {
    expect(await book(value)).toEqual({
      ok: false,
      reason: "invalid_time",
      say: NOT_COMMITTED.notAvailable,
    });
  });

  it("refuses an offered Slot that has since passed", async () => {
    const [first] = (await check()).slots;

    // The same Slot, asked for an hour after it started. Offers are unlimited
    // and a negotiation takes time; the world moves underneath one.
    const later = new Date(new Date(first.slot_start).getTime() + HOUR_MS);
    expect(await book(first.slot_start, later)).toEqual({
      ok: false,
      reason: "in_the_past",
      say: NOT_COMMITTED.notAvailable,
    });
  });

  it("refuses an offered Slot the Business has since closed", async () => {
    // Business Hours can be edited in Settings mid-Call, which is why check 3
    // is not redundant after check 2.
    const [first] = (await check()).slots;

    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, seed.businessId));

    expect(await book(first.slot_start)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
  });

  it("fails cleanly when another Call took the Slot first", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);

    expect(await book(first.slot_start)).toEqual({
      ok: false,
      reason: "slot_taken",
      // SPEC.md §8 step 2: a callback, never a claim.
      say: NOT_COMMITTED.bookFailed,
    });

    const untouched = await appointment();
    // SPEC.md §8 step 3: the Appointment keeps its original Slot...
    expect(untouched!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    expect(untouched!.status).toBe("calling");
    // ...and a human is asked to look at it.
    expect(untouched!.needsAttentionReason).toBe("book_failed");
  });

  it("records the failed booking with its arguments and latency", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);
    await book(first.slot_start);

    const booking = (await invocations()).find((r) => r.toolName === "book_slot");
    expect(booking).toBeDefined();
    expect(booking!.succeeded).toBe(false);
    expect(booking!.arguments).toEqual({ slot_start: first.slot_start });
    expect(booking!.result).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
    expect(booking!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses a second booking while still answering check_availability", async () => {
    const offers = (await check()).slots;

    expect((await book(offers[0].slot_start)).ok).toBe(true);

    // Offers stay unlimited after a Reschedule commits — the 120s cap is the
    // backstop, not a turn limit (SPEC.md §7).
    const second = await check();
    expect(second.ok).toBe(true);
    expect(second.slots.length).toBeGreaterThan(0);

    expect(await book(second.slots[0].slot_start)).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });

    // And the first booking stands, untouched by the refusal.
    expect((await appointment())!.startsAt.toISOString()).toBe(offers[0].slot_start);
    expect((await appointment())!.status).toBe("rescheduled");
  });

  it("leaves exactly one successful book_slot on the record", async () => {
    const offers = (await check()).slots;
    await book(offers[0].slot_start);
    await book((await check()).slots[0].slot_start);

    const bookings = (await invocations()).filter((r) => r.toolName === "book_slot");
    expect(bookings.filter((r) => r.succeeded)).toHaveLength(1);
    expect(bookings.filter((r) => !r.succeeded)).toHaveLength(1);
  });

  it("hands Maya the booked time to read back", async () => {
    // SPEC.md §7 step 3: "call book_slot and read the booked time back to them."
    const [first] = (await check()).slots;

    const result = await book(first.slot_start);

    expect(result.say).toBe(COMMITTED.booked(first.time));
    expect(result.say).toContain(first.time);
  });

  it("never claims success for a Reschedule that did not happen", async () => {
    // SPEC.md §3 rule 7 and §14 rule 4, as one assertion. Every refusal path is
    // driven, and in each the response and the row have to agree.
    const [first] = (await check()).slots;
    await occupy(first.slot_start);

    const outcomes = [
      await book("not a time"),
      await book(OPEN_BUT_NEVER_OFFERED),
      await book(first.slot_start),
    ];

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.booked_time).toBeUndefined();
    }

    const moved = await appointment();
    expect(moved!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });
});

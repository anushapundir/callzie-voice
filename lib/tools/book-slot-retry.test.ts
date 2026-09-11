import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { db, schema } from "@/lib/db";
import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  SPEC.md §8 step 1: "Retry once, silently." Two attempts, not two retries, and
  one answer to the customer.

  This lives in its own file because `vi.mock` is hoisted to the top of whichever
  file it appears in. Putting it in book-slot.test.ts would replace the module
  for eleven tests that want the real one.

  The spy wraps the real function rather than replacing it, so every assertion
  about the database below is still about real behaviour. All this file adds is a
  count.
*/
vi.mock("@/lib/appointments/reschedule", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/appointments/reschedule")>();
  return { ...actual, rescheduleAppointment: vi.fn(actual.rescheduleAppointment) };
});

const CLERK_ID = "user_test_tools_book_retry";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");
const HOUR_MS = 60 * 60_000;

/** 13:00 Asia/Kolkata — open, in hours, and never among the three she is given. */
const OPEN_BUT_NEVER_OFFERED = "2026-08-17T07:30:00.000Z";

let seed: ToolTestSeed;
let context: ToolContext;

const attempts = vi.mocked(rescheduleAppointment);

async function check(): Promise<{ slots: { slot_start: string; time: string }[] }> {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now: NOW,
  })) as { slots: { slot_start: string; time: string }[] };
}

async function book(slotStart: string) {
  return (await runTool({
    name: "book_slot",
    args: { slot_start: slotStart },
    context,
    handler: bookSlotTool,
    now: NOW,
  })) as { ok: boolean; reason?: string; say?: string };
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
  attempts.mockClear();
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

describe("SPEC.md §8's silent retry", () => {
  it("tries twice before giving up", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);

    const result = await book(first.slot_start);

    expect(attempts).toHaveBeenCalledTimes(2);
    // One answer, not two. The retry is silent to the person on the phone.
    expect(result).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
  });

  it("does not retry a booking that worked", async () => {
    const [first] = (await check()).slots;

    expect((await book(first.slot_start)).ok).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it("does not reach the database at all for a time nobody offered", async () => {
    // The three cheap checks run first, in order. A hallucinated time never
    // becomes an attempted write.
    expect((await book(OPEN_BUT_NEVER_OFFERED)).reason).toBe("not_offered");
    expect(attempts).not.toHaveBeenCalled();
  });

  it("leaves the Appointment where it was after both attempts fail", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);
    await book(first.slot_start);

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    expect(appointment!.needsAttentionReason).toBe("book_failed");
  });
});

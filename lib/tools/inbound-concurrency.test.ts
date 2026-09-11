import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { bookAppointmentTool } from "@/lib/tools/book-appointment";
import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { inboundCheckAvailability } from "@/lib/tools/inbound-check-availability";
import {
  resolveInboundToolContext,
  resolveToolContext,
  type InboundToolContext,
  type ToolContext,
} from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import {
  cleanupToolTest,
  seedInboundCall,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  Two writers, one Slot (issue #43).

  SPEC.md §3 rule 8: "Slot uniqueness is a database constraint, not application
  logic. Three concurrent Agents will find any gap between a check and a write."
  M1's concurrency test proved that for two Reschedules. Inbound adds a *second
  kind* of writer — `book_appointment` INSERTs where `book_slot` UPDATEs — and
  this proves `appointments_no_overlap` still settles it.

  It is not a new problem, and that is exactly the claim being tested. The
  constraint is an EXCLUDE over `tstzrange(starts_at, ends_at)` per Business, so
  it does not care which statement produced the range. If that were ever weakened
  to something insert-shaped or update-shaped, this is the test that notices.

  The loser must fail *cleanly*: no row, and a sentence that promises a callback
  rather than claiming a booking (SPEC.md §3 rule 7).
*/

const CLERK_ID = "user_test_inbound_concurrency";
const NOW = new Date("2026-09-07T16:00:00.000Z");
const CALLER = "+12025550142";

let seed: ToolTestSeed;
let inboundContext: InboundToolContext;
let outboundContext: ToolContext;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });

  const inbound = await seedInboundCall({
    businessId: seed.businessId,
    retellCallId: `call_${CLERK_ID}_inbound`,
    fromNumber: CALLER,
  });

  const resolvedInbound = await resolveInboundToolContext(inbound.retellCallId);
  const resolvedOutbound = await resolveToolContext(seed.retellCallId);
  if (!resolvedInbound || !resolvedOutbound) throw new Error("contexts");

  inboundContext = resolvedInbound;
  outboundContext = resolvedOutbound;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

/**
 * One Slot both Calls have been offered.
 *
 * Each Tool refuses a time its own Call never named (ADR-0011), so the race can
 * only be set up by offering the same instant to both — which is itself the
 * realistic situation: two people on the phone at once, hearing the same gap.
 */
async function slotOfferedToBoth(): Promise<string> {
  const inboundOffer = (await runTool({
    name: "check_availability",
    args: { service_name: "Haircut" },
    context: inboundContext,
    handler: inboundCheckAvailability,
    now: NOW,
  })) as { slots: { slot_start: string }[] };

  const outboundOffer = (await runTool({
    name: "check_availability",
    args: {},
    context: outboundContext,
    handler: checkAvailability,
    now: NOW,
  })) as { slots: { slot_start: string }[] };

  const shared = inboundOffer.slots
    .map((s) => s.slot_start)
    .find((s) => outboundOffer.slots.some((o) => o.slot_start === s));

  if (!shared) throw new Error("the two Calls were offered no time in common");
  return shared;
}

function bookInbound(slotStart: string) {
  return runTool({
    name: "book_appointment",
    args: {
      slot_start: slotStart,
      caller_name: "Rahul Verma",
      callback_number: CALLER,
      service_name: "Haircut",
    },
    context: inboundContext,
    handler: bookAppointmentTool,
    now: NOW,
  });
}

function bookOutbound(slotStart: string) {
  return runTool({
    name: "book_slot",
    args: { slot_start: slotStart },
    context: outboundContext,
    handler: bookSlotTool,
    now: NOW,
  });
}

type Outcome = { ok: boolean; say?: string; reason?: string };

/** Every Appointment now holding this instant. */
async function holdersOf(slotStart: string) {
  return db
    .select({ id: schema.appointments.id, name: schema.appointments.name })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, seed.businessId),
        eq(schema.appointments.startsAt, new Date(slotStart)),
        ne(schema.appointments.status, "cancelled"),
        ne(schema.appointments.status, "declined"),
      ),
    );
}

describe("an inbound booking racing an outbound Reschedule", () => {
  it("lets exactly one of them have the Slot", async () => {
    const slotStart = await slotOfferedToBoth();

    // Started together, settled by Postgres. Not sequenced by the test — the
    // point is that nothing in the application decides who wins.
    const [inbound, outbound] = (await Promise.all([
      bookInbound(slotStart),
      bookOutbound(slotStart),
    ])) as [Outcome, Outcome];

    const winners = [inbound, outbound].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    expect(await holdersOf(slotStart)).toHaveLength(1);
  });

  it("never tells the loser a booking happened", async () => {
    /*
      SPEC.md §3 rule 7 and §14 rule 4 — the most damaging failure available to
      this product. The loser's whole response has to read as a failure: the
      model composes speech from it, and it must not be able to read any field
      here as success.
    */
    const slotStart = await slotOfferedToBoth();

    const [inbound, outbound] = (await Promise.all([
      bookInbound(slotStart),
      bookOutbound(slotStart),
    ])) as [Outcome, Outcome];

    const loser = inbound.ok ? outbound : inbound;

    expect(loser.ok).toBe(false);
    expect(loser).not.toHaveProperty("booked_time");
    expect(loser.say ?? "").toMatch(/call you back|isn't available/i);
    expect(loser.say ?? "").not.toMatch(/booked in|all set|locked in/i);
  });

  it("leaves no half-written Appointment when the inbound side loses", async () => {
    /*
      The asymmetry worth testing. `book_slot` UPDATEs a row that already
      exists, so losing changes nothing. `book_appointment` INSERTs — so if its
      transaction did not roll back cleanly, the loser would leave a stranger's
      Appointment behind holding a Slot somebody else already has.
    */
    const slotStart = await slotOfferedToBoth();

    // Outbound goes first and wins outright, so the inbound insert is certain
    // to be the one refused.
    const outbound = (await bookOutbound(slotStart)) as Outcome;
    expect(outbound.ok).toBe(true);

    const inbound = (await bookInbound(slotStart)) as Outcome;
    expect(inbound.ok).toBe(false);

    const created = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.name, "Rahul Verma"));

    expect(created).toHaveLength(0);
    expect(await holdersOf(slotStart)).toHaveLength(1);
  });

  it("records the lost race, so the Call is not a blank", async () => {
    // `tool_invocations` is the authoritative record of what the Agent did
    // (SPEC.md §9 step 3). A failed booking that recorded nothing would render
    // as a Call in which Maya apparently did nothing at all.
    const slotStart = await slotOfferedToBoth();

    await bookOutbound(slotStart);
    await bookInbound(slotStart);

    const invocations = await db
      .select()
      .from(schema.toolInvocations)
      .where(
        and(
          eq(schema.toolInvocations.callId, inboundContext.callId),
          eq(schema.toolInvocations.toolName, "book_appointment"),
        ),
      );

    expect(invocations).toHaveLength(1);
    expect(invocations[0].succeeded).toBe(false);
  });

  it("leaves the caller a callback Enquiry rather than nothing", async () => {
    /*
      There is no Appointment to flag `book_failed` on — the whole point is that
      one was never created — so the Enquiry is the equivalent record, and it is
      left unresolved so somebody rings them back.
    */
    const slotStart = await slotOfferedToBoth();

    await bookOutbound(slotStart);
    await bookInbound(slotStart);

    const enquiry = await db.query.enquiries.findFirst({
      where: eq(schema.enquiries.callId, inboundContext.callId),
    });

    expect(enquiry?.kind).toBe("callback");
    expect(enquiry?.resolved).toBe(false);
    expect(enquiry?.callerPhoneE164).toBe(CALLER);
  });
});

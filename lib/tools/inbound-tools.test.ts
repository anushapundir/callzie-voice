import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { bookAppointmentTool } from "@/lib/tools/book-appointment";
import { inboundCheckAvailability } from "@/lib/tools/inbound-check-availability";
import { logEnquiryTool } from "@/lib/tools/log-enquiry";
import { lookupAppointmentTool } from "@/lib/tools/lookup-appointment";
import { resolveInboundToolContext, type InboundToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import {
  cleanupToolTest,
  seedInboundCall,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The three inbound Tools, against a real database (issue #43).

  Asia/Kolkata, weekdays 09:00-17:00, one 60-minute "Haircut" Service — the
  fixture `seedToolTest` builds. The seeded Appointment sits on Mon 2026-09-14.

  These run through `runTool` rather than calling the handlers directly, because
  the transaction and the `tool_invocations` row are part of what is being
  tested: the one-new-booking index only bites when the record is written in the
  same transaction as the write it describes.
*/

const CLERK_ID = "user_test_inbound_tools";
const NOW = new Date("2026-09-07T16:00:00.000Z"); // Mon 21:30 local — closed
const CALLER = "+12025550142";

let seed: ToolTestSeed;
let context: InboundToolContext;

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

  const resolved = await resolveInboundToolContext(inbound.retellCallId);
  if (!resolved) throw new Error("inbound context did not resolve");
  context = resolved;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

async function offerATime(): Promise<string> {
  const result = (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: inboundCheckAvailability,
    now: NOW,
  })) as { slots: { slot_start: string }[] };

  return result.slots[0].slot_start;
}

function book(args: Record<string, unknown>) {
  return runTool({
    name: "book_appointment",
    args,
    context,
    handler: bookAppointmentTool,
    now: NOW,
  });
}

describe("resolveInboundToolContext", () => {
  it("refuses an outbound Call", async () => {
    /*
      The security half of the inbound/outbound split. Running `log_enquiry`
      against a confirmation Call would write an Enquiry about an Appointment
      Callzie itself rang up.
    */
    expect(await resolveInboundToolContext(seed.retellCallId)).toBeNull();
  });

  it("refuses a Call nobody has heard of", async () => {
    expect(await resolveInboundToolContext("call_does_not_exist")).toBeNull();
  });

  it("carries the caller's number, never an argument", async () => {
    expect(context.fromNumber).toBe(CALLER);
    expect(context.businessId).toBe(seed.businessId);
  });
});

describe("check_availability, inbound", () => {
  it("offers times sized by the Service the caller named", async () => {
    const result = (await runTool({
      name: "check_availability",
      args: { service_name: "Haircut" },
      context,
      handler: inboundCheckAvailability,
      now: NOW,
    })) as { ok: boolean; slots: unknown[]; service_name: string };

    expect(result.ok).toBe(true);
    expect(result.slots.length).toBeGreaterThan(0);
    // Echoed back so book_appointment carries it rather than re-guessing.
    expect(result.service_name).toBe("Haircut");
  });

  it("falls back to a Service when the caller has not said", async () => {
    const result = (await runTool({
      name: "check_availability",
      args: {},
      context,
      handler: inboundCheckAvailability,
      now: NOW,
    })) as { slots: unknown[] };

    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("never offers the same time twice in one Call", async () => {
    // SPEC.md §7's negotiation requires "call check_availability again" to mean
    // something. Repeating the same three times is asking the question louder.
    const first = await offerATime();
    const second = await offerATime();

    expect(second).not.toBe(first);
  });
});

describe("book_appointment", () => {
  it("creates a real Appointment the caller can be held to", async () => {
    const slotStart = await offerATime();

    const result = (await book({
      slot_start: slotStart,
      caller_name: "Rahul Verma",
      callback_number: CALLER,
      service_name: "Haircut",
    })) as { ok: boolean; booked_time: string; say: string };

    expect(result.ok).toBe(true);

    const created = await db.query.appointments.findFirst({
      where: and(
        eq(schema.appointments.businessId, seed.businessId),
        eq(schema.appointments.name, "Rahul Verma"),
      ),
    });

    expect(created).toBeDefined();
    expect(created?.startsAt.toISOString()).toBe(slotStart);
    // Confirmed, not pending: they agreed to it out loud thirty seconds ago,
    // and pending would queue them to be rung about a booking they just made.
    expect(created?.status).toBe("confirmed");
  });

  it("records the outcome as a booked Enquiry", async () => {
    const slotStart = await offerATime();
    await book({
      slot_start: slotStart,
      caller_name: "Rahul Verma",
      callback_number: CALLER,
      service_name: "Haircut",
    });

    const enquiry = await db.query.enquiries.findFirst({
      where: eq(schema.enquiries.callId, context.callId),
    });

    expect(enquiry?.kind).toBe("booked");
    // Nothing for a human to do — it is in the diary.
    expect(enquiry?.resolved).toBe(true);
    expect(enquiry?.appointmentId).toBeTruthy();
  });

  describe("SPEC.md §14 rule 11 — never books somebody unreachable", () => {
    it("refuses with no name", async () => {
      const result = (await book({
        slot_start: await offerATime(),
        callback_number: CALLER,
      })) as { ok: boolean; reason: string };

      expect(result).toMatchObject({ ok: false, reason: "missing_name" });
    });

    it("refuses with no number", async () => {
      const result = (await book({
        slot_start: await offerATime(),
        caller_name: "Rahul Verma",
      })) as { ok: boolean; reason: string };

      expect(result).toMatchObject({ ok: false, reason: "missing_number" });
    });

    it("refuses a number that is not a number", async () => {
      /*
        Present but unparseable is the case rule 11 really guards: it would look
        fine in the table and fail the moment anybody tried to ring it.
      */
      const result = (await book({
        slot_start: await offerATime(),
        caller_name: "Rahul Verma",
        callback_number: "call me on my mobile",
      })) as { ok: boolean; reason: string };

      expect(result).toMatchObject({ ok: false, reason: "invalid_number" });
    });

    it("writes nothing when it refuses", async () => {
      await book({ slot_start: await offerATime(), callback_number: CALLER });

      const [{ count }] = await db
        .select({ count: schema.appointments.id })
        .from(schema.appointments)
        .where(eq(schema.appointments.name, ""))
        .limit(1)
        .then((rows) => (rows.length ? [{ count: rows[0].count }] : [{ count: null }]));

      expect(count).toBeNull();
    });
  });

  describe("ADR-0011 — only a time we actually offered", () => {
    it("refuses a time this Call never named", async () => {
      // The opaque-token contract. Without it the model can compose any
      // datetime it likes and Callzie will book it.
      const result = (await book({
        slot_start: "2026-09-15T05:00:00.000Z",
        caller_name: "Rahul Verma",
        callback_number: CALLER,
      })) as { ok: boolean; reason: string };

      expect(result).toMatchObject({ ok: false, reason: "not_offered" });
    });

    it("refuses a time that is not a time", async () => {
      const result = (await book({
        slot_start: "next Tuesday-ish",
        caller_name: "Rahul Verma",
        callback_number: CALLER,
      })) as { ok: boolean; reason: string };

      expect(result).toMatchObject({ ok: false, reason: "invalid_time" });
    });
  });

  it("caps one Call at one booking", async () => {
    /*
      `tool_invocations_one_new_booking_per_call`. Without it a confused model —
      or a caller working through their whole family — takes any number of Slots
      on one call.
    */
    const first = await offerATime();
    const second = await offerATime();

    await book({
      slot_start: first,
      caller_name: "Rahul Verma",
      callback_number: CALLER,
      service_name: "Haircut",
    });

    const result = (await book({
      slot_start: second,
      caller_name: "Rahul Verma",
      callback_number: CALLER,
      service_name: "Haircut",
    })) as { ok: boolean; reason: string };

    expect(result).toMatchObject({ ok: false, reason: "already_booked" });

    const booked = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.name, "Rahul Verma"));

    expect(booked).toHaveLength(1);
  });
});

describe("lookup_appointment", () => {
  async function lookup() {
    return (await runTool({
      name: "lookup_appointment",
      args: {},
      context,
      handler: lookupAppointmentTool,
      now: NOW,
    })) as { ok: boolean; appointments: { service: string }[]; say?: string };
  }

  it("finds an Appointment held by the number that is calling", async () => {
    await db
      .update(schema.appointments)
      .set({ phoneE164: CALLER })
      .where(eq(schema.appointments.id, seed.appointmentId));

    const result = await lookup();

    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0].service).toBe("Haircut");
  });

  it("finds nothing for a number with no Appointments", async () => {
    // The seeded Appointment is held by a different number.
    const result = await lookup();

    expect(result.ok).toBe(true);
    expect(result.appointments).toHaveLength(0);
    expect(result.say).toContain("can't find an appointment");
  });

  it("never reads another Business's Appointment", async () => {
    /*
      The same number can hold bookings at two Businesses on Callzie. Hearing
      one's diary while ringing the other is a straightforward data leak.
    */
    const other = await seedToolTest({
      clerkId: `${CLERK_ID}_other`,
      appointmentStartsAt: new Date("2026-09-15T04:30:00.000Z"),
    });
    await db
      .update(schema.appointments)
      .set({ phoneE164: CALLER })
      .where(eq(schema.appointments.id, other.appointmentId));

    try {
      expect((await lookup()).appointments).toHaveLength(0);
    } finally {
      await cleanupToolTest(`${CLERK_ID}_other`);
    }
  });

  it("ignores a cancelled Appointment", async () => {
    // Reading a cancelled booking back would sound like it is still on.
    await db
      .update(schema.appointments)
      .set({ phoneE164: CALLER, status: "cancelled" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect((await lookup()).appointments).toHaveLength(0);
  });

  it("ignores an Appointment in the past", async () => {
    await db
      .update(schema.appointments)
      .set({
        phoneE164: CALLER,
        startsAt: new Date("2026-08-01T04:30:00.000Z"),
        endsAt: new Date("2026-08-01T05:30:00.000Z"),
      })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect((await lookup()).appointments).toHaveLength(0);
  });
});

describe("log_enquiry", () => {
  function log(args: Record<string, unknown>) {
    return runTool({
      name: "log_enquiry",
      args,
      context,
      handler: logEnquiryTool,
      now: NOW,
    });
  }

  async function stored() {
    return db.query.enquiries.findFirst({
      where: eq(schema.enquiries.callId, context.callId),
    });
  }

  it("leaves a complaint open for a human", async () => {
    await log({ kind: "complaint", topic: "Waited 40 minutes last visit." });

    const enquiry = await stored();
    expect(enquiry?.kind).toBe("complaint");
    expect(enquiry?.resolved).toBe(false);
  });

  it("closes a question Maya already answered", async () => {
    await log({ kind: "question", topic: "Asked whether we do walk-ins." });

    expect((await stored())?.resolved).toBe(true);
  });

  it("leaves a refusal open, not closed", async () => {
    // A call Maya declined to help with is the one most likely to need a
    // person, not the least.
    await log({ kind: "refused", topic: "Caller described chest pain." });

    expect((await stored())?.resolved).toBe(false);
  });

  it("falls back to the number they are ringing from", async () => {
    await log({ kind: "callback", topic: "Wants a price for a colour." });

    expect((await stored())?.callerPhoneE164).toBe(CALLER);
  });

  it("drops a callback number it cannot parse", async () => {
    // A number the model misheard is worse than no number at all.
    await log({
      kind: "callback",
      topic: "Wants a call back.",
      callback_number: "um, the usual one",
    });

    expect((await stored())?.callerPhoneE164).toBe(CALLER);
  });

  it("refuses a kind that is not one of ours", async () => {
    const result = (await log({ kind: "urgent", topic: "Something." })) as {
      ok: boolean;
      reason: string;
    };

    expect(result).toMatchObject({ ok: false, reason: "invalid_kind" });
    expect(await stored()).toBeUndefined();
  });

  it("refuses to write 'booked'", async () => {
    /*
      Only `book_appointment` may write that, because it is the one place that
      knows an Appointment row exists. A model logging "booked" after a failed
      booking would put SPEC.md §3 rule 7's exact lie into the database, where
      the dashboard would repeat it.
    */
    const result = (await log({ kind: "booked", topic: "All done." })) as {
      ok: boolean;
      reason: string;
    };

    expect(result).toMatchObject({ ok: false, reason: "invalid_kind" });
  });

  it("refuses an empty topic", async () => {
    const result = (await log({ kind: "question", topic: "   " })) as {
      ok: boolean;
      reason: string;
    };

    expect(result).toMatchObject({ ok: false, reason: "missing_topic" });
  });

  it("updates rather than colliding when called twice", async () => {
    // `enquiries.call_id` is UNIQUE. A second call is the model tidying up at
    // the end, and the later description is the better one.
    await log({ kind: "question", topic: "Asked about parking." });
    await log({ kind: "callback", topic: "Actually wants a call back." });

    const enquiry = await stored();
    expect(enquiry?.kind).toBe("callback");
    expect(enquiry?.topic).toBe("Actually wants a call back.");
    expect(enquiry?.resolved).toBe(false);
  });
});

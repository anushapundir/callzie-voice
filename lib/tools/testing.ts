import { eq } from "drizzle-orm";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import type { CallStatus } from "@/lib/db/schema";

/**
 * Seed and tear down the fixture every Tool endpoint test needs.
 *
 * **Test-only.** Nothing under `app/` may import this. It lives in `lib/tools/`
 * rather than a top-level test directory so it sits beside the code it seeds
 * for, and it is not named `*.test.ts` because Vitest would try to run it as a
 * suite and fail on finding no tests.
 *
 * The shape it builds is exactly what issue #11 will leave behind when a Web
 * Call starts: a `calls` row carrying a `retell_call_id`, pointing at an
 * Appointment that belongs to a Business with Business Hours and a Service. #10
 * only ever reads it — nothing in this ticket writes a `calls` row.
 */

/** Monday to Friday, 09:00-17:00. Weekday 0 is Sunday, matching `business_hours`. */
export const WEEKDAY_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: "09:00",
  closesAt: "17:00",
}));

export type ToolTestSeed = {
  userId: string;
  businessId: string;
  serviceId: string;
  appointmentId: string;
  /** `calls.id` — what a `tool_invocations` row points at. */
  callId: string;
  /** What Retell puts in `call.call_id`. */
  retellCallId: string;
};

export type SeedOptions = {
  /** Unique per test file, so two files cannot delete each other's fixture. */
  clerkId: string;
  timezone?: string;
  durationMinutes?: number;
  hours?: { weekday: number; opensAt: string; closesAt: string }[];
  /** Where the Appointment starts before anything reschedules it. */
  appointmentStartsAt: Date;
  /**
   * What state the Call is in.
   *
   * Defaults to `in_progress`, which is where a Tool call finds it — Maya is on
   * the phone. #13's webhook tests need `queued` as well, because the transition
   * they care about starts before the Call has connected.
   */
  callStatus?: CallStatus;
};

export async function seedToolTest({
  clerkId,
  timezone = "Asia/Kolkata",
  durationMinutes = 60,
  hours = WEEKDAY_HOURS,
  appointmentStartsAt,
  callStatus = "in_progress",
}: SeedOptions): Promise<ToolTestSeed> {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Tool Test Salon",
      businessType: "salon",
      timezone,
    })
    .returning();

  if (hours.length > 0) {
    await db
      .insert(schema.businessHours)
      .values(hours.map((h) => ({ businessId: business.id, ...h })));
  }

  const [service] = await db
    .insert(schema.services)
    .values({ businessId: business.id, name: "Haircut", durationMinutes })
    .returning();

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Sharma",
      phoneE164: "+919876543210",
      startsAt: appointmentStartsAt,
      endsAt: new Date(appointmentStartsAt.getTime() + durationMinutes * 60_000),
      // The status an Appointment holds while Maya is on the phone about it.
      status: "calling",
    })
    .returning();

  // Derived from the clerk id so two test files cannot collide on the unique
  // `calls.retell_call_id`.
  const retellCallId = `call_${clerkId}`;
  const [call] = await db
    .insert(schema.calls)
    .values({
      businessId: business.id,
      appointmentId: appointment.id,
      retellCallId,
      // Web is the default and the only kind an unflagged account may place
      // (SPEC.md §3 rule 9).
      callType: "web",
      status: callStatus,
    })
    .returning();

  return {
    userId: user.id,
    businessId: business.id,
    serviceId: service.id,
    appointmentId: appointment.id,
    callId: call.id,
    retellCallId,
  };
}

/**
 * An inbound Call on an existing seeded Business (issue #43).
 *
 * Separate from `seedToolTest` rather than an option on it, because the two
 * describe different situations: that one leaves behind what a Web Call about an
 * Appointment looks like, and this leaves behind a stranger on the line. It
 * writes no Appointment, which is the whole point — an inbound Call has none.
 *
 * Returns both ids because the inbound handlers need `calls.id` and the Tool
 * routes are reached with `retell_call_id`.
 */
export async function seedInboundCall({
  businessId,
  retellCallId,
  fromNumber = "+12025550142",
}: {
  businessId: string;
  retellCallId: string;
  fromNumber?: string;
}): Promise<{ callId: string; retellCallId: string; fromNumber: string }> {
  const [call] = await db
    .insert(schema.calls)
    .values({
      businessId,
      direction: "inbound",
      fromNumber,
      retellCallId,
      callType: "phone",
      status: "in_progress",
    })
    .returning({ id: schema.calls.id });

  return { callId: call.id, retellCallId, fromNumber };
}

/**
 * Delete everything `seedToolTest` wrote, in foreign-key order.
 *
 * Safe to call before seeding as well as after, which is what lets a test file
 * recover from a previous run that died halfway through.
 */
export async function cleanupToolTest(clerkId: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });

  if (business) {
    /*
      Calls are found by Business, not by walking Appointments.

      It used to walk them, which was correct while every Call had one. An
      inbound Call has none (issue #43), so that walk would leave inbound rows
      behind and the `businesses` delete at the bottom would then be refused by
      a foreign key — a failure that shows up as an unrelated test dying on the
      next run, which is a miserable thing to debug.
    */
    const calls = await db
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(eq(schema.calls.businessId, business.id));

    // enquiries, extractions and tool_invocations all reference calls. Inner
    // first, or the delete is refused by the foreign key.
    for (const call of calls) {
      await db.delete(schema.enquiries).where(eq(schema.enquiries.callId, call.id));
      await db
        .delete(schema.extractions)
        .where(eq(schema.extractions.callId, call.id));
      await db
        .delete(schema.toolInvocations)
        .where(eq(schema.toolInvocations.callId, call.id));
    }

    await db.delete(schema.calls).where(eq(schema.calls.businessId, business.id));

    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }

  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}

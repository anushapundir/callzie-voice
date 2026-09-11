/*
  Manual QA helper for issue #10. Drives the four Tool endpoints over real HTTP,
  exactly as Retell would, and prints what Maya would receive.

  Why this exists on top of the test suite. The tests call the route handlers
  directly, so they prove the handlers. They cannot prove `proxy.ts` lets the
  request reach them at all — and a Tool route left behind Clerk's session gate
  would 302 every call to the sign-in page, which reads as a Tool that silently
  never works. This script is the only thing that checks that.

  Run it with the app running and the Cloud SQL Auth Proxy up:

    npm run dev                            # in one terminal
    npx tsx scripts/try-tools.ts           # in another

  It creates one throwaway Appointment and one throwaway Call against the first
  Business it finds, drives the whole negotiation, prints the tool_invocations
  rows, then deletes everything it made. It never touches an Appointment it did
  not create.
*/

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { TOOL_PATHS } from "@/lib/retell/tools";
import { formatInZone } from "@/lib/time/zone";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_SECRET;

/** Marks the rows this script creates, so cleanup can never over-reach. */
const MARKER = `try-tools-${randomUUID().slice(0, 8)}`;

type ToolName = keyof typeof TOOL_PATHS;

async function callTool(
  name: ToolName,
  retellCallId: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(TOOL_PATHS[name], APP_URL).toString();

  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Exactly what scripts/create-agent.ts bakes into every Agent.
      Authorization: `Bearer ${SECRET}`,
    },
    // The envelope docs/verification.md A12 records.
    body: JSON.stringify({
      name,
      call: { call_id: retellCallId, call_type: "web_call", transcript: "" },
      args,
    }),
  });
  const elapsed = Date.now() - startedAt;

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    /*
      Not JSON. The interesting case: a redirect to the sign-in page, which is
      what a Tool route missing from proxy.ts's public list produces. Say so,
      rather than printing 40kb of HTML.
    */
    body = text.slice(0, 200);
  }

  console.log(`\n  ${name}  →  ${response.status}  (${elapsed} ms)`);
  if (Object.keys(args).length > 0) {
    console.log(`    sent: ${JSON.stringify(args)}`);
  }
  console.log(`    got:  ${JSON.stringify(body)}`);

  if (response.status === 307 || response.status === 302) {
    console.log(
      "    ^ redirected. /api/tools is missing from isPublicRoute in proxy.ts.",
    );
  }

  return body;
}

async function main() {
  if (!SECRET) {
    throw new Error(
      "INTERNAL_SECRET is not set. The endpoints refuse everything without it — " +
        "copy the value your Agents were created with into .env.local.",
    );
  }

  const business = await db.query.businesses.findFirst({
    orderBy: asc(schema.businesses.createdAt),
  });
  if (!business) {
    throw new Error("No Business in this database. Sign up and onboard first.");
  }

  const service = await db.query.services.findFirst({
    where: eq(schema.services.businessId, business.id),
  });
  if (!service) {
    throw new Error(`Business "${business.name}" has no Services.`);
  }

  console.log(`Business: ${business.name} (${business.timezone})`);
  console.log(`Service:  ${service.name}, ${service.durationMinutes} minutes`);
  console.log(`App:      ${APP_URL}`);

  /*
    Parked a year out, so it cannot collide with anything real on the calendar —
    appointments_no_overlap would refuse it, and that refusal would look like a
    bug in the endpoints rather than in this script.
  */
  const startsAt = new Date(Date.now() + 365 * 86_400_000);

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: MARKER,
      phoneE164: "+919999999999",
      startsAt,
      endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
      status: "calling",
    })
    .returning();

  const retellCallId = `call_${MARKER}`;
  const [call] = await db
    .insert(schema.calls)
    .values({
      businessId: appointment.businessId,
      appointmentId: appointment.id,
      retellCallId,
      callType: "web",
      status: "in_progress",
    })
    .returning();

  console.log(`\nThrowaway Appointment at ${formatInZone(startsAt, business.timezone)}`);
  console.log(`Throwaway Call ${retellCallId}\n`);

  /*
    Declared out here so `finally` can always delete them. This script runs
    against a real database, and the failure leg below parks a competing
    Appointment on a genuinely open Slot — a crash between creating it and
    deleting it would leave that Slot held by a row nobody asked for.
  */
  let failureCallRowId: string | null = null;
  let competitorId: string | null = null;

  try {
    console.log("--- The negotiation, as Maya would drive it ---");

    // 1. "That time doesn't work for me."
    const first = (await callTool("check_availability", retellCallId, {
      preferred_time: "Thursday afternoon",
    })) as { ok?: boolean; slots?: { slot_start: string; time: string }[] };

    if (!first?.slots?.length) {
      console.log(
        "\n  Nothing open in the next 14 days. Check Business Hours in Settings.",
      );
    } else {
      // 2. "None of those either." Offers are unlimited.
      await callTool("check_availability", retellCallId);

      // 3. She takes one.
      const booked = await callTool("book_slot", retellCallId, {
        slot_start: first.slots[0].slot_start,
      });
      console.log(`    (Maya would say: "${(booked as { booked_time?: string }).booked_time ?? "—"}")`);

      // 4. Checks still work after a booking.
      await callTool("check_availability", retellCallId);

      // 5. A second Reschedule is refused.
      console.log("\n--- The second booking, which must be refused ---");
      await callTool("book_slot", retellCallId, {
        slot_start: first.slots[1]?.slot_start ?? first.slots[0].slot_start,
      });

      // 6. A time nobody offered, which must also be refused.
      await callTool("book_slot", retellCallId, {
        slot_start: new Date(startsAt.getTime() + 3 * 86_400_000).toISOString(),
      });
    }

    /*
      SPEC.md §8, forced. The failure cannot come from the payload — the
      constraint refuses the write because another Appointment holds the Slot —
      so a competing Appointment is parked on an offered Slot first.

      This is the path that matters more than the happy one. Maya must promise a
      callback and must never claim the booking worked (SPEC.md §3 rule 7).

      Note the second Call row. The one-booking index is per Call, and the happy
      path above already committed a Reschedule on `retellCallId` — a book_slot
      there would be refused as `already_booked` and never reach the constraint
      at all.
    */
    console.log("\n--- The booking that fails, which must not sound like success ---");

    const failureCallId = `${retellCallId}_failure`;
    const [failureCall] = await db
      .insert(schema.calls)
      .values({
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        retellCallId: failureCallId,
        callType: "web",
        status: "in_progress",
      })
      .returning();
    failureCallRowId = failureCall.id;

    const toLose = (await callTool("check_availability", failureCallId)) as {
      slots?: { slot_start: string; time: string }[];
    };

    if (toLose?.slots?.length) {
      const target = toLose.slots[0];

      const [competitor] = await db
        .insert(schema.appointments)
        .values({
          businessId: business.id,
          serviceId: service.id,
          name: MARKER,
          phoneE164: "+919999999998",
          startsAt: new Date(target.slot_start),
          endsAt: new Date(
            new Date(target.slot_start).getTime() + service.durationMinutes * 60_000,
          ),
          status: "confirmed",
        })
        .returning();
      competitorId = competitor.id;

      console.log(`    (someone else just took ${target.time})`);

      const failed = (await callTool("book_slot", failureCallId, {
        slot_start: target.slot_start,
      })) as { ok?: boolean; say?: string; booked_time?: string };

      console.log(`    (Maya would say: "${failed.say ?? "—"}")`);

      if (failed.ok !== false) console.log("    ^ WRONG. This had to be ok:false.");
      if (failed.booked_time) console.log("    ^ WRONG. A failure named a booked time.");

      const flagged = await db.query.appointments.findFirst({
        where: eq(schema.appointments.id, appointment.id),
      });
      console.log(`    needs_attention_reason: ${flagged!.needsAttentionReason ?? "—"}`);

      await db
        .delete(schema.appointments)
        .where(eq(schema.appointments.id, competitor.id));
    }

    await db
      .delete(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, failureCall.id));
    await db.delete(schema.calls).where(eq(schema.calls.id, failureCall.id));

    console.log("\n--- Without the secret, which must be 401 ---");
    const unauthorised = await fetch(
      new URL(TOOL_PATHS.check_availability, APP_URL).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "check_availability", call: { call_id: retellCallId }, args: {} }),
      },
    );
    console.log(`  check_availability with no header  →  ${unauthorised.status}`);

    console.log("\n--- What was recorded (tool_invocations) ---");
    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, call.id))
      .orderBy(asc(schema.toolInvocations.createdAt));

    for (const row of rows) {
      const mark = row.succeeded ? "ok  " : "fail";
      console.log(
        `  ${mark} ${row.toolName.padEnd(20)} ${String(row.latencyMs).padStart(5)} ms  ${JSON.stringify(row.result)}`,
      );
    }

    const committed = rows.filter((r) => r.toolName === "book_slot" && r.succeeded);
    console.log(`\n  Reschedules committed: ${committed.length} (must be 1 or 0)`);

    const final = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointment.id),
    });
    console.log(
      `  Appointment ended at ${formatInZone(final!.startsAt, business.timezone)}, status ${final!.status}`,
    );
  } finally {
    // Only ever the rows this run created. The name marker is the guard.
    if (competitorId) {
      await db.delete(schema.appointments).where(eq(schema.appointments.id, competitorId));
    }
    if (failureCallRowId) {
      await db
        .delete(schema.toolInvocations)
        .where(eq(schema.toolInvocations.callId, failureCallRowId));
      await db.delete(schema.calls).where(eq(schema.calls.id, failureCallRowId));
    }
    await db.delete(schema.toolInvocations).where(eq(schema.toolInvocations.callId, call.id));
    await db.delete(schema.calls).where(eq(schema.calls.id, call.id));
    await db
      .delete(schema.appointments)
      .where(and(eq(schema.appointments.id, appointment.id), eq(schema.appointments.name, MARKER)));
    console.log("\nCleaned up.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

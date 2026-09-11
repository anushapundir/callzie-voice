import { and, asc, eq, sql } from "drizzle-orm";

import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { MAX_CONCURRENT_CALLS } from "@/lib/calls/batch/limits";
import { refusingPlacer, type CallPlacer } from "@/lib/calls/batch/placer";
import { releaseCallQuota } from "@/lib/calls/quota";
import { releaseAppointment } from "@/lib/calls/record";
import { reserveCall } from "@/lib/calls/reserve";
import { db, schema } from "@/lib/db";

/*
  Filling the free slots in the throttle (issue #17).

  Called from three places: the Call all button, every `call_ended` webhook, and
  the 5-second tick on an open Overview page. All three do the same thing, which
  is why there is one function.

  **The obvious implementation is wrong.** Counting what is in flight and then
  placing the difference lets two webhooks arriving in the same millisecond both
  read "two running" and both place one — four Calls. That is SPEC.md §3 rule 8
  again: three concurrent Agents will find any gap between a check and a write.

  The row lock on the claim below hides most of that. Two pumps starting
  together read the same count, select the same top-N Appointments, and contend
  on the same rows — so the loser claims nothing and the total comes out right.
  **The window it does not close is the one where the two reads straddle another
  pump's commit**: a pump that counted "none running" and then selected the
  queue *after* a second pump claimed the first three sees three different
  Appointments still waiting, and places three more. Counting is a phantom read;
  nothing can lock rows that do not exist yet.

  So the claim runs inside a per-Business advisory lock — a named Postgres lock,
  taken by number, that makes this Business's pumps take turns while every other
  account runs untouched. Two rules about what goes inside it:

  1. **No network call.** Dialling happens after the transaction commits. That is
     the same rule lib/calls/start-web-call.ts states about holding a lock across
     an HTTP round trip.
  2. **No reads through `db`.** The pool holds five connections; a read through
     `db` from inside a transaction takes a second one, and enough of those
     deadlock the app (lib/db/index.ts). Everything below passes `tx`.
*/

export type PumpResult = {
  placed: number;
  /** Why nothing more was placed, when something stopped it. */
  blocked?: "phone_calls_disabled" | "exhausted";
};

/** An Appointment claimed for a Call, with the row already reserved for it. */
type Claim = { appointmentId: string; callId: string };

export async function pumpBatch({
  businessId,
  now = new Date(),
  place = refusingPlacer,
}: {
  businessId: string;
  now?: Date;
  place?: CallPlacer;
}): Promise<PumpResult> {
  let blocked: PumpResult["blocked"];

  const claims = await db.transaction(async (tx): Promise<Claim[]> => {
    /*
      `hashtext` turns the Business id into the integer the lock is named by.
      Two Businesses could collide on the same number, which costs them nothing
      but taking turns with each other. `pg_advisory_xact_lock` releases when
      this transaction ends, however it ends — there is no unlock to forget.
    */
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${businessId}::text))`,
    );

    /*
      Before anything is claimed. SPEC.md §3 rule 9: an unflagged account may
      not place a Phone Call. Checking here is what stops a retry requeued by
      the webhook from reserving a row and spending a Call on a dial that is
      going to be refused anyway.
    */
    const business = await tx.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
      columns: { phoneCallsEnabled: true },
    });
    if (!business?.phoneCallsEnabled) {
      blocked = "phone_calls_disabled";
      return [];
    }

    const slots =
      MAX_CONCURRENT_CALLS - (await countInFlightCalls(tx, businessId, now));
    if (slots <= 0) return [];

    const waiting = await tx
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.businessId, businessId),
          eq(schema.appointments.status, "queued"),
        ),
      )
      // Soonest first: the Appointment closest to happening is the one where a
      // rebooking is still worth something.
      .orderBy(asc(schema.appointments.startsAt))
      .limit(slots);

    const claimed: Claim[] = [];

    for (const { id } of waiting) {
      // The claim is this WHERE clause. No row means another pump took it.
      const [taken] = await tx
        .update(schema.appointments)
        .set({ status: "calling" })
        .where(
          and(
            eq(schema.appointments.id, id),
            eq(schema.appointments.status, "queued"),
          ),
        )
        .returning({ id: schema.appointments.id });
      if (!taken) continue;

      const reserved = await reserveCall(tx, {
        businessId,
        appointmentId: id,
        callType: "phone",
      });

      if (!reserved.ok) {
        /*
          The Quota ran out. Put this one back, and drain the rest of the queue
          with it — none of them can be placed either, and an Appointment left
          at `queued` that can never be called is a row lying about what is
          going to happen.
        */
        await tx
          .update(schema.appointments)
          .set({ status: "pending" })
          .where(eq(schema.appointments.id, id));
        await tx
          .update(schema.appointments)
          .set({ status: "pending" })
          .where(
            and(
              eq(schema.appointments.businessId, businessId),
              eq(schema.appointments.status, "queued"),
            ),
          );
        blocked = "exhausted";
        break;
      }

      claimed.push({ appointmentId: id, callId: reserved.callId });
    }

    return claimed;
  });

  /*
    Outside the lock, and one at a time rather than in parallel: there are at
    most three of these, and a sequential loop keeps the failure handling below
    readable.
  */
  let placed = 0;
  for (const claim of claims) {
    const result = await place({ businessId, ...claim });
    if (result.ok) {
      placed += 1;
      continue;
    }
    await handOverBack(businessId, claim, result.reason);
  }

  return blocked ? { placed, blocked } : { placed };
}

/**
 * Undoes a claim whose dial never happened.
 *
 * The Quota is refunded because this failure is ours and provable on the
 * server, which is the only kind lib/calls/quota.ts allows a refund for.
 *
 * The Appointment goes back to `pending`, **not** to `queued`. A dialler that
 * is permanently broken would otherwise take the same Appointment on every
 * pump, forever.
 */
async function handOverBack(
  businessId: string,
  { appointmentId, callId }: Claim,
  reason: string,
): Promise<void> {
  await db
    .update(schema.calls)
    .set({ status: "failed", endedAt: new Date(), disconnectReason: reason })
    .where(eq(schema.calls.id, callId));

  await releaseCallQuota(db, businessId);
  await releaseAppointment(appointmentId);
}

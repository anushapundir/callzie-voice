import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  eligibleAppointmentIds,
  quotaRemaining,
} from "@/lib/calls/batch/eligible";
import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { MAX_BATCH_SIZE } from "@/lib/calls/batch/limits";
import { db, schema } from "@/lib/db";

/*
  Every Appointment-status write the batch makes (issue #17).

  Four of them, and all four are conditional UPDATEs writing fixed values. That
  is what makes them safe against a webhook delivered twice and against two
  pumps running at once — the same property lib/webhooks/process.ts states about
  itself. Never a read followed by a write.
*/

/**
 * Marks the callable Appointments as waiting for a Call.
 *
 * **Capped at the remaining Quota**, which is what lets the confirmation sheet
 * say "3 will be placed and 5 stay pending" and be right. Queueing all eight
 * was considered and rejected: an Appointment that can never be placed is a row
 * lying about what is going to happen.
 *
 * The claim is the UPDATE's WHERE clause, not the read above it. A second press
 * finds nothing still `pending` and queues nothing, so a double press is
 * harmless without any lock.
 */
export async function enqueueBatch({
  businessId,
  now = new Date(),
}: {
  businessId: string;
  now?: Date;
}): Promise<{ queued: number; eligible: number }> {
  const eligible = await eligibleAppointmentIds(businessId, now);
  const remaining = await quotaRemaining(businessId);

  const take = Math.min(eligible.length, remaining, MAX_BATCH_SIZE);
  if (take === 0) return { queued: 0, eligible: eligible.length };

  const rows = await db
    .update(schema.appointments)
    .set({ status: "queued" })
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "pending"),
        inArray(schema.appointments.id, eligible.slice(0, take)),
      ),
    )
    .returning({ id: schema.appointments.id });

  return { queued: rows.length, eligible: eligible.length };
}

/**
 * Empties the queue.
 *
 * Calls already in flight are left alone — you can stop a queue, not un-ring a
 * phone. Also the recovery for a queue that cannot drain itself, which is what
 * a requeued retry becomes while `phone_calls_enabled` is off.
 */
export async function stopBatch(businessId: string): Promise<number> {
  const rows = await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "queued"),
      ),
    )
    .returning({ id: schema.appointments.id });

  return rows.length;
}

/**
 * The states where nothing has decided this Appointment yet.
 *
 * Both aftermath writes below key on these two rather than on `pending` alone,
 * and the second one is not hypothetical: a retry that cannot be placed sits at
 * `queued`, and that is exactly the state its next `call_ended` finds it in.
 * Keying on `pending` only left an Appointment stuck in the queue after its
 * final silence — caught by `scripts/replay-webhook.ts`, not by any unit test,
 * because it needs two deliveries against one Appointment to show up.
 *
 * `calling` is not here and does not need to be: `releaseAppointment` runs
 * first and turns it into `pending`.
 *
 * What is deliberately excluded is everything a Tool committed — `confirmed`,
 * `rescheduled`, `declined`, `cancelled`. The Tool wins (SPEC.md §9 step 3).
 */
const UNDECIDED = ["pending", "queued"] as const;

/**
 * Puts an Appointment back in the queue for one more Call.
 *
 * Runs after `releaseAppointment` has returned the row to `pending`. The two
 * conditions are the ones that matter: a Tool that committed mid-Call has
 * already written the outcome and wins, and an Appointment carrying a reason is
 * blocked from calling until a human clears it (issue #15).
 *
 * The retry is a **second Call row** — `reserveCall` numbers it attempt 2 when
 * the pump reaches it — not a revival of the first.
 */
export async function requeueForRetry(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ status: "queued" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        inArray(schema.appointments.status, [...UNDECIDED]),
        isNull(schema.appointments.needsAttentionReason),
      ),
    );
}

/**
 * Stops calling this Appointment and asks a human to look at it.
 *
 * **The Slot stays held.** `unreachable` is not in `SLOT_FREEING_STATUSES` and
 * `starts_at` is not touched, so the booking stays exactly where it is —
 * SPEC.md §14 rule 2: an unanswered phone is not a cancellation, and freeing a
 * Slot on that signal would destroy a real booking.
 *
 * `coalesce` because `book_failed` is the more specific reason and must
 * survive, which is the rule `flagTruncated` already follows. One statement
 * writing fixed values, so a redelivered webhook changes nothing.
 */
export async function markUnreachable(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({
      status: "unreachable",
      needsAttentionReason: sql`coalesce(${schema.appointments.needsAttentionReason}, 'unreachable')`,
    })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        inArray(schema.appointments.status, [...UNDECIDED]),
      ),
    );
}

export type BatchProgress = {
  /** Phone Calls running right now. */
  calling: number;
  /** Appointments waiting for a free slot. */
  waiting: number;
};

/**
 * What the strip above the table shows.
 *
 * `calling` counts **Phone** Calls only, which is what stops the strip
 * duplicating the live-call bar: a browser conversation is already reported
 * there, and a second banner announcing the same Call is noise. The throttle in
 * `pump.ts` counts every type, because a live Web Call genuinely is one of the
 * account's concurrent Calls.
 *
 * There is deliberately no "done" count. Without a Batch entity there is no
 * honest way to compute one, and a made-up number on the demo stage is worse
 * than an absent one.
 */
export async function batchProgress(
  businessId: string,
  now: Date = new Date(),
): Promise<BatchProgress> {
  const [waiting] = await db
    .select({ n: count() })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "queued"),
      ),
    );

  return {
    calling: await countInFlightCalls(db, businessId, now, ["phone"]),
    waiting: waiting.n,
  };
}

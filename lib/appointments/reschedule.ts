import { eq } from "drizzle-orm";

import { isSlotTaken } from "@/lib/availability/slot-taken";
import { schema } from "@/lib/db";
import type { Tx } from "@/lib/tools/run";

/**
 * Move an existing Appointment to another Slot — CONTEXT.md's **Reschedule**.
 *
 * Not `lib/availability/book.ts`, which inserts a new Appointment for the
 * quick-add card. A Reschedule moves the row the Call is already about, so the
 * person keeps one Appointment rather than acquiring a second.
 *
 * **An UPDATE is checked by `appointments_no_overlap` exactly as an INSERT is.**
 * An exclusion constraint tests the row's new range whichever statement produced
 * it, so the no-overlap guarantee needs nothing new here. Nothing in this
 * function asks whether the Slot is free first, and nothing should be added that
 * does: SPEC.md §5 permits three concurrent Calls, and three Agents running
 * check-then-write will find any gap between the read and the write.
 */

export type RescheduleResult =
  | { ok: true; startsAt: Date; endsAt: Date }
  | { ok: false; reason: "slot_taken" };

export type RescheduleInput = {
  /** The caller's transaction. The record of this write is committed with it. */
  tx: Tx;
  appointmentId: string;
  /** The Service's length, from the resolved context. */
  durationMinutes: number;
  startsAt: Date;
};

export async function rescheduleAppointment({
  tx,
  appointmentId,
  durationMinutes,
  startsAt,
}: RescheduleInput): Promise<RescheduleResult> {
  /*
    Derived here, never accepted from the caller — the same rule
    lib/availability/book.ts states, for the same reason: `ends_at` is half of
    what the exclusion constraint compares, so a caller able to supply it could
    defeat the constraint with a one-minute end time.

    Absolute milliseconds, not a wall-clock addition: an Appointment occupies
    real time, so a 90-minute Colour across a spring-forward still takes 90
    minutes even though the clock advances 150.
  */
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  try {
    /*
      A nested transaction, which Drizzle issues as a SAVEPOINT — a marker inside
      a transaction you can roll back to without losing the transaction.

      This is not tidiness. Postgres aborts the whole transaction the instant a
      statement fails, so after the constraint rejects this UPDATE, every later
      statement in the caller's transaction would fail with "current transaction
      is aborted": SPEC.md §8's silent retry, the `book_failed` write, and the
      `tool_invocations` row that is the authoritative record of the attempt.
      Rolling back to a savepoint instead leaves the caller's transaction alive.
    */
    return await tx.transaction(async (savepoint) => {
      const [moved] = await savepoint
        .update(schema.appointments)
        .set({
          startsAt,
          endsAt,
          status: "rescheduled",
          /*
            A new time is a new question. Events that conflicted with 10:00 say
            nothing about 16:00, so the record of what has already been reported
            starts empty again — otherwise a Collision at the new time could be
            skipped because its event id happened to conflict with the old one.

            In this UPDATE rather than a second one, deliberately. A window where
            the Appointment has moved but still remembers the old day's
            conflicts is a window where a real Collision gets swallowed.
          */
          collisionEventIds: [],
        })
        .where(eq(schema.appointments.id, appointmentId))
        .returning();

      if (!moved) throw new Error(`No Appointment ${appointmentId}`);

      return { ok: true as const, startsAt, endsAt };
    });
  } catch (error) {
    if (isSlotTaken(error)) return { ok: false, reason: "slot_taken" };
    // A dropped connection is not a busy Slot. Telling them apart is what lets
    // SPEC.md §3 rule 7 hold: Maya must never claim a booking succeeded when the
    // Tool failed, and she has to be told which of the two happened.
    throw error;
  }
}

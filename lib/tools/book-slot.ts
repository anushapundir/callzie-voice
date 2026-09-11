import { eq } from "drizzle-orm";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { slotIsOffered } from "@/lib/availability/offered";
import { schema } from "@/lib/db";
import { offeredSlotsInCall } from "@/lib/tools/offers";
import type { ToolHandler, ToolOutcome } from "@/lib/tools/run";
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
import { spokenTime } from "@/lib/tools/spoken-time";

/**
 * `book_slot` — the moment the product does what it promises. The Reschedule
 * commits while the person is still on the line (ADR-0003), not from a
 * transcript someone parses afterwards.
 *
 * Four checks, in this order, because each is cheaper than the next and each
 * failure means something different to the person on the phone:
 *
 * 1. Is `slot_start` a time at all?
 * 2. Did we offer it in **this** Call? (`lib/tools/offers.ts`)
 * 3. Is it inside Business Hours and still ahead? (`lib/availability/offered.ts`)
 * 4. Move the Appointment, and let `appointments_no_overlap` settle the race.
 *
 * Check 3 looks redundant after check 2 and is not. A Slot offered forty seconds
 * ago can be in the past by the time it is booked, and Business Hours can be
 * edited in Settings mid-Call. Check 2 asks "did we say this?"; check 3 asks "is
 * it still true?".
 *
 * **The one thing here with no acceptable workaround:** this never returns
 * `ok: true` for a write that did not happen. SPEC.md §3 rule 7 and §14 rule 4 —
 * Maya claiming a booking succeeded when it failed is the most damaging failure
 * available to this product.
 */

/** SPEC.md §8: "Retry once, silently." So two attempts, not two retries. */
const ATTEMPTS = 2;

export type BookSlotRefusal =
  | "invalid_time"
  | "not_offered"
  | "in_the_past"
  | "slot_taken";

/**
 * A refusal, with the words that go with it.
 *
 * `slot_taken` is the only one that promises a callback, because it is the only
 * one where Maya asked for something reasonable and Callzie could not deliver
 * it. The other three mean she named a time that was never on the table, and the
 * right move there is another `check_availability`, not a promise to ring back.
 */
const refuse = (reason: BookSlotRefusal): ToolOutcome => ({
  succeeded: false,
  result: {
    ok: false,
    reason,
    say:
      reason === "slot_taken"
        ? NOT_COMMITTED.bookFailed
        : NOT_COMMITTED.notAvailable,
  },
});

export const bookSlotTool: ToolHandler = async ({ tx, context, args, now }) => {
  const slotStart = args.slot_start;
  if (typeof slotStart !== "string") return refuse("invalid_time");

  const startsAt = new Date(slotStart);
  if (Number.isNaN(startsAt.getTime())) return refuse("invalid_time");

  /*
    Compared on the normalised instant, not the raw string. The model is told to
    copy `slot_start` exactly (lib/retell/tools.ts), and usually will — but
    "…+00:00" and "…Z" are the same moment, and refusing a booking the customer
    just agreed to over a formatting difference is the wrong way to be strict.
    What matters is that we named this instant, and that survives normalising.
  */
  const token = startsAt.toISOString();
  const offered = await offeredSlotsInCall(tx, context.callId);
  if (!offered.has(token)) return refuse("not_offered");

  /*
    SPEC.md §3 rule 6 and §14 rule 1, enforced in the Tool and never in the
    prompt. `slotIsOffered` deliberately does not look at other Appointments —
    that is the constraint's job, and asking here would be a check-then-write.
  */
  const stillOpen = await slotIsOffered({
    businessId: context.businessId,
    serviceId: context.serviceId,
    startsAt,
    now,
    // Through the transaction, never the pool — see lib/tools/check-availability.ts.
    database: tx,
  });
  if (stillOpen === "in_the_past") return refuse("in_the_past");
  if (stillOpen !== "offered") return refuse("not_offered");

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const moved = await rescheduleAppointment({
      tx,
      appointmentId: context.appointment.id,
      durationMinutes: context.durationMinutes,
      startsAt,
    });

    if (moved.ok) {
      // Read back to the customer — SPEC.md §7 step 3.
      const spoken = spokenTime(startsAt, context.timezone);

      return {
        succeeded: true,
        result: {
          ok: true,
          booked_time: spoken,
          say: COMMITTED.booked(spoken),
        },
      };
    }

    /*
      Lost the race. SPEC.md §8 step 1: try once more without saying anything.
      The winner may itself have been rolled back, and a silent retry costs one
      statement. Each attempt runs on its own savepoint inside
      `rescheduleAppointment`, which is what keeps this transaction alive to make
      the second one.
    */
  }

  /*
    SPEC.md §8 step 3. The Appointment keeps its original Slot and a human is
    asked to look at it — Callzie will not call this person again until someone
    clears it (SPEC.md §5). #15 renders this; #10 only writes it.
  */
  await tx
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return refuse("slot_taken");
};

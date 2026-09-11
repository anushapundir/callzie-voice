import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { ToolHandler } from "@/lib/tools/run";
import { COMMITTED } from "@/lib/tools/say";

/**
 * `cancel_appointment` — the person does not want the Appointment at all.
 *
 * **The Slot frees itself.** `cancelled` is one of `SLOT_FREEING_STATUSES`, so
 * `appointments_no_overlap` stops counting the row and `findAvailableSlots`
 * stops subtracting it, in the same instant. There is no separate "release the
 * Slot" step, and therefore no way for the constraint and Availability to
 * disagree about whether that time is open.
 *
 * Note what this does **not** cover. SPEC.md §14 rule 2 says a Slot is never
 * freed on a weak signal — a person saying "cancel it" is not a weak signal, an
 * unanswered phone is, and that path belongs to #17.
 */
export const cancelAppointment: ToolHandler = async ({ tx, context }) => {
  await tx
    .update(schema.appointments)
    .set({ status: "cancelled" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return { succeeded: true, result: { ok: true, say: COMMITTED.cancelled } };
};

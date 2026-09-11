import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { ToolHandler } from "@/lib/tools/run";
import { COMMITTED } from "@/lib/tools/say";

/**
 * `confirm_appointment` — the person can make their time after all.
 *
 * No arguments, by design: it acts on the Appointment this Call is already
 * about, and `lib/retell/tools.ts` explains why no Tool takes an identifier.
 *
 * Idempotent. Confirming an already-confirmed Appointment succeeds, because Maya
 * occasionally calls a Tool twice and a second confirmation is not a problem
 * worth making her explain to the customer.
 *
 * Nothing here touches `starts_at`. A confirmation is agreement with the time
 * the Appointment already holds — moving it is `book_slot`'s job.
 */
export const confirmAppointment: ToolHandler = async ({ tx, context }) => {
  await tx
    .update(schema.appointments)
    .set({ status: "confirmed" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return { succeeded: true, result: { ok: true, say: COMMITTED.confirmed } };
};

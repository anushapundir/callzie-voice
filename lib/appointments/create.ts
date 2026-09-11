import { bookSlot } from "@/lib/availability/book";
import { slotIsOffered } from "@/lib/availability/offered";
import type { schema } from "@/lib/db";

/**
 * Create an Appointment by hand, from the Overview quick-add card (issue #7).
 *
 * Two steps, with two different owners, and keeping them apart is the whole
 * point of this file:
 *
 * 1. `slotIsOffered` — is the Business open then, and is the time still ahead?
 *    Postgres cannot answer this: `appointments_no_overlap` compares time
 *    ranges and never sees `business_hours`.
 *
 * 2. `bookSlot` — attempt the insert. If the Slot is taken, the constraint
 *    rejects it and `bookSlot` hands that back as `slot_taken`.
 *
 * **Nothing here asks whether the Slot is free before inserting, and nothing
 * should be added that does.** Such a check cannot prevent the race it appears
 * to prevent — SPEC.md §5 permits three concurrent Agents, and three
 * check-then-write sequences find any gap between the read and the write. Worse,
 * it would make the `slot_taken` branch below look redundant, and deleting that
 * branch is how the constraint gets orphaned.
 *
 * This function is thin on purpose. The behaviour lives in the two functions it
 * calls; what it adds is a name for each refusal, so the card can say what went
 * wrong instead of showing a generic error.
 */

export type Appointment = typeof schema.appointments.$inferSelect;

export type CreateAppointmentInput = {
  businessId: string;
  serviceId: string;
  name: string;
  /** E.164, already validated by `lib/appointments/phone.ts`. */
  phoneE164: string;
  startsAt: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
};

export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "not_offered" | "in_the_past" | "slot_taken" };

export async function createAppointment({
  businessId,
  serviceId,
  name,
  phoneE164,
  startsAt,
  now = new Date(),
}: CreateAppointmentInput): Promise<CreateAppointmentResult> {
  const offer = await slotIsOffered({ businessId, serviceId, startsAt, now });
  if (offer !== "offered") {
    return { ok: false, reason: offer };
  }

  const booked = await bookSlot({
    businessId,
    serviceId,
    name,
    phoneE164,
    startsAt,
  });
  if (!booked.ok) {
    return { ok: false, reason: "slot_taken" };
  }

  return { ok: true, appointment: booked.appointment };
}

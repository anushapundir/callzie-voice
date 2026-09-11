import { and, eq } from "drizzle-orm";

import { isSlotTaken } from "@/lib/availability/slot-taken";
import { db, schema } from "@/lib/db";

/**
 * Book a Slot (SPEC.md §3 rule 8, §8).
 *
 * The no-overlap guarantee lives in the database, not here. This function does
 * NOT check whether the Slot is free before inserting, and adding such a check
 * would be a mistake: SPEC.md §5 permits three concurrent Calls, and three
 * Agents running check-then-write will find any gap between the read and the
 * write. The `appointments_no_overlap` EXCLUDE constraint closes that gap
 * because Postgres serialises the contending inserts on its gist index.
 *
 * What this function does add is a translation. A losing insert raises a
 * Postgres error, and "someone else just took this Slot" is an ordinary outcome
 * Maya should respond to by offering another time — not an exception. So it comes
 * back as a value, and everything else propagates.
 */

export type BookSlotInput = {
  businessId: string;
  serviceId: string;
  name: string;
  /** E.164 (SPEC.md §3 rule 10). Validated upstream, at the edge that accepts it. */
  phoneE164: string;
  startsAt: Date;
};

export type BookSlotResult =
  | { ok: true; appointment: typeof schema.appointments.$inferSelect }
  | { ok: false; reason: "slot_taken" };

export async function bookSlot({
  businessId,
  serviceId,
  name,
  phoneE164,
  startsAt,
}: BookSlotInput): Promise<BookSlotResult> {
  const service = await db.query.services.findFirst({
    where: and(
      eq(schema.services.id, serviceId),
      eq(schema.services.businessId, businessId),
    ),
    columns: { durationMinutes: true },
  });
  if (!service) {
    throw new Error(`No Service ${serviceId} for Business ${businessId}`);
  }

  /*
    Derived here, never accepted from the caller. `ends_at` is half of what the
    exclusion constraint compares, so a caller able to supply it would be able to
    defeat it — a one-minute end time overlaps nothing.

    Absolute milliseconds, not a wall-clock addition, matching
    lib/onboarding/seed-schedule.ts: an Appointment occupies real time, so a
    90-minute Colour across a spring-forward still takes 90 minutes even though
    the clock advances 150.
  */
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  try {
    const [appointment] = await db
      .insert(schema.appointments)
      .values({ businessId, serviceId, name, phoneE164, startsAt, endsAt })
      .returning();
    return { ok: true, appointment };
  } catch (error) {
    if (isSlotTaken(error)) return { ok: false, reason: "slot_taken" };
    // A dropped connection is not a busy Slot. Telling them apart is the whole
    // point of this function: SPEC.md §3 rule 7 says Maya must never claim a
    // booking succeeded when the Tool failed, and §8 retries once before giving
    // up — neither is servable if every error looks the same.
    throw error;
  }
}

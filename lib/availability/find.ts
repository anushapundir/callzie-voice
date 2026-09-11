import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { loadSchedule } from "@/lib/availability/schedule";
import { openSlots, type Slot } from "@/lib/availability/slots";
import { db, schema, type Queryable } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";

/**
 * Availability for a Business and a Service (SPEC.md §6).
 *
 * Computed entirely from Callzie's own Postgres, never from Google (ADR-0003):
 * `check_availability` runs mid-conversation and a slow answer is dead air.
 *
 * The caller supplies the window. This function owns no policy about how far
 * ahead to look — #10's `check_availability` Tool decides that, and turns its
 * optional `preferred_time` into a window. Keeping the horizon out of here is
 * what lets `lib/availability/slots.ts` stay pure and total.
 */

export type FindAvailableSlotsInput = {
  businessId: string;
  serviceId: string;
  /** Earliest instant to consider. */
  from: Date;
  /** Latest instant a Slot may end at. */
  to: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
  /**
   * Read through this instead of the pool.
   *
   * `check_availability` runs inside the transaction `lib/tools/run.ts` opens,
   * and must pass that transaction here. Reading through the pool while holding
   * a connection is what deadlocks it — see `Queryable` in `lib/db/index.ts`.
   */
  database?: Queryable;
};

export async function findAvailableSlots({
  businessId,
  serviceId,
  from,
  to,
  now = new Date(),
  database = db,
}: FindAvailableSlotsInput): Promise<Slot[]> {
  const { timezone, durationMinutes, hours } = await loadSchedule({
    businessId,
    serviceId,
    database,
  });

  const busy = await database
    .select({
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
    })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        /*
          Exactly the statuses the `appointments_no_overlap` constraint counts —
          see SLOT_HOLDING_STATUSES in lib/db/schema.ts. `declined` and
          `cancelled` free their Slot; everything else holds it, including
          `unreachable` (SPEC.md §14 rule 2).
        */
        inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
        // Half-open overlap with the window, matching tstzrange. Only
        // Appointments that could touch a Slot in range are loaded.
        lt(schema.appointments.startsAt, to),
        gt(schema.appointments.endsAt, from),
      ),
    );

  return openSlots({ hours, timezone, durationMinutes, busy, from, to, now });
}

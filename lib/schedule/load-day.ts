import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import { dayLayout, type DayLayout } from "@/lib/schedule/day-layout";
import { toWallTime } from "@/lib/settings/weekdays";
import {
  addCalendarDays,
  weekdayOf,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * One day of the Schedule screen, read and laid out.
 *
 * The loader half of the pair `lib/availability/find.ts` models: two queries,
 * then straight into the pure core. Nothing is decided here.
 *
 * **Why the Appointment query uses the civil day rather than the drawn
 * window.** The window stretches to hold Appointments falling outside Business
 * Hours, so it cannot be computed until the Appointments are known — and the
 * Appointments cannot be queried by a window that does not exist yet. Midnight
 * to midnight in the Business's own zone breaks the circle: it is a superset of
 * anything the stretched window can reach, so the core is free to widen without
 * a second round trip.
 *
 * An Appointment running across midnight overlaps both civil days and appears
 * whole on both, each day's window stretching to hold it. That is the honest
 * answer, and it is rare — `lib/settings/hours-input.ts` rejects overnight
 * Business Hours, so nothing routinely books across the boundary.
 *
 * **Not `listAppointments`.** That one is capped at 20 rows, has no date filter
 * and does not carry `needs_attention_reason`. Widening it would make Overview
 * pay for a column it never renders.
 */

export type LoadScheduleDayInput = {
  businessId: string;
  /** IANA zone from `businesses.timezone`. */
  timezone: string;
  /** The day to draw, in that zone. */
  date: CivilDate;
};

/** `null` means there is nothing to draw — a closed day with no Appointments. */
export async function loadScheduleDay({
  businessId,
  timezone,
  date,
}: LoadScheduleDayInput): Promise<DayLayout | null> {
  const dayStart = zonedTimeToInstant({ ...date, hour: 0, minute: 0 }, timezone);
  const dayEnd = zonedTimeToInstant(
    { ...addCalendarDays(date, 1), hour: 0, minute: 0 },
    timezone,
  );

  const [hoursRows, appointments] = await Promise.all([
    db
      .select({
        opensAt: schema.businessHours.opensAt,
        closesAt: schema.businessHours.closesAt,
      })
      .from(schema.businessHours)
      .where(
        and(
          eq(schema.businessHours.businessId, businessId),
          eq(schema.businessHours.weekday, weekdayOf(date)),
        ),
      ),

    db
      .select({
        id: schema.appointments.id,
        name: schema.appointments.name,
        serviceName: schema.services.name,
        startsAt: schema.appointments.startsAt,
        endsAt: schema.appointments.endsAt,
        status: schema.appointments.status,
        needsAttentionReason: schema.appointments.needsAttentionReason,
      })
      .from(schema.appointments)
      /*
        An explicit innerJoin rather than the relational query API, for the
        reason lib/business/list-appointments.ts gives: no relations() are
        declared anywhere in this repo, and adding them is a schema-wide
        convention change rather than something to slip into a feature ticket.
      */
      .innerJoin(
        schema.services,
        eq(schema.appointments.serviceId, schema.services.id),
      )
      .where(
        and(
          eq(schema.appointments.businessId, businessId),
          /*
            Exactly the statuses the appointments_no_overlap constraint counts.
            Imported, never re-listed: a second copy of this list is the drift
            lib/db/schema.ts exists to prevent.

            It is also what keeps the layout simple. `declined` and `cancelled`
            free their Slot, so another Appointment may legally sit on top of
            one — and if both were drawn, two blocks could occupy the same
            minutes and the grid would need side-by-side lanes. Excluding them
            lets the database guarantee that blocks never overlap.
          */
          inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
          // Half-open overlap with the civil day, matching tstzrange.
          lt(schema.appointments.startsAt, dayEnd),
          gt(schema.appointments.endsAt, dayStart),
        ),
      )
      // Covered by appointments_business_id_starts_at_idx.
      .orderBy(asc(schema.appointments.startsAt)),
  ]);

  // business_hours_business_weekday_uniq makes this at most one row.
  const hours = hoursRows[0];

  return dayLayout({
    date,
    timezone,
    hours: hours
      ? {
          // `pg` renders a `time` column as "09:00:00"; the pure core expects
          // "09:00". Normalising on the way out of the database is what
          // toWallTime is for.
          opensAt: toWallTime(hours.opensAt),
          closesAt: toWallTime(hours.closesAt),
        }
      : null,
    appointments,
  });
}

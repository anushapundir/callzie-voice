import { and, eq } from "drizzle-orm";

import type { WeekdayWindow } from "@/lib/availability/slots";
import { db, schema, type Queryable } from "@/lib/db";
import { toWallTime } from "@/lib/settings/weekdays";

/**
 * The three facts that define when a Business could take a booking: its
 * timezone, the Service's duration, and its Business Hours.
 *
 * Shared by every caller that has to know where Slot boundaries fall, so no two
 * of them can drift on it.
 *
 * **It deliberately does not load Appointments, and must not start.**
 *
 * The distinction that matters: reading busy times to *show a list* is fine —
 * that is what `find.ts` does, and it loads them itself. Reading them to
 * *decide whether a booking may go ahead* is not. If two Calls both check 09:00
 * at the same moment, both see it free and both try to book it. One has to
 * lose, and Postgres is the only thing positioned to say which.
 *
 * That refusal is `appointments_no_overlap` — a Postgres EXCLUDE constraint,
 * meaning a rule that rejects an insert whose time range overlaps a row already
 * there. `lib/availability/book.ts` explains at length how it is caught and
 * turned back into an ordinary answer, and SPEC.md §3 rule 8 is the rule it
 * enforces. Both are the reference here; `lib/availability/offered.ts` is the
 * caller that depends on this loader staying incomplete.
 */

export type Schedule = {
  /** IANA zone from `businesses.timezone` — Business Hours are local to it. */
  timezone: string;
  /** The Service's length, which is also the Slot size. */
  durationMinutes: number;
  /** One entry per open weekday. Wall-clock `"09:00"`, never an instant. */
  hours: WeekdayWindow[];
};

export type LoadScheduleInput = {
  businessId: string;
  serviceId: string;
  /**
   * Read through this instead of the pool.
   *
   * Callers already inside a transaction must pass their own handle, or this
   * takes a second connection while the first is still held — see `Queryable`
   * in `lib/db/index.ts` for the deadlock that causes and why it is worst here.
   */
  database?: Queryable;
};

/*
  An options object rather than two positional arguments, because both are
  opaque id strings of the same type: swapping them would compile, then fail
  with `No Business svc_abc123` — a message naming the wrong kind of thing.
  Every other function in this directory is shaped the same way.
*/
export async function loadSchedule({
  businessId,
  serviceId,
  database = db,
}: LoadScheduleInput): Promise<Schedule> {
  const business = await database.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { timezone: true },
  });
  if (!business) {
    throw new Error(`No Business ${businessId}`);
  }

  const service = await database.query.services.findFirst({
    where: and(
      eq(schema.services.id, serviceId),
      // Scoped to the Business: a Service id from another account must not
      // resolve, or one Business could read Availability sized by another's
      // duration.
      eq(schema.services.businessId, businessId),
    ),
    columns: { durationMinutes: true },
  });
  if (!service) {
    throw new Error(`No Service ${serviceId} for Business ${businessId}`);
  }

  const hours = await database
    .select({
      weekday: schema.businessHours.weekday,
      opensAt: schema.businessHours.opensAt,
      closesAt: schema.businessHours.closesAt,
    })
    .from(schema.businessHours)
    .where(eq(schema.businessHours.businessId, businessId));

  return {
    timezone: business.timezone,
    durationMinutes: service.durationMinutes,
    // pg renders a `time` column as "09:00:00"; the pure core expects "09:00".
    // Normalising on the way out of the database is what toWallTime is for.
    hours: hours.map(
      (h): WeekdayWindow => ({
        weekday: h.weekday,
        opensAt: toWallTime(h.opensAt),
        closesAt: toWallTime(h.closesAt),
      }),
    ),
  };
}

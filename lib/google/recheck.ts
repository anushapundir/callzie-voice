import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import { raiseCollisions } from "@/lib/google/collision";
import { listEvents } from "@/lib/google/events";
import { overlappingEventIds, wholeDayWindow } from "@/lib/google/overlap";
import { accessTokenFor } from "@/lib/google/token";

/**
 * Looks at the calendar again, for every Appointment that could still be
 * called.
 *
 * **Why this exists at all.** ADR-0004's push-time read catches an owner event
 * that was already sitting in the window when Callzie booked. It cannot catch
 * the far more likely case: the owner adds a conflicting event an *hour after*
 * the booking. Nothing pushes then, so nothing looks. This is what looks.
 *
 * It is triggered from Overview, not Schedule. Schedule is a pure Server
 * Component with no client JavaScript at all, and #18's design says to cut that
 * screen if interaction starts creeping into it. Overview already has client
 * components, so the trigger costs nothing new there.
 *
 * **One HTTP request, whatever the answer.** The Appointments are collected
 * first, the widest window covering all of them is asked for once, and the
 * matching happens in memory. So a re-check costs the same whether the Business
 * has one upcoming Appointment or a hundred.
 */

/**
 * How far ahead to look, and how many rows to consider.
 *
 * `lib/business/needs-attention.ts` leaves this ticket a note: three of the four
 * Needs Attention reasons are bounded by "how much has gone wrong", and
 * `collision` is not — it is detected from a calendar with no Call involved, so
 * one sweep could write many rows at once. That note asks #20 to bound its own
 * detection rather than leave the panel to cap it, and these two constants are
 * where that happens.
 *
 * Fourteen days is comfortably past anything a Business is actively rebooking,
 * and a hundred rows is far inside `events.list`'s 250-event default page size
 * for any realistic calendar.
 */
const HORIZON_DAYS = 14;
const MAX_APPOINTMENTS = 100;

/** Raises Collisions for this Business, and reports how many were new. */
export async function recheckCollisions(
  businessId: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<number> {
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60_000);

  const rows = await db
    .select({
      id: schema.appointments.id,
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
      googleEventId: schema.appointments.googleEventId,
    })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        /*
          The same split the calendar itself mirrors. A cancelled or declined
          Appointment has no event and holds no Slot, so an overlap with it
          would be a Collision about something that is not happening.
        */
        inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
        gt(schema.appointments.startsAt, now),
        lt(schema.appointments.startsAt, horizon),
      ),
    )
    // Covered by `appointments_business_id_starts_at_idx`.
    .orderBy(asc(schema.appointments.startsAt))
    .limit(MAX_APPOINTMENTS);

  if (rows.length === 0) return 0;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { timezone: true },
  });
  if (!business) return 0;

  const span = wholeDayWindow(rows, business.timezone);
  if (!span) return 0;

  // Last, so an unconnected Business costs two local queries and no network.
  const access = await accessTokenFor(businessId, fetchImpl);
  if (!access) return 0;

  const events = await listEvents({ ...access, ...span }, fetchImpl);

  return raiseCollisions(
    overlappingEventIds({
      events,
      windows: rows,
      timeZone: business.timezone,
    }),
  );
}

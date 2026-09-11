import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { NeedsAttentionReason } from "@/lib/db/schema";

/**
 * The Appointments a human has to deal with (SPEC.md §11.3 item 3).
 *
 * **A second query rather than a filter over `listAppointments`.** That one is
 * capped at 20 rows and ordered for the table; an Appointment carrying a reason
 * and sitting at position 21 would silently disappear from the surface that
 * exists to show it. Truncating this list would hide exactly the thing it is
 * for, so there is no cap.
 *
 * **How big can it get?** Today, small: three of the four reasons are written by
 * a Call ending badly, and `businesses.call_quota` defaults to 5. `collision` is
 * the exception and does not fit that bound at all — #20 will detect it from the
 * connected Google Calendar, with no Call involved, so one sync could write many
 * rows at once. **#20 should revisit this**, either with a cap here or by
 * bounding its own detection. Saying "bounded by how much has gone wrong" and
 * leaving it would be true right up until the ticket that makes it false.
 *
 * An explicit `innerJoin` rather than the relational query API, because no
 * `relations()` are declared anywhere in this repo — `lib/db/schema.ts` wires
 * tables with FK `.references()` only. Same call `lib/business/list-appointments.ts`
 * documents.
 *
 * Ordered soonest first, and past-due rows therefore sort to the top. That is
 * deliberate: an Appointment whose time has gone is not stale, it is a Slot
 * still held against a calendar for somebody nobody managed to reach. It is the
 * most urgent thing here, not the least.
 */

export type NeedsAttentionRow = {
  id: string;
  name: string;
  startsAt: Date;
  serviceName: string;
  reason: NeedsAttentionReason;
  /** How many Calls have been placed. The `unreachable` sentence counts them. */
  attempts: number;
};

export async function listNeedsAttention(
  businessId: string,
): Promise<NeedsAttentionRow[]> {
  const rows = await db
    .select({
      id: schema.appointments.id,
      name: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      serviceName: schema.services.name,
      reason: schema.appointments.needsAttentionReason,
      /*
        A correlated subquery rather than a join plus GROUP BY. The join would
        have to be a LEFT JOIN — a Collision carries a reason with no Call behind
        it (#20 detects it from the calendar) — and grouping every column of the
        Appointment to count a child table is more SQL to read for no gain.

        `lib/business/list-appointments.ts` counts the same thing a different
        way, with a second query folded in with JavaScript, and the difference
        is not an oversight. That file needs more than a count: the id and time
        of the most recent Call as well. One pass over the rows gives it all
        three. This file wants a number and nothing else, and a subquery is the
        shortest thing that produces one. Both land on the same number for the
        same Appointment, which is what matters — the panel's sentence and the
        table's Attempts column sit on the same screen.
      */
      attempts: sql<number>`(
        SELECT count(*)::int FROM ${schema.calls}
         WHERE ${schema.calls.appointmentId} = ${schema.appointments.id}
      )`,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        isNotNull(schema.appointments.needsAttentionReason),
      ),
    )
    // Covered by `appointments_business_id_starts_at_idx`.
    .orderBy(asc(schema.appointments.startsAt));

  /*
    Narrowing `reason` from "one of four, or null" to "one of four", without a
    cast. The WHERE clause above excludes nulls in the same query against the
    same snapshot, so the empty branch is unreachable — it is here to satisfy
    the type, not as a fallback anybody should lean on.

    Worth being clear about that, because if it ever did fire, dropping the row
    would be the wrong answer. An Appointment carrying a reason is blocked from
    calling, and this is the one screen that can unblock it; vanishing from here
    would leave somebody uncallable with nothing on the page to say why.
  */
  return rows.flatMap((row) =>
    row.reason === null ? [] : [{ ...row, reason: row.reason }],
  );
}

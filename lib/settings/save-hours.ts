import { and, eq, notInArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { WeekdayHours } from "@/lib/settings/weekdays";

/**
 * Replaces a Business's weekly opening windows with the submitted set.
 *
 * **Upsert then prune, never delete-then-insert.** Delete-then-insert is the
 * obvious way to write "make the table match this list", and it is the one thing
 * #5 rules out: the window between the two statements is a window in which the
 * Business has no hours at all, and a failure inside it — a constraint, a lost
 * connection, a rollback that the caller swallows — leaves an account that can
 * offer no Slot and take no booking. `business_hours` carries
 * `UNIQUE(business_id, weekday)` precisely so the write can be an upsert on that
 * index instead, which never passes through the empty state.
 *
 * A closed day is represented by the **absence** of a row. The schema has no
 * `closed` column and does not need one: Availability reads the rows that exist,
 * so a weekday with no row is a weekday with no opening window. That is why the
 * second statement is a delete rather than a flag update, and why
 * `appointmentsOutsideHours` treats a missing weekday as closed too.
 *
 * Both statements share one transaction, so the pruned days and the saved ones
 * become visible together. A reader mid-save must never see Tuesday's new hours
 * alongside a Wednesday that was meant to close in the same submission.
 */
export async function saveBusinessHours(
  businessId: string,
  hours: readonly WeekdayHours[],
): Promise<void> {
  const openWeekdays = hours.map((day) => day.weekday);

  await db.transaction(async (tx) => {
    if (hours.length > 0) {
      await tx
        .insert(schema.businessHours)
        .values(
          hours.map((day) => ({
            businessId,
            weekday: day.weekday,
            opensAt: day.opensAt,
            closesAt: day.closesAt,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.businessHours.businessId, schema.businessHours.weekday],
          /*
            `excluded` rather than bound parameters: all seven weekdays go in one
            INSERT, so each conflicting row has to take *its own* proposed values.
            A plain `set: { opensAt: someString }` could only name one day's
            times and would stamp them across every row that conflicted.

            Spelled with the physical column names, not the Drizzle properties:
            interpolating a column object into `sql` emits it table-qualified,
            and `excluded."business_hours"."opens_at"` is not valid SQL.
          */
          set: {
            opensAt: sql`excluded.opens_at`,
            closesAt: sql`excluded.closes_at`,
          },
        });
    }

    /*
      Everything not submitted as open is now closed. `notInArray` with an empty
      list compiles to `true` in Drizzle, so the no-open-days case deletes every
      row — which is the correct semantic even though `parseBusinessHoursInput`
      refuses to produce it, and is why this needs no special-casing.
    */
    await tx
      .delete(schema.businessHours)
      .where(
        and(
          eq(schema.businessHours.businessId, businessId),
          notInArray(schema.businessHours.weekday, openWeekdays),
        ),
      );
  });
}

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Writes the `collision` Needs Attention reason, and remembers what it wrote.
 *
 * SPEC.md §5 lists four reasons that all land on the same surface, and this is
 * the writer for the one nothing has ever written: `collision`, set when the
 * Business's Google Calendar holds something in an Appointment's window
 * (ADR-0004). #15 already renders it, already refuses to place a Call for it,
 * and already gives a human a Clear action. This supplies the write.
 *
 * **The whole difficulty is Clear.** A human clears a Collision, the next
 * re-check reads the same window, sees the same overlapping event, and writes
 * `collision` straight back. The row reappears within seconds and the button
 * looks broken.
 *
 * Re-raising is not *wrong* — the overlap is still real. But Clear means "I have
 * seen this", not "this is fixed" (`lib/appointments/clear-attention.ts` is
 * explicit about that), and a button whose effect vanishes is not a button.
 *
 * So Callzie remembers the Google event ids it has already reported, in
 * `appointments.collision_event_ids`, and the rule becomes a set subtraction:
 * overlapping events found, minus events already reported. Raise only if
 * something is left. `clearNeedsAttention` writes one column and this is not it,
 * which is what makes the clear survive.
 *
 * A genuinely new conflicting event has an id that is not in the list, so it
 * still raises. That is the behaviour worth protecting — the clear is permanent
 * for what was cleared, not for the Appointment forever.
 */

/**
 * Raises a Collision on each Appointment carrying an overlap it has not already
 * been told about. Returns how many were newly flagged.
 *
 * The count is what the caller uses to decide whether to revalidate a page.
 * Returning zero when nothing changed is what stops the on-screen re-check
 * becoming a render loop.
 */
export async function raiseCollisions(
  found: ReadonlyMap<string, string[]>,
): Promise<number> {
  if (found.size === 0) return 0;

  const rows = await db
    .select({
      id: schema.appointments.id,
      reason: schema.appointments.needsAttentionReason,
      seen: schema.appointments.collisionEventIds,
    })
    .from(schema.appointments)
    .where(inArray(schema.appointments.id, [...found.keys()]));

  let raised = 0;

  for (const row of rows) {
    /*
      Already carrying a reason — skip entirely, and note that "entirely"
      includes NOT recording the event ids.

      Skipping the write is obvious: the Appointment is already blocked from
      calling, and overwriting `book_failed` with `collision` would lose why it
      was flagged in the first place.

      Not recording the ids is the subtle half. If they were appended here, a
      human clearing the `book_failed` would silently clear a Collision that was
      never shown to anyone — the surface would go quiet about a conflict that
      is still on the calendar. Leaving the list alone means the next re-check
      after the clear raises it properly.
    */
    if (row.reason !== null) continue;

    const seen = row.seen ?? [];
    const overlapping = found.get(row.id) ?? [];
    const fresh = overlapping.filter((id) => !seen.includes(id));

    // Every overlap here has already been reported. This is the clear holding.
    if (fresh.length === 0) continue;

    const updated = await db
      .update(schema.appointments)
      .set({
        needsAttentionReason: "collision",
        collisionEventIds: [...seen, ...fresh],
      })
      .where(
        and(
          eq(schema.appointments.id, row.id),
          /*
            Both guards live in the WHERE rather than in an `if` above it — the
            shape `flagTruncated` uses in lib/calls/record.ts.

            `isNull(reason)` re-checks the skip above against the same statement
            that writes, so a Call that flagged this Appointment between the
            read and the write is not overwritten.

            `eq(collisionEventIds, seen)` is a compare-and-set. A concurrent
            sync that already appended cannot have this one's stale copy of the
            list written over the top of it — the second write matches no row
            and reports nothing raised, which is the honest answer.
          */
          isNull(schema.appointments.needsAttentionReason),
          eq(schema.appointments.collisionEventIds, seen),
        ),
      )
      .returning({ id: schema.appointments.id });

    if (updated.length > 0) raised += 1;
  }

  return raised;
}

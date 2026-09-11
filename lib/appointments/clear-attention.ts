import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * A human has looked at this Appointment. Callzie may call it again.
 *
 * SPEC.md §5: clearing is the only resolution — Callzie never resolves a Needs
 * Attention itself. So this is the one write that takes an Appointment out of
 * the state, and it is triggered by a person pressing a button and by nothing
 * else.
 *
 * **One column.** Not the Slot, not the status, not the Call history. Clearing
 * says "somebody has seen this", not "this turned out to be fine" — an
 * Appointment cleared after an unreachable Call is callable again and still
 * honestly `unreachable` until a Call proves otherwise.
 *
 * Scoped to the Business inside the WHERE clause rather than by a read followed
 * by a check, the same shape as `ownedBy` in lib/calls/record.ts. An
 * Appointment id from another account matches nothing and writes nothing, so
 * there is no branch that could act on one.
 *
 * Silent on a row that was already clear. A Server Action is a POST anyone can
 * send twice, and a double-press is not an error worth a message.
 *
 * **#20, when you add the `collision` writer:** `app/(app)/actions.ts` only
 * revalidates `/` after calling this. Schedule reads this column too — it is
 * what marks a Collision in the day grid — so clearing one from Overview will
 * leave `/schedule` stale until something else re-renders it. That cannot
 * happen today, because nothing writes `collision` yet. It can the day you do.
 */
export async function clearNeedsAttention(
  businessId: string,
  appointmentId: string,
): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: null })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.businessId, businessId),
      ),
    );
}

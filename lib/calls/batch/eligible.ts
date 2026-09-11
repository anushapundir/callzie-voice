import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Which Appointments Call All may call (issue #17), and how much Quota is left
  to call them with.
*/

/**
 * The callable Appointments, soonest first.
 *
 * Three conditions, each earning its place:
 *
 * - `pending` — anything confirmed, rescheduled, declined or cancelled has an
 *   answer already, and anything `queued` or `calling` is in this batch.
 * - no `needs_attention_reason` — an Appointment carrying one is blocked from
 *   calling until a human clears it (issue #15). That is also what skips an
 *   `unreachable` one, which always carries the matching reason.
 * - `starts_at` in the future — phoning somebody to confirm a time that has
 *   already passed spends a Call on something that cannot change.
 *
 * Scoped to the Business inside the WHERE clause, never checked after the read.
 *
 * `now` is injected, matching lib/availability/slots.ts and
 * lib/business/active-calls.ts, so a test does not depend on the clock it runs
 * at.
 */
export async function eligibleAppointmentIds(
  businessId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "pending"),
        isNull(schema.appointments.needsAttentionReason),
        gt(schema.appointments.startsAt, now),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt));

  return rows.map((row) => row.id);
}

/**
 * How many Calls the Quota still allows — a **preview**, not a guarantee.
 *
 * The real bound is `claimCallQuota`'s single UPDATE, and this number can be
 * stale the instant it is read: another tab pressing "Call now" moves it. It
 * exists so the confirmation sheet can say something true at the moment it
 * opens, and so a batch does not queue rows it can never place.
 *
 * `Infinity` for an admin account, which has no bound (SPEC.md §11.1). Callers
 * that send this to the browser turn it into `null` first.
 */
export async function quotaRemaining(businessId: string): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { callQuota: true, callsUsed: true, isAdmin: true },
  });

  if (!business) return 0;
  if (business.isAdmin) return Number.POSITIVE_INFINITY;

  return Math.max(0, business.callQuota - business.callsUsed);
}

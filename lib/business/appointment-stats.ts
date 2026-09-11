import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * The four numbers in Overview's stat strip (SPEC.md §11.3).
 *
 * Two aggregates rather than one query with a join, because joining
 * `appointments` to `calls` multiplies the Appointment rows by their Calls and
 * every count on the Appointment side would then be wrong.
 *
 * Counted over **every** Appointment the Business has, not only the ones still
 * ahead. The seeded demo rows age past their start time within days, and a
 * strip that emptied itself as they did would make a returning demo account
 * look broken.
 */

export type AppointmentStats = {
  total: number;
  confirmed: number;
  needsAttention: number;
  /** Calls that left the queue — the analytics card's headline number. */
  callsPlaced: number;
  /**
   * Completed Calls over Calls that left the queue.
   *
   * `null`, not 0, when no Call has ever been placed — which is every account
   * until #11 lands. The strip renders null as "—". Showing 0% would claim a
   * dialler had tried and failed.
   */
  answerRate: number | null;
};

export async function appointmentStats(
  businessId: string,
): Promise<AppointmentStats> {
  /*
    `count(*) FILTER (WHERE ...)` is Postgres's conditional count. The `::int`
    casts are load-bearing: `count()` returns `bigint`, which `pg` hands back as
    a *string* to avoid losing precision, and a string would flow all the way
    into the rendered tile. The extra parentheses are needed because `::` binds
    tighter than the FILTER clause.
  */
  const [counts] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      confirmed: sql<number>`(count(*) filter (where ${schema.appointments.status} = 'confirmed'))::int`,
      // From the reason, never the status. SPEC.md §5 makes the two orthogonal:
      // an Appointment can be confirmed *and* collided.
      needsAttention: sql<number>`(count(*) filter (where ${schema.appointments.needsAttentionReason} is not null))::int`,
    })
    .from(schema.appointments)
    .where(eq(schema.appointments.businessId, businessId));

  const [calls] = await db
    .select({
      placed: sql<number>`(count(*) filter (where ${schema.calls.status} <> 'queued'))::int`,
      answered: sql<number>`(count(*) filter (where ${schema.calls.status} = 'completed'))::int`,
    })
    .from(schema.calls)
    // Scoped through the Appointment, because `calls` carries no business_id.
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(eq(schema.appointments.businessId, businessId));

  return {
    total: counts.total,
    confirmed: counts.confirmed,
    needsAttention: counts.needsAttention,
    callsPlaced: calls.placed,
    answerRate: calls.placed === 0 ? null : calls.answered / calls.placed,
  };
}

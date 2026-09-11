import { and, eq, gt } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Which Calls are live right now — the topbar's pulsing dot (SPEC.md §11.1) and
  the shimmer on the row being called (§11.2).

  Both read `in_progress` AND a recent `started_at`, and the second half is what
  makes this correct. Until #13's webhook receiver exists, the browser is the
  only thing that reports a Call ending. A closed tab reports nothing, so the row
  stays `in_progress` forever and the dot would pulse for the life of the
  account.

  A Call cannot outlive `max_call_duration_ms` (SPEC.md §7), so anything older
  than that plus slack is not live whatever the column says. The staleness is
  computed at read time: no background job, no cleanup process, nothing to
  schedule, and nothing that can itself fail and leave the truth stale.

  Note this deliberately does NOT correct the row. The row stays wrong until
  #13's webhook writes the real ending — this only stops a wrong row from
  driving the UI. Rewriting history from a guess is how a Call's record stops
  being a record.
*/

/** The 180s cap (SPEC.md §7) plus a minute of slack. */
export const LIVE_CALL_STALENESS_MS = 240_000;

function liveSince(now: Date): Date {
  return new Date(now.getTime() - LIVE_CALL_STALENESS_MS);
}

/**
 * How many Calls this Business has in progress.
 *
 * `now` is injected, matching `slots.ts` and `seed-schedule.ts`, so a test does
 * not depend on the clock it runs at.
 */
export async function countActiveCalls(
  businessId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await liveCalls(businessId, now)).length;
}

/** The Appointments whose rows should shimmer. */
export async function liveCallAppointmentIds(
  businessId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  return new Set(
    (await liveCalls(businessId, now)).map((call) => call.appointmentId),
  );
}

export type LiveCall = {
  appointmentId: string;
  /** Who Maya is talking to — the Appointment's name. */
  name: string;
  startedAt: Date | null;
};

/**
 * The live Calls with who they are talking to — Overview's live-calls card.
 * Same definition of "live" as the counters above, so the card, the topbar dot
 * and the shimmering row can never disagree.
 */
export async function listLiveCalls(
  businessId: string,
  now: Date = new Date(),
): Promise<LiveCall[]> {
  return liveCalls(businessId, now);
}

/**
 * The join all three readers share.
 *
 * Scoped through `appointments` to the Business, so one account can never see
 * another's Call in its topbar.
 *
 * **Outbound only, and by construction rather than by a condition.** The inner
 * join needs an Appointment, and an inbound Call has none (issue #43), so
 * inbound traffic cannot appear here. That is what these three readers want:
 * all of them exist to point at a row in the Appointments table — the shimmer
 * needs one to shimmer, and the live-calls card names the person Maya is
 * calling. An inbound Call has no row to point at and no name until the caller
 * gives one.
 */
async function liveCalls(businessId: string, now: Date) {
  return db
    .select({
      /*
        Read off `appointments`, not off `calls`. The join proves the two are
        equal, and this side is NOT NULL — `calls.appointment_id` is nullable
        since issue #43, so selecting it would hand every caller a
        `string | null` that the join has already ruled out.
      */
      appointmentId: schema.appointments.id,
      name: schema.appointments.name,
      startedAt: schema.calls.startedAt,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.calls.status, "in_progress"),
        gt(schema.calls.startedAt, liveSince(now)),
      ),
    );
}

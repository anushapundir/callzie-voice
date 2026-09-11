import { and, asc, count, eq, gte, inArray } from "drizzle-orm";

import { liveCallAppointmentIds } from "@/lib/business/active-calls";
import { db, schema } from "@/lib/db";
import type { AppointmentStatus, NeedsAttentionReason } from "@/lib/db/schema";
import { TEMPLATES } from "@/lib/onboarding/templates";

/**
 * The Appointments Overview renders.
 *
 * An explicit `innerJoin` rather than `db.query.appointments.findMany({ with:
 * { service: true } })`, because **no `relations()` are declared anywhere in
 * this repo** — `lib/db/schema.ts` wires tables together with FK
 * `.references()` only, and the relational query API needs more than that.
 * Adding `relations()` is a schema-wide convention change with its own
 * trade-offs, not something to slip into a feature ticket.
 *
 * Returns a narrow row rather than the table's own shape: a Server Action's and
 * a Server Component's output both cross to the client, and neither should
 * carry columns the UI does not render.
 *
 * **There are two readers here, and they want opposite things.**
 *
 * `listAppointments` is the plain one: every Appointment a Business has,
 * oldest first, no time filter. Settings needs exactly that — when somebody
 * narrows their opening hours it has to check *past* rows too, so a filter
 * there would silently stop reporting half the conflicts.
 *
 * `listUpcomingAppointments` is what Overview's table uses. Overview is a
 * working screen, not a history screen: after a few weeks the plain list is
 * nothing but appointments that already happened, and the twenty rows it caps
 * at are the twenty oldest ones. So it looks forward instead, and it returns a
 * total alongside the rows so the table can say "20 of 47" rather than quietly
 * hiding the rest.
 */

export type AppointmentRow = {
  id: string;
  name: string;
  phoneE164: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  /**
   * Non-null means Callzie will not call this person again until a human clears
   * it (SPEC.md §5). The table reads it to disable "Call now"; the refusal
   * itself lives on the server in `lib/calls/start-web-call.ts`.
   */
  needsAttentionReason: NeedsAttentionReason | null;
  /** How many Calls have been placed for this Appointment. */
  attempts: number;
  /** The most recent Call, or null if none has been placed. */
  lastCallId: string | null;
  /** When that Call was placed. The table shows this and links it to the id. */
  lastCallAt: Date | null;
  /**
   * True while a Call for this Appointment is live, so the row shimmers
   * (SPEC.md §11.2). Decided here rather than in the component, which keeps
   * `appointments-table.tsx` a Server Component with nothing to work out.
   */
  isCalling: boolean;
  /**
   * This row came from the Template that set the account up, not from a real
   * customer. The table tags it, because five plausible names and five
   * plausible phone numbers otherwise look like five people waiting for a call.
   */
  isExample: boolean;
};

/** The columns every reader below wants, written once. */
const SELECTION = {
  id: schema.appointments.id,
  name: schema.appointments.name,
  phoneE164: schema.appointments.phoneE164,
  serviceName: schema.services.name,
  startsAt: schema.appointments.startsAt,
  endsAt: schema.appointments.endsAt,
  status: schema.appointments.status,
  needsAttentionReason: schema.appointments.needsAttentionReason,
};

/*
  Every phone number the four Templates seed, gathered once at module load.

  Deliberately **not** `checkDestination`'s `RESERVED_FICTIONAL` regex, even
  though every one of these numbers matches it. That regex answers "may this be
  dialled" and covers the whole reserved block; this answers "did this row come
  out of the seed", and someone who types a fictional number by hand has typed a
  row of their own. Two questions, two lookups.
*/
const EXAMPLE_PHONES = new Set(
  Object.values(TEMPLATES).flatMap((template) =>
    template.appointments.map((appointment) => appointment.phoneE164),
  ),
);

/**
 * How far back Overview's table looks: one day.
 *
 * Not zero. Somebody who did not answer at 9am this morning is still a person
 * you are chasing at 4pm, and a table that dropped them the moment their slot
 * passed would hide the row you were about to press "Call now" on again.
 * Anything older than that is history, and Calls is the screen for history.
 */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function listAppointments(
  businessId: string,
  limit = 20,
): Promise<AppointmentRow[]> {
  const appointments = await db
    .select(SELECTION)
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .where(eq(schema.appointments.businessId, businessId))
    // Covered by `appointments_business_id_starts_at_idx`.
    .orderBy(asc(schema.appointments.startsAt))
    .limit(limit);

  return withCallSummaries(businessId, appointments);
}

/**
 * Overview's table: the soonest appointments first, and how many there are in
 * total.
 *
 * `total` counts the rows inside the same window, never every row the Business
 * has ever had. If it counted everything, "20 of 47" would promise 27 rows this
 * table can never reach, which is a worse lie than showing no count at all.
 *
 * `now` is injected, matching `lib/business/active-calls.ts`, so a test does not
 * depend on the clock it runs at.
 */
export async function listUpcomingAppointments(
  businessId: string,
  limit = 20,
  now: Date = new Date(),
): Promise<{ rows: AppointmentRow[]; total: number }> {
  const window = and(
    eq(schema.appointments.businessId, businessId),
    gte(schema.appointments.startsAt, new Date(now.getTime() - LOOKBACK_MS)),
  );

  const [appointments, [counted]] = await Promise.all([
    db
      .select(SELECTION)
      .from(schema.appointments)
      .innerJoin(
        schema.services,
        eq(schema.appointments.serviceId, schema.services.id),
      )
      .where(window)
      // Ascending inside a window that starts yesterday means the nearest
      // appointment is the top row. Covered by
      // `appointments_business_id_starts_at_idx`.
      .orderBy(asc(schema.appointments.startsAt))
      .limit(limit),
    // No join here: counting through `services` would be the same number for
    // more work, because every Appointment has exactly one Service.
    db.select({ value: count() }).from(schema.appointments).where(window),
  ]);

  return {
    rows: await withCallSummaries(businessId, appointments),
    total: counted.value,
  };
}

/** The plain Appointment rows, plus everything that comes off `calls`. */
async function withCallSummaries(
  businessId: string,
  appointments: AppointmentBase[],
): Promise<AppointmentRow[]> {
  if (appointments.length === 0) return [];

  /*
    A second query, folded in with JavaScript, rather than a lateral join or a
    window function.

    `businesses.call_quota` defaults to 5, so an account holds at most five
    `calls` rows in total — "load every Call for these Appointments" is bounded
    by the quota, not by the table. A DISTINCT ON would be more SQL to read for
    no measurable gain at that size.
  */
  const calls = await db
    .select({
      id: schema.calls.id,
      appointmentId: schema.calls.appointmentId,
      attempt: schema.calls.attempt,
      createdAt: schema.calls.createdAt,
    })
    .from(schema.calls)
    .where(
      inArray(
        schema.calls.appointmentId,
        appointments.map((a) => a.id),
      ),
    );

  type LastCall = { id: string; attempt: number; createdAt: Date | null };
  type CallSummary = { attempts: number; last: LastCall };
  const summaries = new Map<string, CallSummary>();
  for (const call of calls) {
    /*
      Unreachable, and here to narrow rather than to handle. SQL's `IN` never
      matches NULL, so the `inArray` above has already excluded every inbound
      Call — but `calls.appointment_id` is nullable since issue #43 and the
      compiler cannot know what the query proved.
    */
    if (call.appointmentId === null) continue;

    const found = summaries.get(call.appointmentId);
    if (!found) {
      summaries.set(call.appointmentId, { attempts: 1, last: call });
      continue;
    }
    found.attempts += 1;
    // Highest attempt number wins. A second Call is attempt 2 by definition
    // (SPEC.md §5), so this orders them without needing a timestamp.
    if (call.attempt > found.last.attempt) {
      found.last = call;
    }
  }

  /*
    Which of these are being called right now. A separate read rather than a
    filter over `calls` above, because "live" is not a column — it is
    `in_progress` AND recent, and that staleness rule lives in one place so the
    topbar's count and the row's shimmer can never disagree.
  */
  const live = await liveCallAppointmentIds(businessId);

  return appointments.map((appointment) => {
    const summary = summaries.get(appointment.id);
    return {
      ...appointment,
      attempts: summary?.attempts ?? 0,
      lastCallId: summary?.last.id ?? null,
      lastCallAt: summary?.last.createdAt ?? null,
      isCalling: live.has(appointment.id),
      isExample: EXAMPLE_PHONES.has(appointment.phoneE164),
    };
  });
}

/** What a `SELECTION` row looks like once the database hands it back. */
type AppointmentBase = Omit<
  AppointmentRow,
  "attempts" | "lastCallId" | "lastCallAt" | "isCalling" | "isExample"
>;

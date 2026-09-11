import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import { raiseCollisions } from "@/lib/google/collision";
import {
  deleteEvent,
  insertEvent,
  listEvents,
  patchEvent,
} from "@/lib/google/events";
import {
  overlappingEventIds,
  wholeDayWindow,
  type AppointmentWindow,
} from "@/lib/google/overlap";
import { accessTokenFor } from "@/lib/google/token";

/**
 * Makes the Business's Google Calendar agree with one Appointment, then checks
 * whether anything else is sitting in that window.
 *
 * **One function, and callers never pick a verb.** Everywhere an Appointment is
 * created, moved or ended says the same thing — "this one changed" — and this
 * decides whether that means insert, patch, delete or nothing. The rule it
 * enforces is one sentence:
 *
 * > The connected calendar holds exactly one event for every Appointment
 * > holding a Slot, and none for any Appointment that is not.
 *
 * That sentence is already in the schema. `SLOT_HOLDING_STATUSES` is imported
 * rather than re-listed here on purpose: it is the same split the
 * `appointments_no_overlap` exclusion constraint uses, so the calendar and the
 * constraint cannot end up disagreeing about which Appointments are real. If
 * this file listed the statuses itself, the day somebody adds an eighth status
 * is the day Google starts holding events for Slots Postgres has released.
 *
 * **Safe to run twice**, which is the entire retry story. Everything here runs
 * inside `after()`, which offers no delivery guarantee, so the answer to a lost
 * push is the next push rather than a queue.
 *
 * **It reads the row itself** rather than accepting one from the caller. A
 * stale row could push a time Postgres has already moved past; reading here
 * means Google can only ever be told something that was true in the database.
 *
 * **Nothing here throws.** ADR-0004 requires Callzie to be fully functional for
 * a Business that never connects Google, and a Business whose calendar broke
 * this morning is in exactly that position. A Google failure is logged and the
 * Appointment is left alone — in particular it does **not** raise a Needs
 * Attention row, because there are four reasons and none of them is "the push
 * failed". A Google outage must not fill that surface with rows about Google.
 */
export async function syncAppointmentToGoogle(
  appointmentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await reconcile(appointmentId, fetchImpl);
  } catch (error) {
    /*
      The outermost guard, and it has to be here. This runs after the response
      has been sent, so an escaping rejection is an unhandled rejection in a
      server process rather than a failed request somebody sees.
    */
    console.error(
      `Could not sync appointment ${appointmentId} to Google Calendar`,
      error,
    );
  }
}

async function reconcile(
  appointmentId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const [row] = await db
    .select({
      id: schema.appointments.id,
      businessId: schema.appointments.businessId,
      name: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
      status: schema.appointments.status,
      googleEventId: schema.appointments.googleEventId,
      serviceName: schema.services.name,
      timezone: schema.businesses.timezone,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(eq(schema.appointments.id, appointmentId))
    .limit(1);

  if (!row) return;

  const holdsSlot = (
    SLOT_HOLDING_STATUSES as readonly string[]
  ).includes(row.status);

  // Nothing to add and nothing to remove. Checked before the token so an
  // unconnected Business costs one query rather than a network round trip.
  if (!holdsSlot && !row.googleEventId) return;

  const access = await accessTokenFor(row.businessId, fetchImpl);
  if (!access) return;

  const { accessToken, calendarId } = access;

  if (!holdsSlot) {
    /*
      Cancelled or declined. `SLOT_FREEING_STATUSES` is the other half of the
      same split, so this branch and the constraint free the range together.

      The column is nulled only after Google has confirmed. A 404 or 410 counts
      as confirmation — the goal is that the event is not on the calendar, and
      in both of those cases it is not.
    */
    await deleteEvent(
      { accessToken, calendarId, eventId: row.googleEventId! },
      fetchImpl,
    );
    await db
      .update(schema.appointments)
      .set({ googleEventId: null })
      .where(eq(schema.appointments.id, row.id));
    return;
  }

  const eventId = row.googleEventId
    ? await moveExisting(row, { accessToken, calendarId }, fetchImpl)
    : await createNew(row, { accessToken, calendarId }, fetchImpl);

  // The insert lost its race and another sync owns the event. That sync will
  // run this check itself; doing it twice would be a wasted request.
  if (!eventId) return;

  await checkForCollision(
    { ...row, googleEventId: eventId },
    { accessToken, calendarId },
    fetchImpl,
  );
}

type Row = {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  googleEventId: string | null;
  serviceName: string;
  timezone: string;
};

type Access = { accessToken: string; calendarId: string };

async function moveExisting(
  row: Row,
  { accessToken, calendarId }: Access,
  fetchImpl: typeof fetch,
): Promise<string> {
  await patchEvent(
    {
      accessToken,
      calendarId,
      eventId: row.googleEventId!,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      timeZone: row.timezone,
    },
    fetchImpl,
  );

  return row.googleEventId!;
}

/**
 * Creates the event, then claims it with a compare-and-set.
 *
 * **The race this closes.** Two syncs for the same Appointment could both read
 * `google_event_id` as null and both insert, leaving one id stored and one
 * event orphaned on the owner's real calendar forever. Nothing would ever clean
 * it up, and it would then be detected as a Collision against the very
 * Appointment it belongs to.
 *
 * So the write-back carries its guard in the `WHERE` — the shape
 * `releaseAppointment` uses in lib/calls/record.ts — and the loser tidies up
 * after itself. Losing is rare and costs one delete; an orphan on somebody's
 * calendar is neither rare enough nor cheap enough to accept.
 */
async function createNew(
  row: Row,
  { accessToken, calendarId }: Access,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const eventId = await insertEvent(
    {
      accessToken,
      calendarId,
      // The owner is looking at their own calendar, where "Appointment" tells
      // them nothing. Name and Service is what makes the entry useful.
      summary: `${row.name} — ${row.serviceName}`,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      timeZone: row.timezone,
    },
    fetchImpl,
  );

  const claimed = await db
    .update(schema.appointments)
    .set({ googleEventId: eventId })
    .where(
      and(
        eq(schema.appointments.id, row.id),
        isNull(schema.appointments.googleEventId),
      ),
    )
    .returning({ id: schema.appointments.id });

  if (claimed.length > 0) return eventId;

  await deleteEvent({ accessToken, calendarId, eventId }, fetchImpl);
  return null;
}

/**
 * ADR-0004's second read.
 *
 * Google Calendar permits overlapping events and `events.insert` documents no
 * conflict handling, so the write cannot report a clash. Detection has to be a
 * deliberate look afterwards, and this is it.
 *
 * The window is the Appointment's **whole local day**, not its own 45 minutes —
 * see `wholeDayWindow` for why an all-day event forces that.
 */
async function checkForCollision(
  row: Row & { googleEventId: string },
  { accessToken, calendarId }: Access,
  fetchImpl: typeof fetch,
): Promise<void> {
  const window: AppointmentWindow = {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    googleEventId: row.googleEventId,
  };

  const span = wholeDayWindow([window], row.timezone);
  if (!span) return;

  const events = await listEvents(
    { accessToken, calendarId, ...span },
    fetchImpl,
  );

  await raiseCollisions(
    overlappingEventIds({ events, windows: [window], timeZone: row.timezone }),
  );
}

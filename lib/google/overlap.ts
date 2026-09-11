import {
  addCalendarDays,
  todayInZone,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * Which Appointments overlap something on the Business's Google Calendar.
 *
 * This is the second read ADR-0004 describes. Google Calendar permits
 * overlapping events and its `events.insert` reference documents no conflict
 * handling, so nothing about the write tells Callzie a Slot was already taken.
 * Detection has to be a deliberate look afterwards, and this module is the rule
 * that look applies.
 *
 * **Pure on purpose.** No database, no `fetch`, no clock. The interesting
 * decisions here are arithmetic and filtering — does 09:45 touch 09:45, does an
 * all-day event count, is a Free-marked reminder a conflict — and none of them
 * should need a fake HTTP layer standing between the test and the rule.
 *
 * **It answers for many Appointments at once.** One `events.list` request
 * covers a whole span, and the matching happens here in memory. That is what
 * keeps a re-check at one HTTP call regardless of how many Appointments are
 * upcoming.
 */

/**
 * The parts of Google's Event resource this cares about.
 *
 * `start` and `end` each carry `dateTime` **or** `date`, never both: a timed
 * event uses the first, an all-day event the second. Both are modelled optional
 * because that is the truth of the payload — a type that promised `dateTime`
 * would lie at the first all-day event, which is precisely the case that
 * matters most here.
 */
export type CalendarEvent = {
  id: string;
  /** `confirmed` | `tentative` | `cancelled`. Absent means confirmed. */
  status?: string;
  /** `opaque` | `transparent`. **Absent means `opaque`** — see `isBusy`. */
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** One Appointment, as this module needs to see it. */
export type AppointmentWindow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  /** Callzie's own event for this Appointment, which can never be a Collision. */
  googleEventId: string | null;
};

/** An absolute span to ask Google about. */
export type CalendarWindow = { timeMin: Date; timeMax: Date };

/**
 * The span to request from Google, widened to whole local days.
 *
 * **Why whole days rather than just the Appointment's own window.** Google does
 * not document how a date-only event — an all-day "Vacation" — is compared
 * against `timeMin` and `timeMax`. The parameter docs describe the filter purely
 * in terms of an event's start and end time and say nothing about how
 * `"2026-08-25"` is resolved to an instant. Presumably it is midnight in the
 * calendar's zone, but presumption is not verification, and all-day events raise
 * a Collision here by decision, so the design cannot rest on it.
 *
 * Asking for the whole day means an all-day event on any day in range is
 * unambiguously inside the window however Google resolves it, and the
 * comparison below is done by us rather than by the query. Widening costs
 * nothing: the same single request, a few more events, filtered in memory.
 *
 * Both triggers use this, not just the bulk re-check. A push-time check for one
 * `14:00 → 14:45` Appointment still asks for that whole day, so there is no
 * second window size to remember.
 *
 * `null` for an empty list, so the caller skips the HTTP call rather than
 * asking Google about an empty range.
 */
export function wholeDayWindow(
  windows: readonly AppointmentWindow[],
  timeZone: string,
): CalendarWindow | null {
  if (windows.length === 0) return null;

  const earliest = new Date(
    Math.min(...windows.map((w) => w.startsAt.getTime())),
  );
  const latest = new Date(Math.max(...windows.map((w) => w.endsAt.getTime())));

  return {
    timeMin: startOfDay(todayInZone(earliest, timeZone), timeZone),
    // The day *after* the last one, so the final day is fully covered.
    timeMax: startOfDay(
      addCalendarDays(todayInZone(latest, timeZone), 1),
      timeZone,
    ),
  };
}

/**
 * Which Appointments overlap which events.
 *
 * Returns only Appointments with at least one overlap, so an empty Map means a
 * clean calendar and the caller has nothing to write.
 */
export function overlappingEventIds({
  events,
  windows,
  timeZone,
}: {
  events: readonly CalendarEvent[];
  windows: readonly AppointmentWindow[];
  timeZone: string;
}): Map<string, string[]> {
  /*
    Resolved once, ahead of the loop, rather than per Appointment. Every
    resolution of an all-day event runs Intl formatting through
    `zonedTimeToInstant`, and the same fifty events would otherwise be resolved
    once for each of a hundred Appointments.
  */
  const busy = events
    .filter(isBusy)
    .map((event) => ({ id: event.id, span: spanOf(event, timeZone) }))
    .filter((e): e is { id: string; span: Span } => e.span !== null);

  const found = new Map<string, string[]>();

  for (const window of windows) {
    const hits = busy
      /*
        Callzie's own event for this Appointment can never be a Collision. It is
        excluded by id rather than by comparing times, because the times match
        exactly by construction — this is the event we just wrote for it.

        Callzie cannot collide with *any* of its own Appointments anyway: the
        `appointments_no_overlap` exclusion constraint makes two overlapping
        Callzie Appointments impossible in Postgres. So anything left after this
        filter belongs to somebody else.
      */
      .filter((e) => e.id !== window.googleEventId)
      .filter((e) => overlaps(window, e.span))
      .map((e) => e.id);

    if (hits.length > 0) found.set(window.id, hits);
  }

  return found;
}

type Span = { start: Date; end: Date };

/**
 * Half-open overlap: strictly less, strictly greater.
 *
 * So `09:00 → 09:45` and `09:45 → 10:30` do **not** overlap. Back-to-back
 * bookings are the normal case in this product, not a conflict, and the same
 * half-open rule is what `appointments_no_overlap` uses on the Postgres side.
 */
function overlaps(window: AppointmentWindow, span: Span): boolean {
  return window.startsAt < span.end && window.endsAt > span.start;
}

/**
 * Whether this event blocks time, and still exists.
 *
 * **`transparency` is absent on most real events**, because `opaque` is
 * Google's documented default. Testing for `!== "opaque"` would therefore
 * ignore almost everything on a real calendar — the quiet way this whole
 * feature could ship appearing to work and detecting nothing. The test is the
 * other way round: only an explicit `transparent` is skipped.
 *
 * `cancelled` should not arrive at all, since `showDeleted` defaults to false
 * on `events.list`. It is filtered anyway because `get` and sync responses do
 * return them, and one filter is cheaper than one bug.
 */
function isBusy(event: CalendarEvent): boolean {
  return event.status !== "cancelled" && event.transparency !== "transparent";
}

/** An event's absolute span, or `null` if it carries neither shape. */
function spanOf(event: CalendarEvent, timeZone: string): Span | null {
  const { start, end } = event;
  if (!start || !end) return null;

  if (start.dateTime && end.dateTime) {
    const from = new Date(start.dateTime);
    const to = new Date(end.dateTime);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    return { start: from, end: to };
  }

  /*
    An all-day event, expanded to midnight-to-midnight in the **Business's**
    zone. It counts as a Collision by decision: if the owner has blocked the
    whole day out, every Appointment in it genuinely is a problem.

    `end.date` is EXCLUSIVE in Google's representation — a single day off on the
    25th arrives as start 2026-08-25, end 2026-08-26 — so it is used as the end
    instant directly. Adding a day here would make every all-day event bleed
    into the next one.
  */
  if (start.date && end.date) {
    const from = parseCivilDate(start.date);
    const to = parseCivilDate(end.date);
    if (!from || !to) return null;
    return { start: startOfDay(from, timeZone), end: startOfDay(to, timeZone) };
  }

  // Neither shape. Skipped rather than guessed at — a malformed event must not
  // become a Collision on somebody's Appointment.
  return null;
}

/** Midnight at the start of `date`, in `timeZone`. */
function startOfDay(date: CivilDate, timeZone: string): Date {
  return zonedTimeToInstant({ ...date, hour: 0, minute: 0 }, timeZone);
}

/** `"2026-08-25"` → a civil date, or `null` if it is not one. */
function parseCivilDate(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

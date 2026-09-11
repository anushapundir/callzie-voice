import {
  addCalendarDays,
  todayInZone,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * How the Schedule screen spells a day — in the URL, in a link, and in the
 * heading.
 *
 * All of it is pure so it can be tested without rendering a page. Which day the
 * screen shows has two failure modes worth pinning, and neither is reachable
 * from inside a Server Component in a test: an impossible date in the query
 * string, and "today" meaning the viewer's day rather than the Business's.
 */

/** The query key the day travels in: `/schedule?date=2026-08-19`. */
export const SCHEDULE_DATE_PARAM = "date";

/** A civil date as `2026-08-19`. */
export function formatDayParam(date: CivilDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * `"2026-08-19"` as a civil date, or `null` if it is not one.
 *
 * The format check alone is not enough. `2026-02-30` matches the pattern
 * perfectly, and `Date.UTC(2026, 1, 30)` accepts it and quietly rolls forward
 * to 2 March — so a naive parser would render "30 February" as 2 March and
 * never say a word.
 *
 * The fix is to normalise through the calendar and read the result back.
 * `addCalendarDays(date, 0)` does the roll-forward, and if what comes out does
 * not spell the same string, the date never existed. The same round trip
 * rejects `0050-01-01`, which `Date.UTC` reads as the year 1950.
 */
export function parseDayParam(value: string | null): CivilDate | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const normalised = addCalendarDays(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    0,
  );
  return formatDayParam(normalised) === value ? normalised : null;
}

/**
 * The day the screen should show.
 *
 * A bad `?date` is not an error page. Someone editing the URL by hand, or
 * following a stale link, lands on today — which is what they would have got
 * with no param at all.
 *
 * `now` is injected rather than read here, so "today" is assertable at a
 * boundary. It matters: 20:00 UTC is already tomorrow in Kolkata, and this must
 * resolve against the Business's clock rather than the server's or the
 * viewer's.
 */
export function resolveDay(
  value: string | null,
  now: Date,
  timezone: string,
): CivilDate {
  return parseDayParam(value) ?? todayInZone(now, timezone);
}

/** The link a day nav points at. */
export function scheduleHref(date: CivilDate): string {
  return `/schedule?${SCHEDULE_DATE_PARAM}=${formatDayParam(date)}`;
}

const HEADING_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The day as the heading writes it — `"Wed, 19 Aug 2026"`.
 *
 * `en-GB` for day-before-month, matching `formatInZone` in `lib/time/zone.ts`.
 * Two people looking at the same day must read the same heading, so the format
 * is fixed rather than following the viewer's locale.
 *
 * The instant handed to the formatter is **noon**, not midnight. A civil date
 * has no time of its own, and midnight is the one hour a DST transition can
 * push across a date boundary — a zone that springs forward at 00:00 would
 * render the heading as the following day. Noon is never within twelve hours of
 * a transition.
 */
export function formatDayHeading(date: CivilDate, timezone: string): string {
  let formatter = HEADING_FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    HEADING_FORMATTERS.set(timezone, formatter);
  }
  return formatter.format(
    zonedTimeToInstant({ ...date, hour: 12, minute: 0 }, timezone),
  );
}

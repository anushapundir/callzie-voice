/**
 * Wall-clock ↔ instant conversion in an IANA timezone, with no dependencies.
 *
 * SPEC.md §5 splits time in two: Business Hours are stored as local wall-clock
 * times and "resolved against [the Business timezone] — never as absolute
 * timestamps", while Appointments carry `timestamptz`. Something has to cross
 * that line, and this file is it. See ADR-0007 for why it is hand-rolled rather
 * than a `date-fns-tz` dependency, and for the DST semantics chosen below.
 *
 * The two rules that make this correct where naive implementations are not:
 *
 * 1. **Nothing rounds to whole hours.** Half- and quarter-hour zones are real
 *    (Asia/Kolkata +05:30, Asia/Kathmandu +05:45, Australia/Eucla +08:45) and
 *    Callzie's first market is one of them.
 * 2. **The offset is read at the instant, not at the zone.** A zone does not
 *    have "an" offset; it has one per moment. Every conversion here resolves
 *    the offset for the specific instant involved.
 */

/** A civil date-time — what a clock on the wall reads, with no offset attached. */
export type WallClock = {
  year: number;
  /** 1-12, unlike `Date`'s 0-11. Matching the wall clock, not the API. */
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** A civil date with no time — "which day is it there". */
export type CivilDate = Pick<WallClock, "year" | "month" | "day">;

/*
  Constructing an Intl.DateTimeFormat is the expensive part of every function
  below, and #6's Availability engine will call them once per candidate Slot.
  One formatter per zone, cached for the life of the process: the key space is
  bounded by the IANA catalogue (~600 entries), so this cannot grow unbounded.
*/
const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // `hourCycle: "h23"`, NOT `hour12: false`. The latter resolves to h24 on
      // some ICU builds, which renders midnight as hour "24" — a value
      // `Date.UTC` silently reads as 1am the next day.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PART_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** What the wall clock in `timeZone` reads at `instant`. */
export function partsInZone(
  instant: Date,
  timeZone: string,
): WallClock & { second: number } {
  const parts = partFormatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl returned no "${type}" part for zone "${timeZone}"`);
    }
    return Number(part.value);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The UTC offset of `timeZone` at `instant`, in milliseconds — positive east of
 * Greenwich, so `Asia/Kolkata` is +19,800,000 (5h30m).
 *
 * Derived rather than parsed: format the instant into the zone's wall clock,
 * then read that wall clock back as if it were UTC. The gap between the two is
 * the offset, by definition.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The formatter has no milliseconds to give back, so compare at second
  // granularity or every offset comes out short by `instant`'s sub-second part.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/**
 * The instant at which the clock in `timeZone` reads `wall`.
 *
 * DST makes this a relation rather than a function, so the two irregular cases
 * are resolved deliberately — matching Temporal's `disambiguation: "compatible"`,
 * so a future migration to Temporal is a straight swap:
 *
 * - **Ambiguous** wall clocks — the autumn hour that happens twice — resolve to
 *   the **earlier** (pre-transition) instant.
 * - **Nonexistent** wall clocks — the spring-forward hour that never happens —
 *   shift **forward** by the transition delta, so 02:30 on a US spring-forward
 *   Sunday becomes 03:30 local.
 *
 * Both offsets in play around the target day are tried and the results are
 * *verified* by reading them back, rather than trusting a single guess-and-
 * correct pass. A correction pass alone is not enough: it silently resolves a
 * spring-forward gap **backwards** (02:30 → 01:30) instead of forwards, and it
 * picks the later instant for an ambiguous time in a zone whose transition
 * falls on the far side of UTC midnight, such as `Pacific/Auckland`.
 */
export function zonedTimeToInstant(wall: WallClock, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
  );

  // A day either side brackets any transition near the target. Wider is not
  // safer: it would start sampling offsets from an unrelated part of the year.
  const before = zoneOffsetMs(new Date(asIfUtc - DAY_MS), timeZone);
  const after = zoneOffsetMs(new Date(asIfUtc + DAY_MS), timeZone);
  const offsets = before === after ? [before] : [before, after];

  const matches = offsets
    .map((offset) => asIfUtc - offset)
    // Verification, not arithmetic: an offset produces the right instant only if
    // the clock there actually reads back as `wall`.
    .filter((ms) => readsAs(new Date(ms), wall, timeZone));

  // Ambiguous times leave two matches; the earlier one wins.
  if (matches.length > 0) return new Date(Math.min(...matches));

  // No match means the wall clock never occurs — a gap. Applying the *larger*
  // pre-transition offset lands past the gap by exactly its width, which is the
  // forward shift.
  return new Date(asIfUtc - Math.min(before, after));
}

/** Whether the clock in `timeZone` reads exactly `wall` at `instant`. */
function readsAs(instant: Date, wall: WallClock, timeZone: string): boolean {
  const p = partsInZone(instant, timeZone);
  return (
    p.year === wall.year &&
    p.month === wall.month &&
    p.day === wall.day &&
    p.hour === wall.hour &&
    p.minute === wall.minute
  );
}

/** The civil date in `timeZone` at `instant` — "what day is it there right now". */
export function todayInZone(instant: Date, timeZone: string): CivilDate {
  const { year, month, day } = partsInZone(instant, timeZone);
  return { year, month, day };
}

/**
 * `date` moved by `days` calendar days.
 *
 * Pure civil arithmetic with no zone involved: adding a day to a date is a
 * calendar operation, and doing it in absolute milliseconds would land on the
 * wrong date across a DST transition.
 */
export function addCalendarDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The weekday of a civil date, **0 = Sunday** — matching `business_hours.weekday`. */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Parses `"09:30"` into its wall-clock parts, or `null` if it is not one.
 *
 * Two callers want opposite failures from the same rule, which is why the regex
 * lives here once and is wrapped twice. The Template seeder reads values this
 * repo authored, so a malformed one is a programming error and must throw
 * (`parseWallTime`). `lib/settings/hours-input.ts` reads what someone POSTed at
 * a Server Action, where a malformed one is an ordinary field error to be
 * collected alongside the others and shown next to its weekday — throwing there
 * would turn a typo into a 500 and lose the other six days' errors with it.
 *
 * Strict `HH:mm`: two digits each, no seconds. That is what `<input type="time">`
 * submits at its default `step`, and what `business_hours` round-trips through
 * `toWallTime` in `lib/settings/weekdays.ts`. Accepting `"9:0"` here would let
 * an unpadded string reach the database, where string comparison of times
 * quietly stops working.
 */
export function tryParseWallTime(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Parses `"09:30"` into its wall-clock parts. Throws on anything else. */
export function parseWallTime(value: string): { hour: number; minute: number } {
  const parsed = tryParseWallTime(value);
  if (!parsed) {
    throw new Error(`Expected a wall-clock time as "HH:mm", got "${value}"`);
  }
  return parsed;
}

/**
 * Parses `"2026-08-21 09:30"` into its wall-clock parts, or `null` if it is not
 * one.
 *
 * This is what a person writes in a spreadsheet, and it is the format the CSV
 * upload accepts (issue #8). There is no offset in the string and none is
 * allowed: the zone comes from `businesses.timezone`, and the caller runs
 * `zonedTimeToInstant` to turn these parts into an instant.
 *
 * **A string carrying its own offset is refused rather than ignored.** Reading
 * the `+05:30` in `2026-08-21T09:30:00+05:30` as if it were local would book an
 * Appointment five and a half hours from where the person meant, with nothing on
 * screen to show it happened. That silent wrong booking is the whole reason this
 * format has no offset in it, so a string that has one is a mistake to report,
 * not a suffix to drop.
 *
 * `T` is accepted alongside a space because a spreadsheet that decides the
 * column is a date will export one.
 *
 * The time half goes to `tryParseWallTime`, so strict `HH:mm` stays written down
 * once. The date half is validated by reading it back: `Date.UTC` rolls
 * 2026-02-30 forward to 2 March rather than refusing it, so the only way to know
 * the date was real is to check the parts survived the round trip.
 */
export function tryParseWallClock(value: string): WallClock | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;

  const time = tryParseWallTime(match[4]);
  if (!time) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, hour: time.hour, minute: time.minute };
}

const DISPLAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant rendered in a Business's own timezone — SPEC.md §11.3 puts these
 * in the mono face, so the format is fixed-width by design ("Tue 12 Aug, 14:30").
 *
 * `en-GB` for day-before-month and 24-hour time: this is an operational
 * timestamp on a dashboard, not prose, and it must not reorder by user locale
 * when two people look at the same Appointment.
 */
export function formatInZone(instant: Date, timeZone: string): string {
  let formatter = DISPLAY_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    DISPLAY_FORMATTERS.set(timeZone, formatter);
  }
  return formatter.format(instant);
}

/**
 * An instant as the wall clock reads it in `timeZone` — `"09:00"`.
 *
 * Distinct from `formatInZone`, which includes the weekday and the date. Three
 * callers want only the time: the Schedule grid's hour labels, its day heading
 * ("Open 09:00 - 17:00") and each Appointment block's range.
 *
 * Built from `partsInZone` rather than a third `Intl` formatter, so the
 * `hourCycle: "h23"` decision made at the top of this file — midnight is `00`,
 * never `24` — holds here for free.
 */
export function clockInZone(instant: Date, timeZone: string): string {
  const { hour, minute } = partsInZone(instant, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const SPEECH_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The same instant, written to be **read aloud** — "Thursday 20 August at 2:30
 * PM".
 *
 * A second formatter rather than a reuse of `formatInZone`, because the two have
 * opposite goals and reusing one for both is what produced Maya saying "Thu
 * twenty Aug, fourteen thirty" on a real Call.
 *
 * `formatInZone` is a dashboard timestamp: abbreviated and 24-hour so it is
 * fixed-width in the mono column §11.2 asks for. Every one of those choices is
 * wrong out loud. Text-to-speech reads "Thu" and "Aug" as clipped syllables
 * rather than expanding them, and 24-hour times come out as "fourteen thirty",
 * which no one confirming a haircut says.
 *
 * So: weekday and month in full, and a 12-hour clock with AM/PM. The year is
 * deliberately absent — Availability never offers a Slot more than two weeks
 * out, and "of two thousand and twenty six" is noise in a sentence whose whole
 * job is to be confirmed or rejected quickly.
 */
export function formatForSpeech(instant: Date, timeZone: string): string {
  let formatter = SPEECH_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: true,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
    });
    SPEECH_FORMATTERS.set(timeZone, formatter);
  }

  /*
    en-GB renders the meridiem lowercase ("2:30 pm") and separates the date from
    the time with a comma. Uppercased so a TTS engine reads it as a meridiem
    rather than the word "pm", and the comma becomes "at" so the whole thing is
    a sentence Maya can say without a stumble.
  */
  return formatter
    .format(instant)
    .replace(/\s*(am|pm)\b/i, (_m, meridiem: string) => ` ${meridiem.toUpperCase()}`)
    .replace(/,\s*(?=\d)/, " at ");
}

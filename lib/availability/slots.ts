import {
  addCalendarDays,
  parseWallTime,
  todayInZone,
  weekdayOf,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * Slot arithmetic — the pure core of Availability (SPEC.md §6).
 *
 * No database and no clock of its own: `now` is injected, for the reason
 * `lib/onboarding/seed-schedule.ts` gives for doing the same — otherwise
 * correctness depends on the day the test runs. The daylight-saving cases are
 * the substance of this module and they have to be assertable without seeding a
 * Business.
 *
 * **The rule that makes clock changes come out right:** convert each day's
 * opening and closing wall-clock times to instants ONCE, then step forward in
 * real milliseconds. Do not step through wall-clock times and convert each one.
 *
 * Both give identical results on the ~363 ordinary days a year. On the two that
 * matter:
 *
 * - Stepping through wall clocks would land inside the spring-forward gap, where
 *   ADR-0007 resolves a nonexistent time *forward*. Two different wall clocks
 *   can then map to the same instant, so the same Slot gets offered twice, or two
 *   Slots overlap. The database would reject the second booking of a Slot Maya
 *   had just read aloud — SPEC.md §3 rule 7.
 * - Stepping in real milliseconds instead yields one fewer Slot on a
 *   spring-forward day, because the day genuinely contains one hour less. That is
 *   the truth about the day, not a defect.
 *
 * A fall-back day comes out right for the same reason: the day holds 25 real
 * hours, so a window reading 00:00-07:00 on the clock is eight hours long and
 * yields eight Slots. Two of them read as "01:00" locally while being an hour
 * apart in real time, and both are genuinely bookable. Converting wall clocks
 * would have named only the first.
 *
 * Known limitation, narrow: if `opensAt` or `closesAt` ITSELF falls inside a
 * transition — a Business opening at 01:30 on a fall-back day, or at 02:30 on a
 * spring-forward day — ADR-0007's rules apply to that one conversion, so the
 * window comes out an hour longer or shorter than the clock suggests. Accepted;
 * see ADR-0010.
 *
 * Half-hour and quarter-hour zones (Asia/Kolkata +05:30, Asia/Kathmandu +05:45)
 * need no special handling, because nothing here does hour arithmetic.
 */

/** A bookable window, sized by a Service's duration. */
export type Slot = {
  startsAt: Date;
  endsAt: Date;
};

/** One weekday's opening window, wall-clock `"HH:mm"` — never an instant. */
export type WeekdayWindow = {
  /** 0 = Sunday, matching `business_hours.weekday`. */
  weekday: number;
  /** `"09:00"`. */
  opensAt: string;
  /** `"17:00"`. Strictly after `opensAt` — `lib/settings/hours-input.ts` rejects
   *  overnight windows, so every window is same-day. */
  closesAt: string;
};

/** Time already taken — an Appointment whose status holds its Slot. */
export type BusyPeriod = {
  startsAt: Date;
  endsAt: Date;
};

export type OpenSlotsInput = {
  hours: WeekdayWindow[];
  /** IANA zone from `businesses.timezone`. */
  timezone: string;
  durationMinutes: number;
  busy: BusyPeriod[];
  /** Earliest instant to consider. */
  from: Date;
  /** Latest instant a Slot may end at. */
  to: Date;
  /** Now. Slots before this are never returned (SPEC.md §6). */
  now: Date;
};

/*
  A ceiling on how many days one call may walk, so a caller asking for a decade
  cannot spin. 366 covers any sane window and makes the loop obviously finite.
*/
const MAX_DAYS = 366;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** The open Slots in `[from, to]`, in ascending order. */
export function openSlots({
  hours,
  timezone,
  durationMinutes,
  busy,
  from,
  to,
  now,
}: OpenSlotsInput): Slot[] {
  if (durationMinutes <= 0) {
    throw new Error(
      `A Service duration must be positive, got ${durationMinutes} minutes`,
    );
  }

  // A Slot in the past is never offered, so the search never starts before now.
  const earliest = from.getTime() > now.getTime() ? from : now;
  if (earliest.getTime() >= to.getTime()) return [];

  const windowsByWeekday = new Map(hours.map((h) => [h.weekday, h]));
  const firstDate = todayInZone(earliest, timezone);
  const lastDate = todayInZone(to, timezone);
  const days = Math.min(civilDaysBetween(firstDate, lastDate), MAX_DAYS - 1);

  const slots: Slot[] = [];
  for (let offset = 0; offset <= days; offset++) {
    const date = addCalendarDays(firstDate, offset);
    const window = windowsByWeekday.get(weekdayOf(date));
    if (!window) continue;

    for (const slot of slotsForDay(window, date, timezone, durationMinutes)) {
      if (slot.startsAt.getTime() < earliest.getTime()) continue;
      if (slot.endsAt.getTime() > to.getTime()) continue;
      if (busy.some((period) => overlaps(slot, period))) continue;
      slots.push(slot);
    }
  }

  return slots;
}

/**
 * One day's Slots, stepping in real milliseconds from the opening instant.
 *
 * The opening and closing wall clocks are each converted once. See this module's
 * header for why stepping in real time rather than clock time is what makes
 * daylight-saving days correct.
 */
function slotsForDay(
  window: WeekdayWindow,
  date: CivilDate,
  timezone: string,
  durationMinutes: number,
): Slot[] {
  const opens = parseWallTime(window.opensAt);
  const closes = parseWallTime(window.closesAt);

  const opensAt = zonedTimeToInstant({ ...date, ...opens }, timezone).getTime();
  const closesAt = zonedTimeToInstant({ ...date, ...closes }, timezone).getTime();

  const stepMs = durationMinutes * MS_PER_MINUTE;
  const slots: Slot[] = [];

  // `start + stepMs <= closesAt`, so a Slot that would run past closing is never
  // generated — SPEC.md §14 rule 1, enforced here rather than trusted to a caller.
  for (let start = opensAt; start + stepMs <= closesAt; start += stepMs) {
    slots.push({ startsAt: new Date(start), endsAt: new Date(start + stepMs) });
  }

  return slots;
}

/**
 * Half-open overlap, matching Postgres `tstzrange` and therefore the
 * `appointments_no_overlap` constraint.
 *
 * Touching is not overlapping: a 09:00-10:00 Appointment leaves 10:00-11:00
 * free. Getting this wrong in the strict direction would hide Slots the database
 * would happily take.
 */
function overlaps(slot: Slot, period: BusyPeriod): boolean {
  return (
    slot.startsAt.getTime() < period.endsAt.getTime() &&
    period.startsAt.getTime() < slot.endsAt.getTime()
  );
}

/**
 * Whole calendar days from `a` to `b`, negative if `b` is earlier.
 *
 * Civil arithmetic with no zone involved, for the reason `addCalendarDays` in
 * `lib/time/zone.ts` gives: counting in absolute milliseconds lands on the wrong
 * date across a DST transition.
 */
function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  const from = Date.UTC(a.year, a.month - 1, a.day);
  const to = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((to - from) / MS_PER_DAY);
}

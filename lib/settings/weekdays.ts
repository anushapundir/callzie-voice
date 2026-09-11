/**
 * The seven weekdays as Settings renders them, and the one shape Business Hours
 * travel in.
 *
 * This module exists because three otherwise-unrelated files need to agree on
 * two small things — the weekday numbering and the wall-clock string format —
 * and disagreeing about either is silent. `business_hours.weekday` is 0 =
 * Sunday (SPEC.md §5), the seeder in `lib/onboarding/templates.ts` writes that
 * numbering, and `weekdayOf` in `lib/time/zone.ts` returns it. Anything here
 * that renumbered would break Availability without failing a type check.
 */

/** One weekday, in the order Settings lists them. */
export type Weekday = {
  /** 0 = Sunday, matching `business_hours.weekday`. */
  weekday: number;
  label: string;
};

/*
  Sunday-first, because that is what 0-6 means in `business_hours.weekday` and
  in `Date.prototype.getUTCDay`. Listing the array in a different order to put
  Monday at the top would make the index and the value disagree, which is
  exactly the bug this module exists to prevent — a UI that wants Monday first
  should reorder at the point of render, not here.
*/
export const WEEKDAYS: readonly Weekday[] = Object.freeze([
  { weekday: 0, label: "Sunday" },
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
]);

export function weekdayLabel(weekday: number): string {
  return WEEKDAYS[weekday]?.label ?? `Day ${weekday}`;
}

/**
 * One weekday's opening window as the application passes it around — wall-clock
 * `"HH:mm"`, never an absolute timestamp (SPEC.md §5).
 *
 * The same shape `TemplateHours` uses in `lib/onboarding/templates.ts`, kept
 * separate because that one describes what a Template ships with and this one
 * describes what a person just typed into a form. They coincide today; a
 * Template gaining a field should not silently change what Settings accepts.
 */
export type WeekdayHours = {
  weekday: number;
  /** `"09:00"`. */
  opensAt: string;
  /** `"17:00"`. Strictly after `opensAt` — no overnight windows. */
  closesAt: string;
};

/**
 * A Postgres `time` value as the form spells it: `"09:00:00"` → `"09:00"`.
 *
 * Drizzle hands back what the driver gives it, and `pg` renders a `time` column
 * as `HH:MM:SS`. An `<input type="time">` submits and expects `HH:mm`, so a
 * round trip through the database changes the string without changing the
 * meaning — and a naive `stored === submitted` comparison then reports every
 * unchanged row as edited. Normalise on the way out of the database, once.
 *
 * Seconds are dropped rather than preserved: Business Hours are set to the
 * minute in the UI, and a stray `:30` seconds would render as an unselectable
 * value in a time input.
 */
export function toWallTime(value: string): string {
  const [hour = "00", minute = "00"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * `"09:30"` as 570 — minutes since local midnight.
 *
 * Comparing wall-clock times as strings works only because the format is
 * zero-padded and fixed-width, which is easy to stop being true. Comparing
 * numbers is the same cost and says what it means.
 */
export function minutesSinceMidnight(value: string): number {
  const [hour = "0", minute = "0"] = toWallTime(value).split(":");
  return Number(hour) * 60 + Number(minute);
}

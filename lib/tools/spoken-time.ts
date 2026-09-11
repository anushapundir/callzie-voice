/**
 * An instant rendered the way Maya says it out loud, in a Business's own
 * timezone — "Thursday 20 August at 2:00 PM".
 *
 * Deliberately not `formatInZone` from `lib/time/zone.ts`. That one produces
 * "Thu 20 Aug, 14:00": fixed-width and 24-hour, which is right for a dashboard
 * table in a mono face (SPEC.md §11.3) and wrong down a phone line. The two
 * formats have opposite requirements, so they are two functions rather than one
 * with a flag.
 *
 * Assembled from `formatToParts` rather than taken as one formatted string,
 * because locales disagree about the separator between the date and the time and
 * one of the two orderings always reads oddly. Assembling makes the output the
 * same sentence in every environment, which is also what makes it assertable.
 *
 * Nothing here does hour arithmetic, so half- and quarter-hour zones
 * (Asia/Kolkata +05:30, Asia/Kathmandu +05:45) need no special handling — the
 * same rule `lib/time/zone.ts` states.
 */

/*
  Constructing an Intl.DateTimeFormat is the expensive part, and
  check_availability calls this once per offered Slot on a live call. One
  formatter per zone, cached for the life of the process: the key space is
  bounded by the IANA catalogue, so this cannot grow unbounded. Same arrangement
  as lib/time/zone.ts.
*/
const SPOKEN_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = SPOKEN_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      // "numeric", not "2-digit": "2:00 PM" is what a person says, "02:00 PM" is
      // what a machine writes.
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    SPOKEN_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function spokenTime(instant: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl returned no "${type}" part for zone "${timeZone}"`);
    }
    return part.value;
  };

  // Some ICU builds render the day period as "am"/"pm", others as "a.m.".
  // Normalised, because this string is asserted in tests and spoken by a model.
  const period = read("dayPeriod").replace(/\./g, "").toUpperCase();

  return `${read("weekday")} ${read("day")} ${read("month")} at ${read("hour")}:${read("minute")} ${period}`;
}

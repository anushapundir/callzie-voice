import { partsInZone, todayInZone, weekdayOf } from "@/lib/time/zone";
import {
  minutesSinceMidnight,
  toWallTime,
  weekdayLabel,
  type WeekdayHours,
} from "@/lib/settings/weekdays";

/*
  Whether the business is open at this moment, and what to say if it is not
  (issue #43).

  Maya answers around the clock, so this never decides *whether* to pick up. It
  decides what she says when she does — "we're open until six" against "we're
  closed now, but I can book you in". That distinction is the whole reason the
  feature is worth having: a caller at nine at night wants to be told when they
  can come in, not that nobody is there.

  Pure, and takes `now` as an argument, matching `slots.ts` and `seed-schedule.ts`
  — so a test does not depend on the hour it runs at, and neither does a call
  placed a minute before closing time.

  Everything below reads the Business's own wall clock, never the server's. A
  clinic in Kolkata is open at 09:00 there whatever the container thinks the time
  is, and this is the module where getting that wrong would be heard out loud.
*/

export type OpenNow = {
  isOpenNow: boolean;
  /** `"9:00am to 5:00pm"`, or `"closed"` on a day with no window. */
  hoursToday: string;
  /**
   * `"Monday at 9:00am"` — when the doors next open.
   *
   * Null when the Business has no Business Hours at all, which is the one case
   * where there is no honest answer. Maya is told to say somebody will call
   * back rather than to invent a day.
   */
  nextOpen: string | null;
  /** `"9:47pm"` in the Business's zone. Maya reads it when asked the time. */
  localTime: string;
};

/** How many days ahead to look for the next opening. A full week, then give up. */
const LOOKAHEAD_DAYS = 7;

export function openNow({
  hours,
  timezone,
  now,
}: {
  hours: readonly WeekdayHours[];
  timezone: string;
  now: Date;
}): OpenNow {
  const parts = partsInZone(now, timezone);
  const minutesNow = parts.hour * 60 + parts.minute;
  const today = weekdayOf(todayInZone(now, timezone));

  const byWeekday = new Map(hours.map((h) => [h.weekday, h]));
  const todaysWindow = byWeekday.get(today);

  const isOpenNow =
    todaysWindow !== undefined &&
    minutesNow >= minutesSinceMidnight(todaysWindow.opensAt) &&
    /*
      Strictly before closing. At exactly 17:00 a business that closes at 17:00
      is shut — saying "we're open" in the same breath as "we close at five"
      is the kind of small wrongness that makes a caller stop trusting the rest
      of the call.
    */
    minutesNow < minutesSinceMidnight(todaysWindow.closesAt);

  return {
    isOpenNow,
    hoursToday: todaysWindow ? windowLabel(todaysWindow) : "closed",
    nextOpen: findNextOpen({ byWeekday, today, minutesNow }),
    localTime: speakClock(parts.hour, parts.minute),
  };
}

/** `"9:00am to 5:00pm"`. */
function windowLabel(window: WeekdayHours): string {
  return `${speakWallTime(window.opensAt)} to ${speakWallTime(window.closesAt)}`;
}

/**
 * The next opening, looking forward at most a week.
 *
 * Today counts only if the doors have not opened yet — a caller at eight in the
 * morning should hear "we open at nine today", not "we open at nine on Monday".
 * Once the day's window has started, today is spent: either the business is open
 * right now, or it has already closed.
 */
function findNextOpen({
  byWeekday,
  today,
  minutesNow,
}: {
  byWeekday: Map<number, WeekdayHours>;
  today: number;
  minutesNow: number;
}): string | null {
  for (let ahead = 0; ahead <= LOOKAHEAD_DAYS; ahead++) {
    const weekday = (today + ahead) % 7;
    const window = byWeekday.get(weekday);
    if (!window) continue;

    // Today only counts before it opens. `ahead > 0` days always count.
    if (ahead === 0 && minutesNow >= minutesSinceMidnight(window.opensAt)) {
      continue;
    }

    const when = ahead === 0 ? "today" : weekdayLabel(weekday);
    return `${when} at ${speakWallTime(window.opensAt)}`;
  }

  // No Business Hours at all. There is no honest answer, so there is no answer.
  return null;
}

/** `"09:00"` -> `"9:00am"`. */
function speakWallTime(value: string): string {
  const [hour = "0", minute = "0"] = toWallTime(value).split(":");
  return speakClock(Number(hour), Number(minute));
}

/**
 * `(17, 5)` -> `"5:05pm"`.
 *
 * Twelve-hour with a lowercase suffix and no space, matching
 * `lib/tools/spoken-time.ts` — these two strings land in the same sentences, and
 * "5:05 PM" next to "5:05pm" in one reply is the sort of seam a caller hears.
 */
function speakClock(hour24: number, minute: number): string {
  const suffix = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
}

import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  clockInZone,
  formatForSpeech,
  formatInZone,
  parseWallTime,
  partsInZone,
  todayInZone,
  tryParseWallClock,
  weekdayOf,
  zoneOffsetMs,
  zonedTimeToInstant,
} from "@/lib/time/zone";

/*
  Expected instants here are derived from the IANA rules, not from running the
  implementation — otherwise the test only asserts that the code does what the
  code does. The 2026 transitions these lean on:

    America/New_York  spring forward  2026-03-08 07:00Z  (-05:00 → -04:00)
                      fall back       2026-11-01 06:00Z  (-04:00 → -05:00)
    Europe/London     BST from        2026-03-29 01:00Z  (+00:00 → +01:00)
    Pacific/Auckland  fall back       2026-04-04 14:00Z  (+13:00 → +12:00)
*/

const wall = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) => ({ year, month, day, hour, minute });

describe("zonedTimeToInstant", () => {
  it("handles a half-hour offset", () => {
    // Asia/Kolkata is +05:30 all year — Callzie's first market, and the case a
    // whole-hour implementation gets wrong.
    expect(zonedTimeToInstant(wall(2026, 3, 15, 10, 0), "Asia/Kolkata")).toEqual(
      new Date("2026-03-15T04:30:00.000Z"),
    );
  });

  it("handles a quarter-hour offset", () => {
    // Australia/Eucla is +08:45 and never observes DST.
    expect(
      zonedTimeToInstant(wall(2026, 6, 1, 9, 0), "Australia/Eucla"),
    ).toEqual(new Date("2026-06-01T00:15:00.000Z"));
  });

  it("uses the offset in force at the instant, not a fixed one per zone", () => {
    // Same zone, same wall clock, six months apart: GMT then BST.
    expect(zonedTimeToInstant(wall(2026, 1, 15, 10, 0), "Europe/London")).toEqual(
      new Date("2026-01-15T10:00:00.000Z"),
    );
    expect(zonedTimeToInstant(wall(2026, 7, 15, 10, 0), "Europe/London")).toEqual(
      new Date("2026-07-15T09:00:00.000Z"),
    );
  });

  it("resolves an ambiguous wall clock to the earlier instant", () => {
    // 01:30 happens twice on 2026-11-01 in New York: once at -04:00 and again
    // an hour later at -05:00. ADR-0007 picks the first.
    expect(
      zonedTimeToInstant(wall(2026, 11, 1, 1, 30), "America/New_York"),
    ).toEqual(new Date("2026-11-01T05:30:00.000Z"));
  });

  it("resolves an ambiguous wall clock to the earlier instant across UTC midnight", () => {
    // Auckland's fall-back lands on the far side of UTC midnight from the local
    // date, which is what breaks a naive guess-and-correct implementation:
    // 02:30 on 2026-04-05 is +13:00 at 13:30Z and +12:00 at 14:30Z.
    expect(
      zonedTimeToInstant(wall(2026, 4, 5, 2, 30), "Pacific/Auckland"),
    ).toEqual(new Date("2026-04-04T13:30:00.000Z"));
  });

  it("shifts a nonexistent wall clock forward past the gap", () => {
    // 02:30 never occurs on 2026-03-08 in New York — the clock jumps 02:00 to
    // 03:00. ADR-0007 shifts forward, so this is 03:30 local.
    const instant = zonedTimeToInstant(wall(2026, 3, 8, 2, 30), "America/New_York");
    expect(instant).toEqual(new Date("2026-03-08T07:30:00.000Z"));
    expect(partsInZone(instant, "America/New_York").hour).toBe(3);
  });

  it("gets the unambiguous hour on a spring-forward day right", () => {
    // 10:00 on the transition day is plain EDT — no special case.
    expect(
      zonedTimeToInstant(wall(2026, 3, 8, 10, 0), "America/New_York"),
    ).toEqual(new Date("2026-03-08T14:00:00.000Z"));
  });

  it("resolves an hour that exists only once near a fall-back", () => {
    // 01:00 on 2026-04-05 in Auckland is not ambiguous — but the offset at the
    // same numeric instant read as UTC is the wrong one, so an uncorrected
    // implementation lands an hour out.
    expect(
      zonedTimeToInstant(wall(2026, 4, 5, 1, 0), "Pacific/Auckland"),
    ).toEqual(new Date("2026-04-04T12:00:00.000Z"));
  });

  it("round-trips every wall clock that is not in a gap", () => {
    const zones = [
      "UTC",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Europe/London",
      "America/New_York",
      "Pacific/Auckland",
      "Australia/Eucla",
      "America/Sao_Paulo",
    ];

    for (const zone of zones) {
      for (const month of [1, 4, 7, 10]) {
        const w = wall(2026, month, 15, 14, 30);
        const parts = partsInZone(zonedTimeToInstant(w, zone), zone);
        expect({ ...parts, second: undefined }, `${zone} ${month}`).toEqual({
          ...w,
          second: undefined,
        });
      }
    }
  });
});

describe("zoneOffsetMs", () => {
  it("is positive east of Greenwich and negative west", () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    expect(zoneOffsetMs(at, "Asia/Kolkata")).toBe(5.5 * 3_600_000);
    expect(zoneOffsetMs(at, "America/New_York")).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(at, "UTC")).toBe(0);
  });

  it("is unaffected by sub-second precision in the instant", () => {
    // The formatter has no milliseconds to give back, so a naive subtraction
    // returns an offset short by the instant's own millisecond part.
    expect(zoneOffsetMs(new Date("2026-06-01T00:00:00.750Z"), "Asia/Kolkata")).toBe(
      5.5 * 3_600_000,
    );
  });
});

describe("todayInZone", () => {
  it("reports the local date, not the UTC one", () => {
    const instant = new Date("2026-01-01T00:30:00.000Z");
    expect(todayInZone(instant, "UTC")).toEqual({ year: 2026, month: 1, day: 1 });
    expect(todayInZone(instant, "America/New_York")).toEqual({
      year: 2025,
      month: 12,
      day: 31,
    });
    expect(todayInZone(instant, "Asia/Kolkata")).toEqual({
      year: 2026,
      month: 1,
      day: 1,
    });
  });
});

describe("addCalendarDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addCalendarDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(addCalendarDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it("handles a leap day", () => {
    expect(addCalendarDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });
});

describe("weekdayOf", () => {
  it("counts from 0 = Sunday, matching business_hours.weekday", () => {
    // 2026-08-16 is a Sunday.
    expect(weekdayOf({ year: 2026, month: 8, day: 16 })).toBe(0);
    expect(weekdayOf({ year: 2026, month: 8, day: 17 })).toBe(1);
    expect(weekdayOf({ year: 2026, month: 8, day: 22 })).toBe(6);
  });
});

describe("parseWallTime", () => {
  it("reads HH:mm", () => {
    expect(parseWallTime("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseWallTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseWallTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects anything else", () => {
    for (const bad of ["9:30", "0930", "24:00", "09:60", "", "09:30:00"]) {
      expect(() => parseWallTime(bad), bad).toThrow();
    }
  });
});

describe("tryParseWallClock", () => {
  it("reads a space-separated date and time", () => {
    expect(tryParseWallClock("2026-08-21 09:30")).toEqual({
      year: 2026,
      month: 8,
      day: 21,
      hour: 9,
      minute: 30,
    });
  });

  it("reads the same value with a T separator", () => {
    // What a spreadsheet exports when it decides the column is a date.
    expect(tryParseWallClock("2026-08-21T09:30")).toEqual({
      year: 2026,
      month: 8,
      day: 21,
      hour: 9,
      minute: 30,
    });
  });

  it("refuses a time that is not strict HH:mm", () => {
    // Delegated to tryParseWallTime, so the rule lives in one place.
    expect(tryParseWallClock("2026-08-21 09:7")).toBeNull();
    expect(tryParseWallClock("2026-08-21 25:00")).toBeNull();
    expect(tryParseWallClock("2026-08-21 09:60")).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    // Date.UTC rolls 30 February forward to 2 March rather than refusing it, so
    // the only way to know the date was real is to read the parts back.
    expect(tryParseWallClock("2026-13-21 09:30")).toBeNull();
    expect(tryParseWallClock("2026-02-30 09:30")).toBeNull();
    expect(tryParseWallClock("2026-00-10 09:30")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(tryParseWallClock("2028-02-29 09:30")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      hour: 9,
      minute: 30,
    });
  });

  it("refuses an unpadded or partial date", () => {
    for (const bad of [
      "2026-8-21 09:30",
      "21/08/2026 09:30",
      "2026-08-21",
      "09:30",
      "",
    ]) {
      expect(tryParseWallClock(bad), bad).toBeNull();
    }
  });

  it("refuses a trailing offset rather than silently ignoring it", () => {
    // Accepting this would read +05:30 as if it were local, which is the one
    // failure a wall-clock format exists to avoid.
    expect(tryParseWallClock("2026-08-21T09:30:00+05:30")).toBeNull();
    expect(tryParseWallClock("2026-08-21T09:30Z")).toBeNull();
  });
});

describe("formatInZone", () => {
  it("renders the same instant in each Business's own timezone", () => {
    const instant = new Date("2026-08-12T09:00:00.000Z");
    expect(formatInZone(instant, "Asia/Kolkata")).toBe("Wed 12 Aug, 14:30");
    expect(formatInZone(instant, "America/New_York")).toBe("Wed 12 Aug, 05:00");
  });
});

describe("clockInZone", () => {
  it("writes an instant as a zero-padded wall clock", () => {
    // 03:30 UTC is 09:00 in Kolkata (+05:30).
    expect(clockInZone(new Date("2026-08-19T03:30:00.000Z"), "Asia/Kolkata")).toBe(
      "09:00",
    );
  });

  it("uses a 24-hour clock, so midnight is 00:00 and never 24:00", () => {
    expect(
      clockInZone(new Date("2026-08-18T18:30:00.000Z"), "Asia/Kolkata"),
    ).toBe("00:00");
  });

  it("does not round a half-hour zone to the hour", () => {
    // 04:00 UTC is 09:30 in Kolkata, not 09:00 and not 10:00.
    expect(clockInZone(new Date("2026-08-19T04:00:00.000Z"), "Asia/Kolkata")).toBe(
      "09:30",
    );
  });
});

describe("formatForSpeech", () => {
  const KOLKATA = "Asia/Kolkata";

  /*
    Maya reads this aloud. `formatInZone` was reused for it once, and a real
    Call came out as "Thu twenty Aug, fourteen thirty" — every abbreviation the
    dashboard wants is wrong in a sentence.
  */
  it("writes the weekday and month in full", () => {
    // 09:00 UTC = 14:30 Kolkata, Tuesday 18 August 2026.
    expect(formatForSpeech(new Date("2026-08-18T09:00:00.000Z"), KOLKATA)).toBe(
      "Tuesday 18 August at 2:30 PM",
    );
  });

  it("uses a 12-hour clock with an uppercase meridiem", () => {
    // "fourteen thirty" is not how anyone confirms an appointment.
    const spoken = formatForSpeech(new Date("2026-08-18T09:00:00.000Z"), KOLKATA);

    expect(spoken).toContain("2:30 PM");
    expect(spoken).not.toContain("14:30");
    expect(spoken).not.toContain("pm");
  });

  it("says midnight and noon without turning either into zero", () => {
    expect(formatForSpeech(new Date("2026-08-20T18:30:00.000Z"), KOLKATA)).toBe(
      "Friday 21 August at 12:00 AM",
    );
    expect(formatForSpeech(new Date("2026-08-15T06:30:00.000Z"), KOLKATA)).toBe(
      "Saturday 15 August at 12:00 PM",
    );
  });

  it("joins the date to the time with a word, not a comma", () => {
    // A comma is a pause; "at" is a sentence.
    const spoken = formatForSpeech(new Date("2026-09-01T05:15:00.000Z"), KOLKATA);

    expect(spoken).toBe("Tuesday 1 September at 10:45 AM");
    expect(spoken).not.toContain(",");
  });

  it("resolves the offset at the instant, like every other function here", () => {
    // Same wall clock, two zones, one instant.
    const instant = new Date("2026-08-18T09:00:00.000Z");

    expect(formatForSpeech(instant, "Europe/London")).toBe(
      "Tuesday 18 August at 10:00 AM",
    );
    expect(formatForSpeech(instant, KOLKATA)).toBe("Tuesday 18 August at 2:30 PM");
  });
});

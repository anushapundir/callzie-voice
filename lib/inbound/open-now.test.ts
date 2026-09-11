import { describe, expect, it } from "vitest";

import { openNow } from "@/lib/inbound/open-now";
import type { WeekdayHours } from "@/lib/settings/weekdays";

/*
  Everything here is read in the Business's own zone, never the server's. The
  fixture is Asia/Kolkata (+05:30) on purpose: a half-hour offset catches the
  class of bug that a whole-hour zone hides, and it is the zone SPEC.md §5 uses
  as its own example.

  Mon 2026-09-07 in UTC:
    03:30Z = 09:00 local   (opening)
    11:29Z = 16:59 local   (a minute before closing)
    11:30Z = 17:00 local   (closing, which is shut)
    16:00Z = 21:30 local   (evening, the case this feature exists for)
*/

const ZONE = "Asia/Kolkata";

// Monday to Friday, 09:00-17:00. No weekend rows, which is how a closed day is
// spelled — a missing row, not a zero-length window.
const WEEKDAY_HOURS: WeekdayHours[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: "09:00",
  closesAt: "17:00",
}));

function at(iso: string, hours: readonly WeekdayHours[] = WEEKDAY_HOURS) {
  return openNow({ hours, timezone: ZONE, now: new Date(iso) });
}

describe("openNow", () => {
  it("is open in the middle of a working day", () => {
    const result = at("2026-09-07T06:00:00.000Z"); // 11:30 local, Monday

    expect(result.isOpenNow).toBe(true);
    expect(result.hoursToday).toBe("9:00am to 5:00pm");
    expect(result.localTime).toBe("11:30am");
  });

  it("is open one minute before closing", () => {
    expect(at("2026-09-07T11:29:00.000Z").isOpenNow).toBe(true);
  });

  it("is shut at exactly closing time", () => {
    /*
      At 17:00 a business that closes at 17:00 is shut. Saying "we're open" in
      the same breath as "we close at five" is the small wrongness that makes a
      caller stop believing the rest of the call.
    */
    expect(at("2026-09-07T11:30:00.000Z").isOpenNow).toBe(false);
  });

  it("is shut before opening, and says today", () => {
    const result = at("2026-09-07T02:00:00.000Z"); // 07:30 local, Monday

    expect(result.isOpenNow).toBe(false);
    // Not "Monday at 9:00am" — the caller is already having Monday.
    expect(result.nextOpen).toBe("today at 9:00am");
  });

  it("is shut in the evening, and points at tomorrow", () => {
    // 21:30 local Monday. This is the call the whole feature exists for.
    const result = at("2026-09-07T16:00:00.000Z");

    expect(result.isOpenNow).toBe(false);
    expect(result.hoursToday).toBe("9:00am to 5:00pm");
    expect(result.nextOpen).toBe("Tuesday at 9:00am");
    expect(result.localTime).toBe("9:30pm");
  });

  it("skips the weekend to reach Monday", () => {
    // Saturday evening: there is no Saturday or Sunday row at all.
    const result = at("2026-09-12T16:00:00.000Z");

    expect(result.isOpenNow).toBe(false);
    expect(result.hoursToday).toBe("closed");
    expect(result.nextOpen).toBe("Monday at 9:00am");
  });

  it("says closed on a day with no window", () => {
    expect(at("2026-09-13T06:00:00.000Z").hoursToday).toBe("closed");
  });

  it("has no next opening when there are no Business Hours at all", () => {
    /*
      The one case with no honest answer. Null rather than a guessed day —
      Maya is told to say somebody will call back rather than to invent one.
    */
    const result = at("2026-09-07T06:00:00.000Z", []);

    expect(result.isOpenNow).toBe(false);
    expect(result.nextOpen).toBeNull();
    expect(result.hoursToday).toBe("closed");
  });

  it("reads midnight and midday as twelve, not zero", () => {
    // 18:30Z = 00:00 local Tuesday. `0:00am` would be read aloud as "zero".
    expect(at("2026-09-07T18:30:00.000Z").localTime).toBe("12:00am");
    // 06:30Z = 12:00 local. Noon is pm.
    expect(at("2026-09-07T06:30:00.000Z").localTime).toBe("12:00pm");
  });

  it("handles a Sunday-only Business, where next week is the same day", () => {
    const sundayOnly: WeekdayHours[] = [
      { weekday: 0, opensAt: "10:00", closesAt: "14:00" },
    ];

    // Sunday 15:00 local — today's window has been and gone.
    const result = at("2026-09-13T09:30:00.000Z", sundayOnly);

    expect(result.isOpenNow).toBe(false);
    expect(result.nextOpen).toBe("Sunday at 10:00am");
  });
});

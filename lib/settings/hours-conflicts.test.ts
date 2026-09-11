import { describe, expect, it } from "vitest";

import type { AppointmentRow } from "@/lib/business/list-appointments";
import { appointmentsOutsideHours } from "@/lib/settings/hours-conflicts";
import type { WeekdayHours } from "@/lib/settings/weekdays";

/*
  Every instant below is written as a literal UTC timestamp with its local wall
  clock in the comment beside it, deliberately: computing the fixtures with
  `zonedTimeToInstant` would make the test agree with the implementation by
  construction, and both could be wrong together. The comments were checked
  against `Intl.DateTimeFormat` for the zone named in each block.
*/

let seq = 0;

function appointment(startsAt: string, endsAt: string): AppointmentRow {
  seq += 1;
  return {
    id: `appt-${seq}`,
    name: `Customer ${seq}`,
    phoneE164: "+12025550101",
    serviceName: "Haircut",
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    status: "confirmed",
    /*
      No Calls, and nothing needing attention. This file is about whether an
      Appointment falls outside newly narrowed Business Hours, which nothing to
      do with calling touches — these fields are here because `AppointmentRow`
      is the shape `appointmentsOutsideHours` takes, not because this test has
      an opinion about them.
    */
    attempts: 0,
    lastCallId: null,
    lastCallAt: null,
    isCalling: false,
    isExample: false,
    needsAttentionReason: null,
  };
}

/** Tuesday 09:00–17:00 only; every other weekday closed. */
const TUESDAY_ONLY: WeekdayHours[] = [
  { weekday: 2, opensAt: "09:00", closesAt: "17:00" },
];

describe("appointmentsOutsideHours", () => {
  /*
    Asia/Kolkata is +05:30 year-round — Callzie's first market, and the case that
    catches any implementation rounding an offset to whole hours.
  */
  describe("in a half-hour zone with no DST (Asia/Kolkata)", () => {
    const outside = (appointments: AppointmentRow[], hours = TUESDAY_ONLY) =>
      appointmentsOutsideHours(appointments, hours, "Asia/Kolkata")
        .map((a) => a.id);

    it("passes an Appointment comfortably inside the window", () => {
      // Tue 11 Aug 2026, 09:00–10:00 local.
      const inside = appointment("2026-08-11T03:30:00Z", "2026-08-11T04:30:00Z");

      expect(outside([inside])).toEqual([]);
    });

    it("flags an Appointment on a weekday with no window at all", () => {
      // Sun 9 Aug 2026, 10:30–11:30 local — inside Tuesday's hours by clock,
      // but Sunday is closed, so the clock never comes into it.
      const sunday = appointment("2026-08-09T05:00:00Z", "2026-08-09T06:00:00Z");

      expect(outside([sunday])).toEqual([sunday.id]);
    });

    it("flags an Appointment starting before opening", () => {
      // Tue 11 Aug 2026, 07:30–08:30 local.
      const early = appointment("2026-08-11T02:00:00Z", "2026-08-11T03:00:00Z");

      expect(outside([early])).toEqual([early.id]);
    });

    it("flags an Appointment ending after closing", () => {
      // Tue 11 Aug 2026, 16:30–17:30 local. It starts inside; only the end is
      // out, which is exactly the case an opening-time-only check would miss.
      const late = appointment("2026-08-11T11:00:00Z", "2026-08-11T12:00:00Z");

      expect(outside([late])).toEqual([late.id]);
    });

    it("treats ending exactly at closing time as inside", () => {
      // Tue 11 Aug 2026, 16:30–17:00 local — the normal last slot of the day.
      const lastSlot = appointment("2026-08-11T11:00:00Z", "2026-08-11T11:30:00Z");

      expect(outside([lastSlot])).toEqual([]);
    });

    it("flags an Appointment that runs past local midnight", () => {
      // Tue 11 Aug 2026, 23:30 → Wed 12 Aug, 00:30 local, at a business open
      // Tuesday 22:00–23:59. Comparing the end's minutes-since-midnight naively
      // would score it 30 and call it inside.
      const overnight = appointment("2026-08-11T18:00:00Z", "2026-08-11T19:00:00Z");
      const lateNight: WeekdayHours[] = [
        { weekday: 2, opensAt: "22:00", closesAt: "23:59" },
      ];

      expect(outside([overnight], lateNight)).toEqual([overnight.id]);

      // The same window still admits an Appointment that ends before midnight:
      // Tue 22:30–23:30 local.
      const beforeMidnight = appointment(
        "2026-08-11T17:00:00Z",
        "2026-08-11T18:00:00Z",
      );
      expect(outside([beforeMidnight], lateNight)).toEqual([]);
    });

    it("returns the display fields the warning renders, and nothing else", () => {
      const early = appointment("2026-08-11T02:00:00Z", "2026-08-11T03:00:00Z");
      const [flagged] = appointmentsOutsideHours(
        [early],
        TUESDAY_ONLY,
        "Asia/Kolkata",
      );

      expect(flagged).toEqual({
        id: early.id,
        name: early.name,
        serviceName: "Haircut",
        startsAt: early.startsAt,
      });
    });

    it("preserves input order across a mixed batch", () => {
      const early = appointment("2026-08-11T02:00:00Z", "2026-08-11T03:00:00Z");
      const ok = appointment("2026-08-11T03:30:00Z", "2026-08-11T04:30:00Z");
      const late = appointment("2026-08-11T11:00:00Z", "2026-08-11T12:00:00Z");

      expect(outside([early, ok, late])).toEqual([early.id, late.id]);
    });
  });

  /*
    Australia/Adelaide is +09:30 standard and +10:30 in summer, and springs
    forward at 02:00 on Sunday 4 October 2026 — a half-hour offset AND a DST
    transition on the same day, which is the combination that breaks anything
    holding a single offset for the zone. All three Appointments below sit on
    that Sunday, after the jump.
  */
  describe("on a DST-transition day in a half-hour zone (Australia/Adelaide)", () => {
    const SUNDAY_MORNING: WeekdayHours[] = [
      { weekday: 0, opensAt: "09:00", closesAt: "13:00" },
    ];
    const outside = (appointments: AppointmentRow[], hours = SUNDAY_MORNING) =>
      appointmentsOutsideHours(appointments, hours, "Australia/Adelaide")
        .map((a) => a.id);

    it("passes an Appointment inside the post-transition window", () => {
      // Sun 4 Oct 2026, 09:15–10:15 local, at +10:30. Resolving it at the zone's
      // standard +09:30 would read 08:15 and wrongly flag it as early; rounding
      // to +10:00 or +11:00 would move it by a half hour either way.
      const inside = appointment("2026-10-03T22:45:00Z", "2026-10-03T23:45:00Z");

      expect(outside([inside])).toEqual([]);
    });

    it("still flags an Appointment ending after closing on the same day", () => {
      // Sun 4 Oct 2026, 13:15–14:15 local — starts and ends after the 13:00
      // close, on the shifted offset.
      const afterClose = appointment("2026-10-04T02:45:00Z", "2026-10-04T03:45:00Z");
      // Sun 4 Oct 2026, 12:00–13:00 local — the last slot, still inside.
      const lastSlot = appointment("2026-10-04T01:30:00Z", "2026-10-04T02:30:00Z");

      expect(outside([lastSlot, afterClose])).toEqual([afterClose.id]);
    });

    it("compares wall clocks, not elapsed time, across the spring-forward gap", () => {
      /*
        Sun 4 Oct 2026, 01:30 local → 03:30 local: one absolute hour that reads
        as two on the wall, because 02:00–03:00 never happens in this zone.
        Business Hours are wall-clock (SPEC.md §5), so the wall clock is what
        decides. Against a 01:00–03:00 window the Appointment ends at 03:30 and
        is out; widen the window to 04:00 and it is in — even though nothing
        about the Appointment changed.
      */
      const acrossTheGap = appointment(
        "2026-10-03T16:00:00Z",
        "2026-10-03T17:00:00Z",
      );

      expect(
        outside([acrossTheGap], [{ weekday: 0, opensAt: "01:00", closesAt: "03:00" }]),
      ).toEqual([acrossTheGap.id]);
      expect(
        outside([acrossTheGap], [{ weekday: 0, opensAt: "01:00", closesAt: "04:00" }]),
      ).toEqual([]);
    });
  });

  it("flags everything when no day is open", () => {
    const any = appointment("2026-08-11T03:30:00Z", "2026-08-11T04:30:00Z");

    expect(appointmentsOutsideHours([any], [], "Asia/Kolkata")).toHaveLength(1);
  });

  it("returns nothing for no Appointments", () => {
    expect(appointmentsOutsideHours([], TUESDAY_ONLY, "Asia/Kolkata")).toEqual([]);
  });
});

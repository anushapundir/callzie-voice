import { describe, expect, it } from "vitest";

import { dayLayout, type DayAppointment } from "@/lib/schedule/day-layout";

/*
  Expected instants are derived from the IANA rules rather than from running the
  implementation, the way lib/time/zone.test.ts does it. The transitions leaned
  on here:

    America/New_York  spring forward  2026-03-08 07:00Z  (-05:00 → -04:00)
                      fall back       2026-11-01 06:00Z  (-04:00 → -05:00)
    Asia/Kolkata      no transitions, +05:30 all year
*/

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

/** 19 August 2026, a Wednesday. */
const WEDNESDAY = { year: 2026, month: 8, day: 19 };

/** Business Hours as the loader hands them over: wall clock, never instants. */
const NINE_TO_FIVE = { opensAt: "09:00", closesAt: "17:00" };

function appointment(
  overrides: Partial<DayAppointment> &
    Pick<DayAppointment, "startsAt" | "endsAt">,
): DayAppointment {
  return {
    id: "appt-1",
    name: "Priya Sharma",
    serviceName: "Cleaning",
    status: "confirmed",
    needsAttentionReason: null,
    ...overrides,
  };
}

describe("dayLayout — the window", () => {
  it("runs from opening to closing when every Appointment is inside", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 09:00-09:45 Kolkata.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
      ],
    });

    expect(layout).not.toBeNull();
    // 09:00 and 17:00 Kolkata (+05:30).
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T03:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T11:30:00.000Z");
    expect(layout?.windowMinutes).toBe(480);
  });

  it("stretches to hold an Appointment that starts before opening", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata, an hour before the doors open.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T02:30:00.000Z");
    expect(layout?.windowMinutes).toBe(540);
  });

  it("rounds outward to a whole hour on the Business's own clock", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      // 14:20-14:50 Kolkata. Rounds out to 14:00-15:00.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:50:00.000Z"),
          endsAt: new Date("2026-08-19T09:20:00.000Z"),
        }),
      ],
    });

    // 14:00 Kolkata is 08:30 UTC — a half hour, because +05:30 is a half-hour
    // offset. Nothing here ever rounds a UTC instant.
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T08:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T09:30:00.000Z");
  });

  it("has no window at all on a closed day with nothing booked", () => {
    expect(
      dayLayout({
        date: WEDNESDAY,
        timezone: KOLKATA,
        hours: null,
        appointments: [],
      }),
    ).toBeNull();
  });

  it("builds the window from the Appointments alone on a closed day", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      // 14:00-14:45 Kolkata.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.hours).toBeNull();
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T08:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T09:30:00.000Z");
  });
});

describe("dayLayout — the gridlines", () => {
  it("puts one line on every hour, evenly spaced", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ]);
    expect(layout?.gridlines[0]?.topPercent).toBe(0);
    expect(layout?.gridlines[4]?.topPercent).toBe(50);
    expect(layout?.gridlines[8]?.topPercent).toBe(100);
  });

  it("skips the hour a spring-forward day never has", () => {
    // 8 March 2026 in New York: 02:00 becomes 03:00.
    const layout = dayLayout({
      date: { year: 2026, month: 3, day: 8 },
      timezone: NEW_YORK,
      hours: { opensAt: "01:00", closesAt: "04:00" },
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "01:00",
      "03:00",
      "04:00",
    ]);
    // Three wall-clock hours, but only two real ones. The day is shorter.
    expect(layout?.windowMinutes).toBe(120);
  });

  it("draws the hour a fall-back day has twice, twice", () => {
    // 1 November 2026 in New York: 02:00 becomes 01:00.
    const layout = dayLayout({
      date: { year: 2026, month: 11, day: 1 },
      timezone: NEW_YORK,
      hours: { opensAt: "00:00", closesAt: "03:00" },
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "00:00",
      "01:00",
      "01:00",
      "02:00",
      "03:00",
    ]);
    // Three wall-clock hours, four real ones.
    expect(layout?.windowMinutes).toBe(240);
  });

  it("never starts the window after the earliest Appointment", () => {
    /*
      The guarantee that rounding may only widen. On a spring-forward morning a
      naive floor can land in the gap, where ADR-0007 resolves it *forward* — to
      an instant later than the one being rounded down.
    */
    const startsAt = new Date("2026-03-08T06:30:00.000Z"); // 01:30 EST
    const endsAt = new Date("2026-03-08T07:15:00.000Z"); // 03:15 EDT

    const layout = dayLayout({
      date: { year: 2026, month: 3, day: 8 },
      timezone: NEW_YORK,
      hours: null,
      appointments: [appointment({ startsAt, endsAt })],
    });

    expect(layout!.windowStart.getTime()).toBeLessThanOrEqual(
      startsAt.getTime(),
    );
    expect(layout!.windowEnd.getTime()).toBeGreaterThanOrEqual(endsAt.getTime());
  });
});

describe("dayLayout — the blocks", () => {
  it("positions a block by its start and its duration", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        // 11:30-12:00 Kolkata, inside a 09:00-17:00 window.
        appointment({
          id: "appt-mid",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
      ],
    });

    const block = layout!.blocks[0]!;
    // Two and a half hours into an eight-hour window.
    expect(block.topPercent).toBeCloseTo(31.25, 5);
    // Thirty minutes of four hundred and eighty.
    expect(block.heightPercent).toBeCloseTo(6.25, 5);
    expect(block.outsideHours).toBe(false);
    expect(block.collision).toBe(false);
  });

  it("returns blocks in start order however they arrive", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          id: "later",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
        appointment({
          id: "earlier",
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks.map((block) => block.appointment.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("never lets a block run past the window", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T11:30:00.000Z"),
        }),
      ],
    });

    for (const block of layout!.blocks) {
      expect(block.topPercent).toBeGreaterThanOrEqual(0);
      expect(block.topPercent + block.heightPercent).toBeLessThanOrEqual(100);
    }
  });

  it("marks an Appointment that falls outside opening hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata, before the doors open.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks[0]?.outsideHours).toBe(true);
  });

  it("treats every Appointment on a closed day as outside hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks[0]?.outsideHours).toBe(true);
  });

  it("marks a Collision, and only a Collision", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          id: "collided",
          needsAttentionReason: "collision",
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
        appointment({
          id: "failed-to-book",
          needsAttentionReason: "book_failed",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks.map((block) => block.collision)).toEqual([
      true,
      false,
    ]);
  });
});

describe("dayLayout — the shaded bands", () => {
  it("shades nothing when the window is exactly Business Hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [],
    });

    expect(layout?.outsideHours).toEqual([]);
  });

  it("shades the stretch before opening", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata. The window becomes 08:00-17:00, nine hours.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toHaveLength(1);
    expect(layout?.outsideHours[0]?.topPercent).toBe(0);
    // One hour of nine.
    expect(layout?.outsideHours[0]?.heightPercent).toBeCloseTo(11.1111, 3);
  });

  it("shades the stretch after closing", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 18:00-18:45 Kolkata. The window becomes 09:00-19:00, ten hours.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T12:30:00.000Z"),
          endsAt: new Date("2026-08-19T13:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toHaveLength(1);
    // Closing is eight hours into a ten-hour window.
    expect(layout?.outsideHours[0]?.topPercent).toBeCloseTo(80, 5);
    expect(layout?.outsideHours[0]?.heightPercent).toBeCloseTo(20, 5);
  });

  it("shades the whole window on a closed day", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toEqual([
      { topPercent: 0, heightPercent: 100 },
    ]);
  });
});

describe("dayLayout — the lanes", () => {
  /** A Kolkata wall time on the Wednesday, as the instant it names. */
  const at = (hour: number, minute = 0): Date =>
    new Date(
      Date.UTC(2026, 7, 19, hour, minute) - 5.5 * 3_600_000,
    );

  it("gives a day with no overlaps one full-width lane each", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({ id: "a", startsAt: at(9), endsAt: at(10) }),
        appointment({ id: "b", startsAt: at(11), endsAt: at(12) }),
      ],
    });

    expect(layout?.blocks.map((b) => [b.lane, b.laneCount])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it("splits the column between two bookings at the same time", () => {
    // The case this exists for: a cancelled 10:00 booking and the rebooking
    // that replaced it. Drawn at the same width, the second hides the first.
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          id: "cancelled",
          status: "cancelled",
          startsAt: at(10),
          endsAt: at(11),
        }),
        appointment({ id: "rebooked", startsAt: at(10), endsAt: at(10, 30) }),
      ],
    });

    expect(layout?.blocks.map((b) => [b.lane, b.laneCount])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("reuses a lane as soon as the booking in it has finished", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({ id: "a", startsAt: at(10), endsAt: at(11) }),
        appointment({ id: "b", startsAt: at(10), endsAt: at(10, 30) }),
        // Starts exactly where b ended, so it takes b's lane rather than a third.
        appointment({ id: "c", startsAt: at(10, 30), endsAt: at(11) }),
      ],
    });

    /*
      Read in the order `blocks` comes back in, which is by start and then by
      end — so b (the shorter 10:00) is first and a is second. b holds lane 0,
      and c reuses it. Three bookings, two columns.
    */
    expect(layout?.blocks.map((b) => [b.lane, b.laneCount])).toEqual([
      [0, 2],
      [1, 2],
      [0, 2],
    ]);
  });

  it("puts back-to-back bookings back at full width", () => {
    // 10:00 ends where 10:00-11:00 starts: touching is not overlapping, so the
    // run of overlaps ends and the next block gets the whole column again.
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({ id: "a", startsAt: at(9), endsAt: at(10) }),
        appointment({ id: "b", startsAt: at(10), endsAt: at(11) }),
      ],
    });

    expect(layout?.blocks.map((b) => [b.lane, b.laneCount])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it("orders two Appointments starting at the same instant the same way twice", () => {
    // Without a tie-break the lanes would follow whatever order the database
    // returned, and could swap between two renders of the same day.
    const forOrder = (ids: string[]) =>
      dayLayout({
        date: WEDNESDAY,
        timezone: KOLKATA,
        hours: NINE_TO_FIVE,
        appointments: ids.map((id) =>
          appointment({ id, startsAt: at(10), endsAt: at(11) }),
        ),
      })?.blocks.map((b) => b.appointment.id);

    expect(forOrder(["b", "a"])).toEqual(["a", "b"]);
    expect(forOrder(["a", "b"])).toEqual(["a", "b"]);
  });
});

import { describe, expect, it } from "vitest";

import { openSlots, type WeekdayWindow } from "@/lib/availability/slots";

/*
  Pure — no database, no ambient clock. `now` is injected for the reason
  lib/onboarding/seed-schedule.ts gives for doing the same: otherwise
  correctness depends on the day the test runs.

  Times are asserted as instants (toISOString) rather than as formatted local
  strings, because the whole point of this module is the conversion between the
  two and a formatted assertion would hide a wrong conversion.
*/

// A salon open 09:00-17:00 on Monday only. 2026-08-17 is a Monday.
const MONDAY_ONLY: WeekdayWindow[] = [
  { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
];

const LONDON = "Europe/London";
const KOLKATA = "Asia/Kolkata";

const starts = (slots: { startsAt: Date }[]) =>
  slots.map((s) => s.startsAt.toISOString());

describe("openSlots", () => {
  it("steps from opening by the Service's duration", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      // Monday 2026-08-17. London is on BST (+01:00) in August.
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // 09:00 BST is 08:00Z. 45-minute steps, last Slot must end by 17:00 local.
    expect(starts(slots).slice(0, 3)).toEqual([
      "2026-08-17T08:00:00.000Z",
      "2026-08-17T08:45:00.000Z",
      "2026-08-17T09:30:00.000Z",
    ]);

    // 09:00-17:00 is 480 minutes; 480 / 45 = 10 whole Slots.
    expect(slots).toHaveLength(10);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2026-08-17T15:30:00.000Z");
  });

  it("never returns a Slot that would end after closing", () => {
    const slots = openSlots({
      hours: [{ weekday: 1, opensAt: "09:00", closesAt: "10:00" }],
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // One 45-minute Slot fits in a 60-minute window. The second would run to
    // 10:30, past closing — SPEC.md §14 rule 1.
    expect(starts(slots)).toEqual(["2026-08-17T08:00:00.000Z"]);
  });

  it("returns nothing on a day the Business is closed", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      // Tuesday.
      from: new Date("2026-08-18T00:00:00.000Z"),
      to: new Date("2026-08-18T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(slots).toEqual([]);
  });

  it("never returns a Slot in the past", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      // 11:30 local (10:30Z) — the 09:00 and 10:00 Slots have gone, and 11:00
      // has already started.
      now: new Date("2026-08-17T10:30:00.000Z"),
    });

    expect(starts(slots)[0]).toBe("2026-08-17T11:00:00.000Z");
  });

  it("drops a Slot that overlaps a busy period", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      // 09:30-10:30 local. Overlaps the 09:00 and 10:00 Slots, not 11:00.
      busy: [
        {
          startsAt: new Date("2026-08-17T08:30:00.000Z"),
          endsAt: new Date("2026-08-17T09:30:00.000Z"),
        },
      ],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(starts(slots)).not.toContain("2026-08-17T08:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-17T09:00:00.000Z");
    expect(starts(slots)).toContain("2026-08-17T10:00:00.000Z");
  });

  it("keeps a Slot that only touches a busy period, never overlapping it", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      // Exactly the 09:00-10:00 local Slot.
      busy: [
        {
          startsAt: new Date("2026-08-17T08:00:00.000Z"),
          endsAt: new Date("2026-08-17T09:00:00.000Z"),
        },
      ],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // Back-to-back is not an overlap: tstzrange is half-open, so the database
    // accepts 10:00 against a 09:00-10:00 Appointment. Availability must agree,
    // or it hides a Slot the database would take.
    expect(starts(slots)).toContain("2026-08-17T09:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-17T08:00:00.000Z");
  });

  it("returns nothing when the window ends before it begins", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      from: new Date("2026-08-18T00:00:00.000Z"),
      to: new Date("2026-08-17T00:00:00.000Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(slots).toEqual([]);
  });

  it("handles a half-hour offset zone", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: KOLKATA,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-16T00:00:00.000Z"),
      to: new Date("2026-08-18T00:00:00.000Z"),
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    // Asia/Kolkata is +05:30 with no DST, so 09:00 local is 03:30Z. Nothing
    // here rounds to whole hours (ADR-0007).
    expect(starts(slots)[0]).toBe("2026-08-17T03:30:00.000Z");
  });
});

describe("openSlots across daylight-saving transitions", () => {
  /*
    Europe/London springs forward on the last Sunday of March. In 2027 that is
    Sunday 28 March: at 01:00 GMT the clock jumps to 02:00 BST, so 01:00-01:59
    local never happens and the day holds 23 hours of real time.
  */
  const SPRING_FORWARD: WeekdayWindow[] = [
    { weekday: 0, opensAt: "00:00", closesAt: "06:00" },
  ];

  it("yields one fewer Slot on a spring-forward day", () => {
    const springForward = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    /*
      Midnight to 06:00 local reads as six hours on the clock but is five hours
      of real time, so five Slots — not six. The day really is shorter; an
      Appointment occupies real time, not clock time.
    */
    expect(springForward).toHaveLength(5);

    // Opens at 00:00 GMT (= 00:00Z), and the clock jump means the 01:00 Slot
    // starts where 02:00 local now reads.
    expect(starts(springForward)).toEqual([
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T02:00:00.000Z",
      "2027-03-28T03:00:00.000Z",
      "2027-03-28T04:00:00.000Z",
    ]);
  });

  it("never returns two Slots at the same instant, or overlapping ones", () => {
    const slots = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 30,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    /*
      The failure this guards against: if Slots were generated by stepping
      through wall-clock times, the times inside the gap would resolve forward
      onto instants already used, and Maya would offer the same Slot twice or
      offer two that overlap. The database would then reject a booking for a
      time she had just read out.
    */
    const instants = starts(slots);
    expect(new Set(instants).size).toBe(instants.length);

    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].startsAt.getTime()).toBeGreaterThanOrEqual(
        slots[i - 1].endsAt.getTime(),
      );
    }
  });

  it("covers both passes through a repeated fall-back hour", () => {
    /*
      Europe/London falls back on the last Sunday of October — 25 October 2026.
      At 02:00 BST the clock returns to 01:00 GMT, so 01:00-01:59 local happens
      twice and the day holds 25 hours.

      A window reading 00:00-07:00 on the clock is therefore EIGHT real hours,
      and stepping in real time offers all eight. Two of those Slots read as
      "01:00" on the wall clock while being an hour apart in real time — which is
      correct: they are genuinely different, separately bookable hours.

      This is the case that would break if Slots were generated by converting
      wall-clock times, because ADR-0007 resolves an ambiguous wall clock to the
      earlier instant and the second 01:00 would never be named.
    */
    const slots = openSlots({
      hours: [{ weekday: 0, opensAt: "00:00", closesAt: "07:00" }],
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-10-24T00:00:00.000Z"),
      to: new Date("2026-10-25T23:59:59.999Z"),
      now: new Date("2026-10-01T00:00:00.000Z"),
    });

    // Eight, not the seven the clock suggests.
    expect(slots).toHaveLength(8);

    // Opens 00:00 BST = 23:00Z the previous day.
    expect(starts(slots)).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z", // 01:00 BST
      "2026-10-25T01:00:00.000Z", // 01:00 GMT — the repeat, still offered
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
      "2026-10-25T04:00:00.000Z",
      "2026-10-25T05:00:00.000Z",
      "2026-10-25T06:00:00.000Z",
    ]);

    const instants = starts(slots);
    expect(new Set(instants).size).toBe(instants.length);
  });

  it("keeps every Slot inside Business Hours across a transition", () => {
    const slots = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 90,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    // 00:00 GMT to 06:00 BST is five real hours, so three 90-minute Slots fit
    // and the fourth would run past closing.
    expect(slots).toHaveLength(3);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2027-03-28T04:30:00.000Z");
  });

  it("handles a quarter-hour offset zone", () => {
    const slots = openSlots({
      hours: [{ weekday: 1, opensAt: "09:00", closesAt: "17:00" }],
      timezone: "Asia/Kathmandu",
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-16T00:00:00.000Z"),
      to: new Date("2026-08-18T00:00:00.000Z"),
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    // +05:45, so 09:00 local is 03:15Z. Nothing rounds to hours (ADR-0007).
    expect(starts(slots)[0]).toBe("2026-08-17T03:15:00.000Z");
  });
});

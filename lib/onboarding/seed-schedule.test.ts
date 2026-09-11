import { describe, expect, it } from "vitest";

import { BUSINESS_TYPES } from "@/lib/db/schema";
import { planSeedAppointments } from "@/lib/onboarding/seed-schedule";
import { templateFor } from "@/lib/onboarding/templates";
import { parseWallTime, partsInZone, weekdayOf } from "@/lib/time/zone";

/*
  Every property the database would otherwise enforce with a 500 during a real
  account's first minute: in the future, inside Business Hours, non-overlapping.

  The zones are chosen to be awkward on purpose — a half-hour offset, a
  quarter-hour offset, a southern-hemisphere DST schedule, and one either side
  of the date line.
*/
const ZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Europe/London",
  "America/New_York",
  "Pacific/Auckland",
  "Australia/Eucla",
];

/** A Thursday, mid-morning UTC. */
const NOW = new Date("2026-08-13T09:00:00.000Z");

describe.each(BUSINESS_TYPES)("planSeedAppointments(%s)", (businessType) => {
  const template = templateFor(businessType);

  describe.each(ZONES)("in %s", (zone) => {
    const planned = planSeedAppointments(template, zone, NOW);

    it("plans one Appointment per Template entry", () => {
      expect(planned).toHaveLength(template.appointments.length);
    });

    it("places every Appointment in the future", () => {
      for (const appointment of planned) {
        expect(
          appointment.startsAt.getTime(),
          appointment.name,
        ).toBeGreaterThan(NOW.getTime());
      }
    });

    it("places every Appointment on a day the Business is open", () => {
      const open = new Set(template.hours.map((h) => h.weekday));
      for (const appointment of planned) {
        const parts = partsInZone(appointment.startsAt, zone);
        expect(open, appointment.name).toContain(weekdayOf(parts));
      }
    });

    it("places every Appointment inside that day's opening window", () => {
      // SPEC.md §14 rule 1: never books outside Business Hours. Seeded data has
      // to hold to it too, or #6's Availability engine starts life inconsistent
      // with its own table.
      for (const appointment of planned) {
        const start = partsInZone(appointment.startsAt, zone);
        const hours = template.hours.find((h) => h.weekday === weekdayOf(start));
        expect(hours, appointment.name).toBeDefined();

        const opens = parseWallTime(hours!.opensAt);
        const closes = parseWallTime(hours!.closesAt);
        const startMinute = start.hour * 60 + start.minute;
        const durationMinutes =
          (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000;

        expect(startMinute, appointment.name).toBeGreaterThanOrEqual(
          opens.hour * 60 + opens.minute,
        );
        expect(startMinute + durationMinutes, appointment.name).toBeLessThanOrEqual(
          closes.hour * 60 + closes.minute,
        );
      }
    });

    it("derives every end time from its Service duration", () => {
      for (const appointment of planned) {
        const service = template.services.find(
          (s) => s.name === appointment.serviceName,
        );
        expect(
          appointment.endsAt.getTime() - appointment.startsAt.getTime(),
          appointment.name,
        ).toBe(service!.durationMinutes * 60_000);
      }
    });

    it("produces no overlapping ranges", () => {
      // `appointments_no_overlap` is a live EXCLUDE constraint scoped to the
      // Business, so this must hold across the whole seed, not just per day.
      const sorted = [...planned].sort(
        (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
      );
      for (let i = 1; i < sorted.length; i++) {
        expect(
          sorted[i].startsAt.getTime(),
          `${sorted[i].name} overlaps ${sorted[i - 1].name}`,
        ).toBeGreaterThanOrEqual(sorted[i - 1].endsAt.getTime());
      }
    });

    it("returns them in chronological order", () => {
      const times = planned.map((a) => a.startsAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it("is deterministic for a given now", () => {
      expect(planSeedAppointments(template, zone, NOW)).toEqual(planned);
    });
  });
});

describe("planSeedAppointments across awkward signup moments", () => {
  const template = templateFor("tutoring");

  it("never places an Appointment today, however late the signup", () => {
    // Late on a Friday night in Auckland is already Saturday in UTC — the case
    // where "the next open day" and "tomorrow" disagree about which day it is.
    const lateFriday = new Date("2026-08-14T11:30:00.000Z"); // 23:30 Fri in NZ
    const zone = "Pacific/Auckland";
    const today = partsInZone(lateFriday, zone);

    for (const appointment of planSeedAppointments(template, zone, lateFriday)) {
      const start = partsInZone(appointment.startsAt, zone);
      expect(appointment.startsAt.getTime()).toBeGreaterThan(lateFriday.getTime());
      expect(
        `${start.year}-${start.month}-${start.day}`,
        "seeded on the signup day",
      ).not.toBe(`${today.year}-${today.month}-${today.day}`);
    }
  });

  it("survives a signup on a DST-transition weekend", () => {
    // 2026-03-08 is the US spring-forward. Seeds land on the following days, so
    // the conversion has to be right on both sides of the jump.
    const zone = "America/New_York";
    const planned = planSeedAppointments(
      templateFor("clinic"),
      zone,
      new Date("2026-03-07T18:00:00.000Z"),
    );

    expect(planned.length).toBeGreaterThan(0);
    for (const appointment of planned) {
      const start = partsInZone(appointment.startsAt, zone);
      // Clinic opens at 09:00 and the earliest seed is at opening.
      expect(start.hour).toBeGreaterThanOrEqual(9);
    }
  });

  it("respects a Template whose weekend window is shorter than its weekdays", () => {
    // Tutoring runs 16:00-20:00 on weekdays but 10:00-14:00 on Saturday. A seed
    // pinned to a wall clock rather than an offset from opening would fall
    // outside Business Hours whenever day zero is a Saturday.
    const zone = "UTC";
    // 2026-08-14 is a Friday, so the first open day is Saturday the 15th.
    const planned = planSeedAppointments(template, zone, new Date("2026-08-14T09:00:00.000Z"));
    const first = partsInZone(planned[0].startsAt, zone);

    expect(weekdayOf(first)).toBe(6);
    expect(first.hour).toBe(10);
  });
});

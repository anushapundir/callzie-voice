import { describe, expect, it } from "vitest";

import { APPOINTMENT_STATUSES, BUSINESS_TYPES } from "@/lib/db/schema";
import { TEMPLATES, templateFor, type Template } from "@/lib/onboarding/templates";
import { parseWallTime } from "@/lib/time/zone";

const minutesOf = (wall: string) => {
  const { hour, minute } = parseWallTime(wall);
  return hour * 60 + minute;
};

/** The shortest opening window the Template declares, in minutes. */
const shortestWindow = (template: Template) =>
  Math.min(
    ...template.hours.map((h) => minutesOf(h.closesAt) - minutesOf(h.opensAt)),
  );

describe("TEMPLATES", () => {
  it("covers every Business Type exactly once", () => {
    // The `Record<BusinessType, Template>` type makes this a compile error, but
    // only for keys — this catches a Template filed under the wrong one.
    expect(Object.keys(TEMPLATES).sort()).toEqual([...BUSINESS_TYPES].sort());
  });

  it("renders home_services as a human string", () => {
    // The column value carries an underscore; the card must not.
    expect(TEMPLATES.home_services.label).toBe("Home services");
  });
});

describe.each(BUSINESS_TYPES)("TEMPLATES.%s", (businessType) => {
  const template = templateFor(businessType);

  it("is filed under its own Business Type", () => {
    expect(template.businessType).toBe(businessType);
  });

  it("has a label and a description for the picker card", () => {
    expect(template.label.length).toBeGreaterThan(0);
    expect(template.description.length).toBeGreaterThan(0);
    // Sentence case, no lorem ipsum (SPEC.md §11.4).
    expect(template.description).toMatch(/^[A-Z].*\.$/);
  });

  describe("Business Hours", () => {
    it("opens on at least five days", () => {
      expect(template.hours.length).toBeGreaterThanOrEqual(5);
    });

    it("declares each weekday at most once", () => {
      // `business_hours` carries UNIQUE(business_id, weekday); a duplicate here
      // fails the seed insert rather than the review.
      const weekdays = template.hours.map((h) => h.weekday);
      expect(new Set(weekdays).size).toBe(weekdays.length);
    });

    it("uses weekday numbers in range", () => {
      for (const { weekday } of template.hours) {
        expect(weekday).toBeGreaterThanOrEqual(0);
        expect(weekday).toBeLessThanOrEqual(6);
      }
    });

    it("opens before it closes", () => {
      for (const { opensAt, closesAt } of template.hours) {
        expect(minutesOf(closesAt), `${opensAt}-${closesAt}`).toBeGreaterThan(
          minutesOf(opensAt),
        );
      }
    });
  });

  describe("Services", () => {
    it("offers at least three, each with a real duration", () => {
      expect(template.services.length).toBeGreaterThanOrEqual(3);
      for (const service of template.services) {
        expect(service.name.length).toBeGreaterThan(0);
        expect(service.durationMinutes).toBeGreaterThan(0);
      }
    });

    it("names each Service once", () => {
      // Seeded Appointments resolve their Service by name, so a duplicate makes
      // that lookup ambiguous.
      const names = template.services.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe("seeded Appointments", () => {
    it("seeds at least three, so Overview is never near-empty", () => {
      expect(template.appointments.length).toBeGreaterThanOrEqual(3);
    });

    it("only references Services it offers", () => {
      // The assertion that stops a typo from aborting a real account's
      // onboarding transaction.
      const offered = new Set(template.services.map((s) => s.name));
      for (const appointment of template.appointments) {
        expect(offered, appointment.name).toContain(appointment.serviceName);
      }
    });

    it("uses only the reserved fictional phone range", () => {
      // +1 202 555 01xx is reserved for fiction. #11 and #19 point a real
      // dialler at exactly these rows, so a plausible real number here is a
      // cold call to a stranger.
      for (const appointment of template.appointments) {
        expect(appointment.phoneE164, appointment.name).toMatch(
          /^\+120255501\d{2}$/,
        );
      }
    });

    it("uses declared Appointment statuses and never fabricates Needs Attention", () => {
      // Needs Attention is #15's surface and is earned by a real failure; a
      // seeded one would be a lie the product then has to explain.
      for (const appointment of template.appointments) {
        expect(APPOINTMENT_STATUSES).toContain(appointment.status);
      }
    });

    it("shows at least one confirmed Appointment", () => {
      // A wall of `pending` reads as a queue that has never worked.
      expect(
        template.appointments.some((a) => a.status === "confirmed"),
      ).toBe(true);
    });

    it("fits inside even the shortest opening window", () => {
      // `minutesAfterOpen` is resolved against whichever weekday `openDay`
      // lands on, and that depends on the signup date. Fitting the shortest
      // window is what makes the seed valid for every possible signup day —
      // tutoring's Saturday is four hours where its weekdays are eight.
      const window = shortestWindow(template);
      for (const appointment of template.appointments) {
        const service = template.services.find(
          (s) => s.name === appointment.serviceName,
        );
        const end = appointment.minutesAfterOpen + (service?.durationMinutes ?? 0);
        expect(appointment.minutesAfterOpen).toBeGreaterThanOrEqual(0);
        expect(end, `${appointment.name} ends ${end}m after opening`).toBeLessThanOrEqual(
          window,
        );
      }
    });

    it("does not overlap itself on any day", () => {
      // `appointments_no_overlap` is a live EXCLUDE constraint; an overlapping
      // Template would abort the whole onboarding transaction.
      const byDay = new Map<number, { start: number; end: number; name: string }[]>();
      for (const appointment of template.appointments) {
        const service = template.services.find(
          (s) => s.name === appointment.serviceName,
        );
        const entry = {
          start: appointment.minutesAfterOpen,
          end: appointment.minutesAfterOpen + (service?.durationMinutes ?? 0),
          name: appointment.name,
        };
        byDay.set(appointment.openDay, [...(byDay.get(appointment.openDay) ?? []), entry]);
      }

      for (const [day, entries] of byDay) {
        const sorted = [...entries].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
          expect(
            sorted[i].start,
            `day ${day}: ${sorted[i].name} starts before ${sorted[i - 1].name} ends`,
          ).toBeGreaterThanOrEqual(sorted[i - 1].end);
        }
      }
    });

    it("uses contiguous openDay indices from zero", () => {
      // `planSeedAppointments` resolves `openDay` as an index into the next open
      // days; a gap would silently place nothing on a day it collected.
      const days = [...new Set(template.appointments.map((a) => a.openDay))].sort(
        (a, b) => a - b,
      );
      expect(days).toEqual(days.map((_, index) => index));
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  overlappingEventIds,
  wholeDayWindow,
  type AppointmentWindow,
  type CalendarEvent,
} from "@/lib/google/overlap";

/*
  ADR-0004: Google permits overlapping events and reports no conflict on insert,
  so detection is a deliberate second read. These are the rules that read
  applies.

  All of it is pure — no database, no fake fetch. "Does 09:45 touch 09:45"
  should not need an HTTP layer to answer.

  Times are written as explicit UTC instants rather than computed. The Business
  here is Asia/Kolkata (UTC+5:30), so 14:00 local is 08:30Z. Spelling both out
  means a broken zone helper cannot make a wrong test pass.
*/

const ZONE = "Asia/Kolkata";

/** 14:00 → 14:45 on 2026-08-25, Kolkata. */
const APPOINTMENT: AppointmentWindow = {
  id: "appt-1",
  startsAt: new Date("2026-08-25T08:30:00Z"),
  endsAt: new Date("2026-08-25T09:15:00Z"),
  googleEventId: "evt-ours",
};

function timed(id: string, from: string, to: string): CalendarEvent {
  return { id, start: { dateTime: from }, end: { dateTime: to } };
}

function against(
  events: CalendarEvent[],
  windows: AppointmentWindow[] = [APPOINTMENT],
): Map<string, string[]> {
  return overlappingEventIds({ events, windows, timeZone: ZONE });
}

describe("overlappingEventIds", () => {
  it("finds an event sitting across the Appointment", () => {
    // The demo case: the owner adds "Dentist" 14:30 → 15:00 by hand.
    const dentist = timed(
      "evt-dentist",
      "2026-08-25T09:00:00Z",
      "2026-08-25T09:30:00Z",
    );

    expect(against([dentist])).toEqual(new Map([["appt-1", ["evt-dentist"]]]));
  });

  it("finds an event that swallows the Appointment whole", () => {
    const allAfternoon = timed(
      "evt-block",
      "2026-08-25T07:00:00Z",
      "2026-08-25T11:00:00Z",
    );

    expect(against([allAfternoon])).toEqual(
      new Map([["appt-1", ["evt-block"]]]),
    );
  });

  it("does not treat touching at the edge as a collision", () => {
    /*
      13:15 → 14:00 ends exactly when the Appointment starts, and 14:45 → 15:30
      begins exactly when it ends. Back-to-back bookings are the normal case in
      this product, not a conflict — Slots are half-open ranges and so is the
      `appointments_no_overlap` constraint.
    */
    const before = timed(
      "evt-before",
      "2026-08-25T07:45:00Z",
      "2026-08-25T08:30:00Z",
    );
    const after = timed(
      "evt-after",
      "2026-08-25T09:15:00Z",
      "2026-08-25T10:00:00Z",
    );

    expect(against([before, after])).toEqual(new Map());
  });

  it("ignores the event Callzie itself wrote", () => {
    /*
      Without this the push-time read would flag every single booking against
      the event it had just created one HTTP call earlier.
    */
    const ours = timed(
      "evt-ours",
      "2026-08-25T08:30:00Z",
      "2026-08-25T09:15:00Z",
    );

    expect(against([ours])).toEqual(new Map());
  });

  it("ignores an event marked Free", () => {
    // `transparent` is Google's "Show me as Available". A birthday reminder is
    // not a double-booking.
    const free: CalendarEvent = {
      ...timed("evt-free", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z"),
      transparency: "transparent",
    };

    expect(against([free])).toEqual(new Map());
  });

  it("treats an event with no transparency field as busy", () => {
    /*
      The single most important line in this file. `transparency` is ABSENT on
      most real events, because `opaque` is Google's documented default. A test
      for `!== "opaque"` would ignore nearly everything on a real calendar —
      the quiet way this feature ships looking finished and detecting nothing.
    */
    const plain = timed(
      "evt-plain",
      "2026-08-25T09:00:00Z",
      "2026-08-25T09:30:00Z",
    );

    expect(against([plain])).toEqual(new Map([["appt-1", ["evt-plain"]]]));
  });

  it("counts an event marked tentative", () => {
    // A maybe on the owner's calendar is still something a human should look
    // at before Callzie phones somebody about that time.
    const maybe: CalendarEvent = {
      ...timed("evt-maybe", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z"),
      status: "tentative",
    };

    expect(against([maybe])).toEqual(new Map([["appt-1", ["evt-maybe"]]]));
  });

  it("ignores a cancelled event", () => {
    // `showDeleted` defaults to false so these should not arrive, but `get` and
    // sync responses do return them and one filter is cheaper than one bug.
    const gone: CalendarEvent = {
      ...timed("evt-gone", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z"),
      status: "cancelled",
    };

    expect(against([gone])).toEqual(new Map());
  });

  it("treats an all-day event as covering the whole day", () => {
    /*
      A deliberate product decision, not a side effect of the arithmetic: if the
      owner has blocked the whole day out, every Appointment in it really is a
      problem.

      Google sends an all-day event as start.date / end.date with the end
      EXCLUSIVE, so one day off on the 25th arrives as 25th → 26th.
    */
    const vacation: CalendarEvent = {
      id: "evt-vacation",
      start: { date: "2026-08-25" },
      end: { date: "2026-08-26" },
    };

    expect(against([vacation])).toEqual(
      new Map([["appt-1", ["evt-vacation"]]]),
    );
  });

  it("does not let an all-day event bleed into the next day", () => {
    /*
      `end.date` is exclusive. An event covering only the 24th must not catch an
      Appointment on the 25th — the off-by-one this guards is the difference
      between one Collision and one per day of somebody's holiday.
    */
    const yesterday: CalendarEvent = {
      id: "evt-yesterday",
      start: { date: "2026-08-24" },
      end: { date: "2026-08-25" },
    };

    expect(against([yesterday])).toEqual(new Map());
  });

  it("expands an all-day event in the Business's zone, not UTC", () => {
    /*
      Kolkata is UTC+5:30, so the 25th there runs 2026-08-24T18:30Z to
      2026-08-25T18:30Z. An Appointment at 00:30 local on the 25th is
      2026-08-24T19:00Z — still the 24th in UTC. Expanding in UTC would miss it.
    */
    const earlyHours: AppointmentWindow = {
      id: "appt-early",
      startsAt: new Date("2026-08-24T19:00:00Z"),
      endsAt: new Date("2026-08-24T19:45:00Z"),
      googleEventId: null,
    };
    const vacation: CalendarEvent = {
      id: "evt-vacation",
      start: { date: "2026-08-25" },
      end: { date: "2026-08-26" },
    };

    expect(against([vacation], [earlyHours])).toEqual(
      new Map([["appt-early", ["evt-vacation"]]]),
    );
  });

  it("matches many Appointments against one list of events", () => {
    // The whole reason this takes a list: one events.list request answers for
    // every upcoming Appointment at once.
    const second: AppointmentWindow = {
      id: "appt-2",
      startsAt: new Date("2026-08-25T10:30:00Z"),
      endsAt: new Date("2026-08-25T11:15:00Z"),
      googleEventId: null,
    };
    const wide = timed(
      "evt-wide",
      "2026-08-25T08:00:00Z",
      "2026-08-25T12:00:00Z",
    );

    expect(against([wide], [APPOINTMENT, second])).toEqual(
      new Map([
        ["appt-1", ["evt-wide"]],
        ["appt-2", ["evt-wide"]],
      ]),
    );
  });

  it("reports every event overlapping one Appointment", () => {
    const first = timed(
      "evt-a",
      "2026-08-25T09:00:00Z",
      "2026-08-25T09:30:00Z",
    );
    const second = timed(
      "evt-b",
      "2026-08-25T08:00:00Z",
      "2026-08-25T08:45:00Z",
    );

    expect(against([first, second])).toEqual(
      new Map([["appt-1", ["evt-a", "evt-b"]]]),
    );
  });

  it("skips an event carrying neither shape", () => {
    // Malformed input must not become a Collision on somebody's Appointment.
    const broken: CalendarEvent = { id: "evt-broken" };

    expect(against([broken])).toEqual(new Map());
  });

  it("returns nothing for an empty calendar", () => {
    expect(against([])).toEqual(new Map());
  });
});

describe("wholeDayWindow", () => {
  it("widens a single Appointment to its whole local day", () => {
    /*
      Why widen at all: Google does not document how a date-only event is
      compared against timeMin/timeMax, and all-day events are load-bearing
      here. Asking for the whole day means an all-day event is unambiguously in
      range however Google resolves it.

      Kolkata midnight on the 25th is 2026-08-24T18:30Z; the next is
      2026-08-25T18:30Z.
    */
    expect(wholeDayWindow([APPOINTMENT], ZONE)).toEqual({
      timeMin: new Date("2026-08-24T18:30:00Z"),
      timeMax: new Date("2026-08-25T18:30:00Z"),
    });
  });

  it("spans from the first day to the last", () => {
    const later: AppointmentWindow = {
      id: "appt-2",
      startsAt: new Date("2026-08-27T08:30:00Z"),
      endsAt: new Date("2026-08-27T09:15:00Z"),
      googleEventId: null,
    };

    expect(wholeDayWindow([APPOINTMENT, later], ZONE)).toEqual({
      timeMin: new Date("2026-08-24T18:30:00Z"),
      timeMax: new Date("2026-08-27T18:30:00Z"),
    });
  });

  it("does not assume the Appointments arrive in order", () => {
    const earlier: AppointmentWindow = {
      id: "appt-0",
      startsAt: new Date("2026-08-20T08:30:00Z"),
      endsAt: new Date("2026-08-20T09:15:00Z"),
      googleEventId: null,
    };

    expect(wholeDayWindow([APPOINTMENT, earlier], ZONE)).toEqual({
      timeMin: new Date("2026-08-19T18:30:00Z"),
      timeMax: new Date("2026-08-25T18:30:00Z"),
    });
  });

  it("returns null for no Appointments, so no request is made", () => {
    // The caller must be able to skip the HTTP call rather than ask Google
    // about an empty range.
    expect(wholeDayWindow([], ZONE)).toBeNull();
  });
});

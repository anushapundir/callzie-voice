import type { AppointmentRow } from "@/lib/business/list-appointments";
import { minutesSinceMidnight, type WeekdayHours } from "@/lib/settings/weekdays";
import { partsInZone, weekdayOf } from "@/lib/time/zone";

/**
 * Which existing Appointments a proposed set of Business Hours would strand.
 *
 * Narrowing Business Hours is the one Settings edit that can invalidate data
 * already in the database. `appointments` has no relationship to
 * `business_hours` — nothing in the schema stops a Business from closing
 * Wednesdays while a confirmed Wednesday Appointment sits on the books — so the
 * conflict is invisible unless something goes looking for it. #5 wants the save
 * to *warn*, not to fail: the Appointments stay exactly as they are and the
 * person is told which ones now fall outside.
 *
 * Deliberately pure. No database, and no `new Date()` for "now" — an
 * Appointment being in the past does not make it agree with the new hours, and
 * a function whose answer depends on the wall clock cannot be tested at a
 * boundary. Callers pass the rows they already loaded.
 *
 * The comparison happens entirely in wall-clock minutes, because that is the
 * unit `business_hours` is stored in (SPEC.md §5: "resolved against [the
 * Business timezone] — never as absolute timestamps"). Appointments are
 * `timestamptz`, so each one is resolved into the Business timezone *at its own
 * instant* via `partsInZone`. Subtracting a fixed offset instead would misjudge
 * every Appointment on the far side of a DST transition, and would round
 * Asia/Kolkata's +05:30 — Callzie's first market — to the wrong half hour. See
 * ADR-0007 for why this is `Intl` rather than a date library.
 */

/** An Appointment that no longer sits inside the Business Hours being saved. */
export type OutOfHoursAppointment = {
  id: string;
  name: string;
  serviceName: string;
  startsAt: Date;
};

/** One weekday's opening window, pre-resolved to minutes since local midnight. */
type OpenWindow = { opens: number; closes: number };

export function appointmentsOutsideHours(
  appointments: readonly AppointmentRow[],
  hours: readonly WeekdayHours[],
  timezone: string,
): OutOfHoursAppointment[] {
  /*
    Keyed by weekday, so a weekday absent from the map is closed. That is the
    same representation the database uses — `business_hours` has no `closed`
    column, a day is closed by having no row — which keeps this function and
    `saveBusinessHours` agreeing about what "closed" means.
  */
  const windows = new Map<number, OpenWindow>(
    hours.map((day) => [
      day.weekday,
      {
        opens: minutesSinceMidnight(day.opensAt),
        closes: minutesSinceMidnight(day.closesAt),
      },
    ]),
  );

  return appointments.filter((appointment) =>
    isOutsideHours(appointment, windows, timezone),
  ).map((appointment) => ({
    id: appointment.id,
    name: appointment.name,
    serviceName: appointment.serviceName,
    startsAt: appointment.startsAt,
  }));
}

function isOutsideHours(
  appointment: AppointmentRow,
  windows: Map<number, OpenWindow>,
  timezone: string,
): boolean {
  const start = partsInZone(appointment.startsAt, timezone);

  // The Appointment belongs to the weekday it *starts* on, in the Business's own
  // zone — not the weekday it is in UTC. Asia/Kolkata is +05:30, so a Monday
  // 09:00 Appointment is still Sunday in UTC when it begins.
  const window = windows.get(weekdayOf(start));
  if (!window) return true;

  const startMinutes = start.hour * 60 + start.minute;
  if (startMinutes < window.opens) return true;

  const end = partsInZone(appointment.endsAt, timezone);

  /*
    An Appointment that runs past local midnight is outside by definition,
    whatever the closing time reads: an opening window is same-day (`closesAt`
    is strictly after `opensAt` — see `hours-input.ts`), so nothing on the
    following civil date can be inside it. Comparing `end`'s minutes-since-
    midnight directly would be the bug — a 23:30 Appointment ending 00:30 would
    score 30 and land comfortably "before" a 17:00 close.
  */
  const endsSameDay =
    end.year === start.year && end.month === start.month && end.day === start.day;
  if (!endsSameDay) return true;

  // Ending exactly at closing time is inside. A 16:00–17:00 Appointment at a
  // business that closes at 17:00 is the normal last slot of the day, not a
  // conflict.
  return end.hour * 60 + end.minute > window.closes;
}

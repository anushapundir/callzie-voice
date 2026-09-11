import type { AppointmentStatus } from "@/lib/db/schema";
import type { Template, TemplateHours } from "@/lib/onboarding/templates";
import {
  addCalendarDays,
  parseWallTime,
  todayInZone,
  weekdayOf,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * Turns a Template's example Appointments into concrete instants in a
 * Business's own timezone.
 *
 * Pure, with `now` injected, because the alternative is a seed whose correctness
 * depends on the day the test runs. Everything the database will reject —
 * overlapping ranges (`appointments_no_overlap`), times outside Business Hours,
 * times in the past — is decided here and asserted in `seed-schedule.test.ts`,
 * so a bad Template fails in review rather than blowing up the onboarding
 * transaction of a real account.
 */

export type PlannedAppointment = {
  name: string;
  phoneE164: string;
  serviceName: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
};

/** How far ahead to look for open days before giving up. */
const MAX_LOOKAHEAD_DAYS = 14;

export function planSeedAppointments(
  template: Template,
  timezone: string,
  now: Date,
): PlannedAppointment[] {
  const daysNeeded =
    Math.max(...template.appointments.map((a) => a.openDay)) + 1;
  const openDays = nextOpenDays(template, timezone, now, daysNeeded);

  const planned = template.appointments.map((appointment) => {
    const day = openDays[appointment.openDay];
    const durationMinutes = durationFor(template, appointment.serviceName);

    const opensAt = parseWallTime(day.hours.opensAt);
    const startMinute =
      opensAt.hour * 60 + opensAt.minute + appointment.minutesAfterOpen;

    const startsAt = zonedTimeToInstant(
      {
        ...day.date,
        hour: Math.floor(startMinute / 60),
        minute: startMinute % 60,
      },
      timezone,
    );

    return {
      name: appointment.name,
      phoneE164: appointment.phoneE164,
      serviceName: appointment.serviceName,
      status: appointment.status,
      startsAt,
      // Absolute milliseconds, not a wall-clock addition. An Appointment
      // occupies real time: a 90-minute Colour that straddles a spring-forward
      // still takes 90 minutes, even though the clock advances by 150.
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
    };
  });

  return planned.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

type OpenDay = { date: CivilDate; hours: TemplateHours };

/**
 * The Business's next `count` open days, starting **strictly after** today in
 * its own timezone.
 *
 * Strictly after, rather than "the next opening from now", on purpose: it makes
 * this total and deterministic with no "what if it is already past closing"
 * branch, and it guarantees every seeded Appointment is in the future, which
 * `check_availability` (#6) will require. The cost is that a Friday-evening
 * signup sees Monday's examples rather than tomorrow's — acceptable for data
 * whose job is to demonstrate the product.
 */
function nextOpenDays(
  template: Template,
  timezone: string,
  now: Date,
  count: number,
): OpenDay[] {
  const hoursByWeekday = new Map(template.hours.map((h) => [h.weekday, h]));
  const today = todayInZone(now, timezone);
  const found: OpenDay[] = [];

  for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS && found.length < count; offset++) {
    const date = addCalendarDays(today, offset);
    const hours = hoursByWeekday.get(weekdayOf(date));
    if (hours) found.push({ date, hours });
  }

  if (found.length < count) {
    // Unreachable for the shipped Templates — each opens on at least five
    // weekdays — so this is a bug in a Template, not a runtime condition.
    throw new Error(
      `Template "${template.businessType}" opens on too few days to place ` +
        `${count} days of seeded Appointments within ${MAX_LOOKAHEAD_DAYS} days`,
    );
  }

  return found;
}

function durationFor(template: Template, serviceName: string): number {
  const service = template.services.find((s) => s.name === serviceName);
  if (!service) {
    // `templates.test.ts` asserts every serviceName resolves, so reaching this
    // means the Template and its test disagree.
    throw new Error(
      `Template "${template.businessType}" seeds an Appointment for Service ` +
        `"${serviceName}", which it does not offer`,
    );
  }
  return service.durationMinutes;
}

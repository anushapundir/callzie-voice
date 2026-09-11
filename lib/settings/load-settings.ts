import { asc, count, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { toWallTime, WEEKDAYS } from "@/lib/settings/weekdays";

/**
 * Everything the Settings screen renders about Business Hours and Services, in
 * the shape the forms want (issue #5).
 *
 * Both halves are read here rather than by the components that show them,
 * because both need reshaping that is easy to get subtly wrong and worth doing
 * exactly once: a week that always has seven rows, times in the format an
 * `<input type="time">` speaks, and a Service that knows how many Appointments
 * stand behind it.
 *
 * The return types are narrow on purpose. This crosses from a Server Component
 * to the client, and neither `businesses` nor `services` should ship columns
 * the UI does not render — the same reasoning as
 * `lib/business/list-appointments.ts`.
 *
 * Explicit `select` + `leftJoin`, never `db.query.services.findMany({ with })`:
 * **no `relations()` are declared anywhere in this repo**. `lib/db/schema.ts`
 * wires tables with FK `.references()` only, which the relational query API
 * cannot use. Adding `relations()` is a schema-wide convention change, not
 * something to slip into a feature ticket.
 */

export type SettingsHoursRow = {
  /** 0 = Sunday, matching `business_hours.weekday`. */
  weekday: number;
  label: string;
  /** False when no `business_hours` row exists for this weekday. */
  open: boolean;
  /** `"09:00"` — wall clock in the Business's own timezone, never an instant. */
  opensAt: string;
  closesAt: string;
};

export type SettingsServiceRow = {
  id: string;
  name: string;
  durationMinutes: number;
  /** How many Appointments reference this Service. Zero means it is safe to delete. */
  appointmentCount: number;
};

export type SettingsData = {
  /** Always seven entries, weekday 0..6, in `WEEKDAYS` order. */
  hours: SettingsHoursRow[];
  services: SettingsServiceRow[];
};

/**
 * What a closed day shows the moment somebody toggles it open.
 *
 * A closed weekday has no `business_hours` row at all, so there is no stored
 * time to render — and a pair of empty time inputs is a form that cannot be
 * submitted without also being filled in, for a day the user only meant to
 * open. Every Template opens somewhere inside 09:00–17:00
 * (`lib/onboarding/templates.ts`), so this is a plausible starting point rather
 * than a value anyone is stuck with.
 */
const PLACEHOLDER_OPENS_AT = "09:00";
const PLACEHOLDER_CLOSES_AT = "17:00";

export async function loadSettings(businessId: string): Promise<SettingsData> {
  const [hourRows, serviceRows] = await Promise.all([
    db
      .select({
        weekday: schema.businessHours.weekday,
        opensAt: schema.businessHours.opensAt,
        closesAt: schema.businessHours.closesAt,
      })
      .from(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId)),

    db
      .select({
        id: schema.services.id,
        name: schema.services.name,
        durationMinutes: schema.services.durationMinutes,
        /*
          `count(appointments.id)`, not `count()`. A star count over a left join
          counts the synthesised all-null row too, so a Service nothing points
          at would report one Appointment — and the guard in
          `lib/settings/services.ts` would then look like it was refusing every
          delete. Counting a non-null column returns 0 for the unmatched side.
        */
        appointmentCount: count(schema.appointments.id),
      })
      .from(schema.services)
      /*
        A LEFT join, deliberately. An inner join would drop every Service with
        no Appointments — which is exactly the set of Services that can be
        deleted, so the rows most worth showing would be the ones missing.

        Joined on `service_id` alone, without also requiring the Appointment's
        `business_id` to match: the count has to agree with the one
        `deleteService` uses to decide whether the FK will block a delete, and
        that constraint knows nothing about `business_id`.
      */
      .leftJoin(
        schema.appointments,
        eq(schema.appointments.serviceId, schema.services.id),
      )
      .where(eq(schema.services.businessId, businessId))
      // Every projected column, not just the primary key. Postgres would infer
      // the other two as functionally dependent on `id` and accept it, but the
      // grouping then only holds as long as `id` stays the primary key of the
      // table these columns come from — a condition nothing here states.
      .groupBy(
        schema.services.id,
        schema.services.name,
        schema.services.durationMinutes,
      )
      .orderBy(asc(schema.services.name)),
  ]);

  const byWeekday = new Map(hourRows.map((row) => [row.weekday, row]));

  return {
    /*
      Driven by WEEKDAYS rather than by what came back, so the form always has
      seven rows in one fixed order whatever the database holds. A closed day is
      the *absence* of a `business_hours` row (SPEC.md §5 — there is no `open`
      column), and a week rendered from stored rows alone would silently shrink
      to five inputs for a Mon–Fri Business, leaving no control to open Saturday
      with.
    */
    hours: WEEKDAYS.map(({ weekday, label }) => {
      const row = byWeekday.get(weekday);
      return {
        weekday,
        label,
        open: row !== undefined,
        /*
          `toWallTime` because `pg` renders a `time` column as `HH:MM:SS` while
          an `<input type="time">` submits and expects `HH:mm`. Skipping this
          makes a round trip through the database change the string without
          changing the meaning, so every untouched row reads as edited.
        */
        opensAt: row ? toWallTime(row.opensAt) : PLACEHOLDER_OPENS_AT,
        closesAt: row ? toWallTime(row.closesAt) : PLACEHOLDER_CLOSES_AT,
      };
    }),
    services: serviceRows,
  };
}

import { field } from "@/lib/form-field";

/**
 * Validation for the two fields a Service carries — name and duration.
 *
 * Settings edits a live Business (issue #5), so the Server Action behind this
 * form is a POST reachable by anyone who can send it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"). Nothing here may assume the request came from the rendered form:
 * the duration arrives as a string even though the input is `type="number"`,
 * and `id` arrives as an opaque string that this module deliberately does not
 * trust — ownership of a Service id is settled against the database in
 * `lib/settings/services.ts`, never here.
 *
 * Hand-written rather than zod, matching `lib/onboarding/input.ts` and the
 * convention `lib/db/schema.ts` states: "the unions below are the real contract
 * and are enforced in application code". Two fields with numeric bounds do not
 * earn a schema library, and the discriminated result below is the seam to swap
 * behind if one is ever wanted.
 *
 * These types live here rather than in the action because a `"use server"`
 * module may only export async functions — `INITIAL_SERVICES_STATE` could not
 * live there, and the client component needs it.
 */

/**
 * Longest Service name accepted. An application rule, not a column constraint:
 * `services.name` is plain `text`. The name is read aloud by the Retell Agent
 * and rendered in a table cell, so it needs a ceiling somewhere.
 */
export const MAX_SERVICE_NAME_LENGTH = 60;

/**
 * Duration bounds, in minutes. The lower bound keeps a Service from being
 * shorter than the granularity Availability offers Slots at (SPEC.md §6); the
 * upper bound is eight hours, longer than any Template's opening window, so a
 * Service that cannot fit inside a single day is rejected at the form rather
 * than becoming an Appointment that no Slot can ever hold.
 */
export const MIN_SERVICE_MINUTES = 5;
export const MAX_SERVICE_MINUTES = 480;

export type ServiceErrors = {
  name?: string;
  durationMinutes?: string;
  /**
   * Not attributable to a field — the row vanished, or a rule about the set of
   * Services as a whole refused the change. Rendered above the form.
   */
  form?: string;
};

/** Echoed back so a rejected submit repopulates instead of clearing. */
export type ServiceValues = {
  /**
   * Which row was being edited, passed straight through unvalidated. The form
   * needs it to reopen the right row's editor after a failed submit; it is
   * never used as an authorisation claim.
   */
  id?: string;
  name?: string;
  durationMinutes?: string;
};

export type ServicesState = {
  errors?: ServiceErrors;
  values?: ServiceValues;
  /**
   * A successful write. Distinct from "no errors": the initial state has no
   * errors either, and the form must not announce a save that never happened.
   */
  saved?: boolean;
};

export const INITIAL_SERVICES_STATE: ServicesState = {};

export type ServiceInput = {
  name: string;
  durationMinutes: number;
};

export type ParsedServiceInput =
  | { ok: true; value: ServiceInput }
  | { ok: false; errors: ServiceErrors; values: ServiceValues };

/**
 * A decimal number as a person or an `<input type="number">` writes one.
 *
 * `Number()` alone is too generous to use as the "is this a number at all"
 * test: it reads `"0x1e"` as 30, `"1e3"` as 1000 and `" "` as 0, so a string
 * that is not a duration in any human sense would pass the numeric check and
 * then be judged on its range. Deciding the shape with a regex first means each
 * rejection can say which thing was wrong.
 */
const NUMERIC = /^[+-]?\d+(\.\d+)?$/;


export function parseServiceInput(formData: FormData): ParsedServiceInput {
  const rawId = field(formData, "id");
  const rawName = field(formData, "name");
  const rawDuration = field(formData, "durationMinutes");

  const errors: ServiceErrors = {};
  const name = rawName.trim();
  const duration = rawDuration.trim();

  if (name.length === 0) {
    errors.name = "Name this service.";
  } else if (name.length > MAX_SERVICE_NAME_LENGTH) {
    errors.name = `Keep the name under ${MAX_SERVICE_NAME_LENGTH} characters.`;
  }

  let durationMinutes = Number.NaN;

  if (duration.length === 0) {
    errors.durationMinutes = "Enter how long this service takes.";
  } else if (!NUMERIC.test(duration)) {
    errors.durationMinutes = "Enter the duration as a number of minutes.";
  } else if (!Number.isInteger(Number(duration))) {
    // `services.duration_minutes` is an `integer` column and the value is added
    // to a start time to derive `appointments.ends_at`. A fractional minute
    // would either round on the way into Postgres or produce an end time that
    // no Slot boundary lines up with, so it is refused rather than coerced.
    errors.durationMinutes = "Give the duration in whole minutes — 45, not 45.5.";
  } else {
    durationMinutes = Number(duration);
    if (
      durationMinutes < MIN_SERVICE_MINUTES ||
      durationMinutes > MAX_SERVICE_MINUTES
    ) {
      errors.durationMinutes =
        `Duration must be between ${MIN_SERVICE_MINUTES} and ` +
        `${MAX_SERVICE_MINUTES} minutes.`;
    }
  }

  // Both fields are reported at once. Returning only the first would make a
  // form with two problems take two round trips to fix.
  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: { id: rawId, name: rawName, durationMinutes: rawDuration },
    };
  }

  return { ok: true, value: { name, durationMinutes } };
}

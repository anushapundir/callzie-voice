import { field } from "@/lib/form-field";
import type { OutOfHoursAppointment } from "@/lib/settings/hours-conflicts";
import { WEEKDAYS, type WeekdayHours } from "@/lib/settings/weekdays";
import { tryParseWallTime } from "@/lib/time/zone";

/**
 * Validation for the weekly Business Hours grid in Settings.
 *
 * Same shape and same reasoning as `lib/onboarding/input.ts`: hand-written, one
 * discriminated result, every problem reported at once, and no zod — see that
 * file's docblock for why, and `lib/form-field.ts` for the trap that
 * `Object.fromEntries(formData)` sets. A Server Action is a POST reachable by
 * anyone who can send it, so nothing here assumes the request came from the
 * form; seven weekdays' worth of untrusted strings arrive and are treated as
 * such.
 *
 * The grid submits one checkbox and two times per weekday, so the error shape
 * is per-weekday (`errors.days`) rather than per-field-name. A day with a bad
 * open time and a bad close time is one broken row to the person looking at it,
 * and gets one message.
 *
 * These types live here rather than in the action because a `"use server"`
 * module may only export async functions — `INITIAL_HOURS_STATE` could not live
 * there, and the client component needs it.
 */

export type HoursErrors = {
  /** A problem with the submission as a whole, not with any one weekday. */
  form?: string;
  /** Keyed by weekday, 0 = Sunday — matching `business_hours.weekday`. */
  days?: Record<number, string>;
};

/**
 * The raw submission echoed back, keyed by form field name.
 *
 * Deliberately untyped-per-field: the grid's names are computed
 * (`opensAt-${weekday}`), so a struct here would be seven near-identical
 * triples restating what `WEEKDAYS` already says.
 */
export type HoursValues = Record<string, string>;

export type HoursState = {
  errors?: HoursErrors;
  /** Echoed back so a rejected save repopulates instead of clearing. */
  values?: HoursValues;
  /**
   * Appointments the *saved* hours now strand. A warning, never a rejection —
   * the save has already happened when these are present (see
   * `hours-conflicts.ts`).
   */
  outOfHours?: OutOfHoursAppointment[];
  saved?: boolean;
};

export const INITIAL_HOURS_STATE: HoursState = {};

export type ParsedHoursInput =
  | { ok: true; value: WeekdayHours[] }
  | { ok: false; errors: HoursErrors; values: HoursValues };


/** `"09:30"` → 570, from parts already parsed. */
function minutesOf(time: { hour: number; minute: number }): number {
  return time.hour * 60 + time.minute;
}

export function parseBusinessHoursInput(formData: FormData): ParsedHoursInput {
  const values: HoursValues = {};
  const days: Record<number, string> = {};
  const open: WeekdayHours[] = [];
  /** Days ticked open, valid or not — see the `errors.form` check below. */
  let opened = 0;

  for (const { weekday, label } of WEEKDAYS) {
    /*
      An unchecked checkbox submits nothing at all, so presence — not value — is
      what "open" means. Reading this with `field()` would collapse "absent" and
      "present but empty" into the same empty string and mark every day closed.
    */
    const isOpen = formData.get(`open-${weekday}`) !== null;
    const rawOpensAt = field(formData, `opensAt-${weekday}`);
    const rawClosesAt = field(formData, `closesAt-${weekday}`);

    /*
      Echoed for every weekday, open or closed — but a closed day's two entries
      are empty strings in practice, and the form must not treat them as the
      truth. `business-hours-form.tsx` disables a closed row's inputs, and a
      disabled control is omitted from `FormData` entirely, so nothing arrives
      here to echo back. The form therefore reads these times only for the days
      this echo reports open, falling back to the stored hours for the rest.

      The keys are still written unconditionally so the shape of `values` does
      not depend on which days were ticked; a consumer indexing it never has to
      distinguish "closed" from "absent".
    */
    if (isOpen) values[`open-${weekday}`] = "on";
    values[`opensAt-${weekday}`] = rawOpensAt;
    values[`closesAt-${weekday}`] = rawClosesAt;

    // A closed day's times are not validated and not returned. Someone who
    // closes Sunday must not be blocked by whatever the disabled Sunday inputs
    // happened to still contain.
    if (!isOpen) continue;
    opened += 1;

    const opensAt = tryParseWallTime(rawOpensAt);
    const closesAt = tryParseWallTime(rawClosesAt);
    if (!opensAt || !closesAt) {
      days[weekday] = `Set an opening and a closing time for ${label}.`;
      continue;
    }

    /*
      Strictly after, so **no overnight windows**. #6's Availability engine
      resolves an opening window as a same-day pair of wall-clock times against
      the Business timezone, so a window that wrapped past midnight — 22:00 to
      02:00 — would yield an empty range and silently produce no Slots at all
      rather than an error. A business that genuinely trades overnight is out of
      scope for SPEC.md §5's model; rejecting it here is honest, and the
      alternative is a Business that looks configured and never offers a time.

      Equal times are rejected by the same test: a zero-length window is a
      closed day spelled confusingly.
    */
    if (minutesOf(closesAt) <= minutesOf(opensAt)) {
      days[weekday] =
        `${label} must close after it opens — overnight hours are not supported.`;
      continue;
    }

    open.push({ weekday, opensAt: rawOpensAt, closesAt: rawClosesAt });
  }

  const errors: HoursErrors = {};
  if (Object.keys(days).length > 0) errors.days = days;

  /*
    Zero open days is the one state this form must never save. Availability is
    computed from Business Hours, so a Business with none can offer no Slot,
    take no booking, and give an Agent nothing to negotiate with — precisely the
    "unusable state" #5 exists to prevent. It is reported on the form rather
    than on a weekday because no single weekday is at fault.

    Counted from the checkboxes, not from `open`, so that a single day ticked
    open with a mistyped time reports only "fix that day". Telling someone who
    just opened Monday that they have opened nothing would be advice that
    contradicts what they can see.
  */
  if (opened === 0) {
    errors.form =
      "Open at least one day — a business with no hours can take no bookings.";
  }

  // Every problem at once. Returning only the first would make a grid with a
  // typo on Tuesday and another on Friday take two round trips to fix.
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  return { ok: true, value: open };
}

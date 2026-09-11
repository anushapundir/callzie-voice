import { parseE164 } from "@/lib/appointments/phone";
import { field } from "@/lib/form-field";

/**
 * Validation for the four fields the Overview quick-add card carries.
 *
 * Shaped like `lib/settings/services-input.ts` and for the same reasons: a
 * `parse*` returning a discriminated result, hand-written rather than zod, with
 * the state types beside it because a `"use server"` module may export nothing
 * but async functions.
 *
 * A Server Action is a POST reachable by anyone who can send it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"), so nothing here assumes the request came from the rendered card.
 * `serviceId` arrives as an opaque string and is deliberately not trusted:
 * whether that Service exists and belongs to this Business is settled against
 * the database in `lib/availability/schedule.ts`, never here.
 */

/**
 * Longest name accepted. An application rule, not a column constraint:
 * `appointments.name` is plain `text`. The name is read aloud by the Retell
 * Agent and rendered in a table cell, so it needs a ceiling somewhere.
 */
export const MAX_NAME_LENGTH = 80;

export type QuickAddErrors = {
  name?: string;
  phone?: string;
  serviceId?: string;
  startsAt?: string;
  /**
   * Not attributable to a field — the Service vanished, or the write was
   * refused for a reason no single input caused. Rendered above the form.
   */
  form?: string;
};

/** Echoed back so a rejected submit repopulates instead of clearing. */
export type QuickAddValues = {
  name?: string;
  phone?: string;
  serviceId?: string;
  startsAt?: string;
};

export type QuickAddState = {
  errors?: QuickAddErrors;
  values?: QuickAddValues;
  /**
   * A successful write. Distinct from "no errors": the initial state has no
   * errors either, and the card must not announce an Appointment that was never
   * created.
   *
   * The `id` is what lets the card chain the dial onto the same submit — the
   * Quick Call card's one accent button adds the Appointment and then calls it
   * (SPEC.md §11.3).
   */
  added?: { id: string; name: string; startsAt: string };
};

export const INITIAL_QUICK_ADD_STATE: QuickAddState = {};

export type QuickAddInput = {
  name: string;
  phoneE164: string;
  serviceId: string;
  startsAt: Date;
};

export type ParsedQuickAddInput =
  | { ok: true; value: QuickAddInput }
  | { ok: false; errors: QuickAddErrors; values: QuickAddValues };

export function parseQuickAddInput(formData: FormData): ParsedQuickAddInput {
  const rawName = field(formData, "name");
  const rawPhone = field(formData, "phone");
  const rawServiceId = field(formData, "serviceId");
  const rawStartsAt = field(formData, "startsAt");

  const errors: QuickAddErrors = {};

  const name = rawName.trim();
  if (name.length === 0) {
    errors.name = "Enter the person's name.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  }

  // The phone validator owns its own wording, so a bad number reads the same
  // here as it will in #8's per-row CSV report.
  let phoneE164 = "";
  const phone = parseE164(rawPhone);
  if (phone.ok) {
    phoneE164 = phone.value;
  } else {
    errors.phone = phone.error;
  }

  const serviceId = rawServiceId.trim();
  if (serviceId.length === 0) {
    errors.serviceId = "Choose a service.";
  }

  const rawTime = rawStartsAt.trim();
  let startsAt = new Date(Number.NaN);
  if (rawTime.length === 0) {
    errors.startsAt = "Choose a time.";
  } else {
    startsAt = new Date(rawTime);
    if (Number.isNaN(startsAt.getTime())) {
      // The card's `<option value>` is an ISO instant. Anything else was not
      // sent by the card, and is a field error rather than a 500.
      errors.startsAt = "Choose a time from the list.";
    }
  }

  // Every field is reported at once. Returning only the first would make a
  // form with two problems take two round trips to fix.
  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: {
        name: rawName,
        phone: rawPhone,
        serviceId: rawServiceId,
        startsAt: rawStartsAt,
      },
    };
  }

  return { ok: true, value: { name, phoneE164, serviceId, startsAt } };
}

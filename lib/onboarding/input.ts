import { BUSINESS_TYPES, type BusinessType } from "@/lib/db/schema";
import { field } from "@/lib/form-field";
import { normalizeTimeZone } from "@/lib/time/timezones";

/**
 * Validation for the three fields onboarding collects.
 *
 * A Server Action runs as a POST against the page and is reachable by anyone
 * who can send that POST, so nothing here may assume the request came from the
 * form (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"). Every value is treated as untrusted string input.
 *
 * Hand-written rather than zod, matching the convention `lib/db/schema.ts`
 * already states — "the unions below are the real contract and are enforced in
 * application code". There are three fields, and the two substantive checks are
 * membership in `BUSINESS_TYPES` and a timezone the runtime can resolve, both
 * of which already exist. If #7's E.164 rules or #8's per-row CSV errors want a
 * schema library, the discriminated result below is the seam to swap behind.
 *
 * These types live here rather than in the action because a `"use server"`
 * module may only export async functions — `INITIAL_ONBOARDING_STATE` could not
 * live there, and the client component needs it.
 */

/** Longest Business name accepted. Application rule, not a column constraint. */
export const MAX_BUSINESS_NAME_LENGTH = 80;

export type OnboardingFieldErrors = {
  businessType?: string;
  name?: string;
  timezone?: string;
};

export type OnboardingState = {
  errors?: OnboardingFieldErrors;
  /** Echoed back so a rejected submit repopulates instead of clearing. */
  values?: {
    businessType?: string;
    name?: string;
    timezone?: string;
  };
};

export const INITIAL_ONBOARDING_STATE: OnboardingState = {};

export type OnboardingInput = {
  name: string;
  businessType: BusinessType;
  /** Normalised to this runtime's spelling — see `normalizeTimeZone`. */
  timezone: string;
};

export type ParsedOnboardingInput =
  | { ok: true; value: OnboardingInput }
  | { ok: false; errors: OnboardingFieldErrors; values: OnboardingState["values"] };

function isBusinessType(value: unknown): value is BusinessType {
  return (
    typeof value === "string" &&
    (BUSINESS_TYPES as readonly string[]).includes(value)
  );
}


export function parseOnboardingInput(formData: FormData): ParsedOnboardingInput {
  const rawBusinessType = field(formData, "businessType");
  const rawName = field(formData, "name");
  const rawTimezone = field(formData, "timezone");

  const errors: OnboardingFieldErrors = {};
  const name = rawName.trim();
  const timezone = normalizeTimeZone(rawTimezone);

  if (!isBusinessType(rawBusinessType)) {
    errors.businessType = "Choose a business type.";
  }

  if (name.length === 0) {
    errors.name = "Name your business.";
  } else if (name.length > MAX_BUSINESS_NAME_LENGTH) {
    // The name is a display string in the sidebar and becomes a dynamic
    // variable in the Agent prompt at #9, so it needs a ceiling somewhere.
    errors.name = `Keep the name under ${MAX_BUSINESS_NAME_LENGTH} characters.`;
  }

  if (timezone === null) {
    errors.timezone = "Choose a timezone from the list.";
  }

  // Every field is reported at once. Returning only the first would make a form
  // with two problems take two round trips to fix.
  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: {
        businessType: rawBusinessType,
        name: rawName,
        timezone: rawTimezone,
      },
    };
  }

  return {
    ok: true,
    value: {
      name,
      businessType: rawBusinessType as BusinessType,
      // The normalised spelling, not the submitted one: `businesses.timezone`
      // must hold a name this deployment can always resolve.
      timezone: timezone as string,
    },
  };
}

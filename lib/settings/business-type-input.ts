import { BUSINESS_TYPES, type BusinessType } from "@/lib/db/schema";
import { field } from "@/lib/form-field";

/**
 * Validation and form state for the Business Type picker in Settings.
 *
 * Split from `lib/settings/business-type.ts`, which performs the write, for one
 * concrete reason: **this module must not import the database.**
 * `INITIAL_BUSINESS_TYPE_STATE` is consumed by `useActionState` inside a
 * `"use client"` component, and a *value* import from a client module pulls the
 * whole transitive graph into the client bundle. `business-type.ts` imports
 * `@/lib/db` and therefore `pg`, whose `net`/`tls`/`dns` requires the client
 * build has no fallback for — so the build fails at bundle resolution, far from
 * the import that caused it.
 *
 * `lib/settings/hours-input.ts` and `lib/settings/services-input.ts` are
 * database-free for the same reason; this file restores that symmetry, so
 * "`*-input.ts` is safe to import from the client, everything else is not" is a
 * rule that holds across all three rather than in two cases out of three.
 *
 * Same conventions as `lib/onboarding/input.ts`: hand-written, a discriminated
 * result, no zod. There is one field, so there is one error.
 */

export type BusinessTypeState = {
  errors?: { businessType?: string };
  /**
   * A successful write. Distinct from "no errors": the initial state has none
   * either, and the form must not announce a save that never happened.
   */
  saved?: boolean;
};

export const INITIAL_BUSINESS_TYPE_STATE: BusinessTypeState = {};

/**
 * `business_type` is `text` in Postgres, not a pg enum — `lib/db/schema.ts`
 * chose that deliberately so a new type never needs a migration, and says the
 * union "is the real contract and [is] enforced in application code". This
 * membership check is that enforcement. Without it a Server Action POST could
 * write `business_type = 'restaurant'`, which no Template and no `retell_agents`
 * row answers to, leaving the account unable to place a Call.
 *
 * The same check as `lib/onboarding/input.ts`, restated rather than shared: the
 * two forms validate different submissions and neither should acquire the
 * other's fields by importing across the boundary.
 */
function isBusinessType(value: unknown): value is BusinessType {
  return (
    typeof value === "string" &&
    (BUSINESS_TYPES as readonly string[]).includes(value)
  );
}

export function parseBusinessTypeInput(
  formData: FormData,
):
  | { ok: true; value: BusinessType }
  | { ok: false; errors: { businessType: string } } {
  const rawBusinessType = field(formData, "businessType");

  if (!isBusinessType(rawBusinessType)) {
    return { ok: false, errors: { businessType: "Choose a business type." } };
  }

  return { ok: true, value: rawBusinessType };
}

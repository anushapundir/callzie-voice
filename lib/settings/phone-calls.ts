import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Turning the Phone Call flag on and off (SPEC.md §3 rule 9, §14 rule 6).

  The admin check is in the WHERE clause, not in a branch above the write. A
  Server Action is a POST anybody can send, and rendering a switch on an
  admin-gated screen is not a security boundary — so a non-admin's update has to
  match zero rows rather than be caught by an `if` somebody could reorder.

  Same discipline as `claimCallQuota` and every cross-tenant guard in `lib/`:
  scope in the statement.

  Worth knowing why a UI control on this flag is defensible at all on an
  open-signup product: `businesses.is_admin` is never written by application
  code. Nothing in the codebase sets it, and SPEC.md §14 rule 9 rules out the
  roles UI that would. Reaching this write means somebody typed an UPDATE into a
  database console first.
*/

/**
 * Sets `phone_calls_enabled`, if the Business is an admin account.
 *
 * Returns whether a row changed. False covers three situations — not an admin,
 * no such Business, and an id from another account — and they get the same
 * answer deliberately: none of them may write, and a caller holding an id that
 * resolves to nothing has no business knowing which it was.
 */
export async function setPhoneCallsEnabled(
  businessId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: enabled })
    .where(
      and(
        eq(schema.businesses.id, businessId),
        eq(schema.businesses.isAdmin, true),
      ),
    )
    .returning({ id: schema.businesses.id });

  return rows.length > 0;
}

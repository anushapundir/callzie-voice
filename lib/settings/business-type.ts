import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { BusinessType } from "@/lib/db/schema";

/**
 * Changing a Business Type from Settings — "changeable, no data migration"
 * (SPEC.md §11.3, issue #5).
 *
 * The whole operation is one column. That reads like an omission, so here is
 * why nothing else moves:
 *
 * - **The Template is read at Onboarding and never again.**
 *   `lib/onboarding/templates.ts` describes what an account *starts* with —
 *   Business Hours, a few Services, example Appointments — and
 *   `lib/onboarding/create-business.ts` is the only caller of `templateFor`.
 *   Re-running it here would overwrite Business Hours someone has since edited
 *   and re-seed fictional Appointments into a working diary; issue #5's own
 *   acceptance criterion is that a type change happens "without touching
 *   existing Appointments or Services".
 * - **The seed path is Onboarding-only by construction.** It lives inside
 *   `createOnboardedBusiness`'s transaction, guarded by the
 *   `businesses_user_id_unique` insert that only succeeds once per account. It
 *   cannot be reached a second time, and this module must not grow a route to
 *   it.
 * - **The Retell Agent is keyed off `business_type`.** `retell_agents` is a
 *   four-row lookup table, one Agent per Business Type, shared by every account
 *   (SPEC.md §7, `docs/adr/0006-agents-reconciled-against-retell.md`). The Call
 *   path joins on this column, so writing it
 *   is what re-points an account at the salon Agent instead of the clinic one.
 *   There is no per-Business Agent to re-provision.
 *
 * So: Appointments, Services and Business Hours are all data this account now
 * owns, and a type change is a change of which Agent conducts its Calls. One
 * `UPDATE`, scoped to the Business.
 */

/**
 * Writes the new type and nothing else.
 *
 * No transaction, because there is one statement. No `returning()`, because the
 * caller re-reads Settings anyway and a Business id resolved from the Clerk
 * session always exists — a zero-row update here would mean the session
 * outlived its account, which is `provisionUser`'s problem, not this form's.
 */
export async function changeBusinessType(
  businessId: string,
  businessType: BusinessType,
): Promise<void> {
  await db
    .update(schema.businesses)
    .set({ businessType })
    .where(eq(schema.businesses.id, businessId));
}

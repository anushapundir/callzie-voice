import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { failureKind, type FailureKind } from "@/lib/webhooks/status";

/*
  The two Retell failures a person has to do something about.

  `mapDisconnectionReason` files both as `failed`, which is correct — the Call
  did fail. But SPEC.md §11.4 asks for inline persistent UI for anything
  requiring action, and these two require very different actions: top up the
  Retell balance, or wait and try again. Shown as a generic failed Call, the
  first reads as a bug in Callzie until somebody thinks of checking the billing
  page.

  Deliberately NOT a `needs_attention_reason`. SPEC.md §5 fixes exactly four of
  those and neither of these is one; widening a locked enum to borrow a UI
  surface would be the wrong trade. This is a property of the account's most
  recent Call, read at render time — no column, no migration, nothing to clean
  up.
*/

/** What a banner can say. `generic` is not one: there is nothing to show. */
export type CallAlertKind = Exclude<FailureKind, "generic">;

/**
 * Whether this Business's last Call hit something it needs to act on.
 *
 * **The most recent Call, and only that one.** That is what makes the banner
 * clear itself: a Call that connects afterwards is proof the balance was topped
 * up or the burst passed, so there is nothing left to act on and nothing for
 * anyone to dismiss.
 *
 * Scoped through `appointments` to the Business inside the WHERE clause, the way
 * `lib/business/active-calls.ts` does it — Callzie is open signup, so a query
 * that read across accounts would put one account's billing state on another's
 * dashboard.
 */
export async function loadCallAlert(
  businessId: string,
): Promise<CallAlertKind | null> {
  const [latest] = await db
    .select({ disconnectReason: schema.calls.disconnectReason })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(eq(schema.appointments.businessId, businessId))
    .orderBy(desc(schema.calls.createdAt))
    .limit(1);

  if (!latest) return null;

  const kind = failureKind(latest.disconnectReason);

  return kind === "generic" ? null : kind;
}

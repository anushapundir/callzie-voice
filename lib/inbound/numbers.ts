import { and, eq } from "drizzle-orm";

import { parseE164 } from "@/lib/appointments/phone";
import { db, schema } from "@/lib/db";
import type { PhoneNumberPurpose } from "@/lib/db/schema";

/*
  The numbers a Business is reached on (issue #44).

  Two halves, deliberately apart:

  - **This file** owns the `phone_numbers` rows. It is pure database work, it
    needs no Retell credentials, and it is fully testable offline.
  - **`lib/inbound/provision.ts`** owns the Retell side — purchasing a number and
    releasing it — and every function there takes an injected client so no test
    ever contacts Retell (SPEC.md §3 rule 11).

  The split matters because the two fail differently. A row that exists with no
  number behind it is a Business whose phone silently never rings. A number that
  exists with no row is $2 a month billed forever with nothing pointing at it,
  and nobody notices. Keeping the reconciliation between them readable is the
  whole job, and it is why `attachNumber` records `retellNumberId` in the same
  statement that creates the row.
*/

export type AttachResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid_number" | "already_taken" | "not_enabled" };

/**
 * Records a number against a Business.
 *
 * **Refuses an account without `inbound_enabled`**, in the statement rather than
 * above it. A number attached to an account that is not answering is a number
 * being billed for nothing, and the flag is also where the emergency-number
 * requirement is already enforced (`lib/settings/inbound.ts`) — so gating here
 * means a number can never be pointed at a Business that would decline every
 * call it receives.
 *
 * `already_taken` is the unique constraint speaking, not a check. Two Businesses
 * sharing a number would leave the inbound webhook unable to say whose customer
 * is calling, and that has to be impossible rather than merely unlikely.
 */
export async function attachNumber({
  businessId,
  e164,
  retellNumberId,
  purpose = "inbound",
}: {
  businessId: string;
  e164: string;
  retellNumberId?: string;
  purpose?: PhoneNumberPurpose;
}): Promise<AttachResult> {
  const parsed = parseE164(e164);
  if (!parsed.ok) return { ok: false, reason: "invalid_number" };

  const business = await db.query.businesses.findFirst({
    where: and(
      eq(schema.businesses.id, businessId),
      eq(schema.businesses.inboundEnabled, true),
    ),
    columns: { id: true },
  });
  if (!business) return { ok: false, reason: "not_enabled" };

  try {
    const [row] = await db
      .insert(schema.phoneNumbers)
      .values({
        businessId,
        e164: parsed.value,
        retellNumberId: retellNumberId ?? null,
        purpose,
      })
      .returning({ id: schema.phoneNumbers.id });

    return { ok: true, id: row.id };
  } catch (error) {
    /*
      Only the unique index on `e164` is an "already taken". Anything else is a
      real failure and must not be reported as somebody else owning the number —
      that message would send whoever reads it looking for a conflict that is
      not there.
    */
    if (!isDuplicateNumber(error)) throw error;
    return { ok: false, reason: "already_taken" };
  }
}

/** Every number pointed at this Business. */
export async function listNumbers(businessId: string) {
  return db
    .select({
      id: schema.phoneNumbers.id,
      e164: schema.phoneNumbers.e164,
      retellNumberId: schema.phoneNumbers.retellNumberId,
      purpose: schema.phoneNumbers.purpose,
      createdAt: schema.phoneNumbers.createdAt,
    })
    .from(schema.phoneNumbers)
    .where(eq(schema.phoneNumbers.businessId, businessId));
}

/**
 * Forgets a number, and returns what Retell still needs told.
 *
 * Deleting the row and releasing the number at Retell are two operations and
 * cannot be one transaction — so this returns the `retellNumberId` rather than
 * calling Retell itself, and the caller releases it afterwards. The order is
 * deliberate and it is the safe one: the row goes first, so a failure to release
 * leaves a number nobody is routing to (visible, and costing $2) rather than a
 * Business routing to a number that no longer exists (invisible, and the phone
 * simply stops working).
 *
 * Scoped to the Business in the WHERE clause, so an id from another account
 * deletes nothing and returns null.
 */
export async function detachNumber(
  businessId: string,
  numberId: string,
): Promise<{ retellNumberId: string | null } | null> {
  const [row] = await db
    .delete(schema.phoneNumbers)
    .where(
      and(
        eq(schema.phoneNumbers.id, numberId),
        eq(schema.phoneNumbers.businessId, businessId),
      ),
    )
    .returning({ retellNumberId: schema.phoneNumbers.retellNumberId });

  return row ?? null;
}

/** Postgres `unique_violation` on `phone_numbers.e164`. */
function isDuplicateNumber(error: unknown): boolean {
  /*
    The `cause` chain has to be walked — Drizzle wraps the `pg` error rather
    than rethrowing it. Same trap `lib/tools/run.ts` and
    `lib/availability/slot-taken.ts` both document at length; three levels is
    plenty for one wrapper and a fixed limit means a cyclic `cause` cannot spin.
  */
  for (let current = error, depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, constraint } = current as { code?: string; constraint?: string };
    if (code === "23505" && constraint?.includes("phone_numbers")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

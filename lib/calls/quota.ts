import { and, eq, lt, or, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Claiming one Call against an account's Quota (SPEC.md §11.1, CONTEXT.md).

  The obvious shape — read calls_used, compare it to call_quota, then write — has
  exactly the defect a pre-check in front of bookSlot has. Two tabs both read
  "four used" and both write "five", and an account with five Calls places six.

  So the check and the increment are one statement. Postgres takes a row lock for
  the UPDATE, so contending statements serialise and there is no gap between the
  read and the write for a second Call to slip through. Same lesson as
  appointments_no_overlap (SPEC.md §3 rule 8), applied to a counter instead of a
  range — and, as there, the guarantee lives in the database rather than in
  application code. Do not add a "check first" branch in front of this; it cannot
  prevent the race it appears to prevent, and it makes this statement's WHERE
  clause look redundant to whoever reads it next.

  lib/calls/quota.test.ts fires ten concurrent claims at an account with five
  Calls and asserts exactly five win.
*/

/** `db`, or a transaction handle from `db.transaction`. */
export type Executor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type QuotaClaim =
  | { ok: true; callsUsed: number }
  | { ok: false; reason: "exhausted" };

/**
 * Takes one Call from the Quota, or refuses.
 *
 * Takes an executor rather than reaching for `db`, so the caller can put this in
 * the same transaction as the `calls` insert. A claimed Call with no row charges
 * someone for nothing; a row with no claim gives a Call away.
 *
 * An admin skips the bound but still increments. `calls_used` is the record of
 * what the account spent, and a counter frozen at zero while Calls go out is
 * simply wrong — even though the sidebar renders "Unlimited" rather than the
 * number for those accounts.
 */
export async function claimCallQuota(
  executor: Executor,
  businessId: string,
): Promise<QuotaClaim> {
  /*
    Drizzle's builder rather than a raw `sql` template, and not by preference:
    interpolating a column into a raw SET clause renders it qualified
    (`"businesses"."calls_used"`), which Postgres rejects — a SET target must be
    a bare column name. The builder emits the correct form.

    What matters is that the whole thing is still ONE statement. The `or` below
    is the bound, evaluated by Postgres under the row lock it takes for this
    UPDATE, not by a read this function did first.
  */
  const [row] = await executor
    .update(schema.businesses)
    .set({ callsUsed: sql`${schema.businesses.callsUsed} + 1` })
    .where(
      and(
        eq(schema.businesses.id, businessId),
        or(
          eq(schema.businesses.isAdmin, true),
          lt(schema.businesses.callsUsed, schema.businesses.callQuota),
        ),
      ),
    )
    .returning({ callsUsed: schema.businesses.callsUsed });

  /*
    No row means the WHERE clause refused it. Two different situations land
    here — the Quota is spent, and the Business does not exist — and both get
    the same answer on purpose: neither may place a Call, and a caller holding
    an id that resolves to nothing has no more business knowing which it was
    than it has placing the Call.
  */
  if (!row) return { ok: false, reason: "exhausted" };

  return { ok: true, callsUsed: row.callsUsed };
}

/**
 * Gives a Call back.
 *
 * The compensating half of `claimCallQuota`, for the one case that earns it:
 * `create-web-call` failed, so nothing was placed and nothing should be charged.
 * That failure is provable on the server, which is what separates it from a
 * browser claiming its Call did not connect — a claim nobody can check, and one
 * that would turn the five-Call cap into a suggestion.
 *
 * Floors at zero. A double release must not produce a negative count.
 */
export async function releaseCallQuota(
  executor: Executor,
  businessId: string,
): Promise<void> {
  await executor
    .update(schema.businesses)
    .set({
      callsUsed: sql`GREATEST(${schema.businesses.callsUsed} - 1, 0)`,
    })
    .where(eq(schema.businesses.id, businessId));
}

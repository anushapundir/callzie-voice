import { and, eq } from "drizzle-orm";

import { schema, type Queryable } from "@/lib/db";

/**
 * Every `slot_start` this Call has actually been offered.
 *
 * This is what turns "Only ever offer times check_availability returned"
 * (SPEC.md §7's prompt) from a request into a rule. `lib/retell/tools.ts`
 * declares `slot_start` an opaque token the model copies rather than composes,
 * and this is the other half of that promise: the endpoint checks the token came
 * from us. A prompt instruction is a suggestion — SPEC.md §3 rule 6.
 *
 * **Read back rather than cached.** The rows are already being written — issue
 * #10 requires every invocation to be recorded — so this costs one query on
 * `tool_invocations_call_id_idx`, an index that already exists. A cache would be
 * a second copy of the record, and a second copy can disagree with the first.
 *
 * Scoped to the Call, not to the last Offer. A time named in turn two stays
 * bookable in turn nine, because "actually, the first one you said" is a real
 * thing people say.
 */

/** One entry of `check_availability`'s response. */
export type OfferedSlot = {
  /** An ISO 8601 instant. The token `book_slot` echoes back. */
  slot_start: string;
  /** What Maya said out loud. Recorded so #16 can show it; never compared. */
  time: string;
};

export async function offeredSlotsInCall(
  /*
    `Queryable`, not `Tx`. A Tool handler must pass its own transaction — it is
    already holding one of the pool's five connections and reaching for a second
    deadlocks the path (see `Queryable` in lib/db/index.ts). But
    `lib/calls/record.ts` calls this after a Call has ended, outside any
    transaction, so the narrower type would force a second copy of this query.
  */
  tx: Queryable,
  callId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ result: schema.toolInvocations.result })
    .from(schema.toolInvocations)
    .where(
      and(
        eq(schema.toolInvocations.callId, callId),
        eq(schema.toolInvocations.toolName, "check_availability"),
        // A check that failed offered nothing, whatever is in its result.
        eq(schema.toolInvocations.succeeded, true),
      ),
    );

  const offered = new Set<string>();

  /*
    Defensive about the shape, deliberately. `result` is jsonb, so anything could
    be in a row written by an older version of this code — and the alternative to
    skipping an unrecognised row is throwing, mid-call, on data that is merely
    old.
  */
  for (const row of rows) {
    const slots = (row.result as { slots?: unknown } | null)?.slots;
    if (!Array.isArray(slots)) continue;

    for (const slot of slots) {
      const start = (slot as { slot_start?: unknown } | null)?.slot_start;
      if (typeof start === "string") offered.add(start);
    }
  }

  return offered;
}

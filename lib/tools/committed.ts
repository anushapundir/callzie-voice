import { and, eq, inArray } from "drizzle-orm";

import { schema, type Queryable } from "@/lib/db";

/**
 * Did any Tool write an outcome on this Call?
 *
 * `tool_invocations` is the authoritative record of what happened (SPEC.md §9
 * step 3), so this asks the record rather than inferring from
 * `appointments.status` — which says what the Appointment is now, not what this
 * particular Call decided.
 *
 * Used by `lib/calls/record.ts` to tell a negotiation that ran out of time from
 * one that reached an answer, and by #13's webhook for the same reason.
 */

/**
 * The three Tools that write.
 *
 * `check_availability` is deliberately absent. A successful check is a question
 * with an answer — the Call that asked it three times and then ran out of time
 * is exactly the Call SPEC.md §5 wants flagged.
 */
export const COMMITTING_TOOLS = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
] as const;

export async function hasCommittedOutcome(
  database: Queryable,
  callId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.toolInvocations.id })
    .from(schema.toolInvocations)
    .where(
      and(
        eq(schema.toolInvocations.callId, callId),
        // A failed book_slot is the case SPEC.md §8 covers, and it commits
        // nothing — book_slot writes `book_failed` itself when it gives up.
        eq(schema.toolInvocations.succeeded, true),
        inArray(schema.toolInvocations.toolName, [...COMMITTING_TOOLS]),
      ),
    )
    .limit(1);

  return row !== undefined;
}

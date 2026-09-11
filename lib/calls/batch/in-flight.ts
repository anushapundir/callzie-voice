import { and, count, eq, gt, inArray } from "drizzle-orm";

import { LIVE_CALL_STALENESS_MS } from "@/lib/business/active-calls";
import type { Executor } from "@/lib/calls/quota";
import { schema } from "@/lib/db";
import { CALL_TYPES, type CallStatus, type CallType } from "@/lib/db/schema";

/*
  How many Calls this Business has running (issue #17's throttle).

  Distinct from lib/business/active-calls.ts, which answers "is a conversation
  happening" for the pulsing dot and the row shimmer. This one also counts a
  Call that has been reserved and not yet connected, because a slot in the
  throttle is taken from the moment the row is written — otherwise three Calls
  ringing at once would count as zero and the pump would place three more.
*/

/** Statuses where the Call has not finished happening. */
const IN_FLIGHT: readonly CallStatus[] = ["queued", "ringing", "in_progress"];

/**
 * Counts the Calls in flight, at this moment.
 *
 * Takes an executor rather than reaching for `db`, because the pump calls this
 * from inside its transaction and a second connection there can deadlock the
 * pool (`lib/db/index.ts`).
 *
 * The recency condition is not decoration. A Call cannot outlive
 * `max_call_duration_ms` (SPEC.md §7), so a row older than that plus slack is a
 * delivery that never arrived rather than a Call. Deciding that at read time
 * means no background job to schedule and nothing that can itself fail and
 * leave a slot held forever. Note it does NOT correct the row: rewriting
 * history from a guess is how a Call's record stops being a record.
 */
export async function countInFlightCalls(
  executor: Executor,
  businessId: string,
  now: Date = new Date(),
  callTypes: readonly CallType[] = CALL_TYPES,
): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(schema.calls)
    /*
      Scoped by `calls.business_id` directly since issue #43. It used to join
      through `appointments` because `calls` carried no business_id; it does now,
      so the join is gone.

      `direction = 'outbound'` is not tidying — it preserves what this function
      means. This is Call All's throttle (issue #17), a pacing limit on Calls
      Callzie chooses to place. An account does not choose when its phone rings,
      so letting inbound Calls fill these three slots would let a busy afternoon
      stall a batch the owner started, for reasons nothing on screen explains.
    */
    .where(
      and(
        eq(schema.calls.businessId, businessId),
        eq(schema.calls.direction, "outbound"),
        inArray(schema.calls.status, [...IN_FLIGHT]),
        inArray(schema.calls.callType, [...callTypes]),
        gt(
          schema.calls.createdAt,
          new Date(now.getTime() - LIVE_CALL_STALENESS_MS),
        ),
      ),
    );

  return row.n;
}

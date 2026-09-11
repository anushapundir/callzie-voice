import { count, eq } from "drizzle-orm";

import { claimCallQuota, type Executor } from "@/lib/calls/quota";
import { schema } from "@/lib/db";
import type { CallType } from "@/lib/db/schema";

/*
  Everything about placing a Call that has to be atomic.

  Lifted out of lib/calls/start-web-call.ts when issue #17's batch pump needed
  the same three writes inside its own transaction. Two copies of this would
  drift, and the thing that drifts is the attempt number — which is what the
  Call detail screen renders as "2 of 2" and what the retry rule reads.

  Takes an executor rather than reaching for `db`, so the caller decides the
  transaction. The count MUST be inside it: two concurrent Calls for one
  Appointment would otherwise both come out as attempt 2.
*/

export type ReserveResult =
  | { ok: true; callId: string; attempt: number }
  | { ok: false; reason: "exhausted" };

export async function reserveCall(
  executor: Executor,
  {
    businessId,
    appointmentId,
    callType,
  }: { businessId: string; appointmentId: string; callType: CallType },
): Promise<ReserveResult> {
  const [{ existing }] = await executor
    .select({ existing: count() })
    .from(schema.calls)
    .where(eq(schema.calls.appointmentId, appointmentId));

  const claim = await claimCallQuota(executor, businessId);
  if (!claim.ok) return { ok: false, reason: "exhausted" };

  const attempt = existing + 1;

  const [call] = await executor
    .insert(schema.calls)
    /*
      `businessId` was already an argument before issue #43 — it was used to
      claim the Quota and then thrown away. Storing it makes every Call
      reachable from its Business without joining through `appointments`, which
      is what an inbound Call needs, since it has no Appointment to join
      through. `direction` defaults to 'outbound'; this function only ever
      places Calls, so it never sets it.
    */
    .values({ businessId, appointmentId, callType, attempt, status: "queued" })
    .returning({ id: schema.calls.id });

  return { ok: true, callId: call.id, attempt };
}

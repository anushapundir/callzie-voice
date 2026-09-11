import { and, eq, isNull, sql } from "drizzle-orm";

import { wasNegotiationTruncated } from "@/lib/calls/truncation";
import { db, schema } from "@/lib/db";
import { hasCommittedOutcome } from "@/lib/tools/committed";
import { offeredSlotsInCall } from "@/lib/tools/offers";

/*
  Writing down how a Call went.

  These three are called from `app/(app)/calls/actions.ts` with a `callId` the
  browser supplied, which makes the scoping the important part of the file:
  every statement is restricted to Calls belonging to the caller's Business
  inside its own WHERE clause, never by a read followed by a check. A `callId`
  from another account matches nothing and writes nothing.

  They live here rather than in the action so they can be tested without Clerk.
  The action is then a thin wrapper — `requireBusiness()`, delegate, revalidate.

  **Nothing here returns a Call to the Quota.** A Call that connected has been
  spent, and these are all reports from a browser, which cannot be checked. The
  one refundable failure is `create-web-call` itself failing, which
  `lib/calls/start-call.ts` handles on the server where it is provable.

  All three are idempotent in the way that matters: re-running one writes the
  same row to the same state. The SDK is free to emit an event twice.

  `recordCallEnded` also writes SPEC.md §5's `negotiation_truncated`. That is
  the one judgement in this file rather than a plain report, and it is made by a
  pure function in lib/calls/truncation.ts so #13's webhook can make the same one
  from better information.
*/

/** The Call has connected — the dot pulses and the row shimmers from here. */
export async function recordCallStarted(
  businessId: string,
  callId: string,
): Promise<void> {
  await db
    .update(schema.calls)
    .set({ status: "in_progress", startedAt: new Date() })
    .where(and(eq(schema.calls.id, callId), ownedBy(businessId)));
}

/** The Call ended normally. */
export async function recordCallEnded(
  businessId: string,
  callId: string,
): Promise<void> {
  /*
    The duration is computed here, from `started_at`, rather than taken from the
    browser. There is no reason to accept a number we already hold.

    `COALESCE` because `started_at` can be null — a Call that ended without ever
    reporting a start — and `GREATEST(..., 0)` because a negative duration would
    be worse than a zero.
  */
  const [call] = await db
    .update(schema.calls)
    .set({
      status: "completed",
      endedAt: new Date(),
      durationSeconds: sql`GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(${schema.calls.startedAt}, now())))::int, 0)`,
    })
    .where(and(eq(schema.calls.id, callId), ownedBy(businessId)))
    .returning({
      id: schema.calls.id,
      appointmentId: schema.calls.appointmentId,
      // Read back rather than recomputed here: the number the row holds is the
      // number the truncation rule has to judge.
      durationSeconds: schema.calls.durationSeconds,
    });

  if (!call) return;

  /*
    The status write above applies to every Call. Everything below is about an
    Appointment, which an inbound Call does not have (issue #43) — there is
    nothing to release, and `negotiation_truncated` is a statement about a
    Reschedule that ran out of time, not about a stranger who hung up.

    An inbound Call that ended without doing anything is not a failure needing a
    human; it is somebody who rang off. What it *did* do, if anything, is on its
    Enquiry.
  */
  if (call.appointmentId === null) return;

  await releaseAppointment(call.appointmentId);

  /*
    SPEC.md §5's fourth Needs Attention reason. The Web Call path knows the Call
    ended but not why, so the rule falls back to the duration — see
    lib/calls/truncation.ts. #13 passes Retell's own `disconnection_reason` into
    the same function and replaces the inference with a fact.
  */
  const committed = await hasCommittedOutcome(db, call.id);
  /*
    Skipped once an outcome exists — the rule ignores `offersMade` in that case
    anyway, and this runs on every completed Call.
  */
  const offersMade = committed
    ? false
    : (await offeredSlotsInCall(db, call.id)).size > 0;

  if (
    wasNegotiationTruncated({
      durationSeconds: call.durationSeconds,
      committed,
      offersMade,
    })
  ) {
    await flagTruncated(call.appointmentId);
  }
}

/**
 * The Call broke.
 *
 * `disconnectReason` carries Retell's own strings — `error_user_not_joined` for
 * an expired access token (docs/verification.md A3, A9) — rather than any we
 * invent, so #13's webhook writing the same row later agrees with this rather
 * than contradicting it.
 */
export async function recordCallFailed(
  businessId: string,
  callId: string,
  disconnectReason: string,
): Promise<void> {
  const [call] = await db
    .update(schema.calls)
    .set({ status: "failed", endedAt: new Date(), disconnectReason })
    .where(and(eq(schema.calls.id, callId), ownedBy(businessId)))
    .returning({ appointmentId: schema.calls.appointmentId });

  // Nothing to release on an inbound Call — it holds no Appointment.
  if (call?.appointmentId) await releaseAppointment(call.appointmentId);
}

/**
 * Asks a human to look at an Appointment whose Call ran out of time.
 *
 * **Only when nothing is flagged already.** `book_slot` may have written
 * `book_failed` moments earlier, and that is the more specific reason: a Call
 * that tried and failed to book is not the same as one that never got there.
 * A conditional UPDATE rather than a read followed by a write, for the reason
 * SPEC.md §3 rule 8 gives.
 *
 * The Appointment keeps its Slot. SPEC.md §14 rule 2 — a Slot is never freed on
 * a weak signal, and a conversation that did not finish is the weakest there is.
 */
async function flagTruncated(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "negotiation_truncated" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        isNull(schema.appointments.needsAttentionReason),
      ),
    );
}

/** The cross-tenant guard: this Call hangs off an Appointment of this Business. */
function ownedBy(businessId: string) {
  return sql`${schema.calls.appointmentId} IN (
    SELECT ${schema.appointments.id} FROM ${schema.appointments}
     WHERE ${schema.appointments.businessId} = ${businessId}
  )`;
}

/**
 * Returns the Appointment to `pending` once its Call is over.
 *
 * **Only if it is still `calling`.** When nothing decided this Appointment's
 * outcome, `pending` is where it genuinely is. Leaving it at `calling` would
 * show a permanently-calling row; writing `confirmed` would be the small version
 * of SPEC.md §3 rule 7.
 *
 * The condition is not decoration. A Tool may write `confirmed` or
 * `rescheduled` mid-Call, and this must not overwrite it. The Tool wins
 * (SPEC.md §9 step 3).
 *
 * Exported because `lib/webhooks/process.ts` needs the same guard when Retell
 * reports the ending. Two copies of this rule would be two places for it to
 * drift, and the drift is invisible until an Appointment someone rebooked
 * quietly reverts to pending.
 */
export async function releaseAppointment(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "calling"),
      ),
    );
}

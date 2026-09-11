import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { syncAppointmentToGoogle } from "@/lib/google/sync";
import type {
  AppointmentStatus,
  NeedsAttentionReason,
  ToolName,
} from "@/lib/db/schema";
import type { ExtractionResult } from "@/lib/extraction/parse";

/*
  The only file in this ticket that may write to `appointments`.

  SPEC.md §9 step 3 in one sentence: a committed Tool outcome always wins. The
  fallback fields exist for one case — a Call where the Agent invoked nothing at
  all — and must never overwrite what a Tool already wrote.

  Three gates enforce that, and any one of them stops the write. They are
  deliberately redundant: the second is the rule, and the third is the same rule
  asked of the Appointment itself, so a bug in reading `tool_invocations` still
  cannot move an Appointment somebody decided.
*/

/**
 * The Tools that write an outcome.
 *
 * `check_availability` is absent on purpose. It is a read — a Call where Maya
 * only ever checked times is a Call where no Tool committed, and the fallback is
 * exactly what that Call needs.
 */
const COMMITTING_TOOLS: readonly ToolName[] = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
];

export type ExtractionOutcomeInput = {
  callId: string;
  appointmentId: string;
  /** Retell's own signal, never the model's guess (SPEC.md §9 step 4). */
  inVoicemail: boolean | null;
  result: ExtractionResult;
};

export async function applyExtractionOutcome({
  callId,
  appointmentId,
  inVoicemail,
  result,
}: ExtractionOutcomeInput): Promise<void> {
  // Gate 1. A voicemail has a transcript worth summarising and nobody in it who
  // could have agreed to anything.
  if (inVoicemail === true) return;

  // Gate 2. The rule.
  if (await aToolCommitted(callId)) return;

  const change = fallbackChange(result);
  if (!change) return;

  /*
    Gate 3, and note where it lives: inside the WHERE clause, not in a read
    followed by an `if`. Same shape as `releaseAppointment` in
    lib/calls/record.ts, and for the same reason — two workers handling a
    redelivered event cannot both win a check they each made before writing.

    `pending` is where an Appointment nobody decided sits by the time
    `call_analyzed` lands, because `call_ended` already ran releaseAppointment.
    One a Tool decided is `confirmed`, `rescheduled` or `cancelled`, and matches
    nothing here.
  */
  const written = await db
    .update(schema.appointments)
    .set(change)
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "pending"),
      ),
    )
    .returning({ status: schema.appointments.status });

  /*
    ADR-0004's one-way push. A `declined` Appointment frees its Slot, so its
    Google event has to go — leaving it would hold time on the owner's calendar
    for somebody who has said they are not coming.

    Only when the UPDATE actually matched. The guard above is in the WHERE, so a
    redelivered event that changed nothing must not go on to tell Google
    something happened.

    Called directly rather than wrapped in `after()`: this already runs inside
    the Retell webhook's `after()` block, and deferring work that is already
    deferred would only add a second place for it to be dropped.
  */
  if (written.length > 0 && change.status === "declined") {
    await syncAppointmentToGoogle(appointmentId);
  }
}

/** Did a Tool write an outcome on this Call? */
async function aToolCommitted(callId: string): Promise<boolean> {
  const committed = await db.query.toolInvocations.findFirst({
    where: and(
      eq(schema.toolInvocations.callId, callId),
      eq(schema.toolInvocations.succeeded, true),
      inArray(schema.toolInvocations.toolName, [...COMMITTING_TOOLS]),
    ),
    columns: { id: true },
  });

  return committed !== undefined;
}

/**
 * What the fallback fields mean for the Appointment, or null for "nothing".
 *
 * `new_time` outranks `confirmed`: a person who named a new time did not agree
 * to the old one, whatever else came back in the same object. It sets a Needs
 * Attention reason rather than a status, so the Appointment keeps its Slot and a
 * human does the Reschedule — an LLM parsing a spoken time into a booking would
 * route around the exclusion constraint, the offer-replay check in
 * lib/tools/book-slot.ts, and Google Calendar in one step.
 */
function fallbackChange(result: ExtractionResult): {
  status?: Extract<AppointmentStatus, "confirmed" | "declined">;
  needsAttentionReason?: NeedsAttentionReason;
} | null {
  if (result.newTime !== null) {
    /*
      SPEC.md §5 words this reason as the call-duration cap. We use it for the wider
      case it describes — no Tool committed during a negotiation — because the
      failure, the fix and the UI surface are all the same. Recorded as decision
      4 in docs/superpowers/specs/2026-08-21-extraction-pipeline-design.md so it
      reads as a choice rather than a drift.
    */
    return { needsAttentionReason: "negotiation_truncated" };
  }

  if (result.confirmed === true) return { status: "confirmed" };
  if (result.confirmed === false) return { status: "declined" };

  return null;
}

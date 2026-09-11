import { and, eq, inArray, sql } from "drizzle-orm";

import { pumpBatch } from "@/lib/calls/batch/pump";
import { markUnreachable, requeueForRetry } from "@/lib/calls/batch/queue";
import { afterCall } from "@/lib/calls/batch/retry";
import { releaseAppointment } from "@/lib/calls/record";
import { db, schema } from "@/lib/db";
import { anthropicExtractor, type ExtractionLlm } from "@/lib/extraction/llm";
import { extractCall } from "@/lib/extraction/run";
import type { WebhookEvent } from "@/lib/webhooks/payload";
import { mapDisconnectionReason } from "@/lib/webhooks/status";

/*
  Applying a delivery to the Call row.

  This is the point of the whole ticket. Until it existed, the browser was the
  only thing that reported how a Call went — app/(app)/calls/actions.ts writes
  `in_progress` and `completed` from the page, and says in its own comment that
  the webhook overwrites all of it. A closed tab reported nothing at all, which
  is why lib/business/active-calls.ts has to treat a stale `in_progress` row as
  not-live rather than trusting the column.

  So: **Retell wins.** Including when it disagrees with the browser — a tab that
  closed cleanly reports a completed Call even when nobody ever joined it, and
  Retell is the one that was actually there.

  What Retell does not win is the Appointment's outcome. A Tool that committed
  mid-call has already written it, and this runs afterwards (SPEC.md §9 step 3).
  Extraction hangs off `call_analyzed` and is bound by the same rule — see
  lib/extraction/outcome.ts, which is the only thing on this path allowed to
  write to `appointments`.

  **Everything here writes a fixed value.** Nothing increments, appends or
  counts. That is what makes `store.ts` safe to hand the same event to two
  workers at once, which it will when Retell redelivers an event that is still
  being processed.
*/

/**
 * Statuses a `call_started` may move.
 *
 * A retried `call_started` can arrive after the Call has ended. Re-opening a
 * finished Call would leave the topbar's live indicator pulsing and the row
 * shimmering for the life of the account.
 */
const NOT_YET_FINISHED = ["queued", "ringing", "in_progress"] as const;

export async function processWebhookEvent(
  event: WebhookEvent,
  /**
   * The extraction model, injected.
   *
   * Defaulted lazily inside `applyAnalyzed` rather than here, because building
   * the real one reads `ANTHROPIC_API_KEY` and throws without it — a
   * `call_started` on a deployment that never configured extraction must still
   * be processed. Tests pass a fake, which is also what stops this file's own
   * suite from making paid API calls.
   */
  extractor?: ExtractionLlm,
): Promise<void> {
  const callId = await findCall(event);
  if (!callId) {
    /*
      Nothing to write, and nothing Retell could fix by retrying — so the route
      still answers 200. The raw row stays in `webhook_events` unprocessed, which
      is what makes it recoverable: a redelivery, or a replay, picks it up if the
      Call turns up later.
    */
    console.warn(
      `[webhook] ${event.event} for unknown call ${event.retellCallId}`,
    );
    return;
  }

  switch (event.event) {
    case "call_started":
      return applyStarted(callId, event);
    case "call_ended":
      return applyEnded(callId, event);
    case "call_analyzed":
      return applyAnalyzed(callId, event, extractor);
    default:
      // We subscribe to three events (scripts/create-agent.ts:59), but an
      // account-level webhook can deliver others. Stored, not acted on.
      return;
  }
}

/** The Call has connected. */
async function applyStarted(callId: string, event: WebhookEvent) {
  await db
    .update(schema.calls)
    .set({
      status: "in_progress",
      startedAt: event.startedAt ?? new Date(),
    })
    .where(
      and(
        eq(schema.calls.id, callId),
        inArray(schema.calls.status, [...NOT_YET_FINISHED]),
      ),
    );
}

/**
 * The Call is over, and this is the delivery that says how it went.
 *
 * `transcript` and `recording_url` are written only when this delivery carries
 * them, so a `call_ended` that arrives without a transcript cannot blank one
 * that is already there.
 *
 * Then the aftermath (issue #17): a silence earns one retry, a second silence
 * earns a human. Both writes are conditional UPDATEs of fixed values, so a
 * redelivered `call_ended` changes nothing the second time.
 */
async function applyEnded(callId: string, event: WebhookEvent) {
  const status = mapDisconnectionReason(event.disconnectionReason);

  const [row] = await db
    .update(schema.calls)
    .set({
      status,
      disconnectReason: event.disconnectionReason,
      endedAt: event.endedAt ?? new Date(),
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      ...(event.durationSeconds !== null
        ? { durationSeconds: event.durationSeconds }
        : {}),
      ...(event.transcript ? { transcript: event.transcript } : {}),
      ...(event.recordingUrl ? { recordingUrl: event.recordingUrl } : {}),
    })
    .where(eq(schema.calls.id, callId))
    .returning({
      appointmentId: schema.calls.appointmentId,
      attempt: schema.calls.attempt,
    });

  if (!row) return;

  /*
    Everything below this line is about an Appointment, and an inbound Call has
    none (issue #43). The status write above already happened and is all an
    inbound Call needs from this handler.

    Each of the four steps would be wrong rather than merely unnecessary:
    there is no Appointment to release, a retry would mean Callzie ringing back
    a stranger who rang it, `unreachable` describes a phone nobody answered
    rather than one that called in, and the pump paces a batch this Call was
    never part of.
  */
  if (row.appointmentId === null) return;

  // Returns the Appointment to `pending` if nothing decided its outcome, which
  // is the status the two writes below key on.
  await releaseAppointment(row.appointmentId);

  switch (afterCall({ status, attempt: row.attempt })) {
    case "retry":
      await requeueForRetry(row.appointmentId);
      break;
    case "unreachable":
      await markUnreachable(row.appointmentId);
      break;
  }

  await pumpAfter(row.appointmentId);
}

/**
 * Fills the slot this Call just freed.
 *
 * The whole batch runs on this: there is no background worker, because Cloud
 * Run withdraws CPU once a response is sent, so every Call after the first
 * three is placed by the delivery that ended an earlier one (ADR-0013).
 *
 * Wrapped, for the same reason Extraction is: a pump that throws must not undo
 * the Call row this handler has already written.
 */
async function pumpAfter(appointmentId: string): Promise<void> {
  try {
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointmentId),
      columns: { businessId: true },
    });
    if (!appointment) return;

    await pumpBatch({ businessId: appointment.businessId });
  } catch (error) {
    console.error(`[batch] pump after ${appointmentId} failed:`, error);
  }
}

/**
 * The analysis has finished.
 *
 * Two jobs. Fill-if-null on the Call row, never overwriting and never touching
 * the status: A9 records `recording_url` timing as unverified — neither Retell
 * page says whether it rides on `call_ended` or only on `call_analyzed` — so
 * take whichever event carries it first and let the other be a no-op.
 *
 * Then Extraction (SPEC.md §9), which is what makes this the event that matters.
 */
async function applyAnalyzed(
  callId: string,
  event: WebhookEvent,
  extractor?: ExtractionLlm,
) {
  if (event.transcript || event.recordingUrl || event.transcriptTurns) {
    await db
      .update(schema.calls)
      .set({
        ...(event.transcript
          ? {
              transcript: sql`coalesce(${schema.calls.transcript}, ${event.transcript})`,
            }
          : {}),
        ...(event.recordingUrl
          ? {
              recordingUrl: sql`coalesce(${schema.calls.recordingUrl}, ${event.recordingUrl})`,
            }
          : {}),
        /*
          Same fill-if-null rule as the two above, and note the explicit
          `::jsonb`. Drizzle binds the stringified array as `text`, and
          `coalesce(jsonb, text)` is a type error in Postgres — the cast is what
          makes both arms the same type.
        */
        ...(event.transcriptTurns
          ? {
              transcriptTurns: sql`coalesce(${schema.calls.transcriptTurns}, ${JSON.stringify(event.transcriptTurns)}::jsonb)`,
            }
          : {}),
      })
      .where(eq(schema.calls.id, callId));
  }

  /*
    Extraction runs after that write, and outside its condition: this delivery
    may carry no transcript at all while the row already holds one from
    `call_ended`.

    Wrapped, and the wrap is the rule rather than caution. SPEC.md §3 rule 5 says
    Extraction must never crash the pipeline — a timeout, a 429, or a missing
    ANTHROPIC_API_KEY on a deployment that never configured one must not undo the
    Call row this handler has already written. `anthropicExtractor()` is built
    inside the try for exactly that reason: it throws when the key is absent.
  */
  try {
    await extractCall({
      callId,
      inVoicemail: event.inVoicemail,
      llm: extractor ?? anthropicExtractor(),
    });
  } catch (error) {
    console.error(`[extraction] ${callId} failed:`, error);
  }
}

/**
 * Which `calls` row this delivery is about, as a `calls.id`.
 *
 * By Retell's id first. The fallback exists because
 * `lib/calls/start-web-call.ts` writes `retell_call_id` in a second statement
 * after Retell returns, so a fast `call_started` can beat it — and that file
 * echoes the Callzie id into `metadata.call_id` for exactly this.
 */
async function findCall(event: WebhookEvent): Promise<string | null> {
  const byRetellId = await db.query.calls.findFirst({
    where: eq(schema.calls.retellCallId, event.retellCallId),
    columns: { id: true },
  });
  if (byRetellId) return byRetellId.id;

  if (!event.callzieCallId) return null;

  /*
    Wrapped, because `calls.id` is a uuid column and the metadata is a string
    Retell handed back — a value that is not a uuid makes Postgres raise rather
    than return no rows, and a malformed id is "no such Call", not a crash.
  */
  try {
    const byMetadata = await db.query.calls.findFirst({
      where: eq(schema.calls.id, event.callzieCallId),
      columns: { id: true },
    });
    return byMetadata?.id ?? null;
  } catch {
    return null;
  }
}

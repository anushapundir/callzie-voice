import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { WebhookEvent } from "@/lib/webhooks/payload";

/*
  The idempotency gate, and the only place `webhook_events` is written.

  SPEC.md §3 rule 2: the handler must be idempotent, deduped on
  `(retell_call_id, event_type)`. That pair is a unique constraint in the
  database (`webhook_events_call_event_uniq`, lib/db/schema.ts:276), so this
  leans on the constraint rather than reading first and writing after — three
  deliveries arriving together would find any gap between the two.

  Rule 3 in the same list: persist the raw event first, process after. That
  ordering is why this file knows nothing about Calls. It writes down what
  arrived and says whether it is worth acting on; `process.ts` does the acting.
*/

/** Whether this delivery has work left in it. */
export type Decision = "process" | "already_done";

/**
 * Write the delivery down, and say what to do with it.
 *
 * Three outcomes, and they collapse into one question — is this row closed?
 *
 *   - Brand new row      -> not closed -> `process`
 *   - Seen, not finished -> not closed -> `process` **again**
 *   - Seen and finished  -> closed     -> `already_done`
 *
 * The middle one is the case issue #13 names. Retell waits 10 seconds and
 * retries up to three times, so a first attempt that is merely slow gets
 * redelivered while it is still working. Treating "a row exists" as "already
 * handled" would drop that event on the floor, and Retell sends no fourth copy
 * after a 200.
 */
export async function recordEvent(
  event: WebhookEvent,
  payload: unknown,
): Promise<{ id: string; decision: Decision }> {
  /*
    One statement, and `DO UPDATE` rather than `DO NOTHING` so that it always
    returns a row. `DO NOTHING` returns nothing on a conflict, which would mean a
    second query to find the row we just collided with — and a window between the
    two where another delivery could still be mid-write.

    Overwriting the payload is deliberate, not a trick to make RETURNING fire. A
    redelivered `call_ended` can carry more than the first one did:
    docs/verification.md A9 records `recording_url` timing as unverified, so the
    retry may be the copy that has it. Keeping the newest body keeps the fullest
    evidence.

    `processed` is untouched, which is what lets the returned value answer the
    question above.

    Note the dedupe key is only sound because the parser guarantees a non-empty
    `retell_call_id`. Postgres treats NULLs as distinct in a unique constraint,
    so a null id would collide with nothing and every delivery would look new.
  */
  const [row] = await db
    .insert(schema.webhookEvents)
    .values({
      retellCallId: event.retellCallId,
      eventType: event.event,
      payload,
    })
    .onConflictDoUpdate({
      target: [schema.webhookEvents.retellCallId, schema.webhookEvents.eventType],
      set: { payload: sql`excluded.payload` },
    })
    .returning({
      id: schema.webhookEvents.id,
      processed: schema.webhookEvents.processed,
    });

  return { id: row.id, decision: row.processed ? "already_done" : "process" };
}

/**
 * Close the row.
 *
 * **After the work, never before.** A crash halfway through leaves the row open,
 * so the next delivery redoes it rather than finding it closed over work that
 * never happened. The cost of that choice is that two deliveries can process the
 * same event at once — which is safe only because every write in `process.ts` is
 * an update to a fixed value. Nothing there increments, appends or counts.
 */
export async function markProcessed(id: string): Promise<void> {
  await db
    .update(schema.webhookEvents)
    .set({ processed: true })
    .where(eq(schema.webhookEvents.id, id));
}

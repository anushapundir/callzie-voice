import { db, schema, type Transaction } from "@/lib/db";
import type { ToolName } from "@/lib/db/schema";
import type { ToolContext } from "@/lib/tools/request";
import { COMMITTED, sayForError } from "@/lib/tools/say";

/**
 * Every Tool call runs inside one transaction that also writes its own
 * `tool_invocations` row.
 *
 * That single sentence is the mechanism the whole ticket rests on. Follow a
 * second `book_slot` in the same Call:
 *
 *   1. Transaction opens.
 *   2. The Appointment is moved to the new Slot.
 *   3. The record row is inserted — and `tool_invocations_one_booking_per_call`
 *      refuses it, because this Call already committed a Reschedule.
 *   4. The whole transaction rolls back. **Step 2 is undone with step 3.**
 *
 * So "one Reschedule commits per Call, however many Offers preceded it"
 * (CONTEXT.md) is enforced by Postgres, and there is no ordering of the two
 * writes that could leave them disagreeing.
 *
 * The same wrapper serves all four Tools. For the other three the transaction is
 * doing nothing clever, and that is fine — one shape for all four is worth more
 * than saving a BEGIN on three of them.
 *
 * `tool_invocations` is the authoritative record of what happened (SPEC.md §9
 * step 3): Extraction never overwrites it. A booking that happened without a
 * record is worse than one that failed, because the Call detail screen (#16)
 * would show a Call in which Maya apparently did nothing.
 */

/**
 * Drizzle's transaction handle. Re-exported from `lib/db` under the short name
 * the handlers use, so a handler needs one import rather than two.
 *
 * **Every read a handler makes must go through this**, not through `db`. The
 * pool holds five connections and this transaction is already holding one;
 * reaching for a second is what deadlocks the whole path under concurrency. The
 * long version is on `Queryable` in `lib/db/index.ts`.
 */
export type Tx = Transaction;

/** What a handler hands back: the JSON Maya reads, and whether it worked. */
export type ToolOutcome = {
  /** Written to `tool_invocations.succeeded`, and what the one-booking index keys on. */
  succeeded: boolean;
  /** The response body, verbatim. */
  result: unknown;
};

/**
 * All this wrapper needs from a context: which `calls` row to record against.
 *
 * Everything else — the Appointment, the Service, the caller's number — belongs
 * to whichever handler is running, and this file has no business knowing which
 * kind it has. That is what lets one `runTool` serve both the outbound Tools
 * (which resolve an Appointment) and the inbound ones (which resolve a
 * Business), with no branch anywhere below.
 */
export type AnyToolContext = { callId: string };

export type ToolHandlerInput<C extends AnyToolContext = ToolContext> = {
  tx: Tx;
  context: C;
  args: Record<string, unknown>;
  /** Injected rather than read, so callers and tests can pin the clock. */
  now: Date;
};

export type ToolHandler<C extends AnyToolContext = ToolContext> = (
  input: ToolHandlerInput<C>,
) => Promise<ToolOutcome>;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";
/*
  The two partial unique indexes that cap bookings per Call.

  `one_booking_per_call` caps Reschedules on an outbound Call (0003);
  `one_new_booking_per_call` caps how many Slots a stranger can take on a single
  inbound Call (0006). Different rules, different tables of consequences — but to
  the person on the phone both mean the same thing, so both produce the same
  sentence below.
*/
const ONE_BOOKING_INDEXES = [
  "tool_invocations_one_booking_per_call",
  "tool_invocations_one_new_booking_per_call",
];

export type RunToolInput<C extends AnyToolContext = ToolContext> = {
  name: ToolName;
  args: Record<string, unknown>;
  context: C;
  handler: ToolHandler<C>;
  now?: Date;
};

export async function runTool<C extends AnyToolContext = ToolContext>({
  name,
  args,
  context,
  handler,
  now = new Date(),
}: RunToolInput<C>): Promise<unknown> {
  const startedAt = performance.now();

  try {
    return await db.transaction(async (tx) => {
      const outcome = await handler({ tx, context, args, now });

      await tx.insert(schema.toolInvocations).values({
        callId: context.callId,
        toolName: name,
        arguments: args,
        result: outcome.result,
        succeeded: outcome.succeeded,
        latencyMs: elapsedMs(startedAt),
      });

      return outcome.result;
    });
  } catch (error) {
    /*
      This is the only code that inserts into `tool_invocations`, so it is the
      only code positioned to recognise that table's constraints. Knowing about
      book_slot here is a small impurity paid for by that.

      Both branches carry the words as well as the reason. A 500 tells Maya
      nothing; a body that says ok:false and hands her a sentence tells her what
      to do next (SPEC.md §3 rule 7).
    */
    const result = isSecondBooking(error)
      ? { ok: false, reason: "already_booked", say: COMMITTED.alreadyBooked }
      : { ok: false, reason: "error", say: sayForError(name) };

    await recordFailure({ name, args, context, result, startedAt });
    return result;
  }
}

/**
 * Write the record of a failure on a fresh connection.
 *
 * Outside the rolled-back transaction, deliberately: writing it inside would
 * roll the record back along with the failure it describes, and the Call would
 * look like one where Maya never invoked anything.
 *
 * `succeeded: false` also keeps this row clear of the one-booking index, which
 * is what lets SPEC.md §8's retry — and any number of lost races — be recorded.
 */
async function recordFailure({
  name,
  args,
  context,
  result,
  startedAt,
}: {
  name: ToolName;
  args: Record<string, unknown>;
  context: AnyToolContext;
  result: unknown;
  startedAt: number;
}): Promise<void> {
  try {
    await db.insert(schema.toolInvocations).values({
      callId: context.callId,
      toolName: name,
      arguments: args,
      result,
      succeeded: false,
      latencyMs: elapsedMs(startedAt),
    });
  } catch (error) {
    // A failure to record a failure must not become the response. Maya is mid
    // sentence; she needs a body to read, not a 500 (SPEC.md §3 rule 7).
    console.error(
      `Could not record a failed ${name} for call ${context.callId}`,
      error,
    );
  }
}

/** Whether this error is the one-booking index refusing a second Reschedule. */
function isSecondBooking(error: unknown): boolean {
  /*
    The `cause` chain has to be walked. Drizzle does not hand back the error `pg`
    raised: it wraps it in a DrizzleQueryError carrying the SQL and the
    parameters, and puts the original on `cause` — the same trap
    lib/availability/slot-taken.ts documents at length. Three levels is plenty
    for one wrapper, and a fixed limit means a cyclic `cause` cannot spin here.
  */
  for (let current = error, depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, constraint } = current as { code?: string; constraint?: string };
    // Both, not just the code: a future unique index elsewhere must not read as
    // "you already booked on this Call".
    if (
      code === UNIQUE_VIOLATION &&
      constraint !== undefined &&
      ONE_BOOKING_INDEXES.includes(constraint)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/*
  Whole milliseconds. `performance.now()` returns fractions and `latency_ms` is
  an integer column, so an unrounded value would be truncated by pg rather than
  rejected — a silently wrong number rather than a loud one.
*/
function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

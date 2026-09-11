import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { ExtractionLlm } from "@/lib/extraction/llm";
import { applyExtractionOutcome } from "@/lib/extraction/outcome";
import { parseExtraction, type ExtractionResult } from "@/lib/extraction/parse";
import { extractionPrompt, STRICTER_NUDGE } from "@/lib/extraction/prompt";
import { formatForSpeech } from "@/lib/time/zone";

/*
  One pass over a finished transcript (SPEC.md §9).

  This file only ever writes to `extractions`. The Appointment is outcome.ts's
  business, and it is reached from exactly one line below — the one guarded by
  whether the insert actually happened.

  Nothing here throws for an ordinary reason. A Call with no transcript, a Call
  that has already been extracted, a Call that does not exist: all of them return
  "skipped". The caller in lib/webhooks/process.ts still wraps it, because a
  timeout or a 429 from Anthropic is not an ordinary reason and must not break
  the Call row that has already been written (SPEC.md §3 rule 5).
*/

export type ExtractOutcome = "ok" | "failed" | "skipped";

export type ExtractCallInput = {
  callId: string;
  /** Retell's `call_analysis.in_voicemail`. Null on events that do not carry it. */
  inVoicemail: boolean | null;
  llm: ExtractionLlm;
};

export async function extractCall({
  callId,
  inVoicemail,
  llm,
}: ExtractCallInput): Promise<ExtractOutcome> {
  const context = await loadContext(callId);
  if (!context) return "skipped";

  /*
    The cheap half of the idempotency story. The expensive half is the unique
    constraint on `extractions.call_id`, which is what actually holds when two
    workers get the same redelivered event at once — see the insert below.
  */
  const already = await db.query.extractions.findFirst({
    where: eq(schema.extractions.callId, callId),
    columns: { id: true },
  });
  if (already) return "skipped";

  const prompt = extractionPrompt({
    transcript: context.transcript,
    personName: context.personName,
    appointmentSpokenTime: formatForSpeech(context.startsAt, context.timezone),
  });

  const { result, raw } = await ask(llm, prompt);

  if (!result) {
    /*
      Second failure. Store the raw output and stop — SPEC.md §9 step 5. Note
      what is NOT here: any call to applyExtractionOutcome. A failed extraction
      never changes an Appointment's status.
    */
    await db
      .insert(schema.extractions)
      .values({ callId, inVoicemail, status: "failed", rawLlmOutput: raw })
      .onConflictDoNothing();

    console.error(`[extraction] ${callId}: unreadable after one retry`);
    return "failed";
  }

  const [inserted] = await db
    .insert(schema.extractions)
    .values({
      callId,
      notes: result.notes,
      summary: result.summary,
      sentiment: result.sentiment,
      // Retell's own signal, never the model's guess (SPEC.md §9 step 4).
      inVoicemail,
      confirmed: result.confirmed,
      newTime: result.newTime,
      status: "ok",
    })
    .onConflictDoNothing()
    .returning({ id: schema.extractions.id });

  /*
    No row came back, so the unique constraint refused it: another worker
    extracted this Call while we were talking to Anthropic, and has already
    applied the outcome. Applying it a second time would be harmless today —
    every write is a fixed value — but "harmless because of how the writes happen
    to be shaped" is not a guarantee worth resting on.
  */
  if (!inserted) return "skipped";

  await applyExtractionOutcome({
    callId,
    appointmentId: context.appointmentId,
    inVoicemail,
    result,
  });

  return "ok";
}

/**
 * Ask once; if the answer cannot be read, ask again more firmly.
 *
 * Exactly one retry, which is what SPEC.md §9 step 5 allows. `raw` is always the
 * last thing the model said, so a stored failure shows what it was actually
 * doing rather than what it did on the first attempt.
 */
async function ask(
  llm: ExtractionLlm,
  prompt: string,
): Promise<{ result: ExtractionResult | null; raw: string }> {
  const first = await llm(prompt);
  const parsed = readable(first);
  if (parsed) return { result: parsed, raw: first.raw };

  const second = await llm(`${prompt}\n${STRICTER_NUDGE}`);
  return { result: readable(second), raw: second.raw };
}

/**
 * The stop reason is checked before the text is.
 *
 * `max_tokens` truncates mid-object and `refusal` returns something that will
 * not match the schema (docs/verification.md A11). Both would otherwise surface
 * as a parse error one layer too late — and a truncated object that happened to
 * close its braces would surface as a wrong answer rather than an error at all.
 */
function readable(response: {
  raw: string;
  stopReason: string | null;
}): ExtractionResult | null {
  if (response.stopReason !== "end_turn") return null;
  return parseExtraction(response.raw);
}

type ExtractionContext = {
  transcript: string;
  personName: string;
  startsAt: Date;
  timezone: string;
  appointmentId: string;
};

/**
 * Everything the prompt and the outcome step need, in one read.
 *
 * The transcript comes from the Call row rather than from the delivery that
 * triggered this: `applyAnalyzed` has already run its fill-if-null write, so the
 * row holds whichever event carried the transcript first.
 */
async function loadContext(callId: string): Promise<ExtractionContext | null> {
  const rows = await db
    .select({
      transcript: schema.calls.transcript,
      appointmentId: schema.appointments.id,
      personName: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      timezone: schema.businesses.timezone,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(eq(schema.calls.id, callId))
    .limit(1);

  const row = rows[0];
  // No such Call, or a Call nobody spoke on. A no-answer has nothing to read.
  if (!row?.transcript) return null;

  return { ...row, transcript: row.transcript };
}

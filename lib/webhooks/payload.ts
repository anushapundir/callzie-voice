/*
  Retell's webhook envelope, read down to the handful of fields Callzie writes.

  Every payload is the same two keys — `{ event, call }` (docs/verification.md
  A7). The `call` object carries far more than this in reality; keeping only what
  is used means a change to the rest of Retell's payload cannot make this wrong.
  The full body is still stored verbatim in `webhook_events.payload`, so nothing
  is lost by not reading it here.

  Null on anything malformed, rather than a thrown error. This URL is reachable
  from the internet, so garbage arriving is ordinary — the same contract, and the
  same reasoning, as `parseToolRequest` in lib/tools/request.ts.
*/

import { parseTranscriptObject, type StoredTurn } from "@/lib/calls/transcript";

/** What Callzie takes from a delivery. */
export type WebhookEvent = {
  /** Retell's event name. Kept even when it is one we do not act on. */
  event: string;
  /** `call.call_id` — Retell's id, which `calls.retell_call_id` holds. */
  retellCallId: string;
  /**
   * `calls.id`, echoed back from the metadata
   * lib/calls/start-web-call.ts:193 sends. The fallback for finding the Call
   * when `retell_call_id` has not landed on the row yet.
   */
  callzieCallId: string | null;
  /** Retell spells it `disconnection_reason`; our column is `disconnect_reason`. */
  disconnectionReason: string | null;
  transcript: string | null;
  /**
   * `call.transcript_object`, reduced to one start time per turn.
   *
   * Only `call_analyzed` carries it, so it is null on the other two events — and
   * null means "Retell did not say", never "there were no turns". The screen
   * falls back to `transcript` above, which arrives a whole event earlier.
   */
  transcriptTurns: StoredTurn[] | null;
  recordingUrl: string | null;
  /**
   * `call_analysis.in_voicemail`. Retell measures this; nothing infers it
   * (SPEC.md §9 step 4). Only `call_analyzed` carries `call_analysis` at all
   * (docs/verification.md A9), so it is null on the other two events — and null
   * means "Retell did not say", never "not a voicemail".
   */
  inVoicemail: boolean | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
};

export function parseWebhookPayload(rawBody: string): WebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;

  const { event, call } = parsed;
  if (typeof event !== "string" || event === "") return null;
  if (!isObject(call)) return null;

  const retellCallId = call.call_id;
  if (typeof retellCallId !== "string" || retellCallId === "") return null;

  const startedAt = asDate(call.start_timestamp);
  const endedAt = asDate(call.end_timestamp);

  return {
    event,
    retellCallId,
    callzieCallId: isObject(call.metadata)
      ? asText(call.metadata.call_id)
      : null,
    disconnectionReason: asText(call.disconnection_reason),
    transcript: asText(call.transcript),
    transcriptTurns: parseTranscriptObject(call.transcript_object),
    recordingUrl: asText(call.recording_url),
    inVoicemail: isObject(call.call_analysis)
      ? asBoolean(call.call_analysis.in_voicemail)
      : null,
    startedAt,
    endedAt,
    durationSeconds: durationSeconds(call.duration_ms, startedAt, endedAt),
  };
}

/**
 * How long the Call ran, in seconds.
 *
 * Retell's own `duration_ms` wins where it exists. The two timestamps are the
 * fallback, and the floor at zero is not decoration: a negative duration would
 * be worse than a zero, which is the same call `lib/calls/record.ts:55` makes
 * with `GREATEST(..., 0)`.
 */
function durationSeconds(
  durationMs: unknown,
  startedAt: Date | null,
  endedAt: Date | null,
): number | null {
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    return Math.max(Math.round(durationMs / 1000), 0);
  }

  if (!startedAt || !endedAt) return null;

  return Math.max(
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    0,
  );
}

/*
  `typeof [] === "object"`, so the array check is not redundant — without it a
  JSON array would be read as an envelope and its `call_id` looked up on an
  array, which is undefined rather than an error.
*/
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A string, or null.
 *
 * An empty string becomes null, which matters for the transcript: "nothing was
 * said" is what null means in that column, and keeping `""` would block the
 * fill-if-null rule in process.ts when a `call_ended` arrives before the
 * transcript is ready.
 */
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A boolean, or null.
 *
 * Anything else — a string, a number, an absent key — is "Retell did not say",
 * which is deliberately not the same as `false`. Only an explicit `true` stops
 * the outcome step in lib/extraction/outcome.ts.
 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Retell sends Unix **milliseconds** (docs/verification.md A7). */
function asDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value)
    : null;
}

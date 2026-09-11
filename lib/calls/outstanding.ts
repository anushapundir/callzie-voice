import type { CallStatus } from "@/lib/db/schema";

/** Statuses where the Call has not finished happening yet. */
const UNSETTLED: readonly CallStatus[] = ["queued", "ringing", "in_progress"];

export type OutstandingInput = {
  status: CallStatus;
  hasTranscript: boolean;
  hasRecording: boolean;
  hasExtraction: boolean;
};

/**
 * Is the Call detail screen still waiting for something?
 *
 * Retell delivers the transcript on `call_ended` and the recording and the
 * analysis on `call_analyzed`, minutes apart, so a screen opened the moment a
 * Call ends fills in over several deliveries.
 *
 * A Call that never connected is settled whatever is missing. `no_answer` and
 * `failed` produce no transcript, no recording and no extraction, ever —
 * polling for them would refresh the page until the tab is closed.
 */
export function hasOutstandingData({
  status,
  hasTranscript,
  hasRecording,
  hasExtraction,
}: OutstandingInput): boolean {
  if (UNSETTLED.includes(status)) return true;
  if (status !== "completed") return false;

  return !hasTranscript || !hasRecording || !hasExtraction;
}

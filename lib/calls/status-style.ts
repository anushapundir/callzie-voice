import type { StatusStyle } from "@/lib/appointments/status-style";
import type { CallStatus } from "@/lib/db/schema";

/**
 * Which colour and which word each Call status gets.
 *
 * The Appointment equivalent lives in lib/appointments/status-style.ts, and the
 * two are deliberately separate: a Call's `completed` and an Appointment's
 * `confirmed` are different facts, and one table of seven-plus-six entries
 * would invite reading the wrong half.
 *
 * Every colour is a token already declared in app/globals.css — the
 * `--color-*: initial` reset there means an off-token colour would not compile.
 * The values are literal class strings because Tailwind scans source text, and
 * a class assembled at runtime is a class that never gets generated.
 *
 * `completed` is the confirmed green: the conversation happened. What was
 * decided in it is the Appointment's status, not this one.
 */
export const CALL_STATUS_STYLES: Record<CallStatus, StatusStyle> = {
  queued: { background: "bg-text-muted", label: "Queued" },
  ringing: { background: "bg-live", label: "Ringing" },
  // In-progress uses the live blue — the same signal as the pulsing dot.
  in_progress: { background: "bg-live", label: "In progress" },
  completed: { background: "bg-confirmed", label: "Completed" },
  no_answer: { background: "bg-unreachable", label: "No answer" },
  failed: { background: "bg-declined", label: "Failed" },
};

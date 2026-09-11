import type { AppointmentStatus } from "@/lib/db/schema";

/**
 * Which colour and which word each Appointment status gets (SPEC.md §11.2).
 *
 * Lifted out of `components/overview/status-pill.tsx` when the Schedule day
 * view needed the same seven colours for a block's left bar. Two screens
 * deriving this independently is how `cancelled` ends up slate on one and red
 * on the other.
 *
 * Every colour below is a token already declared in `app/globals.css`. This
 * module introduces none — the `--color-*: initial` reset in that file means an
 * off-token colour would not compile. The values are literal class strings for
 * a related reason: Tailwind scans source text, and a class assembled at runtime
 * is a class that never gets generated.
 *
 * **§11.2 names colours for five statuses and the schema has seven**, so two
 * were decided here and are written down so the next screen that needs a colour
 * does not re-derive them differently:
 *
 * - `pending` uses `text-muted`. Nothing has happened to this Appointment yet,
 *   and a status that is merely the default should not draw the eye.
 * - `cancelled` uses the `unreachable` slate rather than the `declined` red. A
 *   cancellation is a neutral outcome; red is reserved for the person saying no.
 *
 * A colour is never the only signal. Both callers render `label` beside it:
 * about one in twelve men cannot distinguish the green from the amber, and the
 * word is what they read.
 */

export type StatusStyle = {
  /** A Tailwind background class — the pill's dot, the block's left bar. */
  background: string;
  label: string;
};

export const STATUS_STYLES: Record<AppointmentStatus, StatusStyle> = {
  pending: { background: "bg-text-muted", label: "Pending" },
  // Muted like `pending`, and for the same reason: a queued Appointment is
  // waiting rather than happening, and should not draw the eye away from the
  // row that is actually being called.
  queued: { background: "bg-text-muted", label: "Queued" },
  // In-progress uses the live blue — the same signal as the pulsing dot.
  calling: { background: "bg-live", label: "Calling" },
  confirmed: { background: "bg-confirmed", label: "Confirmed" },
  rescheduled: { background: "bg-rescheduled", label: "Rescheduled" },
  declined: { background: "bg-declined", label: "Declined" },
  cancelled: { background: "bg-unreachable", label: "Cancelled" },
  unreachable: { background: "bg-unreachable", label: "Unreachable" },
};

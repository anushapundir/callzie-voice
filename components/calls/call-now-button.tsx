"use client"

import { Phone } from "lucide-react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * "Call now" on one Appointment's row (SPEC.md §11.3).
 *
 * Disabled for two different reasons, and the `title` says which — a disabled
 * control that does not explain itself reads as a broken one.
 *
 * `busy` is temporary: there is one bar and one Call, so the rest of the table
 * waits. `blocked` is not temporary at all — the Appointment needs attention,
 * and nothing but a human pressing Clear will change that. So `blocked` wins the
 * title when both are true.
 *
 * The Quota is still deliberately NOT checked here. A button that hid itself
 * when the meter ran out would be guessing at a bound the server owns, and the
 * two would disagree the moment another tab spent the last Call.
 * `needs_attention_reason` is different in kind: it is a fact carried on the row
 * already rendered, so disabling on it is reporting rather than guessing.
 *
 * Either way the server has the final word — `lib/calls/start-web-call.ts`
 * refuses a flagged Appointment before it claims the Quota, and it refuses a
 * forged POST exactly the same way.
 */
export function CallNowButton({
  appointmentId,
  name,
  blocked = false,
}: {
  appointmentId: string
  name: string
  /** This Appointment needs attention. Callzie will not call it. */
  blocked?: boolean
}) {
  const { busy, start } = useLiveCall()

  const title = blocked
    ? "This appointment needs attention. Clear it first."
    : busy
      ? "Finish the call in progress first"
      : undefined

  return (
    // Outline, not the primary black: this button repeats on every row, and a
    // table of primary buttons leaves no primary at all. The Quick Call card's
    // "Call now" is the one primary action on the screen.
    <Button
      variant="outline"
      size="sm"
      disabled={busy || blocked}
      title={title}
      onClick={() => start({ appointmentId, name })}
    >
      <Phone aria-hidden />
      Call now
      {/* Seven identical buttons in a table are seven identical announcements
          without this. */}
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}

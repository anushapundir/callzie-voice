"use client"

import { RotateCcw } from "lucide-react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * Try this Appointment again, from the Call that failed.
 *
 * It starts a Web Call through the same provider the Quick Call card and every
 * table row use — there is one microphone, one `RetellWebClient` and one
 * 30-second deadline in this app, and a second implementation here would drift
 * from all three.
 *
 * `startWebCall` writes a NEW `calls` row with `attempt: existing + 1`
 * (lib/calls/start-web-call.ts). So a retry does not revive this Call; it
 * creates the next one, and this page stays readable as the record of the
 * attempt that failed.
 *
 * Disabled while any Call is in flight, with a `title` that says why — the same
 * rule, and the same reasoning, as components/calls/call-now-button.tsx. A
 * disabled control that does not explain itself reads as a broken one.
 *
 * Quota is deliberately not checked. The server owns that bound, and a button
 * that hid itself would be guessing at it; pressing it and being refused in the
 * live-call bar is the honest version.
 */
export function RetryCallButton({
  appointmentId,
  personName,
}: {
  appointmentId: string
  personName: string
}) {
  const { busy, start } = useLiveCall()

  return (
    /*
      `default` size and `default` variant. This is the one thing to do on a call
      that did not connect, and the variant rule in docs/design.md is that the
      action you are meant to take is the solid ink one. It was `sm`, which made
      the only useful control on the screen the smallest thing on it.
    */
    <Button
      disabled={busy}
      title={busy ? "Finish the call in progress first" : undefined}
      onClick={() => start({ appointmentId, name: personName })}
    >
      <RotateCcw aria-hidden />
      Retry call
      <span className="sr-only"> — {personName}</span>
    </Button>
  )
}

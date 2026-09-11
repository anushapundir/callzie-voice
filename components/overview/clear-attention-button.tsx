"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"

import { clearAttentionAction } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"

/**
 * The only way out of Needs Attention (SPEC.md §5).
 *
 * The one client island in the panel. `useTransition` rather than
 * `useActionState`, matching `components/overview/csv-upload.tsx`: there is no
 * form and no returned state to render — the action revalidates and the row
 * simply stops existing.
 *
 * §11.4 wants every async action to carry a loading state on its own button
 * rather than blocking the page, which is what `clearing` is for. Working a
 * queue of three means pressing three buttons, and only the pressed one should
 * look busy.
 *
 * **No confirmation step.** It is one column, the Appointment stays in the table
 * below, and the Call it came from keeps its `tool_invocations`. A confirm
 * dialog on a queue somebody works through is friction with nothing behind it.
 *
 * `outline`, not the accent default. §11.2 reserves the accent for primary
 * actions, and the primary action on this screen is placing a Call.
 */
export function ClearAttentionButton({
  appointmentId,
  name,
}: {
  appointmentId: string
  name: string
}) {
  const [clearing, startClearing] = React.useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={clearing}
      onClick={() =>
        startClearing(async () => {
          await clearAttentionAction(appointmentId)
        })
      }
    >
      {clearing && <Loader2 className="animate-spin" aria-hidden />}
      {clearing ? "Clearing…" : "Clear"}
      {/* Three identical buttons are three identical announcements without
          this — the same call `call-now-button.tsx` makes. */}
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}

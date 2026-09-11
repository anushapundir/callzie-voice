import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

/**
 * What a running batch looks like (issue #17), as pure markup.
 *
 * Split from the client component that polls so it can be rendered to a string
 * in a test — the same split `failure-card.tsx` uses.
 *
 * Renders nothing at zero, so it costs nothing on a quiet screen. Stop
 * disappears with the queue: it returns waiting Appointments to pending and
 * cannot un-ring a phone, so with nothing waiting it would do nothing, and a
 * control that does nothing is a lie.
 */
export function BatchStripView({
  calling,
  waiting,
  stopping,
  onStop,
}: {
  calling: number
  waiting: number
  stopping: boolean
  onStop: () => void
}) {
  if (calling === 0 && waiting === 0) return null

  return (
    <Card
      pad="none"
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-4 px-4 py-3"
    >
      <div className="flex items-center gap-3 text-body text-text">
        {/*
          A dot, not a coloured icon. Cobalt is allowed on the live dot and
          nowhere else (docs/design.md), and a batch in flight is exactly what
          that dot means — the same signal the topbar is showing at the same
          moment.
        */}
        <span
          aria-hidden
          className="size-2 shrink-0 animate-live-pulse rounded-full bg-live"
        />
        <span className="font-mono">Calling {calling}</span>
        <span className="text-text-muted">·</span>
        <span className="font-mono text-text-muted">{waiting} waiting</span>
      </div>

      {waiting > 0 && (
        <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}>
          {/* On the button itself; §11.4 rules out a full-page blocker. */}
          {stopping && <Loader2 className="animate-spin" aria-hidden />}
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
    </Card>
  )
}

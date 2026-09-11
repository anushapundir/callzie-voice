import type * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Nothing here yet — said once, the same way, everywhere.
 *
 * Two shapes, one component:
 *
 * - **Empty.** A screen with no rows. Quiet, and it always offers the next
 *   move, because an empty screen with no way forward is a dead end.
 * - **Waiting** (`waiting`). Data that has not arrived. Retell delivers the
 *   transcript on `call_ended` and the recording on `call_analyzed`, minutes
 *   apart (docs/verification.md A9). Hiding the block until then would change
 *   the shape of the screen under the reader and give no clue anything is
 *   still coming, so the block says so itself.
 *
 * Quiet in both cases. `ui/callout.tsx`'s amber is reserved for things a person
 * has to act on; nothing here is a failure.
 *
 * This replaced six different empty-state shapes — a dashed box here, a bare
 * sentence there, a centred icon somewhere else.
 */
export function EmptyState({
  title,
  children,
  action,
  waiting = false,
  className,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  waiting?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "workspace-empty flex items-start gap-3 rounded-card border border-line bg-surface-soft px-5 py-6 text-table text-text-muted",
        className
      )}
    >
      {waiting ? (
        <Loader2
          className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : null}
      <div className="min-w-0">
        <p className="font-medium text-text">{title}</p>
        {children ? <p className="mt-1">{children}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  )
}

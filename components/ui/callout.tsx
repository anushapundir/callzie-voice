import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A persistent, inline message — never a toast.
 *
 * SPEC.md §11.4 reserves toasts for transient results and requires "inline
 * persistent UI for anything requiring action". Everything this renders is the
 * second kind: the Appointments a narrowed opening window stranded, a failed
 * extraction, the reason a Call did not connect. Each names something a person
 * has to deal with, so it stays on screen until the state that produced it
 * changes.
 *
 * Lifted out of components/settings/section.tsx when the Call detail screen
 * needed the same amber for a failed extraction and a failed Call. Two screens
 * deriving this independently is how the same class of warning ends up two
 * different colours.
 *
 * `tone` maps onto SPEC.md §11.2's status colours and introduces none:
 * `warning` is the needs-attention orange, the palette's designated "a human
 * must look at this" signal.
 */
export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning" | "success"
  title?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      /*
        `role="status"` rather than `role="alert"`. These appear as the result of
        something the person just did, or as part of a page they navigated to,
        and an assertive live region would interrupt a screen reader mid-sentence
        to announce something they asked for. Nothing here is an emergency.
      */
      role="status"
      className={cn(
        "rounded-card border p-4 text-table",
        tone === "warning" && "border-attention/40 bg-attention/10 text-text",
        tone === "success" && "border-confirmed/40 bg-confirmed/10 text-text",
        tone === "info" && "border-line bg-surface-soft text-text-muted",
        className
      )}
    >
      {title ? (
        <p
          className={cn(
            "font-medium",
            tone === "warning" && "text-attention",
            tone === "success" && "text-confirmed",
            tone === "info" && "text-text"
          )}
        >
          {title}
        </p>
      ) : null}
      {children ? (
        <div className={cn(title && "mt-1", "text-text-muted")}>{children}</div>
      ) : null}
    </div>
  )
}

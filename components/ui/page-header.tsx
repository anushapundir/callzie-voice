import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A section title, its one line of description, and its actions.
 *
 * The rule it enforces is the heavier rule underneath: `line-strong` is the one
 * border that says "a new part of the page starts here", and it is the reason
 * sections do not need to be boxes (docs/design.md).
 *
 * Weight and size come from the `text-section` token, never from a
 * `font-medium` written next to it — that is how the same heading shipped at
 * two weights in two files.
 */
export function PageHeader({
  title,
  description,
  actions,
  rule = true,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Drop the rule where the block below already draws its own. */
  rule?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-3",
        rule && "border-b border-line-strong",
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-section text-text">{title}</h2>
        {description ? (
          <p className="mt-1 text-table text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

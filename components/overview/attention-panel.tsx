import type * as React from "react"

import { Callout } from "@/components/ui/callout"
import { cn } from "@/lib/utils"

/**
 * The one shape every "somebody has to do something" message on Overview
 * takes.
 *
 * Four of them can land on this screen at once — a call that could not be
 * placed, the rows a CSV upload refused, the callers waiting to hear back, and
 * the appointments Callzie has stopped calling. Each one used to draw its own
 * amber box, so a bad morning produced four stacked orange panels above the
 * fold and none of them looked more important than any other.
 *
 * So they all come through here, and here they are not boxes. A hairline above
 * and below, a 2px amber rule down the left edge, and paper behind — the amber
 * marks the margin rather than filling the page. Four of these read as one
 * column of related notes instead of four alarms.
 *
 * **The heading is ink, and only the number is amber.** A whole sentence in
 * orange is harder to read and says nothing extra; the count is the part the
 * eye is looking for. Wrap it at the call site:
 * `<span className="text-attention">3</span>`.
 *
 * `ui/callout` draws the chrome, so the colour lives in one place for the whole
 * app. What is overridden here is only the shape: the box becomes two rules and
 * a margin.
 */

/*
  `border-0` first, then the three sides that survive. tailwind-merge resolves
  these by argument order rather than by stylesheet order, so writing the reset
  before the exceptions actually works — the right-hand border stays at zero
  width and the left one ends up at 2px.

  `bg-transparent` matters as much as the borders: paper is the only ground in
  this design, and a tinted panel is a box by another name.
*/
const SHAPE = "rounded-none border-0 border-y border-l-2 bg-transparent py-4 pr-0 pl-4"

export function AttentionPanel({
  id,
  tone = "warning",
  heading,
  actions,
  children,
}: {
  /** Used for the heading's element id, so the section can point at it. */
  id: string
  /** `info` for a clean result that still has to be read and dismissed. */
  tone?: "warning" | "info"
  heading: React.ReactNode
  /** Dismiss, and nothing else. Row-level actions belong on the rows. */
  actions?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    /*
      A `<section>` wrapper rather than props on the callout, so the panel is
      announced by its own heading. `ui/callout` carries `role="status"`, which
      is polite: a screen reader mentions it when the list actually changes, and
      says nothing on the re-renders that leave the same rows in place.
    */
    <section aria-labelledby={`${id}-heading`}>
      <Callout
        tone={tone}
        className={cn(
          SHAPE,
          tone === "warning" && "border-y-line border-l-attention",
          tone === "info" && "border-y-line border-l-line-strong",
        )}
      >
        <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <p id={`${id}-heading`} className="text-body text-text">
            {heading}
          </p>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
        {children ? <div className="mt-3">{children}</div> : null}
      </Callout>
    </section>
  )
}

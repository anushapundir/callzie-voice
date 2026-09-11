import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A bordered object you act *inside*.
 *
 * Most of this product is not made of cards. A section is a run of rows
 * separated by hairlines; a box is reserved for the two or three things on a
 * screen that have an edge — Quick call, the Outcome, a failed extraction
 * (docs/design.md). If a block would read the same as plain layout, it should
 * be plain layout.
 *
 * This exists because `rounded-card border border-line bg-surface` was
 * hand-written in twenty-two files at four different insets, which is how the
 * same object ended up four sizes.
 *
 * `tone` picks which of the four border kinds applies:
 * - `line` — a quiet object, grouped but not urgent.
 * - `ink` — the one thing on the screen you are meant to use. One per screen.
 * - `attention` — the only coloured border. Something a person must deal with.
 */
export function Card({
  tone = "line",
  pad = "md",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: "line" | "ink" | "attention"
  /** `sm` inside a table or a row · `md` everywhere else. Nothing else. */
  pad?: "none" | "sm" | "md"
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-card border bg-surface",
        tone === "line" && "border-line",
        tone === "ink" && "border-accent",
        tone === "attention" && "border-attention",
        pad === "sm" && "p-3",
        pad === "md" && "p-5",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

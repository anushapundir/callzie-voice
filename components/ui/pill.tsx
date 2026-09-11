import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A status: a coloured dot plus the word, in ink.
 *
 * Never colour alone — about one in twelve men cannot tell the green from the
 * amber, and the label is what they read. Never a filled pill and never a
 * bordered chip on a table row either: a row of twenty appointments with twenty
 * outlined chips reads as twenty buttons.
 *
 * `quiet` is the table form — the dot and the word with no border and no
 * padding, so the column reads as text. `quiet={false}` keeps the bordered form
 * for the two places a status stands alone as an object: a Call's header and
 * the live call bar.
 *
 * This replaced five hand-rolled versions of the same idiom, two of which were
 * byte-identical files in different folders.
 */
export function Pill({
  dot,
  children,
  quiet = false,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  /** A background utility class from one of the `*-style.ts` tables. */
  dot: string
  quiet?: boolean
}) {
  return (
    <span
      data-slot="pill"
      className={cn(
        "inline-flex items-center gap-2 text-table text-text",
        !quiet && "rounded-full border border-line px-2 py-1",
        className
      )}
      {...props}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      {children}
    </span>
  )
}

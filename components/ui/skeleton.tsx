import { cn } from "@/lib/utils"

/**
 * A pulsing placeholder block, shown while a screen's data loads.
 *
 * The gray card surface, not a new colour — a skeleton is the shape of the
 * content it stands in for, and the pulse is what says "loading" rather than
 * "empty". `prefers-reduced-motion` stops the pulse via the global rule in
 * app/globals.css, leaving a static gray block.
 *
 * `aria-hidden`: screen readers get the route's loading announcement from
 * Next itself; reading out a grid of empty boxes would add nothing.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-control bg-surface-card", className)}
    />
  )
}

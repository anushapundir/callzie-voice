import Link from "next/link"

import { cn } from "@/lib/utils"

/**
 * The logo. There is no other drawing of it anywhere in this repo.
 *
 * It is a word with a full stop: **Callzie.** — a sentence, finished, the way a
 * booked Appointment is finished. Set in Outfit at 600: a geometric sans with
 * round bowls, which is the voice of the landing page and therefore the first
 * thing anybody sees (docs/design.md).
 *
 * It inherits its colour from whatever it sits on, so the same component works
 * on paper and inside a `data-ground="dark"` band without a second variant.
 *
 * Before this, the mark was drawn four different ways across four consecutive
 * screens — a monospace C in a circle in the sidebar, a bordered box in the
 * nav, a plain letter on the auth page. A visitor met three logos on the way
 * to signing up.
 */
export function Wordmark({
  size = "md",
  href,
  className,
}: {
  /**
   * `sm` sidebar · `md` nav · `lg` the auth brand panel · `inherit` where the
   * parent sets the size itself, which is how the landing footer runs the mark
   * off the bottom of the page at 320px.
   */
  size?: "sm" | "md" | "lg" | "inherit"
  /** Wraps the mark in a link. Omit it where the mark is not a way out. */
  href?: string
  className?: string
}) {
  const mark = (
    <span
      className={cn(
        "font-display leading-none font-semibold tracking-[-0.03em]",
        size === "sm" && "text-[20px]",
        size === "inherit" && "text-[length:inherit] leading-[inherit] tracking-[inherit] font-[inherit]",
        size === "md" && "text-[22px]",
        size === "lg" && "text-[40px]",
        className
      )}
    >
      Callzie.
    </span>
  )

  if (!href) return mark

  return (
    <Link href={href} className="inline-flex items-center rounded-control">
      {mark}
    </Link>
  )
}

/**
 * The mark reduced to one letter, for the collapsed sidebar rail.
 *
 * No container, no border, no box — the serif letterform is the mark.
 */
export function WordmarkGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-display text-[20px] leading-none font-semibold", className)}
      aria-hidden
    >
      C
    </span>
  )
}

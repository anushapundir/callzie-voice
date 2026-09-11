import * as React from "react"

import { cn } from "@/lib/utils"

/*
  Restyled onto SPEC.md §11.2, matching components/ui/button.tsx: 6px radius,
  the 14px body size, borders rather than shadows, and no focus treatment of its
  own — app/globals.css gives every focusable element the accent outline at 2px
  offset, so a component that draws its own ring would double it.

  shadcn ships this with `rounded-lg`, `text-base`/`text-sm` and a
  `focus-visible:ring-3`. None of those tokens exist here, and the `--radius-*`
  / `--text-*` resets mean they emit no CSS rather than failing the build — so
  the default would have rendered as an unstyled box.
*/
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-control border border-line bg-transparent px-2.5 py-1 text-body text-text transition-colors",
        "placeholder:text-text-muted",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }

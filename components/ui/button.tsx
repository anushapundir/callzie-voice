import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/*
  Restyled onto docs/design.md: 4px radius, the 13/14px type scale, and no focus
  treatment of its own — app/globals.css gives every focusable element the ink
  outline at 2px offset, so a component that draws its own would double it.

  **Two sizes.** `default` is 32px and `sm` is 28px; `xs` and `lg` are kept as
  aliases so older call sites still compile, but they resolve to those two. A
  third height is always someone re-deciding a decision that was already made.

  The variant rule, everywhere in the app: committing a form is `default`; a
  reversible on/off is `outline` in *both* directions; something irreversible is
  `destructive`. A toggle that turns red to switch off reads as a delete.
*/
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Hovers to a darker ink, not to 80% opacity. A primary button that fades
        // under the cursor reads as disabled at exactly the moment it is being
        // used.
        default:
          "bg-primary text-primary-foreground hover:bg-accent-active",
        outline:
          "border-line bg-transparent text-text hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost:
          "text-text-muted hover:bg-muted hover:text-text aria-expanded:bg-muted aria-expanded:text-text",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20",
        // Not accent: §11.2 allows it on primary actions, the live indicator
        // and the waveform only — a text link is none of the three.
        link: "text-text underline underline-offset-4 hover:text-text-muted",
      },
      size: {
        default:
          "h-8 gap-2 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 gap-1.5 px-2 text-table has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&_svg:not([class*='size-'])]:size-4",
        // Aliases. See the note above: there are two sizes.
        xs: "h-7 gap-1.5 px-2 text-table has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-8 gap-2 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

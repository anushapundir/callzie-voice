"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/*
  Restyled onto SPEC.md §11.2. Two substantive changes from the shadcn default:

  - **Border, not shadow.** §11.2 is explicit that separation comes from a 1px
    line; the default's `shadow-md ring-1 ring-foreground/10` is replaced by
    `border border-line`.
  - **No fixed `w-72`.** The timezone combobox needs the panel to match its
    trigger, and a hardcoded 288px overflows a 375px viewport once padding is
    counted (§11.4). Callers set the width.

  The header/title/description helpers shadcn ships are dropped: nothing uses
  them, and this repo does not carry dead components.
*/

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-card border border-line bg-surface text-body text-text shadow-overlay",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }

"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The open/closed control on each weekday row in Settings (issue #5).
 *
 * A switch rather than a checkbox because both states are meaningful settings —
 * "closed on Sunday" is a decision, not an unticked option — and because the
 * row's time inputs appear and disappear behind it, which is an on/off
 * relationship the affordance should already imply.
 *
 * Worth knowing before putting one in a `<form>`: like a native checkbox, the
 * input Radix bubbles for `name` is submitted **only when checked**. A closed
 * weekday arrives as an absent key, never as `"false"` — read it with
 * `formData.has(name)` and treat missing as closed. Reading it as a value makes
 * every closed day look untouched, silently.
 */
function Switch({
  className,
  thumbClassName,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  thumbClassName?: string
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      /*
        No focus treatment of its own: app/globals.css §11.4 gives every
        focusable element the accent outline at 2px offset, and a component that
        added a ring — or worked around the outline with `peer-focus-visible:` —
        would double it. The track *is* the focusable element here, so the global
        rule lands on the thing the eye is already on.

        The transparent 2px border is what insets the thumb. The track paints
        under it, so the control reads as 36×20 while the thumb travels the 32px
        content box.
      */
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-line transition-colors",
        // §11.2 reserves the accent for primary actions, the live indicator and
        // the waveform. "This day is open" is the only thing a weekday row
        // asserts, and the whole screen exists to set it.
        "data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        /*
          The thumb changes colour as well as position, so state does not rest on
          the teal alone and survives a greyscale screenshot: muted text on the
          dark track when off, the page background on the accent when on.
        */
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-text-muted transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-bg",
          "data-[state=unchecked]:translate-x-0",
          thumbClassName
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }

"use client"

import { useLinkStatus } from "next/link"

import { cn } from "@/lib/utils"

/*
  Drop inside any <Link> styled as a button: the moment the link is clicked the
  control dims and keeps dimming until the new page takes over.

  This exists because a click on "Sign in" used to look like nothing had
  happened. In development the target route compiles on demand and prefetching
  is off, so the fetch a click starts can take seconds — which is exactly when
  feedback matters. It is a wash rather than a spinner because the button is
  only 32px tall and a spinner inside it would be a moving speck.

  The parent needs `relative` and `overflow-hidden`; every button on the landing
  page has both.
*/
export function LinkPending() {
  const { pending } = useLinkStatus()

  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit] bg-text/15 opacity-0 transition-opacity duration-150",
        pending && "opacity-100 motion-safe:animate-pulse"
      )}
    />
  )
}

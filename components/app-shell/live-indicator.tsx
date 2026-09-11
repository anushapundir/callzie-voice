"use client"

import * as React from "react"

/**
 * The one place cobalt is allowed in the topbar, and the app's one signature
 * animation. `prefers-reduced-motion` stops the pulse via the global rule in
 * app/globals.css, leaving a static dot.
 *
 * No border and no box. It used to be a bordered pill sitting in a bar that has
 * no borders of its own, and on a narrow screen the words were dropped and the
 * box closed around a lone dot that said nothing.
 *
 * It also wakes the rest of the app up: `data-live` on the shell wrapper, and
 * the live favicon, so a call in progress is visible from a background tab.
 */
export function LiveIndicator({ activeCalls }: { activeCalls: number }) {
  const live = activeCalls >= 1
  const noun = activeCalls === 1 ? "call" : "calls"

  React.useEffect(() => {
    if (!live) return

    const shell = document.querySelector("[data-app-shell]")
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    /*
      Read the idle icon back rather than hard-coding `/icon.svg`. Next serves
      `app/icon.svg` at a hashed URL, so putting the plain path back would swap
      the file for a different one and lose the cache-busting with it.
    */
    const idleIcon = icon?.getAttribute("href")

    shell?.setAttribute("data-live", "true")
    icon?.setAttribute("href", "/icon-live.svg")

    return () => {
      shell?.removeAttribute("data-live")
      if (idleIcon) icon?.setAttribute("href", idleIcon)
    }
  }, [live])

  return (
    // The region stays mounted even with no call live. A live region that is
    // inserted at the moment it gains content is generally not announced — it
    // has to already exist for the 0 → 1 change to be read out.
    <span aria-live="polite">
      {live ? (
        <span className="flex items-center gap-2 text-table text-text-muted">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-live animate-live-pulse"
          />
          {/*
            The count is always on screen — it is the only part of this that
            carries information. Below `sm` the words step aside but stay in the
            page for a screen reader, so the sentence is announced whole and
            only once.
          */}
          <span className="font-medium text-text">{activeCalls}</span>
          <span className="sr-only sm:not-sr-only">{noun} in progress</span>
        </span>
      ) : null}
    </span>
  )
}

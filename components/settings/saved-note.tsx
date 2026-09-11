"use client"

import * as React from "react"

/** How long the word stays before it fades. Long enough to read, short enough
 *  that it is gone by the time the next edit starts. */
const VISIBLE_MS = 3000

/**
 * "Saved", in 13px muted grey, for about three seconds.
 *
 * Every section used to confirm a save with a permanent tinted box that sat
 * there until the page was reloaded — so a screen you had edited four times
 * carried four green panels reporting things you already knew. A save is a
 * transient result, and SPEC.md §11.4 keeps the persistent inline treatment for
 * things that still need doing. Those are still `Callout`s; this is not one.
 *
 * **Pass a fresh object as `token` for each save that lands, and `null`
 * otherwise.** Identity is the whole signal: a Server Action returns a new
 * state object every time it completes, so `token={state.saved ? state : null}`
 * re-runs the timer on the second save of the same field, which a boolean prop
 * could not do — `saved` stays true and nothing would change.
 *
 * The wrapper is always in the DOM with `role="status"`, so a screen reader
 * announces the word when it appears instead of announcing a region arriving.
 */
export function SavedNote({
  token,
  children = "Saved",
}: {
  token: unknown
  children?: React.ReactNode
}) {
  /*
    What is stored is the token that has already had its three seconds, not a
    boolean. Whether the word is on screen is then worked out during render
    rather than written by the effect — which matters because setting state
    inside an effect body makes React render the component twice for every
    save, and the lint rule that enforces this is the one that caught it.

    A refused save passes `null`, and `null` is never equal to a real token, so
    the word simply is not there. No branch needed.
  */
  const [expired, setExpired] = React.useState<unknown>(null)
  const visible = token !== null && token !== undefined && token !== expired

  React.useEffect(() => {
    if (token === null || token === undefined) return

    const timer = setTimeout(() => setExpired(token), VISIBLE_MS)
    // Clearing on the way out is what stops an older timer hiding a newer word.
    return () => clearTimeout(timer)
  }, [token])

  return (
    <p role="status" className="text-table text-text-muted">
      {visible ? children : null}
    </p>
  )
}

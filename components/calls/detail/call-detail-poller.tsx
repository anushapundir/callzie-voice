"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

/** How often the page re-reads while anything is outstanding (SPEC.md §11.3). */
const REFRESH_MS = 5_000

/**
 * Re-reads the Call detail while its data is still arriving.
 *
 * Renders nothing. `router.refresh()` re-runs the Server Component above it and
 * swaps the result in without losing client state — so the player keeps playing
 * while the transcript fills in beneath it.
 *
 * The parent decides whether to render this at all, using `hasOutstandingData`.
 * Keeping the decision out here means the interval simply does not exist on a
 * settled Call, rather than existing and returning early forever.
 */
export function CallDetailPoller() {
  const router = useRouter()

  React.useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [router])

  return null
}

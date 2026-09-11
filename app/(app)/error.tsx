"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"

/**
 * The net under every screen in the app.
 *
 * Anything a page or a server action throws lands here instead of on Next's own
 * error page, so the sidebar, the topbar and a way forward all stay put.
 *
 * `reset` re-runs the part of the page that failed. It is the right first move
 * for the common case — a query that timed out, a database connection that had
 * gone away — because nothing needs reloading if the next attempt works.
 *
 * A client component, and it has to be: an error boundary is a React runtime
 * thing, and `reset` is a function the browser calls.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  /*
    Server errors reach the browser stripped of their message — all that
    survives is `digest`, the id the same error was logged under on the server.
    Printing it is what lets someone match what they saw to the server log.
  */
  React.useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <EmptyState
      title="Something went wrong"
      action={
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      }
    >
      That did not load. Try again — if it keeps happening, reload the page.
    </EmptyState>
  )
}

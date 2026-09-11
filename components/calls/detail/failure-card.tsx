import type * as React from "react"

import { Card } from "@/components/ui/card"
import { callFailure } from "@/lib/calls/failure-reason"

/**
 * Why a call did not produce a conversation, and what to do about it.
 *
 * Rendered above everything else in the right column, because on a call that
 * never connected it is the only card with anything to say — the rest of the
 * screen is empty for the reason this one is explaining.
 *
 * Amber, not red. SPEC.md §11.4 wants inline persistent UI for anything
 * requiring action, and the needs-attention orange is the palette's signal for
 * exactly that. Red is the `declined` colour, which means the person said no — a
 * different fact entirely.
 *
 * `retry` arrives as a prop rather than being imported. The button is a client
 * component that reads the live-call context, and taking it as a prop keeps this
 * card a plain Server Component that renders to a string in a test.
 */
export function FailureCard({
  disconnectReason,
  retry,
}: {
  disconnectReason: string | null
  retry: React.ReactNode
}) {
  const failure = callFailure(disconnectReason)

  return (
    <Card tone="attention">
      {/*
        The serif, because this sentence is the answer on a call that never
        connected — the same job the verdict does at the top of a call that did.
      */}
      <p className="font-serif text-section text-text">{failure.headline}</p>
      <p className="mt-2 max-w-prose text-table text-text-muted">
        {failure.detail}
      </p>
      {failure.canRetry ? <div className="mt-4">{retry}</div> : null}
    </Card>
  )
}

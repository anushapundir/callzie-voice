"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import {
  stopBatchAction,
  tickBatchAction,
  type BatchProgress,
} from "@/app/(app)/calls/batch-actions"
import { BatchStripView } from "@/components/overview/batch-strip-view"

/**
 * The strip, and the tick that keeps it honest.
 *
 * Every 5 seconds while a batch is running (SPEC.md §11.3) it asks the server
 * to pump, then refreshes the page. The pump is what fills a slot if a webhook
 * never arrived — belt and braces behind ADR-0013's real mechanism.
 *
 * The refresh is also what makes the Appointments table update while Calls are
 * in flight. The existing 5s refresh in
 * `components/calls/live-call-provider.tsx` cannot do that job: it only runs
 * while *this browser* owns a live Web Call, which is never true of a batch of
 * Phone Calls.
 *
 * **The counts are never copied into state.** They arrive as props from the
 * Server Component and are rendered straight through, so there is one source of
 * truth and nothing to resynchronise. `router.refresh()` brings new ones, and
 * `stopBatchAction` revalidates `/` on the server, which does the same. Holding
 * a copy here would mean an effect writing state on every render — the
 * cascading-render pattern React's own lint rule refuses.
 *
 * The interval stops when nothing is running, so a quiet screen polls nothing.
 */
const TICK_MS = 5_000

export function BatchStrip({ initial }: { initial: BatchProgress }) {
  const [stopping, startStopping] = React.useTransition()
  const router = useRouter()

  const running = initial.calling > 0 || initial.waiting > 0

  React.useEffect(() => {
    if (!running) return

    const interval = setInterval(async () => {
      await tickBatchAction()
      router.refresh()
    }, TICK_MS)

    return () => clearInterval(interval)
  }, [running, router])

  return (
    <BatchStripView
      calling={initial.calling}
      waiting={initial.waiting}
      stopping={stopping}
      onStop={() => startStopping(async () => void (await stopBatchAction()))}
    />
  )
}

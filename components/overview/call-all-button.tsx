"use client"

import { Loader2, PhoneOutgoing } from "lucide-react"
import * as React from "react"

import {
  batchPreviewAction,
  startBatchAction,
  type BatchPreview,
} from "@/app/(app)/calls/batch-actions"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { batchSummary } from "@/lib/calls/batch/summary"

/**
 * Call all (SPEC.md §11.3), and the one confirmation in front of it.
 *
 * A row's "Call now" spends one Call and asks nothing. This spends every Call
 * the account has left, on real phones belonging to real people, so it states
 * the numbers first and waits.
 *
 * The preview is read when the sheet opens rather than with the page, because
 * it goes stale the moment another tab places a Call — reading it late is what
 * makes it true for as long as the sheet is open.
 *
 * `useTransition` and a direct call rather than `useActionState`, matching
 * `csv-upload.tsx`: there is no form here for an action to attach to.
 */
export function CallAllButton() {
  const [open, setOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<BatchPreview | null>(null)
  const [starting, startCalling] = React.useTransition()

  async function show() {
    setOpen(true)
    setPreview(null)
    setPreview(await batchPreviewAction())
  }

  const summary = preview
    ? batchSummary({
        eligible: preview.eligible,
        quotaRemaining: preview.quotaRemaining,
        phoneCallsEnabled: preview.phoneCallsEnabled,
      })
    : null

  return (
    <>
      {/*
        Outline, not the accent default. §11.2 reserves the accent for primary
        actions, and the primary action on this screen is the Quick call card.
      */}
      <Button variant="outline" onClick={() => void show()}>
        <PhoneOutgoing aria-hidden />
        Call all
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="data-[side=right]:sm:max-w-lg"
          aria-describedby="call-all-description"
        >
          <SheetHeader>
            <SheetTitle>{summary?.title ?? "Call all"}</SheetTitle>
            <SheetDescription id="call-all-description">
              {summary?.detail ?? "Working out who can be called…"}
            </SheetDescription>
          </SheetHeader>

          {/*
            A refusal gets Close, not a disabled "Call 0 now". The sheet has
            already said why in a sentence, and a greyed-out button offering to
            place zero calls says nothing and looks broken.
          */}
          <SheetFooter>
            {summary?.canStart ? (
              <Button
                disabled={starting}
                onClick={() =>
                  startCalling(async () => {
                    await startBatchAction()
                    setOpen(false)
                  })
                }
              >
                {/* On the button itself; §11.4 rules out a full-page blocker. */}
                {starting && <Loader2 className="animate-spin" aria-hidden />}
                {starting ? "Starting…" : `Call ${summary.willPlace} now`}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}

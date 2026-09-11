"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"

import { resolveEnquiryAction } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"

/**
 * The only way out of the open-Enquiries panel (issue #43).
 *
 * A near-twin of `clear-attention-button.tsx`, and everything that file says
 * applies here: `useTransition` rather than `useActionState` because there is no
 * form and no returned state, a per-button loading state rather than a page
 * blocker (§11.4), and no confirmation step on a queue somebody works through.
 *
 * The label is "Done" rather than "Clear", and the difference is not cosmetic.
 * Clearing a Needs Attention row unblocks Callzie — it says "you may call this
 * person again". This says "I have dealt with it", about a job the human just
 * did themselves. Two different sentences deserve two different words on two
 * panels that sit next to each other.
 *
 * Nothing is destroyed. The Enquiry, the transcript and the Tool invocations all
 * stay on the Call detail screen; the row only stops asking.
 */
export function ResolveEnquiryButton({
  enquiryId,
  name,
}: {
  enquiryId: string
  name: string
}) {
  const [resolving, startResolving] = React.useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={resolving}
      onClick={() =>
        startResolving(async () => {
          await resolveEnquiryAction(enquiryId)
        })
      }
    >
      {resolving && <Loader2 className="animate-spin" aria-hidden />}
      {resolving ? "Saving…" : "Done"}
      {/* Otherwise three identical buttons are three identical announcements. */}
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}

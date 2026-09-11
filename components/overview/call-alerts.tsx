import { AttentionPanel } from "@/components/overview/attention-panel"
import type { CallAlertKind } from "@/lib/business/call-alerts"

/**
 * The two calling failures a person has to do something about (issue #13).
 *
 * A Server Component holding no state: the kind arrives already worked out by
 * `lib/business/call-alerts.ts`, and there is nothing here to react to.
 *
 * **One line each.** This used to be a heading and a paragraph inside its own
 * amber box, which made the smallest of Overview's four warnings the loudest
 * thing on the screen. Everything the paragraph said that mattered — what
 * stopped, and what to do — fits in a sentence.
 *
 * **Inline and persistent, not a toast.** SPEC.md §11.4 reserves toasts for
 * transient results and asks for inline persistent UI for anything requiring
 * action. An empty calling balance is the definition of requiring action —
 * every Call will fail until somebody tops it up — and a message that fades
 * after four seconds would leave the next person to press "Call now" staring at
 * a failure with no explanation.
 *
 * **No Dismiss button, on purpose.** It clears itself: `loadCallAlert` reads
 * only the most recent Call, so a Call that connects afterwards is proof the
 * condition has passed. A dismiss control would let someone hide a problem that
 * is still there.
 *
 * **Amber, not red.** Amber means a human has to act, which is exactly this.
 * `components/overview/status-pill.tsx` reserves red for the person on the
 * phone saying no, and keeping that line drawn matters more than the vague
 * sense that a failure should be red.
 *
 * These are **not** Needs Attention rows. SPEC.md §5 fixes exactly four of those
 * reasons and neither of these is one — the colour is shared because the meaning
 * is shared, not because the two are the same thing.
 */

/*
  No vendor name and no dashboard link. The owner of a salon did not sign up for
  a calling provider and cannot log into one; whoever set the account up can.
  "Calls are stopped" is the part they need, and a brand name in the middle of
  it only makes the sentence harder to read.
*/
const ALERTS: Record<CallAlertKind, string> = {
  credit_exhausted:
    "Calls are stopped — the calling account is out of credit. Top it up, then try again.",
  concurrency_limit:
    "Your last call was turned away because too many calls were running at once. Wait a moment and try again.",
}

export function CallAlert({ kind }: { kind: CallAlertKind | null }) {
  if (!kind) return null

  return <AttentionPanel id="call-alert" heading={ALERTS[kind]} />
}

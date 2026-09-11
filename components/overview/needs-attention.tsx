import { AttentionPanel } from "@/components/overview/attention-panel"
import { ClearAttentionButton } from "@/components/overview/clear-attention-button"
import { explainNeedsAttention } from "@/lib/appointments/attention-reason"
import type { NeedsAttentionRow } from "@/lib/business/needs-attention"
import { formatInZone } from "@/lib/time/zone"

/**
 * The surface four failure paths converge on (SPEC.md §11.3 item 3, §5).
 *
 * A Server Component holding no state: the rows arrive already read and already
 * filtered, and the only thing here that reacts is the Clear button on each row.
 *
 * The chrome comes from `attention-panel.tsx`, shared with the other three
 * things on this screen that ask a person to act. Read that file for why none of
 * them is a box any more.
 *
 * **Inline and persistent, not a toast.** SPEC.md §11.4 reserves toasts for
 * transient results and asks for inline persistent UI for anything requiring
 * action. Every row here is an Appointment Callzie has stopped calling, which is
 * the definition — and a message that fades after four seconds would leave
 * somebody wondering why a "Call now" button no longer works.
 *
 * **No Dismiss, on purpose.** Clear is the only exit, and it is a write. A
 * dismiss control would let somebody hide a person who is still waiting for a
 * phone call.
 *
 * **Nothing here auto-resolves.** SPEC.md §5 and §14 rules 2 and 3. The panel
 * has no timer, no retry and no cleanup pass; it renders what the column says
 * until a human presses a button.
 *
 * The times are formatted here rather than in the browser, so one `Intl` pass
 * happens on the server and no hydration mismatch is possible between the
 * viewer's clock and the Business's.
 */
export function NeedsAttention({
  rows,
  timezone,
}: {
  rows: NeedsAttentionRow[]
  timezone: string
}) {
  // "Only when non-empty" (SPEC.md §11.3). Not an empty state — no section at
  // all, so a healthy account's Overview does not carry a heading about
  // problems it does not have.
  if (rows.length === 0) return null

  return (
    <AttentionPanel
      id="needs-attention"
      heading={
        <>
          {/* Amber on the number only — the sentence stays ink. */}
          <span className="text-attention">{rows.length}</span>{" "}
          {rows.length === 1
            ? "appointment needs attention"
            : "appointments need attention"}
        </>
      }
    >
      <p className="text-table text-text-muted">
        Callzie will not call these until you clear them.
      </p>

      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((row) => {
          const slotLabel = formatInZone(row.startsAt, timezone)

          return (
            <li
              key={row.id}
              className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                <p className="text-table text-text">
                  {row.name}{" "}
                  <span aria-hidden className="px-1 text-text-muted">
                    ·
                  </span>{" "}
                  {/*
                    Mono — slot times belong with phone numbers and durations.
                    `whitespace-nowrap` because "Fri 14 Aug, 09:00" has spaces of
                    its own and is meant to read as one token: it should move to
                    the next line whole rather than splitting after the comma.
                  */}
                  <span className="font-mono whitespace-nowrap text-text-muted">
                    {slotLabel}
                  </span>{" "}
                  <span aria-hidden className="px-1 text-text-muted">
                    ·
                  </span>{" "}
                  <span className="text-text-muted">{row.serviceName}</span>
                </p>

                <ClearAttentionButton appointmentId={row.id} name={row.name} />
              </div>

              <p className="text-table text-text-muted">
                {explainNeedsAttention({
                  reason: row.reason,
                  slotLabel,
                  attempts: row.attempts,
                })}
              </p>
            </li>
          )
        })}
      </ul>
    </AttentionPanel>
  )
}

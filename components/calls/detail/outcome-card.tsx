import { Check, ChevronRight, X } from "lucide-react"

import { JsonBlock } from "@/components/calls/detail/json-block"
import { Card } from "@/components/ui/card"
import type { NoToolsSummary } from "@/lib/calls/no-tools"
import {
  invocationLabel,
  SLOW_TOOL_MS,
  type CallOutcome,
  type InvocationRow,
} from "@/lib/calls/outcome"
import { cn } from "@/lib/utils"

/**
 * What Maya actually did, as a ledger.
 *
 * This is the claim the product is making, so the card is built from the rows
 * the tool endpoints wrote *during* the call and not from the write-up
 * afterwards, which is only what was said about it.
 *
 * The verdict is the first line, and then one row per thing Maya did, in the
 * order she did it. Each row opens to the exact request and response underneath
 * it. Before this, each row was two side-by-side blocks of JSON about 175px
 * tall, each with its own scrollbar, inside three nested boxes — so a call with
 * three tool calls was a screen and a half of punctuation, and the person
 * reading it could not tell at a glance whether anything got booked. The
 * evidence is still all here; it is just folded away until somebody asks.
 *
 * **Failed calls render, in place, marked as failed.** A booking that failed is
 * the most interesting row here — it is the moment Maya named a time and Callzie
 * could not honour it — and a card that dropped it would be quietly undoing the
 * claim.
 */
export function OutcomeCard({
  outcome,
  noTools,
  verdict,
}: {
  outcome: CallOutcome
  noTools: NoToolsSummary
  /** The one-line answer, rendered again here as the card's own first line. */
  verdict: string
}) {
  return (
    /*
      `pad="none"` so the hairlines between rows run edge to edge. A row inset
      from the card's border reads as a list of little cards; a rule that touches
      both sides reads as a ledger, which is what this is.
    */
    <Card tone="ink" pad="none">
      <h3 className="border-b border-line-strong px-5 py-4 text-section text-text">
        {verdict}
      </h3>

      {outcome.invocations.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-body text-text">{noTools.headline}</p>
          <p className="mt-1 max-w-prose text-table text-text-muted">
            {noTools.detail}
          </p>
        </div>
      ) : (
        <>
          <ol>
            {outcome.invocations.map((invocation, index) => (
              <InvocationRowItem
                key={invocation.id}
                invocation={invocation}
                number={index + 1}
              />
            ))}
          </ol>

          <div className="border-t border-line-strong px-5 py-4">
            <p className="text-table uppercase tracking-[0.06em] text-text-muted">
              Times offered
            </p>
            {outcome.offeredSlots.length === 0 ? (
              <p className="mt-1 text-body text-text">
                None — Maya never named a time.
              </p>
            ) : (
              /*
                The spoken form only. The raw timestamp used to be printed
                beside it in mono, which meant every line read
                "Thursday at half past ten 2026-08-27T10:30:00.000Z" — the one
                half nobody can read, sitting next to the half that is the whole
                point. It is still in the row's own details, where a person
                checking the booking can find it.
              */
              <ul className="mt-1 flex flex-col gap-1 text-body text-text">
                {outcome.offeredSlots.map((slot) => (
                  <li key={slot.slot_start}>{slot.time}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * One line of the ledger, and the evidence behind it.
 *
 * A native `<details>`, not a state hook. It opens and closes on click and on
 * Enter, it is reachable by Tab, a screen reader announces it as expandable, and
 * browser find-in-page can open it to show a match. None of that had to be
 * written.
 */
function InvocationRowItem({
  invocation,
  number,
}: {
  invocation: InvocationRow
  number: number
}) {
  const slow =
    invocation.latencyMs !== null && invocation.latencyMs > SLOW_TOOL_MS

  return (
    <li>
      <details className="group border-b border-line">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-soft [&::-webkit-details-marker]:hidden">
          {/* Two digits so a call with ten steps does not shift the column. */}
          <span className="font-mono text-table text-text-muted">
            {String(number).padStart(2, "0")}
          </span>

          {invocation.succeeded ? (
            <Check className="size-4 shrink-0 text-confirmed" aria-hidden />
          ) : (
            <X className="size-4 shrink-0 text-declined" aria-hidden />
          )}
          {/*
            The tick and the cross are the only thing separating "Booked" from
            "tried to book and could not". Read aloud, a colour and a glyph are
            nothing, so the word is here for anyone listening to the page.
          */}
          <span className="sr-only">
            {invocation.succeeded ? "Succeeded" : "Failed"}
          </span>

          <span className="min-w-0 flex-1 text-body text-text">
            {invocationLabel(invocation)}
          </span>

          {invocation.latencyMs !== null ? (
            /*
              A slow tool is dead air the person on the phone can hear, so past a
              second and a half the number goes amber instead of sitting in the
              same grey as the fast ones.
            */
            <span
              className={cn(
                "font-mono text-table",
                slow ? "text-attention" : "text-text-muted",
              )}
            >
              {invocation.latencyMs} ms
            </span>
          ) : null}

          <ChevronRight
            className="size-4 shrink-0 text-text-muted transition-transform group-open:rotate-90"
            aria-hidden
          />
        </summary>

        <div className="px-5 pb-4">
          {/* The engineer's name for it — mono, and only down here. */}
          <p className="font-mono text-table text-text-muted">
            {invocation.toolName}
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-table uppercase tracking-[0.06em] text-text-muted">
                Arguments
              </p>
              <div className="mt-1">
                <JsonBlock value={invocation.arguments} />
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-table uppercase tracking-[0.06em] text-text-muted">
                Result
              </p>
              <div className="mt-1">
                <JsonBlock value={invocation.result} />
              </div>
            </div>
          </div>
        </div>
      </details>
    </li>
  )
}

import type { LiveCall } from "@/lib/business/active-calls"
import { Card } from "@/components/ui/card"
import { clockInZone } from "@/lib/time/zone"

/**
 * Who Maya is talking to right now — a strip above the table, and nothing at
 * all the rest of the time.
 *
 * This used to be a permanent card that said "No calls in progress right now"
 * on every visit. That is true for almost every second of an account's life, so
 * the card spent its whole existence taking up the space above the table to
 * report an absence. Now it renders only when there is something to report, in
 * the same shape as the batch strip a few lines below it — because they say the
 * same kind of thing, and two shapes for one idea is one shape too many.
 *
 * The same definition of "live" as the topbar dot and the shimmering table row
 * (`lib/business/active-calls.ts`), so the three surfaces always agree. While a
 * batch runs, the batch strip's ~5s revalidation refreshes this list along with
 * the rest of the page.
 *
 * The start time is shown as a clock rather than a ticking elapsed counter: a
 * Server Component cannot tick, and a counter that only moved on revalidation
 * would look broken exactly when someone is staring at it.
 *
 * Cobalt is allowed here. It is the same pulsing dot the topbar carries, and a
 * live call is the only thing in this product that colour ever means.
 */
export function LiveCallsStrip({
  calls,
  timezone,
}: {
  calls: LiveCall[]
  timezone: string
}) {
  if (calls.length === 0) return null

  return (
    <Card pad="none" role="status" aria-live="polite" className="px-4 py-1">
      <ul>
        {calls.map((call) => (
          <li
            key={call.appointmentId}
            className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 animate-live-pulse rounded-full bg-live"
            />
            <p className="truncate text-body text-text">
              Live with {call.name}
            </p>
            {/* The word stays in Inter; only the clock is mono. */}
            {call.startedAt && (
              <p className="ml-auto shrink-0 text-table text-text-muted">
                Started{" "}
                <span className="font-mono">
                  {clockInZone(call.startedAt, timezone)}
                </span>
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { weekdayLabel } from "@/lib/settings/weekdays"
import { weekdayOf, type CivilDate } from "@/lib/time/zone"

/**
 * A day with no Business Hours and no Appointments on it.
 *
 * A designed state rather than an empty grid. Drawing hour lines across a day
 * the Business is shut would say the day is open and quiet, which is a
 * different fact.
 *
 * `EmptyState` rather than a hand-drawn panel: it is the one shape this app uses
 * for "nothing here", and it carries the rule an empty screen must never be a
 * dead end — so this one names where opening hours are changed.
 *
 * Named after the weekday rather than the date — "Closed on Sundays" is the
 * standing rule, and it is the sentence that tells someone where to go and
 * change it.
 */
export function ClosedDay({ date }: { date: CivilDate }) {
  return (
    <EmptyState
      title={`Closed on ${weekdayLabel(weekdayOf(date))}s.`}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/settings">Change opening hours</Link>
        </Button>
      }
    >
      No appointments.
    </EmptyState>
  )
}

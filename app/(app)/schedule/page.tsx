import { ClosedDay } from "@/components/schedule/closed-day"
import { DayGrid } from "@/components/schedule/day-grid"
import { DayNav } from "@/components/schedule/day-nav"
import { requireBusiness } from "@/lib/business/require-business"
import {
  formatDayParam,
  resolveDay,
  SCHEDULE_DATE_PARAM,
} from "@/lib/schedule/day-param"
import { loadScheduleDay } from "@/lib/schedule/load-day"
import { todayInZone } from "@/lib/time/zone"

/**
 * Schedule — the read-only day view (SPEC.md §11.3, issue #18).
 *
 * A Server Component with no client JavaScript at all. The only interactive
 * elements on the page are the day controls in `DayNav` — three links and a
 * plain GET form holding the browser's own date field. Nothing is draggable,
 * nothing is clickable to book. SPEC.md is explicit that if this screen starts
 * growing interaction it should be cut, because it competes with the Needs
 * Attention surface (#15).
 *
 * `requireBusiness()` is React-`cache()`d and the shell layout above has
 * already called it, so it costs no second query.
 *
 * A Collision renders from `appointments.needs_attention_reason`. Nothing
 * writes that value yet — detecting Collisions against Google Calendar is #20 —
 * so the marker is present and currently silent. #20 lights it up by writing
 * one column and changes nothing here.
 */
export default async function SchedulePage({
  searchParams,
}: PageProps<"/schedule">) {
  const { business } = await requireBusiness()

  /*
    One clock reading for the whole render. Three separate `new Date()` calls
    could straddle midnight and disagree with each other about which day is
    today, which is the kind of bug that happens once a year at 00:00 and is
    never reproduced.
  */
  const now = new Date()

  /*
    "Today" is resolved in the Business's own timezone rather than the server's
    or the viewer's, and `now` is passed in rather than read inside, so the rule
    stays testable at a boundary — see lib/schedule/day-param.ts.
  */
  const date = resolveDay(
    readParam((await searchParams)[SCHEDULE_DATE_PARAM]),
    now,
    business.timezone,
  )

  /*
    Comparing the two dates as strings rather than field by field: they are both
    civil dates and `formatDayParam` is the one spelling of one. This decides
    two things — whether the "Today" link says you are already here, and whether
    the grid draws a "now" line at all.
  */
  const isToday =
    formatDayParam(date) === formatDayParam(todayInZone(now, business.timezone))

  const layout = await loadScheduleDay({
    businessId: business.id,
    timezone: business.timezone,
    date,
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="workspace-intro"><div><p className="workspace-eyebrow">YOUR DAY, AT A GLANCE</p><h2>Good things on the calendar.</h2><p>Browse your appointments and spot the spaces in between. Times are shown in {business.timezone}.</p></div></div>
      <DayNav
        date={date}
        timezone={business.timezone}
        hours={layout?.hours ?? null}
        appointmentCount={layout?.blocks.length ?? 0}
        isToday={isToday}
      />

      {/*
        A null layout means a closed day with nothing on it — the one case that
        gets an empty state instead of a grid. A closed day *with* a booking
        still draws the grid, fully hatched, so the booking keeps its place in
        time.
      */}
      {layout ? (
        <DayGrid
          layout={layout}
          timezone={business.timezone}
          now={isToday ? now : null}
        />
      ) : (
        <ClosedDay date={date} />
      )}
    </div>
  )
}

/**
 * A search param as a single string.
 *
 * A repeated query key (`?date=a&date=b`) arrives as an array, so this collapses
 * to the first entry rather than letting `string[]` reach a function typed for
 * `string | null`. The same guard `app/(app)/settings/page.tsx` uses.
 */
function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

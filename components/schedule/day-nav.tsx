import { ChevronLeft, ChevronRight } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  formatDayParam,
  scheduleHref,
  SCHEDULE_DATE_PARAM,
} from "@/lib/schedule/day-param"
import {
  addCalendarDays,
  clockInZone,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone"
import { cn } from "@/lib/utils"

/**
 * Which day the Schedule is showing, and the four ways to change it.
 *
 * **Plain links and one plain form, deliberately.** They are the only
 * interactive elements on this screen, and being links rather than buttons is
 * what keeps the whole page a Server Component with no client JavaScript — and
 * what makes a day shareable and bookmarkable. Changing which day you are
 * looking at is navigation, not booking, so #18's read-only rule holds.
 *
 * Today is `/schedule` with no param at all, rather than today's date spelled
 * out. That link stays correct after midnight without the page being
 * re-rendered.
 *
 * The date field is the browser's own `<input type="date">` inside a GET form,
 * not a calendar widget: a day three weeks out is one tap rather than twenty-one
 * presses of the next arrow, and the platform already draws the calendar. A GET
 * form puts the chosen day in the query string, which is exactly the URL the
 * arrows produce, so nothing else has to change. It needs its own submit button
 * because with no JavaScript nothing else would tell the browser to go.
 *
 * `addCalendarDays` for prev and next, not a subtraction in milliseconds:
 * adding a day is a calendar operation, and counting in absolute time lands on
 * the wrong date across a DST transition.
 */

type DayNavProps = {
  date: CivilDate
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
  /** That weekday's opening window, or null when the Business is shut. */
  hours: { opensAt: Date; closesAt: Date } | null
  appointmentCount: number
  /** Whether `date` is today in the Business's own zone. Decided by the page. */
  isToday: boolean
}

export function DayNav({
  date,
  timezone,
  hours,
  appointmentCount,
  isToday,
}: DayNavProps) {
  return (
    <header className="workspace-day-nav flex flex-wrap items-center gap-x-5 gap-y-3">
      {/*
        One fused control, not two floating buttons: the two links share a seam
        (`-ml-px` pulls the second onto the first's border) so back and forward
        read as a single instrument.
      */}
      <nav aria-label="Choose a day" className="flex items-center">
        <DayArrow
          href={scheduleHref(addCalendarDays(date, -1))}
          label="Previous day"
          className="rounded-l-control"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </DayArrow>
        <DayArrow
          href={scheduleHref(addCalendarDays(date, 1))}
          label="Next day"
          className="-ml-px rounded-r-control"
        >
          <ChevronRight className="size-4" aria-hidden />
        </DayArrow>
      </nav>

      {/*
        `aria-current="date"` is how a screen reader is told this link points at
        the day already on screen. Without it "Today" sounds like somewhere else
        to go even when you are already there.
      */}
      <Link
        href="/schedule"
        aria-current={isToday ? "date" : undefined}
        className={cn(
          "inline-flex items-center text-table underline-offset-4 transition-colors hover:underline pointer-coarse:min-h-11",
          isToday ? "text-text" : "text-text-muted hover:text-text",
        )}
      >
        Today
      </Link>


      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/*
          The day is the largest thing on this screen, because it is the one
          fact every other pixel is about. No year: nobody browsing a salon's
          week is unsure which year it is.
        */}
        <h2 className="font-serif text-title text-text">
          {formatDayTitle(date, timezone)}
        </h2>
        <p className="text-table text-text-muted">
          {summarise(hours, appointmentCount, timezone)}
        </p>
      </div>

      <form action="/schedule" className="flex items-center gap-2 sm:ms-auto">
        <label htmlFor="schedule-day" className="sr-only">
          Jump to a date
        </label>
        <input
          id="schedule-day"
          type="date"
          name={SCHEDULE_DATE_PARAM}
          defaultValue={formatDayParam(date)}
          className="h-8 rounded-control border border-line bg-surface px-2 font-mono text-table text-text pointer-coarse:h-11"
        />
        <Button type="submit" variant="outline" size="sm">
          Go
        </Button>
      </form>
    </header>
  )
}

/**
 * What the line beside the date says.
 *
 * Only the two clock readings are set in the mono face. The sentence around
 * them is ordinary prose and belongs in the ordinary face — mono is for phone
 * numbers, clock times, durations, tool names and JSON, never for a sentence.
 *
 * A closed day with bookings on it names the count, because that is the
 * combination worth noticing. Business Hours can be narrowed after Appointments
 * are booked — `lib/settings/hours-conflicts.ts` exists because Settings only
 * warns about that rather than moving anything.
 */
function summarise(
  hours: { opensAt: Date; closesAt: Date } | null,
  appointmentCount: number,
  timezone: string,
): React.ReactNode {
  if (hours) {
    return (
      <>
        Open <span className="font-mono">{clockInZone(hours.opensAt, timezone)}</span>{" "}
        to <span className="font-mono">{clockInZone(hours.closesAt, timezone)}</span>
      </>
    )
  }
  if (appointmentCount === 0) return "Closed"
  const plural = appointmentCount === 1 ? "" : "s"
  return `Closed · ${appointmentCount} appointment${plural}`
}

const TITLE_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/**
 * The day as the heading writes it — `"Wednesday 19 August"`.
 *
 * `en-GB` for day-before-month, and fixed rather than following the viewer's
 * locale, for the reason `lib/schedule/day-param.ts` gives: two people looking
 * at the same day must read the same heading. The instant handed to the
 * formatter is **noon** for the reason given there too — midnight is the one
 * hour a DST transition can push across a date boundary.
 *
 * Its own formatter rather than `formatDayHeading`, because that one spells the
 * short form with a year in it and other callers may still want that shape.
 */
function formatDayTitle(date: CivilDate, timezone: string): string {
  let formatter = TITLE_FORMATTERS.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
    })
    TITLE_FORMATTERS.set(timezone, formatter)
  }
  return formatter.format(
    zonedTimeToInstant({ ...date, hour: 12, minute: 0 }, timezone),
  )
}

/**
 * One arrow in the fused day stepper.
 *
 * `aria-label` because both are icons only. 32px on a mouse, 44px on a finger —
 * a coarse pointer cannot hit a 32px target reliably.
 */
function DayArrow({
  href,
  label,
  className,
  children,
}: {
  href: string
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(
        "flex size-8 items-center justify-center border border-line text-text-muted transition-colors hover:bg-muted hover:text-text pointer-coarse:size-11",
        className,
      )}
    >
      {children}
    </Link>
  )
}
